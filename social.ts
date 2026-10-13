import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { MILESTONES } from "../constants";
import { QUIZ_QUESTION_COUNT } from "../points";
import { pickDailyQuiz } from "../quiz-bank";
import {
  asInt,
  assertDataUrlOrLink,
  ensureContest,
  fail,
  getSqlReady,
  iso,
  ledger,
  nid,
  requireProfile,
} from "./helpers";

export const getDailyQuiz = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const today = new Date().toISOString().slice(0, 10);
    const attempt = await sql<Record<string, unknown>>`
      select * from quiz_attempts where user_id = ${context.userId} and quiz_date = ${today}::date`;
    const questions = pickDailyQuiz(today, context.userId, QUIZ_QUESTION_COUNT).map(({ correct: _c, ...rest }, n) => ({
      id: n,
      ...rest,
    }));
    let attemptView: { correct: number; points: number; createdAt: string } | null = null;
    if (attempt[0]) {
      let extra = { correct: asInt(attempt[0].score), points: asInt(attempt[0].score) };
      try {
        const parsed = JSON.parse(String(attempt[0].answers ?? "{}")) as { correct?: number; points?: number };
        if (typeof parsed.points === "number") extra = { correct: parsed.correct ?? extra.correct, points: parsed.points };
      } catch {
        /* legacy row */
      }
      attemptView = { ...extra, createdAt: iso(attempt[0].created_at) };
    }
    return {
      date: today,
      questions,
      total: QUIZ_QUESTION_COUNT,
      attempt: attemptView,
    };
  });

export const submitDailyQuiz = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { answers: number[] }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const today = new Date().toISOString().slice(0, 10);
    const existing = await sql`
      select id from quiz_attempts where user_id = ${context.userId} and quiz_date = ${today}::date`;
    if (existing[0]) fail("Already attempted today's quiz");
    const questions = pickDailyQuiz(today, context.userId, QUIZ_QUESTION_COUNT);
    if (!Array.isArray(data.answers) || data.answers.length !== questions.length) {
      fail("Answer all 5 questions");
    }
    let correct = 0;
    let points = 0;
    questions.forEach((q, i) => {
      if (data.answers[i] === q.correct) {
        correct += 1;
        points += q.points;
      }
    });
    await sql`
      insert into quiz_attempts (id, user_id, quiz_date, score, answers)
      values (
        ${nid()},
        ${context.userId},
        ${today}::date,
        ${points},
        ${JSON.stringify({ picks: data.answers, correct, points })}
      )`;
    if (points > 0) {
      await ledger(
        sql,
        context.userId,
        points,
        "credit",
        "coins",
        "quiz",
        `Daily quiz +${points} points (${correct}/${questions.length})`,
        "quiz",
        today,
      );
    }
    return { correct, points, total: questions.length, already: false as const };
  });

export const getLeaderboard = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select p.user_id, p.display_name, p.gold_creator, w.lifetime_earned_paise, w.coins, p.streak_count
      from profiles p
      join wallets w on w.user_id = p.user_id
      where p.role = 'student'
      order by w.lifetime_earned_paise desc, w.coins desc
      limit 50`;
    return rows.map((r, i) => ({
      rank: i + 1,
      userId: String(r.user_id),
      name: String(r.display_name),
      goldCreator: r.gold_creator === true || r.gold_creator === "t",
      lifetimePaise: asInt(r.lifetime_earned_paise),
      coins: asInt(r.coins),
      streak: asInt(r.streak_count),
      isMe: String(r.user_id) === context.userId,
    }));
  });

export const getReferral = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const invited = await sql<{ n: number }>`
      select count(*)::int as n from profiles where referred_by = ${me.userId}`;
    return { code: me.referralCode, invited: asInt(invited[0]?.n) };
  });

export const getContest = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const contest = await ensureContest(sql);
    const id = String(contest.id);
    const entries = await sql<Record<string, unknown>>`
      select e.*, p.display_name,
        (select count(*)::int from contest_votes v where v.entry_id = e.id) as votes
      from contest_entries e join profiles p on p.user_id = e.user_id
      where e.contest_id = ${id}
      order by votes desc, e.created_at`;
    const mine = await sql`select id from contest_entries where contest_id = ${id} and user_id = ${context.userId}`;
    const voted = await sql<{ entry_id: string }>`
      select entry_id from contest_votes where contest_id = ${id} and voter_id = ${context.userId}`;
    return {
      id,
      title: String(contest.title),
      description: String(contest.description ?? ""),
      entries: entries.map((e) => ({
        id: String(e.id),
        name: String(e.display_name),
        caption: String(e.caption),
        imageUrl: String(e.image_url),
        votes: asInt(e.votes),
        isMine: String(e.user_id) === context.userId,
      })),
      hasEntry: Boolean(mine[0]),
      votedEntryId: voted[0]?.entry_id ?? null,
    };
  });

export const submitContest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { caption: string; imageUrl: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "student") fail("Only students can enter the contest", 403);
    const caption = data.caption.trim().slice(0, 140);
    if (caption.length < 2) fail("Add a caption");
    const imageUrl = assertDataUrlOrLink(data.imageUrl);
    const contest = await ensureContest(sql);
    await sql`
      insert into contest_entries (id, contest_id, user_id, caption, image_url)
      values (${nid()}, ${String(contest.id)}, ${me.userId}, ${caption}, ${imageUrl})
      on conflict (contest_id, user_id) do update set caption = ${caption}, image_url = ${imageUrl}`;
    return { ok: true as const };
  });

export const voteContest = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { entryId: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const contest = await ensureContest(sql);
    const entry = await sql<{ id: string; user_id: string; contest_id: string }>`
      select id, user_id, contest_id from contest_entries where id = ${data.entryId} limit 1`;
    if (!entry[0] || entry[0].contest_id !== String(contest.id)) fail("Entry not found");
    if (entry[0].user_id === context.userId) fail("You cannot vote for your own entry");
    await sql`delete from contest_votes where contest_id = ${String(contest.id)} and voter_id = ${context.userId}`;
    await sql`
      insert into contest_votes (id, contest_id, entry_id, voter_id)
      values (${nid()}, ${String(contest.id)}, ${data.entryId}, ${context.userId})`;
    return { ok: true as const };
  });

export const listAchievements = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const w = await sql<Record<string, unknown>>`select * from wallets where user_id = ${context.userId}`;
    const life = asInt(w[0]?.lifetime_earned_paise);
    const unlocked = await sql<Record<string, unknown>>`
      select * from achievements where user_id = ${context.userId}`;
    const claims = await sql<Record<string, unknown>>`
      select * from reward_claims where user_id = ${context.userId} order by created_at desc`;
    const certs = await sql<Record<string, unknown>>`
      select * from certificates where user_id = ${context.userId} order by issued_at desc`;
    return {
      lifetimePaise: life,
      goldCreator: me.goldCreator,
      ageBand: me.ageBand,
      guardianConsent: me.guardianConsent,
      milestones: MILESTONES.map((m) => ({
        ...m,
        reached: life >= m.paise,
        unlockedAt: unlocked.find((u) => asInt(u.milestone_paise) === m.paise)
          ? iso(unlocked.find((u) => asInt(u.milestone_paise) === m.paise)!.created_at)
          : null,
      })),
      claims: claims.map((c) => ({
        id: String(c.id),
        milestonePaise: asInt(c.milestone_paise),
        kind: String(c.kind),
        destination: c.destination ? String(c.destination) : null,
        status: String(c.status),
        createdAt: iso(c.created_at),
      })),
      certificates: certs.map((c) => ({
        id: String(c.id),
        userId: String(c.user_id),
        studentName: String(c.student_name),
        title: String(c.title),
        issuedAt: iso(c.issued_at),
      })),
    };
  });

export const requestReward = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { milestonePaise: number; destination?: string; guardianConsent?: boolean }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const w = await sql<Record<string, unknown>>`select * from wallets where user_id = ${context.userId}`;
    const life = asInt(w[0]?.lifetime_earned_paise);
    const m = MILESTONES.find((x) => x.paise === data.milestonePaise);
    if (!m) fail("Unknown milestone");
    if (life < m.paise) fail("You have not reached this milestone");
    if (m.physical && !m.configured) fail("This physical reward is not configured for fulfillment");
    if (me.ageBand === "13-17" && !data.guardianConsent && !me.guardianConsent) {
      fail("Guardian consent is required for minors");
    }
    const open = await sql`
      select id from reward_claims
      where user_id = ${context.userId} and milestone_paise = ${m.paise}
        and status not in ('cancelled','rejected','delivered')`;
    if (open[0]) fail("A claim is already in progress");
    const id = nid();
    await sql`
      insert into reward_claims (id, user_id, milestone_paise, kind, destination, status, guardian_consent, notes)
      values (${id}, ${me.userId}, ${m.paise}, ${m.kind}, ${data.destination?.trim() || null}, ${"requested"}, ${Boolean(data.guardianConsent || me.guardianConsent)}, ${"Eligibility recorded. Fulfillment is not automatic."})`;
    return { id, status: "requested" as const };
  });

export const getCertificatePublic = createServerFn({ method: "POST" })
  .validator((d: { id: string }) => d)
  .handler(async ({ data }) => {
    const sql = await getSqlReady();
    const rows = await sql<Record<string, unknown>>`
      select * from certificates where id = ${data.id} limit 1`;
    if (!rows[0]) return { certificate: null };
    return {
      certificate: {
        id: String(rows[0].id),
        userId: String(rows[0].user_id),
        studentName: String(rows[0].student_name),
        title: String(rows[0].title),
        issuedAt: iso(rows[0].issued_at),
      },
    };
  });
