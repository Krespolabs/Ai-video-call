/**
 * The canonical `POST /api/vault/unlock` request-message format — extracted
 * from `vault-unlock-auth.js` (prompt 11) into its own dependency-free module
 * so the vault UI (prompt 12) can import the EXACT same `buildVaultUnlockMessage`/
 * `parseVaultUnlockMessage` client-side without pulling in `vault-unlock-auth.js`'s
 * `../redis.js` import (a Node-only replay-lock dependency that would otherwise
 * get bundled into the browser for no reason — this module has zero Node-only
 * APIs, just string formatting, so Vite bundles it unmodified for both server
 * and client, matching the existing isomorphic pattern `src/bnb/move-sender.js`
 * already uses for `api/_lib/bnb/world-moves.js`). `vault-unlock-auth.js`
 * re-exports both functions from here — this is the single source of truth,
 * never redefine the message shape elsewhere.
 */

export class VaultUnlockMessageError extends Error {
	/** @param {string} message @param {{ code?: string }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'VaultUnlockMessageError';
		this.code = info.code || 'bad_message';
	}
}

/**
 * Build the canonical unlock-request message. The buyer's wallet signs this
 * exact string (EIP-191 personal-sign) to prove control of `buyer` and, via
 * signature public-key recovery, to receive the wrap-recipient key.
 * @param {{ objectId:string, buyer:string, network:string, nonce:string, issuedAt:string }} p
 */
export function buildVaultUnlockMessage({ objectId, buyer, network, nonce, issuedAt }) {
	return [
		'three.ws vault unlock request',
		'',
		`Object: ${objectId}`,
		`Buyer: ${buyer}`,
		`Network: ${network}`,
		`Nonce: ${nonce}`,
		`Issued At: ${issuedAt}`,
	].join('\n');
}

/** Parse the canonical unlock message back into its fields. Throws if the shape doesn't match. */
export function parseVaultUnlockMessage(message) {
	const lines = String(message || '').split('\n');
	const field = (label) => {
		const line = lines.find((l) => l.startsWith(`${label}: `));
		if (!line) throw new VaultUnlockMessageError(`unlock message is missing "${label}:"`, { code: 'bad_message' });
		return line.slice(label.length + 2).trim();
	};
	if (lines[0] !== 'three.ws vault unlock request') {
		throw new VaultUnlockMessageError('unlock message has the wrong preamble', { code: 'bad_message' });
	}
	return {
		objectId: field('Object'),
		buyer: field('Buyer'),
		network: field('Network'),
		nonce: field('Nonce'),
		issuedAt: field('Issued At'),
	};
}

/** A fresh nonce for a new unlock request — 16 random bytes, hex-encoded (browser + Node safe). */
export function generateUnlockNonce() {
	const bytes = new Uint8Array(16);
	if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
