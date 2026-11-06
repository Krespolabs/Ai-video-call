// Cosmetic creator economy (R25) — coin-tied revenue splits on top of the R22
// avatar-shop rail.
//
// Every /play world IS a pump.fun coin (keyed by its mint). When a player buys a
// premium cosmetic inside a coin's world, the sale is "tied" to that coin: a
// configurable share of the settled USDC is paid out — as a REAL on-chain USDC
// transfer from the platform settlement wallet to the coin's creator wallet
// (reusing api/_lib/solana-transfer.js, the same payout rail the club sweep uses).
// There is no simulated balance: the creator either has a confirmed payout tx or a
// pending/failed accrual a sweep retries.
//
// The split is recorded by the verified-payment handler in
// api/x402/cosmetic-purchase.js (R22), the only writer. The creator-earnings
// dashboard and the platform "rarest fits" leaderboard read the ledger back. All
// amounts are USDC atomics (6 decimals) — the asset x402 actually settles. ($THREE
// stays the only coin the shop quotes value in; it is never a settlement asset.)

import bs58 from 'bs58';

import { sql } from './db.js';
import { databaseConfigured } from './env.js';
import { getCosmetic } from './cosmetics.js';
import { verifySiwsSignature } from './siws.js';
import { transferSolanaUSDC } from './solana-transfer.js';
import { SOLANA_USDC_MINT } from '../payments/_config.js';
import { loadCoinByMint } from './coin/index.js';

// The default creator share of a coin-tied cosmetic sale, in basis points. A coin
// creator can raise or lower their own share but never above MAX_CREATOR_BPS — the
// platform always keeps a slice to fund the worlds the cosmetics are worn in.
export const DEFAULT_CREATOR_BPS = 5000; // 50%
export const MAX_CREATOR_BPS = 9000;     // 90% ceiling

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
// Rarity → flex weight. Drives the "rarest fits" status score: a legendary fit is
// worth far more to a wallet's flex score than a rare one.
export const RARITY_WEIGHT = Object.freeze({ common: 1, rare: 4, epic: 12, legendary: 40 });

export function isMint(mint) {
	return typeof mint === 'string' && BASE58_RE.test(mint);
}
export function isWallet(addr) {
	return typeof addr === 'string' && BASE58_RE.test(addr);
}

// True only when a durable economy DB is configured. Recording is best-effort: a
// missing DB must never block an R22 unlock the buyer already paid for.
export function economyDbConfigured() {
	return databaseConfigured();
}

// ── Creator resolution ─────────────────────────────────────────────────────

// Resolve the creator wallet that earns a coin's cosmetic share. Order:
//   1. an explicit cosmetic_creator_splits override (the creator set it),
//   2. our own launch record (coin_launches.creator_wallet),
//   3. an agent identity that launched this mint (agent_identities.meta.token),
//   4. the on-chain pump.fun bonding-curve creator (arbitrary community coins).
// Returns { wallet, source }; { wallet:null, source:'none' } when none resolves —
// the sale then settles with no creator leg (full platform revenue).
export async function resolveCreatorWallet(mint, { allowOnchain = true } = {}) {
	if (!isMint(mint)) return { wallet: null, source: 'none' };
	try {
		const [cfg] = await sql`
			select creator_wallet from cosmetic_creator_splits where mint = ${mint} limit 1
		`;
		if (isWallet(cfg?.creator_wallet)) return { wallet: cfg.creator_wallet, source: 'config' };

		const coin = await loadCoinByMint(mint).catch(() => null);
		if (isWallet(coin?.creator_wallet)) return { wallet: coin.creator_wallet, source: 'coin_launches' };

		const [agent] = await sql`
			select meta->'token'->>'creator' as creator
			from agent_identities
			where deleted_at is null and meta->'token'->>'mint' = ${mint}
			limit 1
		`;
		if (isWallet(agent?.creator)) return { wallet: agent.creator, source: 'agent_identity' };
	} catch (err) {
		console.warn('[cosmetics-economy] DB creator lookup failed:', err?.message);
	}

	if (allowOnchain) {
		const onchain = await resolveOnchainPumpCreator(mint);
		if (onchain) return { wallet: onchain, source: 'pumpfun_onchain' };
	}
	return { wallet: null, source: 'none' };
}

// Best-effort on-chain creator from the pump.fun bonding curve. Heavy SDK imports
// are deferred so the common (DB-resolved) path never loads them. Returns null on
// any failure — an unresolvable creator just means "no creator leg".
async function resolveOnchainPumpCreator(mint) {
	try {
		const [{ PublicKey }, { PUMP_SDK, bondingCurvePda }, { getConnection }] = await Promise.all([
			import('@solana/web3.js'),
			import('@pump-fun/pump-sdk'),
			import('./pump.js'),
		]);
		const conn = getConnection({ network: 'mainnet' });
		const info = await conn.getAccountInfo(bondingCurvePda(new PublicKey(mint)));
		if (!info) return null;
		const curve = typeof PUMP_SDK?.decodeBondingCurve === 'function'
			? PUMP_SDK.decodeBondingCurve(info)
			: new PUMP_SDK().decodeBondingCurve(info);
		const creator = curve?.creator?.toBase58?.();
		return isWallet(creator) ? creator : null;
	} catch (err) {
		console.warn('[cosmetics-economy] on-chain creator lookup failed:', err?.message);
		return null;
	}
}

// ── Split config ───────────────────────────────────────────────────────────

export function clampCreatorBps(bps) {
	const n = Number(bps);
	if (!Number.isFinite(n)) return DEFAULT_CREATOR_BPS;
	return Math.max(0, Math.min(MAX_CREATOR_BPS, Math.round(n)));
}

// The effective split config for a coin: the creator wallet + share applied to its
// cosmetic sales. Reflects an explicit override when present, otherwise the
// resolved creator at the default share. `isDefault` tells the UI whether the
// creator has customized it yet.
export async function getSplitConfig(mint) {
	if (!isMint(mint)) return null;
	const [row] = await sql`
		select mint, creator_wallet, split_bps, updated_at
		from cosmetic_creator_splits where mint = ${mint} limit 1
	`;
	if (row) {
		return {
			mint: row.mint,
			creatorWallet: row.creator_wallet,
			splitBps: row.split_bps,
			source: 'config',
			isDefault: false,
			updatedAt: row.updated_at,
			maxBps: MAX_CREATOR_BPS,
		};
	}
	const { wallet, source } = await resolveCreatorWallet(mint);
	return {
		mint,
		creatorWallet: wallet,
		splitBps: wallet ? DEFAULT_CREATOR_BPS : 0,
		source,
		isDefault: true,
		updatedAt: null,
		maxBps: MAX_CREATOR_BPS,
	};
}

// The message a creator signs to authorize changing their coin's cosmetic split.
export function splitConfigMessage({ mint, bps, ts }) {
	return `three.ws cosmetic revenue split\nmint: ${mint}\nshare: ${bps} bps\nts: ${ts}`;
}

const SIGNATURE_MAX_AGE_S = 600; // a config-change signature is valid for 10 minutes

// Set a coin's cosmetic split, authorized by an ed25519 signature from the coin's
// creator wallet over splitConfigMessage(). Verifies the signer IS the resolved
// creator, the timestamp is fresh, and the bps is in range. Returns the new
// effective config. Throws { status, code, message, expose } on any failure.
export async function setSplitConfig({ mint, bps, ts, signature, signer }) {
	if (!isMint(mint)) throw fail(400, 'bad_mint', 'Invalid coin mint.');
	const bpsClamped = clampCreatorBps(bps);
	const tsNum = Number(ts);
	if (!Number.isFinite(tsNum)) throw fail(400, 'bad_timestamp', 'Missing or invalid timestamp.');
	const ageS = Math.floor(Date.now() / 1000) - tsNum;
	if (ageS < -60 || ageS > SIGNATURE_MAX_AGE_S) throw fail(400, 'stale_signature', 'Signature timestamp is too old or in the future.');
	if (!isWallet(signer)) throw fail(400, 'bad_signer', 'Invalid signer wallet.');

	const { wallet: creatorWallet } = await resolveCreatorWallet(mint);
	if (!creatorWallet) throw fail(409, 'no_creator', 'No creator wallet is established for this coin yet.');
	if (creatorWallet !== signer) throw fail(403, 'not_creator', 'Only the coin creator can set the cosmetic split.');

	let valid = false;
	try {
		valid = verifySiwsSignature(splitConfigMessage({ mint, bps: bpsClamped, ts: tsNum }), signature, signer);
	} catch { valid = false; }
	if (!valid) throw fail(401, 'bad_signature', 'Signature did not verify against the creator wallet.');

	await sql`
		insert into cosmetic_creator_splits (mint, creator_wallet, split_bps, updated_by)
		values (${mint}, ${creatorWallet}, ${bpsClamped}, ${signer})
		on conflict (mint) do update
		set creator_wallet = excluded.creator_wallet,
		    split_bps = excluded.split_bps,
		    updated_by = excluded.updated_by
	`;
	return getSplitConfig(mint);
}

// ── Record + pay the creator split ─────────────────────────────────────────

// Decode the platform settlement wallet that fronts creator payouts. This is the
// wallet the x402 Solana settlements land in; ops configures its 64-byte secret
// (base64) so the split can be sent back out on-chain. Returns the bs58 secret
// transferSolanaUSDC expects, or null when unconfigured (payouts then accrue).
function payoutTreasuryBs58() {
	const b64 = process.env.COSMETIC_SPLIT_TREASURY_SECRET_KEY_B64;
	if (!b64) return null;
	try {
		const raw = Buffer.from(b64, 'base64');
		if (raw.byteLength !== 64) {
			console.warn('[cosmetics-economy] COSMETIC_SPLIT_TREASURY_SECRET_KEY_B64 is not a 64-byte secret — payouts disabled.');
			return null;
		}
		return bs58.encode(raw);
	} catch {
		return null;
	}
}

// Record a settled cosmetic sale and pay the coin creator their share on-chain.
// Idempotent on (account, cosmetic): a replayed settle or SIWX re-access conflicts
// and returns the existing record without re-paying. On a fresh sale it resolves
// the creator + share, inserts the ledger row, then BEST-EFFORT pays the creator's
// USDC cut on Solana — a payout failure leaves the row 'pending'/'failed' (the
// buyer still owns the cosmetic; a sweep retries the payout). Never throws to the
// caller: recording/payout must not fail the unlock the buyer already paid for.
//
// @returns {Promise<{ recorded:boolean, alreadyRecorded?:boolean, creatorWallet?:string|null,
//   creatorBps?:number, creatorCutAtomics?:string, payoutStatus?:string, payoutTx?:string|null }>}
export async function recordSaleAndSplit({ account, cosmeticId, item, payerWallet, payerNetwork, asset, priceAtomics, mint }) {
	if (!economyDbConfigured()) return { recorded: false };
	const cosmetic = item || getCosmetic(cosmeticId);
	if (!cosmetic) return { recorded: false };

	let priceRaw;
	try { priceRaw = BigInt(priceAtomics || '0'); } catch { priceRaw = 0n; }

	// Resolve the creator + share for this coin world (best-effort).
	let creatorWallet = null;
	let bps = 0;
	if (isMint(mint)) {
		try {
			const cfg = await getSplitConfig(mint);
			if (cfg?.creatorWallet && isWallet(cfg.creatorWallet)) {
				creatorWallet = cfg.creatorWallet;
				bps = clampCreatorBps(cfg.splitBps);
			}
		} catch (err) {
			console.warn('[cosmetics-economy] split config resolve failed:', err?.message);
		}
	}
	// Never pay the creator out of a payment they themselves made.
	if (creatorWallet && payerWallet && creatorWallet === payerWallet) { creatorWallet = null; bps = 0; }
	const cutRaw = creatorWallet && bps > 0 ? (priceRaw * BigInt(bps)) / 10000n : 0n;
	const initialStatus = !creatorWallet || cutRaw <= 0n ? 'none' : 'pending';

	// Insert-or-skip, idempotent on (account, cosmetic). A conflict means we already
	// recorded (and possibly paid) this unlock — return without re-paying.
	let inserted;
	try {
		[inserted] = await sql`
			insert into cosmetic_sales (
				account, payer_wallet, payer_network, mint, cosmetic_id, rarity,
				price_usdc_atomics, asset, creator_wallet, split_bps, creator_cut_atomics, payout_status
			) values (
				${account}, ${payerWallet || null}, ${payerNetwork || null}, ${isMint(mint) ? mint : null},
				${cosmeticId}, ${cosmetic.rarity || 'common'}, ${priceRaw.toString()}, ${asset || null},
				${creatorWallet}, ${bps}, ${cutRaw.toString()}, ${initialStatus}
			)
			on conflict (account, cosmetic_id) do nothing
			returning id
		`;
	} catch (err) {
		console.error('[cosmetics-economy] sale insert failed:', err?.message);
		return { recorded: false };
	}
	if (!inserted) {
		return { recorded: true, alreadyRecorded: true };
	}

	// Pay the creator their cut on-chain (best-effort). Solana-only: pump.fun
	// creators are Solana wallets, and the platform fronts the USDC on Solana
	// regardless of which network the buyer paid on.
	let payoutStatus = initialStatus;
	let payoutTx = null;
	if (initialStatus === 'pending') {
		const result = await payCreatorCut({ saleId: inserted.id, creatorWallet, cutRaw });
		payoutStatus = result.status;
		payoutTx = result.tx || null;
	}

	return {
		recorded: true,
		alreadyRecorded: false,
		creatorWallet,
		creatorBps: bps,
		creatorCutAtomics: cutRaw.toString(),
		payoutStatus,
		payoutTx,
	};
}

// Send one creator cut on-chain and reconcile the ledger row. Returns the new
// payout status + tx (or the failure). Never throws.
async function payCreatorCut({ saleId, creatorWallet, cutRaw }) {
	const fromWallet = payoutTreasuryBs58();
	if (!fromWallet) {
		await markPayout(saleId, { status: 'skipped', error: 'payout treasury not configured' });
		return { status: 'skipped' };
	}
	try {
		const tx = await transferSolanaUSDC({
			fromWallet,
			toAddress: creatorWallet,
			amount: cutRaw,
			mint: SOLANA_USDC_MINT,
		});
		await markPayout(saleId, { status: 'paid', tx, network: 'solana' });
		return { status: 'paid', tx };
	} catch (err) {
		const reason = err?.message ? String(err.message).slice(0, 300) : 'payout_failed';
		console.error('[cosmetics-economy] creator payout failed:', reason);
		await markPayout(saleId, { status: 'failed', error: reason });
		return { status: 'failed' };
	}
}

async function markPayout(saleId, { status, tx = null, network = null, error = null }) {
	try {
		await sql`
			update cosmetic_sales
			set payout_status = ${status},
			    payout_tx = ${tx},
			    payout_network = ${network},
			    payout_error = ${error},
			    paid_at = ${status === 'paid' ? new Date().toISOString() : null}
			where id = ${saleId}
		`;
	} catch (err) {
		console.error('[cosmetics-economy] payout reconcile failed:', err?.message);
	}
}

// Retry creator payouts that haven't landed on-chain (pending/failed). Bounded per
// run. Returns a per-sale outcome list. Safe to call from a cron or an admin tool.
export async function sweepPendingCreatorPayouts({ limit = 25 } = {}) {
	if (!economyDbConfigured()) return { swept: 0, results: [] };
	const rows = await sql`
		select id, creator_wallet, creator_cut_atomics
		from cosmetic_sales
		where payout_status in ('pending', 'failed')
		  and creator_wallet is not null
		  and creator_cut_atomics > 0
		order by settled_at asc
		limit ${limit}
	`;
	const results = [];
	for (const r of rows) {
		const out = await payCreatorCut({ saleId: r.id, creatorWallet: r.creator_wallet, cutRaw: BigInt(r.creator_cut_atomics) });
		results.push({ id: r.id, status: out.status, tx: out.tx || null });
	}
	return { swept: results.length, results };
}

// ── Creator earnings (dashboard) ───────────────────────────────────────────

const usdc = (raw) => Number(raw || 0) / 1e6;

// Real, settled cosmetic earnings for a creator wallet: lifetime + 30-day totals,
// paid vs. pending, per-coin + per-cosmetic breakdowns, and recent sales. Every
// number is summed straight from the ledger — never estimated.
export async function creatorEarnings(creatorWallet, { recentLimit = 25 } = {}) {
	if (!isWallet(creatorWallet)) return null;

	const [totals] = await sql`
		select
			count(*)::int as sales,
			count(distinct account)::int as buyers,
			coalesce(sum(creator_cut_atomics), 0)::text as earned,
			coalesce(sum(creator_cut_atomics) filter (where payout_status = 'paid'), 0)::text as paid,
			coalesce(sum(creator_cut_atomics) filter (where payout_status in ('pending','failed')), 0)::text as pending,
			coalesce(sum(creator_cut_atomics) filter (where settled_at > now() - interval '30 days'), 0)::text as earned_30d,
			coalesce(sum(price_usdc_atomics), 0)::text as gross,
			min(settled_at) as first_sale_at,
			max(settled_at) as last_sale_at
		from cosmetic_sales
		where creator_wallet = ${creatorWallet}
	`;

	const perCoin = await sql`
		select mint, count(*)::int as sales, coalesce(sum(creator_cut_atomics),0)::text as earned
		from cosmetic_sales where creator_wallet = ${creatorWallet}
		group by mint order by sum(creator_cut_atomics) desc limit 50
	`;
	const perCosmetic = await sql`
		select cosmetic_id, rarity, count(*)::int as sales, coalesce(sum(creator_cut_atomics),0)::text as earned
		from cosmetic_sales where creator_wallet = ${creatorWallet}
		group by cosmetic_id, rarity order by sum(creator_cut_atomics) desc limit 50
	`;
	const recent = await sql`
		select cosmetic_id, rarity, mint, account, price_usdc_atomics, creator_cut_atomics,
		       split_bps, payout_status, payout_tx, settled_at
		from cosmetic_sales where creator_wallet = ${creatorWallet}
		order by settled_at desc limit ${recentLimit}
	`;

	return {
		creatorWallet,
		currency: 'USDC',
		totals: {
			sales: totals.sales,
			buyers: totals.buyers,
			earnedUsdc: usdc(totals.earned),
			paidUsdc: usdc(totals.paid),
			pendingUsdc: usdc(totals.pending),
			earned30dUsdc: usdc(totals.earned_30d),
			grossUsdc: usdc(totals.gross),
			firstSaleAt: totals.first_sale_at,
			lastSaleAt: totals.last_sale_at,
		},
		perCoin: perCoin.map((r) => ({ mint: r.mint, sales: r.sales, earnedUsdc: usdc(r.earned) })),
		perCosmetic: perCosmetic.map((r) => ({
			cosmeticId: r.cosmetic_id,
			name: getCosmetic(r.cosmetic_id)?.name || r.cosmetic_id,
			rarity: r.rarity,
			sales: r.sales,
			earnedUsdc: usdc(r.earned),
		})),
		recent: recent.map((r) => ({
			cosmeticId: r.cosmetic_id,
			name: getCosmetic(r.cosmetic_id)?.name || r.cosmetic_id,
			rarity: r.rarity,
			mint: r.mint,
			buyer: r.account,
			priceUsdc: usdc(r.price_usdc_atomics),
			earnedUsdc: usdc(r.creator_cut_atomics),
			splitBps: r.split_bps,
			payoutStatus: r.payout_status,
			payoutTx: r.payout_tx,
			settledAt: r.settled_at,
		})),
	};
}

// ── Leaderboard / rarest fits ──────────────────────────────────────────────

// The platform-wide flex surface, all from settled records:
//   • rarestFits   — premium cosmetics ranked by scarcity (fewest distinct owners),
//     each with a deep link back to a world where it's been bought.
//   • topCollectors — accounts ranked by a rarity-weighted flex score.
//   • topCreators  — creator wallets ranked by real settled cosmetic earnings.
//   • recent       — the latest settled sales (the live activity drip).
export async function cosmeticsLeaderboard({ limit = 12 } = {}) {
	const ownerRows = await sql`
		select cosmetic_id, account,
		       (array_agg(mint) filter (where mint is not null))[1] as any_mint
		from cosmetic_sales
		group by cosmetic_id, account
	`;

	const owners = new Map();        // cosmetic_id → { owners:Set, anyMint }
	const scoreByAccount = new Map(); // account → { score, count }
	for (const row of ownerRows) {
		const c = getCosmetic(row.cosmetic_id);
		if (!c) continue;
		const weight = RARITY_WEIGHT[c.rarity] || 1;
		const o = owners.get(row.cosmetic_id) || { set: new Set(), anyMint: row.any_mint || null };
		o.set.add(row.account);
		if (!o.anyMint && row.any_mint) o.anyMint = row.any_mint;
		owners.set(row.cosmetic_id, o);

		const s = scoreByAccount.get(row.account) || { score: 0, count: 0 };
		s.score += weight; s.count += 1;
		scoreByAccount.set(row.account, s);
	}

	const rarestFits = [...owners.entries()]
		.map(([cosmeticId, o]) => {
			const c = getCosmetic(cosmeticId);
			return {
				cosmeticId,
				name: c.name,
				slot: c.slot,
				rarity: c.rarity,
				owners: o.set.size,
				weight: RARITY_WEIGHT[c.rarity] || 1,
				worldMint: o.anyMint,
				previewImage: c.previewImage || null,
			};
		})
		.sort((a, b) => a.owners - b.owners || b.weight - a.weight)
		.slice(0, limit);

	const topCollectors = [...scoreByAccount.entries()]
		.map(([account, v]) => ({ account, flexScore: v.score, fits: v.count }))
		.sort((a, b) => b.flexScore - a.flexScore || b.fits - a.fits)
		.slice(0, limit);

	const creatorRows = await sql`
		select creator_wallet, count(*)::int as sales, coalesce(sum(creator_cut_atomics),0)::text as earned
		from cosmetic_sales where creator_wallet is not null
		group by creator_wallet order by sum(creator_cut_atomics) desc limit ${limit}
	`;
	const topCreators = creatorRows.map((r) => ({ wallet: r.creator_wallet, sales: r.sales, earnedUsdc: usdc(r.earned) }));

	const recentRows = await sql`
		select cosmetic_id, rarity, mint, account, price_usdc_atomics, settled_at
		from cosmetic_sales order by settled_at desc limit ${limit}
	`;
	const recent = recentRows.map((r) => ({
		cosmeticId: r.cosmetic_id,
		name: getCosmetic(r.cosmetic_id)?.name || r.cosmetic_id,
		rarity: r.rarity,
		mint: r.mint,
		buyer: r.account,
		priceUsdc: usdc(r.price_usdc_atomics),
		settledAt: r.settled_at,
	}));

	return { currency: 'USDC', rarestFits, topCollectors, topCreators, recent };
}

// ── helpers ────────────────────────────────────────────────────────────────

function fail(status, code, message) {
	return Object.assign(new Error(message), { status, code, expose: true });
}
