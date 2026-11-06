/**
 * Signed memory — the integrity + authorship layer of the Portable & Verifiable Brain.
 *
 * Every memory an agent commits is signed by the agent's own EVM wallet
 * (the same secp256k1 key behind its ERC-8004 on-chain identity) using ERC-191
 * `personal_sign`. The signature is publicly verifiable: anyone holding the
 * memory and the agent's wallet address can `ecrecover` the signer and confirm
 * the content was authored by that agent and has not been tampered with. This
 * is what makes a forked or purchased brain trustworthy — its history is
 * cryptographically provable, not a claim in our database.
 *
 * The module is split deliberately:
 *   - Pure functions (canonicalizeMemory, memoryDigest, signMessageBody,
 *     verifyMemorySignature) have no DB or wallet dependency and are unit-tested
 *     directly — they are the verification primitive a buyer/forker runs.
 *   - signMemoryWithAgent / loadAgentSigner touch the DB + custodial key vault
 *     (recoverAgentKey) and are exercised through the live endpoints.
 *
 * Signing is best-effort at the write boundary: an agent without a provisioned
 * wallet stores its memory unsigned (signature null) rather than failing the
 * write. The verification path reports "unsigned" honestly — never a fake green
 * check.
 */

import { createHash } from 'node:crypto';
import { Wallet, verifyMessage, computeAddress } from 'ethers';

import { sql } from './db.js';
import { recoverAgentKey } from './agent-wallet.js';

// Bump this prefix on any breaking change to the canonical form or message
// framing — old signatures stay verifiable against their own version string.
export const MEMORY_SIG_VERSION = 'threews:brain:memory:v1';

/**
 * Deterministic, stable serialization of the signable fields of a memory.
 * Field order and tag order are fixed so the same logical memory always
 * produces the same bytes on any machine — the precondition for a reproducible
 * hash and signature. Mutable, non-authorship fields (salience, tier, pinned,
 * access counts, updated_at) are intentionally excluded: re-tiering a memory
 * must not invalidate its authorship signature.
 *
 * Accepts either the snake_case DB row shape or the camelCase decorated shape.
 *
 * @param {object} mem
 * @returns {string} canonical JSON string
 */
export function canonicalizeMemory(mem) {
	const id = mem.id ?? mem.memoryId ?? '';
	const agentId = mem.agent_id ?? mem.agentId ?? '';
	const type = mem.type ?? 'project';
	const content = mem.content ?? '';
	const rawTags = Array.isArray(mem.tags) ? mem.tags : [];
	const tags = [...rawTags].map((t) => String(t)).sort();
	const createdRaw = mem.created_at ?? mem.createdAt ?? null;
	// Normalize timestamps to ISO so a numeric ms input and an ISO input that
	// denote the same instant hash identically.
	const createdAt = createdRaw == null ? '' : new Date(createdRaw).toISOString();

	return JSON.stringify({
		v: MEMORY_SIG_VERSION,
		id: String(id),
		agentId: String(agentId),
		type: String(type),
		content: String(content),
		tags,
		createdAt,
	});
}

/**
 * SHA-256 (hex) of the canonical memory form. This is the `content_hash`
 * persisted alongside the signature — a fast tamper check that does not require
 * elliptic-curve math.
 *
 * @param {object} mem
 * @returns {string} 64-char lowercase hex digest
 */
export function memoryDigest(mem) {
	return createHash('sha256').update(canonicalizeMemory(mem)).digest('hex');
}

/**
 * The exact string that gets ERC-191 signed. Framing the digest with a
 * domain-separating prefix prevents a memory signature from ever being replayed
 * as a signature over some other three.ws message.
 *
 * @param {string} digest hex digest from memoryDigest
 * @returns {string}
 */
export function signMessageBody(digest) {
	return `${MEMORY_SIG_VERSION}:${digest}`;
}

/**
 * Sign a precomputed memory digest with a raw EVM private key. Pure crypto —
 * no DB. Returns the ERC-191 signature and the recovered signer address.
 *
 * @param {string} privKeyHex 0x-prefixed 32-byte private key
 * @param {string} digest hex digest from memoryDigest
 * @returns {Promise<{ signature: string, signer_address: string }>}
 */
export async function signDigest(privKeyHex, digest) {
	const wallet = new Wallet(privKeyHex);
	const signature = await wallet.signMessage(signMessageBody(digest));
	return { signature, signer_address: wallet.address };
}

/**
 * Verify a memory against a signature + claimed signer. Pure crypto — this is
 * the function a buyer/forker runs offline to trust a brain.
 *
 * @param {object} mem the memory (DB row or decorated)
 * @param {object} proof
 * @param {string} proof.signature ERC-191 signature
 * @param {string} proof.signer_address claimed signer (the agent wallet)
 * @param {string} [proof.content_hash] optional stored hash to cross-check
 * @returns {{ valid: boolean, recovered: string|null, digest: string, reason: string }}
 */
export function verifyMemorySignature(mem, { signature, signer_address, content_hash } = {}) {
	const digest = memoryDigest(mem);

	if (content_hash && content_hash.toLowerCase() !== digest.toLowerCase()) {
		return { valid: false, recovered: null, digest, reason: 'content_hash_mismatch' };
	}
	if (!signature || !signer_address) {
		return { valid: false, recovered: null, digest, reason: 'unsigned' };
	}

	let recovered = null;
	try {
		recovered = verifyMessage(signMessageBody(digest), signature);
	} catch {
		return { valid: false, recovered: null, digest, reason: 'malformed_signature' };
	}

	const valid = recovered.toLowerCase() === String(signer_address).toLowerCase();
	return {
		valid,
		recovered,
		digest,
		reason: valid ? 'ok' : 'signer_mismatch',
	};
}

/**
 * Resolve the agent's signing identity: its EVM wallet address + a decrypted
 * private key. DB + custodial vault. Returns null when the agent has no
 * provisioned EVM wallet (caller stores the memory unsigned).
 *
 * @param {string} agentId
 * @param {object} [audit] passed through to recoverAgentKey for the custody trail
 * @returns {Promise<{ address: string, privKey: string }|null>}
 */
export async function loadAgentSigner(agentId, audit = null) {
	const [row] = await sql`
		SELECT wallet_address, meta FROM agent_identities
		WHERE id = ${agentId} AND deleted_at IS NULL
		LIMIT 1
	`;
	if (!row) return null;
	const encrypted = row.meta?.encrypted_wallet_key;
	if (!encrypted) return null;

	const privKey = await recoverAgentKey(encrypted, audit || { agentId, reason: 'brain_sign' });
	const address = row.wallet_address || computeAddress(privKey);
	return { address, privKey };
}

/**
 * Sign a memory row with its agent's wallet and persist the signature.
 * Best-effort: returns an unsigned descriptor (signature null) when no wallet
 * exists, never throws on a missing key.
 *
 * @param {object} mem the freshly-inserted memory row (must carry real id + created_at)
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true] write the signature columns back to the row
 * @returns {Promise<{ content_hash: string, signature: string|null, signer_address: string|null, signed_at: string|null }>}
 */
export async function signMemoryWithAgent(mem, { persist = true } = {}) {
	const agentId = mem.agent_id ?? mem.agentId;
	const digest = memoryDigest(mem);

	let signer = null;
	try {
		signer = await loadAgentSigner(agentId);
	} catch (err) {
		// A vault/decrypt failure must not lose the memory — store unsigned and
		// surface the reason for the ops trail.
		console.error('[brain-sign] loadAgentSigner failed', agentId, err?.message);
	}

	if (!signer) {
		if (persist) {
			await sql`
				UPDATE agent_memories SET content_hash = ${digest}
				WHERE id = ${mem.id}
			`;
		}
		return { content_hash: digest, signature: null, signer_address: null, signed_at: null };
	}

	const { signature, signer_address } = await signDigest(signer.privKey, digest);
	const signed_at = new Date().toISOString();

	if (persist) {
		await sql`
			UPDATE agent_memories
			SET content_hash = ${digest},
			    signature = ${signature},
			    signer_address = ${signer_address},
			    signed_at = ${signed_at}
			WHERE id = ${mem.id}
		`;
	}

	return { content_hash: digest, signature, signer_address, signed_at };
}
