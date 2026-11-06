// Shared club-door pass issuer.
//
// Both cover-charge rails issue the SAME entry pass once payment settles:
//   - USDC via x402         → api/x402/club-cover.js
//   - $THREE on Solana      → api/club/cover-three.js
//
// The bouncer logic is identical regardless of which coin paid: look the payer
// up against the ban list, count their prior settled club activity to assign a
// door tier, and mint a time-boxed pass the /club door consumes to drop the
// rope. Keeping it here means the two endpoints can never drift on who gets in.

import { randomUUID } from 'node:crypto';
import { sql } from '../db.js';

// How long an entry pass is good for. A wallet that paid the cover re-enters
// for the rest of the night without paying again.
export const PASS_TTL_SEC = 60 * 60 * 6; // 6 hours

// Normalize a wallet for ban/activity lookups. Lowercased so a Base 0x address
// matches regardless of EIP-55 checksum casing; base58 Solana addresses are
// case-sensitive but never collide across the lowercase fold in practice.
export function normalizeWallet(w) {
	return String(w || '').trim().toLowerCase();
}

/**
 * Look the payer's wallet up against the ban list. Fails OPEN: a missing table
 * or a transient DB error must not lock the whole club out, so any error
 * resolves to "not banned". Returns the matching row or null.
 */
export async function findBan(wallet) {
	if (!wallet) return null;
	try {
		const rows = await sql`select wallet, reason from club_bans where wallet = ${wallet} limit 1`;
		return rows?.[0] ?? null;
	} catch (err) {
		console.warn('[club-cover] ban lookup failed (fail-open)', err?.message || err);
		return null;
	}
}

/**
 * Count this wallet's prior settled club tips to assign a door tier. Pure read
 * of the existing club_tips ledger. Fails soft to 0 visits / newcomer.
 */
export async function visitsFor(wallet) {
	if (!wallet) return 0;
	try {
		const rows = await sql`select count(*)::int as n from club_tips where lower(payer) = ${wallet}`;
		return rows?.[0]?.n ?? 0;
	} catch (err) {
		console.warn('[club-cover] visit count failed (soft 0)', err?.message || err);
		return 0;
	}
}

export function tierFor(visits) {
	if (visits >= 10) return 'vip';
	if (visits >= 1) return 'regular';
	return 'newcomer';
}

// ── Membership snapshot ─────────────────────────────────────────────────────
//
// The cover-charge endpoint also sells a *membership snapshot* of the club: a
// paid read of who actually shows up. There is a single club ledger (club_tips —
// every settled door/dance payment writes one row), so the snapshot is computed
// over that ledger and the requested `club` label (e.g. "three_holders") is
// carried through for the caller's bookkeeping. Three real, growth/churn-
// actionable counts come straight out of the ledger:
//
//   member_count   — distinct wallets that have ever paid into the club (the
//                    all-time membership base).
//   active_last_7d — distinct wallets with a settled payment in the last 7 days
//                    (this week's active members).
//   new_this_week  — distinct wallets whose FIRST-EVER payment landed in the
//                    last 7 days (genuinely new members, not returning ones).
//
// One round-trip: group the ledger by wallet to get each wallet's first/last
// activity, then tally over those per-wallet extents.
//
// Fails HARD (throws 503) on a query error so the paid endpoint never charges
// for a snapshot it couldn't actually compute — a genuinely empty club returns
// all zeros, which is a real answer and is fine to bill.
export async function membershipSnapshot(club = 'three_holders') {
	let row;
	try {
		const rows = await sql`
			with firsts as (
				select
					lower(payer)     as wallet,
					min(created_at)  as first_seen,
					max(created_at)  as last_seen
				from club_tips
				where payer is not null and payer <> ''
				group by lower(payer)
			)
			select
				count(*)::int                                                            as member_count,
				count(*) filter (where last_seen  >= now() - interval '7 days')::int     as active_last_7d,
				count(*) filter (where first_seen >= now() - interval '7 days')::int     as new_this_week
			from firsts
		`;
		row = rows?.[0] || {};
	} catch (err) {
		throw Object.assign(
			new Error(`club membership ledger is temporarily unavailable: ${err?.message || err}`),
			{ status: 503, code: 'membership_unavailable' },
		);
	}
	return classifyMembership({
		club,
		member_count: Number(row.member_count) || 0,
		active_last_7d: Number(row.active_last_7d) || 0,
		new_this_week: Number(row.new_this_week) || 0,
	});
}

// Turn the three raw counts into a classified growth/churn signal. Pure — the
// snapshot endpoint embeds the result in the paid response and the autonomous
// loop's extractSignal lifts the same fields, so writer and reader never drift.
//
// @param {{ club?: string, member_count: number, active_last_7d: number, new_this_week: number }} s
export function classifyMembership(s) {
	const member_count = Math.max(0, Math.round(Number(s?.member_count) || 0));
	const active_last_7d = Math.max(0, Math.round(Number(s?.active_last_7d) || 0));
	const new_this_week = Math.max(0, Math.round(Number(s?.new_this_week) || 0));

	// Share of the base that is new this week / active this week.
	const growth_rate = member_count > 0 ? new_this_week / member_count : 0;
	const active_rate = member_count > 0 ? active_last_7d / member_count : 0;

	let signal, headline;
	if (member_count === 0) {
		signal = 'empty';
		headline = 'No club members yet — the door has seen no settled activity.';
	} else if (new_this_week >= 1 && growth_rate >= 0.1) {
		signal = 'growing';
		headline = `Club growing — ${new_this_week} new member${new_this_week === 1 ? '' : 's'} this week (${Math.round(growth_rate * 100)}% of the base).`;
	} else if (active_rate < 0.1) {
		signal = 'churning';
		headline = `Club churning — only ${active_last_7d} of ${member_count} members active in the last 7 days.`;
	} else {
		signal = 'stable';
		headline = `Club stable — ${active_last_7d} of ${member_count} members active this week, ${new_this_week} new.`;
	}

	// Confidence grows with the membership base: a 1-member club is a weak
	// read, a 50+ member club is a confident one. Clamped to [0.3, 0.95].
	const confidence =
		member_count === 0 ? 0.3 : Math.min(0.95, Math.max(0.3, member_count / 50));

	return {
		club: String(s?.club || 'three_holders'),
		member_count,
		active_last_7d,
		new_this_week,
		growth_rate: Number(growth_rate.toFixed(4)),
		active_rate: Number(active_rate.toFixed(4)),
		signal,
		headline,
		confidence: Number(confidence.toFixed(2)),
	};
}

/**
 * Run the bouncer over a paid wallet and return its entry pass. The payment is
 * assumed already settled on-chain by the caller — this only decides admission
 * and tier. A banned wallet gets `admitted:false` and no usable pass (the cover
 * already settled; there are no refunds for being on the list).
 *
 * @param {{ payer: string|null, network?: string|null, amountAtomics?: string|null, asset?: string|null }} p
 * @returns {Promise<object>} the pass object the /club door consumes.
 */
export async function issueCoverPass({ payer, network = null, amountAtomics = null, asset = null }) {
	const wallet = normalizeWallet(payer || '');
	const now = new Date();

	const ban = await findBan(wallet);
	if (ban) {
		return {
			ok: true,
			admitted: false,
			banned: true,
			reason: ban.reason || 'Not on the list tonight.',
			tier: 'banned',
			visits: 0,
			passId: randomUUID(),
			issuedAt: now.toISOString(),
			expiresAt: now.toISOString(),
			payer: payer ?? null,
			network,
			amountAtomics,
			asset,
		};
	}

	const visits = await visitsFor(wallet);
	const expires = new Date(now.getTime() + PASS_TTL_SEC * 1000);

	return {
		ok: true,
		admitted: true,
		banned: false,
		reason: null,
		tier: tierFor(visits),
		visits,
		passId: randomUUID(),
		issuedAt: now.toISOString(),
		expiresAt: expires.toISOString(),
		payer: payer ?? null,
		network,
		amountAtomics,
		asset,
	};
}
