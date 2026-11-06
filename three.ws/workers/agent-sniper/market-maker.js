// agent-sniper — range-based market maker on pump.fun coins via Jito execution.
//
// For each enabled agent_market_maker_configs row the module:
//   1. Quotes current buy/sell prices every rebalance_interval_ms.
//   2. Computes the mid-price and compares against the configured spread band.
//   3. Buys when price is below the lower band (if inventory headroom allows).
//   4. Sells all inventory when price is above the upper band.
//   5. Persists every trade to agent_market_maker_trades and updates totals.
//
// In simulate mode quotes are resolved but no transaction is broadcast.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { getTradeCtx } from './trade-client.js';
import { loadAgentKeypair } from './keys.js';
import { screenPush } from './screen-push.js';

// ── constants ─────────────────────────────────────────────────────────────────

const SLIPPAGE_PCT = 1.0; // 1 % slippage for all MM trades
const DEFAULT_INTERVAL_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 60_000;

// ── helpers ───────────────────────────────────────────────────────────────────

/** Wrap a raw value in the BN type carried by the trade context. */
function bn(ctx, v) {
	return new ctx.BN(BigInt(v).toString());
}

function lamportsToSol(l) {
	return Number(BigInt(l)) / 1e9;
}

// ── database helpers ──────────────────────────────────────────────────────────

/** Load all enabled market-maker configs (joined with agent metadata). */
async function loadEnabledConfigs(network) {
	return sql`
		SELECT
			c.id,
			c.agent_id,
			c.user_id,
			c.mint,
			c.symbol,
			c.network,
			c.enabled,
			c.spread_bps,
			c.min_profit_bps,
			c.order_size_sol,
			c.max_inventory_sol,
			c.rebalance_interval_ms,
			c.current_inventory_sol,
			c.avg_entry_price_lamports,
			c.total_volume_sol,
			c.total_pnl_sol,
			c.trade_count,
			c.last_tick_at,
			c.mev_tip_mode
		FROM agent_market_maker_configs c
		WHERE c.enabled = true
		  AND c.network = ${network}
	`;
}

/** Insert a trade record and update config totals in a single round-trip. */
async function recordTrade(configId, trade) {
	const {
		side,           // 'buy' | 'sell'
		priceSol,       // per-token price at execution (SOL)
		sizeSol,        // SOL size of this leg
		tokenAmount,    // base token units (BigInt or number)
		sig,            // tx signature or 'SIMULATED'
		pnlSol,         // realised P&L this trade (0 for buys)
		newInventorySol,
		newAvgEntryLamports,
		newTotalVolumeSol,
		newTotalPnlSol,
		newTradeCount,
	} = trade;

	await sql`
		INSERT INTO agent_market_maker_trades
			(config_id, side, price_sol, size_sol, token_amount, sig, pnl_sol, created_at)
		VALUES
			(${configId}, ${side}, ${priceSol}, ${sizeSol}, ${String(tokenAmount)}, ${sig}, ${pnlSol}, now())
	`;

	await sql`
		UPDATE agent_market_maker_configs
		SET
			current_inventory_sol      = ${newInventorySol},
			avg_entry_price_lamports   = ${newAvgEntryLamports},
			total_volume_sol           = ${newTotalVolumeSol},
			total_pnl_sol              = ${newTotalPnlSol},
			trade_count                = ${newTradeCount},
			last_tick_at               = now()
		WHERE id = ${configId}
	`;
}

/** Touch last_tick_at so the ops dashboard knows the config is being visited. */
async function touchLastTick(configId) {
	await sql`
		UPDATE agent_market_maker_configs
		SET last_tick_at = now()
		WHERE id = ${configId}
	`.catch(() => {});
}

// ── band computation ──────────────────────────────────────────────────────────

/**
 * Given a config row return the buy/sell price thresholds in SOL per token.
 *
 * lower_band = avgEntry * (1 - spread_bps/2 / 10000)  → buy signal
 * upper_band = avgEntry * (1 + spread_bps/2 / 10000)  → sell signal
 *
 * When there is no inventory yet we don't have an avg_entry to anchor on; in
 * that case we return null bands to trigger a plain opportunistic buy.
 */
function computeBands(config) {
	const avgEntryLamports = Number(config.avg_entry_price_lamports ?? 0);
	const spreadBps = Number(config.spread_bps ?? 100);
	const halfSpread = spreadBps / 2 / 10_000;

	if (!avgEntryLamports) {
		// No position yet — no meaningful band.
		return { lowerBand: null, upperBand: null, avgEntrySol: null };
	}

	const avgEntrySol = avgEntryLamports / 1e9;
	return {
		lowerBand: avgEntrySol * (1 - halfSpread),
		upperBand: avgEntrySol * (1 + halfSpread),
		avgEntrySol,
	};
}

// ── per-config tick ───────────────────────────────────────────────────────────

async function processCoin(cfg, config) {
	const { mint, symbol, agent_id, user_id, network } = config;
	const orderSizeSol = Number(config.order_size_sol ?? 0.1);
	const maxInventorySol = Number(config.max_inventory_sol ?? 1.0);
	const currentInventorySol = Number(config.current_inventory_sol ?? 0);
	const mevTipMode = config.mev_tip_mode || 'auto';

	// ── 1. Get trade context ─────────────────────────────────────────────────
	let ctx;
	try {
		ctx = await getTradeCtx(network);
	} catch (err) {
		log.error('mm: getTradeCtx failed', { mint, symbol, err: err?.message });
		return;
	}

	// ── 2. Quote buy price (SOL → tokens) ───────────────────────────────────
	// We quote a single order_size_sol purchase to get the per-token buy price.
	let buyQuote;
	try {
		buyQuote = await ctx.client.quoteForBuy({
			mint,
			quoteAmount: bn(ctx, Math.round(orderSizeSol * 1e9)), // lamports
			slippagePct: SLIPPAGE_PCT,
		});
	} catch (err) {
		log.warn('mm: buy quote failed', { mint, symbol, err: err?.message });
		await touchLastTick(config.id);
		return;
	}

	// ── 3. Quote sell price (tokens → SOL) ──────────────────────────────────
	// Use the token amount we'd get from the buy quote to determine sell value.
	let sellQuote;
	const tokenAmountForQuote = BigInt(buyQuote.baseAmount ?? buyQuote.tokenAmount ?? 0);
	if (!tokenAmountForQuote) {
		log.warn('mm: buy quote returned zero token amount', { mint, symbol });
		await touchLastTick(config.id);
		return;
	}

	try {
		sellQuote = await ctx.client.quoteForSell({
			mint,
			baseAmount: bn(ctx, tokenAmountForQuote),
			slippagePct: SLIPPAGE_PCT,
		});
	} catch (err) {
		log.warn('mm: sell quote failed', { mint, symbol, err: err?.message });
		await touchLastTick(config.id);
		return;
	}

	// ── 4. Derive mid price ──────────────────────────────────────────────────
	const buyPriceLamports = Math.round((orderSizeSol * 1e9) / Number(tokenAmountForQuote));
	const sellOutLamports = Number(sellQuote.quoteAmount ?? sellQuote.solAmount ?? 0);
	const sellPriceLamports = sellOutLamports / Number(tokenAmountForQuote);
	const midPriceLamports = (buyPriceLamports + sellPriceLamports) / 2;
	const midPriceSol = midPriceLamports / 1e9;

	log.info('mm: price quote', {
		mint,
		symbol,
		buy_price_lamports: buyPriceLamports,
		sell_price_lamports: sellPriceLamports,
		mid_price_sol: midPriceSol,
		inventory_sol: currentInventorySol,
	});

	// ── 5. Compute bands and decide action ───────────────────────────────────
	const { lowerBand, upperBand, avgEntrySol } = computeBands(config);
	const spreadBps = Number(config.spread_bps ?? 100);
	const minProfitBps = Number(config.min_profit_bps ?? 50);

	// Determine whether to BUY or SELL.
	let action = null; // 'buy' | 'sell' | null

	const hasInventory = currentInventorySol > 0;
	const hasRoomForMore = currentInventorySol + orderSizeSol <= maxInventorySol;

	if (!hasInventory) {
		// No position yet: buy opportunistically. There's no band anchor so we
		// treat any price as an entry (guarded by max_inventory_sol).
		if (hasRoomForMore) {
			action = 'buy';
		}
	} else if (!hasRoomForMore) {
		// Inventory is full — only sell once the spread is captured.
		const sellThreshold = avgEntrySol * (1 + spreadBps / 10_000);
		if (midPriceSol >= sellThreshold) {
			action = 'sell';
		}
	} else {
		// Have partial inventory and room for more.
		if (upperBand !== null && midPriceSol >= upperBand) {
			action = 'sell';
		} else if (lowerBand !== null && midPriceSol <= lowerBand) {
			action = 'buy';
		} else if (lowerBand === null) {
			// Fallback: no avg yet (shouldn't happen when hasInventory, but guard).
			action = 'buy';
		}
	}

	// Check minimum-profit gate for sells when we have an entry.
	if (action === 'sell' && avgEntrySol) {
		const minSellPrice = avgEntrySol * (1 + minProfitBps / 10_000);
		if (midPriceSol < minSellPrice) {
			log.info('mm: sell blocked — below min_profit_bps threshold', {
				mint, symbol, mid_price_sol: midPriceSol, min_sell_price: minSellPrice,
			});
			action = null;
		}
	}

	if (!action) {
		log.info('mm: no action — price within band', {
			mint, symbol,
			mid_price_sol: midPriceSol,
			lower_band: lowerBand,
			upper_band: upperBand,
		});
		await touchLastTick(config.id);
		return;
	}

	// ── 6. Simulate mode: log and exit ──────────────────────────────────────
	if (cfg.mode !== 'live') {
		log.info(`mm: simulate — would ${action}`, {
			mint, symbol, action, mid_price_sol: midPriceSol,
			order_size_sol: orderSizeSol, inventory_sol: currentInventorySol,
		});
		await touchLastTick(config.id);
		return;
	}

	// ── 7. Load keypair ──────────────────────────────────────────────────────
	const agentKey = await loadAgentKeypair(agent_id, user_id, 'market_maker');
	if (!agentKey) {
		log.warn('mm: no keypair for agent', { agent_id, mint, symbol });
		return;
	}

	// ── 8. Execute trade ─────────────────────────────────────────────────────
	let sig = null;

	if (action === 'buy') {
		screenPush(`MM: Buying $${symbol} at ${midPriceSol.toFixed(6)} SOL/token`, 'trade');

		const solLamports = Math.round(orderSizeSol * 1e9);
		let instructions;
		try {
			instructions = await ctx.client.buildBuyInstructions({
				payer: agentKey.keypair.publicKey,
				mint,
				quoteAmount: bn(ctx, solLamports),
				slippagePct: SLIPPAGE_PCT,
			});
		} catch (err) {
			log.error('mm: buildBuyInstructions failed', { mint, symbol, err: err?.message });
			return;
		}

		try {
			sig = await import('./trade-client.js').then(({ signAndSend }) =>
				signAndSend(ctx, agentKey.keypair, instructions, CONFIRM_TIMEOUT_MS, {
					tipMode: mevTipMode,
				})
			);
		} catch (err) {
			log.error('mm: buy broadcast failed', { mint, symbol, err: err?.message });
			return;
		}

		// Update inventory.
		const tokensReceived = tokenAmountForQuote;
		const newInventorySol = currentInventorySol + orderSizeSol;

		// Compute new avg entry price (weighted average).
		const prevLamports = Number(config.avg_entry_price_lamports ?? 0);
		const newAvgEntry = prevLamports
			? Math.round(
				(prevLamports * currentInventorySol + buyPriceLamports * orderSizeSol) /
				newInventorySol
			)
			: buyPriceLamports;

		await recordTrade(config.id, {
			side: 'buy',
			priceSol: midPriceSol,
			sizeSol: orderSizeSol,
			tokenAmount: tokensReceived,
			sig,
			pnlSol: 0,
			newInventorySol,
			newAvgEntryLamports: newAvgEntry,
			newTotalVolumeSol: Number(config.total_volume_sol ?? 0) + orderSizeSol,
			newTotalPnlSol: Number(config.total_pnl_sol ?? 0),
			newTradeCount: Number(config.trade_count ?? 0) + 1,
		}).catch((err) => log.warn('mm: recordTrade(buy) failed', { mint, err: err?.message }));

		log.trade('mm:buy', {
			agent: agent_id, mint, symbol,
			price_sol: midPriceSol, size_sol: orderSizeSol,
			inventory_sol: newInventorySol, sig,
		});

	} else {
		// action === 'sell'
		const pnlPct = avgEntrySol
			? ((midPriceSol - avgEntrySol) / avgEntrySol) * 100
			: 0;

		screenPush(`MM: Selling $${symbol} — ${pnlPct.toFixed(1)}% spread captured`, 'trade');

		// Determine token inventory to sell: query the agent's on-chain token balance
		// as the authoritative source; fall back to an estimate from avg entry price.
		let tokenAmountToSell;
		try {
			const tokenAccts = await ctx.connection.getParsedTokenAccountsByOwner(
				agentKey.keypair.publicKey,
				{ mint: new ctx.web3.PublicKey(mint) },
			);
			const balance = tokenAccts.value?.[0]?.account?.data?.parsed?.info?.tokenAmount?.amount;
			tokenAmountToSell = balance ? BigInt(balance) : BigInt(0);
		} catch (err) {
			log.warn('mm: token balance fetch failed — estimating from avg entry', { mint, symbol, err: err?.message });
			// Estimate: inventory_sol / avg_entry_sol → token units
			const avgPriceSol = Number(config.avg_entry_price_lamports ?? 0) / 1e9;
			tokenAmountToSell = avgPriceSol > 0
				? BigInt(Math.round(currentInventorySol / avgPriceSol))
				: BigInt(0);
		}

		if (!tokenAmountToSell) {
			log.warn('mm: nothing to sell', { mint, symbol });
			await touchLastTick(config.id);
			return;
		}

		let instructions;
		try {
			instructions = await ctx.client.buildSellInstructions({
				payer: agentKey.keypair.publicKey,
				mint,
				baseAmount: bn(ctx, tokenAmountToSell),
				slippagePct: SLIPPAGE_PCT,
			});
		} catch (err) {
			log.error('mm: buildSellInstructions failed', { mint, symbol, err: err?.message });
			return;
		}

		try {
			sig = await import('./trade-client.js').then(({ signAndSend }) =>
				signAndSend(ctx, agentKey.keypair, instructions, CONFIRM_TIMEOUT_MS, {
					tipMode: mevTipMode,
				})
			);
		} catch (err) {
			log.error('mm: sell broadcast failed', { mint, symbol, err: err?.message });
			return;
		}

		// Realised P&L: proceeds - cost basis
		const proceedsLamports = sellOutLamports;
		const proceedsSol = lamportsToSol(proceedsLamports);
		const costBasisSol = avgEntrySol
			? avgEntrySol * currentInventorySol
			: currentInventorySol;
		const realizedPnlSol = proceedsSol - costBasisSol;

		await recordTrade(config.id, {
			side: 'sell',
			priceSol: midPriceSol,
			sizeSol: proceedsSol,
			tokenAmount: tokenAmountToSell,
			sig,
			pnlSol: realizedPnlSol,
			newInventorySol: 0,
			newAvgEntryLamports: 0,
			newTotalVolumeSol: Number(config.total_volume_sol ?? 0) + proceedsSol,
			newTotalPnlSol: Number(config.total_pnl_sol ?? 0) + realizedPnlSol,
			newTradeCount: Number(config.trade_count ?? 0) + 1,
		}).catch((err) => log.warn('mm: recordTrade(sell) failed', { mint, err: err?.message }));

		log.trade('mm:sell', {
			agent: agent_id, mint, symbol,
			price_sol: midPriceSol, proceeds_sol: proceedsSol,
			pnl_sol: realizedPnlSol, pnl_pct: pnlPct, sig,
		});
	}
}

// ── shared tick ───────────────────────────────────────────────────────────────

async function tick(cfg) {
	let configs;
	try {
		configs = await loadEnabledConfigs(cfg.network);
	} catch (err) {
		log.error('mm: loadEnabledConfigs failed', { err: err?.message });
		return;
	}

	if (!configs.length) return;

	// Fan out — an error in one config must never kill the others.
	await Promise.allSettled(
		configs.map((config) =>
			processCoin(cfg, config).catch((err) =>
				log.error('mm: processCoin crashed', {
					mint: config.mint,
					symbol: config.symbol,
					err: err?.message,
				})
			)
		)
	);
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Start the market-maker watch loop.
 *
 * Uses a single shared interval that fans out to all enabled configs on each
 * tick. The interval period is the minimum rebalance_interval_ms across all
 * enabled configs (or cfg.marketMakerIntervalMs / DEFAULT_INTERVAL_MS).
 *
 * @param {{ cfg: object, signal?: AbortSignal }} options
 *   cfg    — loadConfig() result (needs cfg.network, cfg.mode, cfg.marketMakerIntervalMs)
 *   signal — optional AbortSignal; abort stops the loop
 * @returns {Function} stop — call to cancel the interval
 */
export function startMarketMakerWatch({ cfg, signal } = {}) {
	// Determine the initial poll interval. We'll start with the configured
	// default; once configs are loaded the interval adapts on each tick.
	const baseIntervalMs = cfg.marketMakerIntervalMs ?? DEFAULT_INTERVAL_MS;

	let running = false;
	let intervalHandle = null;

	async function runTick() {
		if (running) return;
		running = true;
		try {
			// Re-read enabled configs each tick to pick up interval changes.
			let configs = [];
			try {
				configs = await loadEnabledConfigs(cfg.network);
			} catch {
				// Already logged inside; proceed with empty set (no-op tick).
			}

			// Compute the tightest rebalance interval across live configs.
			const minIntervalMs = configs.length
				? Math.min(...configs.map((c) => Number(c.rebalance_interval_ms || DEFAULT_INTERVAL_MS)))
				: baseIntervalMs;

			// Restart the interval if it drifted from the current tightest setting.
			if (minIntervalMs !== currentIntervalMs) {
				clearInterval(intervalHandle);
				currentIntervalMs = minIntervalMs;
				intervalHandle = setInterval(runTick, currentIntervalMs);
				if (intervalHandle.unref) intervalHandle.unref();
				log.info('mm: interval adjusted', { new_interval_ms: currentIntervalMs });
			}

			// Execute the actual tick (queries enabled configs again inside).
			await tick(cfg);
		} catch (err) {
			log.error('mm: tick crashed', { err: err?.message });
		} finally {
			running = false;
		}
	}

	let currentIntervalMs = baseIntervalMs;
	intervalHandle = setInterval(runTick, currentIntervalMs);
	if (intervalHandle.unref) intervalHandle.unref();

	log.info('mm: market-maker armed', {
		network: cfg.network,
		mode: cfg.mode,
		interval_ms: currentIntervalMs,
	});

	// Fire immediately so the first tick doesn't wait a full interval.
	runTick();

	function stop() {
		clearInterval(intervalHandle);
		log.info('mm: market-maker stopped');
	}

	if (signal) {
		signal.addEventListener('abort', stop, { once: true });
	}

	return stop;
}
