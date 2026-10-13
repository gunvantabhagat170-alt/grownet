import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";
import { MIN_WITHDRAWAL_PAISE } from "../points";
import { loadSettings } from "./upgrade";
import {
  asInt,
  fail,
  getSqlReady,
  iso,
  ledger,
  mapWallet,
  nid,
  notify,
  providerStatus,
  requireProfile,
} from "./helpers";

export const getWallet = createServerFn({ method: "GET" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const sql = await getSqlReady();
    await requireProfile(sql, context.userId);
    const w = await sql<Record<string, unknown>>`select * from wallets where user_id = ${context.userId}`;
    const ledgerRows = await sql<Record<string, unknown>>`
      select * from ledger_entries where user_id = ${context.userId}
      order by created_at desc limit 80`;
    const withdrawals = await sql<Record<string, unknown>>`
      select * from withdrawals where user_id = ${context.userId}
      order by created_at desc limit 40`;
    return {
      wallet: mapWallet(w[0]),
      providers: providerStatus(),
      ledger: ledgerRows.map((r) => ({
        id: String(r.id),
        amountPaise: asInt(r.amount_paise),
        direction: String(r.direction) as "credit" | "debit",
        bucket: String(r.bucket),
        entryType: String(r.entry_type),
        refType: r.ref_type ? String(r.ref_type) : null,
        refId: r.ref_id ? String(r.ref_id) : null,
        description: String(r.description ?? ""),
        createdAt: iso(r.created_at),
      })),
      withdrawals: withdrawals.map((r) => ({
        id: String(r.id),
        amountPaise: asInt(r.amount_paise),
        upiId: r.upi_id ? String(r.upi_id) : null,
        status: String(r.status),
        failureReason: r.failure_reason ? String(r.failure_reason) : null,
        createdAt: iso(r.created_at),
      })),
    };
  });

export const requestWithdrawal = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((d: { amountPaise: number; idempotencyKey: string }) => d)
  .handler(async ({ context, data }) => {
    const sql = await getSqlReady();
    const me = await requireProfile(sql, context.userId);
    if (me.role !== "student") fail("Only students can withdraw earnings", 403);

    const amount = Math.round(data.amountPaise);
    const settings = await loadSettings();
    if (amount < settings.minWithdrawalPaise) {
      fail(`Minimum withdrawal is ₹${(settings.minWithdrawalPaise / 100).toFixed(0)}`);
    }
    if (!me.upiId) fail("Add a UPI ID in profile first");

    const id = data.idempotencyKey?.trim();
    if (!id) fail("A withdrawal request ID is required");

    // Claim the withdrawal atomically before touching the wallet. The unique
    // open-withdrawal index also prevents two concurrent requests from both
    // becoming open withdrawals for the same student.
    const claim = await sql<Record<string, unknown>>`
      insert into withdrawals (id, user_id, amount_paise, upi_id, status, provider)
      values (${id}, ${context.userId}, ${amount}, ${me.upiId}, 'processing', null)
      on conflict do nothing
      returning id`;

    if (!claim[0]) {
      const same = await sql`
        select id from withdrawals
        where id = ${id} and user_id = ${context.userId}
        limit 1`;
      if (same[0]) return { ok: true as const, already: true, status: "processing" as const };
      const open = await sql`
        select id from withdrawals
        where user_id = ${context.userId}
          and status in ('requested','pending','processing')
        limit 1`;
      if (open[0]) fail("You already have an open withdrawal request");
      fail("Could not create withdrawal request. Please try again");
    }

    let debitApplied = false;
    try {
      // This conditional update is the final balance guard. It is atomic, so
      // concurrent withdrawals cannot spend the same available balance.
      const debit = await sql`
        update wallets
        set available_paise = available_paise - ${amount}, updated_at = now()
        where user_id = ${context.userId}
          and available_paise >= ${amount}
        returning user_id`;
      if (!debit[0]) throw new Error("Insufficient withdrawable balance");
      debitApplied = true;

      await sql`
        insert into ledger_entries
          (id, user_id, amount_paise, direction, bucket, entry_type, ref_type, ref_id, description)
        values
          (${nid()}, ${context.userId}, ${amount}, 'debit', 'available',
           'withdrawal_hold', 'withdrawal', ${id},
           'Withdrawal requested — held from available balance')`;

      // No real payout provider adapter is implemented in this project yet.
      // Keep the request in processing rather than falsely claiming provider
      // processing or a successful payout.
      await sql`
        update withdrawals
        set status = 'requested', provider = null, updated_at = now()
        where id = ${id} and user_id = ${context.userId}`;

      await notify(
        sql,
        context.userId,
        "withdrawal",
        "Withdrawal requested",
        "Your withdrawal request was recorded and is awaiting payout processing.",
        "/app/wallet",
      );
      return { ok: true as const, already: false, status: "requested" as const };
    } catch (err) {
      // Remove only our just-created claim. Since the claim is unique, another
      // request cannot legitimately own this row. The wallet debit happens
      // before the ledger insert; if the ledger insert fails, restore the
      // balance before removing the request.
      const ledgerRow = await sql`
        select id from ledger_entries
        where user_id = ${context.userId}
          and ref_type = 'withdrawal'
          and ref_id = ${id}
        limit 1`;
      if (!ledgerRow[0] && debitApplied) {
        // The wallet debit succeeded but the ledger insert did not. Restore the
        // balance so a failed request can never silently consume funds.
        await sql`
          update wallets
          set available_paise = available_paise + ${amount}, updated_at = now()
          where user_id = ${context.userId}`;
      }
      await sql`
        update withdrawals
        set status = 'failed', failure_reason = ${err instanceof Error ? err.message : "Withdrawal failed"}, updated_at = now()
        where id = ${id} and user_id = ${context.userId}`;
      throw err;
    }
  });
