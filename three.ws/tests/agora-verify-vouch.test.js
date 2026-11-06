// @vitest-environment jsdom
//
// Agora — the Verify → vouch bridge (Task 08 DoD item 4). A human who re-hashes a
// deliverable and sees it match the on-chain proofHash must be one click away
// from leaving a real on-chain vouch for the citizen who produced it. verify.js
// stays pure of auth/actions, so it wires the bridge by dispatching the decoupled
// `agora:vouch-prompt` event that the human HUD turns into the attestation.
//
// These tests exercise mountVerifier in a real DOM: a matching verdict surfaces
// the vouch CTA (only when the worker is known), clicking it dispatches the event
// with the worker context, and a mismatch never offers a vouch (you can't attest
// to work that failed verification).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mountVerifier } from '../src/agora/verify.js';

const sha256Node = (buf) => createHash('sha256').update(buf).digest('hex');

// A minimal fetch stub returning `bytes` for any URL, driving mountVerifier's
// no-stream (arrayBuffer) path with an honest content-type + length.
function stubFetch(bytes, { contentType = 'text/plain' } = {}) {
	const headers = new Map([
		['content-type', contentType],
		['content-length', String(bytes.byteLength)],
	]);
	globalThis.fetch = vi.fn(async () => ({
		ok: true,
		status: 200,
		statusText: 'OK',
		headers: { get: (k) => headers.get(String(k).toLowerCase()) ?? null },
		body: null, // → arrayBuffer path (no ReadableStream in the stub)
		arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
	}));
}

// Click Verify and wait for the async re-hash to settle (verdict rendered).
async function runVerify(container) {
	container.querySelector('.agora-btn-primary').click();
	for (let i = 0; i < 200; i++) {
		if (container.querySelector('.agora-verdict')) return;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error('verdict never rendered');
}

describe('Verify → vouch bridge', () => {
	let root;
	beforeEach(() => { root = document.createElement('div'); document.body.appendChild(root); });
	afterEach(() => { root.remove(); vi.restoreAllMocks(); delete globalThis.fetch; });

	it('offers a one-click vouch on a match and dispatches the worker context', async () => {
		const bytes = new TextEncoder().encode('a real, verified deliverable');
		const proofHash = sha256Node(Buffer.from(bytes));
		stubFetch(bytes);

		mountVerifier(root, {
			deliverableUrl: 'https://cdn.example/deliverable.txt',
			proofHash,
			worker: { agentPda: 'Wk1111111111111111111111111111111111111111', name: 'Aria', taskPda: 'Tsk2222', cluster: 'devnet' },
		});

		await runVerify(root);

		expect(root.querySelector('.agora-verdict.is-match')).toBeTruthy();
		const vouchBtn = root.querySelector('.agora-verify-vouch-btn');
		expect(vouchBtn).toBeTruthy();
		expect(vouchBtn.textContent).toContain('Aria');

		const events = [];
		window.addEventListener('agora:vouch-prompt', (e) => events.push(e.detail), { once: true });
		vouchBtn.click();

		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			agentPda: 'Wk1111111111111111111111111111111111111111',
			name: 'Aria',
			taskPda: 'Tsk2222',
			cluster: 'devnet',
			proofHash,
			verified: true,
		});
	});

	it('never offers a vouch on a mismatch (no attesting to failed verification)', async () => {
		const bytes = new TextEncoder().encode('the bytes actually served');
		const wrongProof = sha256Node(Buffer.from('a different, expected artifact'));
		stubFetch(bytes);

		mountVerifier(root, {
			deliverableUrl: 'https://cdn.example/tampered.txt',
			proofHash: wrongProof,
			worker: { agentPda: 'Wk1111111111111111111111111111111111111111', name: 'Aria' },
		});

		await runVerify(root);

		expect(root.querySelector('.agora-verdict.is-mismatch')).toBeTruthy();
		expect(root.querySelector('.agora-verify-vouch-btn')).toBeNull();
	});

	it('omits the vouch CTA when the worker is unknown (nothing to vouch for)', async () => {
		const bytes = new TextEncoder().encode('verified but authorless');
		const proofHash = sha256Node(Buffer.from(bytes));
		stubFetch(bytes);

		mountVerifier(root, { deliverableUrl: 'https://cdn.example/x.txt', proofHash }); // no worker

		await runVerify(root);

		expect(root.querySelector('.agora-verdict.is-match')).toBeTruthy();
		expect(root.querySelector('.agora-verify-vouch-btn')).toBeNull();
	});
});
