// POST /api/embed/gate-verify
//
// Two-phase SIWS wallet-ownership proof for a token-gated embed, mirroring
// api/scene/gate-check.js's phase1 (nonce)/phase2 (signature + on-chain check)
// shape so the two gating systems feel like one product even though they're
// stored separately (embed_gates vs. scene_gates).
//
// Phase 1 — { assetId, walletAddress } → { message, gate }
//   Issues a one-time nonce embedded in a human-readable SIWS message the
//   caller's wallet signs. Nothing is granted yet.
//
// Phase 2 — { assetId, walletAddress, signature, message } → { allowed, ... }
//   Verifies the ed25519 signature, burns the nonce, then reads the wallet's
//   REAL on-chain SPL balance for the gate's mint (never a client-reported
//   number). On success mints a short-lived signed access token
//   (api/_lib/embed-gate-token.js) that api/embed/resolve.js accepts in place
//   of re-running the chain read on every asset fetch.
//
// Anti-abuse: rate-limited per IP (flood guard) AND per wallet (the bucket
// that actually bounds a determined attacker, since IPs are cheap to rotate
// but a wallet's signing key is not).
import { z } from 'zod';
import { sql } from '../_lib/db.js';
import { cors, json, method, readJson, wrap, error, rateLimited } from '../_lib/http.js';
import { limits, clientIp } from '../_lib/rate-limit.js';
import { randomToken } from '../_lib/crypto.js';
import { verifySiwsSignature } from '../_lib/siws.js';
import { parse } from '../_lib/validate.js';
import { readEmbedGateByAsset, getSplTokenBalance, meetsGateThreshold } from '../_lib/embed-gate.js';
import { signEmbedGateToken, EMBED_GATE_TOKEN_TTL_S } from '../_lib/embed-gate-token.js';

const NONCE_TTL_SEC = 10 * 60;

const phase1Schema = z.object({
	assetId: z.string().trim().min(3).max(80),
	walletAddress: z.string().trim().min(1).max(128),
});

const phase2Schema = z.object({
	assetId: z.string().trim().min(3).max(80),
	walletAddress: z.string().trim().min(1).max(128),
	signature: z.string().min(1).max(512),
	message: z.string().min(1).max(1024),
});

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'POST,OPTIONS', origins: '*' })) return;
	if (!method(req, res, ['POST'])) return;
	res.setHeader('cache-control', 'no-store');

	const rl = await limits.embedGateVerifyIp(clientIp(req));
	if (!rl.success) return rateLimited(res, rl);

	const raw = await readJson(req);
	if (raw && raw.signature != null) return handlePhase2(res, raw);
	return handlePhase1(res, raw);
});

async function handlePhase1(res, raw) {
	const body = parse(phase1Schema, raw);

	const gate = await readEmbedGateByAsset(body.assetId);
	if (!gate) return error(res, 404, 'not_found', 'this embed is not gated');

	let nonce = '';
	while (nonce.length < 16) {
		nonce += randomToken(20).replace(/[^A-Za-z0-9]/g, '');
	}
	nonce = nonce.slice(0, 16);

	await sql`
		insert into embed_gate_nonces (nonce, gate_id, address, expires_at)
		values (${nonce}, ${gate.id}, ${body.walletAddress}, now() + ${`${NONCE_TTL_SEC} seconds`}::interval)
	`;

	const message = [
		'three.ws token-gated embed verification.',
		'',
		`Asset: ${body.assetId}`,
		`Wallet: ${body.walletAddress}`,
		`Nonce: ${nonce}`,
		`Issued At: ${new Date().toISOString()}`,
	].join('\n');

	return json(res, 200, {
		message,
		chain: gate.chain,
		gate: { mint: gate.mint, minAmount: Number(gate.min_amount) },
	});
}

async function handlePhase2(res, raw) {
	const body = parse(phase2Schema, raw);

	const walletRl = await limits.embedGateVerifyWallet(body.walletAddress);
	if (!walletRl.success) return rateLimited(res, walletRl);

	const gate = await readEmbedGateByAsset(body.assetId);
	if (!gate) return error(res, 404, 'not_found', 'this embed is not gated');

	let valid;
	try {
		valid = verifySiwsSignature(body.message, body.signature, body.walletAddress);
	} catch {
		return error(res, 401, 'invalid_signature', 'Solana signature verification failed');
	}
	if (!valid) return error(res, 401, 'invalid_signature', 'signature does not match wallet');

	const nonceMatch = body.message.match(/^Nonce: (.+)$/m);
	if (!nonceMatch) return error(res, 400, 'invalid_message', 'nonce not found in message');
	const nonce = nonceMatch[1].trim();

	const [nonceRow] = await sql`
		select nonce, gate_id, address, expires_at, consumed_at
		from embed_gate_nonces where nonce = ${nonce} limit 1
	`;
	if (!nonceRow) return error(res, 400, 'invalid_nonce', 'unknown nonce');
	if (nonceRow.consumed_at) return error(res, 400, 'nonce_reused', 'nonce already used');
	if (new Date(nonceRow.expires_at) < new Date()) return error(res, 400, 'nonce_expired', 'nonce expired — restart verification');
	if (nonceRow.gate_id !== gate.id) return error(res, 400, 'invalid_nonce', 'nonce gate mismatch');
	if (nonceRow.address !== body.walletAddress) return error(res, 400, 'invalid_nonce', 'nonce wallet mismatch');

	const burned = await sql`
		update embed_gate_nonces set consumed_at = now()
		where nonce = ${nonce} and consumed_at is null
		returning nonce
	`;
	if (!burned[0]) return error(res, 400, 'nonce_reused', 'nonce already used');

	const minAmount = Number(gate.min_amount);

	let balance;
	try {
		balance = await getSplTokenBalance(body.walletAddress, gate.mint);
	} catch (err) {
		return json(res, 200, {
			allowed: false,
			reason: err?.message || 'balance check failed — try again',
			minAmount,
			mint: gate.mint,
		});
	}

	if (!meetsGateThreshold(balance, minAmount)) {
		return json(res, 200, {
			allowed: false,
			reason: `insufficient balance: hold ${minAmount}, have ${balance}`,
			amount: balance,
			minAmount,
			mint: gate.mint,
		});
	}

	const accessToken = await signEmbedGateToken({
		gateId: gate.id,
		assetId: body.assetId,
		wallet: body.walletAddress,
		mint: gate.mint,
		minAmount,
		amount: balance,
	});

	return json(res, 200, {
		allowed: true,
		accessToken,
		expiresIn: EMBED_GATE_TOKEN_TTL_S,
		amount: balance,
		minAmount,
		mint: gate.mint,
	});
}
