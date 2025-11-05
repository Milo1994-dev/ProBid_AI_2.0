from fastapi import APIRouter, Request, HTTPException
from fastapi.responses import JSONResponse
import os
import stripe
from pydantic import BaseModel

router = APIRouter()
stripe.api_key = os.getenv("STRIPE_SECRET_KEY", "")

class CheckoutRequest(BaseModel):
    product_name: str = "ProBid Demo"
    currency: str = "usd"
    unit_amount: int = 1000  # cents
    quantity: int = 1
    success_url: str = "http://localhost:3000/success?session_id={CHECKOUT_SESSION_ID}"
    cancel_url: str = "http://localhost:3000/cancel"

@router.post("/billing/create-checkout-session")
async def create_checkout_session(req: CheckoutRequest):
    if not stripe.api_key:
        raise HTTPException(status_code=500, detail="Stripe API key not configured")

    try:
        # Create a Checkout Session with inline price_data so no pre-created Price ID is required
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            mode="payment",
            line_items=[
                {
                    "price_data": {
                        "currency": req.currency,
                        "product_data": {"name": req.product_name},
                        "unit_amount": req.unit_amount,
                    },
                    "quantity": req.quantity,
                }
            ],
            success_url=req.success_url,
            cancel_url=req.cancel_url,
        )
        return JSONResponse({"url": session.url, "id": session.id})
    except stripe.error.StripeError as e:
        raise HTTPException(status_code=400, detail=str(e))


# Stripe webhook endpoint
@router.post("/stripe/webhook")
async def stripe_webhook(request: Request):
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")
    webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "")
    if webhook_secret:
        try:
            event = stripe.Webhook.construct_event(payload=payload, sig_header=sig_header, secret=webhook_secret)
        except ValueError:
            # Invalid payload
            raise HTTPException(status_code=400, detail="Invalid payload")
        except stripe.error.SignatureVerificationError:
            # Invalid signature
            raise HTTPException(status_code=400, detail="Invalid signature")
    else:
        # If webhook secret not configured, try to parse payload (useful for test/dev)
        import json
        event = json.loads(payload.decode("utf-8"))

    # Handle the event (extend as needed)
    event_type = event.get("type")
    if event_type == "checkout.session.completed":
        session = event["data"]["object"]
        # TODO: Fulfill the purchase, record order in DB, send receipt, etc.
        print("Checkout completed:", session.get("id"))
    else:
        print("Unhandled event type:", event_type)

    return JSONResponse({"status": "success"})
