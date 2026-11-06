/**
 * Short-lived, HMAC-signed download token for `GET /api/vault/download`
 * (prompt 12/13). `POST /api/vault/unlock` (11) already does the expensive
 * work — verify the buyer's signature, read the contract's `Granted` sale
 * state, resolve the Greenfield refs — exactly once per unlock call. Ciphertext
 * bytes can be multiple MB and a buyer's client may need to retry the download
 * (flaky connection, a second tab) without re-signing a wallet message every
 * time (the unlock message's nonce is also single-use — see
 * `vault-unlock-auth.js` — so it CAN'T be replayed for a second purpose).
 * Rather than either (a) making the buyer sign twice, or (b) carving an
 * exemption into the unlock replay guard, `unlock.js` mints one of these
 * alongside its wrapped-key response and `download.js` accepts it in place of
 * a fresh signature — same shape as `forge-job-token.js`'s `f1.<payload>.<sig>`
 * job-handle codec (HMAC-SHA256 over `env.JWT_SECRET`, `timingSafeEqual`
 * verification), reused here rather than reinvented.
 *
 * This token is NOT a substitute for the on-chain authorization check —
 * `download.js` re-reads `saleIdOf`/`sales` fresh on every call (never trusts
 * the token alone) exactly like `unlock.js` does, so a revoked/expired grant
 * still denies the download even with a structurally-valid token.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

import { env } from '../env.js';

const TOKEN_TTL_MS = 15 * 60 * 1000; // comfortably longer than a large-GLB download + one retry

function sign(payload) {
	return createHmac('sha256', env.JWT_SECRET).update(payload).digest('base64url');
}

/**
 * @param {{ objectId:string, buyer:string, network:string }} p
 * @returns {string} `vd1.<payload>.<sig>`
 */
export function encodeVaultDownloadToken({ objectId, buyer, network }) {
	const payload = Buffer.from(
		JSON.stringify({ o: objectId, b: buyer.toLowerCase(), n: network, e: Date.now() + TOKEN_TTL_MS }),
		'utf8',
	).toString('base64url');
	return `vd1.${payload}.${sign(payload)}`;
}

/**
 * @param {string} token
 * @returns {{ objectId:string, buyer:string, network:string, expiresAt:number }|null} null on any invalid/expired/tampered token
 */
export function decodeVaultDownloadToken(token) {
	if (typeof token !== 'string' || !token.startsWith('vd1.')) return null;
	const parts = token.split('.');
	if (parts.length !== 3) return null;
	const [, payload, sig] = parts;
	if (!payload || !sig) return null;
	try {
		const expected = Buffer.from(sign(payload), 'utf8');
		const actual = Buffer.from(sig, 'utf8');
		if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
		const obj = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
		if (!obj?.o || !obj?.b || !obj?.n || !obj?.e) return null;
		if (Date.now() > obj.e) return null;
		return { objectId: obj.o, buyer: obj.b, network: obj.n, expiresAt: obj.e };
	} catch {
		return null;
	}
}
