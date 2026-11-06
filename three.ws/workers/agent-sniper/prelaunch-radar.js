// agent-sniper — the pre-launch creator-wallet radar (block-zero pre-cog).
//
// A fourth source of snipes, parallel to the new-mint feed, first-claim poll, and
// intel watcher. Instead of reacting to a launch AFTER it hits the PumpPortal feed
// (where thousands of bots already see it), the radar watches the wallets of
// proven creators + smart-money (the auto-curated radar_watchlist) and detects the
// on-chain PRECURSOR to a launch:
//
//   • a watched wallet submits a pump.fun create instruction      → 'create'
//   • a watched wallet funds a brand-new deploy wallet …           → 'funding'
//     … which then submits the create instruction                 → 'correlated_mint'
//
// The instant a mint is known, the precursor is scored against every armed
// prelaunch_radar strategy and — if it passes the radar gates — routed through the
// SAME executor as any other snipe (firewall, MEV engine, spend guards, custody
// audit all unchanged). We act on PUBLIC on-chain precursors (funding, deploys),
// never on intercepting another user's pending mempool transaction.
//
// Real chain reads only (Helius RPC when keyed, else the platform Solana RPC). No
// RPC available → the radar reports itself PAUSED and the feed-based snipe carries
// on; it never fabricates a precursor.
//
// Dedupe is two-layered like first-claim-watch: an in-process `seen` set skips a
// signature handled this run, and radar_events' unique (network, signature, kind)
// is the durable guarantee a precursor pre-arms once. The executor's
// (agent, mint, network) lock is the final idempotency backstop on the buy.

import { sql } from '../../api/_lib/db.js';
import { log } from './log.js';
import { cachedStrategies } from './strategy-store.js';
import { executeBuy } from './executor.js';
import { oracleGate } from './oracle-gate.js';
import { getWalletReputation } from '../../api/_lib/smart-money.js';
import { scoreRadarEvent } from './radar-scorer.js';
import {
	radarEndpoint, fetchNewSignatures, fetchTransaction,
	classifyTransaction, walletHistoryCount,
} from './radar-detect.js';
import {
	recomputeWatchlist, loadWatchlist, markWatchlistHit,
} from './radar-watchlist.js';

const MAX_SEEN = 8000;

function radarStrategies(network) {
	return cachedStrategies().filter(
		(s) => s.trigger === 'prelaunch_radar' && (s.network || 'mainnet') === network,
	);
}

/**
 * Start the radar. Returns a stop() that clears every timer, and a getState() the
 * heartbeat reads so the operator can see whether the radar is live or paused.
 *
 * @param {object} o
 * @param {object} o.cfg
 * @param {{push:Function}} o.queue       bounded buy queue (shared with other triggers)
 * @param {{tryConsume:Function}} o.throttle
 * @param {() => boolean} o.isHalted
 */
export function startPrelaunchRadar({ cfg, queue, throttle, isHalted }) {
	const endpoint = radarEndpoint(cfg.network);
	const paused = !endpoint;
	const source = process.env.HELIUS_API_KEY ? 'helius' : 'rpc';

	const seen = new Set();                 // signatures handled this run
	const cursors = new Map();              // watched address → newest sig already scanned
	const deployWatch = new Map();          // fresh wallet → { funder, addedAt }
	let watchlist = new Map();              // address → row
	let rotateIdx = 0;
	let scanning = false;
	let backoffUntil = 0;
	let consecutiveErrors = 0;
	const state = {
		active: !paused, paused, source, reason: paused ? 'no_rpc' : null,
		watched: 0, deployWatch: 0, lastTickAt: null, lastEventAt: null,
		events: 0, prearmed: 0, errors: 0,
	};

	if (paused) {
		log.warn('prelaunch radar paused — no RPC endpoint (set HELIUS_API_KEY or SOLANA_RPC_URL)', {});
	}

	// ── watchlist refresh ────────────────────────────────────────────────────
	const refreshWatchlist = async () => {
		try {
			const r = await recomputeWatchlist({ network: cfg.network, cfg });
			watchlist = await loadWatchlist(cfg.network, cfg.radarMaxWatch);
			state.watched = watchlist.size;
			log.info('radar watchlist refreshed', {
				watched: watchlist.size, creators: r.creators, smartMoney: r.smartMoney, evicted: r.evicted,
			});
		} catch (err) {
			log.warn('radar watchlist refresh failed', { err: err?.message });
			// Keep whatever we already had loaded — never blank the radar on a hiccup.
			if (!watchlist.size) {
				try { watchlist = await loadWatchlist(cfg.network, cfg.radarMaxWatch); state.watched = watchlist.size; } catch {}
			}
		}
	};

	// ── pre-arm a precursor that now has a mint ──────────────────────────────
	const prearm = async (ev) => {
		const strategies = radarStrategies(cfg.network);
		if (!strategies.length) return;

		// One reputation read per precursor shared across strategies — the trigger
		// wallet (or, for a correlated mint, the funder) is what require_smart_money
		// _funder judges. Degrades to a zero-data result; never blocks the snipe.
		let funderRep = null;
		try { funderRep = await getWalletReputation(ev.trigger_wallet, cfg.network); } catch { funderRep = null; }

		for (const strat of strategies) {
			const scored = scoreRadarEvent({ ...ev, funder_reputation: funderRep }, strat, cfg);
			if (!scored.pass) {
				log.info('radar skip', { agent: strat.agent_id, mint: ev.mint, reason: scored.reasons[0] });
				continue;
			}
			log.info('radar candidate', {
				agent: strat.agent_id, mint: ev.mint, kind: ev.kind,
				trigger: ev.trigger_wallet, confidence: scored.confidence, reasons: scored.reasons,
			});
			state.prearmed++;
			const candidate = {
				mint: ev.mint, symbol: null, name: null,
				entry_trigger: 'prelaunch_radar', trigger_ref: ev.signature,
			};
			queue.push(async () => {
				if (isHalted()) return;
				const og = await oracleGate(ev.mint, cfg.network, strat);
				if (!og.pass) { log.info('oracle gate skip', { agent: strat.agent_id, mint: ev.mint, reason: og.reason }); return; }
				await executeBuy({ cfg, strat, mint: candidate, throttle });
			});
		}
	};

	// Persist a precursor (deduped). Returns true if it was NEW (pre-arm once).
	const recordEvent = async (ev) => {
		try {
			const watch = ev.watch || {};
			const [row] = await sql`
				insert into radar_events
					(network, kind, trigger_wallet, new_wallet, mint, signature, confidence,
					 watch_reason, watch_score, detail, observed_ts)
				values
					(${cfg.network}, ${ev.kind}, ${ev.trigger_wallet}, ${ev.new_wallet || null},
					 ${ev.mint || null}, ${ev.signature}, ${ev.base_confidence ?? 0},
					 ${watch.reason || null}, ${watch.score ?? null},
					 ${JSON.stringify(ev.detail || {})}::jsonb,
					 ${ev.observed_ms ? new Date(ev.observed_ms).toISOString() : null})
				on conflict (network, signature, kind) do nothing
				returning id
			`;
			return !!row;
		} catch (err) {
			log.warn('radar event persist failed', { err: err?.message });
			return false;
		}
	};

	const emit = async (ev) => {
		const fresh = await recordEvent(ev);
		if (!fresh) return;
		state.events++;
		state.lastEventAt = Date.now();
		markWatchlistHit(ev.trigger_wallet, cfg.network).catch(() => {});
		if (ev.mint) await prearm(ev);
	};

	// ── scan one watched wallet's new activity ───────────────────────────────
	const scanWallet = async (address, watch) => {
		const until = cursors.get(address) || null;
		// A throw here bubbles to tick() for backoff accounting — intentional.
		const sigs = await fetchNewSignatures(address, { endpoint, untilSig: until, limit: 25 });
		if (!sigs.length) return;

		// First time we see this wallet: anchor the cursor at its newest signature
		// WITHOUT acting on history. The radar only fires on launches that happen
		// after we start watching — never backfills a stale, already-floored launch.
		if (!until) { cursors.set(address, sigs[0].signature); return; }

		cursors.set(address, sigs[0].signature);
		// Process oldest→newest so a funding that precedes its create is seen first.
		for (const s of [...sigs].reverse()) {
			if (s.err || seen.has(s.signature)) continue;
			seen.add(s.signature);
			const tx = await fetchTransaction(s.signature, { endpoint }).catch(() => null);
			if (!tx) continue;
			const observedMs = s.blockTime ? s.blockTime * 1000 : (tx.blockTime ? tx.blockTime * 1000 : null);
			const { create, fundings } = classifyTransaction(tx, address);

			if (create) {
				await emit({
					kind: 'create', trigger_wallet: address, mint: create.mint, signature: s.signature,
					base_confidence: 0.9, observed_ms: observedMs, watch,
					detail: { variant: create.variant },
				});
			}

			for (const f of fundings) {
				if (f.lamports < cfg.radarMinFundingLamports) continue;
				let hist;
				try { hist = await walletHistoryCount(f.destination, { endpoint }); } catch { hist = null; }
				if (!hist || !hist.fresh) continue; // only fresh wallets are deploy-wallet candidates
				await emit({
					kind: 'funding', trigger_wallet: address, new_wallet: f.destination, signature: s.signature,
					base_confidence: 0.5, observed_ms: observedMs, watch,
					detail: { funded_sol: f.lamports / 1e9, fresh_tx_count: hist.total },
				});
				// Put the fresh wallet under correlation watch for its create.
				if (deployWatch.size < 2000) {
					deployWatch.set(f.destination, { funder: address, watch, addedAt: Date.now(), cursor: null });
				}
			}
		}
	};

	// ── scan a freshly-funded wallet for the create it was funded to make ────
	const scanDeployWallet = async (address, entry) => {
		// A throw here bubbles to tick() for backoff accounting — intentional.
		const sigs = await fetchNewSignatures(address, { endpoint, untilSig: entry.cursor, limit: 15 });
		if (!sigs.length) return;
		entry.cursor = sigs[0].signature;
		for (const s of [...sigs].reverse()) {
			if (s.err || seen.has(s.signature)) continue;
			seen.add(s.signature);
			const tx = await fetchTransaction(s.signature, { endpoint }).catch(() => null);
			if (!tx) continue;
			const create = classifyTransaction(tx, address).create;
			if (!create) continue;
			const observedMs = s.blockTime ? s.blockTime * 1000 : null;
			await emit({
				kind: 'correlated_mint', trigger_wallet: entry.funder, new_wallet: address, mint: create.mint,
				signature: s.signature, base_confidence: 0.85, observed_ms: observedMs, watch: entry.watch,
				detail: { variant: create.variant, via_funding: true },
			});
			deployWatch.delete(address); // correlated — stop watching it
			return;
		}
	};

	// ── poll tick ────────────────────────────────────────────────────────────
	const tick = async () => {
		if (paused || scanning || isHalted()) return;
		if (Date.now() < backoffUntil) return;
		if (!radarStrategies(cfg.network).length) return; // nothing armed → don't burn RPC
		if (!watchlist.size) return;
		scanning = true;
		let hadError = false;
		try {
			// Expire stale deploy-watch entries.
			const ttl = cfg.radarDeployWatchTtlMs;
			for (const [addr, entry] of deployWatch) {
				if (Date.now() - entry.addedAt > ttl) deployWatch.delete(addr);
			}

			// Round-robin a bounded batch of watched wallets so the whole set is
			// covered across ticks without flooding the RPC in one tick.
			const addresses = [...watchlist.keys()];
			const batchSize = Math.min(cfg.radarWalletsPerTick, addresses.length);
			for (let i = 0; i < batchSize; i++) {
				const address = addresses[(rotateIdx + i) % addresses.length];
				try {
					await scanWallet(address, watchlist.get(address));
				} catch (err) {
					hadError = true;
					log.warn('radar wallet scan failed', { address, err: err?.message });
				}
			}
			rotateIdx = (rotateIdx + batchSize) % addresses.length;

			// Always sweep the (small) deploy-watch set every tick — these are the
			// hottest precursors, a create can land seconds after the funding.
			for (const [addr, entry] of [...deployWatch]) {
				try {
					await scanDeployWallet(addr, entry);
				} catch (err) {
					hadError = true;
					log.warn('radar deploy-wallet scan failed', { addr, err: err?.message });
				}
			}

			pruneSeen(seen);
			state.lastTickAt = Date.now();
			state.deployWatch = deployWatch.size;
		} finally {
			scanning = false;
			if (hadError) {
				state.errors++;
				consecutiveErrors++;
				// Exponential backoff on sustained RPC failure (rate limits / outage),
				// capped — the radar degrades, the feed snipe keeps running.
				if (consecutiveErrors >= 3) {
					const backoff = Math.min(120_000, cfg.radarPollMs * 2 ** Math.min(5, consecutiveErrors - 2));
					backoffUntil = Date.now() + backoff;
					state.reason = 'rpc_backoff';
					log.warn('radar backing off', { ms: backoff, consecutiveErrors });
				}
			} else {
				consecutiveErrors = 0;
				if (state.reason === 'rpc_backoff') state.reason = null;
			}
		}
	};

	// ── boot ──────────────────────────────────────────────────────────────────
	let pollTimer = null;
	let refreshTimer = null;
	if (!paused) {
		refreshWatchlist().finally(() => {
			pollTimer = setInterval(() => { tick().catch((err) => log.error('radar tick crashed', { err: err?.message })); }, cfg.radarPollMs);
			if (pollTimer.unref) pollTimer.unref();
		});
		refreshTimer = setInterval(() => { refreshWatchlist().catch(() => {}); }, cfg.radarWatchlistRefreshMs);
		if (refreshTimer.unref) refreshTimer.unref();
		log.info('prelaunch radar armed', {
			pollMs: cfg.radarPollMs, refreshMs: cfg.radarWatchlistRefreshMs, walletsPerTick: cfg.radarWalletsPerTick, source,
		});
	}

	return {
		stop() {
			if (pollTimer) clearInterval(pollTimer);
			if (refreshTimer) clearInterval(refreshTimer);
		},
		getState() {
			return { ...state, watched: watchlist.size, deployWatch: deployWatch.size };
		},
	};
}

function pruneSeen(seen) {
	if (seen.size <= MAX_SEEN) return;
	const drop = seen.size - Math.floor(MAX_SEEN / 2);
	let i = 0;
	for (const sig of seen) {
		seen.delete(sig);
		if (++i >= drop) break;
	}
}
