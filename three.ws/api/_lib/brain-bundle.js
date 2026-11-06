/**
 * Portable brain bundle — the `.brain` file format.
 *
 * A schema-versioned, self-describing snapshot of an agent's mind: its persona,
 * a curated set of (signed) memories, an optional on-chain anchor, and a
 * manifest whose `brain_hash` content-addresses the whole set. The bundle is
 * itself signed by the agent's wallet, so a recipient can verify — entirely
 * offline — both that each memory was authored by the agent and that the
 * collection was exported as a coherent, untampered whole.
 *
 * Private memories never travel in the clear: in `encrypted-ipfs` mode their
 * plaintext is replaced by a reference to the wallet-encrypted IPFS object
 * (the owner moves the ciphertext + the key; we cannot read it). In a plaintext
 * export the owner must explicitly opt into including private content, and the
 * UI confirms that consequence.
 *
 * Validation uses zod (already a platform dependency) so import rejects a
 * malformed or partial bundle before it can reconstitute a broken mind.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { verifyMessage } from 'ethers';

import { memoryDigest, verifyMemorySignature, signDigest, signMessageBody } from './brain-sign.js';

export const BRAIN_BUNDLE_VERSION = 'brain/1';
export const BRAIN_HASH_VERSION = 'threews:brain:hash:v1';

const hexHash = z.string().regex(/^[a-f0-9]{64}$/i);

const memoryEntrySchema = z.object({
	id: z.string(),
	type: z.enum(['user', 'feedback', 'project', 'reference']),
	tags: z.array(z.string()).default([]),
	salience: z.number().min(0).max(1).default(0.5),
	tier: z.enum(['working', 'recall', 'archival']).default('recall'),
	is_public: z.boolean().default(false),
	created_at: z.string(),
	// Exactly one of `content` (plaintext) or `cipher` (encrypted reference) is present.
	content: z.string().optional(),
	cipher: z
		.object({
			scheme: z.literal('wallet-aes-gcm-v1'),
			cid: z.string().min(1),
			filename: z.string().min(1),
		})
		.optional(),
	content_hash: hexHash.optional(),
	signature: z.string().optional(),
	signer_address: z.string().optional(),
	signed_at: z.string().nullable().optional(),
});

const anchorSchema = z
	.object({
		brain_hash: hexHash,
		proof_uri: z.string().url().optional(),
		proof_hash: z.string().optional(),
		tx_hash: z.string().optional(),
		chain_id: z.number().int().optional(),
		anchored_at: z.string().optional(),
		explorer_url: z.string().url().nullable().optional(),
	})
	.nullable();

export const brainBundleSchema = z.object({
	version: z.literal(BRAIN_BUNDLE_VERSION),
	exported_at: z.string(),
	agent: z.object({
		id: z.string(),
		name: z.string().nullable().optional(),
		description: z.string().nullable().optional(),
		avatar_id: z.string().nullable().optional(),
		chain_id: z.number().int().nullable().optional(),
		erc8004_agent_id: z.union([z.string(), z.number()]).nullable().optional(),
		wallet_address: z.string().nullable().optional(),
	}),
	persona: z
		.object({
			prompt: z.string().nullable().optional(),
			prompt_hash: z.string().nullable().optional(),
			prompt_sig: z.string().nullable().optional(),
			tone_tags: z.array(z.string()).default([]),
			extracted_at: z.string().nullable().optional(),
		})
		.nullable(),
	memories: z.array(memoryEntrySchema),
	anchor: anchorSchema.optional(),
	manifest: z.object({
		memory_count: z.number().int(),
		public_count: z.number().int(),
		private_count: z.number().int(),
		encrypted_count: z.number().int(),
		brain_hash: hexHash,
		signer_address: z.string().nullable().optional(),
		persona_prompt_hash: z.string().nullable().optional(),
	}),
	// The agent-wallet signature over the manifest.brain_hash. Null when the
	// agent has no provisioned wallet (bundle is then portable but unsigned).
	signature: z
		.object({
			brain_hash: hexHash,
			value: z.string(),
			signer_address: z.string(),
		})
		.nullable(),
	// Provenance is set on a forked/imported bundle so the chain of custody is
	// preserved across owners.
	provenance: z
		.object({
			source_agent_id: z.string(),
			source_brain_hash: hexHash,
			forked_at: z.string(),
		})
		.nullable()
		.optional(),
});

/**
 * Content-address a brain state. Deterministic over the persona hash and the
 * sorted set of memory content-hashes — the same curated mind always yields the
 * same hash, which is what makes the on-chain anchor and the bundle signature
 * meaningful. This exact value is what gets anchored on-chain.
 *
 * @param {object} p
 * @param {string|null} p.personaPromptHash
 * @param {string[]} p.memoryHashes content_hash of each included memory
 * @param {string} p.agentId
 * @returns {string} 64-char hex
 */
export function computeBrainHash({ personaPromptHash = null, memoryHashes = [], agentId = '' }) {
	const sorted = [...memoryHashes].filter(Boolean).map((h) => h.toLowerCase()).sort();
	const core = JSON.stringify({
		v: BRAIN_HASH_VERSION,
		agentId: String(agentId),
		persona: personaPromptHash ? String(personaPromptHash).toLowerCase() : null,
		memories: sorted,
	});
	return createHash('sha256').update(core).digest('hex');
}

/**
 * Build a memory entry for the bundle from a DB row, honoring the storage mode.
 * In encrypted-ipfs mode a private memory's plaintext is dropped in favor of a
 * cipher reference (must have been pinned already); public memories stay plain.
 *
 * @param {object} row agent_memories row (snake_case)
 * @param {object} opts
 * @param {boolean} opts.includePrivatePlaintext include private plaintext (explicit opt-in)
 * @param {Map<string,{cid:string,filename:string}>} [opts.cipherRefs] memoryId → pinned cipher ref
 * @returns {object|null} bundle memory entry, or null if a private memory must be excluded
 */
export function buildMemoryEntry(row, { includePrivatePlaintext = false, cipherRefs = new Map() } = {}) {
	const isPublic = row.is_public === true;
	const content_hash = row.content_hash || memoryDigest(row);
	const base = {
		id: String(row.id),
		type: row.type || 'project',
		tags: Array.isArray(row.tags) ? row.tags : [],
		salience: typeof row.salience === 'number' ? row.salience : 0.5,
		tier: row.tier || 'recall',
		is_public: isPublic,
		created_at: new Date(row.created_at ?? row.createdAt ?? Date.now()).toISOString(),
		content_hash,
		signature: row.signature || undefined,
		signer_address: row.signer_address || undefined,
		signed_at: row.signed_at || row.signedAt || null,
	};

	if (isPublic || includePrivatePlaintext) {
		return { ...base, content: String(row.content ?? '') };
	}

	// Private + not opted into plaintext: only travel as an encrypted reference.
	const ref = cipherRefs.get(String(row.id));
	if (ref) {
		return { ...base, cipher: { scheme: 'wallet-aes-gcm-v1', cid: ref.cid, filename: ref.filename } };
	}
	return null;
}

/**
 * Assemble a full bundle and (optionally) sign it with the agent wallet key.
 *
 * @param {object} p
 * @param {object} p.agent agent identity row
 * @param {object|null} p.persona persona fields
 * @param {object[]} p.memoryEntries entries from buildMemoryEntry (no nulls)
 * @param {object|null} [p.anchor] on-chain anchor record
 * @param {object|null} [p.provenance]
 * @param {string} p.exportedAt ISO timestamp (server-supplied)
 * @param {string|null} [p.signerPrivKey] agent private key to sign the brain_hash
 * @returns {Promise<object>} validated bundle
 */
export async function buildBundle({
	agent,
	persona,
	memoryEntries,
	anchor = null,
	provenance = null,
	exportedAt,
	signerPrivKey = null,
}) {
	const memoryHashes = memoryEntries.map((m) => m.content_hash).filter(Boolean);
	const personaPromptHash = persona?.prompt_hash || null;
	const brainHash = computeBrainHash({ personaPromptHash, memoryHashes, agentId: agent.id });

	const publicCount = memoryEntries.filter((m) => m.is_public).length;
	const encryptedCount = memoryEntries.filter((m) => m.cipher).length;

	let signature = null;
	let signerAddress = agent.wallet_address || null;
	if (signerPrivKey) {
		const { signature: value, signer_address } = await signDigest(signerPrivKey, brainHash);
		signature = { brain_hash: brainHash, value, signer_address };
		signerAddress = signer_address;
	}

	const bundle = {
		version: BRAIN_BUNDLE_VERSION,
		exported_at: exportedAt,
		agent: {
			id: String(agent.id),
			name: agent.name ?? null,
			description: agent.description ?? null,
			avatar_id: agent.avatar_id ?? null,
			chain_id: agent.chain_id ?? null,
			erc8004_agent_id: agent.erc8004_agent_id != null ? String(agent.erc8004_agent_id) : null,
			wallet_address: agent.wallet_address ?? null,
		},
		persona: persona
			? {
					prompt: persona.prompt ?? null,
					prompt_hash: persona.prompt_hash ?? null,
					prompt_sig: persona.prompt_sig ?? null,
					tone_tags: persona.tone_tags ?? [],
					extracted_at: persona.extracted_at ?? null,
				}
			: null,
		memories: memoryEntries,
		anchor,
		manifest: {
			memory_count: memoryEntries.length,
			public_count: publicCount,
			private_count: memoryEntries.length - publicCount,
			encrypted_count: encryptedCount,
			brain_hash: brainHash,
			signer_address: signerAddress,
			persona_prompt_hash: personaPromptHash,
		},
		signature,
		provenance,
	};

	// Validate our own output — a build bug must never ship a malformed bundle.
	return brainBundleSchema.parse(bundle);
}

/**
 * Verify a bundle end-to-end. Pure — the offline trust check a buyer/forker runs.
 * Reports per-memory verdicts plus aggregate integrity (brain_hash recompute,
 * manifest consistency, bundle signature).
 *
 * @param {object} bundle
 * @returns {{
 *   valid: boolean,
 *   schemaValid: boolean,
 *   brainHashValid: boolean,
 *   bundleSignatureValid: boolean|null,
 *   memories: Array<{ id: string, signed: boolean, valid: boolean, reason: string, recovered: string|null }>,
 *   signedCount: number,
 *   verifiedCount: number,
 *   errors: string[],
 * }}
 */
export function verifyBundle(bundle) {
	const errors = [];
	const parsed = brainBundleSchema.safeParse(bundle);
	if (!parsed.success) {
		return {
			valid: false,
			schemaValid: false,
			brainHashValid: false,
			bundleSignatureValid: null,
			memories: [],
			signedCount: 0,
			verifiedCount: 0,
			errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
		};
	}
	const b = parsed.data;

	// Per-memory signature verification. Encrypted (cipher) entries can't be
	// content-verified offline without the key — report them honestly as
	// "encrypted", neither pass nor forged.
	const memories = b.memories.map((m) => {
		if (m.cipher) {
			return { id: m.id, signed: Boolean(m.signature), valid: false, reason: 'encrypted', recovered: null };
		}
		const v = verifyMemorySignature(
			{ id: m.id, agent_id: b.agent.id, type: m.type, content: m.content, tags: m.tags, created_at: m.created_at },
			{ signature: m.signature, signer_address: m.signer_address, content_hash: m.content_hash },
		);
		return { id: m.id, signed: Boolean(m.signature), valid: v.valid, reason: v.reason, recovered: v.recovered };
	});

	const signedCount = memories.filter((m) => m.signed).length;
	const verifiedCount = memories.filter((m) => m.valid).length;

	// Recompute the brain_hash over the included memory content-hashes.
	const recomputed = computeBrainHash({
		personaPromptHash: b.manifest.persona_prompt_hash,
		memoryHashes: b.memories.map((m) => m.content_hash).filter(Boolean),
		agentId: b.agent.id,
	});
	const brainHashValid = recomputed.toLowerCase() === b.manifest.brain_hash.toLowerCase();
	if (!brainHashValid) errors.push('brain_hash does not match the included memory set');

	// Manifest counts must match the actual array.
	const publicCount = b.memories.filter((m) => m.is_public).length;
	const encryptedCount = b.memories.filter((m) => m.cipher).length;
	if (b.manifest.memory_count !== b.memories.length) errors.push('manifest.memory_count mismatch');
	if (b.manifest.public_count !== publicCount) errors.push('manifest.public_count mismatch');
	if (b.manifest.encrypted_count !== encryptedCount) errors.push('manifest.encrypted_count mismatch');

	// Bundle signature over the brain_hash.
	let bundleSignatureValid = null;
	if (b.signature) {
		if (b.signature.brain_hash.toLowerCase() !== b.manifest.brain_hash.toLowerCase()) {
			bundleSignatureValid = false;
			errors.push('bundle signature is over a different brain_hash');
		} else {
			bundleSignatureValid = verifyBrainHashSignature(b.manifest.brain_hash, b.signature);
			if (!bundleSignatureValid) errors.push('bundle signature failed to verify');
		}
	}

	// A bundle is valid when: schema ok, brain_hash consistent, manifest
	// consistent, bundle signature (if present) verifies, and every
	// *signed plaintext* memory verifies. Unsigned or encrypted memories do not
	// fail the bundle — they are reported, not penalized.
	const plaintextSignedAllValid = memories
		.filter((m) => m.signed && m.reason !== 'encrypted')
		.every((m) => m.valid);

	const valid =
		brainHashValid &&
		errors.length === 0 &&
		(bundleSignatureValid === null || bundleSignatureValid === true) &&
		plaintextSignedAllValid;

	return {
		valid,
		schemaValid: true,
		brainHashValid,
		bundleSignatureValid,
		memories,
		signedCount,
		verifiedCount,
		errors,
	};
}

/**
 * Verify an ERC-191 signature over a brain_hash (the bundle-level signature).
 * signDigest(privKey, brainHash) signs `signMessageBody(brainHash)`, so verify
 * with the identical framing.
 *
 * @param {string} brainHash
 * @param {{ value: string, signer_address: string }} signature
 * @returns {boolean}
 */
export function verifyBrainHashSignature(brainHash, signature) {
	try {
		const recovered = verifyMessage(signMessageBody(brainHash), signature.value);
		return recovered.toLowerCase() === String(signature.signer_address).toLowerCase();
	} catch {
		return false;
	}
}
