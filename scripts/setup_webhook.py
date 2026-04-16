import os
import stripe
from dotenv import load_dotenv

load_dotenv(".env.prod")
stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
WEBHOOK_URL = "https://localwebb-cloud.vercel.app/api/billing/webhook"

def setup_webhook():
    print(f"🚀 Registering Webhook for {WEBHOOK_URL}...")
    
    # 1. Check if it already exists
    existing = stripe.WebhookEndpoint.list(limit=100)
    for endpoint in existing.data:
        if endpoint.url == WEBHOOK_URL:
            print("⚠️ Webhook already exists. Deleting old one to refresh secret...")
            stripe.WebhookEndpoint.delete(endpoint.id)

    # 2. Create new endpoint
    endpoint = stripe.WebhookEndpoint.create(
        url=WEBHOOK_URL,
        enabled_events=[
            "customer.subscription.created",
            "customer.subscription.updated",
            "customer.subscription.deleted",
            "checkout.session.completed" # Added this for initial purchase safety
        ],
    )
    
    print(f"✅ Webhook Registered! ID: {endpoint.id}")
    return endpoint.secret

if __name__ == "__main__":
    try:
        secret = setup_webhook()
        print(f"\n🎉 WEBHOOK SECRET OBTAINED: {secret}")
        
        # Update .env.prod
        env_path = ".env.prod"
        with open(env_path, "r") as f:
            lines = f.readlines()
        
        with open(env_path, "w") as f:
            for line in lines:
                if line.startswith("STRIPE_WEBHOOK_SECRET="):
                    f.write(f"STRIPE_WEBHOOK_SECRET={secret}\n")
                else:
                    f.write(line)
        print("✅ .env.prod updated successfully.")
        
    except Exception as e:
        print(f"❌ Error setting up webhook: {e}")
