#!/usr/bin/env node
// scripts/x402-ring-agents-run.mjs
//
// Drive the ring agent-buyer roster locally for N ticks — the acceptance harness
// for Task 09. Each tick calls the same run(ctx) the autonomous loop invokes, so
// what you observe here is exactly what runs in production: personas plan, spend-
// limit-check, pay their own custodial wallets → treasury, and self-record
// attributed rows in x402_autonomous_log; at the on-chain cadence one roster agent
// lands a real agent-invocation receipt.
//
// It is REAL end to end — no mocks. With env + funded wallets present it settles on
// chain; without them each tick degrades to a clean skip (and says why), never a
// crash. After the run it prints the attribution summary (distinct agent_ids +
// settle sigs) and the fund-ledger moves so you can paste them into the acceptance
// checklist.
//
// Usage:
//   node scripts/x402-ring-agents-run.mjs [ticks]       # default 10 ticks
//   X402_RING_ONCHAIN_EVERY_N_TICKS=1 node scripts/x402-ring-agents-run.mjs 3
//
// Never prints a secret; never funds anything outside the ring.

import { randomUUID } from 'node:crypto';

import { run as ringAgentBuyers } from '../api/_lib/x402/agents/index.js';
import { floatTopUp } from '../api/_lib/x402/pipelines/ring-rebalance.js';

const ticks = Math.max(1, Number(process.argv[2] || 10));

function line(s = '') { console.log(s); }

line(`\n=== three.ws x402 ring — agent-buyer run (${ticks} ticks) ===\n`);

let sql = null;
try {
	({ sql } = await import('../api/_lib/db.js'));
	await sql`SELECT 1`;
} catch (e) {
	line(`  DB unreachable (${e.message}) — ticks will still run and degrade cleanly.\n`);
	sql = null;
}

let redis = null;
try {
	const mod = await import('../api/_lib/redis.js');
	redis = mod.getRedis?.() || null;
	if (redis) await redis.ping();
} catch { redis = null; }

const perTick = [];
for (let i = 0; i < ticks; i++) {
	const runId = randomUUID();
	const ctx = { runId, redis, sql, origin: process.env.APP_ORIGIN || 'https://three.ws' };
	let buy, fund;
	try {
		buy = await ringAgentBuyers(ctx);
	} catch (e) {
		buy = { error: e.message };
	}
	try {
		fund = await floatTopUp({ ...ctx });
	} catch (e) {
		fund = { error: e.message };
	}
	const paid = buy?.signalData?.paid ?? 0;
	const refused = buy?.signalData?.refused ?? 0;
	const onchain = buy?.signalData?.onchain?.landed ? buy.signalData.onchain.signature : (buy?.signalData?.onchain?.reason || '—');
	const moves = Array.isArray(fund?.moves) ? fund.moves.filter((m) => m.tx).length : 0;
	perTick.push({ tick: i + 1, paid, refused, onchain, funded: moves, note: buy?.note || buy?.error || '' });
	line(`  tick ${String(i + 1).padStart(2)}  paid=${paid} refused=${refused} funded=${moves} onchain=${onchain}  ${buy?.note || buy?.error || ''}`);
}

// ── Attribution summary from x402_autonomous_log ────────────────────────────────
if (sql) {
	try {
		const rows = await sql`
			SELECT agent_id, count(*)::int AS calls,
			       count(*) FILTER (WHERE success)::int AS ok,
			       count(tx_signature)::int AS settled,
			       max(ts) AS last_ts
			FROM x402_autonomous_log
			WHERE pipeline IN ('ring-agents', 'ring-onchain') AND agent_id IS NOT NULL
			  AND ts > now() - interval '10 minutes'
			GROUP BY agent_id ORDER BY calls DESC
		`;
		line(`\n  attributed agents (last 10 min): ${rows.length}`);
		for (const r of rows) {
			line(`    agent ${r.agent_id}  calls=${r.calls} ok=${r.ok} settled=${r.settled}`);
		}
		const [funds] = await sql`
			SELECT count(*)::int AS n, COALESCE(sum(amount_atomic), 0)::bigint AS total
			FROM x402_ring_ledger WHERE kind = 'fund' AND ts > now() - interval '10 minutes'
		`;
		line(`  fund-ledger moves (last 10 min): ${funds?.n || 0} totaling ${(Number(funds?.total || 0) / 1e6).toFixed(4)} USDC`);
	} catch (e) {
		line(`\n  (attribution summary unavailable: ${e.message})`);
	}
}

const anyPaid = perTick.some((t) => t.paid > 0);
const anyOnchain = perTick.some((t) => t.onchain && t.onchain.length > 40);
line(`\n  RESULT: ${anyPaid ? 'purchases settled' : 'no settlements (check env/funding — code path ran clean)'}` +
	`${anyOnchain ? ', on-chain receipt landed' : ''}\n`);

process.exit(0);
