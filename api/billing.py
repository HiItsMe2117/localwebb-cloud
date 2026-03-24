import os
import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from .index import require_user, supabase

router = APIRouter(prefix="/api/billing", tags=["billing"])

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

# Price-to-role mappings for Stripe subscriptions
PRICE_ID_BASIC = os.getenv("STRIPE_PRICE_ID_BASIC") # e.g. $49/mo
PRICE_ID_PRO = os.getenv("STRIPE_PRICE_ID_PRO")     # e.g. $149/mo
TOKEN_METER_ID = os.getenv("STRIPE_TOKEN_METER_ID") # For metered overages

VALID_TIERS = {"basic", "pro"}
PRICE_TO_ROLE = {
    PRICE_ID_BASIC: "basic",
    PRICE_ID_PRO: "pro",
}

@router.get("/account")
async def get_account(user = Depends(require_user)):
    """Return account profile, subscription info, and usage summary."""
    try:
        # Profile + subscription info
        profile_res = supabase.table("profiles").select(
            "username, role, subscription_status, current_period_end, stripe_customer_id, created_at"
        ).eq("id", user.id).single().execute()
        profile = profile_res.data or {}

        # Usage stats for current billing period
        usage_data = {"total_tokens": 0, "total_requests": 0, "by_endpoint": {}}
        try:
            usage_res = supabase.table("usage_logs").select(
                "endpoint, total_tokens"
            ).eq("user_id", user.id).execute()
            rows = usage_res.data or []
            usage_data["total_requests"] = len(rows)
            for row in rows:
                tokens = row.get("total_tokens", 0) or 0
                usage_data["total_tokens"] += tokens
                ep = row.get("endpoint", "unknown")
                if ep not in usage_data["by_endpoint"]:
                    usage_data["by_endpoint"][ep] = {"tokens": 0, "requests": 0}
                usage_data["by_endpoint"][ep]["tokens"] += tokens
                usage_data["by_endpoint"][ep]["requests"] += 1
        except Exception:
            pass  # Usage logs may not exist yet

        # Billing totals from Stripe
        billing = {"total_spent": 0, "invoices": []}
        customer_id = profile.get("stripe_customer_id")
        if customer_id:
            try:
                invoices = stripe.Invoice.list(customer=customer_id, limit=12)
                for inv in invoices.data:
                    amount = (inv.amount_paid or 0) / 100
                    billing["total_spent"] += amount
                    billing["invoices"].append({
                        "date": inv.created,
                        "amount": amount,
                        "status": inv.status,
                        "pdf": inv.invoice_pdf,
                    })
            except Exception:
                pass

        return {
            "email": user.email,
            "username": profile.get("username"),
            "role": profile.get("role", "standard"),
            "subscription_status": profile.get("subscription_status", "inactive"),
            "current_period_end": profile.get("current_period_end"),
            "member_since": profile.get("created_at"),
            "usage": usage_data,
            "billing": billing,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-checkout-session")
async def create_checkout_session(tier: str, user = Depends(require_user)):
    """Create a Stripe Checkout session for a subscription."""
    if tier not in VALID_TIERS:
        raise HTTPException(status_code=400, detail=f"Invalid tier: {tier}. Must be one of: {', '.join(VALID_TIERS)}")

    try:
        # Get or create Stripe Customer
        profile_res = supabase.table("profiles").select("stripe_customer_id").eq("id", user.id).single().execute()
        profile = profile_res.data

        customer_id = profile.get("stripe_customer_id")
        if not customer_id:
            customer = stripe.Customer.create(
                email=user.email,
                metadata={"supabase_user_id": str(user.id)}
            )
            customer_id = customer.id
            supabase.table("profiles").update({"stripe_customer_id": customer_id}).eq("id", user.id).execute()

        price_id = PRICE_ID_PRO if tier == "pro" else PRICE_ID_BASIC
        
        session = stripe.checkout.Session.create(
            customer=customer_id,
            payment_method_types=["card"],
            line_items=[{"price": price_id, "quantity": 1}],
            mode="subscription",
            success_url=f"{FRONTEND_URL}/?checkout=success",
            cancel_url=f"{FRONTEND_URL}/?checkout=canceled",
        )
        return {"url": session.url}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/create-portal-session")
async def create_portal_session(user = Depends(require_user)):
    """Create a Stripe Customer Portal session for managing subscriptions."""
    try:
        profile_res = supabase.table("profiles").select("stripe_customer_id").eq("id", user.id).single().execute()
        customer_id = profile_res.data.get("stripe_customer_id")
        if not customer_id:
            raise HTTPException(status_code=400, detail="No billing profile found")

        session = stripe.billing_portal.Session.create(
            customer=customer_id,
            return_url=f"{FRONTEND_URL}/",
        )
        return {"url": session.url}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Handle Stripe webhooks to update subscription status."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature")

    try:
        event = stripe.Webhook.construct_event(payload, sig_header, STRIPE_WEBHOOK_SECRET)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Webhook error: {e}")

    # Handle subscription events
    if event.type in ["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"]:
        subscription = event.data.object
        customer_id = subscription.customer
        status = subscription.status
        period_end = subscription.current_period_end

        # Determine role from the subscription's price
        role = "standard"
        if status == "active" and subscription.get("items", {}).get("data"):
            price_id = subscription["items"]["data"][0]["price"]["id"]
            role = PRICE_TO_ROLE.get(price_id, "basic")

        # Update profile in Supabase
        supabase.table("profiles").update({
            "subscription_status": status,
            "stripe_subscription_id": subscription.id,
            "current_period_end": period_end,
            "role": role,
        }).eq("stripe_customer_id", customer_id).execute()

    return {"status": "success"}

def report_usage_to_stripe(user_id: str, token_count: int):
    """Report metered usage to Stripe."""
    try:
        profile_res = supabase.table("profiles").select("stripe_subscription_id").eq("id", user_id).single().execute()
        sub_id = profile_res.data.get("stripe_subscription_id")
        if not sub_id:
            return

        # Retrieve the subscription to find the metered item
        subscription = stripe.Subscription.retrieve(sub_id)
        metered_item_id = None
        for item in subscription["items"]["data"]:
            if item["price"]["id"] == TOKEN_METER_ID:
                metered_item_id = item["id"]
                break

        if not metered_item_id:
            print(f"No metered item found on subscription {sub_id}")
            return

        stripe.SubscriptionItem.create_usage_record(
            metered_item_id,
            quantity=token_count,
            timestamp="now",
            action="increment",
        )
    except Exception as e:
        print(f"Stripe usage reporting failed: {e}")
