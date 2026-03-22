import os
import stripe
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from .index import require_user, supabase

router = APIRouter(prefix="/api/billing", tags=["billing"])

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
STRIPE_WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

# Model mappings for Stripe prices
# You should create these in your Stripe Dashboard first
PRICE_ID_BASIC = os.getenv("STRIPE_PRICE_ID_BASIC") # e.g. $49/mo
PRICE_ID_PRO = os.getenv("STRIPE_PRICE_ID_PRO")     # e.g. $149/mo
TOKEN_METER_ID = os.getenv("STRIPE_TOKEN_METER_ID") # For metered overages

@router.post("/create-checkout-session")
async def create_checkout_session(tier: str, user = Depends(require_user)):
    """Create a Stripe Checkout session for a subscription."""
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
            success_url=f"{FRONTEND_URL}/billing?success=true",
            cancel_url=f"{FRONTEND_URL}/billing?canceled=true",
        )
        return {"url": session.url}
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
            return_url=f"{FRONTEND_URL}/billing",
        )
        return {"url": session.url}
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
        
        # Update profile in Supabase
        supabase.table("profiles").update({
            "subscription_status": status,
            "stripe_subscription_id": subscription.id,
            "current_period_end": period_end,
            "role": "pro" if status == "active" else "standard" # Simple logic: active = pro
        }).eq("stripe_customer_id", customer_id).execute()

    return {"status": "success"}

def report_usage_to_stripe(user_id: str, token_count: int):
    """Report metered usage to Stripe."""
    try:
        profile_res = supabase.table("profiles").select("stripe_subscription_id").eq("id", user_id).single().execute()
        sub_id = profile_res.data.get("stripe_subscription_id")
        if not sub_id: return

        # This assumes you have a metered price on the subscription
        # In a real app, you'd aggregate these and send in batches
        stripe.SubscriptionItem.create_usage_record(
            sub_id, # You actually need the ID of the specific item in the sub
            quantity=token_count,
            timestamp='now',
            action='increment'
        )
    except Exception as e:
        print(f"Stripe usage reporting failed: {e}")
