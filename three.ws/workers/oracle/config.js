// Oracle worker — config. Validated once at boot; live mode demands the secrets
// needed to load agent wallets and sign, so a misconfigured live deploy fails
// loud instead of silently never trading.

import { env } from '../../api/_lib/env.js';

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function loadConfig() {
	const mode = (process.env.ORACLE_MODE || 'simulate').toLowerCase() === 'live' ? 'live' : 'simulate';
	const network = (process.env.ORACLE_NETWORK || 'mainnet').toLowerCase() === 'devnet' ? 'devnet' : 'mainnet';

	const cfg = {
		mode,
		network,
		globalKill: process.env.ORACLE_GLOBAL_KILL === '1',
		scoreIntervalMs: num(process.env.ORACLE_SCORE_INTERVAL_MS, 15_000),
		agentIntervalMs: num(process.env.ORACLE_AGENT_INTERVAL_MS, 3_000),
		settleIntervalMs: num(process.env.ORACLE_SETTLE_INTERVAL_MS, 60_000),
		scoreBatch: num(process.env.ORACLE_SCORE_BATCH, 20),
		rescoreAfterSec: num(process.env.ORACLE_RESCORE_AFTER_SEC, 180),
		// Hard ceiling on any single live action, regardless of a watch's config —
		// a server-side backstop the owner UI can't exceed.
		maxTradeSolHardCap: num(process.env.ORACLE_MAX_TRADE_SOL, 0.25),
		// When set, live buys go through Jito bundles (MEV-protected, prioritised)
		// instead of standard RPC broadcast. Tip in SOL is capped at 0.01.
		useJito: process.env.ORACLE_USE_JITO === '1',
		jitoTipSol: Math.min(num(process.env.JITO_TIP_SOL, 0.002), 0.01),
		jitoBundleUrl: process.env.JITO_BUNDLE_URL || 'https://mainnet.block-engine.jito.wtf/api/v1/bundles',
	};

	if (!env.DATABASE_URL) throw new Error('[oracle] DATABASE_URL is required');
	if (cfg.mode === 'live' && !env.JWT_SECRET) {
		throw new Error('[oracle] live mode requires JWT_SECRET (to decrypt agent wallets)');
	}
	return cfg;
}
