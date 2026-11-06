#!/usr/bin/env node
/**
 * sniper-backfill-graduated.mjs — exit any sniper position parked on a graduated
 * coin through the pump AMM pool.
 *
 * Before the AMM-exit path existed, a position whose coin graduated off the
 * bonding curve was flagged `error='graduated:awaiting_amm_exit'` and left open
 * indefinitely — the bonding-curve sell could no longer price it. The live
 * worker now re-quotes such positions off the AMM and exits them when an exit
 * rule fires, so they no longer park. This one-shot drives that same machinery
 * on demand (e.g. right after deploy) instead of waiting for the worker's poll
 * cadence, and clears any pre-existing backlog.
 *
 * It runs the REAL production sweep (workers/agent-sniper/positions.js →
 * runPositionSweep), which:
 *   • includes graduated positions in its work set (strategy-store.getOpenPositions),
 *   • re-quotes each off the canonical AMM pool (amm-exit.quoteAmmSell),
 *   • fires stop-loss / trailing / take-profit / timeout against the real
 *     post-graduation price, and exits via the AMM (executor.buildGraduatedSell).
 *
 * Idempotent: executeSell flips status to closing→closed, so re-running never
 * double-sells. Honors SNIPER_MODE (simulate = paper exit, the default).
 *
 * Usage:
 *   SNIPER_MODE=simulate node scripts/sniper-backfill-graduated.mjs
 *   SNIPER_MODE=live SOLANA_RPC_URL=... node scripts/sniper-backfill-graduated.mjs
 *   node scripts/sniper-backfill-graduated.mjs --max-sweeps 8
 *
 * Env: DATABASE_URL + JWT_SECRET (required); SNIPER_NETWORK (default mainnet);
 *      SNIPER_MODE (default simulate); SOLANA_RPC_URL / HELIUS_API_KEY (live).
 */

import { loadConfig } from '../workers/agent-sniper/config.js';
import { runPositionSweep } from '../workers/agent-sniper/positions.js';
import { sql } from '../api/_lib/db.js';

function arg(flag, def) {
	const i = process.argv.indexOf(flag);
	if (i === -1 || i === process.argv.length - 1) return def;
	return process.argv[i + 1];
}

async function countParked(network) {
	const [r] = await sql`
		SELECT count(*)::int AS n FROM agent_sniper_positions
		WHERE network = ${network} AND status = 'open' AND error LIKE 'graduated%'
	`;
	return r?.n ?? 0;
}

async function main() {
	const cfg = loadConfig();
	const maxSweeps = Math.max(1, Number(arg('--max-sweeps', '6')) || 6);

	const before = await countParked(cfg.network);
	console.log(
		`[backfill] network=${cfg.network} mode=${cfg.mode} parked(graduated)=${before}`,
	);
	if (before === 0) {
		console.log('[backfill] nothing parked — done.');
		return;
	}

	// Run sweeps until the parked set stops shrinking or the cap is hit. A single
	// sweep re-quotes every open position (including graduated ones) and exits the
	// ones whose triggers fire; a long-parked position satisfies its timeout
	// immediately, so most clear on the first pass. Extra passes catch transient
	// RPC failures on the previous one.
	let remaining = before;
	for (let i = 1; i <= maxSweeps; i++) {
		await runPositionSweep(cfg);
		const now = await countParked(cfg.network);
		console.log(`[backfill] sweep ${i}: parked ${remaining} → ${now}`);
		if (now === 0) {
			console.log('[backfill] all graduated positions exited.');
			return;
		}
		if (now >= remaining) {
			// No progress this pass — the rest are held by exit rules that haven't
			// fired yet (e.g. a graduated coin still inside its hold window with no
			// stop hit). The live worker will exit them when a trigger fires; this is
			// not a stuck state. Report and stop.
			console.log(
				`[backfill] ${now} graduated position(s) still open but holding (no exit trigger met). ` +
					'The worker will exit them when stop-loss/trailing/take-profit/timeout fires.',
			);
			return;
		}
		remaining = now;
	}
	const left = await countParked(cfg.network);
	console.log(`[backfill] stopped after ${maxSweeps} sweeps; ${left} still open (holding).`);
}

main()
	.then(() => process.exit(0))
	.catch((err) => {
		console.error('[backfill] fatal:', err?.message || err);
		process.exit(1);
	});
