/**
 * Skill purchase flow (Solana Pay).
 * ---------------------------------
 * POST /api/marketplace/purchase
 *   Body: { agent_id, skill }
 *   Creates a pending skill_purchases row and returns Solana Pay params.
 *
 * GET  /api/marketplace/purchase/:reference
 *   Returns { status, tx_signature, confirmed_at } for the caller's purchase.
 *
 * POST /api/marketplace/purchase/:reference/confirm
 *   Looks up the on-chain transaction by `reference`, validates it sent the
 *   expected amount of the expected SPL token to the agent owner's payout
 *   wallet, marks the purchase confirmed, records agent_revenue_events.
 *
 * Routed via vercel.json rewrites — see project root.
 */

import { sql } from '../_lib/db.js';
import { authenticateBearer, extractBearer, getSessionUser } from '../_lib/auth.js';
import { cors, error, json, method, readJson, wrap, rateLimited } from '../_lib/http.js';
import { clientIp, limits } from '../_lib/rate-limit.js';
import { logEvent } from '../_lib/purchase-confirm.js';
import { requireCsrf } from '../_lib/csrf.js';
import { MonetizationService } from '../_lib/services/MonetizationService.js';
import { solanaConnection } from '../_lib/solana/connection.js';
import { buildGaslessPurchaseTx } from '../_lib/solana/gasless-tx.js';
import { resolveRecipient } from '../_lib/resolve-recipient.js';
import { normalizeReferralCode } from '../_lib/referrals.js';

const SOLANA_RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

const REFERENCE_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58 Pubkey

export default wrap(async (req, res) => {
	const url = new URL(req.url, 'http://x');
	// Vercel rewrites pass reference/op as query params; allow path form too for
	// local dev where the rewrite chain may be skipped.
	const parts = url.pathname.split('/').filter(Boolean); // ['api','marketplace','purchase', ...]
	const reference = url.searchParams.get('reference') || parts[3] || null;
	const op = url.searchParams.get('op') || parts[4] || null;

	if (!reference) {
		if (req.method === 'POST') return handleCreate(req, res);
		return error(res, 405, 'method_not_allowed', 'POST required');
	}

	if (!REFERENCE_RE.test(reference)) {
		return error(res, 400, 'validation_error', 'invalid reference');
	}

	if (!op) return handleStatus(req, res, reference);
	if (op === 'confirm') return handleConfirm(req, res, reference);
	return error(res, 404, 'not_found', 'unknown purchase action');
});

async function resolveAuth(req) {
	const session = await getSessionUser(req);
	if (session) return { userId: session.id };
	const bearer = await authenticateBearer(extractBearer(req));
	if (bearer) return { userId: bearer.userId };
	return null;
}

// ── Create ─────────────────────────────────────────────────────────────────

async function handleCreate(req, res) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const body = await readJson(req).catch(() => null);
	const agentId = body?.agent_id;
	const skill = typeof body?.skill === 'string' ? body.skill.trim() : null;
	const durationHours = Number.isInteger(body?.duration_hours) && body.duration_hours > 0
		? Math.min(body.duration_hours, 720)
		: null;
	if (!agentId || !skill) {
		return error(res, 400, 'validation_error', 'agent_id and skill required');
	}
	// Pay-what-you-want: the buyer may name an amount (atomic units). Accepted as a
	// number or numeric string; the service validates it against the skill's
	// minimum + a ceiling, and ignores it for fixed-price skills.
	let payAmount = null;
	if (body?.pay_amount != null && body.pay_amount !== '') {
		const raw = typeof body.pay_amount === 'number' ? Math.trunc(body.pay_amount) : String(body.pay_amount).trim();
		if (!/^\d+$/.test(String(raw))) {
			return error(res, 400, 'validation_error', 'pay_amount must be a whole number of atomic units');
		}
		payAmount = String(raw);
	}
	// Optional: when the browser wallet is already connected it passes its
	// pubkey so we can return a platform-sponsored (gasless) transaction.
	const buyerPublicKey =
		typeof body?.buyer_public_key === 'string' && REFERENCE_RE.test(body.buyer_public_key)
			? body.buyer_public_key
			: null;

	// Referrer is resolved from the request (querystring / account link) and
	// attributed only when a brand-new pending row is created.
	const referrerUserId = await resolveReferrer(req, auth.userId);

	// Gifting: the buyer may target another user by username / wallet / id. We
	// resolve it to a real account here (never trusting a raw id from the client),
	// so the service only ever sees a validated recipient user id. An unresolvable
	// recipient fails the whole checkout — better than silently buying for self.
	const recipientRaw = body?.recipient ?? body?.recipient_id ?? null;
	let recipientUserId = null;
	if (recipientRaw != null && String(recipientRaw).trim() !== '') {
		const recipient = await resolveRecipient(String(recipientRaw));
		if (!recipient) {
			return error(res, 400, 'recipient_not_found', 'no user matches that username or wallet');
		}
		if (recipient.id === auth.userId) {
			return error(res, 400, 'cannot_gift_self', 'you already own purchases you make for yourself');
		}
		recipientUserId = recipient.id;
	}

	// The service owns the purchase quote: price lookup, payout resolution,
	// already-owned short-circuit, idempotent pending reuse, fee split, and the
	// persisted skill_purchases row. The handler stays at the HTTP + transport
	// layer (gasless sponsorship) on top of that quote.
	const service = new MonetizationService(auth);
	let result;
	try {
		result = await service.preparePurchaseTransaction(agentId, skill, { durationHours, referrerUserId, recipientUserId, payAmount });
	} catch (e) {
		if (e.status) return error(res, e.status, e.code, e.message);
		throw e;
	}

	if (result.already_owned) return json(res, 200, { data: result });

	const { already_owned, ...quote } = result;

	// Gasless checkout: when the buyer's wallet is connected and this is a Solana
	// purchase, the platform builds the SPL transfer as a fee-payer-sponsored
	// VersionedTransaction and pre-signs it. The buyer adds only their authority
	// signature in the wallet — no SOL required. Falls back to a buyer-pays
	// transaction (transaction = null) when no payer is configured or for the
	// mobile QR path. The split here matches exactly what confirm verifies.
	let gaslessBlock = {};
	if (buyerPublicKey && quote.chain === 'solana') {
		try {
			const connection = solanaConnection({ url: SOLANA_RPC, commitment: 'confirmed' });
			const prepared = await buildGaslessPurchaseTx({
				connection,
				buyerPublicKey,
				recipient: quote.recipient,
				mint: quote.currency_mint,
				creatorAtomics: BigInt(quote.creator_amount),
				reference: quote.reference,
				decimals: quote.mint_decimals,
				platformFeeAtomics: quote.fee ? BigInt(quote.fee.amount) : 0n,
				platformFeeWallet: quote.fee?.recipient ?? null,
			});
			if (prepared) {
				gaslessBlock = { transaction: prepared.transaction, gasless: true, fee_payer: prepared.feePayer };
			}
		} catch (e) {
			// Never block checkout on the sponsorship optimization — the buyer can
			// still build and pay for the transaction themselves.
			await logEvent(quote.reference, 'gasless_prepare_failed', { reason: e?.message });
		}
	}

	return json(res, 201, { data: { ...quote, ...gaslessBlock } });
}

// ── Status ─────────────────────────────────────────────────────────────────

async function handleStatus(req, res, reference) {
	if (cors(req, res, { methods: 'GET,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['GET'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	const rl = await limits.widgetRead(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const [row] = await sql`
		SELECT reference, agent_id, skill, status, tx_signature, confirmed_at,
		       amount, currency_mint, chain
		FROM skill_purchases
		WHERE reference = ${reference} AND user_id = ${auth.userId}
	`;
	if (!row) return error(res, 404, 'not_found', 'purchase not found');

	return json(res, 200, { data: row }, { 'cache-control': 'no-store' });
}

// ── Confirm ────────────────────────────────────────────────────────────────

async function handleConfirm(req, res, reference) {
	if (cors(req, res, { methods: 'POST,OPTIONS', credentials: true })) return;
	if (!method(req, res, ['POST'])) return;

	const auth = await resolveAuth(req);
	if (!auth) return error(res, 401, 'unauthorized', 'sign in required');

	if (!(await requireCsrf(req, res, auth.userId))) return;

	const rl = await limits.authIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	// EVM purchases settle by a tx hash the buyer submits in the confirm body;
	// Solana scans the chain by reference and ignores it. Read it
	// unconditionally — the service enforces "EVM requires a tx_hash".
	const body = await readJson(req).catch(() => null);
	const txHash = body?.tx_hash || body?.txHash || null;

	const service = new MonetizationService(auth);
	let result;
	try {
		result = await service.confirmPurchase(reference, { txHash });
	} catch (e) {
		if (e.status) return error(res, e.status, e.code, e.message);
		throw e;
	}

	if (result.status === 'pending') {
		return json(res, 200, { data: { status: 'pending' } });
	}
	if (result.status === 'tipped') {
		return error(res, 409, 'transfer_mismatch', result.message || 'on-chain transfer did not match expected', {
			status: 'tipped',
			tipped_amount: result.tipped_amount,
			tx_signature: result.tx_signature,
		});
	}
	if (result.status === 'mismatch') {
		return error(res, 409, 'transfer_mismatch', result.message || 'no matching transfer found');
	}
	if (result.status === 'expired') {
		return error(res, 410, 'purchase_expired', 'this pending purchase expired; please start a new one');
	}
	return json(res, 200, { data: { status: 'confirmed', tx_signature: result.tx_signature } });
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Look up the referrer who sent the buyer here. Two paths:
//   1. ?ref=<code> querystring — buyer arrived via a referral link.
//   2. users.referred_by_id — buyer signed up under someone.
async function resolveReferrer(req, buyerUserId) {
	const url = new URL(req.url, 'http://x');
	const code = normalizeReferralCode(url.searchParams.get('ref'));
	if (code) {
		const [u] = await sql`SELECT id FROM users WHERE UPPER(referral_code) = ${code} AND deleted_at IS NULL LIMIT 1`;
		if (u && u.id !== buyerUserId) return u.id;
	}
	const [me] = await sql`SELECT referred_by_id FROM users WHERE id = ${buyerUserId}`;
	if (me?.referred_by_id && me.referred_by_id !== buyerUserId) return me.referred_by_id;
	return null;
}
