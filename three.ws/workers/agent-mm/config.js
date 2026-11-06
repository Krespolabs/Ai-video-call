// agent-mm — environment + runtime configuration for the autonomous fair-launch
// market-maker worker. Validated once at boot so a misconfigured worker fails
// loudly instead of running half a config. Long-lived process (NOT a Vercel
// cron): every cfg.pollMs it sweeps active policies and re-quotes each coin.
//
//   MM_MODE=simulate  — real quotes + full decision logic, no broadcast (default)
//   MM_MODE=live      — real floor-defense / recycle fills from agent wallets
//   MM_GLOBAL_KILL=1  — halt all MM actions (policies untouched; kill/withdraw still work)

import { databaseConfigured } from '../../api/_lib/env.js';

// The Postgres connection string may arrive under DATABASE_URL or any standard
// Vercel-Postgres/Neon alias (POSTGRES_URL, NEON_DATABASE_URL, …). db.js resolves
// the live connection from that alias set, so assert configuration the same way
// rather than hard-requiring the bare DATABASE_URL name at boot.
function requireDatabase(scope) {
	if (!databaseConfigured()) {
		throw new Error(`[${scope}] missing required env var: DATABASE_URL (or a POSTGRES_URL/NEON_DATABASE_URL alias)`);
	}
}

function req(name) {
	const v = process.env[name];
	if (!v || !String(v).trim()) throw new Error(`[agent-mm] missing required env var: ${name}`);
	return v;
}
function num(name, def) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	const n = Number(raw);
	return Number.isFinite(n) ? n : def;
}
function bool(name, def = false) {
	const raw = process.env[name];
	if (raw == null || raw === '') return def;
	return /^(1|true|yes|on)$/i.test(String(raw).trim());
}

export function loadConfig() {
	// DATABASE_URL + JWT_SECRET are consumed transitively by db.js / agent-wallet.js.
	requireDatabase('agent-mm');
	req('JWT_SECRET');

	const network = (process.env.MM_NETWORK || 'mainnet').trim();
	if (network !== 'mainnet' && network !== 'devnet') {
		throw new Error(`[agent-mm] MM_NETWORK must be mainnet|devnet, got "${network}"`);
	}
	const mode = (process.env.MM_MODE || 'simulate').trim();
	if (mode !== 'live' && mode !== 'simulate') {
		throw new Error(`[agent-mm] MM_MODE must be live|simulate, got "${mode}"`);
	}
	// A live worker on a public RPC will rate-limit under continuous re-quote load —
	// refuse to start live without a real endpoint rather than silently dropping fills.
	if (mode === 'live' && !process.env.SOLANA_RPC_URL && !process.env.HELIUS_API_KEY) {
		throw new Error('[agent-mm] live mode requires SOLANA_RPC_URL or HELIUS_API_KEY (public RPC will rate-limit)');
	}

	return {
		network,
		mode,
		// Emergency stop — halt all MM actions while leaving policies intact
		// (the owner can still kill / withdraw via the API).
		globalKill: bool('MM_GLOBAL_KILL', false),
		// Policy re-quote / decision cadence. The per-policy min_action_interval is
		// the real rate limit on actions; this is just how often we re-evaluate.
		pollMs: Math.max(5_000, num('MM_POLL_MS', 15_000)),
		// Policies evaluated in parallel per sweep (each agent's actions run serially).
		concurrency: Math.max(1, Math.min(16, num('MM_CONCURRENCY', 4))),
		// Liveness heartbeat into bot_heartbeat (shared ops visibility). 0 disables.
		heartbeatMs: Math.max(0, num('MM_HEARTBEAT_MS', 30_000)),
		// Window (seconds) over which "live volume" is measured for the volume cap.
		volumeWindowSeconds: Math.max(60, num('MM_VOLUME_WINDOW_S', 300)),
	};
}
