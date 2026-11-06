// agent-sniper — the first-claim trigger.
//
// A second source of snipes, parallel to the PumpPortal new-mint feed. Instead
// of reacting to launches, this polls the on-chain pump.fun fee-claim stream and
// fires when a creator pulls their accrued rewards for the FIRST time EVER — an
// irreversible "the creator is live and taking real fees" signal. Each first
// claim is scored against every armed `first_claim` strategy, held for the
// owner-set delay, then routed through the SAME executeBuy path as a new-mint
// snipe (same guardrails, same idempotency lock, same position lifecycle).
//
// Dedupe is two-layered: an in-process `seen` set skips re-scoring a claim we
// already handled this run, and the executor's INSERT … ON CONFLICT
// (agent, mint, network) is the durable guarantee that a coin is sniped once.

import { scanFirstClaims } from '../../api/_lib/pump-claims.js';
import { scoreClaim } from './claim-scorer.js';
import { executeBuy } from './executor.js';
import { oracleGate } from './oracle-gate.js';
import { cachedStrategies } from './strategy-store.js';
import { log } from './log.js';

const MAX_SEEN = 5000; // cap the dedupe set; prune oldest in bulk when exceeded.

function firstClaimStrategies() {
	return cachedStrategies().filter((s) => s.trigger === 'first_claim');
}

/**
 * Start the first-claim poll loop. Returns a stop() that clears the interval and
 * every pending delayed-buy timer.
 *
 * @param {object} o
 * @param {object} o.cfg     loadConfig() result
 * @param {{push:Function}} o.queue  bounded buy queue from index.js
 * @param {{tryConsume:Function}} o.throttle  global buy throttle from index.js
 * @param {() => boolean} o.isHalted  true when draining or the global kill is set
 */
export function startFirstClaimWatch({ cfg, queue, throttle, isHalted }) {
	const seen = new Set();
	const timers = new Set();
	let scanning = false;

	const scheduleBuy = (strat, candidate) => {
		const delay = Math.max(0, Math.min(600_000, Number(strat.buy_delay_ms) || 0));
		const execJob = async () => {
			const og = await oracleGate(candidate.mint, cfg.network, strat);
			if (!og.pass) { log.info('oracle gate skip', { agent: strat.agent_id, mint: candidate.mint, reason: og.reason }); return; }
			if (og.skipped) log.info('oracle unscored — proceeding', { agent: strat.agent_id, mint: candidate.mint });
			await executeBuy({ cfg, strat, mint: candidate, throttle });
		};
		if (delay === 0) {
			if (!isHalted()) queue.push(execJob);
			return;
		}
		const timer = setTimeout(() => {
			timers.delete(timer);
			if (isHalted()) return;
			log.info('first-claim buy (delayed)', {
				agent: strat.agent_id, mint: candidate.mint, delayMs: delay,
			});
			queue.push(execJob);
		}, delay);
		if (timer.unref) timer.unref();
		timers.add(timer);
	};

	const tick = async () => {
		if (scanning || isHalted()) return;
		const strategies = firstClaimStrategies();
		if (!strategies.length) return;
		scanning = true;
		try {
			const nowTs = Math.floor(Date.now() / 1000);
			const sinceTs = nowTs - cfg.claimLookbackSeconds;
			const items = await scanFirstClaims({ sinceTs, limit: 50 });
			for (const item of items) {
				if (seen.has(item.signature)) continue;
				seen.add(item.signature);
				const age = nowTs - (Number(item.ts) || 0);
				for (const strat of strategies) {
					const maxAge = Number(strat.first_claim_max_age_seconds) || cfg.claimMaxAgeSeconds;
					if (age > maxAge) {
						log.info('skip', { agent: strat.agent_id, mint: item.mint, reason: 'claim_stale', ageS: age });
						continue;
					}
					const { pass, reasons } = scoreClaim(item, strat);
					if (!pass) {
						log.info('skip', { agent: strat.agent_id, mint: item.mint, reason: reasons[0] });
						continue;
					}
					log.info('first-claim candidate', {
						agent: strat.agent_id, mint: item.mint, creator: item.creator, sig: item.signature, reasons,
					});
					scheduleBuy(strat, {
						mint: item.mint,
						symbol: null,
						name: null,
						entry_trigger: 'first_claim',
						trigger_ref: item.signature,
					});
				}
			}
			pruneSeen(seen);
		} catch (err) {
			log.error('first-claim scan failed', { err: err?.message });
		} finally {
			scanning = false;
		}
	};

	const interval = setInterval(() => { tick().catch((err) => log.error('first-claim tick crashed', { err: err?.message })); }, cfg.claimPollMs);
	if (interval.unref) interval.unref();
	log.info('first-claim watch armed', { pollMs: cfg.claimPollMs, lookbackS: cfg.claimLookbackSeconds });

	return function stop() {
		clearInterval(interval);
		for (const t of timers) clearTimeout(t);
		timers.clear();
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
