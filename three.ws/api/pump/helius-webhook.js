// POST /api/pump/helius-webhook
// ------------------------------
// Inbound receiver for Helius enhanced-txn webhooks. Helius pushes a JSON
// array of decoded txns whenever a monitored wallet has activity. We filter
// to pump.fun buys/sells and persist to `pump_agent_trades` so the wallet
// monitor UI / copy-trade skill can consume from DB instead of polling RPC.
//
// Auth: shared-secret in 'authorization' header (set via HELIUS_WEBHOOK_AUTH).
// Body: array of Helius enhanced txn objects.
//
// To register the webhook, run once from a server-side script:
//   import { createWebhook } from '../_lib/helius.js';
//   await createWebhook({
//     wallets: [...],
//     webhookURL: `${env.APP_ORIGIN}/api/pump/helius-webhook`,
//   });

import { timingSafeEqual, createHash } from 'node:crypto';
import { sql, sqlValues } from '../_lib/db.js';
import { cors, json, method, wrap, error, readJson } from '../_lib/http.js';
import { parsePumpTrades } from '../_lib/helius.js';
import { WSOL_MINT } from '../_lib/pump-quote.js';

function safeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string') return false;
	// Hash both values so the comparison buffers are always equal length — a
	// length pre-check leaks the secret's length as a timing side-channel.
	const ha = createHash('sha256').update(a).digest();
	const hb = createHash('sha256').update(b).digest();
	return timingSafeEqual(ha, hb);
}

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS' })) return;
	if (!method(req, res, ['POST'])) return;

	const expected = process.env.HELIUS_WEBHOOK_AUTH;
	if (!expected) return error(res, 503, 'not_configured', 'helius webhook auth not set');
	if (!safeEqual(String(req.headers.authorization || ''), expected)) {
		return error(res, 401, 'unauthorized', 'bad auth header');
	}

	const body = await readJson(req);
	const txns = Array.isArray(body) ? body : [];

	const trades = txns.flatMap(parsePumpTrades);
	if (trades.length === 0) return json(res, 200, { received: txns.length, trades: 0 });

	// Helius parses native-SOL pump.fun swaps, so every monitored trade is
	// SOL-paired: the quote is wrapped SOL and quote_amount == sol_amount.
	// One multi-row insert, joined to pump_agent_mints exactly as the per-trade
	// query did — only trades whose mint is a tracked agent mint are persisted,
	// and (tx_signature, network) collisions are skipped. Atomic in one statement.
	const rows = trades.map((t) => [t.mint, t.wallet, t.side, Math.round(t.sol * 1e9), t.signature]);
	const insertedRows = await sql`
		insert into pump_agent_trades (
			mint_id, user_id, wallet, direction, route,
			sol_amount, quote_mint, quote_symbol, quote_amount, tx_signature, network
		)
		select
			m.id, null, v.wallet, v.direction, 'bonding_curve',
			v.lamports::bigint, ${WSOL_MINT}, 'SOL', v.lamports::bigint, v.signature, 'mainnet'
		from ( values ${sqlValues(rows)} ) as v(mint, wallet, direction, lamports, signature)
		join pump_agent_mints m on m.mint = v.mint
		on conflict (tx_signature, network) do nothing
		returning id
	`;
	const inserted = insertedRows.length;

	return json(res, 200, { received: txns.length, trades: trades.length, inserted });
});
