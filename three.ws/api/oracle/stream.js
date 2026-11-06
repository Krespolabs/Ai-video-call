/**
 * Oracle — live conviction stream (SSE).
 *
 *   GET /api/oracle/stream?network=mainnet&min_score=0
 *
 * The ingestion augmentor is a separate process, so this endpoint can't read its
 * memory — it DB-polls oracle_conviction for rows scored since a cursor (~2s) and
 * fans new/updated verdicts to every connected client. Neon serverless HTTP
 * can't hold a LISTEN connection, so polling is the right call (matches the
 * sniper/club stream pattern). Events: hello, coin, ping, bye.
 */

import { cors, method, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { feedSince } from '../_lib/oracle/store.js';

const NETWORKS = new Set(['mainnet', 'devnet']);
const MAX_DURATION_MS = 90_000;
const PING_INTERVAL_MS = 15_000;
const POLL_INTERVAL_MS = 2_000;

export default async function handleOracleStream(req, res) {
	if (cors(req, res, { methods: 'GET,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['GET'])) return;

	const rl = await limits.mcpIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const url = new URL(req.url, `http://${req.headers.host || 'x'}`);
	const network = NETWORKS.has(url.searchParams.get('network')) ? url.searchParams.get('network') : 'mainnet';
	const minScore = Math.max(0, Math.min(100, Number(url.searchParams.get('min_score')) || 0));

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

	// Stream only fresh verdicts; the feed endpoint supplies the initial backlog.
	let cursor = new Date().toISOString();

	const poll = async () => {
		if (!active) return;
		try {
			const items = await feedSince({ network, sinceIso: cursor, limit: 40 });
			for (const it of items) {
				if (it.score < minScore) continue;
				send('coin', it);
			}
			if (items.length) cursor = items[items.length - 1].scored_at || cursor;
		} catch { /* transient DB error — next tick retries */ }
	};

	const pollTimer = setInterval(poll, POLL_INTERVAL_MS);
	const pingTimer = setInterval(() => send('ping', { ts: Date.now() }), PING_INTERVAL_MS);
	const stopTimer = setTimeout(() => { send('bye', { reason: 'rotate' }); cleanup(); }, MAX_DURATION_MS);

	function cleanup() {
		if (!active) return;
		active = false;
		clearInterval(pollTimer);
		clearInterval(pingTimer);
		clearTimeout(stopTimer);
		try { res.end(); } catch { /* already closed */ }
	}

	req.on('close', cleanup);
	req.on('error', cleanup);
}
