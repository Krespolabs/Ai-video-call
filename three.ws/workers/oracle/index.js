// Oracle worker — entry point.
//
// A long-lived Node process (deploy alongside the other workers, NOT a Vercel
// function). Two cooperating loops:
//   1. score loop — keeps oracle_conviction warm from the data brain.
//   2. agent loop — acts on fresh verdicts for every armed agent watch.
//
//   ORACLE_MODE=simulate|live   (default simulate — no real spend)
//   ORACLE_NETWORK=mainnet|devnet
//   ORACLE_GLOBAL_KILL=1         halts all agent actions (scoring continues)
//
// Run: node workers/oracle/index.js   (or `npm run worker:oracle`)

import { loadConfig } from './config.js';
import { log } from './log.js';
import { runScorePass } from './score-loop.js';
import { runAgentPass } from './agent-loop.js';
import { runSettlePass } from './settle-loop.js';

async function main() {
	const cfg = loadConfig();
	log.info(`starting — mode=${cfg.mode} network=${cfg.network} score=${cfg.scoreIntervalMs}ms agent=${cfg.agentIntervalMs}ms${cfg.globalKill ? ' [KILL]' : ''}`);

	let stopped = false;
	const stop = (sig) => { log.info(`${sig} — shutting down`); stopped = true; setTimeout(() => process.exit(0), 200); };
	process.on('SIGINT', () => stop('SIGINT'));
	process.on('SIGTERM', () => stop('SIGTERM'));
	process.on('unhandledRejection', (e) => log.error('unhandledRejection:', e?.message || e));

	// Independent self-scheduling loops so a slow score pass never blocks acting.
	const loop = (name, fn, interval) => {
		const tick = async () => {
			if (stopped) return;
			try { await fn(cfg); } catch (e) { log.error(`${name} pass threw:`, e?.message || e); }
			if (!stopped) setTimeout(tick, interval);
		};
		tick();
	};

	loop('score', runScorePass, cfg.scoreIntervalMs);
	loop('agent', runAgentPass, cfg.agentIntervalMs);
	loop('settle', runSettlePass, cfg.settleIntervalMs);
}

main().catch((e) => { log.error('fatal:', e?.message || e); process.exit(1); });
