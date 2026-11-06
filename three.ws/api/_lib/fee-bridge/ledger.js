// @ts-check
// Fee Bridge ledger reads: balances, recipient identity, and the public numbers.
//
// A handle's unpaid balance is always derived, never stored: everything credited
// to it minus every pending or confirmed payout. There is no running total that
// can drift from the rows that justify it.

import { sql } from '../db.js';

const big = (v) => BigInt(v ?? 0);

/** Credited, paid, and unpaid USDC atomics for one handle. */
export async function handleBalance(handleLc) {
	const [row] = await sql`
		select
			(select coalesce(sum(usdc_atomics), 0)::text from fee_bridge_credits where handle_lc = ${handleLc}) as credited,
			(select coalesce(sum(usdc_atomics), 0)::text from fee_bridge_payouts
				where handle_lc = ${handleLc} and status in ('pending', 'confirmed')) as paid,
			(select coalesce(sum(usdc_atomics), 0)::text from fee_bridge_payouts
				where handle_lc = ${handleLc} and status = 'pending') as in_flight
	`;
	const credited = big(row?.credited);
	const paid = big(row?.paid);
	return { credited, paid, inFlight: big(row?.in_flight), unpaid: credited - paid };
}

/**
 * The X account allowed to withdraw a handle's balance, from a user's live X
 * connection. A handle already bound to an X account id only ever pays that id
 * (so a renamed-then-reclaimed handle cannot be claimed by its new owner); an
 * unbound handle is claimed by whoever holds it on X right now.
 *
 * @param {{ userId?: string, handleLc?: string }} q  userId for a withdrawal,
 *   handleLc for an automatic payout
 * @returns {Promise<{ handleLc: string, handle: string, xUserId: string, userId: string }|null>}
 */
export async function resolveClaimant({ userId, handleLc }) {
	if (userId) {
		const [conn] = await sql`
			select user_id, provider_uid, username from social_connections
			where user_id = ${userId} and provider = 'x' and disconnected_at is null
			limit 1
		`;
		if (!conn?.provider_uid || !conn.username) return null;
		const [bound] = await sql`
			select handle_lc, handle from fee_bridge_recipients where x_user_id = ${conn.provider_uid} limit 1
		`;
		if (bound) return { handleLc: bound.handle_lc, handle: bound.handle, xUserId: conn.provider_uid, userId: conn.user_id };
		const lc = String(conn.username).toLowerCase();
		const [taken] = await sql`select x_user_id from fee_bridge_recipients where handle_lc = ${lc} limit 1`;
		if (taken && taken.x_user_id !== conn.provider_uid) return null;
		return { handleLc: lc, handle: conn.username, xUserId: conn.provider_uid, userId: conn.user_id };
	}

	const lc = String(handleLc || '').toLowerCase();
	if (!lc) return null;
	const [bound] = await sql`select x_user_id, handle from fee_bridge_recipients where handle_lc = ${lc} limit 1`;
	const [conn] = bound
		? await sql`
			select user_id, provider_uid, username from social_connections
			where provider = 'x' and provider_uid = ${bound.x_user_id} and disconnected_at is null
			order by updated_at desc nulls last limit 1
		`
		: await sql`
			select user_id, provider_uid, username from social_connections
			where provider = 'x' and lower(username) = ${lc} and disconnected_at is null
			order by updated_at desc nulls last limit 1
		`;
	if (!conn?.provider_uid) return null;
	return { handleLc: lc, handle: bound?.handle || conn.username, xUserId: conn.provider_uid, userId: conn.user_id };
}

/** A user's Solana wallets, primary first. */
export async function solanaWallets(userId) {
	const rows = await sql`
		select address, is_primary from user_wallets
		where user_id = ${userId} and chain_type = 'solana'
		order by is_primary desc, created_at asc
	`;
	return rows.map((r) => ({ address: r.address, primary: !!r.is_primary }));
}

/** Handles whose unpaid balance has reached `floor`, largest first. */
export async function handlesAtOrAbove(floor, limit) {
	const rows = await sql`
		with credited as (
			select handle_lc, sum(usdc_atomics) as amt from fee_bridge_credits group by handle_lc
		), paid as (
			select handle_lc, sum(usdc_atomics) as amt from fee_bridge_payouts
			where status in ('pending', 'confirmed') group by handle_lc
		)
		select c.handle_lc, (c.amt - coalesce(p.amt, 0))::text as unpaid
		from credited c left join paid p using (handle_lc)
		where c.amt - coalesce(p.amt, 0) >= ${floor.toString()}::numeric
		  and not exists (select 1 from fee_bridge_payouts x where x.handle_lc = c.handle_lc and x.status = 'pending')
		order by c.amt - coalesce(p.amt, 0) desc
		limit ${limit}
	`;
	return rows.map((r) => ({ handleLc: r.handle_lc, unpaid: big(r.unpaid) }));
}

/** Public totals for /fee-bridge. */
export async function publicStats() {
	const [row] = await sql`
		select
			(select count(*)::int from fee_bridge_coins where status = 'active') as coins,
			(select count(distinct handle_lc)::int from fee_bridge_coins) as handles,
			(select coalesce(sum(usdc_atomics), 0)::text from fee_bridge_credits) as credited,
			(select coalesce(sum(usdc_atomics), 0)::text from fee_bridge_payouts where status = 'confirmed') as paid,
			(select coalesce(sum(buyback_usdc_atomics), 0)::text from fee_bridge_batches where stage = 'credited') as buyback_usdc,
			(select coalesce(sum(three_bought_atomics), 0)::text from fee_bridge_batches where stage = 'credited') as three_bought,
			(select count(*)::int from fee_bridge_payouts where status = 'confirmed') as payouts
	`;
	const credited = big(row?.credited);
	const paid = big(row?.paid);
	return {
		coins: row?.coins ?? 0,
		handles: row?.handles ?? 0,
		payouts: row?.payouts ?? 0,
		credited_usdc_atomics: credited.toString(),
		paid_usdc_atomics: paid.toString(),
		unpaid_usdc_atomics: (credited - paid).toString(),
		buyback_usdc_atomics: big(row?.buyback_usdc).toString(),
		three_bought_atomics: big(row?.three_bought).toString(),
	};
}

/** Newest confirmed payouts, for the public ledger. */
export async function recentPayouts(limit = 20) {
	const rows = await sql`
		select p.id, coalesce(r.handle, p.handle_lc) as handle, p.usdc_atomics::text as usdc_atomics,
			p.signature, p.trigger, p.confirmed_at
		from fee_bridge_payouts p
		left join fee_bridge_recipients r on r.handle_lc = p.handle_lc
		where p.status = 'confirmed'
		order by p.confirmed_at desc
		limit ${limit}
	`;
	return rows.map((r) => ({
		id: r.id,
		handle: r.handle,
		usdc_atomics: r.usdc_atomics,
		signature: r.signature,
		trigger: r.trigger,
		confirmed_at: r.confirmed_at,
	}));
}

/** Registered coins with what each has earned its handle, newest first. */
export async function listCoins({ limit = 50, handleLc = null } = {}) {
	const rows = await sql`
		select c.mint, c.handle, c.handle_lc, c.status, c.quote_mint, c.created_at, c.last_crank_at,
			m.name, m.symbol,
			coalesce((select sum(usdc_atomics) from fee_bridge_credits k where k.mint = c.mint), 0)::text as credited
		from fee_bridge_coins c
		left join pump_agent_mints m on m.mint = c.mint and m.network = 'mainnet'
		where (${handleLc}::text is null or c.handle_lc = ${handleLc})
		order by c.created_at desc
		limit ${limit}
	`;
	return rows.map((r) => ({
		mint: r.mint,
		handle: r.handle,
		status: r.status,
		quote: r.quote_mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC',
		name: r.name || null,
		symbol: r.symbol || null,
		credited_usdc_atomics: r.credited,
		registered_at: r.created_at,
		last_crank_at: r.last_crank_at,
	}));
}

/** A handle's recent payouts (any status), for its owner. */
export async function payoutsFor(handleLc, limit = 20) {
	const rows = await sql`
		select id, wallet, usdc_atomics::text as usdc_atomics, trigger, status, signature, error, created_at, confirmed_at
		from fee_bridge_payouts where handle_lc = ${handleLc}
		order by created_at desc limit ${limit}
	`;
	return rows;
}
