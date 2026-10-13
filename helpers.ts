import { getSql, dbSource, type Sql } from "@/lib/db";
import { MILESTONES, MAX_DATA_URL_CHARS } from "../constants";
import type { Profile, Wallet, TaskSummary } from "../types";

export function nid() {
  return crypto.randomUUID();
}

export function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

export function isoOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = iso(v);
  return s || null;
}

export function asInt(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v) || 0;
  return 0;
}

export function asBool(v: unknown): boolean {
  return v === true || v === "t" || v === "true" || v === 1;
}

export function providerStatus() {
  const payments = Boolean(
    process.env.RAZORPAY_KEY_ID || process.env.STRIPE_SECRET_KEY,
  );
  const payouts = Boolean(
    process.env.RAZORPAY_KEY_ID || process.env.PAYOUT_PROVIDER_KEY,
  );
  return {
    payments,
    payouts,
    ai: Boolean(process.env.XAI_API_KEY),
    storage: Boolean(process.env.S3_BUCKET || process.env.STORAGE_BUCKET),
    adminSecret: Boolean(process.env.ADMIN_SECRET),
    previewDb: dbSource === "pglite",
  };
}

export async function requireProfile(sql: Sql, userId: string) {
  const rows = await sql<Record<string, unknown>>`
    select * from profiles where user_id = ${userId} limit 1`;
  if (!rows[0]) {
    const err = new Error("Complete onboarding first");
    (err as Error & { status: number }).status = 409;
    throw err;
  }
  if (asBool(rows[0].is_suspended)) {
    const err = new Error("Account suspended");
    (err as Error & { status: number }).status = 403;
    throw err;
  }
  return mapProfile(rows[0]);
}

export function mapProfile(r: Record<string, unknown>, email: string | null = null): Profile {
  return {
    userId: String(r.user_id),
    role: r.role === "client" ? "client" : "student",
    isAdmin: asBool(r.is_admin),
    displayName: String(r.display_name ?? ""),
    avatarUrl: r.avatar_url ? String(r.avatar_url) : null,
    bio: String(r.bio ?? ""),
    language: String(r.language ?? "en"),
    ageBand: r.age_band === "13-17" || r.age_band === "18+" ? r.age_band : null,
    guardianConsent: asBool(r.guardian_consent),
    goldCreator: asBool(r.gold_creator),
    upiId: r.upi_id ? String(r.upi_id) : null,
    notifyTasks: asBool(r.notify_tasks),
    notifyPayments: asBool(r.notify_payments),
    notifyAnnouncements: asBool(r.notify_announcements),
    onboardingComplete: asBool(r.onboarding_complete),
    referralCode: String(r.referral_code ?? ""),
    referredBy: r.referred_by ? String(r.referred_by) : null,
    streakCount: asInt(r.streak_count),
    lastStreakDate: isoOrNull(r.last_streak_date),
    email,
    createdAt: iso(r.created_at),
  };
}

export function mapWallet(r: Record<string, unknown> | undefined): Wallet {
  if (!r) return { availablePaise: 0, pendingPaise: 0, lifetimeEarnedPaise: 0, coins: 0 };
  return {
    availablePaise: asInt(r.available_paise),
    pendingPaise: asInt(r.pending_paise),
    lifetimeEarnedPaise: asInt(r.lifetime_earned_paise),
    coins: asInt(r.coins),
  };
}

export function mapTask(r: Record<string, unknown>, slotsOpen: number, clientName: string): TaskSummary {
  return {
    id: String(r.id),
    clientId: String(r.client_id),
    clientName,
    category: String(r.category),
    title: String(r.title),
    requirement: String(r.requirement ?? ""),
    description: String(r.description ?? ""),
    submissionType: String(r.submission_type),
    slotsTotal: asInt(r.slots_total),
    slotsOpen,
    pendingReview: asInt(r.pending_review),
    payoutPaise: asInt(r.payout_paise),
    platformFeePaise: asInt(r.platform_fee_paise),
    clientTotalPaise: asInt(r.client_total_paise),
    deadlineHours: asInt(r.deadline_hours),
    status: String(r.status),
    isTeam: asBool(r.is_team),
    referenceKind: r.reference_kind ? String(r.reference_kind) : null,
    referenceValue: r.reference_value ? String(r.reference_value) : null,
    createdAt: iso(r.created_at),
    publishedAt: isoOrNull(r.published_at),
  };
}

export async function notify(
  sql: Sql,
  userId: string,
  ntype: string,
  title: string,
  body: string,
  link?: string,
) {
  await sql`
    insert into notifications (id, user_id, ntype, title, body, link)
    values (${nid()}, ${userId}, ${ntype}, ${title}, ${body}, ${link ?? null})`;
}

export async function audit(
  sql: Sql,
  actorId: string | null,
  action: string,
  targetType?: string,
  targetId?: string,
  meta?: Record<string, unknown>,
) {
  await sql`
    insert into audit_logs (id, actor_id, action, target_type, target_id, meta)
    values (${nid()}, ${actorId}, ${action}, ${targetType ?? null}, ${targetId ?? null}, ${JSON.stringify(meta ?? {})})`;
}

export async function ledger(
  sql: Sql,
  userId: string,
  amountPaise: number,
  direction: "credit" | "debit",
  bucket: "available" | "pending" | "coins",
  entryType: string,
  description: string,
  refType?: string,
  refId?: string,
) {
  const amt = Math.abs(Math.round(amountPaise));
  if (amt <= 0) return;
  if (bucket === "coins") {
    if (direction === "credit") {
      const ok = await sql`
        update wallets set coins = coins + ${amt}, updated_at = now()
        where user_id = ${userId}`;
      void ok;
    } else {
      const rows = await sql`
        update wallets set coins = coins - ${amt}, updated_at = now()
        where user_id = ${userId} and coins >= ${amt}
        returning user_id`;
      if (!rows[0]) throw new Error("Insufficient coins");
    }
  } else if (bucket === "pending") {
    if (direction === "credit") {
      await sql`
        update wallets set pending_paise = pending_paise + ${amt}, updated_at = now()
        where user_id = ${userId}`;
    } else {
      const rows = await sql`
        update wallets set pending_paise = pending_paise - ${amt}, updated_at = now()
        where user_id = ${userId} and pending_paise >= ${amt}
        returning user_id`;
      if (!rows[0]) throw new Error("Insufficient pending balance");
    }
  } else {
    if (direction === "credit") {
      await sql`
        update wallets
        set available_paise = available_paise + ${amt},
            lifetime_earned_paise = lifetime_earned_paise + ${amt},
            updated_at = now()
        where user_id = ${userId}`;
    } else {
      const rows = await sql`
        update wallets set available_paise = available_paise - ${amt}, updated_at = now()
        where user_id = ${userId} and available_paise >= ${amt}
        returning user_id`;
      if (!rows[0]) throw new Error("Insufficient withdrawable balance");
    }
  }
  await sql`
    insert into ledger_entries
      (id, user_id, amount_paise, direction, bucket, entry_type, ref_type, ref_id, description)
    values
      (${nid()}, ${userId}, ${amt}, ${direction}, ${bucket}, ${entryType}, ${refType ?? null}, ${refId ?? null}, ${description})`;
}

export async function syncMilestones(sql: Sql, userId: string, name: string) {
  const w = await sql<Record<string, unknown>>`select * from wallets where user_id = ${userId}`;
  const life = asInt(w[0]?.lifetime_earned_paise);
  const approved = await sql<{ n: number }>`
    select count(*)::int as n from task_slots where student_id = ${userId} and status = 'approved'`;
  const gold = life >= 1_000_000 || asInt(approved[0]?.n) >= 10;
  if (gold) {
    await sql`update profiles set gold_creator = true, updated_at = now() where user_id = ${userId}`;
  }
  for (const m of MILESTONES) {
    if (life < m.paise) continue;
    const existing = await sql`
      select id from achievements where user_id = ${userId} and milestone_paise = ${m.paise} and kind = ${m.kind}`;
    if (existing[0]) continue;
    const achId = nid();
    await sql`
      insert into achievements (id, user_id, milestone_paise, kind)
      values (${achId}, ${userId}, ${m.paise}, ${m.kind})`;
    if (m.kind === "certificate" && m.configured && !m.physical) {
      const title = m.label;
      await sql`
        insert into certificates (id, user_id, achievement_id, student_name, title)
        values (${nid()}, ${userId}, ${achId}, ${name}, ${title})
        on conflict (user_id, title) do nothing`;
    }
    await notify(
      sql,
      userId,
      "achievement",
      "Milestone unlocked",
      m.label,
      "/app/achievements",
    );
  }
}

export function assertDataUrlOrLink(value: string) {
  const v = value.trim();
  if (!v) throw new Error("Submission is empty");
  if (v.startsWith("data:")) {
    if (v.length > MAX_DATA_URL_CHARS) {
      throw new Error("File is too large for in-app storage. Use a URL instead.");
    }
    if (!/^data:(image|application|video|text)\//.test(v)) {
      throw new Error("Unsupported file type");
    }
  } else if (!/^https?:\/\//i.test(v)) {
    throw new Error("Provide an http(s) URL or an attached file");
  }
  return v;
}

export async function expireOverdue(sql: Sql) {
  const overdue = await sql<{ id: string; task_id: string; student_id: string | null }>`
    select id, task_id, student_id from task_slots
    where status in ('claimed') and deadline_at is not null and deadline_at < now()`;
  for (const row of overdue) {
    const upd = await sql`
      update task_slots set status = 'expired' where id = ${row.id} and status = 'claimed' returning id`;
    if (!upd[0]) continue;
    await sql`insert into task_slots (id, task_id, status) values (${nid()}, ${row.task_id}, 'open')`;
    if (row.student_id) {
      await notify(
        sql,
        row.student_id,
        "deadline",
        "Deadline passed",
        "Your slot expired and was released.",
        `/app/tasks/${row.task_id}`,
      );
    }
  }
}

export async function ensureContest(sql: Sql) {
  const rows = await sql<Record<string, unknown>>`
    select * from contests where status = 'open' order by created_at desc limit 1`;
  if (rows[0]) return rows[0];
  const id = nid();
  await sql`
    insert into contests (id, title, description, status)
    values (${id}, ${"Weekly meme contest"}, ${"Submit an original meme. One entry per person. Votes are real and counted server-side."}, ${"open"})`;
  const created = await sql<Record<string, unknown>>`select * from contests where id = ${id}`;
  return created[0];
}

export async function getSqlReady(): Promise<Sql> {
  return getSql();
}

export function fail(message: string, status = 400): never {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  throw err;
}

export async function requireAdmin(sql: Sql, userId: string) {
  const p = await requireProfile(sql, userId);
  if (!p.isAdmin) fail("Admin only", 403);
  return p;
}

export function referralCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "GN";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}
