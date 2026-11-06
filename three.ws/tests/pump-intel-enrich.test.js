// Unit tests for the funder-graph enrichment's pure logic — the bubble-map math
// and the on-chain funder parser. These are the parts that decide "is this coin a
// coordinated bundle or organic?", so they're worth pinning down exactly. No DB or
// RPC is touched: connectivityFromFunders is pure, and parseFunderFromTransaction
// runs against fixture getTransaction payloads shaped like Solana's jsonParsed RPC.

import { describe, it, expect } from 'vitest';
import {
	connectivityFromFunders,
	parseFunderFromTransaction,
} from '../api/_lib/pump-intel/enrich.js';

const SYSTEM = '11111111111111111111111111111111';

describe('connectivityFromFunders', () => {
	it('returns null connectivity below the 3-known-funder floor', () => {
		const r = connectivityFromFunders({ a: 'F1', b: 'F1' });
		expect(r.connectivity).toBeNull();
		expect(r.known).toBe(2);
	});

	it('measures the largest shared-funder cluster as a share of known funders', () => {
		// 4 of 5 wallets funded by F1 → one 4-wallet cluster, connectivity 0.8.
		const r = connectivityFromFunders({ a: 'F1', b: 'F1', c: 'F1', d: 'F1', e: 'F2' });
		expect(r.known).toBe(5);
		expect(r.largest_cluster).toBe(4);
		expect(r.connectivity).toBeCloseTo(0.8, 4);
		expect(r.clusters).toBe(1); // only F1 has >= 2 members
	});

	it('reads as organic when every funder is distinct', () => {
		const r = connectivityFromFunders({ a: 'F1', b: 'F2', c: 'F3', d: 'F4' });
		expect(r.connectivity).toBeCloseTo(0.25, 4); // largest cluster is 1 wallet
		expect(r.clusters).toBe(0);
	});

	it('ignores wallets with no known funder', () => {
		const r = connectivityFromFunders({ a: 'F1', b: 'F1', c: 'F1', d: null, e: undefined });
		expect(r.known).toBe(3);
		expect(r.connectivity).toBeCloseTo(1, 4);
	});
});

describe('parseFunderFromTransaction', () => {
	const ADDR = 'Wa11etDestination1111111111111111111111111';
	const FUNDER = 'FundeR111111111111111111111111111111111111';

	it('resolves the source of an explicit system transfer into the wallet', () => {
		const tx = {
			transaction: { message: {
				accountKeys: [{ pubkey: FUNDER, signer: true }, { pubkey: ADDR, signer: false }],
				instructions: [
					{ program: 'system', parsed: { type: 'transfer', info: { source: FUNDER, destination: ADDR, lamports: 30_000_000 } } },
				],
			} },
			meta: { preBalances: [1e9, 0], postBalances: [1e9 - 3e7, 3e7], innerInstructions: [] },
		};
		const out = parseFunderFromTransaction(tx, ADDR);
		expect(out?.funder).toBe(FUNDER);
		expect(out?.lamports).toBe(30_000_000);
	});

	it('finds the funder inside inner instructions (nested/CEX routing)', () => {
		const tx = {
			transaction: { message: {
				accountKeys: [{ pubkey: 'SomeProgramPayer11111111111111111111111111' }, { pubkey: ADDR }],
				instructions: [{ program: 'spl-associated-token-account', parsed: null }],
			} },
			meta: {
				preBalances: [1e9, 0], postBalances: [1e9, 5e6],
				innerInstructions: [{ index: 0, instructions: [
					{ program: 'system', parsed: { type: 'transfer', info: { source: FUNDER, destination: ADDR, lamports: 5_000_000 } } },
				] }],
			},
		};
		expect(parseFunderFromTransaction(tx, ADDR)?.funder).toBe(FUNDER);
	});

	it('falls back to the fee payer when the wallet balance rose with no parsed transfer', () => {
		const tx = {
			transaction: { message: {
				accountKeys: [{ pubkey: FUNDER, signer: true }, { pubkey: ADDR }],
				instructions: [{ program: 'vote', parsed: null }],
			} },
			meta: { preBalances: [1e9, 0], postBalances: [1e9 - 1e6, 1e6], innerInstructions: [] },
		};
		expect(parseFunderFromTransaction(tx, ADDR)?.funder).toBe(FUNDER);
	});

	it('never treats the system program or the wallet itself as a funder', () => {
		const sysTx = {
			transaction: { message: {
				accountKeys: [{ pubkey: SYSTEM }, { pubkey: ADDR }],
				instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: SYSTEM, destination: ADDR, lamports: 1 } } }],
			} },
			meta: { preBalances: [1e9, 0], postBalances: [1e9, 1], innerInstructions: [] },
		};
		expect(parseFunderFromTransaction(sysTx, ADDR)).toBeNull();

		const selfTx = {
			transaction: { message: {
				accountKeys: [{ pubkey: ADDR, signer: true }],
				instructions: [{ program: 'system', parsed: { type: 'transfer', info: { source: ADDR, destination: ADDR, lamports: 1 } } }],
			} },
			meta: { preBalances: [1e9], postBalances: [1e9], innerInstructions: [] },
		};
		expect(parseFunderFromTransaction(selfTx, ADDR)).toBeNull();
	});

	it('returns null when the wallet only spent (it was the fee payer, balance fell)', () => {
		const tx = {
			transaction: { message: {
				accountKeys: [{ pubkey: ADDR, signer: true }, { pubkey: FUNDER }],
				instructions: [{ program: 'vote', parsed: null }],
			} },
			meta: { preBalances: [1e9, 0], postBalances: [1e9 - 5000, 0], innerInstructions: [] },
		};
		expect(parseFunderFromTransaction(tx, ADDR)).toBeNull();
	});
});
