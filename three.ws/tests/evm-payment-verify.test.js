// Tests for the EVM USDC payment verifier. We partial-mock viem so the Base
// public client is controllable, but keep the real getAddress / decodeEventLog /
// parseAbiItem so log decoding and checksumming are exercised for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
	client: { getTransactionReceipt: vi.fn(), getBlockNumber: vi.fn() },
}));

vi.mock('viem', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, createPublicClient: vi.fn(() => h.client) };
});

import { verifyEvmUsdcPayment } from '../api/_lib/evm-payment-verify.js';

const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const RECIPIENT = '0x1111111111111111111111111111111111111111';
const TX = '0x' + 'a'.repeat(64);

const padAddr = (a) => '0x' + a.slice(2).toLowerCase().padStart(64, '0');
const padU256 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
function transferLog({ address = USDC_BASE, to, value, from = '0x0000000000000000000000000000000000000002' }) {
	return { address, topics: [TRANSFER_TOPIC, padAddr(from), padAddr(to)], data: padU256(value) };
}

beforeEach(() => {
	h.client.getTransactionReceipt.mockReset();
	h.client.getBlockNumber.mockReset();
	h.client.getBlockNumber.mockResolvedValue(1000n); // head far ahead → confirmations satisfied
});

describe('verifyEvmUsdcPayment', () => {
	it('matches when a sufficient USDC transfer reaches the recipient', async () => {
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [transferLog({ to: RECIPIENT, value: 1_000_000n })],
		});
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('match');
		expect(r.actualAmount).toBe('1000000');
	});

	it('is pending when the tx is not yet mined', async () => {
		h.client.getTransactionReceipt.mockRejectedValue(new Error('not found'));
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('pending');
	});

	it('is pending when confirmations are insufficient', async () => {
		h.client.getBlockNumber.mockResolvedValue(990n); // head == block → 1 confirmation < 2
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [transferLog({ to: RECIPIENT, value: 1_000_000n })],
		});
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('pending');
	});

	it('degrades to retryable pending when the confirmations RPC read faults', async () => {
		// A transport fault on getBlockNumber must NOT strand a real payment as a
		// hard error — the buyer keeps their funds and the confirm retries. (The
		// failover transport rotates endpoints first; this is the last-resort soft
		// fail when every endpoint is down.)
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [transferLog({ to: RECIPIENT, value: 1_000_000n })],
		});
		h.client.getBlockNumber.mockRejectedValue(new Error('fetch failed'));
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('pending');
	});

	it('rejects a reverted transaction', async () => {
		h.client.getTransactionReceipt.mockResolvedValue({ status: 'reverted', blockNumber: 990n, logs: [] });
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('mismatch');
	});

	it('rejects when the transfer went to a different wallet', async () => {
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [transferLog({ to: '0x2222222222222222222222222222222222222222', value: 1_000_000n })],
		});
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('mismatch');
	});

	it('reports a short transfer as a mismatch with the actual amount (tip)', async () => {
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [transferLog({ to: RECIPIENT, value: 400_000n })],
		});
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('mismatch');
		expect(r.actualAmount).toBe('400000');
	});

	it('ignores Transfer events from a non-USDC contract', async () => {
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [transferLog({ address: '0x9999999999999999999999999999999999999999', to: RECIPIENT, value: 1_000_000n })],
		});
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('mismatch');
	});

	it('rejects a malformed tx hash without calling RPC', async () => {
		const r = await verifyEvmUsdcPayment({ txHash: 'nope', chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('mismatch');
		expect(h.client.getTransactionReceipt).not.toHaveBeenCalled();
	});

	it('rejects an unsupported chain', async () => {
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'fantom', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('mismatch');
	});

	it('sums multiple USDC transfers to the recipient in one tx', async () => {
		h.client.getTransactionReceipt.mockResolvedValue({
			status: 'success', blockNumber: 990n,
			logs: [
				transferLog({ to: RECIPIENT, value: 600_000n }),
				transferLog({ to: RECIPIENT, value: 600_000n }),
			],
		});
		const r = await verifyEvmUsdcPayment({ txHash: TX, chain: 'base', recipient: RECIPIENT, expectedAmount: '1000000' });
		expect(r.status).toBe('match');
		expect(r.actualAmount).toBe('1200000');
	});
});
