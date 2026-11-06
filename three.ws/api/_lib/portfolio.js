/**
 * Portfolio Command — unified, honest valuation + PnL attribution + risk for one
 * agent's custodial Solana wallet.
 *
 * This is the truth layer behind the wallet hub's Portfolio tab and
 * `/api/agents/:id/portfolio`. It fuses three real sources — never a mock, never
 * a fabricated price:
 *
 *   1. Live on-chain holdings + USD valuation   → api/_lib/balances.js (Helius DAS
 *      + Jupiter + pump.fun bonding curve; the same path the holder gate trusts).
 *   2. The sniper position ledger               → agent_sniper_positions, via the
 *      pure computeTraderMetrics in trader-stats.js (on-chain-proven realized P&L).
 *   3. The custody/spend ledger                 → agent_custody_events (category
 *      trade / snipe / x402 / withdraw), the record of every outbound action.
 *
 * Two layers, mirroring trader-stats.js:
 *   - PURE functions (buildLots, computeRisk, attributionFromLots, riskFlags) —
 *     no DB, no network, deterministic over their inputs. The tests pin these.
 *   - getPortfolio — fetches the three sources, then defers all arithmetic to the
 *     pure layer so the API and the SSE stream can never disagree.
 *
 * Honesty rules (inherited from trader-stats.js + CLAUDE.md):
 *   - SOL amounts are exact (from chain / ledger). USD degrades to null if the
 *     price feed is down — we never invent a dollar figure.
 *   - Cost basis uses FIFO lots in RAW token base units, so it needs no decimals
 *     and never drifts. A holding with no recorded acquisition (deposited /
 *     airdropped in) gets a null basis — honestly "unknown", never guessed.
 *   - Unpriceable / dead holdings are flagged `priceable:false` with usd null —
 *     they count toward concentration honestly but never fabricate a value.
 *   - Discretionary realized P&L is FIFO-derived from the recorded trade quotes
 *     (the only proceeds figure the custody row captures); the sniper track is
 *     on-chain actuals. The response labels which is which (`basis`).
 */

import { sql } from './db.js';
import { getBalances } from './balances.js';
import { solUsdPrice } from './avatar-wallet.js';
import { computeTraderMetrics, fetchTraderPositions } from './trader-stats.js';
import { solanaConnection, solanaPublicConnection } from './agent-pumpfun.js';
import { PublicKey } from '@solana/web3.js';

const LAMPORTS_PER_SOL = 1e9;
const SOL_MINT = 'So11111111111111111111111111111111111111112';

// USDC is the payment-rail asset (1:1 USD), not a coin we promote. $THREE is the
// platform coin. Both are treated as low-"tape-beta" (they don't move with the
// pump.fun memecoin tape the way a fresh launch does), so the risk model can
// honestly separate "at-risk memecoin exposure" from stable / SOL holdings.
const USDC_MINTS = new Set([
	'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // mainnet
	'4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // devnet
]);
export const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

const big = (v) => {
	try { return Number(BigInt(v)); } catch { return Number(v) || 0; }
};
const round = (n, dp = 6) => (n == null || !Number.isFinite(n) ? null : Number(n.toFixed(dp)));

function stddev(values) {
	if (values.length < 2) return 0;
	const mean = values.reduce((a, v) => a + v, 0) / values.length;
	const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance);
}

// --- Source labelling ---------------------------------------------------------
// A custody/position row maps to one attribution bucket. Sniper strategies are
// split out by id+name; everything from the discretionary HTTP path lands in
// "discretionary"; strategy-object fills carry their own bucket.

const SOURCE_LABELS = {
	sniper: 'Sniper',
	discretionary: 'Discretionary',
	strategy: 'Strategy object',
	x402: 'x402 payments',
	withdraw: 'Withdrawals',
};

/**
 * FIFO lot engine. Consumes time-ordered acquisitions + disposals per mint in
 * RAW token base units, attributing realized P&L (lamports) to the SOURCE of the
 * lot that was sold, and leaving the remaining lots (current cost basis) tagged
 * by source so unrealized P&L can be attributed too.
 *
 * @param {Array<{mint,source,strategyId?,kind:'buy'|'sell',qtyRaw:bigint,
 *   lamports:bigint,at:number}>} events  buy = acquisition (lamports = SOL cost),
 *   sell = disposal (lamports = SOL proceeds). qtyRaw is the token amount moved.
 * @returns {{ realizedBySource: Map, remainingByMint: Map }}
 *   realizedBySource: source → { realizedLamports, sells }
 *   remainingByMint:  mint → Array<{ source, strategyId, qtyRaw, costLamports }>
 */
export function buildLots(events) {
	const byMint = new Map();
	for (const e of events) {
		if (!e.mint) continue;
		if (!byMint.get(e.mint)) byMint.set(e.mint, []);
		byMint.get(e.mint).push(e);
	}

	const realizedBySource = new Map();
	const remainingByMint = new Map();
	const addRealized = (source, lamports) => {
		const r = realizedBySource.get(source) || { realizedLamports: 0n, sells: 0 };
		r.realizedLamports += lamports;
		r.sells += 1;
		realizedBySource.set(source, r);
	};

	for (const [mint, list] of byMint) {
		list.sort((a, b) => a.at - b.at);
		/** @type {Array<{source,strategyId,qtyRaw:bigint,costLamports:bigint}>} */
		const lots = [];
		for (const e of list) {
			if (e.kind === 'buy') {
				if (e.qtyRaw > 0n) lots.push({ source: e.source, strategyId: e.strategyId || null, qtyRaw: e.qtyRaw, costLamports: e.lamports });
				continue;
			}
			// sell: consume oldest lots first, attributing realized P&L to each
			// consumed lot's source (the proceeds are split across lots pro-rata
			// by the quantity each lot contributes).
			let remainingToSell = e.qtyRaw;
			const proceeds = e.lamports; // total SOL out for this disposal
			const totalSellQty = e.qtyRaw > 0n ? e.qtyRaw : 1n;
			while (remainingToSell > 0n && lots.length) {
				const lot = lots[0];
				const take = lot.qtyRaw <= remainingToSell ? lot.qtyRaw : remainingToSell;
				// proceeds attributable to this slice (pro-rata of the sell qty)
				const sliceProceeds = (proceeds * take) / totalSellQty;
				const sliceCost = (lot.costLamports * take) / (lot.qtyRaw > 0n ? lot.qtyRaw : 1n);
				addRealized(lot.source, sliceProceeds - sliceCost);
				lot.qtyRaw -= take;
				lot.costLamports -= sliceCost;
				remainingToSell -= take;
				if (lot.qtyRaw <= 0n) lots.shift();
			}
			// A sell with no matching lots (token deposited in, not bought here)
			// has an unknown basis — attribute the full proceeds as realized to the
			// disposal's own source rather than inventing a cost.
			if (remainingToSell > 0n && proceeds > 0n) {
				const sliceProceeds = (proceeds * remainingToSell) / totalSellQty;
				addRealized(e.source, sliceProceeds);
			}
		}
		if (lots.length) remainingByMint.set(mint, lots);
	}

	return { realizedBySource, remainingByMint };
}

/**
 * Portfolio risk metrics from valued holdings + the sniper metric set. Pure.
 *
 * @param {Array<{usd:number|null, mint:string|null, isNative:boolean, stable:boolean}>} holdings
 * @param {number} netWorthUsd
 * @param {object} metrics  computeTraderMetrics output (drawdown, etc.)
 * @param {number[]} closedPnlPcts  per-closed-trade realized % (for realized vol)
 */
export function computeRisk(holdings, netWorthUsd, metrics, closedPnlPcts) {
	const valued = holdings.filter((h) => Number.isFinite(h.usd) && h.usd > 0);
	const totalValued = valued.reduce((s, h) => s + h.usd, 0) || 0;

	// Concentration over everything with a real value (Herfindahl-Hirschman index
	// of portfolio weights, 0..1; 1 = a single position).
	let hhi = 0;
	let topShare = 0;
	let topHolding = null;
	for (const h of valued) {
		const w = totalValued > 0 ? h.usd / totalValued : 0;
		hhi += w * w;
		if (w > topShare) { topShare = w; topHolding = h; }
	}

	// At-risk exposure: share of net worth in volatile memecoins (not SOL, not a
	// stablecoin). This is the honest "tape beta" proxy — the slice that moves
	// with the broad pump.fun tape, vs SOL/USDC that don't.
	const riskAssets = valued.filter((h) => !h.isNative && !h.stable);
	const volatileUsd = riskAssets.reduce((s, h) => s + h.usd, 0);
	const exposurePct = netWorthUsd > 0 ? (volatileUsd / netWorthUsd) * 100 : 0;
	const tapeBeta = netWorthUsd > 0 ? volatileUsd / netWorthUsd : 0;

	// Reserve ("dry powder"): SOL + stablecoins — the slice that carries no tape
	// risk and is ready to deploy. A wallet that is all reserve (the common fresh
	// state) has NO concentration risk; concentration is a property of the volatile
	// sleeve, not of holding the base asset.
	const reserveUsd = totalValued - volatileUsd;
	const reservePct = netWorthUsd > 0 ? (reserveUsd / netWorthUsd) * 100 : 0;

	// Concentration of the *risk* sleeve: the single largest volatile position as a
	// share of net worth. This is what "one position could rug me" actually means.
	let topRisk = null;
	let topRiskShare = 0;
	for (const h of riskAssets) {
		const w = totalValued > 0 ? h.usd / totalValued : 0;
		if (w > topRiskShare) { topRiskShare = w; topRisk = h; }
	}
	const topIsReserve = !!topHolding && (topHolding.isNative || topHolding.stable);

	return {
		net_worth_usd: round(netWorthUsd, 2),
		concentration_hhi: round(hhi, 4),
		top_position_pct: round(topShare * 100, 2),
		top_position_mint: topHolding?.mint || (topHolding?.isNative ? 'SOL' : null),
		top_position_is_reserve: topIsReserve,
		top_risk_position_pct: round(topRiskShare * 100, 2),
		top_risk_position_mint: topRisk?.mint || null,
		reserve_usd: round(reserveUsd, 2),
		reserve_pct: round(reservePct, 2),
		risk_assets_count: riskAssets.length,
		volatile_exposure_usd: round(volatileUsd, 2),
		exposure_pct: round(exposurePct, 2),
		tape_beta: round(tapeBeta, 3),
		max_drawdown_pct: metrics?.max_drawdown_pct ?? null,
		max_drawdown_sol: metrics?.max_drawdown_sol ?? null,
		realized_volatility_pct: round(stddev(closedPnlPcts), 2),
		holdings_count: holdings.length,
		valued_count: valued.length,
		unpriceable_count: holdings.filter((h) => !Number.isFinite(h.usd) && !h.isNative).length,
	};
}

/**
 * Plain-language risk flags from the metric set + the top holding's liquidity.
 * Each flag is { level: 'info'|'warn'|'danger', text }. Pure + deterministic.
 */
export function riskFlags(risk, topHoldingPriceable) {
	const flags = [];
	// Concentration is a property of the *risk* sleeve, not of holding the base
	// asset. A wallet that is all SOL/stable is dry powder, not a concentrated bet —
	// so key the flag off the largest volatile position when we know it, and never
	// alarm when the dominant holding is reserve (SOL / stablecoin).
	const top = risk.top_risk_position_pct != null ? risk.top_risk_position_pct : risk.top_position_pct;
	if (top != null && top >= 60) {
		const liq = topHoldingPriceable === false ? ' illiquid' : '';
		flags.push({
			level: top >= 80 ? 'danger' : 'warn',
			text: `${top}% of valued holdings sit in one${liq} position — concentration risk.`,
		});
	}
	if (risk.exposure_pct != null && risk.exposure_pct >= 75) {
		flags.push({
			level: risk.exposure_pct >= 90 ? 'danger' : 'warn',
			text: `${risk.exposure_pct}% of net worth is in volatile memecoins — high tape exposure.`,
		});
	}
	if (risk.max_drawdown_pct != null && risk.max_drawdown_pct >= 35) {
		flags.push({
			level: risk.max_drawdown_pct >= 60 ? 'danger' : 'warn',
			text: `Realized drawdown has reached ${risk.max_drawdown_pct}% from peak.`,
		});
	}
	if (risk.unpriceable_count > 0) {
		flags.push({
			level: 'info',
			text: `${risk.unpriceable_count} holding${risk.unpriceable_count === 1 ? '' : 's'} could not be priced — shown as unvalued, never guessed.`,
		});
	}
	// Reserve-heavy wallets (the common fresh / between-trades state) carry no tape
	// risk. Say so positively instead of leaving a scary silence or a false alarm.
	if (!flags.length && risk.reserve_pct != null && risk.reserve_pct >= 90) {
		flags.push({
			level: 'info',
			text: `${risk.reserve_pct}% of net worth is held in SOL / stable reserve — dry powder ready to deploy, minimal market risk.`,
		});
	}
	if (!flags.length && risk.net_worth_usd != null) {
		flags.push({ level: 'info', text: 'No elevated concentration, exposure, or drawdown risk detected.' });
	}
	return flags;
}

// --- Live holdings valuation --------------------------------------------------
// mainnet: the rich Helius-DAS path (metadata + prices, cached). devnet: a direct
// RPC enumeration (devnet tokens have no market, so SPL is honestly unpriceable;
// only SOL is valued). Both normalize to the same holding shape.

function normalizeHolding({ mint, symbol, name, amount, decimals, price, usd, logo, isNative }) {
	const priceable = Number.isFinite(usd) && usd != null;
	const stable = mint ? USDC_MINTS.has(mint) : false;
	return {
		mint: isNative ? null : mint,
		symbol: symbol || (isNative ? 'SOL' : (mint ? mint.slice(0, 6) : '?')),
		name: name || symbol || (isNative ? 'Solana' : null),
		amount: amount ?? null,
		decimals: decimals ?? (isNative ? 9 : null),
		price: Number.isFinite(price) ? price : null,
		usd: priceable ? Number(usd) : null,
		logo: logo || null,
		isNative: !!isNative,
		stable,
		is_three: mint === THREE_MINT,
		priceable,
	};
}

async function valuateMainnet(address) {
	const bal = await getBalances({ chain: 'solana', address });
	const holdings = [];
	holdings.push(normalizeHolding({
		isNative: true, symbol: 'SOL', name: 'Solana',
		amount: bal?.native?.amount ?? 0, decimals: 9,
		price: bal?.native?.price ?? null, usd: bal?.native?.usd ?? null,
	}));
	for (const t of bal?.tokens || []) {
		holdings.push(normalizeHolding({
			mint: t.mint, symbol: t.symbol, name: t.name, amount: t.amount,
			decimals: t.decimals, price: t.price, usd: t.usd, logo: t.logo,
		}));
	}
	return { holdings, solUsd: bal?.native?.price ?? null };
}

async function valuateDevnet(address) {
	// Devnet has no price oracle for SPL; value SOL only, mark SPL unpriceable.
	const conn = solanaConnection('devnet');
	const fallback = solanaPublicConnection('devnet');
	const owner = new PublicKey(address);
	const readBalance = async (c) => c.getBalance(owner, 'confirmed');
	let lamports = 0;
	try { lamports = await readBalance(conn); }
	catch { try { lamports = await readBalance(fallback); } catch { lamports = 0; } }

	let solUsd = null;
	try { solUsd = await solUsdPrice(); } catch { solUsd = null; }
	const sol = lamports / LAMPORTS_PER_SOL;
	const holdings = [normalizeHolding({
		isNative: true, symbol: 'SOL', name: 'Solana', amount: sol, decimals: 9,
		price: solUsd, usd: solUsd != null ? sol * solUsd : null,
	})];

	try {
		const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = await import('@solana/spl-token');
		for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
			let resp;
			try { resp = await conn.getParsedTokenAccountsByOwner(owner, { programId }); } catch { continue; }
			for (const { account } of resp.value) {
				const info = account.data?.parsed?.info;
				const amt = info?.tokenAmount;
				if (!info || !amt || !(Number(amt.uiAmount) > 0)) continue;
				holdings.push(normalizeHolding({
					mint: info.mint, amount: Number(amt.uiAmount), decimals: amt.decimals,
					price: null, usd: null, // devnet SPL: honestly unpriceable
				}));
			}
		}
	} catch { /* SPL enumeration best-effort */ }

	return { holdings, solUsd };
}

/** Live holdings + SOL price for a wallet on a network. */
export async function valuateHoldings({ network, address }) {
	if (!address) return { holdings: [], solUsd: null };
	return network === 'devnet' ? valuateDevnet(address) : valuateMainnet(address);
}

// --- Ledger → FIFO events -----------------------------------------------------

/** Sniper positions → buy/sell FIFO events tagged by strategy. */
function sniperEvents(positions) {
	const events = [];
	for (const p of positions) {
		if (!p.mint) continue;
		const source = `sniper:${p.strategy_id || 'default'}`;
		const opened = new Date(p.opened_at).getTime();
		const qty = p.base_amount != null ? BigInt(p.base_amount) : 0n;
		if (qty > 0n) {
			events.push({
				mint: p.mint, source: 'sniper', strategyId: p.strategy_id || null, kind: 'buy',
				qtyRaw: qty, lamports: p.entry_quote_lamports != null ? BigInt(p.entry_quote_lamports) : 0n,
				at: opened,
			});
		}
		if (p.status === 'closed' && qty > 0n) {
			events.push({
				mint: p.mint, source: 'sniper', strategyId: p.strategy_id || null, kind: 'sell',
				qtyRaw: qty, lamports: p.exit_quote_lamports != null ? BigInt(p.exit_quote_lamports) : 0n,
				at: new Date(p.closed_at || p.opened_at).getTime(),
			});
		}
	}
	return events;
}

/** Custody 'trade' events → buy/sell FIFO events (discretionary + strategy). */
function custodyTradeEvents(rows) {
	const events = [];
	for (const e of rows) {
		const m = e.meta && typeof e.meta === 'object' ? e.meta : {};
		const mint = m.mint || (e.asset && e.asset !== 'SOL' ? e.asset : null);
		if (!mint) continue;
		const side = m.side || (e.asset === 'SOL' ? 'buy' : 'sell');
		const source = m.source === 'strategy' ? 'strategy' : 'discretionary';
		const at = new Date(e.created_at).getTime();
		if (side === 'buy') {
			// buy: SOL spent = amount_lamports; tokens received ≈ meta.expected_out (raw)
			events.push({
				mint, source, strategyId: m.strategy_id || null, kind: 'buy',
				qtyRaw: m.expected_out ? safeBig(m.expected_out) : 0n,
				lamports: e.amount_lamports != null ? BigInt(e.amount_lamports) : 0n,
				at,
			});
		} else {
			// sell: tokens out = amount_raw; SOL proceeds ≈ meta.expected_out (raw lamports)
			events.push({
				mint, source, strategyId: m.strategy_id || null, kind: 'sell',
				qtyRaw: e.amount_raw != null ? safeBig(e.amount_raw) : 0n,
				lamports: m.expected_out ? safeBig(m.expected_out) : 0n,
				at,
			});
		}
	}
	return events;
}

function safeBig(v) {
	try { return BigInt(String(v).split('.')[0]); } catch { return 0n; }
}

// --- Main assembly ------------------------------------------------------------

let _solCache = { usd: null, at: 0 };
async function cachedSolUsd(fallback) {
	if (fallback != null) { _solCache = { usd: fallback, at: Date.now() }; return fallback; }
	if (_solCache.usd != null && Date.now() - _solCache.at < 60_000) return _solCache.usd;
	try { const usd = await solUsdPrice(); _solCache = { usd, at: Date.now() }; return usd; }
	catch { return _solCache.usd; }
}

/**
 * The full portfolio for one agent wallet on one network: live valuation,
 * holdings with FIFO cost basis + unrealized P&L, PnL attribution by source,
 * risk metrics, and plain-language risk flags. Returns null if the agent doesn't
 * exist; an honest empty-wallet shape if it has no holdings/history.
 *
 * @param {{ agentId:string, network?:string, now?:number }} opts
 */
export async function getPortfolio({ agentId, network = 'mainnet', now = Date.now() }) {
	const net = network === 'devnet' ? 'devnet' : 'mainnet';

	const [idRows, positions, custodyRows] = await Promise.all([
		sql`select id, name, profile_image_url, avatar_url, meta from agent_identities where id = ${agentId} and deleted_at is null limit 1`,
		fetchTraderPositions({ agentId, network: net, window: 'all', now }).catch(() => []),
		sql`
			select id, event_type, category, asset, amount_lamports, amount_raw, usd, status, created_at, meta
			from agent_custody_events
			where agent_id = ${agentId} and network = ${net}
			order by id asc
		`.catch(() => []),
	]);
	const identity = idRows[0];
	if (!identity) return null;
	const address = identity.meta?.solana_address || null;

	const { holdings, solUsd: valSolUsd } = await valuateHoldings({ network: net, address });
	const solUsd = await cachedSolUsd(valSolUsd);

	const metrics = computeTraderMetrics(positions, { solUsd });
	const closedPnlPcts = positions
		.filter((p) => p.status === 'closed' && p.realized_pnl_pct != null && Number.isFinite(Number(p.realized_pnl_pct)))
		.map((p) => Number(p.realized_pnl_pct));

	// FIFO over the unified trade ledger (sniper + custody trades).
	const tradeRows = custodyRows.filter((e) => e.category === 'trade' && e.event_type === 'spend' && e.status !== 'failed');
	const events = [...sniperEvents(positions), ...custodyTradeEvents(tradeRows)];
	const { realizedBySource, remainingByMint } = buildLots(events);

	// Per-mint live price in lamports-per-raw-unit (for unrealized on held lots).
	const priceByMint = new Map();
	for (const h of holdings) {
		if (!h.mint || !h.priceable || h.price == null || solUsd == null || h.decimals == null) continue;
		// usd/uiToken → SOL/uiToken → lamports/rawUnit
		const lamportsPerRaw = (h.price / solUsd) * LAMPORTS_PER_SOL / Math.pow(10, h.decimals);
		priceByMint.set(h.mint, lamportsPerRaw);
	}

	// Cost basis per current holding + unrealized P&L by source.
	const unrealizedBySource = new Map();
	const basisByMint = new Map();
	for (const [mint, lots] of remainingByMint) {
		const lamportsPerRaw = priceByMint.get(mint);
		let costLamports = 0n;
		let liveLamports = 0n;
		let priced = lamportsPerRaw != null;
		for (const lot of lots) {
			costLamports += lot.costLamports;
			const lotLive = priced ? BigInt(Math.round(Number(lot.qtyRaw) * lamportsPerRaw)) : 0n;
			liveLamports += lotLive;
			if (priced) {
				const u = unrealizedBySource.get(lot.source) || 0n;
				unrealizedBySource.set(lot.source, u + (lotLive - lot.costLamports));
			}
		}
		basisByMint.set(mint, {
			cost_sol: round(big(costLamports.toString()) / LAMPORTS_PER_SOL),
			live_sol: priced ? round(big(liveLamports.toString()) / LAMPORTS_PER_SOL) : null,
			unrealized_sol: priced ? round((big(liveLamports.toString()) - big(costLamports.toString())) / LAMPORTS_PER_SOL) : null,
		});
	}

	// Attach cost basis to each holding.
	const holdingsOut = holdings.map((h) => {
		const basis = h.mint ? basisByMint.get(h.mint) : null;
		const unrealizedPct = basis && basis.cost_sol > 0 && basis.unrealized_sol != null
			? round((basis.unrealized_sol / basis.cost_sol) * 100, 2)
			: null;
		return {
			...h,
			usd_value: h.usd ?? null,
			cost_basis_sol: basis?.cost_sol ?? null,
			unrealized_sol: basis?.unrealized_sol ?? null,
			unrealized_pct: unrealizedPct,
			liquidity_warning: !h.isNative && !h.priceable ? 'unpriceable' : null,
		};
	}).sort((a, b) => (b.usd_value ?? -1) - (a.usd_value ?? -1));

	// Net worth.
	const netWorthSol = holdings.reduce((s, h) => {
		if (h.isNative) return s + (h.amount || 0);
		if (h.priceable && solUsd) return s + (h.usd / solUsd);
		return s;
	}, 0);
	const netWorthUsd = holdings.reduce((s, h) => s + (Number.isFinite(h.usd) ? h.usd : 0), 0);

	// Attribution buckets.
	const attribution = buildAttribution({
		realizedBySource, unrealizedBySource, custodyRows, solUsd,
	});

	const risk = computeRisk(holdingsOut, netWorthUsd, metrics, closedPnlPcts);
	// The concentration flag now keys off the largest volatile position, so its
	// illiquid detail should track that holding when one drives the flag.
	const flagMint = risk.top_risk_position_mint || risk.top_position_mint;
	const top = holdingsOut.find((h) => (h.mint || (h.isNative ? 'SOL' : null)) === flagMint);
	const flags = riskFlags(risk, top ? top.priceable : null);

	return {
		agent: {
			id: identity.id,
			name: identity.name,
			image: identity.profile_image_url || identity.avatar_url || null,
			wallet: address,
		},
		network: net,
		sol_usd: solUsd,
		t: now,
		net_worth: {
			sol: round(netWorthSol),
			usd: round(netWorthUsd, 2),
			realized_pnl_sol: metrics.realized_pnl_sol,
			realized_pnl_usd: metrics.realized_pnl_usd,
			unrealized_pnl_sol: round(sumUnrealizedSol(unrealizedBySource)),
		},
		holdings: holdingsOut,
		attribution,
		risk,
		risk_flags: flags,
		metrics,
		basis_note: 'Sniper P&L is on-chain actuals; discretionary P&L is FIFO-derived from recorded trade quotes.',
	};
}

function sumUnrealizedSol(unrealizedBySource) {
	let total = 0n;
	for (const v of unrealizedBySource.values()) total += v;
	return big(total.toString()) / LAMPORTS_PER_SOL;
}

/**
 * Assemble the attribution table. Realized + unrealized from the FIFO engine,
 * plus pure-outflow buckets (x402 payments, withdrawals) summed from the custody
 * ledger. Pure given its inputs (exported for tests).
 */
export function buildAttribution({ realizedBySource, unrealizedBySource, custodyRows, solUsd }) {
	const usd = (sol) => (solUsd != null && sol != null ? round(sol * solUsd, 2) : null);
	const buckets = new Map();
	const bucket = (key, label) => {
		if (!buckets.get(key)) buckets.set(key, { source: key, label, realized_sol: 0, unrealized_sol: 0, sells: 0, spent_sol: 0 });
		return buckets.get(key);
	};

	for (const [source, r] of realizedBySource) {
		const key = source.startsWith('sniper') ? 'sniper' : source;
		const b = bucket(key, SOURCE_LABELS[key] || key);
		b.realized_sol += big(r.realizedLamports.toString()) / LAMPORTS_PER_SOL;
		b.sells += r.sells;
	}
	for (const [source, lamports] of unrealizedBySource) {
		const key = source.startsWith('sniper') ? 'sniper' : source;
		const b = bucket(key, SOURCE_LABELS[key] || key);
		b.unrealized_sol += big(lamports.toString()) / LAMPORTS_PER_SOL;
	}

	// Pure-outflow categories (no round-trip P&L): x402 + withdraw.
	const outflow = { x402: 0, withdraw: 0 };
	for (const e of custodyRows) {
		if (e.status === 'failed') continue;
		if (e.category === 'x402') outflow.x402 += e.amount_lamports != null ? big(e.amount_lamports) / LAMPORTS_PER_SOL : 0;
		else if (e.category === 'withdraw') outflow.withdraw += e.amount_lamports != null ? big(e.amount_lamports) / LAMPORTS_PER_SOL : 0;
	}
	if (outflow.x402 > 0) bucket('x402', SOURCE_LABELS.x402).spent_sol = outflow.x402;
	if (outflow.withdraw > 0) bucket('withdraw', SOURCE_LABELS.withdraw).spent_sol = outflow.withdraw;

	return [...buckets.values()]
		.map((b) => ({
			source: b.source,
			label: b.label,
			realized_sol: round(b.realized_sol),
			realized_usd: usd(b.realized_sol),
			unrealized_sol: round(b.unrealized_sol),
			unrealized_usd: usd(b.unrealized_sol),
			total_sol: round(b.realized_sol + b.unrealized_sol),
			spent_sol: b.spent_sol > 0 ? round(b.spent_sol) : null,
			spent_usd: b.spent_sol > 0 ? usd(b.spent_sol) : null,
			sells: b.sells,
			is_outflow: b.source === 'x402' || b.source === 'withdraw',
		}))
		.sort((a, b) => (b.total_sol ?? 0) - (a.total_sol ?? 0));
}
