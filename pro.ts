import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { assertOnPlatformMessage } from "../safety";
import {
  asBool,
  asInt,
  audit,
  fail,
  getSqlReady,
  iso,
  nid,
  notify,
  requireAdmin,
  requireProfile,
} from "./helpers";

const VIDEO = ["video_editing", "reel_editing", "long_video", "captions"];
const DESIGN = [
  "canva_design",
  "image_poster",
  "youtube_thumbnail",
  "image_editing",
  "background_removal",
  "social_post_design",
  "ppt_design",
  "product_image_editing",
  "advanced_design",
  "landing_page",
  "portfolio_design",
  "social_package",
];
const WRITING = ["content_writing", "caption_writing", "product_description", "proofreading", "short_transcription"];

export const LESSONS = [
  {
    id: "video-cut",
    track: "Video Editing",
    title: "Trim a short clip",
    steps: ["Import the practice clip", "Remove silence", "Export under the requested length"],
  },
  {
    id: "canva-poster",
    track: "Canva / design",
    title: "Poster layout",
    steps: ["Set the canvas size", "Use one headline and one image", "Check contrast"],
  },
  {
    id: "html-basics",
    track: "Basic coding",
    title: "A single page",
    steps: ["Add a heading and a paragraph", "Add one link", "Open it and check the text"],
  },
  {
    id: "writing-brief",
    track: "Writing",
    title: "Match the brief",
    steps: ["Read the word limit", "Answer every requested point", "Proofread once"],
  },
  {
    id: "web-test",
    track: "Website testing",
    title: "Report a bug",
    steps: ["Write the exact steps", "Note what you expected", "Describe what happened"],
  },
  {
    id: "app-test",
    track: "App testing",
    title: "Check one flow",
    steps: ["Start from the home screen", "Finish the flow", "List anything that broke"],
  },
] as const;

function istParts(d = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

function istMidnightUtc(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day, -5, -30, 0));
}

export function lastFullMonthKey(now = new Date()) {
  const { year, month } = istParts(now);
  const m = month === 1 ? 12 : month - 1;
  const y = month === 1 ? year - 1 : year;
  return `${y}-${String(m).padStart(2, "0")}`;
}

function monthBounds(yearMonth: string) {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) fail("Invalid month");
  const start = istMidnightUtc(y, m, 1);
  const end = m === 12 ? istMidnightUtc(y + 1, 1, 1) : istMidnightUtc(y, m + 1, 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

function weekStartIso(now = new Date()) {
  const { year, month, day } = istParts(now);
  const midnight = istMidnightUtc(year, month, day);
  const dow = midnight.getUTCDay();
  const delta = dow === 0 ? 6 : dow - 1;
  midnight.setUTCDate(midnight.getUTCDate() - delta);
  return midnight.toISOString();
}

type BoardRow = {
  userId: string;
  name: string;
  earningsPaise: number;
  tasks: number;
};

async function board(
  sql: Awaited<ReturnType<typeof getSqlReady>>,
  since: string,
  categories: string[] | null,
  rising: boolean,
) {
  const rows = categories
    ? await sql.query<Record<string, unknown>>(
        `select p.user_id, p.display_name,
          sum(coalesce(s.role_payout_paise, t.payout_paise))::int as earned,
          count(*)::int as tasks,
          min(s.approved_at) as first_done
        from task_slots s
        join tasks t on t.id = s.task_id
        join profiles p on p.user_id = s.student_id
        where s.status = 'approved'
          and s.approved_at >= $1::timestamptz
          and t.category = any($2::text[])
          and not exists (
            select 1 from disputes d where d.slot_id = s.id and d.status = 'open'
          )
        group by p.user_id, p.display_name
        order by earned desc, first_done asc
        limit 8`,
        [since, categories],
      )
    : await sql.query<Record<string, unknown>>(
        `select p.user_id, p.display_name,
          sum(coalesce(s.role_payout_paise, t.payout_paise))::int as earned,
          count(*)::int as tasks,
          min(s.approved_at) as first_done
        from task_slots s
        join tasks t on t.id = s.task_id
        join profiles p on p.user_id = s.student_id
        where s.status = 'approved'
          and s.approved_at >= $1::timestamptz
          and ($2::boolean = false or p.created_at >= $1::timestamptz - interval '30 days')
          and not exists (
            select 1 from disputes d where d.slot_id = s.id and d.status = 'open'
          )
        group by p.user_id, p.display_name
        order by earned desc, first_done asc
        limit 8`,
        [since, rising],
      );
  return rows.map((r) => ({
    userId: String(r.user_id),
    name: String(r.display_name || "Student"),
    earningsPaise: asInt(r.earned),
    tasks: asInt(r.tasks),
  }));
}

export const getTaskRadar = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select t.category, count(*)::int as open_slots
      from task_slots s
      join tasks t on t.id = s.task_id
      where s.status = 'open' and t.status in ('published', 'in_progress')
      group by t.category
      order by open_slots desc, t.category`;
    return rows.map((r) => ({ category: String(r.category), openSlots: asInt(r.open_slots) }));
  });

export const getWeeklyLeague = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const since = weekStartIso();
    const [video, design, writing, rising] = await Promise.all([
      board(sql, since, VIDEO, false),
      board(sql, since, DESIGN, false),
      board(sql, since, WRITING, false),
      board(sql, since, null, true),
    ]);
    return { since, video, design, writing, rising };
  });

export const getLessons = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const done = await sql<Record<string, unknown>>`
      select lesson_id from lesson_progress where user_id = ${context.userId}`;
    const ids = new Set(done.map((r) => String(r.lesson_id)));
    return LESSONS.map((lesson) => ({ ...lesson, done: ids.has(lesson.id) }));
  });

export const completeLesson = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { lessonId: string }) => d)
  .handler(async ({ context, data }) => {
    if (!LESSONS.some((l) => l.id === data.lessonId)) fail("Unknown lesson");
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    await sql`
      insert into lesson_progress (user_id, lesson_id)
      values (${me.userId}, ${data.lessonId})
      on conflict do nothing`;
    return { ok: true as const };
  });

const TICKET_TOPICS = ["login", "tasks", "payments", "withdrawals", "account", "refunds", "disputes"] as const;

export const listTickets = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select * from support_tickets where user_id = ${context.userId}
      order by created_at desc limit 30`;
    return rows.map((r) => ({
      id: String(r.id),
      topic: String(r.topic),
      body: String(r.body),
      status: String(r.status),
      createdAt: iso(r.created_at),
    }));
  });

export const createTicket = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { topic: string; body: string }) => d)
  .handler(async ({ context, data }) => {
    if (!TICKET_TOPICS.includes(data.topic as (typeof TICKET_TOPICS)[number])) fail("Unknown topic");
    const body = data.body.trim().slice(0, 1000);
    if (body.length < 8) fail("Describe the issue");
    assertOnPlatformMessage(body);
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from support_tickets
      where user_id = ${me.userId} and created_at > now() - interval '1 hour'`;
    if (asInt(recent[0]?.n) >= 5) fail("Too many tickets. Try again later.", 429);
    const id = nid();
    await sql`
      insert into support_tickets (id, user_id, topic, body, status)
      values (${id}, ${me.userId}, ${data.topic}, ${body}, 'open')`;
    return { id };
  });

export const getAwardConsent = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select show_earnings, show_photo from profiles where user_id = ${me.userId}`;
    return {
      showEarnings: asBool(rows[0]?.show_earnings),
      showPhoto: asBool(rows[0]?.show_photo),
    };
  });

export const setAwardConsent = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { showEarnings: boolean; showPhoto: boolean }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    await sql`
      update profiles
      set show_earnings = ${Boolean(data.showEarnings)},
          show_photo = ${Boolean(data.showPhoto)},
          updated_at = now()
      where user_id = ${context.userId}`;
    return { ok: true as const };
  });

export const listMonthlyAwards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const latest = await sql<{ year_month: string }>`
      select year_month from monthly_awards order by year_month desc limit 1`;
    const yearMonth = latest[0]?.year_month ?? null;
    if (!yearMonth) return { yearMonth: null as string | null, rows: [] };
    const rows = await sql<Record<string, unknown>>`
      select a.*, p.avatar_url, p.show_photo
      from monthly_awards a
      join profiles p on p.user_id = a.user_id
      where a.year_month = ${yearMonth}
      order by a.category, a.rank`;
    return {
      yearMonth,
      rows: rows.map((r) => ({
        id: String(r.id),
        category: String(r.category),
        rank: asInt(r.rank),
        name: String(r.display_name),
        earningsPaise: r.show_earnings === true || r.show_earnings === "t" ? asInt(r.earnings_paise) : null,
        tasks: asInt(r.task_count),
        certificateId: r.certificate_id ? String(r.certificate_id) : null,
        avatarUrl: r.show_photo === true || r.show_photo === "t" ? (r.avatar_url ? String(r.avatar_url) : null) : null,
      })),
    };
  });

async function earnersBetween(
  sql: Awaited<ReturnType<typeof getSqlReady>>,
  start: string,
  end: string,
  categories: string[] | null,
  rising: boolean,
) {
  if (categories) {
    return sql.query<Record<string, unknown>>(
      `select p.user_id, p.display_name, p.show_earnings,
        sum(coalesce(s.role_payout_paise, t.payout_paise))::int as earned,
        count(*)::int as tasks
      from task_slots s
      join tasks t on t.id = s.task_id
      join profiles p on p.user_id = s.student_id
      where s.status = 'approved'
        and s.approved_at >= $1::timestamptz
        and s.approved_at < $2::timestamptz
        and t.category = any($3::text[])
        and not exists (select 1 from disputes d where d.slot_id = s.id and d.status = 'open')
      group by p.user_id, p.display_name, p.show_earnings
      order by earned desc, min(s.approved_at) asc
      limit 3`,
      [start, end, categories],
    );
  }
  return sql.query<Record<string, unknown>>(
    `select p.user_id, p.display_name, p.show_earnings,
      sum(coalesce(s.role_payout_paise, t.payout_paise))::int as earned,
      count(*)::int as tasks
    from task_slots s
    join tasks t on t.id = s.task_id
    join profiles p on p.user_id = s.student_id
    where s.status = 'approved'
      and s.approved_at >= $1::timestamptz
      and s.approved_at < $2::timestamptz
      and ($3::boolean = false or (p.created_at >= $1::timestamptz and p.created_at < $2::timestamptz))
      and not exists (select 1 from disputes d where d.slot_id = s.id and d.status = 'open')
    group by p.user_id, p.display_name, p.show_earnings
    order by earned desc, min(s.approved_at) asc
    limit 3`,
    [start, end, rising],
  );
}

export const computeMonthlyAwards = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const yearMonth = lastFullMonthKey();
    const existing = await sql<{ n: number }>`
      select count(*)::int as n from monthly_awards where year_month = ${yearMonth}`;
    if (asInt(existing[0]?.n) > 0) {
      return { yearMonth, created: 0, already: true as const };
    }
    const { start, end } = monthBounds(yearMonth);
    const overall = await earnersBetween(sql, start, end, null, false);
    const video = await earnersBetween(sql, start, end, VIDEO, false);
    const design = await earnersBetween(sql, start, end, DESIGN, false);
    const writing = await earnersBetween(sql, start, end, WRITING, false);
    const rising = await earnersBetween(sql, start, end, null, true);
    const groups: { category: string; rows: Record<string, unknown>[]; take: number }[] = [
      { category: "top", rows: overall, take: 3 },
      { category: "video", rows: video.slice(0, 1), take: 1 },
      { category: "design", rows: design.slice(0, 1), take: 1 },
      { category: "writing", rows: writing.slice(0, 1), take: 1 },
      { category: "rising", rows: rising.slice(0, 1), take: 1 },
    ];
    const titles: Record<string, string[]> = {
      top: ["Monthly Top Earner", "Second Highest Earner", "Third Highest Earner"],
      video: ["Top Video Editor"],
      design: ["Top Designer"],
      writing: ["Top Writer"],
      rising: ["Rising Creator"],
    };
    let created = 0;
    for (const group of groups) {
      for (let i = 0; i < Math.min(group.take, group.rows.length); i += 1) {
        const row = group.rows[i];
        if (!row || asInt(row.earned) <= 0) continue;
        const userId = String(row.user_id);
        const name = String(row.display_name || "Student");
        const title = `${titles[group.category][i]} · ${yearMonth}`;
        const certId = nid();
        await sql`
          insert into certificates (id, user_id, student_name, title)
          values (${certId}, ${userId}, ${name}, ${title})
          on conflict (user_id, title) do nothing`;
        const cert = await sql<{ id: string }>`
          select id from certificates where user_id = ${userId} and title = ${title} limit 1`;
        const certificateId = cert[0]?.id ?? null;
        await sql`
          insert into monthly_awards (
            id, year_month, category, rank, user_id, display_name,
            earnings_paise, task_count, show_earnings, certificate_id
          ) values (
            ${nid()}, ${yearMonth}, ${group.category}, ${i + 1}, ${userId}, ${name},
            ${asInt(row.earned)}, ${asInt(row.tasks)}, ${asBool(row.show_earnings)}, ${certificateId}
          )
          on conflict (year_month, category, rank) do nothing`;
        if (certificateId) {
          await notify(sql, userId, "award", title, "Your monthly award certificate is ready to verify.", `/verify/${certificateId}`);
        }
        created += 1;
      }
    }
    await audit(sql, context.userId, "awards.computed", "month", yearMonth, { created });
    return { yearMonth, created, already: false as const };
  });
