// Holder cohorts — named, derived audience segments over a coin's holder set.
//
// Every agent token launched on three.ws already has its full holder set
// snapshotted on-chain (Helius `getTokenAccounts`, Token-2022) into
// `coin_holders` and refreshed by the snapshot cron (see distribution.js).
// Cohorts are *queries* over that materialized set — not a second pipeline —
// so they are always as fresh as the last snapshot and need no extra storage.
//
// A cohort is a predicate over real `coin_holders` columns (balance in token
// smallest units, first_seen, last_seen). We expose them so the /go bounty
// board, coin communities, and holder worlds can target a slice of a coin's
// holders ("airdrop the top 10% of whales", "bounty visible to diamond hands",
// "win-back wallets that exited").
//
// Sampling is deterministic: the same (wallet, cohort, salt) always lands in
// the same bucket, so "10% of whales" is stable across calls and paginates
// consistently — the idea borrowed from pump.fun's internal segments SDK,
// reimplemented dependency-free against our own Postgres holder set.

import { sql } from '../db.js';

const DAY_MS = 86_400_000;

// ─── Cohort registry ─────────────────────────────────────────────────────────
//
// Each cohort declares its tunable params (with defaults) for the public
// definition listing. The predicate itself is resolved by cohortSpec() into a
// small set of bounds the single keyset query understands — no dynamic SQL
// string-building, which keeps every query a parameterized tagged template.

export const COHORTS = Object.freeze([
	{
		id: 'holders',
		name: 'All holders',
		description: 'Every wallet currently holding a positive balance.',
		params: [],
	},
	{
		id: 'whales',
		name: 'Whales',
		description: 'Largest holders by balance — the top slice of the holder set.',
		params: [{ key: 'topPct', label: 'Top fraction (0–1)', default: 0.1 }],
	},
	{
		id: 'diamond-hands',
		name: 'Diamond hands',
		description: 'Wallets that first appeared at least N days ago and still hold.',
		params: [{ key: 'minHoldDays', label: 'Minimum hold age (days)', default: 30 }],
	},
	{
		id: 'new-buyers',
		name: 'New buyers',
		description: 'Wallets that first appeared within the last N days and still hold.',
		params: [{ key: 'windowDays', label: 'Lookback window (days)', default: 7 }],
	},
	{
		id: 'exited',
		name: 'Exited',
		description: 'Wallets that once held but have since sold to zero (win-back targets).',
		params: [{ key: 'idleDays', label: 'Left at least N days ago', default: 0 }],
	},
]);

const COHORT_IDS = new Set(COHORTS.map((c) => c.id));

export function isCohortId(id) {
	return COHORT_IDS.has(id);
}

export function listCohorts() {
	return COHORTS.map((c) => ({ ...c }));
}

function num(value, fallback) {
	const n = typeof value === 'number' ? value : parseFloat(value);
	return Number.isFinite(n) ? n : fallback;
}

function daysAgo(days) {
	return new Date(Date.now() - Math.max(0, days) * DAY_MS);
}

/**
 * Resolve a cohort id + params into balance/first_seen bounds the keyset query
 * applies. `whales` is special: its bound is a balance threshold derived from a
 * percentile, so it carries { topPct } and the caller computes the threshold
 * against live data first.
 *
 * @returns {{minBalance: bigint, maxBalance: bigint|null, firstSeenBefore: Date|null, firstSeenAfter: Date|null, lastSeenBefore: Date|null, topPct?: number}}
 */
export function cohortSpec(cohortId, params = {}) {
	switch (cohortId) {
		case 'holders':
			return {
				minBalance: 1n,
				maxBalance: null,
				firstSeenBefore: null,
				firstSeenAfter: null,
				lastSeenBefore: null,
			};
		case 'whales': {
			const topPct = Math.min(Math.max(num(params.topPct, 0.1), 0.0001), 1);
			return {
				minBalance: 1n,
				maxBalance: null,
				firstSeenBefore: null,
				firstSeenAfter: null,
				lastSeenBefore: null,
				topPct,
			};
		}
		case 'diamond-hands': {
			const minHoldDays = Math.max(num(params.minHoldDays, 30), 0);
			return {
				minBalance: 1n,
				maxBalance: null,
				firstSeenBefore: daysAgo(minHoldDays),
				firstSeenAfter: null,
				lastSeenBefore: null,
			};
		}
		case 'new-buyers': {
			const windowDays = Math.max(num(params.windowDays, 7), 0);
			return {
				minBalance: 1n,
				maxBalance: null,
				firstSeenBefore: null,
				firstSeenAfter: daysAgo(windowDays),
				lastSeenBefore: null,
			};
		}
		case 'exited': {
			const idleDays = Math.max(num(params.idleDays, 0), 0);
			return {
				minBalance: 0n,
				maxBalance: 0n,
				firstSeenBefore: null,
				firstSeenAfter: null,
				lastSeenBefore: idleDays > 0 ? daysAgo(idleDays) : null,
			};
		}
		default:
			throw new Error(`unknown cohort: ${cohortId}`);
	}
}

// ─── Deterministic sampling (FNV-1a 32-bit, 10k buckets) ─────────────────────
//
// Stable, dependency-free hash so "N% of a cohort" is the same set every call
// and survives pagination. Salt defaults to the coin id so the same wallet
// falls into different buckets across coins.

const BUCKETS = 10_000;

export function sampleBucket(wallet, cohortId, salt) {
	const input = `${wallet}#${cohortId}#${salt}`;
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		// 32-bit FNV prime multiply via shifts to stay in integer range.
		h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
	}
	return h % BUCKETS;
}

export function inSample(bucket, fraction) {
	return bucket < Math.floor(fraction * BUCKETS);
}

// ─── Whale threshold ─────────────────────────────────────────────────────────
//
// The balance at the top-`topPct` rank: ceil(positiveHolders × topPct) wallets
// qualify (ties at the boundary are included, so the set is at-least-topPct).

async function whaleThreshold({ coinId, topPct }) {
	const [{ n }] = await sql`
		select count(*)::int as n from coin_holders
		where coin_id = ${coinId} and balance > 0
	`;
	const positive = n || 0;
	if (positive === 0) return null;
	const cutoffRank = Math.max(1, Math.ceil(positive * topPct));
	const [row] = await sql`
		select balance::text as balance from coin_holders
		where coin_id = ${coinId} and balance > 0
		order by balance desc
		offset ${cutoffRank - 1} limit 1
	`;
	return row ? BigInt(row.balance) : null;
}

// ─── Counts overview ─────────────────────────────────────────────────────────

/**
 * Member counts for every cohort of a coin, for the definition overview.
 * @returns {Promise<Record<string, number>>}
 */
export async function cohortCounts({ coinId, params = {} }) {
	const diamond = cohortSpec('diamond-hands', params).firstSeenBefore;
	const fresh = cohortSpec('new-buyers', params).firstSeenAfter;
	const whaleMin = await whaleThreshold({ coinId, topPct: cohortSpec('whales', params).topPct });

	const [row] = await sql`
		select
			count(*) filter (where balance > 0) as holders,
			count(*) filter (where balance > 0 and ${whaleMin == null ? null : whaleMin.toString()}::bigint is not null
				and balance >= ${whaleMin == null ? null : whaleMin.toString()}::bigint) as whales,
			count(*) filter (where balance > 0 and first_seen <= ${diamond}::timestamptz) as "diamond-hands",
			count(*) filter (where balance > 0 and first_seen >= ${fresh}::timestamptz) as "new-buyers",
			count(*) filter (where balance = 0) as exited
		from coin_holders
		where coin_id = ${coinId}
	`;
	return {
		holders: Number(row.holders) || 0,
		whales: Number(row.whales) || 0,
		'diamond-hands': Number(row['diamond-hands']) || 0,
		'new-buyers': Number(row['new-buyers']) || 0,
		exited: Number(row.exited) || 0,
	};
}

// ─── Cursor (keyset over balance desc, id asc) ───────────────────────────────

function encodeCursor(row) {
	return Buffer.from(JSON.stringify({ b: row.balance, id: row.id }), 'utf-8').toString(
		'base64url',
	);
}

function decodeCursor(cursor) {
	if (!cursor) return null;
	try {
		const { b, id } = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf-8'));
		if (typeof b !== 'string' || !Number.isFinite(Number(id))) return null;
		return { balance: b, id: Number(id) };
	} catch {
		return null;
	}
}

// ─── Member export ───────────────────────────────────────────────────────────

/**
 * Page through a cohort's members, sorted by balance desc. Optional
 * deterministic sampling thins the page (the same wallets every call).
 *
 * @param {object} opts
 * @param {string} opts.coinId
 * @param {string} opts.cohortId
 * @param {object} [opts.params]   cohort tunables (topPct, windowDays, …)
 * @param {number} [opts.limit]    page size before sampling (default 200, max 1000)
 * @param {string} [opts.cursor]   opaque pagination cursor
 * @param {number} [opts.sample]   0–1 fraction to keep via deterministic bucketing
 * @param {string} [opts.salt]     sampling salt (defaults to coinId)
 * @returns {Promise<{members: Array, nextCursor: string|null, sampled: boolean}>}
 */
export async function queryCohort({
	coinId,
	cohortId,
	params = {},
	limit = 200,
	cursor,
	sample,
	salt,
}) {
	if (!isCohortId(cohortId)) throw new Error(`unknown cohort: ${cohortId}`);
	const pageSize = Math.min(Math.max(Math.floor(limit) || 200, 1), 1000);
	const spec = cohortSpec(cohortId, params);

	let minBalance = spec.minBalance;
	if (cohortId === 'whales') {
		const threshold = await whaleThreshold({ coinId, topPct: spec.topPct });
		// No positive holders → empty cohort, short-circuit.
		if (threshold == null) return { members: [], nextCursor: null, sampled: sample != null };
		minBalance = threshold;
	}

	const after = decodeCursor(cursor);
	const maxBalance = spec.maxBalance;
	const firstSeenBefore = spec.firstSeenBefore;
	const firstSeenAfter = spec.firstSeenAfter;
	const lastSeenBefore = spec.lastSeenBefore;

	// One parameterized keyset query covers every cohort: nullable bounds are
	// no-ops via `(:p is null or …)`, and the cursor predicate continues the
	// (balance desc, id asc) order. Fetch one extra row to detect a next page.
	const rows = await sql`
		select id, wallet, balance::text as balance, first_seen, last_seen
		from coin_holders
		where coin_id = ${coinId}
		  and balance >= ${minBalance.toString()}::bigint
		  and (${maxBalance == null ? null : maxBalance.toString()}::bigint is null
		       or balance <= ${maxBalance == null ? null : maxBalance.toString()}::bigint)
		  and (${firstSeenBefore}::timestamptz is null or first_seen <= ${firstSeenBefore}::timestamptz)
		  and (${firstSeenAfter}::timestamptz is null or first_seen >= ${firstSeenAfter}::timestamptz)
		  and (${lastSeenBefore}::timestamptz is null or last_seen <= ${lastSeenBefore}::timestamptz)
		  and (${after ? after.balance : null}::bigint is null
		       or balance < ${after ? after.balance : null}::bigint
		       or (balance = ${after ? after.balance : null}::bigint and id > ${after ? after.id : null}::bigint))
		order by balance desc, id asc
		limit ${pageSize + 1}
	`;

	const hasMore = rows.length > pageSize;
	const page = hasMore ? rows.slice(0, pageSize) : rows;
	// Cursor tracks the last RAW row so pagination is unaffected by sampling.
	const nextCursor = hasMore ? encodeCursor(page[page.length - 1]) : null;

	let members = page.map((r) => ({
		wallet: r.wallet,
		balance: r.balance,
		firstSeen: r.first_seen,
		lastSeen: r.last_seen,
	}));

	const doSample = sample != null && sample > 0 && sample < 1;
	if (doSample) {
		const s = salt || coinId;
		members = members.filter((m) => inSample(sampleBucket(m.wallet, cohortId, s), sample));
	}

	return { members, nextCursor, sampled: doSample };
}
