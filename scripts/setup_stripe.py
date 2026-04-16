import os
import stripe
from dotenv import load_dotenv

load_dotenv(".env.prod")
stripe.api_key = os.getenv("STRIPE_SECRET_KEY")

def setup_stripe():
    print("🚀 Initializing Stripe Product Setup (Reusing Meter)...")
    
    # 1. Find or Create a Meter
    meters = stripe.billing.Meter.list(limit=10)
    existing_meter = next((m for m in meters.data if m.event_name == "token_usage"), None)
    
    if existing_meter:
        meter_id = existing_meter.id
        print(f"✅ Found Existing Meter: {meter_id}")
    else:
        print("Creating Compute Token Meter...")
        meter = stripe.billing.Meter.create(
            display_name="Compute Tokens",
            event_name="token_usage",
            default_aggregation={"formula": "sum"},
        )
        meter_id = meter.id
        print(f"✅ Created Meter: {meter_id}")

    # 2. Create the Metered Price
    print("Creating Metered Price...")
    token_price = stripe.Price.create(
        nickname="Token Usage Overage",
        currency="usd",
        recurring={"usage_type": "metered", "interval": "month", "meter": meter_id},
        unit_amount_decimal="0.00001", 
        billing_scheme="per_unit",
        product_data={"name": "Compute Overage"},
    )
    print(f"✅ Created Price: {token_price.id}")

    # 3. Create Basic Plan (Researcher)
    print("Creating Researcher Plan...")
    basic_product = stripe.Product.create(
        name="Researcher",
        description="Standard investigative tools with 5M compute tokens monthly."
    )
    basic_price = stripe.Price.create(
        product=basic_product.id,
        unit_amount=4900, 
        currency="usd",
        recurring={"interval": "month"},
    )
    print(f"✅ Created Basic Plan: {basic_price.id}")

    # 4. Create Pro Plan (Pro Investigator)
    print("Creating Pro Investigator Plan...")
    pro_product = stripe.Product.create(
        name="Pro Investigator",
        description="Advanced investigation features with 10M compute tokens monthly."
    )
    pro_price = stripe.Price.create(
        product=pro_product.id,
        unit_amount=14900,
        currency="usd",
        recurring={"interval": "month"},
    )
    print(f"✅ Created Pro Plan: {pro_price.id}")

    return {
        "BASIC_ID": basic_price.id,
        "PRO_ID": pro_price.id,
        "TOKEN_METER_ID": token_price.id,
        "METER_ID": meter_id
    }

if __name__ == "__main__":
    try:
        ids = setup_stripe()
        print("\n🎉 SETUP COMPLETE!")
        print(f"STRIPE_PRICE_ID_BASIC={ids['BASIC_ID']}")
        print(f"STRIPE_PRICE_ID_PRO={ids['PRO_ID']}")
        print(f"STRIPE_TOKEN_METER_ID={ids['TOKEN_METER_ID']}")
        print(f"STRIPE_METER_ID={ids['METER_ID']}")
    except Exception as e:
        print(f"❌ Error during setup: {e}")
