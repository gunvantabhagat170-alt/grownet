import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import {
  asInt,
  fail,
  getSqlReady,
  iso,
  isoOrNull,
  ledger,
  mapProfile,
  mapWallet,
  notify,
  providerStatus,
  referralCode,
  requireProfile,
} from "./helpers";

export const getProviderStatus = createServerFn({ method: "GET" }).handler(async () => {
  return providerStatus();
});

export const getMe = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const rows = await sql<Record<string, unknown>>`
      select * from profiles where user_id = ${context.userId} limit 1`;
    const walletRows = await sql<Record<string, unknown>>`
      select * from wallets where user_id = ${context.userId} limit 1`;
    const unread = await sql<{ n: number }>`
      select count(*)::int as n from notifications where user_id = ${context.userId} and read_at is null`;
    return {
      profile: rows[0]
        ? mapProfile(rows[0], null)
        : null,
      wallet: mapWallet(walletRows[0]),
      unread: asInt(unread[0]?.n),
      providers: providerStatus(),
    };
  });

export const completeOnboarding = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: {
    role: "student" | "client";
    displayName: string;
    ageBand: "13-17" | "18+";
    guardianConsent: boolean;
    language: string;
    referralCodeInput?: string;
  }) => d)
  .handler(async ({ context, data }) => {
    if (data.role !== "student" && data.role !== "client") fail("Choose Student or Client");
    const name = data.displayName.trim().slice(0, 80);
    if (name.length < 2) fail("Enter your name");
    if (data.ageBand === "13-17" && !data.guardianConsent) {
      fail("Guardian consent is required for ages 13–17");
    }
    const sql = await getSqlReady();
    const existing = await sql`select user_id from profiles where user_id = ${context.userId}`;
    if (existing[0]) fail("Profile already exists");
    let referredBy: string | null = null;
    const codeIn = data.referralCodeInput?.trim().toUpperCase();
    if (codeIn) {
      const ref = await sql<{ user_id: string }>`
        select user_id from profiles where referral_code = ${codeIn} limit 1`;
      if (ref[0] && ref[0].user_id !== context.userId) referredBy = ref[0].user_id;
    }
    let code = referralCode();
    for (let i = 0; i < 5; i += 1) {
      const clash = await sql`select user_id from profiles where referral_code = ${code}`;
      if (!clash[0]) break;
      code = referralCode();
    }
    const lang = ["en", "hi", "hinglish", "mr", "te"].includes(data.language) ? data.language : "en";
    await sql`
      insert into profiles (
        user_id, role, display_name, language, age_band, guardian_consent,
        onboarding_complete, referral_code, referred_by
      ) values (
        ${context.userId}, ${data.role}, ${name}, ${lang}, ${data.ageBand}, ${data.guardianConsent},
        true, ${code}, ${referredBy}
      )`;
    await sql`insert into wallets (user_id) values (${context.userId})`;
    await notify(
      sql,
      context.userId,
      "account",
      "Welcome to GrowNet",
      data.role === "student"
        ? "Your student profile is ready. Browse eligible tasks to start earning."
        : "Your client profile is ready. Post work when you are ready to publish.",
      "/app",
    );
    return { ok: true as const };
  });

export const updateProfile = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: {
    displayName?: string;
    bio?: string;
    language?: string;
    upiId?: string;
    avatarUrl?: string | null;
    notifyTasks?: boolean;
    notifyPayments?: boolean;
    notifyAnnouncements?: boolean;
  }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const p = await requireProfile(sql, context.userId);
    const displayName = data.displayName?.trim().slice(0, 80) || p.displayName;
    const bio = data.bio?.slice(0, 280) ?? p.bio;
    const language = data.language && ["en", "hi", "hinglish", "mr", "te"].includes(data.language)
      ? data.language
      : p.language;
    const upiId = data.upiId === undefined ? p.upiId : data.upiId.trim().slice(0, 80) || null;
    const avatarUrl = data.avatarUrl === undefined ? p.avatarUrl : data.avatarUrl;
    await sql`
      update profiles set
        display_name = ${displayName},
        bio = ${bio},
        language = ${language},
        upi_id = ${upiId},
        avatar_url = ${avatarUrl},
        notify_tasks = ${data.notifyTasks ?? p.notifyTasks},
        notify_payments = ${data.notifyPayments ?? p.notifyPayments},
        notify_announcements = ${data.notifyAnnouncements ?? p.notifyAnnouncements},
        updated_at = now()
      where user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const bumpStreak = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const p = await requireProfile(sql, context.userId);
    const today = new Date().toISOString().slice(0, 10);
    const last = p.lastStreakDate ? p.lastStreakDate.slice(0, 10) : null;
    if (last === today) return { streak: p.streakCount };
    const y = new Date();
    y.setUTCDate(y.getUTCDate() - 1);
    const yesterday = y.toISOString().slice(0, 10);
    const next = last === yesterday ? p.streakCount + 1 : 1;
    await sql`
      update profiles set streak_count = ${next}, last_streak_date = ${today}::date, updated_at = now()
      where user_id = ${context.userId}`;
    if (next > 0 && next % 7 === 0) {
      await ledger(sql, context.userId, 20, "credit", "coins", "streak", `7-day streak bonus`, "streak", today);
    }
    return { streak: next };
  });

export const listNotifications = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select * from notifications where user_id = ${context.userId}
      order by created_at desc limit 80`;
    return rows.map((r) => ({
      id: String(r.id),
      ntype: String(r.ntype),
      title: String(r.title),
      body: String(r.body ?? ""),
      link: r.link ? String(r.link) : null,
      readAt: isoOrNull(r.read_at),
      createdAt: iso(r.created_at),
    }));
  });

export const markNotificationsRead = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await sql`
      update notifications set read_at = now()
      where user_id = ${context.userId} and read_at is null`;
    return { ok: true as const };
  });
