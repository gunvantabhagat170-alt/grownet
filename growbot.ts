import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { fail, getSqlReady, requireProfile } from "./helpers";

const SYSTEM = `You are GrowBot, GrowNet's in-app assistant for students and clients.
GrowNet is a student earning marketplace. Clients post digital work. Eligible students claim open slots. Clients do not preselect students.
Be role-aware. Never execute financial actions, approve payments, change balances, or bypass authorization.
If asked to move payments off-platform, refuse and keep work on GrowNet.
Never ask for or accept OTPs, passwords, UPI PINs, bank passwords, or other private secrets.
Never discuss how GrowNet was built, which tools were used, or internal development.
Keep answers concise, practical, and suitable for ages 13+.`;

function localGrowBot(message: string, role: string, name: string): string {
  const m = message.toLowerCase();
  if (/otp|password|upi\s*pin|atm pin|cvv|bank (password|pin)/i.test(m)) {
    return "Never share OTPs, passwords, UPI PINs, bank passwords, or card details with anyone — including people in chat or on WhatsApp. GrowNet will not ask for those.";
  }
  if (/how (was|is) grownet (built|created|made|coded)|which ai|chatgpt|internal development|who (coded|programmed)/i.test(m)) {
    return `I can help you use GrowNet, ${name}. I don't discuss how the product was made. Ask about tasks, wallet, quiz, or account help.`;
  }
  if (/withdraw|minimum|₹\s*69|\b69\b/.test(m)) {
    return "Withdrawals are for real ledger earnings. The minimum request is ₹69. If your withdrawable balance is below ₹69, add earnings first, then request payout to the UPI ID saved in your profile.";
  }
  if (/point|coin|₹\s*1|20 points|500 points/.test(m)) {
    return "Quiz and reward points use a fixed rate: 20 points = ₹1, so 500 points = ₹25. Points are not rupees one-for-one.";
  }
  if (/quiz/.test(m)) {
    return "The daily quiz has 5 general-knowledge questions. Each correct answer is worth 10–15 points. You can complete it once per day; points are added only once.";
  }
  if (/fee|10%|pricing|₹99/.test(m)) {
    return "GrowNet adds a transparent 10% platform fee. Example: ₹99 to the student, ₹9.90 fee, client total ₹108.90.";
  }
  if (/community|whatsapp|help group|support/.test(m)) {
    return "Use Profile or Home to join the official GrowNet Community on WhatsApp for help and questions. Do not share OTPs, passwords, or UPI PINs in the group.";
  }
  if (/claim|accept|slot|task/.test(m)) {
    return role === "client"
      ? "Post a brief, set student slots, review the 10% fee, then pay. Eligible students claim open slots themselves — you do not pick a student in advance."
      : "Open Tasks, choose an eligible job, and accept an open slot. Submit before the deadline. You may attempt the same task up to 2 times.";
  }
  if (/certificate|gold|milestone/.test(m)) {
    return "Certificates and Gold Creator status come from real approved earnings. Rewards stay as eligibility until fulfillment is confirmed — nothing is marked delivered by default.";
  }
  if (role === "client") {
    return `Hi ${name}. I can help you post work, review submissions, and understand fees. Try asking about publishing a task, revisions, or payouts.`;
  }
  return `Hi ${name}. I can help with tasks, the daily quiz, wallet points (20 points = ₹1), withdrawals (minimum ₹69), and community help. What do you need?`;
}

async function askModel(key: string, messages: { role: string; content: string }[]) {
  const models = ["grok-4.5", "grok-3", "grok-2"];
  for (const model of models) {
    try {
      const res = await fetch("https://api.x.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ model, max_tokens: 400, messages }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = body.choices?.[0]?.message?.content?.trim() ?? "";
      if (text) return text;
    } catch {
      /* try next model */
    }
  }
  return null;
}

export const askGrowBot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { message: string; history?: { role: "user" | "assistant"; content: string }[] }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const message = data.message.trim().slice(0, 2000);
    if (!message) fail("Enter a message");
    const history = (data.history ?? []).slice(-8).map((m) => ({
      role: m.role,
      content: m.content.slice(0, 2000),
    }));
    const fallback = localGrowBot(message, me.role, me.displayName);
    const key = process.env.XAI_API_KEY;
    if (key) {
      const text = await askModel(key, [
        {
          role: "system",
          content: `${SYSTEM}\nThe current user is a ${me.role} named ${me.displayName}.`,
        },
        ...history,
        { role: "user", content: message },
      ]);
      if (text) return { ok: true as const, text };
    }
    return { ok: true as const, text: fallback };
  });
