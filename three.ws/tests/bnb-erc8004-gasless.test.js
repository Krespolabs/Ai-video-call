/**
 * Gasless ERC-8004 registration relay (api/_lib/bnb/erc8004-gasless.js) —
 * unit tests.
 *
 * Every path signs a REAL legacy transaction with a SYNTHETIC, per-test
 * throwaway viem account (generatePrivateKey — never a real key) so
 * parseTransaction/recoverTransactionAddress exercise genuine RLP decoding
 * and signature recovery. MegaFuel and the BSC RPC are injected mocks — no
 * live network — mirroring tests/bnb-megafuel.test.js's approach.
 */

import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { relayGaslessRegistration, RegisterRelayError } from '../api/_lib/bnb/erc8004-gasless.js';

const TESTNET_REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const REGISTER_DATA = '0x1aa3a008'; // register() selector — bytes only need to be well-formed hex here
const CHAIN_ID = 97;

function agentTopic(agentId) {
	return '0x' + BigInt(agentId).toString(16).padStart(64, '0');
}

const REGISTERED_TOPIC0 = '0xca52e62c367d81bb2e328eb795f7c7ba24afb478408a26c0e201d155c449bc4a';
const TRANSFER_TOPIC0 = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function freshAccount() {
	return privateKeyToAccount(generatePrivateKey());
}

async function signRegisterTx(account, { gasPrice = 0n, nonce = 0, to = TESTNET_REGISTRY } = {}) {
	return account.signTransaction({
		to,
		data: REGISTER_DATA,
		gasPrice,
		gas: 300000n,
		nonce,
		chainId: CHAIN_ID,
		type: 'legacy',
	});
}

function mockPublicClient({ balance = 0n, tokenId = 0n, tokenIdReverts = false, receipt, sendRawTransaction, call } = {}) {
	return {
		async readContract({ functionName }) {
			if (functionName === 'balanceOf') return balance;
			if (functionName === 'tokenOfOwnerByIndex') {
				if (tokenIdReverts) throw new Error('execution reverted: 0x');
				return tokenId;
			}
			throw new Error(`unexpected readContract call: ${functionName}`);
		},
		async waitForTransactionReceipt() {
			if (receipt instanceof Error) throw receipt;
			return receipt;
		},
		async sendRawTransaction(args) {
			if (sendRawTransaction) return sendRawTransaction(args);
			return '0x' + 'e'.repeat(64);
		},
		async call(args) {
			if (call) return call(args);
			return {};
		},
	};
}

describe('relayGaslessRegistration — input validation', () => {
	it('rejects a malformed signedRegisterTx', async () => {
		await expect(
			relayGaslessRegistration({ signedRegisterTx: 'not-hex', network: 'bscTestnet' }),
		).rejects.toMatchObject({ code: 'bad_tx' });
	});

	it('rejects a tx targeting a contract other than the Identity Registry', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { to: '0x000000000000000000000000000000000000dEaD' });
		await expect(
			relayGaslessRegistration({
				signedRegisterTx: signed,
				network: 'bscTestnet',
				publicClient: mockPublicClient(),
			}),
		).rejects.toMatchObject({ code: 'wrong_target' });
	});

	it('rejects a non-legacy (EIP-1559) transaction', async () => {
		const account = await freshAccount();
		const signed = await account.signTransaction({
			to: TESTNET_REGISTRY,
			data: REGISTER_DATA,
			maxFeePerGas: 1000000000n,
			maxPriorityFeePerGas: 1000000000n,
			gas: 300000n,
			nonce: 0,
			chainId: CHAIN_ID,
			type: 'eip1559',
		});
		await expect(
			relayGaslessRegistration({
				signedRegisterTx: signed,
				network: 'bscTestnet',
				publicClient: mockPublicClient(),
			}),
		).rejects.toMatchObject({ code: 'bad_tx_type' });
	});
});

describe('relayGaslessRegistration — already-registered guard', () => {
	it('returns the existing agentId without broadcasting', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account);
		let sent = false;
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({
				balance: 1n,
				tokenId: 42n,
				sendRawTransaction: () => { sent = true; },
			}),
			megafuelOpts: { megafuelRpc: async () => { sent = true; } },
		});
		expect(out.alreadyRegistered).toBe(true);
		expect(out.agentId).toBe('42');
		expect(out.address.toLowerCase()).toBe(account.address.toLowerCase());
		expect(sent).toBe(false);
	});

	// Real finding, live BSC testnet, 2026-07-08: the deployed Identity Registry
	// declares tokenOfOwnerByIndex in its ABI but REVERTS on it (no
	// ERC721Enumerable storage wired) — balanceOf > 0 still must short-circuit
	// the guard; only the id itself degrades to null. Regression test for the
	// bug this proof run caught: the guard originally treated a revert here as
	// "not registered" via a blanket .catch(() => null), which would have let a
	// held address slip straight into a duplicate mint attempt.
	it('balanceOf > 0 but tokenOfOwnerByIndex reverts → still short-circuits, agentId null', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account);
		let sent = false;
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({
				balance: 1n,
				tokenIdReverts: true,
				sendRawTransaction: () => { sent = true; },
			}),
			megafuelOpts: { megafuelRpc: async () => { sent = true; } },
		});
		expect(out.alreadyRegistered).toBe(true);
		expect(out.agentId).toBeNull();
		expect(sent).toBe(false);
	});
});

describe('relayGaslessRegistration — sponsored (gasless) path', () => {
	it('sponsorable probe → relays exact bytes via MegaFuel → mode sponsored + agentId decoded', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 0n });
		const receipt = {
			status: 'success',
			blockNumber: 123n,
			logs: [{ address: TESTNET_REGISTRY.toLowerCase(), topics: [REGISTERED_TOPIC0, agentTopic(7)] }],
		};
		const calls = [];
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({ receipt }),
			megafuelOpts: {
				megafuelRpc: async (method, params) => {
					calls.push(method);
					if (method === 'pm_isSponsorable') return { sponsorable: true, sponsorAddress: '0xspon' };
					if (method === 'eth_sendRawTransaction') {
						expect(params[0]).toBe(signed); // exact client bytes relayed, not re-signed
						return '0x' + 'a'.repeat(64);
					}
					return null;
				},
			},
		});
		expect(out.mode).toBe('sponsored');
		expect(out.hash).toBe('0x' + 'a'.repeat(64));
		expect(out.agentId).toBe('7');
		expect(out.pending).toBe(false);
		expect(calls).toEqual(['pm_isSponsorable', 'eth_sendRawTransaction']);
	});

	it('MegaFuel decline → mode declined, no broadcast attempted', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 0n });
		let broadcast = false;
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({ sendRawTransaction: () => { broadcast = true; } }),
			megafuelOpts: {
				megafuelRpc: async (m) => {
					if (m === 'eth_sendRawTransaction') broadcast = true;
					return { sponsorable: false, reason: 'no policy for sender' };
				},
			},
		});
		expect(out.mode).toBe('declined');
		expect(out.reason).toMatch(/no policy/);
		expect(out.hint).toMatch(/self-pay/i);
		expect(broadcast).toBe(false);
	});
});

describe('relayGaslessRegistration — self-pay path', () => {
	it('gasPrice > 0 → broadcasts as-is, mode self-pay, agentId decoded from a Transfer-only receipt', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 1_000_000_000n });
		// Transfer(address indexed from, address indexed to, uint256 indexed
		// tokenId) → topics = [sig, from, to, tokenId]. `from` is the zero
		// address on every mint; the id lives at topics[3], not topics[1] — a
		// real bug caught live (see PROGRESS.md 2026-07-08) where a naive
		// "first Registered-or-Transfer match, read topics[1]" decoded
		// Transfer's `from` as the agentId whenever Transfer preceded
		// Registered in the same receipt (which the real registry always does).
		const zeroAddrTopic = '0x' + '0'.repeat(64);
		const toTopic = '0x' + '0'.repeat(24) + account.address.slice(2).toLowerCase();
		const receipt = {
			status: 'success',
			blockNumber: 456n,
			logs: [{ address: TESTNET_REGISTRY.toLowerCase(), topics: [TRANSFER_TOPIC0, zeroAddrTopic, toTopic, agentTopic(99)] }],
		};
		let sentBytes;
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({
				receipt,
				sendRawTransaction: ({ serializedTransaction }) => {
					sentBytes = serializedTransaction;
					return '0x' + 'b'.repeat(64);
				},
			}),
		});
		expect(sentBytes).toBe(signed);
		expect(out.mode).toBe('self-pay');
		expect(out.hash).toBe('0x' + 'b'.repeat(64));
		expect(out.agentId).toBe('99');
	});

	it('a receipt carrying BOTH Transfer (first) and Registered (second) prefers Registered', async () => {
		// Exactly the real-world log order the live registry emits on every
		// mint — Transfer before Registered in the same receipt. Regression
		// test for the bug above: Registered must win regardless of log order.
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 1_000_000_000n });
		const zeroAddrTopic = '0x' + '0'.repeat(64);
		const toTopic = '0x' + '0'.repeat(24) + account.address.slice(2).toLowerCase();
		const receipt = {
			status: 'success',
			blockNumber: 789n,
			logs: [
				{ address: TESTNET_REGISTRY.toLowerCase(), topics: [TRANSFER_TOPIC0, zeroAddrTopic, toTopic, agentTopic(1591)] },
				{ address: TESTNET_REGISTRY.toLowerCase(), topics: [REGISTERED_TOPIC0, agentTopic(1591), toTopic] },
			],
		};
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({ receipt, sendRawTransaction: () => '0x' + 'f'.repeat(64) }),
		});
		expect(out.agentId).toBe('1591');
	});

	it('insufficient funds on broadcast → typed RegisterRelayError', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 1_000_000_000n });
		await expect(
			relayGaslessRegistration({
				signedRegisterTx: signed,
				network: 'bscTestnet',
				publicClient: mockPublicClient({
					sendRawTransaction: () => { throw new Error('insufficient funds for gas * price + value'); },
				}),
			}),
		).rejects.toMatchObject({ code: 'insufficient_funds' });
	});
});

describe('relayGaslessRegistration — revert decoding', () => {
	it('reverted receipt → replays the call for a real reason, not a bare "reverted"', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 1_000_000_000n });
		await expect(
			relayGaslessRegistration({
				signedRegisterTx: signed,
				network: 'bscTestnet',
				publicClient: mockPublicClient({
					receipt: { status: 'reverted', blockNumber: 1n, logs: [] },
					call: () => { throw Object.assign(new Error('execution reverted: already registered'), { shortMessage: 'already registered' }); },
				}),
			}),
		).rejects.toMatchObject({ code: 'tx_reverted', message: 'already registered' });
	});
});

describe('relayGaslessRegistration — pending state', () => {
	it('receipt wait timeout → pending:true with the real hash, not a hard failure', async () => {
		const account = await freshAccount();
		const signed = await signRegisterTx(account, { gasPrice: 0n });
		const out = await relayGaslessRegistration({
			signedRegisterTx: signed,
			network: 'bscTestnet',
			publicClient: mockPublicClient({ receipt: new Error('timeout') }),
			megafuelOpts: {
				megafuelRpc: async (m) => {
					if (m === 'pm_isSponsorable') return { sponsorable: true };
					if (m === 'eth_sendRawTransaction') return '0x' + 'c'.repeat(64);
					return null;
				},
			},
		});
		expect(out.pending).toBe(true);
		expect(out.hash).toBe('0x' + 'c'.repeat(64));
		expect(out.agentId).toBeNull();
	});
});

describe('RegisterRelayError', () => {
	it('is an Error subclass carrying code + status', () => {
		const err = new RegisterRelayError('boom', { code: 'x', status: 418 });
		expect(err).toBeInstanceOf(Error);
		expect(err.code).toBe('x');
		expect(err.status).toBe(418);
	});
});
