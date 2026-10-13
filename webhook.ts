import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { createFileRoute } from "@tanstack/react-router";
import { getSql } from "@/lib/db";
import { configuredPaymentProvider } from "@/lib/grownet/payments";

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyStripe(raw: string, header: string, secret: string) {
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, ...rest] = p.split("=");
      return [k.trim(), rest.join("=")];
    }),
  );
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;
  const expected = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return safeEqual(expected, v1);
}

function verifyRazorpay(raw: string, header: string, secret: string) {
  const expected = createHmac("sha256", secret).update(raw).digest("hex");
  return safeEqual(expected, header);
}

async function handle(request: Request) {
  const provider = configuredPaymentProvider();
  if (!provider) {
    return Response.json(
      { ok: false, error: "Payment provider is not configured. Webhooks are not accepted." },
      { status: 503 },
    );
  }
  const secret =
    provider === "razorpay"
      ? process.env.RAZORPAY_WEBHOOK_SECRET
      : process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: "Webhook secret is not configured." }, { status: 503 });
  }
  const raw = await request.text();
  const stripeSig = request.headers.get("stripe-signature") ?? "";
  const razorSig = request.headers.get("x-razorpay-signature") ?? "";
  const verified =
    provider === "stripe"
      ? Boolean(stripeSig) && verifyStripe(raw, stripeSig, secret)
      : Boolean(razorSig) && verifyRazorpay(raw, razorSig, secret);
  if (!verified) {
    return Response.json({ ok: false, error: "Invalid webhook signature" }, { status: 400 });
  }
  let payload: {
    id?: string;
    event?: string;
    payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string } } };
    data?: { object?: { id?: string; amount?: number; amount_received?: number; status?: string } };
  };
  try {
    payload = JSON.parse(raw) as typeof payload;
  } catch {
    return Response.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }
  const providerRef =
    provider === "stripe"
      ? payload.data?.object?.id ?? null
      : payload.payload?.payment?.entity?.order_id ?? null;
  if (!providerRef) {
    return Response.json({ ok: false, error: "No provider reference" }, { status: 400 });
  }
  const eventId = payload.id || `${provider}:${providerRef}:${raw.length}`;
  const sql = await getSql();
  const existingEvent = await sql`
    select id from payment_events where provider_event_id = ${eventId} limit 1`;
  if (existingEvent[0]) return Response.json({ ok: true, already: true });
  const rows = await sql<Record<string, unknown>>`
    select * from payments where provider_ref = ${providerRef} and provider = ${provider} limit 1`;
  if (!rows[0]) {
    return Response.json({ ok: false, error: "Unknown payment" }, { status: 404 });
  }
  const expectedAmount = Number(rows[0].amount_paise);
  const receivedAmount =
    provider === "stripe"
      ? Number(payload.data?.object?.amount_received ?? payload.data?.object?.amount ?? NaN)
      : Number(payload.payload?.payment?.entity?.amount ?? NaN);
  if (!Number.isFinite(receivedAmount) || receivedAmount !== expectedAmount) {
    return Response.json({ ok: false, error: "Payment amount mismatch" }, { status: 400 });
  }
  await sql`
    insert into payment_events (id, payment_id, provider_event_id, event_type, status, payload)
    values (${randomUUID()}, ${String(rows[0].id)}, ${eventId}, ${"payment.captured"}, ${"received"}, ${raw.slice(0, 4000)})`;
  if (String(rows[0].status) === "captured" || String(rows[0].status) === "sandbox_preview") {
    return Response.json({ ok: true, already: true });
  }
  const updated = await sql`
    update payments set status = ${"captured"}, confirmed_at = now()
    where id = ${String(rows[0].id)} and status = ${"created"}
    returning id`;
  if (updated[0]) {
    await sql`
      update tasks set status = ${"published"}, published_at = now()
      where id = ${String(rows[0].task_id)} and status in ('awaiting_payment','draft')`;
  }
  return Response.json({ ok: true, published: Boolean(updated[0]) });
}

export const Route = createFileRoute("/api/payments/webhook")({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
    },
  },
});
