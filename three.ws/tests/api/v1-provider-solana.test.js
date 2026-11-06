// Tests for the Solana on-chain-reads aggregator provider (api/v1/_providers.js).
//
// This provider wraps Solana JSON-RPC as plain GET endpoints so an agent never
// hand-builds a JSON-RPC body. The caller side is GET; the upstream call is a
// POST JSON-RPC body — that GET→POST lift is the `upstreamMethod` field
// (api/_lib/aggregator.js `executeUpstream`), covered here via the `body()`
// builders (which receive the caller's query params, exactly as the engine
// calls them for a GET-caller/POST-upstream endpoint).
//
// No live network here — the descriptor's transforms are pure functions,
// exercised against fixtures captured from the REAL configured Solana RPC
// (public mainnet fallback) on 2026-07-08: getBalance, getTokenSupply,
// getTokenAccountsByOwner, getAccountInfo (all live-verified), plus the
// documented getTokenLargestAccounts/getRecentPrioritizationFees shapes and a
// real getTransaction capture for a $THREE transfer — plus RPC-error payloads,
// percentile math, and required-param enforcement via the body() builders.

import { describe, it, expect } from 'vitest';
import { PROVIDERS, ENDPOINT_INDEX } from '../../api/v1/_providers.js';

const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const solana = PROVIDERS.find((p) => p.id === 'solana');
const ep = (id) => ENDPOINT_INDEX.get(`solana/${id}`).endpoint;

const RPC_ERROR_INVALID_PARAM = { jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid param: Invalid' } };
const RPC_ERROR_RATE_LIMITED = { jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Too many requests for a specific RPC call' } };

describe('solana provider — descriptor integrity', () => {
	it('is registered as a keyless onchain-data provider on a resolved RPC base', () => {
		expect(solana).toBeTruthy();
		expect(solana.category).toBe('onchain-data');
		expect(solana.requiresKey).toBe(false);
		expect(solana.byokHeader).toBeNull();
		expect(solana.envVar).toBeNull();
		expect(typeof solana.base).toBe('string');
		expect(solana.base.startsWith('http')).toBe(true);
	});

	it('exposes all 7 reads — GET caller-side, POST upstream, scoped, priced, free-tiered', () => {
		expect(solana.endpoints.map((e) => e.id)).toEqual([
			'balance',
			'token-holdings',
			'token-supply',
			'largest-holders',
			'transaction',
			'account',
			'priority-fees',
		]);
		for (const e of solana.endpoints) {
			expect(e.method, `${e.id} caller method`).toBe('GET');
			expect(e.upstreamMethod, `${e.id} upstream method`).toBe('POST');
			expect(e.scope).toBe('agents:read');
			expect(e.priceAtomics).toBe('1000');
			expect(e.free).toEqual({ perMin: 20, perDay: 2000 });
			expect(typeof e.summary).toBe('string');
			expect(e.summary.length).toBeGreaterThan(0);
			expect(e.params).toBeTruthy();
			expect(typeof e.body).toBe('function');
		}
	});
});

describe('solana/balance', () => {
	it('requires address and builds a getBalance JSON-RPC body', () => {
		expect(() => ep('balance').body({})).toThrow(/address/);
		expect(ep('balance').body({ address: '11111111111111111111111111111111' })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'getBalance',
			params: ['11111111111111111111111111111111'],
		});
	});

	it('converts lamports to sol from a real-shaped response', () => {
		// Captured live 2026-07-08: getBalance("11111111111111111111111111111111").
		const fixture = { jsonrpc: '2.0', id: 1, result: { context: { apiVersion: '4.1.0', slot: 431484341 }, value: 1 } };
		expect(ep('balance').transform(fixture)).toEqual({ lamports: 1, sol: 1e-9 });
	});

	it('surfaces an RPC error as a client-fault HTTP error, not a payload', () => {
		expect(() => ep('balance').transform(RPC_ERROR_INVALID_PARAM)).toThrow(/Invalid param/);
		try {
			ep('balance').transform(RPC_ERROR_INVALID_PARAM);
		} catch (e) {
			expect(e.status).toBe(400);
			expect(e.code).toBe('rpc_invalid_request');
		}
	});

	it('maps a non-caller-fault RPC error (rate limit) to a 502', () => {
		try {
			ep('balance').transform(RPC_ERROR_RATE_LIMITED);
			throw new Error('should have thrown');
		} catch (e) {
			expect(e.status).toBe(502);
			expect(e.code).toBe('rpc_upstream_error');
		}
	});
});

describe('solana/token-holdings', () => {
	it('requires owner and builds a getTokenAccountsByOwner JSON-RPC body', () => {
		expect(() => ep('token-holdings').body({})).toThrow(/owner/);
		const body = ep('token-holdings').body({ owner: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw' });
		expect(body.method).toBe('getTokenAccountsByOwner');
		expect(body.params[0]).toBe('DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw');
		expect(body.params[1]).toEqual({ programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' });
		expect(body.params[2]).toEqual({ encoding: 'jsonParsed' });
	});

	it('slims parsed token accounts, filters zero balances, sorts largest first', () => {
		// Captured live 2026-07-08: getTokenAccountsByOwner for a real wallet.
		const fixture = {
			jsonrpc: '2.0',
			id: 1,
			result: {
				context: { slot: 431484541 },
				value: [
					{
						pubkey: 'FPk1bPtMfxPg1AQDbZ3fccg88FziAnssB2z9L29aRvHc',
						account: {
							data: {
								program: 'spl-token',
								parsed: {
									info: {
										mint: '6iKXPHDxHBMnsmpcwoMbLi8xedKvBXpwQErEhdBVGBB',
										owner: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw',
										state: 'initialized',
										tokenAmount: { amount: '3514399525981', decimals: 6, uiAmount: 3514399.525981, uiAmountString: '3514399.525981' },
									},
									type: 'account',
								},
							},
						},
					},
					{
						pubkey: '2gKwXijKbC5Sdr7VgZV5c9WCH9bZ7MjGES6f49GCD2Gx',
						account: {
							data: {
								program: 'spl-token',
								parsed: {
									info: {
										mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
										owner: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw',
										state: 'initialized',
										tokenAmount: { amount: '0', decimals: 6, uiAmount: 0, uiAmountString: '0' },
									},
									type: 'account',
								},
							},
						},
					},
				],
			},
		};
		expect(ep('token-holdings').transform(fixture)).toEqual([
			{ mint: '6iKXPHDxHBMnsmpcwoMbLi8xedKvBXpwQErEhdBVGBB', amount: '3514399525981', decimals: 6, uiAmount: 3514399.525981 },
		]);
	});

	it('tolerates an empty/malformed value array', () => {
		expect(ep('token-holdings').transform({ result: { value: [] } })).toEqual([]);
		expect(ep('token-holdings').transform({ result: {} })).toEqual([]);
	});
});

describe('solana/token-supply', () => {
	it('requires mint and builds a getTokenSupply JSON-RPC body', () => {
		expect(() => ep('token-supply').body({})).toThrow(/mint/);
		expect(ep('token-supply').body({ mint: THREE_MINT })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'getTokenSupply',
			params: [THREE_MINT],
		});
	});

	it('slims the real $THREE supply response', () => {
		// Captured live 2026-07-08: getTokenSupply(THREE_MINT).
		const fixture = {
			jsonrpc: '2.0',
			id: 1,
			result: { context: { apiVersion: '4.1.0', slot: 431484344 }, value: { amount: '999683493875007', decimals: 6, uiAmount: 999683493.875007, uiAmountString: '999683493.875007' } },
		};
		expect(ep('token-supply').transform(fixture)).toEqual({ amount: '999683493875007', decimals: 6, uiAmount: 999683493.875007 });
	});

	it('404s a mint with no value (not an SPL token)', () => {
		expect(() => ep('token-supply').transform({ result: { value: null } })).toThrow(/mint not found/);
		try {
			ep('token-supply').transform({ result: { value: null } });
		} catch (e) {
			expect(e.status).toBe(404);
			expect(e.code).toBe('mint_not_found');
		}
	});
});

describe('solana/largest-holders', () => {
	it('requires mint and caps at 20', () => {
		expect(() => ep('largest-holders').body({})).toThrow(/mint/);
		// Documented shape: result.value is an array of up to 20 holder accounts.
		const fixture = {
			result: {
				value: Array.from({ length: 25 }, (_, i) => ({ address: `Holder${i}`, amount: String(1000 - i), decimals: 6, uiAmount: 1000 - i })),
			},
		};
		const out = ep('largest-holders').transform(fixture);
		expect(out).toHaveLength(20);
		expect(out[0]).toEqual({ address: 'Holder0', uiAmount: 1000 });
	});

	it('tolerates a malformed value array', () => {
		expect(ep('largest-holders').transform({ result: {} })).toEqual([]);
	});
});

describe('solana/transaction', () => {
	it('requires signature and builds a getTransaction JSON-RPC body', () => {
		expect(() => ep('transaction').body({})).toThrow(/signature/);
		const sig = '2Gz7S6GCjoJb6wj2s4prUZj75B36n2bpa6GRh7op7qv8eBMP5hucG4a3N2pSga8t9frWJhoHjj3eJDaFEEgCv19W';
		expect(ep('transaction').body({ signature: sig })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'getTransaction',
			params: [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }],
		});
	});

	it('slims a real transaction to slot/blockTime/fee/err/signers/logs/token deltas', () => {
		// Trimmed but real-shaped capture (2026-07-08) of a $THREE transferChecked
		// instruction — full instruction tree/rewards/inner instructions dropped,
		// meta.preTokenBalances/postTokenBalances/logMessages/accountKeys kept.
		const fixture = {
			jsonrpc: '2.0',
			id: 1,
			result: {
				blockTime: 1783471283,
				slot: 431484410,
				transaction: {
					message: {
						accountKeys: [
							{ pubkey: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw', signer: true, source: 'transaction', writable: true },
							{ pubkey: '4MGFkWT5ML3M5dRkMmLqHXD8SbELvj5a9ywGyzpLVnCW', signer: false, source: 'transaction', writable: true },
						],
					},
					signatures: ['2Gz7S6GCjoJb6wj2s4prUZj75B36n2bpa6GRh7op7qv8eBMP5hucG4a3N2pSga8t9frWJhoHjj3eJDaFEEgCv19W'],
				},
				meta: {
					err: null,
					fee: 40665,
					logMessages: Array.from({ length: 30 }, (_, i) => `log line ${i}`),
					preTokenBalances: [
						{ accountIndex: 2, mint: THREE_MINT, owner: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw', uiTokenAmount: { amount: '18394271251', decimals: 6, uiAmount: 18394.271251 } },
					],
					postTokenBalances: [
						{ accountIndex: 2, mint: THREE_MINT, owner: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw', uiTokenAmount: { amount: '0', decimals: 6, uiAmount: null } },
						{ accountIndex: 3, mint: 'So11111111111111111111111111111111111111112', owner: 'NewHolderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', uiTokenAmount: { amount: '5000000000', decimals: 9, uiAmount: 5 } },
					],
				},
			},
		};
		const out = ep('transaction').transform(fixture);
		expect(out.slot).toBe(431484410);
		expect(out.blockTime).toBe(1783471283);
		expect(out.fee).toBe(40665);
		expect(out.err).toBeNull();
		expect(out.signers).toEqual(['DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw']);
		expect(out.logMessages).toHaveLength(20); // truncated to first 20 lines
		expect(out.tokenBalanceChanges).toContainEqual({ mint: THREE_MINT, owner: 'DdCL89km6hCardM5rNbEKEiQUFDhp2NG6nz9qkbbQpNw', delta: -18394.271251 });
		expect(out.tokenBalanceChanges).toContainEqual({ mint: 'So11111111111111111111111111111111111111112', owner: 'NewHolderXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', delta: 5 });
	});

	it('404s an unknown/unfinalized signature (result: null)', () => {
		expect(() => ep('transaction').transform({ jsonrpc: '2.0', id: 1, result: null })).toThrow(/transaction not found/);
		try {
			ep('transaction').transform({ jsonrpc: '2.0', id: 1, result: null });
		} catch (e) {
			expect(e.status).toBe(404);
			expect(e.code).toBe('transaction_not_found');
		}
	});
});

describe('solana/account', () => {
	it('requires address and builds a getAccountInfo JSON-RPC body', () => {
		expect(() => ep('account').body({})).toThrow(/address/);
		expect(ep('account').body({ address: THREE_MINT })).toEqual({
			jsonrpc: '2.0',
			id: 1,
			method: 'getAccountInfo',
			params: [THREE_MINT, { encoding: 'jsonParsed' }],
		});
	});

	it('slims the real $THREE mint account (Token-2022, jsonParsed)', () => {
		// Captured live 2026-07-08: getAccountInfo(THREE_MINT, jsonParsed).
		const fixture = {
			jsonrpc: '2.0',
			id: 1,
			result: {
				context: { apiVersion: '4.1.0', slot: 431484381 },
				value: {
					data: { program: 'spl-token-2022', parsed: { info: { decimals: 6, supply: '999683493875007' }, type: 'mint' }, space: 411 },
					executable: false,
					lamports: 46804176073,
					owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
					space: 411,
				},
			},
		};
		expect(ep('account').transform(fixture)).toEqual({
			owner: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
			lamports: 46804176073,
			executable: false,
			program: 'spl-token-2022',
			parsedType: 'mint',
		});
	});

	it('404s an unfunded/nonexistent address (value: null)', () => {
		expect(() => ep('account').transform({ result: { value: null } })).toThrow(/account not found/);
		try {
			ep('account').transform({ result: { value: null } });
		} catch (e) {
			expect(e.status).toBe(404);
			expect(e.code).toBe('account_not_found');
		}
	});
});

describe('solana/priority-fees', () => {
	it('takes no params and builds a getRecentPrioritizationFees JSON-RPC body', () => {
		expect(ep('priority-fees').body({})).toEqual({ jsonrpc: '2.0', id: 1, method: 'getRecentPrioritizationFees', params: [] });
	});

	it('computes p50/p75/p95/max from a real-shaped fee list', () => {
		// Captured live 2026-07-08: getRecentPrioritizationFees([]) — last ~150 slots.
		const fees = [0, 0, 0, 100, 200, 5000];
		const fixture = { jsonrpc: '2.0', id: 1, result: fees.map((prioritizationFee, i) => ({ slot: 431484227 + i, prioritizationFee })) };
		const out = ep('priority-fees').transform(fixture);
		expect(out.max).toBe(5000);
		expect(out.p50).toBeGreaterThanOrEqual(0);
		expect(out.p95).toBeLessThanOrEqual(5000);
		expect(out.p50).toBeLessThanOrEqual(out.p75);
		expect(out.p75).toBeLessThanOrEqual(out.p95);
		expect(out.p95).toBeLessThanOrEqual(out.max);
	});

	it('returns all zeros for an empty fee list', () => {
		expect(ep('priority-fees').transform({ jsonrpc: '2.0', id: 1, result: [] })).toEqual({ p50: 0, p75: 0, p95: 0, max: 0 });
	});

	it('is order-independent (percentiles sort internally)', () => {
		const asc = { result: [10, 20, 30, 40, 100].map((f) => ({ prioritizationFee: f })) };
		const desc = { result: [100, 40, 30, 20, 10].map((f) => ({ prioritizationFee: f })) };
		expect(ep('priority-fees').transform(asc)).toEqual(ep('priority-fees').transform(desc));
	});
});
