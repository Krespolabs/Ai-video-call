// agent-mm — the market-maker decision engine.
//
// For one policy this sweep: re-quote the coin (curve pre-grad, AMM post-grad),
// snapshot inventory, run the graduation transition once, then pick AT MOST ONE
// bounded, non-reflexive action — seed → defend → recycle → rebalance — and fire
// it through executeAgentTrade (the same firewall + spend-guard + custody path a
// manual trade uses). The engine adds NO new way to move funds; it only decides
// WHEN and HOW MUCH, inside the policy's published limits.
//
// Anti-manipulation is enforced HERE, in code, every action:
//   • interval gate — no action, and NEVER a side flip, inside min_action_interval
//     (× a multiple for flips). The MM physically cannot wash-trade / round-trip.
//   • volume cap — a single action can't exceed max_volume_pct of LIVE volume; if
//     volume can't be measured, it won't act above a tiny conservative slice (it
//     never paints a no-volume tape).
//   • bounded sizing — defend buys are capped by the dip budget, daily budget,
//     wallet SOL, and the inventory ceiling; recycle sells by recycle_pct and the
//     volume cap. Nothing is reflexive; it never chases.

import { executeAgentTrade, parseTradeInput } from '../../api/agents/agent-trade.js';
import { getTradeLimits } from '../../api/_lib/agent-trade-guards.js';
import { GUARDS, SOL } from '../../api/_lib/market-maker.js';
import { quoteMarket, getHolding, getSolBalanceLamports, getWindowVolumeLamports } from './market.js';
import { provideLp } from './graduation.js';
import {
	markEvaluated, recordActionAndAdvance, markSeedDone, markGraduation,
	getDeployedLamports24h, getDefenseLamports24h,
} from './store.js';
import { log } from './log.js';

const MIN_TRADE_LAMPORTS = BigInt(GUARDS.MIN_TRADE_LAMPORTS);
const WALLET_HEADROOM_LAMPORTS = 5_000_000n; // leave 0.005 SOL for fees

function lamports(sol) { return BigInt(Math.max(0, Math.round(sol * SOL))); }
function bigMin(...xs) { return xs.reduce((a, b) => (a < b ? a : b)); }

/**
 * Evaluate + (maybe) act on one policy. `agent` is { id, userId, meta }. Returns
 * a short outcome tag for logging. Never throws past the per-policy try in the
 * sweep — a single policy's failure can't abort the others.
 */
export async function runPolicy({ cfg, policy, agent }) {
	const network = policy.network;
	const mint = policy.mint;
	const owner = agent.meta?.solana_address || null;
	// LIVE only when BOTH the worker and the policy are live; otherwise the full
	// logic runs against real quotes but never signs or spends (clearly labeled).
	const simulate = !(cfg.mode === 'live' && policy.mode === 'live');
	const tag = { policy: policy.id, mint, mode: simulate ? 'simulate' : 'live' };

	// Read-only render collector: the helpers below mutate it as they size + fill,
	// and runPolicy returns it merged with the outcome tag. NONE of these reads
	// touch the decision/guard logic — they only describe what was decided so the
	// arena can draw the floor line and route emotes off the same numbers.
	const render = {
		mint,
		simulate,
		floorSol: Number(policy.floor_price_sol) || 0,
		priceSol: null,
		sizeSol: 0,
		sideBuy: null,
		signature: null,
	};
	const out = (t) => ({ tag: t, ...render });

	if (!owner || !agent.meta?.encrypted_solana_secret) {
		await markEvaluated(policy.id, { error: 'no_wallet' });
		return out('no_wallet');
	}

	const market = await quoteMarket({ network, mint });
	if (!market || !(market.price_sol > 0)) {
		await markEvaluated(policy.id, { error: 'no_price' });
		return out('no_price');
	}
	const price = market.price_sol; // SOL per whole token
	render.priceSol = price;

	const holding = await getHolding({ network, mint, owner });
	const inventoryWhole = holding?.whole ?? 0;
	const inventoryRaw = holding?.raw ?? 0n;
	const inventoryValueLamports = lamports(inventoryWhole * price);
	await markEvaluated(policy.id, { priceSol: price, inventoryTokens: inventoryWhole, inventoryValueLamports, error: null });

	const solBal = (await getSolBalanceLamports({ network, owner })) ?? 0n;

	// ── graduation transition (once) ──────────────────────────────────────────
	if (market.graduated && !policy.graduation_done_at) {
		return out(await runGraduation({ cfg, policy, agent, price, inventoryWhole, inventoryRaw, solBal, simulate, tag, render }));
	}

	// ── decide intent (priority: seed → defend → recycle → rebalance) ─────────
	const slippageBps = Math.round(Number(policy.slippage_bps) || 500);
	const floorPrice = Number(policy.floor_price_sol) || 0;
	const floorBand = Number(policy.floor_band_pct) || 0;
	const takeBand = Number(policy.take_profit_band_pct) || 0;
	const recyclePct = Number(policy.recycle_pct) || 0;
	const maxInv = Number(policy.max_inventory_tokens) || 0;

	const floorTrigger = floorPrice * (1 - floorBand / 100);
	const takeTrigger = floorPrice * (1 + takeBand / 100);

	let intent = null; // { kind, side, lamports?|tokens?, reason }
	if (Number(policy.seed_lamports) > 0 && !policy.seed_done_at) {
		intent = { kind: 'seed', side: 'buy', lamports: BigInt(policy.seed_lamports), reason: 'seed_initial_liquidity' };
	} else if (floorPrice > 0 && price <= floorTrigger) {
		// Defend: buy a measured slice. The per-action slice is a quarter of the dip
		// budget (defend in tranches, never the whole budget at once).
		const dipBudget = BigInt(policy.dip_buy_budget_lamports);
		const slice = dipBudget > 0n ? dipBudget / 4n : lamports(0.02);
		intent = { kind: 'defend_buy', side: 'buy', lamports: slice, reason: `price ${price.toExponential(3)} ≤ floor band ${floorTrigger.toExponential(3)}` };
	} else if (takeBand >= 0 && price >= takeTrigger && inventoryWhole > 0) {
		const tokens = inventoryWhole * (recyclePct / 100);
		if (tokens > 0) intent = { kind: 'recycle_sell', side: 'sell', tokens, reason: `price ${price.toExponential(3)} ≥ take band ${takeTrigger.toExponential(3)}` };
	} else if (maxInv > 0 && inventoryWhole > maxInv) {
		const tokens = inventoryWhole - maxInv;
		intent = { kind: 'rebalance_trim', side: 'sell', tokens, reason: `inventory ${inventoryWhole.toFixed(2)} > ceiling ${maxInv.toFixed(2)}` };
	}

	if (!intent) return out('in_band'); // nothing to do — markEvaluated already recorded the heartbeat

	// ── anti-manipulation: interval + side-flip gate ──────────────────────────
	const interval = Number(policy.min_action_interval_seconds) || 60;
	const lastAt = policy.last_action_at ? new Date(policy.last_action_at).getTime() : 0;
	const sinceSec = lastAt ? (Date.now() - lastAt) / 1000 : Infinity;
	if (sinceSec < interval) {
		return out(await skip({ policy, intent, price, status: 'skipped', detail: `interval guard — ${Math.ceil(interval - sinceSec)}s until next action allowed`, reason: 'interval_guard' }));
	}
	if (policy.last_action_side && policy.last_action_side !== intent.side && sinceSec < interval * GUARDS.SIDE_FLIP_INTERVAL_MULTIPLE) {
		return out(await skip({ policy, intent, price, status: 'blocked', detail: `anti-wash guard — a ${intent.side} cannot follow a ${policy.last_action_side} within ${interval * GUARDS.SIDE_FLIP_INTERVAL_MULTIPLE}s`, reason: 'anti_wash_guard' }));
	}

	// ── anti-manipulation: live-volume cap (lamports per action) ──────────────
	const windowVol = await getWindowVolumeLamports({ mint, windowSeconds: cfg.volumeWindowSeconds });
	const volumeCapLamports = windowVol == null
		? BigInt(GUARDS.NO_VOLUME_FALLBACK_LAMPORTS)
		: (windowVol * BigInt(Math.round(Number(policy.max_volume_pct) * 1000))) / 100000n;
	const volumeUnmeasured = windowVol == null;

	// ── size + execute ────────────────────────────────────────────────────────
	if (intent.side === 'buy') {
		return out(await doBuy({ cfg, policy, agent, intent, price, inventoryWhole, maxInv, solBal, volumeCapLamports, volumeUnmeasured, slippageBps, simulate, tag, render }));
	}
	return out(await doSell({ cfg, policy, agent, intent, price, inventoryWhole, inventoryRaw, volumeCapLamports, volumeUnmeasured, slippageBps, simulate, tag, render }));
}

// ── buys (seed + defend) ──────────────────────────────────────────────────────
async function doBuy({ cfg, policy, agent, intent, price, inventoryWhole, maxInv, solBal, volumeCapLamports, volumeUnmeasured, slippageBps, simulate, tag, render }) {
	let size = intent.lamports;

	// Daily budget (all buys) and dip budget (defense only), measured rolling-24h.
	const dailyBudget = BigInt(policy.daily_budget_lamports);
	if (dailyBudget > 0n) {
		const deployed = await getDeployedLamports24h(policy.id);
		const remaining = dailyBudget > deployed ? dailyBudget - deployed : 0n;
		if (remaining <= 0n) return skip({ policy, intent, price, status: 'skipped', detail: 'daily budget exhausted (24h)', reason: 'daily_budget' });
		size = bigMin(size, remaining);
	}
	if (intent.kind === 'defend_buy') {
		const dipBudget = BigInt(policy.dip_buy_budget_lamports);
		if (dipBudget > 0n) {
			const spent = await getDefenseLamports24h(policy.id);
			const remaining = dipBudget > spent ? dipBudget - spent : 0n;
			if (remaining <= 0n) return skip({ policy, intent, price, status: 'skipped', detail: 'dip-buy budget exhausted (24h)', reason: 'dip_budget' });
			size = bigMin(size, remaining);
		}
	}

	// Inventory ceiling — never buy past it.
	if (maxInv > 0) {
		const headroomTokens = maxInv - inventoryWhole;
		if (headroomTokens <= 0) return skip({ policy, intent, price, status: 'skipped', detail: 'at inventory ceiling', reason: 'at_max_inventory' });
		size = bigMin(size, lamports(headroomTokens * price));
	}

	// Volume cap — the maker can't be more than max_volume_pct of live volume.
	size = bigMin(size, volumeCapLamports);

	// Wallet SOL headroom (leave fees).
	const spendable = solBal > WALLET_HEADROOM_LAMPORTS ? solBal - WALLET_HEADROOM_LAMPORTS : 0n;
	if (spendable <= 0n) return skip({ policy, intent, price, status: 'skipped', detail: 'wallet has no spendable SOL', reason: 'insufficient_sol' });
	size = bigMin(size, spendable);

	if (size < MIN_TRADE_LAMPORTS) {
		const reason = volumeUnmeasured ? 'volume_unmeasured' : 'below_min';
		return skip({ policy, intent, price, status: 'skipped', detail: volumeUnmeasured ? 'live volume unmeasured — holding to the conservative no-volume slice' : 'sized below the dust floor', reason });
	}

	const body = { mint: policy.mint, network: policy.network, side: 'buy', amount: Number(size) / SOL, slippageBps };
	return execute({ cfg, policy, agent, intent, price, body, sizeLamports: size, simulate, tag, render });
}

// ── sells (recycle + rebalance) ──────────────────────────────────────────────
async function doSell({ cfg, policy, agent, intent, price, inventoryWhole, inventoryRaw, volumeCapLamports, volumeUnmeasured, slippageBps, simulate, tag, render }) {
	let tokens = Math.min(intent.tokens, inventoryWhole);
	if (!(tokens > 0)) return skip({ policy, intent, price, status: 'skipped', detail: 'no inventory to sell', reason: 'no_inventory' });

	// Volume cap → max tokens this action.
	const capTokens = Number(volumeCapLamports) / SOL / price;
	if (capTokens < tokens) tokens = capTokens;

	const sizeLamports = lamports(tokens * price);
	if (sizeLamports < MIN_TRADE_LAMPORTS) {
		const reason = volumeUnmeasured ? 'volume_unmeasured' : 'below_min';
		return skip({ policy, intent, price, status: 'skipped', detail: volumeUnmeasured ? 'live volume unmeasured — holding to the conservative no-volume slice' : 'sized below the dust floor', reason });
	}

	// Sell whole tokens (executeAgentTrade resolves the base units + venue).
	const body = { mint: policy.mint, network: policy.network, side: 'sell', amount: tokens, slippageBps };
	return execute({ cfg, policy, agent, intent, price, body, sizeLamports, tokens, simulate, tag, render });
}

// ── execute through the shared, audited trade path ────────────────────────────
async function execute({ cfg, policy, agent, intent, price, body, sizeLamports, tokens = null, simulate, tag, render }) {
	const tradeLimits = getTradeLimits(agent.meta);
	let input;
	try {
		input = parseTradeInput(body, tradeLimits);
	} catch (e) {
		return skip({ policy, intent, price, status: 'failed', detail: `invalid trade: ${e?.code || e?.message || 'error'}`, reason: 'invalid_trade' });
	}
	// Idempotency bucket = the interval window, so two overlapping sweeps can't
	// double-fire the same action; a fresh window allows the next one.
	const bucket = Math.floor(Date.now() / (Math.max(30, Number(policy.min_action_interval_seconds) || 60) * 1000));
	input.idempotencyKey = `mm:${policy.id}:${intent.kind}:${bucket}`;
	input.simulate = simulate;

	let result;
	try {
		result = await executeAgentTrade({
			id: agent.id, userId: agent.userId, meta: agent.meta, input,
			source: `mm:${intent.kind}`, sourceMeta: { policy_id: policy.id, mint: policy.mint },
		});
	} catch (e) {
		return skip({ policy, intent, price, status: 'failed', detail: `execute crashed: ${e?.message?.slice(0, 120) || 'error'}`, reason: 'execute_error' });
	}

	if (!result.ok) {
		const status = result.code === 'firewall_blocked' ? 'blocked' : 'failed';
		await recordActionAndAdvance({
			policy,
			action: { kind: intent.kind, side: body.side, triggerReason: intent.reason, priceSol: price, status, detail: `${result.code}: ${result.message || ''}`.slice(0, 280), meta: { code: result.code } },
		});
		log.warn('mm action blocked', { ...tag, kind: intent.kind, code: result.code });
		return result.code || 'failed';
	}

	const d = result.data || {};
	const isSim = d.simulated === true || simulate;
	const status = isSim ? 'simulated' : 'executed';
	const solMoved = body.side === 'buy'
		? (isSim ? Number(sizeLamports) : Math.round((d.sol_spent ?? 0) * SOL))
		: (isSim ? Number(sizeLamports) : Math.round((d.sol_received ?? 0) * SOL));
	const tokenAmount = body.side === 'buy'
		? (d.tokens_received != null ? Number(d.tokens_received) / 1e6 : null)
		: (tokens ?? null);

	await recordActionAndAdvance({
		policy,
		action: {
			kind: intent.kind, side: body.side, triggerReason: intent.reason, priceSol: price,
			solLamports: solMoved, tokenAmount, priceImpactPct: d.price_impact_pct ?? null,
			venue: d.venue || null, signature: d.signature && d.signature !== 'SIMULATED' ? d.signature : null,
			custodyEventId: d.custody_event_id ?? null, status,
			detail: isSim ? 'paper fill (simulate)' : null, meta: { mode: isSim ? 'simulate' : 'live' },
		},
		effect: { solLamports: solMoved },
	});
	if (intent.kind === 'seed') await markSeedDone(policy.id);
	// Render enrichment (read-only): the actual SOL moved + side + on-chain sig so
	// the arena renders the real fill, not the pre-size estimate.
	if (render) {
		render.sizeSol = Math.max(0, solMoved) / SOL;
		render.sideBuy = body.side === 'buy';
		render.signature = d.signature && d.signature !== 'SIMULATED' ? d.signature : null;
	}
	log.trade('mm action', { ...tag, kind: intent.kind, side: body.side, status, sol: solMoved / SOL, sig: d.signature || null, impact: d.price_impact_pct ?? null });
	return intent.kind;
}

// ── graduation transition (provide_lp | distribute | hold) ────────────────────
async function runGraduation({ cfg, policy, agent, price, inventoryWhole, inventoryRaw, solBal, simulate, tag, render }) {
	const action = policy.graduation_action || 'hold';
	const slippagePct = (Number(policy.slippage_bps) || 500) / 100;
	log.info('graduation transition', { ...tag, action });

	if (action === 'hold') {
		await recordActionAndAdvance({ policy, action: { kind: 'graduation_hold', triggerReason: 'graduated', priceSol: price, status: 'executed', detail: 'holding inventory; continuing two-sided on the AMM' } });
		await markGraduation(policy.id, { status: 'done', terminal: false });
		return 'graduation_hold';
	}

	if (action === 'provide_lp') {
		if (!(inventoryWhole > 0)) {
			await recordActionAndAdvance({ policy, action: { kind: 'graduation_lp', triggerReason: 'graduated', priceSol: price, status: 'skipped', detail: 'no inventory to provide as LP' } });
			await markGraduation(policy.id, { status: 'done', terminal: true });
			return 'graduation_lp_empty';
		}
		try {
			const lp = await provideLp({
				network: policy.network, mint: policy.mint, meta: agent.meta, userId: agent.userId, agentId: agent.id,
				inventoryRaw, walletLamports: solBal, slippagePct, confirmTimeoutMs: 60_000, simulate,
			});
			await recordActionAndAdvance({
				policy,
				action: {
					kind: 'graduation_lp', triggerReason: 'graduated', priceSol: price,
					solLamports: lp.quoteLamports, tokenAmount: Number(lp.baseDeposited) / 1e6, venue: 'lp',
					signature: lp.signature, status: lp.simulated ? 'simulated' : 'executed',
					detail: lp.simulated ? 'paper LP deposit (simulate)' : 'provided LP into the canonical AMM pool',
					meta: { base_deposited: lp.baseDeposited, quote_lamports: lp.quoteLamports },
				},
			});
			await markGraduation(policy.id, { status: 'done', signature: lp.signature, terminal: true });
			if (render) {
				render.sizeSol = Math.max(0, Number(lp.quoteLamports) || 0) / SOL;
				render.sideBuy = null; // an LP deposit is two-sided, neither a buy nor a sell
				render.signature = lp.signature && lp.signature !== 'SIMULATED' ? lp.signature : null;
			}
			log.trade('graduation lp', { ...tag, sig: lp.signature, base: lp.baseDeposited, quote: lp.quoteLamports, simulated: lp.simulated });
			return 'graduation_lp';
		} catch (e) {
			await recordActionAndAdvance({ policy, action: { kind: 'graduation_lp', triggerReason: 'graduated', priceSol: price, status: 'failed', detail: `${e?.code || e?.message || 'lp_failed'}`.slice(0, 280) } });
			await markGraduation(policy.id, { status: `failed:${e?.code || 'lp_failed'}`, terminal: false });
			log.warn('graduation lp failed (will retry)', { ...tag, code: e?.code, err: e?.message });
			return 'graduation_lp_failed';
		}
	}

	// distribute — liquidate the managed inventory back to SOL in the agent wallet
	// (the owner can then withdraw / distribute). Routed through the audited path.
	if (!(inventoryWhole > 0)) {
		await recordActionAndAdvance({ policy, action: { kind: 'graduation_distribute', triggerReason: 'graduated', priceSol: price, status: 'skipped', detail: 'no inventory to distribute' } });
		await markGraduation(policy.id, { status: 'done', terminal: true });
		return 'graduation_distribute_empty';
	}
	const body = { mint: policy.mint, network: policy.network, side: 'sell', amount: 'max', slippageBps: Math.round(Number(policy.slippage_bps) || 500) };
	const tradeLimits = getTradeLimits(agent.meta);
	let input;
	try { input = parseTradeInput(body, tradeLimits); }
	catch (e) {
		await markGraduation(policy.id, { status: `failed:${e?.code || 'invalid'}`, terminal: false });
		return 'graduation_distribute_failed';
	}
	input.idempotencyKey = `mm:${policy.id}:graduation_distribute`;
	input.simulate = simulate;
	let result;
	try {
		result = await executeAgentTrade({ id: agent.id, userId: agent.userId, meta: agent.meta, input, source: 'mm:graduation_distribute', sourceMeta: { policy_id: policy.id, mint: policy.mint } });
	} catch (e) {
		await markGraduation(policy.id, { status: `failed:${e?.message?.slice(0, 60) || 'error'}`, terminal: false });
		return 'graduation_distribute_failed';
	}
	if (!result.ok) {
		await recordActionAndAdvance({ policy, action: { kind: 'graduation_distribute', triggerReason: 'graduated', priceSol: price, side: 'sell', status: result.code === 'firewall_blocked' ? 'blocked' : 'failed', detail: `${result.code}: ${result.message || ''}`.slice(0, 280) } });
		await markGraduation(policy.id, { status: `failed:${result.code}`, terminal: false });
		return 'graduation_distribute_failed';
	}
	const d = result.data || {};
	const isSim = d.simulated === true || simulate;
	const solMoved = isSim ? lamports(inventoryWhole * price) : Math.round((d.sol_received ?? 0) * SOL);
	await recordActionAndAdvance({
		policy,
		action: { kind: 'graduation_distribute', side: 'sell', triggerReason: 'graduated', priceSol: price, solLamports: Number(solMoved), tokenAmount: inventoryWhole, venue: d.venue || 'amm', signature: d.signature && d.signature !== 'SIMULATED' ? d.signature : null, custodyEventId: d.custody_event_id ?? null, status: isSim ? 'simulated' : 'executed', detail: isSim ? 'paper distribute (simulate)' : 'liquidated inventory to SOL for distribution' },
		effect: { solLamports: Number(solMoved) },
	});
	await markGraduation(policy.id, { status: 'done', signature: d.signature || null, terminal: true });
	if (render) {
		render.sizeSol = Math.max(0, Number(solMoved) || 0) / SOL;
		render.sideBuy = false;
		render.signature = d.signature && d.signature !== 'SIMULATED' ? d.signature : null;
	}
	return 'graduation_distribute';
}

// Record a non-firing decision. Routine pacing/budget/dust gates fire on EVERY
// sweep, so persisting each one would flood the ledger — those update the
// heartbeat (last_eval_at + last_error) instead, which the UI shows as a "what
// it's doing right now" note. Only NOTABLE events — an anti-wash block or a
// failure — earn a permanent ledger row.
async function skip({ policy, intent, price, status, detail, reason }) {
	if (status === 'blocked' || status === 'failed') {
		await recordActionAndAdvance({
			policy,
			action: { kind: intent.kind, side: intent.side, triggerReason: intent.reason, priceSol: price, status, detail, meta: { reason } },
		});
	} else {
		await markEvaluated(policy.id, { error: `holding: ${detail}`.slice(0, 200) });
	}
	return reason;
}
