/**
 * Browser-safe half of the vault crypto envelope (prompt 12/13). The
 * server-side implementation (`api/_lib/bnb/vault-crypto.js`) uses Node's
 * `node:crypto` (AES-256-GCM) which does not exist in a Vite-bundled browser
 * build — this module reimplements the SAME two operations a buyer's client
 * needs (`unwrapKey`, `decryptGlb`) using only browser-native/isomorphic
 * primitives already in this workspace's dependency graph:
 *
 *   - `@noble/curves`/`@noble/hashes` (already bundled client-side elsewhere,
 *     e.g. `src/agent-eth-vanity-card.js`) for the secp256k1 ECDH + HKDF-SHA256
 *     step — byte-for-byte the same construction as the server's `unwrapKey`
 *     (same curve, same HKDF info string `ECIES_HKDF_INFO`).
 *   - `window.crypto.subtle` (Web Crypto, native AES-256-GCM) for the content
 *     decrypt step, instead of Node's `createDecipheriv`.
 *
 * Every constant here (HKDF info string, key/IV/tag lengths) MUST stay
 * byte-identical to `api/_lib/bnb/vault-crypto.js` / `specs/vault-manifest.md`
 * — a buyer's unwrap/decrypt would silently produce garbage (caught loudly by
 * GCM auth-tag verification, never silent) if they drifted.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const AES_KEY_LEN = 32;
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const ECDH_SECRET_LEN = 32;
const ECIES_HKDF_INFO = 'three.ws/bnb-vault/ecies/v1';

export class VaultCryptoBrowserError extends Error {
	/** @param {string} message @param {{ code?: string, cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'VaultCryptoBrowserError';
		this.code = info.code || 'vault_crypto_error';
		if (info.cause) this.cause = info.cause;
	}
}

/** Coerce a `0x`-hex string or Uint8Array into a Uint8Array. */
function toBytes(input, label) {
	if (input instanceof Uint8Array) return input;
	if (typeof input === 'string') {
		const hex = input.startsWith('0x') ? input.slice(2) : input;
		if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
			throw new VaultCryptoBrowserError(`${label} must be a Uint8Array or hex string`, { code: 'bad_input' });
		}
		const out = new Uint8Array(hex.length / 2);
		for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
		return out;
	}
	throw new VaultCryptoBrowserError(`${label} must be a Uint8Array or hex string`, { code: 'bad_input' });
}

function assertLen(bytes, len, label) {
	if (bytes.length !== len) {
		throw new VaultCryptoBrowserError(`${label} must be ${len} bytes, got ${bytes.length}`, { code: 'bad_length' });
	}
	return bytes;
}

function deriveWrapKey(sharedSecretX) {
	return hkdf(sha256, sharedSecretX, undefined, ECIES_HKDF_INFO, AES_KEY_LEN);
}

/**
 * Unwrap a content key previously wrapped by the server's `wrapKey` (ECIES),
 * using the recipient's own secp256k1 private key. Wrong key -> GCM auth
 * check fails -> throws, never returns garbage bytes.
 * @param {{ ephemeralPublicKey:string, iv:string, authTag:string, ciphertext:string }} wrapped 0x-hex fields (as returned by POST /api/vault/unlock)
 * @param {string} recipientPrivKeyHex 0x-hex 32-byte secp256k1 private key
 * @returns {Promise<Uint8Array>} the 32-byte AES content key
 */
export async function unwrapKey(wrapped, recipientPrivKeyHex) {
	const privKey = assertLen(toBytes(recipientPrivKeyHex, 'recipientPrivKey'), AES_KEY_LEN, 'recipientPrivKey');
	const ephemeralPub = toBytes(wrapped.ephemeralPublicKey, 'ephemeralPublicKey');
	const iv = assertLen(toBytes(wrapped.iv, 'iv'), GCM_IV_LEN, 'iv');
	const authTag = assertLen(toBytes(wrapped.authTag, 'authTag'), GCM_TAG_LEN, 'authTag');
	const ciphertext = toBytes(wrapped.ciphertext, 'ciphertext');

	let shared;
	try {
		shared = secp256k1.getSharedSecret(privKey, ephemeralPub, true);
	} catch (err) {
		throw new VaultCryptoBrowserError('invalid recipient private key or ephemeral public key', { code: 'bad_ecdh_input', cause: err });
	}
	const sharedX = shared.subarray(1, 1 + ECDH_SECRET_LEN);
	const wrapKeyBytes = deriveWrapKey(sharedX);

	// Web Crypto's AES-GCM decrypt wants ciphertext+tag concatenated and
	// verifies the tag internally — matches createDecipheriv+setAuthTag
	// semantics on the server, just a different calling convention.
	const combined = new Uint8Array(ciphertext.length + authTag.length);
	combined.set(ciphertext, 0);
	combined.set(authTag, ciphertext.length);

	let cryptoKey;
	try {
		cryptoKey = await crypto.subtle.importKey('raw', wrapKeyBytes, 'AES-GCM', false, ['decrypt']);
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, tagLength: GCM_TAG_LEN * 8 }, cryptoKey, combined);
		return new Uint8Array(plain);
	} catch (err) {
		throw new VaultCryptoBrowserError('key-unwrap authentication failed — wrong recipient key or tampered wrapped key', {
			code: 'auth_failed',
			cause: err,
		});
	}
}

/**
 * Decrypt a GLB envelope client-side. Verifies the plaintext sha256 against
 * the manifest when `expectedSha256` is given — the buyer's own end-to-end
 * integrity check, independent of anything the server asserts.
 * @param {{ ciphertext:Uint8Array, contentKey:Uint8Array, iv:string, authTag:string }} envelope `iv`/`authTag` as hex (from the manifest, no 0x prefix)
 * @param {{ expectedSha256?: string }} [opts]
 * @returns {Promise<Uint8Array>} the original GLB bytes
 */
export async function decryptGlb({ ciphertext, contentKey, iv, authTag }, opts = {}) {
	const key = assertLen(toBytes(contentKey, 'contentKey'), AES_KEY_LEN, 'contentKey');
	const nonce = assertLen(toBytes(iv, 'iv'), GCM_IV_LEN, 'iv');
	const tag = assertLen(toBytes(authTag, 'authTag'), GCM_TAG_LEN, 'authTag');
	const ct = ciphertext instanceof Uint8Array ? ciphertext : new Uint8Array(ciphertext);

	const combined = new Uint8Array(ct.length + tag.length);
	combined.set(ct, 0);
	combined.set(tag, ct.length);

	let plaintext;
	try {
		const cryptoKey = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: GCM_TAG_LEN * 8 }, cryptoKey, combined);
		plaintext = new Uint8Array(plain);
	} catch (err) {
		throw new VaultCryptoBrowserError('GCM authentication failed — ciphertext or key tampered/incorrect', { code: 'auth_failed', cause: err });
	}

	if (opts.expectedSha256) {
		const actual = await sha256Hex(plaintext);
		if (actual !== opts.expectedSha256) {
			throw new VaultCryptoBrowserError('decrypted plaintext sha256 does not match the manifest', { code: 'sha256_mismatch' });
		}
	}
	return plaintext;
}

/** SHA-256 of arbitrary bytes, lowercase hex — via Web Crypto's native digest. */
export async function sha256Hex(bytes) {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
