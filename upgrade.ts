import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { PLATFORM_FEE_BPS } from "../constants";
import { MIN_WITHDRAWAL_PAISE } from "../points";
import { asInt, audit, fail, getSqlReady, nid, notify, requireAdmin, requireProfile } from "./helpers";

type Settings = {
  commissionBps: number;
  minWithdrawalPaise: number;
  quizPoints: number;
  quizInrPaise: number;
  referralCoins: number;
};

export async function loadSettings(): Promise<Settings> {
  const sql = await getSqlReady();
  const rows = await sql<Record<string, unknown>>`
    select * from platform_settings where id = ${"default"} limit 1`;
  const row = rows[0];
  return {
    commissionBps: row ? asInt(row.commission_bps) || PLATFORM_FEE_BPS : PLATFORM_FEE_BPS,
    minWithdrawalPaise: row ? asInt(row.min_withdrawal_paise) || MIN_WITHDRAWAL_PAISE : MIN_WITHDRAWAL_PAISE,
    quizPoints: row ? asInt(row.quiz_points) || 500 : 500,
    quizInrPaise: row ? asInt(row.quiz_inr_paise) || 2500 : 2500,
    referralCoins: row ? asInt(row.referral_coins) || 50 : 50,
  };
}

export const getPlatformSettings = createServerFn({ method: "GET" }).handler(async () => loadSettings());

export const getStudentHub = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const skills = await sql<Record<string, unknown>>`
      select s.id, s.name, coalesce(us.level, 'beginner') as level,
             coalesce(us.verified, false) as verified, coalesce(us.score, 0) as score
      from skills s
      left join user_skills us on us.skill_id = s.id and us.user_id = ${me.userId}
      order by s.name`;
    const portfolio = await sql<Record<string, unknown>>`
      select id, title, summary, public_url, share_client_work, created_at
      from portfolio_items where user_id = ${me.userId}
      order by created_at desc limit 20`;
    const badges = await sql<Record<string, unknown>>`
      select b.code, b.title, b.description, ub.awarded_at
      from user_badges ub join badges b on b.id = ub.badge_id
      where ub.user_id = ${me.userId}`;
    const missions = await sql<Record<string, unknown>>`
      select m.id, m.code, m.title, m.points,
        exists (
          select 1 from mission_progress p
          where p.user_id = ${me.userId} and p.mission_id = m.id and p.mission_date = current_date and p.completed
        ) as done
      from daily_missions m where m.active
      order by m.title`;
    const recs = await sql<Record<string, unknown>>`
      select t.id, t.title, t.category, t.difficulty, t.payout_paise,
        (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'open') as slots_open
      from tasks t
      where t.status in ('published', 'in_progress')
      order by t.published_at desc nulls last
      limit 12`;
    const skillIds = new Set(skills.filter((s) => asInt(s.score) > 0 || s.verified === true).map((s) => String(s.id)));
    const recommended = recs
      .map((r) => ({
        id: String(r.id),
        title: String(r.title),
        category: String(r.category),
        difficulty: String(r.difficulty ?? "beginner"),
        payoutPaise: asInt(r.payout_paise),
        slotsOpen: asInt(r.slots_open),
        match: skillIds.has(String(r.category)) || skillIds.size === 0,
      }))
      .filter((r) => r.slotsOpen > 0)
      .sort((a, b) => Number(b.match) - Number(a.match))
      .slice(0, 4);
    return {
      skillLevel: me.role === "student" ? "beginner" : "beginner",
      reputation: 0,
      skills: skills.map((s) => ({
        id: String(s.id),
        name: String(s.name),
        level: String(s.level),
        verified: s.verified === true || s.verified === "t",
        score: asInt(s.score),
      })),
      portfolio: portfolio.map((p) => ({
        id: String(p.id),
        title: String(p.title),
        summary: String(p.summary ?? ""),
        publicUrl: p.public_url && p.share_client_work !== false ? String(p.public_url) : null,
        createdAt: String(p.created_at),
      })),
      badges: badges.map((b) => ({
        code: String(b.code),
        title: String(b.title),
        description: String(b.description ?? ""),
        awardedAt: String(b.awarded_at),
      })),
      missions: missions.map((m) => ({
        id: String(m.id),
        code: String(m.code),
        title: String(m.title),
        points: asInt(m.points),
        done: m.done === true || m.done === "t",
      })),
      recommended,
    };
  });

export const setSkillLevel = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { skillId: string; level: string }) => d)
  .handler(async ({ context, data }) => {
    const level = data.level;
    if (!["beginner", "intermediate", "advanced", "pro"].includes(level)) fail("Unknown skill level");
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "student") fail("Students only", 403);
    await sql`
      insert into user_skills (user_id, skill_id, level, verified, score)
      values (${me.userId}, ${data.skillId}, ${level}, false, 0)
      on conflict (user_id, skill_id) do update set level = ${level}`;
    await sql`update profiles set skill_level = ${level}, updated_at = now() where user_id = ${me.userId}`;
    return { ok: true as const };
  });

export const addPortfolioItem = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { title: string; summary: string; publicUrl?: string; skillId?: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const title = data.title.trim().slice(0, 80);
    if (title.length < 3) fail("Add a title");
    const url = data.publicUrl?.trim() || null;
    if (url && !/^https?:\/\//i.test(url)) fail("Portfolio link must be http(s)");
    await sql`
      insert into portfolio_items (id, user_id, title, skill_id, summary, public_url, share_client_work)
      values (${nid()}, ${me.userId}, ${title}, ${data.skillId || null}, ${data.summary.trim().slice(0, 400)}, ${url}, ${Boolean(url)})`;
    return { ok: true as const };
  });

export const fileReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { targetType: string; targetId?: string; reason: string; details?: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const reason = data.reason.trim().slice(0, 240);
    if (reason.length < 4) fail("Describe the report");
    if (!["task", "user", "payment", "account", "dispute"].includes(data.targetType)) fail("Unknown report type");
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from reports
      where reporter_id = ${me.userId} and created_at > now() - interval '1 hour'`;
    if (asInt(recent[0]?.n) >= 8) fail("Too many reports. Try again later.", 429);
    const id = nid();
    await sql`
      insert into reports (id, reporter_id, target_type, target_id, reason, details)
      values (${id}, ${me.userId}, ${data.targetType}, ${data.targetId ?? null}, ${reason}, ${(data.details ?? "").slice(0, 2000)})`;
    await audit(sql, me.userId, "report.opened", data.targetType, data.targetId ?? id, { reason });
    return { id };
  });

export const completeVerifiedMission = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { code: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const missions = await sql<Record<string, unknown>>`
      select * from daily_missions where code = ${data.code} and active limit 1`;
    if (!missions[0]) fail("Unknown mission");
    const mission = missions[0];
    let eligible = false;
    if (data.code === "daily_quiz") {
      const quiz = await sql`select id from quiz_attempts where user_id = ${me.userId} and quiz_date = current_date`;
      eligible = Boolean(quiz[0]);
    } else if (data.code === "review_task") {
      const seen = await sql`select id from task_attempts where student_id = ${me.userId} and created_at::date = current_date`;
      eligible = Boolean(seen[0]);
    } else if (data.code === "keep_streak") {
      const streak = await sql`select streak_count from profiles where user_id = ${me.userId} and last_streak_date = current_date`;
      eligible = Boolean(streak[0]);
    }
    if (!eligible) fail("Complete the real action before claiming this mission");
    const inserted = await sql`
      insert into mission_progress (user_id, mission_id, mission_date, completed)
      values (${me.userId}, ${String(mission.id)}, current_date, true)
      on conflict (user_id, mission_id, mission_date) do nothing
      returning user_id`;
    if (!inserted[0]) return { ok: true as const, already: true };
    const { ledger } = await import("./helpers");
    await ledger(
      sql,
      me.userId,
      asInt(mission.points),
      "credit",
      "coins",
      "mission",
      `Daily mission: ${String(mission.title)}`,
      "mission",
      String(mission.id),
    );
    return { ok: true as const, already: false, points: asInt(mission.points) };
  });

export const adminListReports = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select * from reports order by created_at desc limit 50`;
    return rows.map((r) => ({
      id: String(r.id),
      reporterId: String(r.reporter_id),
      targetType: String(r.target_type),
      targetId: r.target_id ? String(r.target_id) : null,
      reason: String(r.reason),
      status: String(r.status),
      createdAt: String(r.created_at),
    }));
  });

export const adminResolveReport = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { id: string; status: string; resolution: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const admin = await requireAdmin(sql, context.userId);
    if (!["open", "reviewing", "resolved", "rejected"].includes(data.status)) fail("Unknown status");
    await sql`
      update reports set status = ${data.status}, resolution = ${data.resolution.slice(0, 500)},
        resolved_at = case when ${data.status} in ('resolved', 'rejected') then now() else resolved_at end
      where id = ${data.id}`;
    await audit(sql, admin.userId, "report.resolved", "report", data.id, { status: data.status });
    const row = await sql<{ reporter_id: string }>`select reporter_id from reports where id = ${data.id}`;
    if (row[0]) {
      await notify(sql, row[0].reporter_id, "report", "Report updated", data.resolution.slice(0, 180), "/app");
    }
    return { ok: true as const };
  });

export const adminSaveSettings = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { commissionBps: number; minWithdrawalPaise: number; quizPoints: number; quizInrPaise: number }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const admin = await requireAdmin(sql, context.userId);
    const commissionBps = Math.min(5000, Math.max(0, Math.round(data.commissionBps)));
    const minWithdrawalPaise = Math.max(100, Math.round(data.minWithdrawalPaise));
    const quizPoints = Math.max(1, Math.round(data.quizPoints));
    const quizInrPaise = Math.max(1, Math.round(data.quizInrPaise));
    await sql`
      insert into platform_settings (id, commission_bps, min_withdrawal_paise, quiz_points, quiz_inr_paise, updated_at)
      values ('default', ${commissionBps}, ${minWithdrawalPaise}, ${quizPoints}, ${quizInrPaise}, now())
      on conflict (id) do update set
        commission_bps = ${commissionBps},
        min_withdrawal_paise = ${minWithdrawalPaise},
        quiz_points = ${quizPoints},
        quiz_inr_paise = ${quizInrPaise},
        updated_at = now()`;
    await audit(sql, admin.userId, "settings.updated", "platform_settings", "default", { commissionBps });
    return { ok: true as const };
  });

export const adminSetFlag = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { key: string; enabled: boolean }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const admin = await requireAdmin(sql, context.userId);
    await sql`
      insert into feature_flags (key, enabled) values (${data.key}, ${data.enabled})
      on conflict (key) do update set enabled = ${data.enabled}`;
    await audit(sql, admin.userId, "flag.updated", "feature_flag", data.key, { enabled: data.enabled });
    return { ok: true as const };
  });

export const adminListFlags = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`select key, enabled, note from feature_flags order by key`;
    return rows.map((r) => ({ key: String(r.key), enabled: r.enabled === true || r.enabled === "t", note: String(r.note ?? "") }));
  });
