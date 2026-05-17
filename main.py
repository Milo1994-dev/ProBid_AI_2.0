from typing import Optional
from fastapi import FastAPI, UploadFile, Form, HTTPException
from fastapi.responses import JSONResponse, Response
from fastapi.middleware.cors import CORSMiddleware
import stripe
from stripe import StripeError
import openai
import uuid
import os
import base64

app = FastAPI(title="ProBid AI", description="Contractor estimate generator")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
openai.api_key = os.getenv("OPENAI_API_KEY")

PRO_PRICE = 25
BUSINESS_PRICE = 55


def generate_estimate(description: str, image_data: Optional[str] = None) -> str:
    messages = []
    
    if image_data:
        messages.append({
            "role": "user",
            "content": [
                {
                    "type": "text",
                    "text": f"""You are a professional contractor with 20+ years of experience. 
Analyze the provided image and job description to generate a detailed, professional estimate.

Job Description: {description}

Provide a structured estimate including:
1. Scope of Work
2. Materials Needed (with estimated costs)
3. Labor Hours & Costs
4. Timeline
5. Total Estimated Cost Range
6. Important Notes/Disclaimers

Be realistic and professional. Include low and high estimates where appropriate."""
                },
                {
                    "type": "image_url",
                    "image_url": {
                        "url": image_data
                    }
                }
            ]
        })
        model = "gpt-4o"
    else:
        messages.append({
            "role": "user",
            "content": f"""You are a professional contractor with 20+ years of experience.
Generate a detailed, professional estimate based on this job description:

{description}

Provide a structured estimate including:
1. Scope of Work
2. Materials Needed (with estimated costs)
3. Labor Hours & Costs
4. Timeline
5. Total Estimated Cost Range
6. Important Notes/Disclaimers

Be realistic and professional. Include low and high estimates where appropriate."""
        })
        model = "gpt-4o"
    
    client = openai.OpenAI()
    response = client.chat.completions.create(
        model=model,
        messages=messages,
        temperature=0.4,
        max_tokens=2000
    )
    
    return response.choices[0].message.content or ""


@app.get("/favicon.ico")
def favicon():
    return Response(status_code=204)


@app.get("/")
def home():
    return {"status": "ProBid AI money-core running", "version": "1.0.0"}


@app.post("/estimate")
async def create_estimate(
    description: str = Form(...),
    photo: Optional[UploadFile] = None
):
    if not os.getenv("OPENAI_API_KEY"):
        raise HTTPException(status_code=500, detail="OpenAI API key not configured")
    
    try:
        image_data = None
        if photo:
            contents = await photo.read()
            encoded = base64.b64encode(contents).decode("utf-8")
            content_type = photo.content_type or "image/jpeg"
            image_data = f"data:{content_type};base64,{encoded}"
        
        estimate = generate_estimate(description, image_data)
        estimate_id = str(uuid.uuid4())
        
        return {
            "estimate_id": estimate_id,
            "estimate": estimate,
            "description": description,
            "had_photo": photo is not None
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/subscribe")
def subscribe(
    email: str = Form(...),
    plan: str = Form(...)
):
    if not os.getenv("STRIPE_SECRET_KEY"):
        raise HTTPException(status_code=500, detail="Stripe API key not configured")
    
    if plan not in ["pro", "business"]:
        raise HTTPException(status_code=400, detail="Invalid plan. Choose 'pro' or 'business'")
    
    price = PRO_PRICE if plan == "pro" else BUSINESS_PRICE
    
    try:
        intent = stripe.PaymentIntent.create(
            amount=price * 100,
            currency="usd",
            receipt_email=email,
            metadata={
                "plan": plan,
                "email": email
            }
        )
        
        return {
            "client_secret": intent.client_secret,
            "plan": plan,
            "amount": price,
            "currency": "usd"
        }
    except StripeError as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/plans")
def get_plans():
    return {
        "plans": [
            {
                "id": "pro",
                "name": "Pro",
                "price": PRO_PRICE,
                "currency": "usd",
                "features": [
                    "Unlimited estimates",
                    "Photo analysis",
                    "Email support"
                ]
            },
            {
                "id": "business",
                "name": "Business",
                "price": BUSINESS_PRICE,
                "currency": "usd",
                "features": [
                    "Everything in Pro",
                    "Priority processing",
                    "Phone support",
                    "Team access"
                ]
            }
        ]
    }


if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 5000))
    uvicorn.run(app, host="0.0.0.0", port=port)
