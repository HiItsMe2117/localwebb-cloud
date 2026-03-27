import os
from twilio.rest import Client

_client = None

def _get_client():
    global _client
    if _client is None:
        sid = os.environ.get("TWILIO_ACCOUNT_SID")
        token = os.environ.get("TWILIO_AUTH_TOKEN")
        if sid and token:
            _client = Client(sid, token)
    return _client

def send_sms(body: str):
    """Send an SMS notification. Fails silently so it never blocks the app."""
    try:
        client = _get_client()
        if not client:
            print("[notify] Twilio not configured, skipping SMS")
            return
        from_number = os.environ.get("TWILIO_FROM_NUMBER")
        to_number = os.environ.get("NOTIFY_PHONE")
        if not from_number or not to_number:
            print("[notify] Missing TWILIO_FROM_NUMBER or NOTIFY_PHONE")
            return
        client.messages.create(body=body, from_=from_number, to=to_number)
    except Exception as e:
        print(f"[notify] SMS failed: {e}")
