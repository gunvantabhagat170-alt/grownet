export type PaymentProviderId = "razorpay" | "stripe";

export function configuredPaymentProvider(): PaymentProviderId | null {
  if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) return "razorpay";
  if (process.env.STRIPE_SECRET_KEY) return "stripe";
  return null;
}

export async function createProviderOrder(opts: {
  amountPaise: number;
  receipt: string;
}): Promise<{ provider: PaymentProviderId; providerRef: string; extra?: Record<string, string> }> {
  const provider = configuredPaymentProvider();
  if (!provider) {
    throw Object.assign(new Error("A live payment provider is not configured"), { status: 503 });
  }
  if (provider === "razorpay") {
    const key = process.env.RAZORPAY_KEY_ID!;
    const secret = process.env.RAZORPAY_KEY_SECRET!;
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        amount: opts.amountPaise,
        currency: "INR",
        receipt: opts.receipt.slice(0, 40),
        payment_capture: 1,
      }),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`Razorpay order failed (${res.status})`), { status: 502 });
    }
    const body = (await res.json()) as { id: string };
    return { provider, providerRef: body.id, extra: { keyId: key } };
  }
  const stripeKey = process.env.STRIPE_SECRET_KEY!;
  const res = await fetch("https://api.stripe.com/v1/payment_intents", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      amount: String(opts.amountPaise),
      currency: "inr",
      "metadata[task_id]": opts.receipt,
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error(`Stripe intent failed (${res.status})`), { status: 502 });
  }
  const body = (await res.json()) as { id: string; client_secret?: string };
  return { provider, providerRef: body.id, extra: body.client_secret ? { clientSecret: body.client_secret } : undefined };
}
