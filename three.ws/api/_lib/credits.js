// Prepaid credit wallet — the platform's spend rail for logged-in users.
//
// Top up by depositing SOL or $THREE (api/_lib/credit-deposit.js verifies the
// on-chain transfer and calls creditAccount here); spend on metered actions
// (Forge, …) priced by api/_lib/pricing/catalog.js and discounted by the user's
// $THREE holder tier (api/_lib/three-tier.js). Credits are denominated in USD
// (numeric(20,6)) to match the pricing catalog and token_payments.usd — one
// currency end to end, no second unit to reconcile.
//
// Integrity model (mirrors api/_lib/token/payments.js):
//   • credit_accounts holds the rolling balance; credit_ledger is the append-only
//     history. Both are written in ONE statement (a CTE) — Neon's HTTP driver has
//     no interactive transactions, and a single statement is atomic (an error
//     rolls the whole statement back), so balance and ledger can never diverge.
//   • Every movement carries an idempotency_key (UNIQUE). A replay rolls back on
//     the unique violation and resolves to the prior row, so a retried deposit
//     credits once and a retried charge debits once.
//   • A debit decrements only `where balance_usd >= amount`, so a spend can never
//     drive the balance negative even under concurrent requests.

import { sql } from './db.js';
import { priceForAction } from './pricing/catalog.js';
import { holderDiscountBps } from './three-tier.js';

const CREDIT_KINDS = new Set(['deposit', 'refund', 'grant', 'adjust']);

function isUniqueViolation(err) {
	return err?.code === '23505' || /duplicate key|unique constraint/i.test(err?.message || '');
}

function badRequest(message, code = 'bad_request') {
	return Object.assign(new Error(message), { status: 400, code });
}

// Money is stored as numeric(20,6); pass strings to the driver so JS float drift
// never reaches the column. Six decimals = USDC precision.
function usd6(n) {
	return Number(n).toFixed(6);
}

/** Current balance + lifetime totals for a user. Zeros when no account row yet. */
export async function getCreditAccount(userId) {
	if (!userId) throw badRequest('userId is required');
	const [row] = await sql`
		select balance_usd, lifetime_deposited_usd, lifetime_spent_usd, updated_at
		from credit_accounts where user_id = ${userId} limit 1
	`;
	return {
		balanceUsd: Number(row?.balance_usd ?? 0),
		lifetimeDepositedUsd: Number(row?.lifetime_deposited_usd ?? 0),
		lifetimeSpentUsd: Number(row?.lifetime_spent_usd ?? 0),
		updatedAt: row?.updated_at ?? null,
	};
}

async function priorLedger(idempotencyKey) {
	const [row] = await sql`
		select id, balance_after from credit_ledger where idempotency_key = ${idempotencyKey} limit 1
	`;
	return row || null;
}

/**
 * Add credits (deposit / refund / grant / adjust). Atomic upsert + ledger,
 * idempotent on idempotencyKey. Only a 'deposit' counts toward lifetime_deposited.
 * @returns {Promise<{ balanceUsd: number, ledgerId: string|null, replay: boolean }>}
 */
export async function creditAccount({
	userId,
	amountUsd,
	kind = 'deposit',
	action = null,
	refType = null,
	refId = null,
	txSignature = null,
	asset = null,
	assetAmount = null,
	priceUsd = null,
	idempotencyKey,
	meta = {},
}) {
	if (!userId) throw badRequest('userId is required');
	if (!CREDIT_KINDS.has(kind)) throw badRequest(`invalid credit kind: ${kind}`);
	const amt = Number(amountUsd);
	if (!Number.isFinite(amt) || amt <= 0) throw badRequest('amountUsd must be a positive number');
	if (!idempotencyKey) throw badRequest('idempotencyKey is required');

	const usd = usd6(amt);
	const dep = usd6(kind === 'deposit' ? amt : 0); // lifetime_deposited only tracks real top-ups
	const assetAmountStr = assetAmount == null ? null : String(assetAmount);

	try {
		const [row] = await sql`
			with acct as (
				insert into credit_accounts (user_id, balance_usd, lifetime_deposited_usd, updated_at)
				values (${userId}, ${usd}, ${dep}, now())
				on conflict (user_id) do update
					set balance_usd = credit_accounts.balance_usd + ${usd},
						lifetime_deposited_usd = credit_accounts.lifetime_deposited_usd + ${dep},
						updated_at = now()
				returning balance_usd
			), led as (
				insert into credit_ledger
					(user_id, kind, amount_usd, balance_after, action, ref_type, ref_id,
					 tx_signature, asset, asset_amount, price_usd, idempotency_key, meta)
				select ${userId}, ${kind}, ${usd}, balance_usd, ${action}, ${refType}, ${refId},
					   ${txSignature}, ${asset}, ${assetAmountStr}, ${priceUsd}, ${idempotencyKey},
					   ${JSON.stringify(meta || {})}::jsonb
				from acct
				returning id, balance_after
			)
			select id, balance_after from led
		`;
		return { balanceUsd: Number(row.balance_after), ledgerId: row.id, replay: false };
	} catch (err) {
		if (isUniqueViolation(err)) {
			const prior = await priorLedger(idempotencyKey);
			return {
				balanceUsd: Number(prior?.balance_after ?? 0),
				ledgerId: prior?.id ?? null,
				replay: true,
			};
		}
		throw err;
	}
}

/**
 * Debit credits for a spend. Atomic conditional decrement + ledger, idempotent on
 * idempotencyKey. Throws a 402 insufficient_credits (with available/required)
 * when the balance is short — the spend never partially applies.
 * @returns {Promise<{ balanceUsd: number, ledgerId: string|null, replay: boolean, chargedUsd: number }>}
 */
export async function debitCredits({
	userId,
	amountUsd,
	action = null,
	refType = null,
	refId = null,
	idempotencyKey,
	meta = {},
}) {
	if (!userId) throw badRequest('userId is required');
	const amt = Number(amountUsd);
	if (!Number.isFinite(amt) || amt <= 0) throw badRequest('amountUsd must be a positive number');
	if (!idempotencyKey) throw badRequest('idempotencyKey is required');

	const usd = usd6(amt);
	const neg = usd6(-amt);

	let rows;
	try {
		rows = await sql`
			with upd as (
				update credit_accounts
					set balance_usd = balance_usd - ${usd},
						lifetime_spent_usd = lifetime_spent_usd + ${usd},
						updated_at = now()
				where user_id = ${userId} and balance_usd >= ${usd}
				returning balance_usd
			), led as (
				insert into credit_ledger
					(user_id, kind, amount_usd, balance_after, action, ref_type, ref_id, idempotency_key, meta)
				select ${userId}, 'spend', ${neg}, balance_usd, ${action}, ${refType}, ${refId}, ${idempotencyKey},
					   ${JSON.stringify(meta || {})}::jsonb
				from upd
				returning id, balance_after
			)
			select id, balance_after from led
		`;
	} catch (err) {
		if (isUniqueViolation(err)) {
			const prior = await priorLedger(idempotencyKey);
			return {
				balanceUsd: Number(prior?.balance_after ?? 0),
				ledgerId: prior?.id ?? null,
				replay: true,
				chargedUsd: 0,
			};
		}
		throw err;
	}

	if (!rows || rows.length === 0) {
		const acct = await getCreditAccount(userId);
		throw Object.assign(new Error('not enough credits — top up to continue'), {
			status: 402,
			code: 'insufficient_credits',
			available_usd: acct.balanceUsd,
			required_usd: amt,
		});
	}
	return {
		balanceUsd: Number(rows[0].balance_after),
		ledgerId: rows[0].id,
		replay: false,
		chargedUsd: amt,
	};
}

/**
 * Resolve the credit price for an action with the user's $THREE holder discount
 * applied — without charging. Use for display / affordability checks.
 * @returns {Promise<{ action: string, usd: number, label: string, discountBps: number }>}
 */
export async function quoteCreditsForAction({ user, action, usd = undefined }) {
	const discountBps = await holderDiscountBps(user).catch(() => 0);
	const priced = priceForAction(action, { usd, discountBps });
	return { action, usd: priced.usd, label: priced.label, discountBps };
}

/**
 * The metering primitive every paid surface calls: price an action with the
 * caller's holder discount, then debit credits for it. Throws 402
 * insufficient_credits when short. idempotencyKey must be stable per logical
 * charge so a retry never double-debits.
 * @returns {Promise<{ balanceUsd: number, ledgerId: string|null, replay: boolean, chargedUsd: number, pricedUsd: number, discountBps: number, label: string, action: string }>}
 */
export async function chargeCreditsForAction({
	user,
	action,
	usd = undefined,
	refType = null,
	refId = null,
	idempotencyKey,
	meta = {},
}) {
	if (!user?.id)
		throw badRequest('a signed-in user is required to spend credits', 'unauthorized');
	const discountBps = await holderDiscountBps(user).catch(() => 0);
	const priced = priceForAction(action, { usd, discountBps });
	const debit = await debitCredits({
		userId: user.id,
		amountUsd: priced.usd,
		action,
		refType,
		refId,
		idempotencyKey,
		meta: { ...meta, label: priced.label, discount_bps: discountBps },
	});
	return { ...debit, pricedUsd: priced.usd, discountBps, label: priced.label, action };
}

/** Return credits for an action that was charged but did not deliver. Idempotent. */
export async function refundCredits({
	userId,
	amountUsd,
	action = null,
	refType = null,
	refId = null,
	idempotencyKey,
	meta = {},
}) {
	return creditAccount({
		userId,
		amountUsd,
		kind: 'refund',
		action,
		refType,
		refId,
		idempotencyKey,
		meta,
	});
}

/** Keyset-paginated ledger history (newest first) for a user.
 *  Cursor is the `id` of the last-seen row (UUID). Stable even when two rows
 *  share the same `created_at` timestamp. */
export async function listLedger({ userId, limit = 25, before = null } = {}) {
	if (!userId) throw badRequest('userId is required');
	const cap = Math.min(Math.max(Number(limit) || 25, 1), 100);
	// before is the id of the last item on the previous page. We look up its
	// (created_at, id) pair so we can use a compound keyset condition that is
	// stable across rows with identical timestamps.
	let beforeTs = null;
	let beforeId = null;
	if (before) {
		const [anchor] = await sql`
			select created_at from credit_ledger
			where id = ${before} and user_id = ${userId}
			limit 1
		`;
		if (anchor) { beforeTs = anchor.created_at; beforeId = before; }
	}
	const rows = await sql`
		select id, kind, amount_usd, balance_after, action, ref_type, ref_id,
			   tx_signature, asset, asset_amount, price_usd, created_at
		from credit_ledger
		where user_id = ${userId}
		  and (
		    ${beforeTs}::timestamptz is null
		    or created_at < ${beforeTs}::timestamptz
		    or (created_at = ${beforeTs}::timestamptz and id < ${beforeId}::uuid)
		  )
		order by created_at desc, id desc
		limit ${cap + 1}
	`;
	const hasMore = rows.length > cap;
	const items = (hasMore ? rows.slice(0, cap) : rows).map((r) => ({
		id: r.id,
		kind: r.kind,
		amount_usd: Number(r.amount_usd),
		balance_after: Number(r.balance_after),
		action: r.action,
		ref_type: r.ref_type,
		ref_id: r.ref_id,
		tx_signature: r.tx_signature,
		asset: r.asset,
		asset_amount: r.asset_amount == null ? null : String(r.asset_amount),
		price_usd: r.price_usd == null ? null : Number(r.price_usd),
		created_at: r.created_at,
	}));
	return { items, next_cursor: hasMore ? items[items.length - 1].id : null };
}
