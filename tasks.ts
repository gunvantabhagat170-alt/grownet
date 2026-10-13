import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { CATEGORIES, MAX_TASK_ATTEMPTS, categoryById } from "../constants";
import { calcPrice, minimumPayoutPaise } from "../pricing";
import { assertOnPlatformMessage, assertSafeTaskText } from "../safety";
import { verifySubmission } from "../verify";
import { loadSettings } from "./upgrade";
import {
  asInt,
  assertDataUrlOrLink,
  expireOverdue,
  fail,
  getSqlReady,
  iso,
  isoOrNull,
  ledger,
  mapTask,
  nid,
  notify,
  providerStatus,
  requireProfile,
  syncMilestones,
} from "./helpers";

function isCategory(id: string) {
  return CATEGORIES.some((c) => c.id === id);
}

export const listPublishedTasks = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { q?: string; category?: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    await expireOverdue(sql);
    const q = data.q?.trim().toLowerCase() ?? "";
    const cat = data.category?.trim() || "";
    const rows = await sql<Record<string, unknown>>`
      select t.*, p.display_name as client_name,
        (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'open') as slots_open,
        (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'submitted') as pending_review
      from tasks t
      join profiles p on p.user_id = t.client_id
      where t.status in ('published', 'in_progress')
      order by t.published_at desc nulls last, t.created_at desc
      limit 80`;
    return rows
      .map((r) => mapTask(r, asInt(r.slots_open), String(r.client_name ?? "Client")))
      .filter((t) => {
        if (cat && t.category !== cat) return false;
        if (!q) return true;
        const hay = `${t.title} ${t.category} ${t.clientName}`.toLowerCase();
        return hay.includes(q);
      })
      .map((t) => ({
        ...t,
        requirement: t.requirement.slice(0, 280),
        description: t.description.slice(0, 280),
        referenceValue: null,
      }));
  });

export const getTaskDetail = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { taskId: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    await expireOverdue(sql);
    const tasks = await sql<Record<string, unknown>>`
      select t.*, p.display_name as client_name,
        (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'open') as slots_open,
        (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'submitted') as pending_review
      from tasks t join profiles p on p.user_id = t.client_id
      where t.id = ${data.taskId} limit 1`;
    if (!tasks[0]) fail("Task not found", 404);
    const t = tasks[0];
    const slots = await sql<Record<string, unknown>>`
      select s.*, pr.display_name as student_name
      from task_slots s
      left join profiles pr on pr.user_id = s.student_id
      where s.task_id = ${data.taskId}
      order by s.id`;
    const isClient = me.userId === String(t.client_id);
    const isStudentOn = slots.some((s) => s.student_id === me.userId);
    const isAdmin = me.isAdmin;
    const published = ["published", "in_progress", "completed"].includes(String(t.status));
    if (!isClient && !isStudentOn && !isAdmin && !published) fail("Not allowed", 403);

    const mySlots = slots.filter((s) => s.student_id === me.userId);
    const slotIds = (isClient || isAdmin ? slots : mySlots).map((s) => String(s.id));
    let submissions: Record<string, unknown>[] = [];
    let revisions: Record<string, unknown>[] = [];
    let disputes: Record<string, unknown>[] = [];
    if (slotIds.length) {
      const ph = slotIds.map((_, i) => `$${i + 1}`).join(",");
      submissions = await sql.query(
        `select * from submissions where slot_id in (${ph}) order by created_at`,
        slotIds,
      );
      revisions = await sql.query(
        `select * from revisions where slot_id in (${ph}) order by created_at`,
        slotIds,
      );
      disputes = await sql.query(
        `select * from disputes where slot_id in (${ph}) order by created_at`,
        slotIds,
      );
    }
    const attempts = await sql<{ n: number }>`
      select count(*)::int as n from task_attempts
      where task_id = ${data.taskId} and student_id = ${me.userId}`;
    const messages = isClient || isStudentOn || isAdmin
      ? await sql<Record<string, unknown>>`
          select m.*, p.display_name as sender_name
          from messages m join profiles p on p.user_id = m.sender_id
          where m.task_id = ${data.taskId}
          order by m.created_at`
      : [];
    const showPrivate = isClient || isStudentOn || isAdmin;
    return {
      task: {
        ...mapTask(
          t,
          slots.filter((s) => s.status === "open").length,
          String(t.client_name ?? "Client"),
        ),
        referenceValue: showPrivate ? (t.reference_value ? String(t.reference_value) : null) : null,
        referenceKind: showPrivate ? (t.reference_kind ? String(t.reference_kind) : null) : null,
      },
      private: showPrivate,
      slots: slots.map((s) => ({
        id: String(s.id),
        taskId: String(s.task_id),
        studentId: s.student_id ? String(s.student_id) : null,
        studentName: isClient || isAdmin || s.student_id === me.userId
          ? s.student_name
            ? String(s.student_name)
            : null
          : s.student_id
            ? "Student"
            : null,
        status: String(s.status),
        roleLabel: s.role_label ? String(s.role_label) : null,
        rolePayoutPaise: s.role_payout_paise == null ? null : asInt(s.role_payout_paise),
        attemptCount: asInt(s.attempt_count),
        claimedAt: isoOrNull(s.claimed_at),
        deadlineAt: isoOrNull(s.deadline_at),
        approvedAt: isoOrNull(s.approved_at),
      })),
      submissions: submissions.map((s) => ({
        id: String(s.id),
        slotId: String(s.slot_id),
        version: asInt(s.version),
        submissionType: String(s.submission_type),
        contentText: String(s.content_text ?? ""),
        createdAt: iso(s.created_at),
      })),
      revisions: revisions.map((r) => ({
        id: String(r.id),
        slotId: String(r.slot_id),
        instructions: String(r.instructions),
        createdAt: iso(r.created_at),
      })),
      disputes: disputes.map((d) => ({
        id: String(d.id),
        slotId: String(d.slot_id),
        reason: String(d.reason),
        status: String(d.status),
        createdAt: iso(d.created_at),
      })),
      messages: messages.map((m) => ({
        id: String(m.id),
        taskId: String(m.task_id),
        slotId: m.slot_id ? String(m.slot_id) : null,
        senderId: String(m.sender_id),
        senderName: String(m.sender_name ?? "Member"),
        body: String(m.body),
        createdAt: iso(m.created_at),
      })),
      myAttemptCount: asInt(attempts[0]?.n),
      meId: me.userId,
      meRole: me.role,
      providers: providerStatus(),
    };
  });

export const createTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: {
    category: string;
    title: string;
    requirement: string;
    description: string;
    submissionType: string;
    slots: number;
    payoutPaise: number;
    deadlineHours: number;
    referenceKind?: string;
    referenceValue?: string;
    difficulty?: string;
    videoSeconds?: number;
    roles?: { label: string; payoutPaise: number }[];
  }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "client") fail("Only clients can post work", 403);
    if (!isCategory(data.category)) fail("Unknown category");
    const title = data.title.trim().slice(0, 120);
    if (title.length < 4) fail("Enter a clear title");
    const videoSeconds = data.videoSeconds ? Math.max(0, Math.round(data.videoSeconds)) : null;
    const floor = minimumPayoutPaise(data.category, videoSeconds);
    const cat = categoryById(data.category);
    const roles = (data.roles ?? [])
      .map((role) => ({
        label: role.label.trim().slice(0, 40),
        payoutPaise: Math.round(role.payoutPaise),
      }))
      .filter((role) => role.label.length >= 2);
    const team = roles.length >= 2;
    if (team && roles.length > 6) fail("A team can have at most 6 roles");
    for (const role of roles) {
      if (role.payoutPaise < floor) {
        fail(`Each role must pay at least ₹${(floor / 100).toFixed(0)}`);
      }
    }
    const slots = team ? roles.length : Math.min(20, Math.max(1, Math.round(data.slots)));
    const requestedPayout = Number.isFinite(data.payoutPaise) ? Math.round(data.payoutPaise) : 0;
    const payout = team
      ? 0
      : Math.max(floor, cat.defaultPayoutPaise, requestedPayout || cat.defaultPayoutPaise);
    const hours = Math.max(1, Math.min(168, Math.round(data.deadlineHours || cat.defaultHours)));
    assertSafeTaskText(`${title}\n${data.requirement}\n${data.description}`);
    const settings = await loadSettings();
    const price = team
      ? calcPrice(roles.reduce((sum, role) => sum + role.payoutPaise, 0), 1, settings.commissionBps)
      : calcPrice(payout, slots, settings.commissionBps);
    if (data.referenceValue) assertDataUrlOrLink(data.referenceValue);
    const difficulty = ["beginner", "intermediate", "advanced", "pro"].includes(data.difficulty ?? "")
      ? data.difficulty
      : "beginner";
    const id = nid();
    try {
      await sql`
        insert into tasks (
          id, client_id, category, title, requirement, description, submission_type,
          slots_total, payout_paise, platform_fee_paise, client_total_paise,
          deadline_hours, status, reference_kind, reference_value, difficulty, video_seconds, is_team
        ) values (
          ${id}, ${me.userId}, ${data.category}, ${title}, ${data.requirement.trim().slice(0, 4000)},
          ${data.description.trim().slice(0, 8000)}, ${data.submissionType || "url"},
          ${slots}, ${team ? 0 : price.payoutPaise}, ${price.platformFeePaise}, ${price.clientTotalPaise},
          ${hours}, ${"awaiting_payment"}, ${data.referenceKind ?? null}, ${data.referenceValue ?? null},
          ${difficulty}, ${videoSeconds}, ${team}
        )`;
      if (team) {
        for (const role of roles) {
          await sql`
            insert into task_slots (id, task_id, status, role_label, role_payout_paise)
            values (${nid()}, ${id}, ${"open"}, ${role.label}, ${role.payoutPaise})`;
        }
      } else {
        for (let i = 0; i < slots; i += 1) {
          await sql`insert into task_slots (id, task_id, status) values (${nid()}, ${id}, ${"open"})`;
        }
      }
    } catch (error) {
      // Best-effort cleanup prevents a half-created task from remaining payable.
      await sql`delete from tasks where id = ${id} and client_id = ${me.userId}`;
      throw error;
    }
    return { taskId: id, price, providers: providerStatus() };
  });

export const startTaskPayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { taskId: string; idempotencyKey: string }) => d)
  .handler(async ({ context, data }) => {
    const { configuredPaymentProvider, createProviderOrder } = await import("../payments");
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "client") fail("Only the client can pay", 403);
    const tasks = await sql<Record<string, unknown>>`
      select * from tasks where id = ${data.taskId} and client_id = ${me.userId} limit 1`;
    if (!tasks[0]) fail("Task not found", 404);
    const t = tasks[0];
    if (["published", "in_progress"].includes(String(t.status))) {
      return { ok: true as const, already: true, mode: "live" as const };
    }
    if (!["awaiting_payment", "draft"].includes(String(t.status))) {
      fail("Task cannot be paid from this state");
    }
    const provider = configuredPaymentProvider();
    if (!provider) fail("A live payment provider is not configured", 503);
    const existing = await sql<Record<string, unknown>>`
      select * from payments where idempotency_key = ${data.idempotencyKey}`;
    if (existing[0]) {
      return {
        ok: true as const,
        already: true,
        mode: "live" as const,
        provider: String(existing[0].provider),
        providerRef: existing[0].provider_ref ? String(existing[0].provider_ref) : null,
      };
    }
    const order = await createProviderOrder({
      amountPaise: asInt(t.client_total_paise),
      receipt: data.taskId,
    });
    const payId = nid();
    await sql`
      insert into payments (
        id, client_id, task_id, amount_paise, provider, provider_ref, status, idempotency_key
      ) values (
        ${payId}, ${me.userId}, ${data.taskId}, ${asInt(t.client_total_paise)},
        ${order.provider}, ${order.providerRef}, ${"created"}, ${data.idempotencyKey}
      )`;
    await sql`update tasks set payment_id = ${payId} where id = ${data.taskId} and client_id = ${me.userId}`;
    return {
      ok: true as const,
      already: false,
      mode: "live" as const,
      provider: order.provider,
      providerRef: order.providerRef,
      extra: order.extra ?? null,
    };
  });

export const confirmSandboxPayment = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { taskId: string; idempotencyKey: string }) => d)
  .handler(async ({ context, data }) => {
    const { configuredPaymentProvider } = await import("../payments");
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "client") fail("Only the client can pay", 403);
    if (configuredPaymentProvider()) {
      fail("Use the live payment provider to complete this order");
    }
    const tasks = await sql<Record<string, unknown>>`
      select * from tasks where id = ${data.taskId} and client_id = ${me.userId} limit 1`;
    if (!tasks[0]) fail("Task not found", 404);
    const t = tasks[0];
    if (String(t.status) === "published" || String(t.status) === "in_progress") {
      return { ok: true as const, already: true, mode: "sandbox" as const };
    }
    if (String(t.status) !== "awaiting_payment" && String(t.status) !== "draft") {
      fail("Task cannot be published from this state");
    }
    const existing = await sql`select id from payments where idempotency_key = ${data.idempotencyKey}`;
    if (existing[0]) {
      return { ok: true as const, already: true, mode: "sandbox" as const };
    }
    const payId = nid();
    await sql`
      insert into payments (
        id, client_id, task_id, amount_paise, provider, status, idempotency_key, confirmed_at
      ) values (
        ${payId}, ${me.userId}, ${data.taskId}, ${asInt(t.client_total_paise)},
        ${"sandbox_preview"}, ${"sandbox_preview"}, ${data.idempotencyKey}, now()
      )`;
    await sql`
      update tasks set status = ${"published"}, payment_id = ${payId}, published_at = now()
      where id = ${data.taskId} and client_id = ${me.userId}`;
    await notify(
      sql,
      me.userId,
      "payment",
      "Sandbox escrow recorded",
      "Task published. No real money was collected — payment provider is not configured.",
      `/app/tasks/${data.taskId}`,
    );
    return { ok: true as const, already: false, mode: "sandbox" as const };
  });

export const claimTask = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { taskId: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "student") fail("Only students can accept tasks", 403);
    await expireOverdue(sql);
    const tasks = await sql<Record<string, unknown>>`
      select * from tasks where id = ${data.taskId} limit 1`;
    if (!tasks[0]) fail("Task not found", 404);
    const t = tasks[0];
    if (!["published", "in_progress"].includes(String(t.status))) fail("Task is not available");
    if (String(t.client_id) === me.userId) fail("You cannot accept your own task");
    const used = await sql<{ n: number }>`
      select count(*)::int as n from task_attempts
      where task_id = ${data.taskId} and student_id = ${me.userId}`;
    if (asInt(used[0]?.n) >= MAX_TASK_ATTEMPTS) {
      fail("This task is blocked after 2 attempts");
    }
    const active = await sql`
      select id from task_slots
      where task_id = ${data.taskId} and student_id = ${me.userId}
        and status in ('claimed','submitted','revision','disputed')`;
    if (active[0]) fail("You already have an active slot on this task");
    const open = await sql<{ id: string }>`
      select id from task_slots where task_id = ${data.taskId} and status = 'open' limit 1`;
    if (!open[0]) fail("No open slots remain");
    const hours = asInt(t.deadline_hours) || 24;
    const deadline = new Date(Date.now() + hours * 3600 * 1000).toISOString();
    const attemptNo = asInt(used[0]?.n) + 1;
    const upd = await sql`
      update task_slots
      set student_id = ${me.userId},
          status = ${"claimed"},
          attempt_count = ${attemptNo},
          claimed_at = now(),
          deadline_at = ${deadline}::timestamptz
      where id = ${open[0].id} and status = 'open'
      returning id`;
    if (!upd[0]) fail("Slot was taken. Retry.");
    await sql`
      insert into task_attempts (id, task_id, student_id, attempt_no, slot_id, outcome)
      values (${nid()}, ${data.taskId}, ${me.userId}, ${attemptNo}, ${open[0].id}, ${"claimed"})`;
    await sql`update tasks set status = ${"in_progress"} where id = ${data.taskId} and status = ${"published"}`;
    await notify(
      sql,
      String(t.client_id),
      "task",
      "A student accepted a slot",
      `${me.displayName} accepted “${String(t.title)}”.`,
      `/app/tasks/${data.taskId}`,
    );
    await notify(
      sql,
      me.userId,
      "task",
      "Task accepted",
      `Deadline is set. Submit ${String(t.submission_type)} work before it expires.`,
      `/app/tasks/${data.taskId}`,
    );
    return { slotId: open[0].id, deadlineAt: deadline, attemptNo };
  });

export const cancelSlot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { slotId: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const slots = await sql<Record<string, unknown>>`
      select s.*, t.client_id, t.title from task_slots s
      join tasks t on t.id = s.task_id
      where s.id = ${data.slotId} limit 1`;
    if (!slots[0]) fail("Slot not found", 404);
    const s = slots[0];
    if (String(s.student_id) !== me.userId) fail("Not your slot", 403);
    if (String(s.status) !== "claimed") fail("Only an unsubmitted claimed slot can be cancelled");
    await sql`
      update task_slots set status = ${"cancelled"}, cancelled_at = now()
      where id = ${data.slotId} and student_id = ${me.userId} and status = ${"claimed"}`;
    await sql`insert into task_slots (id, task_id, status) values (${nid()}, ${String(s.task_id)}, ${"open"})`;
    await sql`
      update task_attempts set outcome = ${"cancelled"}
      where slot_id = ${data.slotId} and student_id = ${me.userId}`;
    await notify(
      sql,
      String(s.client_id),
      "task",
      "Slot released",
      `A student cancelled “${String(s.title)}”. The slot is open again.`,
      `/app/tasks/${String(s.task_id)}`,
    );
    return { ok: true as const };
  });

export const submitWork = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { slotId: string; content: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const content = assertDataUrlOrLink(data.content);
    const slots = await sql<Record<string, unknown>>`
      select s.*, t.client_id, t.title, t.submission_type, t.payout_paise
      from task_slots s join tasks t on t.id = s.task_id
      where s.id = ${data.slotId} limit 1`;
    if (!slots[0]) fail("Slot not found", 404);
    const s = slots[0];
    if (String(s.student_id) !== me.userId) fail("Not your slot", 403);
    if (!["claimed", "revision"].includes(String(s.status))) fail("Cannot submit in this state");
    const prev = await sql<{ n: number }>`
      select count(*)::int as n from submissions where slot_id = ${data.slotId}`;
    const version = asInt(prev[0]?.n) + 1;
    const first = version === 1;
    const submissionId = nid();
    const taskRow = await sql<Record<string, unknown>>`
      select requirement, video_seconds from tasks where id = ${String(s.task_id)} limit 1`;
    const verdict = verifySubmission({
      submissionType: String(s.submission_type),
      content,
      requirement: String(taskRow[0]?.requirement ?? ""),
      videoSeconds: taskRow[0]?.video_seconds == null ? null : asInt(taskRow[0].video_seconds),
    });
    if (verdict.status === "rejected") fail(verdict.notes);
    await sql`
      insert into submissions (id, slot_id, student_id, version, submission_type, content_text)
      values (${submissionId}, ${data.slotId}, ${me.userId}, ${version}, ${String(s.submission_type)}, ${content})`;
    await sql`
      insert into verification_results (id, submission_id, status, checks, notes)
      values (${nid()}, ${submissionId}, ${verdict.status}, ${JSON.stringify(verdict.checks)}, ${verdict.notes})`;
    await sql`update task_slots set status = ${"submitted"} where id = ${data.slotId}`;
    if (first) {
      await ledger(
        sql,
        me.userId,
        asInt(s.role_payout_paise) > 0 ? asInt(s.role_payout_paise) : asInt(s.payout_paise),
        "credit",
        "pending",
        "task_pending",
        `Pending payout for “${String(s.title)}”`,
        "slot",
        data.slotId,
      );
    }
    await notify(
      sql,
      String(s.client_id),
      "submission",
      "New submission",
      `${me.displayName} submitted work on “${String(s.title)}”.`,
      `/app/tasks/${String(s.task_id)}`,
    );
    return { version };
  });

export const requestRevision = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { slotId: string; instructions: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const instructions = data.instructions.trim().slice(0, 4000);
    if (instructions.length < 4) fail("Explain what to change");
    const slots = await sql<Record<string, unknown>>`
      select s.*, t.client_id, t.title from task_slots s
      join tasks t on t.id = s.task_id
      where s.id = ${data.slotId} limit 1`;
    if (!slots[0]) fail("Slot not found", 404);
    if (String(slots[0].client_id) !== me.userId) fail("Only the client can request a revision", 403);
    if (String(slots[0].status) !== "submitted") fail("Revision is only available on submitted work");
    const last = await sql<{ id: string }>`
      select id from submissions where slot_id = ${data.slotId} order by version desc limit 1`;
    await sql`
      insert into revisions (id, slot_id, submission_id, instructions, created_by)
      values (${nid()}, ${data.slotId}, ${last[0]?.id ?? null}, ${instructions}, ${me.userId})`;
    await sql`update task_slots set status = ${"revision"} where id = ${data.slotId}`;
    if (slots[0].student_id) {
      await notify(
        sql,
        String(slots[0].student_id),
        "revision",
        "Revision requested",
        instructions.slice(0, 180),
        `/app/tasks/${String(slots[0].task_id)}`,
      );
    }
    return { ok: true as const };
  });

export const approveSlot = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { slotId: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const slots = await sql<Record<string, unknown>>`
      select s.*, t.client_id, t.title, t.payout_paise, t.category, t.id as task_id
      from task_slots s join tasks t on t.id = s.task_id
      where s.id = ${data.slotId} limit 1`;
    if (!slots[0]) fail("Slot not found", 404);
    const s = slots[0];
    if (String(s.client_id) !== me.userId) fail("Only the client can approve", 403);
    if (!["submitted", "revision"].includes(String(s.status))) fail("Nothing to approve");
    const studentId = String(s.student_id);
    const payout = asInt(s.role_payout_paise) > 0 ? asInt(s.role_payout_paise) : asInt(s.payout_paise);
    const approved = await sql`
      update task_slots set status = ${"approved"}, approved_at = now()
      where id = ${data.slotId} and status in ('submitted','revision')
      returning id`;
    // Only the request that won the state transition may release funds.
    // This makes repeated/double approval idempotent under concurrent requests.
    if (!approved[0]) {
      return { ok: true as const, already: true as const };
    }
    await ledger(sql, studentId, payout, "debit", "pending", "task_release", `Released pending for “${String(s.title)}”`, "slot", data.slotId);
    await ledger(sql, studentId, payout, "credit", "available", "task_payout", `Approved payout for “${String(s.title)}”`, "slot", data.slotId);
    const student = await sql<Record<string, unknown>>`select display_name from profiles where user_id = ${studentId}`;
    await syncMilestones(sql, studentId, String(student[0]?.display_name ?? "Student"));
    await sql`
      insert into user_badges (user_id, badge_id)
      values (${studentId}, ${"first_approval"})
      on conflict do nothing`;
    const skillId = ["video_editing", "image_editing", "canva", "writing", "data", "testing", "design", "tech"].includes(String(s.category))
      ? String(s.category)
      : String(s.category).includes("writ") ? "writing"
      : String(s.category).includes("video") ? "video_editing"
      : String(s.category).includes("test") ? "testing"
      : String(s.category).includes("design") || String(s.category).includes("canva") ? "design"
      : "data";
    await sql`
      insert into user_skills (user_id, skill_id, level, verified, score)
      select ${studentId}, ${skillId}, 'beginner', true, 1
      where exists (select 1 from skills where id = ${skillId})
      on conflict (user_id, skill_id) do update set score = user_skills.score + 1, verified = true`;
    await sql`update profiles set reputation = reputation + 10, updated_at = now() where user_id = ${studentId}`;
    if (slots[0].student_id) {
      await notify(
        sql,
        studentId,
        "approval",
        "Work approved",
        `${formatSilent(payout)} is now withdrawable in your ledger.`,
        "/app/wallet",
      );
    }
    const open = await sql<{ n: number }>`
      select count(*)::int as n from task_slots where task_id = ${String(s.task_id)} and status in ('open','claimed','submitted','revision','disputed')`;
    if (asInt(open[0]?.n) === 0) {
      await sql`update tasks set status = ${"completed"} where id = ${String(s.task_id)}`;
    }
    const prof = await sql<Record<string, unknown>>`select referred_by from profiles where user_id = ${studentId}`;
    const approvedCount = await sql<{ n: number }>`
      select count(*)::int as n from task_slots where student_id = ${studentId} and status = 'approved'`;
    if (prof[0]?.referred_by && String(prof[0].referred_by) !== studentId && asInt(approvedCount[0]?.n) === 1) {
      await ledger(
        sql,
        String(prof[0].referred_by),
        50,
        "credit",
        "coins",
        "referral",
        "Referral reward — first completed task",
        "user",
        studentId,
      );
      await notify(sql, String(prof[0].referred_by), "referral", "Referral reward", "Your invite completed a first task. +50 coins.", "/app/refer");
    }
    return { ok: true as const };
  });

function formatSilent(paise: number) {
  return `₹${(paise / 100).toFixed(2)}`;
}

export const openDispute = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { slotId: string; reason: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const reason = data.reason.trim().slice(0, 2000);
    if (reason.length < 4) fail("Describe the dispute");
    const slots = await sql<Record<string, unknown>>`
      select s.*, t.client_id, t.title from task_slots s
      join tasks t on t.id = s.task_id
      where s.id = ${data.slotId} limit 1`;
    if (!slots[0]) fail("Slot not found", 404);
    const s = slots[0];
    const allowed = me.userId === String(s.client_id) || me.userId === String(s.student_id);
    if (!allowed) fail("Not a participant", 403);
    if (!["submitted", "revision", "claimed"].includes(String(s.status))) fail("Cannot dispute this slot");
    await sql`
      insert into disputes (id, slot_id, opened_by, reason, status)
      values (${nid()}, ${data.slotId}, ${me.userId}, ${reason}, ${"open"})`;
    await sql`update task_slots set status = ${"disputed"} where id = ${data.slotId}`;
    const other = me.userId === String(s.client_id) ? String(s.student_id) : String(s.client_id);
    if (other) {
      await notify(sql, other, "dispute", "Dispute opened", reason.slice(0, 180), `/app/tasks/${String(s.task_id)}`);
    }
    return { ok: true as const };
  });

export const sendMessage = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { taskId: string; slotId?: string; body: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const body = data.body.trim().slice(0, 2000);
    if (!body) fail("Message is empty");
    try {
      assertOnPlatformMessage(body);
    } catch (err) {
      fail(err instanceof Error ? err.message : "Message blocked");
    }
    const tasks = await sql<Record<string, unknown>>`select * from tasks where id = ${data.taskId} limit 1`;
    if (!tasks[0]) fail("Task not found", 404);
    const onSlot = await sql`
      select id from task_slots where task_id = ${data.taskId} and student_id = ${me.userId} limit 1`;
    const allowed = me.isAdmin || String(tasks[0].client_id) === me.userId || Boolean(onSlot[0]);
    if (!allowed) fail("Messaging is limited to task participants", 403);
    await sql`
      insert into messages (id, task_id, slot_id, sender_id, body)
      values (${nid()}, ${data.taskId}, ${data.slotId ?? null}, ${me.userId}, ${body})`;
    return { ok: true as const };
  });

export const submitRating = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { slotId: string; stars: number; comment?: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    const stars = Math.min(5, Math.max(1, Math.round(data.stars)));
    const slots = await sql<Record<string, unknown>>`
      select s.*, t.client_id from task_slots s join tasks t on t.id = s.task_id
      where s.id = ${data.slotId} limit 1`;
    if (!slots[0]) fail("Slot not found", 404);
    if (String(slots[0].status) !== "approved") fail("Rate after approval");
    const isClient = me.userId === String(slots[0].client_id);
    const isStudent = me.userId === String(slots[0].student_id);
    if (!isClient && !isStudent) fail("Not a participant", 403);
    const ratee = isClient ? String(slots[0].student_id) : String(slots[0].client_id);
    const exists = await sql`
      select id from ratings where slot_id = ${data.slotId} and rater_id = ${me.userId}`;
    if (exists[0]) fail("You already rated this work");
    await sql`
      insert into ratings (id, slot_id, rater_id, ratee_id, stars, comment)
      values (${nid()}, ${data.slotId}, ${me.userId}, ${ratee}, ${stars}, ${(data.comment ?? "").slice(0, 400)})`;
    return { ok: true as const };
  });

export const listMyWork = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    await expireOverdue(sql);
    if (me.role === "client") {
      const rows = await sql<Record<string, unknown>>`
        select t.*, p.display_name as client_name,
          (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'open') as slots_open,
          (select count(*)::int from task_slots s where s.task_id = t.id and s.status = 'submitted') as pending_review
        from tasks t join profiles p on p.user_id = t.client_id
        where t.client_id = ${me.userId}
        order by t.created_at desc limit 80`;
      return {
        role: "client" as const,
        tasks: rows.map((r) => mapTask(r, asInt(r.slots_open), String(r.client_name ?? ""))),
      };
    }
    const rows = await sql<Record<string, unknown>>`
      select s.*, t.title, t.category, t.payout_paise, t.submission_type, t.client_id, p.display_name as client_name
      from task_slots s
      join tasks t on t.id = s.task_id
      join profiles p on p.user_id = t.client_id
      where s.student_id = ${me.userId}
      order by s.claimed_at desc nulls last
      limit 80`;
    return {
      role: "student" as const,
      slots: rows.map((r) => ({
        id: String(r.id),
        taskId: String(r.task_id),
        title: String(r.title),
        category: String(r.category),
        status: String(r.status),
        payoutPaise: asInt(r.payout_paise),
        deadlineAt: isoOrNull(r.deadline_at),
        clientName: String(r.client_name ?? ""),
      })),
    };
  });
