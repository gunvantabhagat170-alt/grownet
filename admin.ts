import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { dbSource } from "@/lib/db";
import {
  asInt,
  audit,
  fail,
  getSqlReady,
  iso,
  ledger,
  nid,
  notify,
  providerStatus,
  requireAdmin,
  requireProfile,
} from "./helpers";

export const unlockAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { secret: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const secret = process.env.ADMIN_SECRET;
    const recent = await sql<{ n: number }>`
      select count(*)::int as n from admin_login_attempts
      where user_id = ${context.userId} and created_at > now() - interval '10 minutes'`;
    if (asInt(recent[0]?.n) >= 8) fail("Too many attempts. Try later.", 429);
    const ok = Boolean(secret) && data.secret === secret;
    await sql`
      insert into admin_login_attempts (id, user_id, ok) values (${nid()}, ${context.userId}, ${ok})`;
    if (!secret) fail("Admin secret is not configured for this environment");
    if (!ok) fail("Invalid admin secret", 401);
    await sql`update profiles set is_admin = true, updated_at = now() where user_id = ${context.userId}`;
    await audit(sql, context.userId, "admin_unlock", "user", context.userId);
    return { ok: true as const };
  });

export const grantPreviewAdmin = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    if (dbSource !== "pglite") fail("Preview admin is only available on the local preview database", 403);
    if (process.env.ADMIN_SECRET) fail("Use the admin secret instead");
    await sql`update profiles set is_admin = true, updated_at = now() where user_id = ${context.userId}`;
    await audit(sql, context.userId, "preview_admin_grant", "user", context.userId, { preview: true });
    return { ok: true as const, preview: true as const };
  });

export const adminOverview = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const users = await sql<{ n: number }>`select count(*)::int as n from profiles`;
    const students = await sql<{ n: number }>`select count(*)::int as n from profiles where role = 'student'`;
    const clients = await sql<{ n: number }>`select count(*)::int as n from profiles where role = 'client'`;
    const tasks = await sql<{ n: number }>`select count(*)::int as n from tasks`;
    const published = await sql<{ n: number }>`select count(*)::int as n from tasks where status in ('published','in_progress')`;
    const fees = await sql<{ n: number }>`
      select coalesce(sum(platform_fee_paise),0)::int as n from tasks where payment_id is not null`;
    const escrow = await sql<{ n: number }>`
      select coalesce(sum(client_total_paise),0)::int as n from tasks where payment_id is not null`;
    const pendingWd = await sql<{ n: number }>`
      select coalesce(sum(amount_paise),0)::int as n from withdrawals where status in ('requested','pending','processing')`;
    const disputes = await sql<{ n: number }>`select count(*)::int as n from disputes where status = 'open'`;
    return {
      providers: providerStatus(),
      users: asInt(users[0]?.n),
      students: asInt(students[0]?.n),
      clients: asInt(clients[0]?.n),
      tasks: asInt(tasks[0]?.n),
      published: asInt(published[0]?.n),
      platformFeesPaise: asInt(fees[0]?.n),
      customerFundsPaise: asInt(escrow[0]?.n),
      pendingWithdrawalsPaise: asInt(pendingWd[0]?.n),
      openDisputes: asInt(disputes[0]?.n),
    };
  });

export const adminListUsers = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select p.*, w.available_paise, w.pending_paise, w.lifetime_earned_paise
      from profiles p left join wallets w on w.user_id = p.user_id
      order by p.created_at desc limit 200`;
    return rows.map((r) => ({
      userId: String(r.user_id),
      role: String(r.role),
      name: String(r.display_name),
      isAdmin: r.is_admin === true || r.is_admin === "t",
      suspended: r.is_suspended === true || r.is_suspended === "t",
      goldCreator: r.gold_creator === true || r.gold_creator === "t",
      availablePaise: asInt(r.available_paise),
      pendingPaise: asInt(r.pending_paise),
      lifetimePaise: asInt(r.lifetime_earned_paise),
      createdAt: iso(r.created_at),
    }));
  });

export const adminSetSuspended = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { userId: string; suspended: boolean }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    if (data.userId === context.userId) fail("You cannot suspend yourself");
    await sql`
      update profiles set is_suspended = ${data.suspended}, updated_at = now()
      where user_id = ${data.userId}`;
    await audit(sql, context.userId, data.suspended ? "suspend_user" : "unsuspend_user", "user", data.userId);
    return { ok: true as const };
  });

export const adminListTasks = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select t.*, p.display_name as client_name from tasks t
      join profiles p on p.user_id = t.client_id
      order by t.created_at desc limit 150`;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      status: String(r.status),
      clientName: String(r.client_name),
      payoutPaise: asInt(r.payout_paise),
      clientTotalPaise: asInt(r.client_total_paise),
      createdAt: iso(r.created_at),
    }));
  });

export const adminListPayments = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select * from payments order by created_at desc limit 150`;
    const wd = await sql<Record<string, unknown>>`
      select * from withdrawals order by created_at desc limit 150`;
    return {
      payments: rows.map((r) => ({
        id: String(r.id),
        taskId: String(r.task_id),
        amountPaise: asInt(r.amount_paise),
        provider: String(r.provider),
        status: String(r.status),
        createdAt: iso(r.created_at),
      })),
      withdrawals: wd.map((r) => ({
        id: String(r.id),
        userId: String(r.user_id),
        amountPaise: asInt(r.amount_paise),
        upiId: r.upi_id ? String(r.upi_id) : null,
        status: String(r.status),
        failureReason: r.failure_reason ? String(r.failure_reason) : null,
        createdAt: iso(r.created_at),
      })),
    };
  });

export const adminListDisputes = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select d.*, s.task_id, s.student_id, t.title
      from disputes d
      join task_slots s on s.id = d.slot_id
      join tasks t on t.id = s.task_id
      order by d.created_at desc limit 100`;
    return rows.map((r) => ({
      id: String(r.id),
      slotId: String(r.slot_id),
      taskId: String(r.task_id),
      title: String(r.title),
      reason: String(r.reason),
      status: String(r.status),
      resolution: r.resolution ? String(r.resolution) : null,
      createdAt: iso(r.created_at),
    }));
  });

export const adminResolveDispute = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { disputeId: string; outcome: "student" | "client"; note: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select d.*, s.id as slot_id, s.student_id, s.status as slot_status,
        coalesce(s.role_payout_paise, t.payout_paise) as payout_paise,
        t.title, t.client_id
      from disputes d
      join task_slots s on s.id = d.slot_id
      join tasks t on t.id = s.task_id
      where d.id = ${data.disputeId} limit 1`;
    if (!rows[0]) fail("Dispute not found", 404);
    if (String(rows[0].status) !== "open") fail("Already resolved");
    const note = data.note.trim().slice(0, 1000);
    const studentId = String(rows[0].student_id);
    const payout = asInt(rows[0].payout_paise);
    if (data.outcome === "student") {
      await sql`update task_slots set status = ${"approved"}, approved_at = now() where id = ${String(rows[0].slot_id)}`;
      await ledger(sql, studentId, payout, "debit", "pending", "dispute_release", `Dispute resolved for “${String(rows[0].title)}”`, "slot", String(rows[0].slot_id)).catch(() => undefined);
      await ledger(sql, studentId, payout, "credit", "available", "dispute_payout", `Dispute awarded for “${String(rows[0].title)}”`, "slot", String(rows[0].slot_id));
    } else {
      await sql`update task_slots set status = ${"cancelled"} where id = ${String(rows[0].slot_id)}`;
      await ledger(sql, studentId, payout, "debit", "pending", "dispute_void", `Dispute voided pending for “${String(rows[0].title)}”`, "slot", String(rows[0].slot_id)).catch(() => undefined);
      await sql`insert into task_slots (id, task_id, status) values (${nid()}, ${String(rows[0].task_id)}, ${"open"})`;
    }
    await sql`
      update disputes set status = ${"resolved"}, resolution = ${`${data.outcome}:${note}`}, resolved_at = now()
      where id = ${data.disputeId}`;
    await audit(sql, context.userId, "resolve_dispute", "dispute", data.disputeId, { outcome: data.outcome });
    await notify(sql, studentId, "dispute", "Dispute resolved", note, `/app/tasks/${String(rows[0].task_id)}`);
    await notify(sql, String(rows[0].client_id), "dispute", "Dispute resolved", note, `/app/tasks/${String(rows[0].task_id)}`);
    return { ok: true as const };
  });

export const adminAnnounce = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { title: string; body: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const title = data.title.trim().slice(0, 120);
    const body = data.body.trim().slice(0, 2000);
    if (!title || !body) fail("Title and body required");
    const id = nid();
    await sql`insert into announcements (id, title, body, created_by) values (${id}, ${title}, ${body}, ${context.userId})`;
    const users = await sql<{ user_id: string }>`select user_id from profiles`;
    for (const u of users) {
      await notify(sql, u.user_id, "announcement", title, body, "/app");
    }
    await audit(sql, context.userId, "announce", "announcement", id);
    return { ok: true as const };
  });

export const adminAuditLog = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select * from audit_logs order by created_at desc limit 120`;
    return rows.map((r) => ({
      id: String(r.id),
      actorId: r.actor_id ? String(r.actor_id) : null,
      action: String(r.action),
      targetType: r.target_type ? String(r.target_type) : null,
      targetId: r.target_id ? String(r.target_id) : null,
      createdAt: iso(r.created_at),
    }));
  });

export const adminListRewards = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select r.*, p.display_name from reward_claims r
      join profiles p on p.user_id = r.user_id
      order by r.created_at desc limit 100`;
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.display_name),
      kind: String(r.kind),
      status: String(r.status),
      destination: r.destination ? String(r.destination) : null,
      createdAt: iso(r.created_at),
    }));
  });

export const adminUpdateReward = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { id: string; status: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    await requireAdmin(sql, context.userId);
    const allowed = ["requested", "under_review", "approved", "preparing", "shipped", "cancelled", "rejected"];
    if (data.status === "delivered") fail("Delivered requires actual delivery confirmation and is not set from this console");
    if (!allowed.includes(data.status)) fail("Invalid status");
    await sql`update reward_claims set status = ${data.status}, updated_at = now() where id = ${data.id}`;
    await audit(sql, context.userId, "reward_status", "reward", data.id, { status: data.status });
    return { ok: true as const };
  });

export const listAnnouncements = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const rows = await sql<Record<string, unknown>>`
      select id, title, body, created_at from announcements order by created_at desc limit 8`;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      body: String(r.body),
      createdAt: iso(r.created_at),
    }));
  });

