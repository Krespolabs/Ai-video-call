/**
 * MegaFuel gasless-send client — unit tests.
 *
 * Every path is exercised with injected mocks (megafuelRpc, publicClient,
 * walletClient) and a SYNTHETIC throwaway account — no live network, no real
 * key. The self-pay fallback is the load-bearing behaviour and gets the most
 * coverage: policy decline, MegaFuel throwing, and sponsored-send failure must
 * all resolve to a self-paid send rather than a hard failure.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
	isSponsorable,
	sendGasless,
	megafuelEndpoint,
	MegaFuelError,
	MEGAFUEL_ENDPOINTS,
} from '../api/_lib/bnb/megafuel.js';

// Synthetic throwaway account — generated per run, never a real third-party key.
const account = privateKeyToAccount(generatePrivateKey());
const TO = '0x000000000000000000000000000000000000dEaD';

function mockPublicClient() {
	return {
		chain: { id: 97, name: 'BNB Smart Chain Testnet', nativeCurrency: { name: 'tBNB', symbol: 'tBNB', decimals: 18 } },
		bnbRpcs: ['https://data-seed-prebsc-1-s1.bnbchain.org:8545'],
		async getTransactionCount() {
			return 0;
		},
		async estimateGas() {
			return 21000n;
		},
	};
}

describe('megafuelEndpoint', () => {
	// pm_isSponsorable / eth_sendRawTransaction run unauthenticated at the plain
	// base URL always (verified against docs.nodereal.io/reference/pm-issponsorable
	// and .../eth-sendrawtransaction-megafuel) — no API-key path segment. The key
	// only applies to the separate policy-management endpoint (not implemented here).
	it('returns the public testnet endpoint', () => {
		expect(megafuelEndpoint('bscTestnet')).toBe(MEGAFUEL_ENDPOINTS.bscTestnet);
	});
	it('returns the public mainnet endpoint regardless of NODEREAL_MEGAFUEL_KEY', () => {
		process.env.NODEREAL_MEGAFUEL_KEY = 'testkey';
		expect(megafuelEndpoint('bscMainnet')).toBe(MEGAFUEL_ENDPOINTS.bscMainnet);
		delete process.env.NODEREAL_MEGAFUEL_KEY;
	});
});

describe('isSponsorable', () => {
	it('maps a sponsorable:true reply', async () => {
		const out = await isSponsorable('bscTestnet', { to: TO, from: account.address }, {
			megafuelRpc: async () => ({ sponsorable: true, sponsorAddress: '0xabc' }),
		});
		expect(out.sponsorable).toBe(true);
		expect(out.sponsorInfo).toMatchObject({ sponsorable: true });
		expect(out.reason).toBeNull();
	});

	it('maps a sponsorable:false reply with a reason (does not throw)', async () => {
		const out = await isSponsorable('bscTestnet', { to: TO, from: account.address }, {
			megafuelRpc: async () => ({ sponsorable: false, reason: 'no policy' }),
		});
		expect(out.sponsorable).toBe(false);
		expect(out.reason).toBe('no policy');
	});

	it('treats a probe error as not-sponsorable (never throws)', async () => {
		const out = await isSponsorable('bscTestnet', { to: TO, from: account.address }, {
			megafuelRpc: async () => {
				throw new Error('endpoint down');
			},
		});
		expect(out.sponsorable).toBe(false);
		expect(out.reason).toMatch(/probe failed/);
	});
});

describe('sendGasless — sponsored path', () => {
	it('signs with gasPrice 0 and submits via MegaFuel → mode:sponsored', async () => {
		const calls = [];
		const out = await sendGasless('bscTestnet', { account, tx: { to: TO } }, {
			publicClient: mockPublicClient(),
			megafuelRpc: async (method, params) => {
				calls.push(method);
				if (method === 'pm_isSponsorable') return { sponsorable: true, sponsorAddress: '0xspon' };
				if (method === 'eth_sendRawTransaction') {
					expect(typeof params[0]).toBe('string'); // a signed raw tx
					return '0x' + 'a'.repeat(64);
				}
				return null;
			},
		});
		expect(out.mode).toBe('sponsored');
		expect(out.hash).toBe('0x' + 'a'.repeat(64));
		expect(calls).toContain('pm_isSponsorable');
		expect(calls).toContain('eth_sendRawTransaction');
	});
});

describe('sendGasless — self-pay fallback (load-bearing)', () => {
	it('policy declines → self-pays via walletClient → mode:self-pay', async () => {
		let sent = false;
		const out = await sendGasless('bscTestnet', { account, tx: { to: TO } }, {
			publicClient: mockPublicClient(),
			megafuelRpc: async () => ({ sponsorable: false, reason: 'no policy for sender' }),
			walletClient: {
				async sendTransaction() {
					sent = true;
					return '0x' + 'b'.repeat(64);
				},
			},
		});
		expect(sent).toBe(true);
		expect(out.mode).toBe('self-pay');
		expect(out.hash).toBe('0x' + 'b'.repeat(64));
		expect(out.reason).toMatch(/no policy/);
	});

	it('MegaFuel throwing on the probe → still self-pays', async () => {
		const out = await sendGasless('bscTestnet', { account, tx: { to: TO } }, {
			publicClient: mockPublicClient(),
			megafuelRpc: async () => {
				throw new Error('megafuel 503');
			},
			walletClient: { async sendTransaction() { return '0x' + 'c'.repeat(64); } },
		});
		expect(out.mode).toBe('self-pay');
	});

	it('sponsored send failing after an accepted probe → self-pays', async () => {
		const out = await sendGasless('bscTestnet', { account, tx: { to: TO } }, {
			publicClient: mockPublicClient(),
			megafuelRpc: async (method) => {
				if (method === 'pm_isSponsorable') return { sponsorable: true };
				throw new Error('raw send rejected');
			},
			walletClient: { async sendTransaction() { return '0x' + 'd'.repeat(64); } },
		});
		expect(out.mode).toBe('self-pay');
	});

	it('self-pay also failing → typed MegaFuelError', async () => {
		await expect(
			sendGasless('bscTestnet', { account, tx: { to: TO } }, {
				publicClient: mockPublicClient(),
				megafuelRpc: async () => ({ sponsorable: false }),
				walletClient: { async sendTransaction() { throw new Error('insufficient funds'); } },
			}),
		).rejects.toBeInstanceOf(MegaFuelError);
	});
});

describe('sendGasless — input validation', () => {
	it('rejects a malformed tx.to before any network call', async () => {
		await expect(
			sendGasless('bscTestnet', { account, tx: { to: 'not-an-address' } }, {}),
		).rejects.toMatchObject({ code: 'bad_tx' });
	});
	it('rejects a non-signer account', async () => {
		await expect(
			sendGasless('bscTestnet', { account: {}, tx: { to: TO } }, {}),
		).rejects.toMatchObject({ code: 'bad_signer' });
	});
});

describe('no private key is read inside the module', () => {
	it('source reads no private key / mnemonic / raw key literal', () => {
		const src = readFileSync(new URL('../api/_lib/bnb/megafuel.js', import.meta.url), 'utf8');
		// The NodeReal API-key path (NODEREAL_MEGAFUEL_KEY) is a public endpoint
		// segment, not a signing key — the checks below target signing material.
		expect(src).not.toMatch(/PRIVATE_KEY/i);
		expect(src).not.toMatch(/privateKeyToAccount/);
		expect(src).not.toMatch(/mnemonic/i);
		expect(src).not.toMatch(/0x[0-9a-fA-F]{64}/); // no raw 32-byte key literal
	});
});
