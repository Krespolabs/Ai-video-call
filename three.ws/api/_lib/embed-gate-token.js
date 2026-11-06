// Short-lived, HMAC-signed access token for a token-gated 3D embed.
//
// Anti-abuse design: a visitor only pays the cost of a real on-chain balance
// read + wallet signature ONCE per TTL window. api/embed/gate-verify.js mints
// this token after a server-verified SPL balance check clears the gate's
// min_amount; api/embed/resolve.js accepts it in place of re-checking the
// chain on every asset fetch, and rejects it once `exp` passes — the widget
// (public/embed/v1.js) then re-runs the verify flow, so a sold-off wallet
// can't keep viewing gated content past the token's lifetime.
//
// Format mirrors api/_lib/forge-job-token.js: `eg1.<base64url(payload)>.<sig>`,
// HMAC-SHA256 over a domain-tagged payload with env.JWT_SECRET — the same
// canonical signing secret used across the platform's other short-lived
// tokens (holder-pass.js, forge-job-token.js). No new secret to provision.

import { hmacSha256, constantTimeEquals } from './crypto.js';
import { env } from './env.js';

// Long enough that a visitor isn't re-signing on every page interaction; short
// enough that a wallet that sells off its holding loses access promptly.
export const EMBED_GATE_TOKEN_TTL_S = 10 * 60;

const PREFIX = 'eg1';
const DOMAIN = 'three.ws-embed-gate-token-v1';

function b64urlEncode(str) {
	return Buffer.from(str, 'utf8').toString('base64url');
}

function b64urlDecode(str) {
	return Buffer.from(str, 'base64url').toString('utf8');
}

/**
 * Seal a verified gate check into a compact, tamper-evident token.
 * @param {{ gateId:string, assetId:string, wallet:string, mint:string, minAmount:number, amount:number }} claims
 * @returns {Promise<string>}
 */
export async function signEmbedGateToken({ gateId, assetId, wallet, mint, minAmount, amount }) {
	const now = Math.floor(Date.now() / 1000);
	const payload = {
		g: gateId,
		a: assetId,
		w: wallet,
		m: mint,
		min: Math.max(0, Number(minAmount) || 0),
		amt: Math.max(0, Number(amount) || 0),
		iat: now,
		exp: now + EMBED_GATE_TOKEN_TTL_S,
	};
	const body = b64urlEncode(JSON.stringify(payload));
	const sig = await hmacSha256(env.JWT_SECRET, `${DOMAIN}:${body}`);
	return `${PREFIX}.${body}.${sig}`;
}

/**
 * Verify a token's signature and expiry. Optionally pin it to the exact
 * gate/asset it must have been issued for — resolve.js and gate-verify.js
 * both pass `assetId` and `gateId` so a token from a superseded gate (the
 * creator changed the requirement) never verifies against the new one.
 * @returns {Promise<{gateId,assetId,wallet,mint,minAmount,amount,iat,exp}|null>}
 */
export async function verifyEmbedGateToken(token, { assetId, gateId } = {}) {
	if (typeof token !== 'string' || !token.startsWith(`${PREFIX}.`)) return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [, body, sig] = parts;
	if (!body || !sig) return null;

	let expected;
	try {
		expected = await hmacSha256(env.JWT_SECRET, `${DOMAIN}:${body}`);
	} catch {
		return null;
	}
	if (!constantTimeEquals(expected, sig)) return null;

	let payload;
	try {
		payload = JSON.parse(b64urlDecode(body));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object') return null;

	const now = Math.floor(Date.now() / 1000);
	if (!Number.isFinite(payload.exp) || payload.exp < now) return null;
	if (assetId && payload.a !== assetId) return null;
	if (gateId && payload.g !== gateId) return null;

	return {
		gateId: payload.g,
		assetId: payload.a,
		wallet: payload.w,
		mint: payload.m,
		minAmount: Number(payload.min) || 0,
		amount: Number(payload.amt) || 0,
		iat: payload.iat,
		exp: payload.exp,
	};
}
