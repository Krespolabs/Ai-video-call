/**
 * Proof-of-Custody — canonical leaf encoding + Merkle tree.
 *
 * This is the SINGLE source of truth for how a custodial-wallet attestation is
 * hashed. The server prover (api/_lib/custody-proof.js) and the in-browser
 * independent verifier (src/proof-of-custody/verifier.js) both import THIS file,
 * so the leaf encoding and the tree construction can never drift between the
 * side that builds a proof and the side that checks it. Any change here is a
 * change to both at once, and the golden tests in tests/custody-merkle.test.js
 * pin the exact bytes.
 *
 * Isomorphic by design: it uses only `globalThis.crypto.subtle` (Web Crypto),
 * which is present in modern browsers and in the Node runtime the API functions
 * run on — no Node-only (`node:crypto`) or browser-only imports — so the exact
 * same module loads in a Vite bundle and in a Vercel function.
 *
 * Domain separation: leaf hashes are prefixed with 0x00 and internal nodes with
 * 0x01 before hashing, so no internal node can ever be reinterpreted as a leaf
 * (second-preimage hardening, the standard Certificate-Transparency convention).
 */

export const LEAF_DOMAIN = 'threews-custody-leaf:v1';
const LEAF_PREFIX = 0x00;
const NODE_PREFIX = 0x01;

const enc = new TextEncoder();

/** Resolve Web Crypto's SubtleCrypto in either runtime, or throw clearly. */
function subtle() {
	const s = globalThis.crypto && globalThis.crypto.subtle;
	if (!s) {
		throw new Error('Web Crypto SubtleCrypto unavailable — cannot hash custody leaves');
	}
	return s;
}

/** Lowercase hex of a byte array. */
export function bytesToHex(bytes) {
	let out = '';
	for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
	return out;
}

/** Parse a 64-char lowercase/uppercase hex string into a 32-byte Uint8Array. */
export function hexToBytes(hex) {
	const h = String(hex || '').trim().toLowerCase();
	if (!/^[0-9a-f]*$/.test(h) || h.length % 2 !== 0) {
		throw new Error('invalid hex string');
	}
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function sha256(bytes) {
	const digest = await subtle().digest('SHA-256', bytes);
	return new Uint8Array(digest);
}

function concatBytes(...arrays) {
	let total = 0;
	for (const a of arrays) total += a.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const a of arrays) { out.set(a, off); off += a.length; }
	return out;
}

/**
 * Canonical, injective preimage string for one custodial wallet at one epoch.
 * Fields are newline-joined under a versioned domain header. Every field is a
 * value with no newline (uuid, base58 address, decimal integer, ledger-head
 * token, integer epoch), so the join is unambiguous and reproducible byte-for-
 * byte on both server and client.
 *
 * @param {object} f
 * @param {string} f.agentId   wallet/agent UUID (public)
 * @param {string} f.address   custodial Solana address, base58 (public)
 * @param {string|number|bigint} f.balanceLamports  on-chain balance in lamports, integer
 * @param {string} f.ledgerHead  commitment to the authorized-state head
 *                                (e.g. "<lastEventId>:<lastSignature>" or "genesis")
 * @param {number} f.epoch      monotonic epoch number, integer
 * @returns {string}
 */
export function leafPreimage(f) {
	const balance = normalizeInteger(f.balanceLamports, 'balanceLamports');
	const epoch = normalizeInteger(f.epoch, 'epoch');
	const agentId = requireField(f.agentId, 'agentId');
	const address = requireField(f.address, 'address');
	const ledgerHead = String(f.ledgerHead ?? 'genesis');
	for (const [k, v] of [['agentId', agentId], ['address', address], ['ledgerHead', ledgerHead]]) {
		if (v.includes('\n')) throw new Error(`custody leaf field ${k} must not contain a newline`);
	}
	return [LEAF_DOMAIN, agentId, address, balance, ledgerHead, epoch].join('\n');
}

function requireField(v, name) {
	if (v == null || v === '') throw new Error(`custody leaf field ${name} is required`);
	return String(v);
}

/** Coerce to a canonical non-negative integer decimal string (no float, no sign drift). */
function normalizeInteger(v, name) {
	if (typeof v === 'bigint') {
		if (v < 0n) throw new Error(`custody leaf field ${name} must be >= 0`);
		return v.toString();
	}
	const s = String(v).trim();
	if (!/^\d+$/.test(s)) throw new Error(`custody leaf field ${name} must be a non-negative integer (got "${s}")`);
	// strip a single leading run of zeros while keeping "0"
	return s.replace(/^0+(?=\d)/, '');
}

/** 32-byte leaf hash (hex) of one wallet's attested state. */
export async function computeLeafHash(fields) {
	const preimage = leafPreimage(fields);
	const h = await sha256(concatBytes(Uint8Array.of(LEAF_PREFIX), enc.encode(preimage)));
	return bytesToHex(h);
}

/** Hash an internal node from its two child hashes (hex in, hex out). */
export async function hashNode(leftHex, rightHex) {
	const h = await sha256(concatBytes(Uint8Array.of(NODE_PREFIX), hexToBytes(leftHex), hexToBytes(rightHex)));
	return bytesToHex(h);
}

/**
 * Build a Merkle tree over an ordered array of leaf-hash hex strings.
 * Odd layers promote by duplicating the last node (hash(last,last)).
 * @param {string[]} leaves  ordered leaf hashes (hex)
 * @returns {Promise<{ root: string|null, layers: string[][], size: number }>}
 *          layers[0] === leaves; layers[last] === [root]. Empty input → root null.
 */
export async function buildMerkleTree(leaves) {
	const size = leaves.length;
	if (size === 0) return { root: null, layers: [[]], size: 0 };
	const layers = [leaves.slice()];
	let level = layers[0];
	while (level.length > 1) {
		const next = [];
		for (let i = 0; i < level.length; i += 2) {
			const left = level[i];
			const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last when odd
			next.push(await hashNode(left, right));
		}
		layers.push(next);
		level = next;
	}
	return { root: layers[layers.length - 1][0], layers, size };
}

/** Convenience: just the root for an ordered leaf-hash array. */
export async function merkleRoot(leaves) {
	return (await buildMerkleTree(leaves)).root;
}

/**
 * Inclusion proof for the leaf at `index` in a built tree's layers.
 * @returns {{ sibling: string, position: 'left'|'right' }[]} bottom-up path.
 *          `position` is the SIBLING's side relative to the running node.
 */
export function getMerkleProof(layers, index) {
	const proof = [];
	let idx = index;
	for (let level = 0; level < layers.length - 1; level++) {
		const nodes = layers[level];
		const isRight = idx % 2 === 1;
		const siblingIdx = isRight ? idx - 1 : idx + 1;
		// When the layer is odd and `idx` is the last (left) node, it pairs with
		// itself — the sibling is the node itself, on the right.
		const sibling = siblingIdx < nodes.length ? nodes[siblingIdx] : nodes[idx];
		proof.push({ sibling, position: isRight ? 'left' : 'right' });
		idx = Math.floor(idx / 2);
	}
	return proof;
}

/**
 * Fold an inclusion proof from a leaf hash up to a root and return the computed
 * root (hex). The verifier compares this against the on-chain anchored root.
 */
export async function computeRootFromProof(leafHex, proof) {
	let node = String(leafHex).toLowerCase();
	for (const step of proof) {
		const sib = String(step.sibling).toLowerCase();
		node = step.position === 'left' ? await hashNode(sib, node) : await hashNode(node, sib);
	}
	return node;
}

/**
 * Verify that `leafHex` is included under `expectedRootHex` via `proof`.
 * Pure boolean — never throws on a mismatch, only on malformed hex input.
 */
export async function verifyMerkleProof(leafHex, proof, expectedRootHex) {
	if (!leafHex || !expectedRootHex || !Array.isArray(proof)) return false;
	const computed = await computeRootFromProof(leafHex, proof);
	return computed === String(expectedRootHex).toLowerCase();
}
