// Holder snapshot via Helius's DAS API (helius-sdk).
//
// Pump.fun tokens are issued on Token-2022 (createV2). Helius's `getTokenAccounts`
// indexes both the legacy SPL Token program and Token-2022 transparently, so a
// single mint filter returns every holder regardless of token program. This
// replaces the previous direct-RPC `getProgramAccounts` walk, which:
//   • returned thousands of accounts in a single un-paginated response (OOM risk)
//   • required two separate calls (one per token program)
//   • was slower for popular mints (Helius's DAS-indexed path is purpose-built)
//
// Each token account belongs to an owner wallet (the "holder"). We aggregate
// balances by owner — a single owner can have multiple token accounts (rare
// for retail wallets but does happen with multisigs).
//
// Snapshots are persisted into coin_holders via upsert; balances of zero
// (i.e. holders that fully exited) are KEPT in the table at balance=0 because
// their accrued_reflection_lamports might still be unpaid. The reflection
// payout flow filters by balance > min_holder_balance at distribution time.

import { sql } from '../db.js';
import { createHelius } from 'helius-sdk';

const PAGE_LIMIT = 1000;
const MAX_PAGES = 200; // hard ceiling — 200k holders before we abort, matches Helius limits
const UPSERT_CHUNK = 2000; // rows per batched upsert — keeps statements under Neon size limits

// Per-page retry policy for the DAS walk. Helius enforces a shared requests/sec
// rate limit; a multi-page holder scan can trip it mid-walk and the SDK throws a
// 429. Retrying that page after a short backoff lets the limiter refill and the
// scan complete, instead of aborting the whole snapshot tick (the production
// failure mode behind the "[three-holders-snapshot] refresh failed: Solana error
// #8100002" floods — #8100002 is the @solana/kit HTTP-transport wrapper carrying
// statusCode 429). Capped well under the cron's 120s budget: at most
// PAGE_RETRY_MAX backoffs of up to PAGE_RETRY_CAP_MS each, gated by an overall
// SCAN_BUDGET_MS deadline so a sustained throttle degrades to a deferred tick
// rather than a function timeout.
const PAGE_RETRY_MAX = 4;
const PAGE_RETRY_BASE_MS = 500;
const PAGE_RETRY_CAP_MS = 6000;
const SCAN_BUDGET_MS = 90_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * True when a thrown RPC error is an upstream rate limit (HTTP 429). Handles the
 * three shapes Helius/@solana/kit produce: a SolanaError whose `context.statusCode`
 * is 429 (the structured signal, present at runtime even when the human-readable
 * message is stripped in prod builds), a plain error with `.status`/`.statusCode`,
 * and the verbatim provider bodies ("429", "Too Many Requests", "max usage
 * reached") that surface only as a message string. Exported so the snapshot cron
 * classifies the same condition as a transient warning, not an error.
 * @param {unknown} err
 * @returns {boolean}
 */
export function isRpcRateLimited(err) {
	if (!err || typeof err !== 'object') return false;
	const e = /** @type {any} */ (err);
	const ctx = e.context || {};
	const status = Number(e.statusCode ?? e.status ?? ctx.statusCode ?? NaN);
	if (status === 429) return true;
	const msg = String(e.message || err);
	return /\b429\b|too many requests|rate.?limit|max usage reached/i.test(msg);
}

// One DAS page with bounded exponential backoff on 429. Non-rate-limit errors
// (auth, malformed mint, network reset) propagate immediately — retrying them
// only burns the scan budget. `deadline` is the absolute epoch-ms cutoff for the
// whole walk; once a backoff would cross it we give up so the cron never runs
// past its function budget.
async function getTokenAccountsPage(client, params, deadline) {
	for (let attempt = 0; ; attempt++) {
		try {
			return await client.getTokenAccounts(params);
		} catch (err) {
			if (!isRpcRateLimited(err) || attempt >= PAGE_RETRY_MAX) throw err;
			const backoff = Math.min(PAGE_RETRY_CAP_MS, PAGE_RETRY_BASE_MS * 2 ** attempt)
				+ Math.floor(Math.random() * 250); // small jitter so concurrent scanners desync
			if (Date.now() + backoff > deadline) throw err;
			await sleep(backoff);
		}
	}
}

let _heliusMainnet = null;
let _heliusDevnet = null;

function helius(network) {
	const apiKey = process.env.HELIUS_API_KEY;
	if (!apiKey) throw new Error('HELIUS_API_KEY not set');
	if (network === 'devnet') {
		if (!_heliusDevnet) _heliusDevnet = createHelius({ apiKey, cluster: 'devnet' });
		return _heliusDevnet;
	}
	if (!_heliusMainnet) _heliusMainnet = createHelius({ apiKey, cluster: 'mainnet' });
	return _heliusMainnet;
}

/**
 * Fetch all holders of a given mint via Helius's DAS-indexed `getTokenAccounts`.
 * Aggregates per-owner balances across multiple token accounts.
 *
 * @param {object} opts
 * @param {string} opts.mint
 * @param {'mainnet'|'devnet'} [opts.network]
 * @returns {Promise<Map<string, bigint>>}  owner → token-units (BigInt)
 */
export async function fetchHolderBalances({ mint, network = 'mainnet' }) {
	const client = helius(network);
	const balances = new Map();
	const deadline = Date.now() + SCAN_BUDGET_MS;

	let cursor;
	for (let page = 0; page < MAX_PAGES; page++) {
		const resp = await getTokenAccountsPage(client, {
			mint,
			limit: PAGE_LIMIT,
			...(cursor ? { cursor } : {}),
			options: { showZeroBalance: false },
		}, deadline);

		const accounts = resp?.token_accounts || [];
		for (const acc of accounts) {
			const owner = acc.owner;
			if (!owner) continue;
			// Helius types `amount` as `number`, but its underlying value comes
			// from a string in the JSON response. Coerce through String() so
			// BigInt() never sees scientific notation for huge supplies.
			const amountStr = acc.amount == null ? null : String(acc.amount);
			if (!amountStr || amountStr === '0') continue;
			const n = BigInt(amountStr);
			if (n === 0n) continue;
			balances.set(owner, (balances.get(owner) || 0n) + n);
		}

		// Helius returns a cursor when more pages remain. Empty/missing cursor
		// or short page → we're done.
		if (!resp?.cursor || accounts.length < PAGE_LIMIT) break;
		cursor = resp.cursor;
	}

	return balances;
}

/**
 * Persist a holder snapshot into coin_holders. Returns counts for logging.
 * Wallets with balance=0 in the snapshot are downgraded to balance=0 in DB
 * (so they stop accruing reflection) but the row is preserved so any pending
 * accrued_reflection_lamports remains claimable.
 *
 * @param {object} opts
 * @param {string} opts.coinId
 * @param {Map<string, bigint>} opts.balances
 */
export async function persistHolderSnapshot({ coinId, balances }) {
	const now = new Date();
	const wallets = [...balances.keys()];

	// Batched multi-row upsert via unnest — one round-trip per chunk instead of
	// one per holder. For a popular mint that is thousands of holders, so a
	// per-wallet loop over the Neon HTTP driver would be thousands of serial
	// round-trips. Chunk to stay under Postgres statement-size limits. Mirrors
	// the unnest upsert in api/_lib/agent-embeddings.js.
	for (let i = 0; i < wallets.length; i += UPSERT_CHUNK) {
		const chunk = wallets.slice(i, i + UPSERT_CHUNK);
		const coinIds = chunk.map(() => coinId);
		const balanceStrs = chunk.map((w) => balances.get(w).toString());
		await sql`
			insert into coin_holders (coin_id, wallet, balance, first_seen, last_seen)
			select u.coin_id, u.wallet, u.balance, ${now}, ${now}
			from unnest(
				${coinIds}::uuid[],
				${chunk}::text[],
				${balanceStrs}::bigint[]
			) as u(coin_id, wallet, balance)
			on conflict (coin_id, wallet) do update set
				balance = excluded.balance,
				last_seen = excluded.last_seen
		`;
	}

	// Mark wallets that vanished from the snapshot as balance=0 so they stop
	// accruing reflection. Neon's HTTP client expands arrays into Postgres
	// array params, so we use `NOT (wallet = ANY($1))` rather than `NOT IN`.
	if (wallets.length > 0) {
		await sql`
			update coin_holders
			set balance = 0
			where coin_id = ${coinId}
			  and balance > 0
			  and not (wallet = any(${wallets}))
		`;
	} else {
		await sql`
			update coin_holders set balance = 0
			where coin_id = ${coinId} and balance > 0
		`;
	}

	await sql`
		update coin_launches
		set last_snapshot_at = ${now}, updated_at = ${now}
		where id = ${coinId}
	`;

	const positive = wallets.filter((w) => balances.get(w) > 0n).length;
	return { totalAccounts: wallets.length, positive };
}

/**
 * Read the current eligible-holder set from DB. Returns {wallet, balance}
 * tuples for everyone with balance > min_holder_balance, sorted descending
 * by balance.
 */
export async function readEligibleHolders({ coinId, minBalance = 0n }) {
	const rows = await sql`
		select wallet, balance::text as balance
		from coin_holders
		where coin_id = ${coinId} and balance > ${minBalance.toString()}::bigint
		order by balance::numeric desc
	`;
	return rows.map((r) => ({ wallet: r.wallet, balance: BigInt(r.balance) }));
}
