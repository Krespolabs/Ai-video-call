import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

import { decodeSeedSecret } from '../api/_lib/x402/pay.js';

// The x402 payer key is the single credential behind every ring settle, seed
// call, and autonomous spend. In July 2026 a paste artifact in the env var
// (strict bs58.decode saw a non-base58 character) silently paused all three
// engines every tick. decodeSeedSecret must accept every encoding an operator
// realistically pastes — and reject garbage cleanly instead of half-decoding.

const kp = Keypair.generate();
const bytes = kp.secretKey; // 64 bytes
const b58 = bs58.encode(bytes);
const b64 = Buffer.from(bytes).toString('base64');
const jsonArr = JSON.stringify(Array.from(bytes));

describe('decodeSeedSecret', () => {
	it('decodes canonical base58', () => {
		expect(decodeSeedSecret(b58)).toEqual(bytes);
	});

	it('decodes base64 and JSON-array forms', () => {
		expect(decodeSeedSecret(b64)).toEqual(bytes);
		expect(decodeSeedSecret(jsonArr)).toEqual(bytes);
	});

	it('tolerates paste artifacts: quotes, whitespace, newlines', () => {
		expect(decodeSeedSecret(`"${b58}"`)).toEqual(bytes);
		expect(decodeSeedSecret(`  ${b58}\n`)).toEqual(bytes);
		expect(decodeSeedSecret(`'${b64}'`)).toEqual(bytes);
		// A 64-char-wrapped multi-line paste of the base58 form.
		const wrapped = b58.replace(/(.{32})/g, '$1\n');
		expect(decodeSeedSecret(wrapped)).toEqual(bytes);
	});

	it('rejects garbage and wrong lengths instead of half-decoding', () => {
		expect(decodeSeedSecret('')).toBeNull();
		expect(decodeSeedSecret(null)).toBeNull();
		expect(decodeSeedSecret('not-a-key-0OIl')).toBeNull();
		expect(decodeSeedSecret(bs58.encode(bytes.slice(0, 32)))).toBeNull(); // 32-byte seed, not 64
		expect(decodeSeedSecret(JSON.stringify(Array.from(bytes.slice(0, 32))))).toBeNull();
	});
});
