// /api/fee-bridge/:action serves the Fee Bridge, a coin's creator fees, paid to an X
// account in USDC. Docs: docs/fee-bridge.md.
//
//   GET  config                  bridge wallet, split, floors (public)
//   GET  stats                   totals + newest payouts (public)
//   GET  coins[?handle=]         registered coins and what each has earned (public)
//   GET  coin?mint=              one coin's registration + on-chain routing (public)
//   GET  recipient?handle=       a handle's credited / paid / unpaid USDC (public)
//   GET  me                      the signed-in user's handle, balance, wallets, payouts
//   POST register {mint, handle} register a coin already routing 100% to the bridge
//   POST withdraw {wallet?}      pay the signed-in user's unpaid balance

import { z } from 'zod';

import { sql } from '../_lib/db.js';
import { getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, rateLimited, readJson, wrap } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { parse } from '../_lib/validate.js';
import { bridgeAddress, loadBridgeSigner, publicConfig, isEnabled } from '../_lib/fee-bridge/config.js';
import { readSharingState, routesOnlyTo } from '../_lib/fee-bridge/chain.js';
import { parseXHandle } from '../_lib/fee-bridge/math.js';
import { payClaimant, registerCoin } from '../_lib/fee-bridge/engine.js';
import {
	handleBalance,
	listCoins,
	payoutsFor,
	publicStats,
	recentPayouts,
	resolveClaimant,
	solanaWallets,
} from '../_lib/fee-bridge/ledger.js';

const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PUBLIC_CACHE = { 'cache-control': 'public, max-age=15, s-maxage=30' };

const registerSchema = z.object({
	mint: z.string().regex(MINT_RE, 'invalid mint'),
	handle: z.string().trim().min(1).max(60),
});
const withdrawSchema = z.object({
	wallet: z.string().regex(MINT_RE, 'invalid wallet').optional(),
});

// Typed engine errors (status < 500 or a known 5xx code) go back as-is; anything
// else rethrows to wrap(), which logs it and returns a sanitized envelope.
function sendTyped(res, e) {
	if (e?.status && e?.code) return error(res, e.status, e.code, e.message);
	throw e;
}

async function handleConfig(req, res) {
	return json(res, 200, publicConfig(await bridgeAddress()), PUBLIC_CACHE);
}

async function handleStats(req, res) {
	const [totals, payouts, address] = await Promise.all([publicStats(), recentPayouts(20), bridgeAddress()]);
	return json(res, 200, { config: publicConfig(address), totals, recent_payouts: payouts }, PUBLIC_CACHE);
}

async function handleCoins(req, res, url) {
	const raw = url.searchParams.get('handle');
	const handle = raw ? parseXHandle(raw) : null;
	if (raw && !handle) return error(res, 400, 'invalid_handle', 'invalid X handle');
	const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || 50));
	const coins = await listCoins({ limit, handleLc: handle ? handle.toLowerCase() : null });
	return json(res, 200, { coins }, PUBLIC_CACHE);
}

async function handleCoin(req, res, url) {
	const mint = url.searchParams.get('mint') || '';
	if (!MINT_RE.test(mint)) return error(res, 400, 'validation_error', 'valid mint required');
	const address = await bridgeAddress();
	const [row] = await sql`
		select c.mint, c.handle, c.status, c.quote_mint, c.created_at, c.last_crank_at, c.last_error,
			coalesce((select sum(usdc_atomics) from fee_bridge_credits k where k.mint = c.mint), 0)::text as credited
		from fee_bridge_coins c where c.mint = ${mint}
	`;
	let routed = null;
	if (address) {
		const state = await readSharingState(mint).catch(() => null);
		routed = state ? routesOnlyTo(state, address) : null;
	}
	return json(res, 200, {
		mint,
		enabled: isEnabled() && !!address,
		bridge_wallet: address,
		routes_to_bridge: routed,
		registration: row
			? {
					handle: row.handle,
					status: row.status,
					quote: row.quote_mint === 'So11111111111111111111111111111111111111112' ? 'SOL' : 'USDC',
					credited_usdc_atomics: row.credited,
					registered_at: row.created_at,
					last_crank_at: row.last_crank_at,
				}
			: null,
	}, { 'cache-control': 'private, no-store' });
}

async function handleRecipient(req, res, url) {
	const handle = parseXHandle(url.searchParams.get('handle'));
	if (!handle) return error(res, 400, 'invalid_handle', 'a valid X handle is required');
	const lc = handle.toLowerCase();
	const [balance, coins, [bound]] = await Promise.all([
		handleBalance(lc),
		listCoins({ limit: 50, handleLc: lc }),
		sql`select handle, bound_at from fee_bridge_recipients where handle_lc = ${lc}`,
	]);
	return json(res, 200, {
		handle: bound?.handle || handle,
		claimed: !!bound,
		credited_usdc_atomics: balance.credited.toString(),
		paid_usdc_atomics: balance.paid.toString(),
		unpaid_usdc_atomics: balance.unpaid.toString(),
		coins,
	}, PUBLIC_CACHE);
}

async function handleMe(req, res) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const address = await bridgeAddress();
	const [[xConn], claimant, wallets] = await Promise.all([
		sql`select username from social_connections where user_id = ${user.id} and provider = 'x' and disconnected_at is null limit 1`,
		resolveClaimant({ userId: user.id }),
		solanaWallets(user.id),
	]);
	const base = { config: publicConfig(address), x_connected: !!xConn, x_username: xConn?.username || null, wallets };
	if (!claimant) {
		return json(res, 200, { ...base, handle: null, handle_conflict: !!xConn, balance: null, coins: [], payouts: [] }, { 'cache-control': 'private, no-store' });
	}
	const [balance, coins, payouts] = await Promise.all([
		handleBalance(claimant.handleLc),
		listCoins({ limit: 50, handleLc: claimant.handleLc }),
		payoutsFor(claimant.handleLc, 20),
	]);
	return json(res, 200, {
		...base,
		handle: claimant.handle,
		handle_conflict: false,
		balance: {
			credited_usdc_atomics: balance.credited.toString(),
			paid_usdc_atomics: balance.paid.toString(),
			in_flight_usdc_atomics: balance.inFlight.toString(),
			unpaid_usdc_atomics: balance.unpaid.toString(),
		},
		coins,
		payouts: payouts.map((p) => ({ ...p })),
	}, { 'cache-control': 'private, no-store' });
}

async function handleRegister(req, res) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(registerSchema, await readJson(req));
	try {
		const out = await registerCoin({ userId: user.id, mint: body.mint, handle: body.handle });
		return json(res, out.created ? 201 : 200, out);
	} catch (e) {
		return sendTyped(res, e);
	}
}

async function handleWithdraw(req, res) {
	const user = await getSessionUser(req);
	if (!user) return error(res, 401, 'unauthorized', 'sign in required');
	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);
	const body = parse(withdrawSchema, await readJson(req));
	if (!isEnabled()) return error(res, 503, 'fee_bridge_paused', 'Payouts are paused right now. Your balance is safe; try again later.');
	const claimant = await resolveClaimant({ userId: user.id });
	if (!claimant) {
		return error(res, 409, 'x_not_connected', 'Connect the X account your fees are addressed to before withdrawing.');
	}
	try {
		const signer = await loadBridgeSigner();
		const out = await payClaimant({ signer, claimant, trigger: 'withdraw', wallet: body.wallet });
		return json(res, out.status === 'confirmed' ? 200 : 202, out);
	} catch (e) {
		return sendTyped(res, e);
	}
}

const GET = { config: handleConfig, stats: handleStats, coins: handleCoins, coin: handleCoin, recipient: handleRecipient, me: handleMe };
const POST = { register: handleRegister, withdraw: handleWithdraw };

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	const url = new URL(req.url, 'http://x');
	const action = req.query?.action || url.pathname.split('/').filter(Boolean)[2];
	const table = req.method === 'POST' ? POST : GET;
	const handler = table[action];
	if (!handler) return error(res, 404, 'not_found', `unknown fee-bridge action: ${action}`);

	if (req.method === 'GET') {
		const rl = await limits.authedReadIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl);
	}
	return handler(req, res, url);
});
