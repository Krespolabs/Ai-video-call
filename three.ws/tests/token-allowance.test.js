// Unit tests for the $THREE spend-allowance encoders (api/_lib/token/allowance.js).
//
// These pin the on-chain wire format against the native Subscriptions program's
// published IDL: instruction discriminators, argument byte layouts, account
// ordering/signer flags, PDA seeds, and account-state offsets. A drift in any
// constant — which would silently send malformed instructions or misread a
// balance — fails here before it can reach mainnet.

import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
	SUBSCRIPTIONS_PROGRAM_ID,
	subscriptionAuthorityPda,
	fixedDelegationPda,
	eventAuthorityPda,
	ixInitSubscriptionAuthority,
	ixCreateFixedDelegation,
	ixRevokeDelegation,
	ixTransferFixed,
	parseSubscriptionAuthorityInitId,
	parseFixedDelegation,
} from '../api/_lib/token/allowance.js';

const USER = new PublicKey('9MjzHaTB6Jko4YKo9mDzJSaGnktzhbebgsnqPpYWnXC7');
const DELEGATEE = new PublicKey('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44');
const MINT = new PublicKey('FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');

describe('program identity', () => {
	it('uses the audited native Subscriptions program id', () => {
		expect(SUBSCRIPTIONS_PROGRAM_ID.toBase58()).toBe('De1egAFMkMWZSN5rYXRj9CAdheBamobVNubTsi9avR44');
	});
});

describe('PDA derivation', () => {
	it('subscription authority is deterministic and program-owned', () => {
		const a = subscriptionAuthorityPda(USER, MINT);
		const b = subscriptionAuthorityPda(USER, MINT);
		expect(a.toBase58()).toBe(b.toBase58());
		// Re-derive with the documented seeds and confirm it matches.
		const [expected] = PublicKey.findProgramAddressSync(
			[Buffer.from('SubscriptionAuthority'), USER.toBuffer(), MINT.toBuffer()],
			SUBSCRIPTIONS_PROGRAM_ID,
		);
		expect(a.toBase58()).toBe(expected.toBase58());
	});

	it('fixed-delegation PDA varies by nonce', () => {
		const sa = subscriptionAuthorityPda(USER, MINT);
		const d0 = fixedDelegationPda({ subscriptionAuthority: sa, delegator: USER, delegatee: DELEGATEE, nonce: 0 });
		const d1 = fixedDelegationPda({ subscriptionAuthority: sa, delegator: USER, delegatee: DELEGATEE, nonce: 1 });
		expect(d0.toBase58()).not.toBe(d1.toBase58());
	});

	it('event authority is a constant PDA', () => {
		const [expected] = PublicKey.findProgramAddressSync([Buffer.from('event_authority')], SUBSCRIPTIONS_PROGRAM_ID);
		expect(eventAuthorityPda().toBase58()).toBe(expected.toBase58());
	});
});

describe('instruction encodings', () => {
	it('initSubscriptionAuthority: discriminator 0, 6 accounts, owner is the only signer', () => {
		const ix = ixInitSubscriptionAuthority({ owner: USER, mint: MINT });
		expect(ix.programId.equals(SUBSCRIPTIONS_PROGRAM_ID)).toBe(true);
		expect([...ix.data]).toEqual([0]);
		expect(ix.keys).toHaveLength(6);
		expect(ix.keys[0].pubkey.equals(USER)).toBe(true);
		expect(ix.keys[0].isSigner).toBe(true);
		expect(ix.keys[0].isWritable).toBe(true);
		expect(ix.keys.filter((k) => k.isSigner)).toHaveLength(1);
	});

	it('createFixedDelegation: disc 1 + nonce(u64) + amount(u64) + expiry(i64) + initId(i64) little-endian', () => {
		const ix = ixCreateFixedDelegation({
			delegator: USER,
			delegatee: DELEGATEE,
			nonce: 7,
			amount: 123_456n,
			expiryTs: 1_900_000_000,
			expectedInitId: 1_750_000_000,
			mint: MINT,
		});
		expect(ix.data[0]).toBe(1);
		const d = Buffer.from(ix.data);
		expect(d.readBigUInt64LE(1)).toBe(7n);
		expect(d.readBigUInt64LE(9)).toBe(123_456n);
		expect(d.readBigInt64LE(17)).toBe(1_900_000_000n);
		expect(d.readBigInt64LE(25)).toBe(1_750_000_000n);
		expect(d.length).toBe(33); // 1 + 8 + 8 + 8 + 8
		expect(ix.keys[0].isSigner).toBe(true); // delegator signs the grant
	});

	it('revokeDelegation: discriminator 3, authority signs, delegation account is writable', () => {
		const delegationPda = fixedDelegationPda({
			subscriptionAuthority: subscriptionAuthorityPda(USER, MINT),
			delegator: USER,
			delegatee: DELEGATEE,
			nonce: 3,
		});
		const ix = ixRevokeDelegation({ authority: USER, delegationPda });
		expect([...ix.data]).toEqual([3]);
		expect(ix.keys).toHaveLength(2);
		expect(ix.keys[0].pubkey.equals(USER)).toBe(true);
		expect(ix.keys[0].isSigner).toBe(true);
		expect(ix.keys[1].pubkey.equals(delegationPda)).toBe(true);
		expect(ix.keys[1].isWritable).toBe(true);
		expect(ix.keys[1].isSigner).toBe(false);
	});

	it('transferFixed: disc 4 + amount(u64) + delegator(32) + mint(32); delegatee is the signer', () => {
		const delegationPda = fixedDelegationPda({
			subscriptionAuthority: subscriptionAuthorityPda(USER, MINT),
			delegator: USER,
			delegatee: DELEGATEE,
			nonce: 0,
		});
		const ix = ixTransferFixed({
			delegationPda,
			delegator: USER,
			delegatee: DELEGATEE,
			receiver: MINT, // any pubkey works as a receiver owner for encoding
			amount: 5000n,
			mint: MINT,
		});
		expect(ix.data[0]).toBe(4);
		const d = Buffer.from(ix.data);
		expect(d.readBigUInt64LE(1)).toBe(5000n);
		expect(new PublicKey(d.subarray(9, 41)).equals(USER)).toBe(true);
		expect(new PublicKey(d.subarray(41, 73)).equals(MINT)).toBe(true);
		expect(d.length).toBe(73); // 1 + 8 + 32 + 32
		expect(ix.keys).toHaveLength(9);
		// The delegatee (platform delegate) is the sole signer on a pull.
		const signers = ix.keys.filter((k) => k.isSigner);
		expect(signers).toHaveLength(1);
		expect(signers[0].pubkey.equals(DELEGATEE)).toBe(true);
		// Last account is the program itself (self CPI for event emission).
		expect(ix.keys[ix.keys.length - 1].pubkey.equals(SUBSCRIPTIONS_PROGRAM_ID)).toBe(true);
	});
});

describe('account-state parsers', () => {
	it('reads the subscription authority init-id at its documented offset', () => {
		const buf = Buffer.alloc(106);
		buf.writeBigInt64LE(1_751_234_567n, 98);
		expect(parseSubscriptionAuthorityInitId(buf)).toBe(1_751_234_567);
		expect(parseSubscriptionAuthorityInitId(Buffer.alloc(10))).toBeNull(); // too short
	});

	it('decodes a fixed-delegation account: parties, remaining balance, expiry', () => {
		const buf = Buffer.alloc(187);
		USER.toBuffer().copy(buf, 3); // header.delegator
		DELEGATEE.toBuffer().copy(buf, 35); // header.delegatee
		buf.writeBigUInt64LE(42_000n, 171); // remaining amount (decrements per pull)
		buf.writeBigInt64LE(1_888_000_000n, 179); // expiry
		const parsed = parseFixedDelegation(buf);
		expect(parsed.delegator).toBe(USER.toBase58());
		expect(parsed.delegatee).toBe(DELEGATEE.toBase58());
		expect(parsed.remaining).toBe(42_000n);
		expect(parsed.expiryTs).toBe(1_888_000_000);
		expect(parseFixedDelegation(Buffer.alloc(100))).toBeNull(); // undersized
	});
});
