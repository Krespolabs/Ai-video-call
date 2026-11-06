/**
 * confirmOrThrow / pollConfirmation / sendAndConfirm — unit tests.
 *
 * Confirmation happens over HTTP polling (`getSignatureStatuses`), never a WebSocket
 * subscription — that WS path bypassed the RPC failover and produced the
 * `ws error: Unexpected server response: 429` reconnect storm in production. These
 * tests assert the polling mechanism, the throw-on-revert guarantee (a landed-but-
 * reverted tx must never resolve as confirmed), and blockhash-expiry handling, all
 * against a fake Connection so no RPC is hit.
 */

import { describe, it, expect, vi } from 'vitest';
import { confirmOrThrow, pollConfirmation, sendAndConfirm } from '../api/_lib/solana/confirm.js';

// A fake Connection whose getSignatureStatuses returns a scripted sequence of
// per-signature statuses. `steps` is an array of status objects (or null) returned on
// successive polls; the last entry sticks. blockHeight is a fixed value for expiry.
function fakeConn({ steps = [], blockHeight = 0 } = {}) {
	let i = 0;
	return {
		getSignatureStatuses: vi.fn(async () => {
			const st = steps[Math.min(i, steps.length - 1)];
			i++;
			return { context: { slot: 1 }, value: [st ?? null] };
		}),
		getBlockHeight: vi.fn(async () => blockHeight),
	};
}

describe('pollConfirmation / confirmOrThrow', () => {
	it('resolves once the status reaches the requested commitment', async () => {
		const conn = fakeConn({ steps: [null, { confirmationStatus: 'processed', err: null, slot: 5 }, { confirmationStatus: 'confirmed', err: null, slot: 5 }] });
		const out = await confirmOrThrow(conn, 'sig123', 'confirmed');
		expect(out.value.err).toBeNull();
		expect(out.value.confirmationStatus).toBe('confirmed');
		expect(conn.getSignatureStatuses).toHaveBeenCalledWith(['sig123']);
	});

	it('throws when the tx landed but reverted (status carries err)', async () => {
		const conn = fakeConn({ steps: [{ confirmationStatus: 'confirmed', err: { InstructionError: [0, { Custom: 6001 }] }, slot: 7 }] });
		await expect(confirmOrThrow(conn, 'sigABC', 'confirmed')).rejects.toThrow(/reverted on-chain/);
	});

	it('tags the thrown revert with code, signature, and the on-chain err', async () => {
		const onChainErr = { InstructionError: [1, 'ProgramFailedToComplete'] };
		const conn = fakeConn({ steps: [{ confirmationStatus: 'confirmed', err: onChainErr, slot: 3 }] });
		await expect(confirmOrThrow(conn, 'deadbeef', 'confirmed')).rejects.toMatchObject({
			code: 'tx_reverted',
			signature: 'deadbeef',
			onChainErr,
		});
	});

	it('extracts the signature from the object strategy form', async () => {
		const conn = fakeConn({ steps: [{ confirmationStatus: 'confirmed', err: { foo: 'bar' }, slot: 2 }] });
		await expect(
			confirmOrThrow(conn, { signature: 'objSig', blockhash: 'bh', lastValidBlockHeight: 9 }, 'confirmed'),
		).rejects.toMatchObject({ signature: 'objSig', code: 'tx_reverted' });
	});

	it('defaults the commitment to "confirmed"', async () => {
		const conn = fakeConn({ steps: [{ confirmationStatus: 'confirmed', err: null, slot: 1 }] });
		const out = await confirmOrThrow(conn, 'sig');
		expect(out.value.err).toBeNull();
	});

	it('throws tx_expired when the blockhash is no longer valid and the tx never landed', async () => {
		// Status stays null (never lands); block height is already past lastValidBlockHeight.
		const conn = fakeConn({ steps: [null], blockHeight: 200 });
		await expect(
			pollConfirmation(conn, { signature: 'gone', blockhash: 'bh', lastValidBlockHeight: 100 }, 'confirmed'),
		).rejects.toMatchObject({ code: 'tx_expired', signature: 'gone' });
	});

	it('throws tx_confirm_timeout for a bare signature that never lands', async () => {
		const conn = fakeConn({ steps: [null] });
		await expect(pollConfirmation(conn, 'stuck', 'confirmed', { timeoutMs: 0 })).rejects.toMatchObject({
			code: 'tx_confirm_timeout',
			signature: 'stuck',
		});
	});

	it('never opens a WebSocket — it uses getSignatureStatuses, not confirmTransaction', async () => {
		const conn = fakeConn({ steps: [{ confirmationStatus: 'confirmed', err: null, slot: 1 }] });
		conn.confirmTransaction = vi.fn();
		await confirmOrThrow(conn, 'sig');
		expect(conn.confirmTransaction).not.toHaveBeenCalled();
	});
});

describe('sendAndConfirm', () => {
	it('signs, broadcasts, polls to confirmation, and returns the signature', async () => {
		const conn = {
			getLatestBlockhash: vi.fn(async () => ({ blockhash: 'BH', lastValidBlockHeight: 150 })),
			sendRawTransaction: vi.fn(async () => 'sigSENT'),
			getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [{ confirmationStatus: 'confirmed', err: null, slot: 1 }] })),
			getBlockHeight: vi.fn(async () => 10),
		};
		const signer = { publicKey: { toBase58: () => 'PAYER' } };
		const tx = { serialize: () => Buffer.from('x'), sign: vi.fn() };
		const sig = await sendAndConfirm(conn, tx, [signer], { commitment: 'confirmed' });
		expect(sig).toBe('sigSENT');
		expect(tx.sign).toHaveBeenCalledWith(signer);
		expect(tx.recentBlockhash).toBe('BH');
		expect(tx.feePayer).toBe(signer.publicKey);
	});

	it('throws when no signer is provided', async () => {
		await expect(sendAndConfirm({}, {}, [])).rejects.toThrow(/at least one signer/);
	});
});
