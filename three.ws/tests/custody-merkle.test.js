/**
 * Verifiable Proof-of-Custody — Merkle/leaf unit tests.
 *
 * Pins the canonical leaf encoding (golden vectors), the Merkle tree build, and
 * the inclusion-proof verify path, including the cross-implementation guarantee
 * the whole feature rests on: the SAME module that the server prover uses to
 * build a proof (src/proof-of-custody/merkle.js) accepts exactly that proof on
 * the client and rejects any tampered input. Also covers epoch monotonicity and
 * the end-to-end browser verifier (with a mocked on-chain anchor fetch).
 */

import { describe, it, expect } from 'vitest';
import {
	leafPreimage,
	computeLeafHash,
	buildMerkleTree,
	merkleRoot,
	getMerkleProof,
	verifyMerkleProof,
	computeRootFromProof,
	hashNode,
} from '../src/proof-of-custody/merkle.js';
import { verifyInclusionProof, readOnchainAnchor } from '../src/proof-of-custody/verifier.js';

const GOLDEN_LEAF_FIELDS = {
	agentId: '11111111-1111-4111-8111-111111111111',
	address: 'THREEsynthetic1111111111111111111111111111',
	balanceLamports: '1000000000',
	ledgerHead: 'genesis',
	epoch: 1,
};
const GOLDEN_LEAF_HASH = 'c656d7532c7e0a535107d63d22d549a81b3d8659efe91700ea8a161dfb07d7b7';

async function leaves() {
	const a = await computeLeafHash({ agentId: 'a', address: 'A', balanceLamports: '0', ledgerHead: 'genesis', epoch: 1 });
	const b = await computeLeafHash({ agentId: 'b', address: 'B', balanceLamports: '5', ledgerHead: '1:sig', epoch: 1 });
	const c = await computeLeafHash({ agentId: 'c', address: 'C', balanceLamports: '9', ledgerHead: 'genesis', epoch: 1 });
	return { a, b, c };
}

describe('leaf encoding', () => {
	it('produces a stable, newline-joined, domain-tagged preimage', () => {
		expect(leafPreimage(GOLDEN_LEAF_FIELDS)).toBe(
			'threews-custody-leaf:v1\n11111111-1111-4111-8111-111111111111\nTHREEsynthetic1111111111111111111111111111\n1000000000\ngenesis\n1',
		);
	});

	it('matches the golden leaf hash (server↔client pin)', async () => {
		expect(await computeLeafHash(GOLDEN_LEAF_FIELDS)).toBe(GOLDEN_LEAF_HASH);
	});

	it('normalizes integers: leading zeros, numbers, and bigints all agree', async () => {
		const base = await computeLeafHash(GOLDEN_LEAF_FIELDS);
		expect(await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, balanceLamports: 1000000000 })).toBe(base);
		expect(await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, balanceLamports: 1000000000n })).toBe(base);
		expect(await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, balanceLamports: '0001000000000' })).toBe(base);
		expect(await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, epoch: '1' })).toBe(base);
	});

	it('rejects non-integer / negative / missing fields', async () => {
		await expect(computeLeafHash({ ...GOLDEN_LEAF_FIELDS, balanceLamports: '1.5' })).rejects.toThrow();
		await expect(computeLeafHash({ ...GOLDEN_LEAF_FIELDS, balanceLamports: -1n })).rejects.toThrow();
		await expect(computeLeafHash({ ...GOLDEN_LEAF_FIELDS, agentId: '' })).rejects.toThrow();
		await expect(computeLeafHash({ ...GOLDEN_LEAF_FIELDS, address: 'has\nnewline' })).rejects.toThrow();
	});

	it('changes when the epoch advances (replay/rollback shows up in the leaf)', async () => {
		const e1 = await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, epoch: 1 });
		const e2 = await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, epoch: 2 });
		expect(e1).not.toBe(e2);
	});

	it('changes when the balance or ledger head changes', async () => {
		const base = await computeLeafHash(GOLDEN_LEAF_FIELDS);
		expect(await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, balanceLamports: '999999999' })).not.toBe(base);
		expect(await computeLeafHash({ ...GOLDEN_LEAF_FIELDS, ledgerHead: '42:abc' })).not.toBe(base);
	});
});

describe('merkle tree', () => {
	it('single leaf: root is the leaf itself', async () => {
		const { a } = await leaves();
		const tree = await buildMerkleTree([a]);
		expect(tree.root).toBe(a);
		expect(getMerkleProof(tree.layers, 0)).toEqual([]);
	});

	it('domain separation: node hash uses the 0x01 prefix and is order-sensitive', async () => {
		const { a, b } = await leaves();
		expect(await hashNode(a, b)).not.toBe(await hashNode(b, a));
		// two-leaf root === hashNode(left,right)
		expect(await merkleRoot([a, b])).toBe(await hashNode(a, b));
	});

	it('odd layer promotes by duplicating the last node', async () => {
		const { a, b, c } = await leaves();
		const expected = await hashNode(await hashNode(a, b), await hashNode(c, c));
		expect(await merkleRoot([a, b, c])).toBe(expected);
	});

	it('empty tree has a null root', async () => {
		expect((await buildMerkleTree([])).root).toBeNull();
	});

	it('inclusion proof verifies for every index (2..5 leaves)', async () => {
		const { a, b, c } = await leaves();
		const d = await computeLeafHash({ agentId: 'd', address: 'D', balanceLamports: '7', ledgerHead: 'genesis', epoch: 1 });
		const e = await computeLeafHash({ agentId: 'e', address: 'E', balanceLamports: '3', ledgerHead: 'genesis', epoch: 1 });
		for (const set of [[a, b], [a, b, c], [a, b, c, d], [a, b, c, d, e]]) {
			const tree = await buildMerkleTree(set);
			for (let i = 0; i < set.length; i++) {
				const proof = getMerkleProof(tree.layers, i);
				expect(await computeRootFromProof(set[i], proof)).toBe(tree.root);
				expect(await verifyMerkleProof(set[i], proof, tree.root)).toBe(true);
			}
		}
	});

	it('tampering fails verification (leaf, sibling, and root)', async () => {
		const { a, b, c } = await leaves();
		const set = [a, b, c];
		const tree = await buildMerkleTree(set);
		const proof = getMerkleProof(tree.layers, 1);
		// genuine
		expect(await verifyMerkleProof(set[1], proof, tree.root)).toBe(true);
		// tampered leaf
		expect(await verifyMerkleProof(c, proof, tree.root)).toBe(false);
		// tampered sibling in the path
		const badProof = proof.map((s, i) => (i === 0 ? { ...s, sibling: c } : s));
		expect(await verifyMerkleProof(set[1], badProof, tree.root)).toBe(false);
		// tampered root
		expect(await verifyMerkleProof(set[1], proof, 'deadbeef'.repeat(8))).toBe(false);
	});
});

describe('browser verifier (cross-impl prover→verifier)', () => {
	// Build a server-shaped inclusion proof for one wallet, then run the exact
	// client verifier against it with a mocked on-chain anchor read.
	async function buildServerProof({ epoch = 3, tamper = null } = {}) {
		const wallets = [
			{ agentId: 'agent-A', address: 'AAAA1111', balanceLamports: '2000000000', ledgerHead: '10:sig' },
			{ agentId: 'agent-B', address: 'BBBB2222', balanceLamports: '500000000', ledgerHead: 'genesis' },
			{ agentId: 'agent-C', address: 'CCCC3333', balanceLamports: '0', ledgerHead: '3:sig' },
		];
		const leafHashes = [];
		for (const w of wallets) leafHashes.push(await computeLeafHash({ ...w, epoch }));
		const tree = await buildMerkleTree(leafHashes);
		const idx = 1; // prove wallet B
		const w = wallets[idx];
		const proof = getMerkleProof(tree.layers, idx);
		const onchainRoot = tamper === 'root' ? 'ff'.repeat(32) : tree.root;
		const fetchTx = async () => ({
			tx: { transaction: { message: { instructions: [
				{ program: 'spl-memo', parsed: JSON.stringify({ v: 1, kind: 'threews.custody.v1', epoch, root: onchainRoot }) },
			] } } },
			endpoint: 'https://api.devnet.solana.com',
		});
		return {
			fetchTx,
			data: {
				included: true,
				epoch,
				network: 'mainnet',
				anchor: { network: 'devnet', signature: 'SIG', explorer: 'https://solscan.io/tx/SIG?cluster=devnet', status: 'anchored' },
				leaf: { ...w, epoch, index: idx, leafHash: tamper === 'leaf' ? 'aa'.repeat(32) : leafHashes[idx] },
				proof,
				merkle_root: tree.root,
				wallet_count: wallets.length,
			},
		};
	}

	it('accepts a valid server proof against the on-chain root', async () => {
		const { data, fetchTx } = await buildServerProof();
		const out = await verifyInclusionProof(data, { fetchTx });
		expect(out.verified).toBe(true);
		expect(out.steps.every((s) => s.ok)).toBe(true);
	});

	it('rejects a tampered leaf hash and names the failing step', async () => {
		const { data, fetchTx } = await buildServerProof({ tamper: 'leaf' });
		const out = await verifyInclusionProof(data, { fetchTx });
		expect(out.verified).toBe(false);
		expect(out.steps.find((s) => s.name === 'leaf_recompute').ok).toBe(false);
	});

	it('rejects when the on-chain root does not match the computed root', async () => {
		const { data, fetchTx } = await buildServerProof({ tamper: 'root' });
		const out = await verifyInclusionProof(data, { fetchTx });
		expect(out.verified).toBe(false);
		expect(out.steps.find((s) => s.name === 'root_match').ok).toBe(false);
	});

	it('treats a failed anchor fetch as UNVERIFIED, never verified', async () => {
		const { data } = await buildServerProof();
		const fetchTx = async () => { throw new Error('rpc down'); };
		const out = await verifyInclusionProof(data, { fetchTx });
		expect(out.verified).toBe(false);
		expect(out.steps.find((s) => s.name === 'onchain_anchor').ok).toBe(false);
	});

	it('reports "not included" honestly when there is no leaf yet', async () => {
		const out = await verifyInclusionProof({ included: false, reason: 'no_leaf_yet' });
		expect(out.verified).toBe(false);
		expect(out.steps[0].ok).toBe(false);
	});

	it('readOnchainAnchor extracts epoch + root from the memo', async () => {
		const fetchTx = async () => ({
			tx: { transaction: { message: { instructions: [
				{ program: 'spl-memo', parsed: JSON.stringify({ kind: 'threews.custody.v1', epoch: 7, root: 'ab'.repeat(32), wallet_count: 4 }) },
			] } } },
			endpoint: 'rpc',
		});
		const out = await readOnchainAnchor('SIG', 'devnet', { fetchTx });
		expect(out.epoch).toBe(7);
		expect(out.root).toBe('ab'.repeat(32));
		expect(out.walletCount).toBe(4);
	});
});
