/**
 * /api/agents/:id/portfolio         — owner-only Portfolio Command snapshot:
 *   live valuation of every holding (SOL + SPL) in SOL + USD, FIFO cost basis +
 *   unrealized P&L per holding, realized/unrealized P&L attributed by source
 *   (sniper strategies, discretionary, strategy objects, x402, withdrawals), and
 *   live risk metrics (concentration, exposure, drawdown, realized vol) with
 *   plain-language flags. All real — see api/_lib/portfolio.js.
 *
 * /api/agents/:id/portfolio/stream  — owner-only SSE: re-values on an interval
 *   and pushes net-worth + risk snapshots so the UI stays live.
 *
 * Attribution is derived from the custody/spend ledger, which is owner-sensitive,
 * so the whole surface is owner-gated (unlike the public balance read).
 */

import { getSessionUser, authenticateBearer, extractBearer } from '../_lib/auth.js';
import { sql } from '../_lib/db.js';
import { cors, json, method, error, rateLimited, serverError } from '../_lib/http.js';
import { limits } from '../_lib/rate-limit.js';
import { getPortfolio } from '../_lib/portfolio.js';

// The stream MUST close itself before the platform kills the function, or Vercel
// emits a "Runtime Timeout Error" 504 mid-stream instead of our clean `bye` — the
// client then sees an abrupt drop rather than the graceful close its EventSource
// reconnects from. This handler is served by api/agents/[id].js, whose vercel.json
// cap is 45s, so we self-terminate at 40s (5s margin for the final bye + flush) and
// let the browser's EventSource auto-reconnect. Keep this strictly under that cap:
// if api/agents/[id].js maxDuration changes in vercel.json, change this to match.
const MAX_DURATION_MS = 40_000;
const PING_INTERVAL_MS = 15_000;
const SNAPSHOT_INTERVAL_MS = 20_000;

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// Load + ownership-gate the agent. Returns { auth } on success, or null after
// having written the error response.
async function gateOwner(req, res, id) {
	const auth = await resolveAuth(req);
	if (!auth) { error(res, 401, 'unauthorized', 'sign in required'); return null; }
	const [row] = await sql`SELECT id, user_id FROM agent_identities WHERE id = ${id} AND deleted_at IS NULL`;
	if (!row) { error(res, 404, 'not_found', 'agent not found'); return null; }
	if (row.user_id !== auth.userId) { error(res, 403, 'forbidden', 'not your agent'); return null; }
	return { auth };
}

function networkOf(req) {
	const url = new URL(req.url, 'http://x');
	return url.searchParams.get('network') === 'devnet' ? 'devnet' : 'mainnet';
}

// ── snapshot ────────────────────────────────────────────────────────────────
async function handleSnapshot(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const gate = await gateOwner(req, res, id);
	if (!gate) return;

	const rl = await limits.walletRead(gate.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const network = networkOf(req);
	let portfolio;
	try {
		portfolio = await getPortfolio({ agentId: id, network });
	} catch (e) {
		console.error('[agents/portfolio] snapshot failed', e?.message);
		return serverError(res, 502, 'portfolio_failed', e);
	}
	if (!portfolio) return error(res, 404, 'not_found', 'agent not found');
	return json(res, 200, { data: portfolio });
}

// ── live stream (SSE) ───────────────────────────────────────────────────────
async function handleStream(req, res, id) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const gate = await gateOwner(req, res, id);
	if (!gate) return;

	const rl = await limits.walletRead(gate.auth.userId);
	if (!rl.success) return rateLimited(res, rl);

	const network = networkOf(req);

	res.writeHead(200, {
		'Content-Type': 'text/event-stream; charset=utf-8',
		'Cache-Control': 'no-cache, no-transform',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	res.flushHeaders?.();

	let active = true;
	const send = (event, data) => {
		if (!active || res.writableEnded) return;
		try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ }
	};

	send('hello', { ts: Date.now(), network });

	const push = async () => {
		if (!active) return;
		try {
			const p = await getPortfolio({ agentId: id, network });
			if (!p) { send('bye', { reason: 'not_found' }); return cleanup(); }
			// Stream the live-moving parts; the initial GET supplies the full body.
			send('snapshot', {
				t: p.t,
				sol_usd: p.sol_usd,
				net_worth: p.net_worth,
				risk: p.risk,
				risk_flags: p.risk_flags,
				attribution: p.attribution,
				holdings: p.holdings,
			});
		} catch (e) {
			send('warn', { message: 'revaluation_failed' });
		}
	};

	await push();
	const snapTimer = setInterval(push, SNAPSHOT_INTERVAL_MS);
	const pingTimer = setInterval(() => send('ping', { ts: Date.now() }), PING_INTERVAL_MS);
	const hardStop = setTimeout(() => { send('bye', { reason: 'max_duration' }); cleanup(); }, MAX_DURATION_MS);

	function cleanup() {
		if (!active) return;
		active = false;
		clearInterval(snapTimer);
		clearInterval(pingTimer);
		clearTimeout(hardStop);
		try { res.end(); } catch { /* already closed */ }
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
}

export default async function handler(req, res, id, action) {
	if (action === 'stream') return handleStream(req, res, id);
	if (!action) return handleSnapshot(req, res, id);
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	return error(res, 404, 'not_found', 'unknown portfolio sub-resource');
}
