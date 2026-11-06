// Holder pass verification — the game-server half of holder-gated worlds.
//
// The Vercel API (api/_lib/holder-pass.js) prices a user's on-chain holding and
// seals { mint, wallet, usd, tier, iat, exp } into an HMAC-SHA256 token. This
// process re-derives the signature with the same shared secret and checks it,
// so WalkRoom.onAuth can admit a client into a coin's holder world without ever
// touching Solana RPC or a price feed. Keep this byte-for-byte compatible with
// the signer.

import crypto from 'node:crypto';

const DEV_SECRET = 'three-ws-holder-pass-dev-secret';

let _warned = false;
function secret() {
	const s = process.env.HOLDER_PASS_SECRET;
	if (s) return s;
	// Fail closed in production: never verify against a publicly-known secret.
	if (process.env.NODE_ENV === 'production') {
		throw new Error(
			'[holder-pass] HOLDER_PASS_SECRET is required in production — refusing to verify passes with the dev secret.',
		);
	}
	if (!_warned) {
		_warned = true;
		console.warn(
			'[holder-pass] HOLDER_PASS_SECRET is not set — using the insecure dev secret. ' +
				'Set HOLDER_PASS_SECRET in production or holder worlds can be entered with a forged pass.',
		);
	}
	return DEV_SECRET;
}

function b64url(buf) {
	return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function hmac(body) {
	return b64url(crypto.createHmac('sha256', secret()).update(body).digest());
}

// Constant-time compare so a forged token can't be brute-forced byte by byte.
function safeEqual(a, b) {
	const ba = Buffer.from(a);
	const bb = Buffer.from(b);
	if (ba.length !== bb.length) return false;
	return crypto.timingSafeEqual(ba, bb);
}

/**
 * Verify a holder pass and return its payload, or null if the token is missing,
 * malformed, tampered with, or expired.
 * @param {unknown} token
 * @returns {{ mint: string, wallet: string, usd: number, amount?: number, minUsd?: number, minTokens?: number, tier: string, iat: number, exp: number } | null}
 */
export function verifyHolderPass(token) {
	if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return null;
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!safeEqual(sig, hmac(body))) return null;

	let payload;
	try {
		payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object') return null;
	if (payload.tier !== 'holders') return null;
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
	// Reject passes issued in the future (clock skew / forged iat) and ones whose
	// lifetime exceeds the issuer's TTL — a defence against a tampered exp slipping
	// past the HMAC if the secret ever leaks.
	const now = Date.now() / 1000;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	if (payload.exp - payload.iat > 15 * 60) return null;
	if (typeof payload.mint !== 'string' || !payload.mint) return null;
	// onAuth stores these on client.userData and drives in-world affordances off
	// them, so they must be present and well-typed, not merely signed.
	if (typeof payload.wallet !== 'string' || !payload.wallet) return null;
	if (typeof payload.usd !== 'number' || !Number.isFinite(payload.usd) || payload.usd < 0) return null;
	// minUsd is signed by the issuer; if present it must be a sane number (the
	// game server displays it as the gate requirement). Tolerate its absence so a
	// pass minted by an older signer during a rollout still verifies.
	if (payload.minUsd != null && (typeof payload.minUsd !== 'number' || !Number.isFinite(payload.minUsd) || payload.minUsd < 0)) return null;
	// minTokens (the creator-set threshold) and amount (the verified holding) are
	// optional — a pass from an older signer during a rollout omits them — but when
	// present must be sane numbers, since the game server displays them as the gate.
	if (payload.minTokens != null && (typeof payload.minTokens !== 'number' || !Number.isFinite(payload.minTokens) || payload.minTokens < 0)) return null;
	if (payload.amount != null && (typeof payload.amount !== 'number' || !Number.isFinite(payload.amount) || payload.amount < 0)) return null;
	return payload;
}

/**
 * Verify a $THREE tier pass and return its payload, or null. Byte-for-byte
 * compatible with signTierPass() in api/_lib/three-tier.js, so the game server can
 * gate private/branded worlds on a holder's tier LEVEL without touching Solana RPC
 * or a price feed — the same trust model as holder passes.
 * @param {unknown} token
 * @returns {{ kind:'three-tier', wallet:string, level:number, tierId:string, usd:number, iat:number, exp:number } | null}
 */
export function verifyTierPass(token) {
	if (typeof token !== 'string' || token.length < 16 || token.length > 4096) return null;
	const dot = token.indexOf('.');
	if (dot <= 0) return null;
	const body = token.slice(0, dot);
	const sig = token.slice(dot + 1);
	if (!safeEqual(sig, hmac(body))) return null;

	let payload;
	try {
		payload = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
	} catch {
		return null;
	}
	if (!payload || typeof payload !== 'object') return null;
	if (payload.kind !== 'three-tier') return null;
	if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
	const now = Date.now() / 1000;
	if (typeof payload.iat !== 'number' || payload.iat > now + 60) return null;
	if (payload.exp - payload.iat > 15 * 60) return null;
	if (typeof payload.wallet !== 'string' || !payload.wallet) return null;
	if (typeof payload.level !== 'number' || !Number.isInteger(payload.level) || payload.level < 0) return null;
	if (typeof payload.tierId !== 'string' || !payload.tierId) return null;
	if (typeof payload.usd !== 'number' || !Number.isFinite(payload.usd) || payload.usd < 0) return null;
	return payload;
}
