/**
 * Agent Sniper — live SSE stream for the /play arena.
 *
 *   GET /api/sniper/stream?network=mainnet
 *
 * The sniper worker is a SEPARATE process, so this endpoint can't read its
 * in-memory state — it DB-polls agent_sniper_positions for rows changed since a
 * cursor (~1.5s) and emits diffs. Postgres LISTEN/NOTIFY is not an option: Neon
 * serverless HTTP can't hold a LISTEN connection.
 *
 * Events: open, buy, sell, update, ping, close.
 */

import { cors, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { sql } from '../_lib/db.js';

const MAX_DURATION_MS = 90_000;
const PING_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 1_500;
const NETWORKS = new Set(['mainnet', 'devnet']);

function solscan(sig, network) {
	if (!sig || sig === 'SIMULATED') return null;
	return network === 'devnet' ? `https://solscan.io/tx/${sig}?cluster=devnet` : `https://solscan.io/tx/${sig}`;
}
const sol = (l) => (l != null ? Number(BigInt(l)) / 1e9 : null);

function shape(r, network) {
	const entry = r.entry_quote_lamports != null ? Number(BigInt(r.entry_quote_lamports)) : 0;
	const last = r.last_value_lamports != null ? Number(BigInt(r.last_value_lamports)) : entry;
	return {
		id: r.id,
		agent_id: r.agent_id,
		agent_name: r.agent_name,
		mint: r.mint,
		symbol: r.symbol,
		name: r.name,
		status: r.status,
		exit_reason: r.exit_reason,
		entry_sol: sol(r.entry_quote_lamports),
		current_sol: entry > 0 ? last / 1e9 : sol(r.last_value_lamports),
		exit_sol: sol(r.exit_quote_lamports),
		pnl_sol: sol(r.realized_pnl_lamports),
		pnl_pct: r.realized_pnl_pct != null ? Number(r.realized_pnl_pct) : (entry > 0 ? ((last - entry) / entry) * 100 : null),
		buy_url: solscan(r.buy_sig, network),
		sell_url: solscan(r.sell_sig, network),
		exec_route: r.exec_route || null,
		tip_lamports: r.tip_lamports != null ? Number(r.tip_lamports) : null,
		priority_fee_microlamports: r.priority_fee_microlamports != null ? Number(r.priority_fee_microlamports) : null,
		landed_ms: r.landed_ms != null ? Number(r.landed_ms) : null,
		at: r.changed_at,
	};
}

export default async function handleSniperStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active) return;
		res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
	};

	// Start from "now" so we stream only fresh activity; the leaderboard endpoint
	// supplies the initial backlog the page renders on load.
	let cursor = new Date().toISOString();

	const poll = async () => {
		if (!active) return;
		try {
			const rows = await sql`
				select p.id, p.agent_id, a.name as agent_name, p.mint, p.symbol, p.name,
				       p.status, p.exit_reason, p.entry_quote_lamports, p.last_value_lamports,
				       p.exit_quote_lamports, p.realized_pnl_lamports, p.realized_pnl_pct,
				       p.buy_sig, p.sell_sig,
				       p.exec_route, p.tip_lamports, p.priority_fee_microlamports, p.landed_ms,
				       p.opened_at, p.closed_at,
				       greatest(p.opened_at, coalesce(p.closed_at, p.opened_at),
				                coalesce(p.last_quoted_at, p.opened_at)) as changed_at
				from agent_sniper_positions p
				join agent_identities a on a.id = p.agent_id
				where p.network = ${network}
				  and greatest(p.opened_at, coalesce(p.closed_at, p.opened_at),
				               coalesce(p.last_quoted_at, p.opened_at)) > ${cursor}
				order by changed_at asc
				limit 100
			`;
			for (const r of rows) {
				const payload = shape(r, network);
				// Classify the transition for the ticker: a row whose newest timestamp
				// is its close is a sell; one whose newest is its open is a buy; the
				// rest are live re-quote updates.
				const closedTs = r.closed_at ? new Date(r.closed_at).getTime() : 0;
				const openedTs = new Date(r.opened_at).getTime();
				const changedTs = new Date(r.changed_at).getTime();
				const event = r.status === 'closed' && closedTs === changedTs ? 'sell'
					: openedTs === changedTs && r.buy_sig ? 'buy'
					: 'update';
				send(event, payload);
				if (r.changed_at > cursor) cursor = r.changed_at;
			}
		} catch (err) {
			send('error', { message: 'poll_failed' });
		}
	};

	send('open', { network, source: 'agent-sniper' });
	const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
	const ping = setInterval(() => send('ping', { t: Date.now() }), PING_INTERVAL_MS);

	const teardown = () => {
		if (!active) return;
		active = false;
		clearInterval(pollTimer);
		clearInterval(ping);
		clearTimeout(durationTimer);
		try { res.end(); } catch {}
	};
	const durationTimer = setTimeout(() => {
		send('close', { reason: 'duration_limit' });
		teardown();
	}, MAX_DURATION_MS);

	req.on('close', teardown);
}
