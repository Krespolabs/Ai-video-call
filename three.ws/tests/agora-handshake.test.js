// Agora cross-chain handshake — unit tests for the bridge math. The handshake's
// honesty depends on the browser re-deriving the canonical AgenC agentId exactly
// as the on-chain bridge does (solana-agent-sdk identity-bridge), so it can
// confirm /api/agenc/link's output rather than trust it. Here we cross-check the
// browser derivation in handshake.js against an INDEPENDENT Node implementation
// of the documented spec — if either drifts, this fails.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import {
	deriveCanonicalAgenCId, parseIdentityProofs, hasDualIdentity,
} from '../src/agora/handshake.js';

const NS_COMPOSITE = 'AgenC/three.ws/composite/v1\0';
const NS_ERC8004 = 'AgenC/three.ws/erc8004/v1\0';
const NS_MPL_CORE = 'AgenC/three.ws/mpl-core/v1\0';
const NS_HANDLE = 'AgenC/three.ws/handle/v1\0';

// Synthetic, valid base58 pubkey for test assets (System program id — clearly
// not a coin, per the repo's no-real-mint rule).
const TEST_ASSET = '11111111111111111111111111111111';

function ercBe(id) {
	let n = BigInt(id);
	const out = Buffer.alloc(32);
	for (let i = 31; i >= 0 && n > 0n; i--) { out[i] = Number(n & 0xffn); n >>= 8n; }
	return out;
}
function nodeSha(...parts) {
	const h = createHash('sha256');
	for (const p of parts) h.update(typeof p === 'string' ? Buffer.from(p, 'utf8') : p);
	return h.digest('hex');
}

describe('deriveCanonicalAgenCId — matches the documented bridge spec', () => {
	it('composite (EVM + Solana) binds both proofs', async () => {
		const erc = '42';
		const mplBase58 = new PublicKey(TEST_ASSET).toBase58();
		const composite = JSON.stringify({ v: 1, erc8004: '0x' + ercBe(erc).toString('hex'), mplCore: mplBase58 });
		const expected = nodeSha(NS_COMPOSITE, composite);

		const got = await deriveCanonicalAgenCId({ erc8004AgentId: erc, mplCoreAsset: TEST_ASSET });
		expect(got.source).toBe('composite');
		expect(got.hex).toBe(expected);
	});

	it('erc8004-only', async () => {
		const expected = nodeSha(NS_ERC8004, ercBe('7'));
		const got = await deriveCanonicalAgenCId({ erc8004AgentId: '7' });
		expect(got.source).toBe('erc8004');
		expect(got.hex).toBe(expected);
	});

	it('mpl-core-only', async () => {
		const expected = nodeSha(NS_MPL_CORE, Buffer.from(new PublicKey(TEST_ASSET).toBytes()));
		const got = await deriveCanonicalAgenCId({ mplCoreAsset: TEST_ASSET });
		expect(got.source).toBe('mpl-core');
		expect(got.hex).toBe(expected);
	});

	it('handle-only is case-insensitive', async () => {
		const expected = nodeSha(NS_HANDLE, 'aria');
		const got = await deriveCanonicalAgenCId({ handle: 'ARIA' });
		expect(got.source).toBe('handle');
		expect(got.hex).toBe(expected);
	});

	it('composite priority: same inputs in either field order resolve identically', async () => {
		const a = await deriveCanonicalAgenCId({ erc8004AgentId: '42', mplCoreAsset: TEST_ASSET, handle: 'ignored' });
		const b = await deriveCanonicalAgenCId({ erc8004AgentId: '42', mplCoreAsset: TEST_ASSET });
		expect(a.hex).toBe(b.hex); // handle is ignored once both chains are present
		expect(a.source).toBe('composite');
	});

	it('produces a 64-char lowercase hex id', async () => {
		const got = await deriveCanonicalAgenCId({ erc8004AgentId: '1', mplCoreAsset: TEST_ASSET });
		expect(got.hex).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe('parseIdentityProofs', () => {
	it('extracts erc8004 + mpl + handle from a metadataUri', () => {
		const uri = 'https://three.ws/.well-known/agent.json?erc8004=42&mpl=' + TEST_ASSET + '&handle=Aria';
		const p = parseIdentityProofs(uri);
		expect(p.erc8004AgentId).toBe('42');
		expect(p.mplCoreAsset).toBe(TEST_ASSET);
		expect(p.handle).toBe('aria');
	});

	it('is null-safe and tolerates a bare query', () => {
		expect(parseIdentityProofs(null)).toEqual({ erc8004AgentId: null, mplCoreAsset: null, handle: null });
		expect(parseIdentityProofs('erc8004=9').erc8004AgentId).toBe('9');
	});
});

describe('hasDualIdentity', () => {
	it('true only when both chains are present', () => {
		expect(hasDualIdentity({ erc8004AgentId: '1', mplCoreAsset: TEST_ASSET })).toBe(true);
		expect(hasDualIdentity({ erc8004AgentId: '1' })).toBe(false);
		expect(hasDualIdentity({ mplCoreAsset: TEST_ASSET })).toBe(false);
		expect(hasDualIdentity({})).toBe(false);
	});
});
