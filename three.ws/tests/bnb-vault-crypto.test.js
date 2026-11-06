/**
 * BNB vault crypto envelope — unit tests (prompt 08).
 *
 * Exercises the real AES-256-GCM content-encryption round trip and the real
 * secp256k1 ECIES key-wrap round trip against a tiny but structurally valid
 * synthetic GLB fixture (glTF binary header + minimal JSON chunk) — no
 * mocked crypto anywhere in this suite.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
	encryptGlb,
	decryptGlb,
	wrapKey,
	unwrapKey,
	generateVaultKeypair,
	VaultCryptoError,
	VAULT_CRYPTO_PARAMS,
} from '../api/_lib/bnb/vault-crypto.js';

/**
 * Build a minimal but structurally valid GLB (glTF 2.0 binary container):
 * 12-byte header (magic 'glTF', version 2, total length) + one JSON chunk
 * containing the smallest legal glTF document. Real bytes, real GLB magic —
 * just no geometry, which is fine for a crypto-envelope round-trip proof.
 */
function buildSyntheticGlb() {
	const json = JSON.stringify({ asset: { version: '2.0', generator: 'three.ws-bnb-vault-test' } });
	const jsonBytes = Buffer.from(json, 'utf8');
	const pad = (4 - (jsonBytes.length % 4)) % 4;
	const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc(pad, 0x20)]); // glTF pads JSON with spaces

	const chunkHeader = Buffer.alloc(8);
	chunkHeader.writeUInt32LE(jsonChunk.length, 0);
	chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'

	const totalLength = 12 + chunkHeader.length + jsonChunk.length;
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546c67, 0); // magic 'glTF'
	header.writeUInt32LE(2, 4); // version
	header.writeUInt32LE(totalLength, 8);

	return Buffer.concat([header, chunkHeader, jsonChunk]);
}

describe('encryptGlb / decryptGlb round trip', () => {
	it('decrypts to byte-identical plaintext with matching sha256', () => {
		const glb = buildSyntheticGlb();
		const expectedSha256 = createHash('sha256').update(glb).digest('hex');

		const { ciphertext, contentKey, iv, authTag, sha256OfPlaintext } = encryptGlb(glb);
		expect(sha256OfPlaintext).toBe(expectedSha256);
		expect(contentKey).toHaveLength(32);
		expect(iv).toHaveLength(12);
		expect(authTag).toHaveLength(16);
		expect(ciphertext.equals(glb)).toBe(false); // actually encrypted, not passthrough

		const plaintext = decryptGlb({ ciphertext, contentKey, iv, authTag }, { expectedSha256 });
		expect(plaintext.equals(glb)).toBe(true);
		expect(createHash('sha256').update(plaintext).digest('hex')).toBe(expectedSha256);
	});

	it('rejects empty input', () => {
		expect(() => encryptGlb(Buffer.alloc(0))).toThrow(VaultCryptoError);
	});

	it('tampering one ciphertext byte throws a typed auth error, never garbage bytes', () => {
		const glb = buildSyntheticGlb();
		const { ciphertext, contentKey, iv, authTag } = encryptGlb(glb);
		const tampered = Buffer.from(ciphertext);
		tampered[0] ^= 0xff; // flip one bit's worth of byte

		let caught;
		try {
			decryptGlb({ ciphertext: tampered, contentKey, iv, authTag });
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VaultCryptoError);
		expect(caught.name).toBe('VaultCryptoError');
		expect(caught.code).toBe('auth_failed');
	});

	it('tampering the auth tag also throws a typed auth error', () => {
		const glb = buildSyntheticGlb();
		const { ciphertext, contentKey, iv, authTag } = encryptGlb(glb);
		const tampered = Buffer.from(authTag);
		tampered[0] ^= 0xff;
		expect(() => decryptGlb({ ciphertext, contentKey, iv, authTag: tampered })).toThrow(VaultCryptoError);
	});

	it('rejects a wrong-size content key before ever touching the cipher', () => {
		const glb = buildSyntheticGlb();
		const { ciphertext, iv, authTag } = encryptGlb(glb);
		expect(() => decryptGlb({ ciphertext, contentKey: Buffer.alloc(16), iv, authTag })).toThrow(VaultCryptoError);
	});

	it('rejects a wrong-size IV before ever touching the cipher', () => {
		const glb = buildSyntheticGlb();
		const { ciphertext, contentKey, authTag } = encryptGlb(glb);
		expect(() => decryptGlb({ ciphertext, contentKey, iv: Buffer.alloc(8), authTag })).toThrow(VaultCryptoError);
	});

	it('expectedSha256 mismatch is caught even when GCM auth passes', () => {
		const glb = buildSyntheticGlb();
		const { ciphertext, contentKey, iv, authTag } = encryptGlb(glb);
		expect(() =>
			decryptGlb({ ciphertext, contentKey, iv, authTag }, { expectedSha256: 'deadbeef'.repeat(8) }),
		).toThrow(/sha256/);
	});
});

describe('wrapKey / unwrapKey (ECIES over secp256k1)', () => {
	it('round-trips a content key with a real keypair', () => {
		const { privateKey, publicKey } = generateVaultKeypair();
		const { contentKey } = encryptGlb(buildSyntheticGlb());

		const wrapped = wrapKey(contentKey, publicKey);
		expect(wrapped.ephemeralPublicKey).toHaveLength(33); // compressed point
		expect(wrapped.ciphertext.equals(contentKey)).toBe(false);

		const unwrapped = unwrapKey(wrapped, privateKey);
		expect(unwrapped.equals(contentKey)).toBe(true);
	});

	it('accepts an uncompressed (65-byte) recipient public key too', () => {
		const { privateKey } = generateVaultKeypair();
		const uncompressedPub = Buffer.from(secp256k1.getPublicKey(privateKey, false));
		expect(uncompressedPub).toHaveLength(65);

		const { contentKey } = encryptGlb(buildSyntheticGlb());
		const wrapped = wrapKey(contentKey, uncompressedPub);
		const unwrapped = unwrapKey(wrapped, privateKey);
		expect(unwrapped.equals(contentKey)).toBe(true);
	});

	it('produces a different ephemeral key (and ciphertext) on every wrap call', () => {
		const { publicKey } = generateVaultKeypair();
		const { contentKey } = encryptGlb(buildSyntheticGlb());
		const a = wrapKey(contentKey, publicKey);
		const b = wrapKey(contentKey, publicKey);
		expect(a.ephemeralPublicKey.equals(b.ephemeralPublicKey)).toBe(false);
		expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
	});

	it('unwrapping with the wrong private key fails with a typed auth error, not garbage', () => {
		const recipient = generateVaultKeypair();
		const attacker = generateVaultKeypair();
		const { contentKey } = encryptGlb(buildSyntheticGlb());

		const wrapped = wrapKey(contentKey, recipient.publicKey);

		let caught;
		try {
			unwrapKey(wrapped, attacker.privateKey);
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(VaultCryptoError);
		expect(caught.code).toBe('auth_failed');
	});

	it('rejects a malformed recipient public key', () => {
		const { contentKey } = encryptGlb(buildSyntheticGlb());
		expect(() => wrapKey(contentKey, Buffer.from('not-a-point'))).toThrow(VaultCryptoError);
	});

	it('full envelope + key-wrap pipeline: encrypt -> wrap -> (simulated storage/transfer) -> unwrap -> decrypt', () => {
		const seller = generateVaultKeypair(); // stands in for the buyer's keypair receiving the key
		const glb = buildSyntheticGlb();
		const expectedSha256 = createHash('sha256').update(glb).digest('hex');

		const { ciphertext, contentKey, iv, authTag, sha256OfPlaintext } = encryptGlb(glb);
		expect(sha256OfPlaintext).toBe(expectedSha256);

		const wrapped = wrapKey(contentKey, seller.publicKey);
		// Simulate the wrapped key + ciphertext crossing the wire (JSON-safe hex round trip).
		const wire = {
			ciphertext: Buffer.from(ciphertext).toString('hex'),
			iv: Buffer.from(iv).toString('hex'),
			authTag: Buffer.from(authTag).toString('hex'),
			wrapped: {
				ephemeralPublicKey: Buffer.from(wrapped.ephemeralPublicKey).toString('hex'),
				iv: Buffer.from(wrapped.iv).toString('hex'),
				authTag: Buffer.from(wrapped.authTag).toString('hex'),
				ciphertext: Buffer.from(wrapped.ciphertext).toString('hex'),
			},
		};

		const recoveredContentKey = unwrapKey(wire.wrapped, seller.privateKey);
		const recoveredGlb = decryptGlb(
			{ ciphertext: wire.ciphertext, contentKey: recoveredContentKey, iv: wire.iv, authTag: wire.authTag },
			{ expectedSha256 },
		);
		expect(recoveredGlb.equals(glb)).toBe(true);
	});
});

describe('VAULT_CRYPTO_PARAMS', () => {
	it('publishes the exact algorithm/lengths the manifest spec documents', () => {
		expect(VAULT_CRYPTO_PARAMS.alg).toBe('AES-256-GCM');
		expect(VAULT_CRYPTO_PARAMS.keyLenBytes).toBe(32);
		expect(VAULT_CRYPTO_PARAMS.ivLenBytes).toBe(12);
		expect(VAULT_CRYPTO_PARAMS.authTagLenBytes).toBe(16);
		expect(VAULT_CRYPTO_PARAMS.ecies.curve).toBe('secp256k1');
		expect(VAULT_CRYPTO_PARAMS.ecies.kdf).toBe('HKDF-SHA256');
	});
});
