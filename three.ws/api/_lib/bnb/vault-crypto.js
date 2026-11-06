/**
 * Vault content-encryption + key-wrapping primitives for the BNB vault track
 * (prompts 08-11). Encrypts a GLB once with a random per-object AES-256-GCM
 * content key, then wraps that content key to a specific buyer's secp256k1
 * public key (an EVM address's key) so the bytes can sit on a public-ish
 * Storage Provider while only an authorized, paying buyer can ever recover
 * the plaintext. Wire format: `specs/vault-manifest.md`.
 *
 * CLAUDE.md: never hand-roll crypto primitives. Every primitive here comes
 * from an audited library — Node's built-in `crypto` (AES-256-GCM, the same
 * FIPS-validated OpenSSL implementation Node ships) and `@noble/curves` /
 * `@noble/hashes` (already a pinned workspace dependency — see package.json)
 * for secp256k1 ECDH and HKDF-SHA256. The only original code here is the
 * ECIES *composition* (ECDH -> HKDF -> AES-256-GCM), which is unavoidable —
 * composing a key-wrap scheme from primitives is exactly what a library like
 * `eciesjs` also does, and `eciesjs` itself depends on `@noble/curves` +
 * `@noble/hashes`. Since both are already installed and pinned in this repo,
 * building directly on them (rather than adding `eciesjs` as a redundant
 * second dependency graph on top of the same primitives) is the open-source
 * -first, dependency-minimal choice per CLAUDE.md ("check existing workspace
 * dependencies first ... never add a dependency that duplicates one already
 * present"). This is the well-known ECIES construction used by Ethereum
 * tooling (e.g. `eth-crypto`, `eciesjs`): ephemeral-key ECDH over secp256k1,
 * HKDF-SHA256 to derive a symmetric key, AES-256-GCM to encrypt the payload.
 */

import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';

const AES_ALG = 'aes-256-gcm';
const AES_KEY_LEN = 32; // AES-256
const GCM_IV_LEN = 12; // 96-bit nonce, NIST SP 800-38D recommended size
const GCM_TAG_LEN = 16;
const ECDH_SECRET_LEN = 32; // secp256k1 shared x-coordinate

/** HKDF `info` context string — versioned so a future v2 scheme can't collide. */
const ECIES_HKDF_INFO = 'three.ws/bnb-vault/ecies/v1';

/**
 * Typed error for every vault-crypto failure. `code` disambiguates the stage
 * so callers (upload/unlock APIs) can map to the right HTTP status without
 * string-matching messages.
 */
export class VaultCryptoError extends Error {
	/** @param {string} message @param {{ code?: string, cause?: unknown }} [info] */
	constructor(message, info = {}) {
		super(message);
		this.name = 'VaultCryptoError';
		this.code = info.code || 'vault_crypto_error';
		if (info.cause) this.cause = info.cause;
	}
}

/** Coerce a Buffer/Uint8Array/hex-string (with or without `0x`) into a Uint8Array. */
function toBytes(input, label) {
	if (input instanceof Uint8Array) return input;
	if (typeof input === 'string') {
		const hex = input.startsWith('0x') ? input.slice(2) : input;
		if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) {
			throw new VaultCryptoError(`${label} must be a Buffer/Uint8Array or hex string`, { code: 'bad_input' });
		}
		return Uint8Array.from(Buffer.from(hex, 'hex'));
	}
	throw new VaultCryptoError(`${label} must be a Buffer/Uint8Array or hex string`, { code: 'bad_input' });
}

function assertLen(bytes, len, label) {
	if (bytes.length !== len) {
		throw new VaultCryptoError(`${label} must be ${len} bytes, got ${bytes.length}`, { code: 'bad_length' });
	}
	return bytes;
}

/**
 * Normalize any valid secp256k1 public key encoding (33-byte compressed,
 * 65-byte uncompressed, hex string, `0x`-prefixed) to canonical 33-byte
 * compressed form via curve point validation — rejects off-curve/garbage
 * input before it ever reaches ECDH.
 */
function normalizePublicKey(pubKey) {
	const bytes = toBytes(pubKey, 'recipientPubKey');
	try {
		return secp256k1.Point.fromBytes(bytes).toBytes(true);
	} catch (err) {
		throw new VaultCryptoError('recipientPubKey is not a valid secp256k1 point', { code: 'bad_public_key', cause: err });
	}
}

/** Derive the AES-256-GCM key-encryption-key from an ECDH shared secret via HKDF-SHA256. */
function deriveWrapKey(sharedSecretX) {
	return hkdf(sha256, sharedSecretX, undefined, ECIES_HKDF_INFO, AES_KEY_LEN);
}

/**
 * Encrypt a GLB's raw bytes with a fresh random AES-256-GCM content key.
 * @param {Uint8Array} glbBytes
 * @returns {{ ciphertext: Buffer, contentKey: Buffer, iv: Buffer, authTag: Buffer, sha256OfPlaintext: string }}
 */
export function encryptGlb(glbBytes) {
	const plaintext = toBytes(glbBytes, 'glbBytes');
	if (plaintext.length === 0) {
		throw new VaultCryptoError('glbBytes must not be empty', { code: 'bad_input' });
	}
	const contentKey = randomBytes(AES_KEY_LEN);
	const iv = randomBytes(GCM_IV_LEN);
	const cipher = createCipheriv(AES_ALG, contentKey, iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const authTag = cipher.getAuthTag();
	const sha256OfPlaintext = createHash('sha256').update(plaintext).digest('hex');
	return { ciphertext, contentKey, iv, authTag, sha256OfPlaintext };
}

/**
 * Decrypt a GLB envelope. Verifies the GCM auth tag (tampered ciphertext or
 * wrong key throws a typed `VaultCryptoError{code:'auth_failed'}`, never
 * silent garbage) and the plaintext sha256 if `expectedSha256` is given.
 * @param {{ ciphertext: Uint8Array, contentKey: Uint8Array, iv: Uint8Array, authTag: Uint8Array }} envelope
 * @param {{ expectedSha256?: string }} [opts]
 * @returns {Buffer} the original glbBytes
 */
export function decryptGlb({ ciphertext, contentKey, iv, authTag }, opts = {}) {
	const key = assertLen(toBytes(contentKey, 'contentKey'), AES_KEY_LEN, 'contentKey');
	const nonce = assertLen(toBytes(iv, 'iv'), GCM_IV_LEN, 'iv');
	const tag = assertLen(toBytes(authTag, 'authTag'), GCM_TAG_LEN, 'authTag');
	const ct = toBytes(ciphertext, 'ciphertext');

	const decipher = createDecipheriv(AES_ALG, key, nonce);
	decipher.setAuthTag(tag);
	let plaintext;
	try {
		plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
	} catch (err) {
		throw new VaultCryptoError('GCM authentication failed — ciphertext or key tampered/incorrect', {
			code: 'auth_failed',
			cause: err,
		});
	}

	if (opts.expectedSha256) {
		const actual = createHash('sha256').update(plaintext).digest('hex');
		if (actual !== opts.expectedSha256) {
			throw new VaultCryptoError('Decrypted plaintext sha256 does not match expected value', {
				code: 'sha256_mismatch',
			});
		}
	}
	return plaintext;
}

/**
 * Wrap a 32-byte content key to a recipient's secp256k1 public key (ECIES):
 * generate an ephemeral keypair, ECDH with the recipient's public key,
 * HKDF-SHA256 the shared x-coordinate into an AES-256-GCM key, encrypt the
 * content key under it. Only the holder of the matching private key can
 * `unwrapKey` — the content key is never exposed publicly.
 * @param {Uint8Array} contentKey 32-byte AES key from `encryptGlb`.
 * @param {Uint8Array|string} recipientPubKey secp256k1 public key (compressed/uncompressed/hex).
 * @returns {{ ephemeralPublicKey: Buffer, iv: Buffer, authTag: Buffer, ciphertext: Buffer }}
 */
export function wrapKey(contentKey, recipientPubKey) {
	const key = assertLen(toBytes(contentKey, 'contentKey'), AES_KEY_LEN, 'contentKey');
	const recipientPub = normalizePublicKey(recipientPubKey);

	const ephemeral = secp256k1.keygen();
	const shared = secp256k1.getSharedSecret(ephemeral.secretKey, recipientPub, true);
	const sharedX = shared.subarray(1, 1 + ECDH_SECRET_LEN); // drop the 0x02/0x03 parity prefix
	const wrapKeyBytes = deriveWrapKey(sharedX);

	const iv = randomBytes(GCM_IV_LEN);
	const cipher = createCipheriv(AES_ALG, Buffer.from(wrapKeyBytes), iv);
	const ciphertext = Buffer.concat([cipher.update(Buffer.from(key)), cipher.final()]);
	const authTag = cipher.getAuthTag();

	return {
		ephemeralPublicKey: Buffer.from(ephemeral.publicKey), // compressed, 33 bytes
		iv,
		authTag,
		ciphertext,
	};
}

/**
 * Unwrap a content key previously wrapped by `wrapKey`, using the
 * recipient's secp256k1 private key. Wrong private key derives a different
 * shared secret and therefore a different AES key — GCM auth tag check
 * fails and this throws `VaultCryptoError{code:'auth_failed'}`, never
 * silently returning garbage bytes.
 * @param {{ ephemeralPublicKey: Uint8Array, iv: Uint8Array, authTag: Uint8Array, ciphertext: Uint8Array }} wrapped
 * @param {Uint8Array|string} recipientPrivKey 32-byte secp256k1 private key (hex or bytes).
 * @returns {Buffer} the original 32-byte content key
 */
export function unwrapKey(wrapped, recipientPrivKey) {
	const privKey = assertLen(toBytes(recipientPrivKey, 'recipientPrivKey'), AES_KEY_LEN, 'recipientPrivKey');
	const ephemeralPub = toBytes(wrapped.ephemeralPublicKey, 'ephemeralPublicKey');
	const iv = assertLen(toBytes(wrapped.iv, 'iv'), GCM_IV_LEN, 'iv');
	const authTag = assertLen(toBytes(wrapped.authTag, 'authTag'), GCM_TAG_LEN, 'authTag');
	const ciphertext = toBytes(wrapped.ciphertext, 'ciphertext');

	let shared;
	try {
		shared = secp256k1.getSharedSecret(privKey, ephemeralPub, true);
	} catch (err) {
		throw new VaultCryptoError('Invalid recipient private key or ephemeral public key', {
			code: 'bad_ecdh_input',
			cause: err,
		});
	}
	const sharedX = shared.subarray(1, 1 + ECDH_SECRET_LEN);
	const wrapKeyBytes = deriveWrapKey(sharedX);

	const decipher = createDecipheriv(AES_ALG, Buffer.from(wrapKeyBytes), Buffer.from(iv));
	decipher.setAuthTag(Buffer.from(authTag));
	try {
		return Buffer.concat([decipher.update(Buffer.from(ciphertext)), decipher.final()]);
	} catch (err) {
		throw new VaultCryptoError('Key-unwrap authentication failed — wrong recipient key or tampered wrapped key', {
			code: 'auth_failed',
			cause: err,
		});
	}
}

/**
 * Convenience: derive a secp256k1 keypair (compressed public key) suitable
 * for `wrapKey`/`unwrapKey` recipient testing and manifest examples. Not
 * used for BSC transaction signing — that stays in `chains.js`/callers'
 * own viem accounts; this is purely for the vault key-wrap layer.
 * @returns {{ privateKey: Buffer, publicKey: Buffer }}
 */
export function generateVaultKeypair() {
	const kp = secp256k1.keygen();
	return { privateKey: Buffer.from(kp.secretKey), publicKey: Buffer.from(kp.publicKey) };
}

export const VAULT_CRYPTO_PARAMS = Object.freeze({
	alg: 'AES-256-GCM',
	keyLenBytes: AES_KEY_LEN,
	ivLenBytes: GCM_IV_LEN,
	authTagLenBytes: GCM_TAG_LEN,
	ecies: {
		curve: 'secp256k1',
		kdf: 'HKDF-SHA256',
		info: ECIES_HKDF_INFO,
	},
});
