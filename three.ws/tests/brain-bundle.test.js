import { describe, it, expect } from 'vitest';
import { Wallet } from 'ethers';

import {
	canonicalizeMemory,
	memoryDigest,
	signDigest,
	verifyMemorySignature,
	signMessageBody,
	MEMORY_SIG_VERSION,
} from '../api/_lib/brain-sign.js';
import {
	computeBrainHash,
	buildMemoryEntry,
	buildBundle,
	verifyBundle,
	verifyBrainHashSignature,
	BRAIN_BUNDLE_VERSION,
} from '../api/_lib/brain-bundle.js';

// A deterministic throwaway key — the test's "agent wallet". Never a real mint.
const TEST_PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const wallet = new Wallet(TEST_PK);

function fixtureMemory(overrides = {}) {
	return {
		id: '11111111-1111-1111-1111-111111111111',
		agent_id: '22222222-2222-2222-2222-222222222222',
		type: 'user',
		content: 'The user prefers terse, senior-engineer feedback. No filler.',
		tags: ['tone', 'feedback'],
		salience: 0.8,
		tier: 'working',
		is_public: true,
		created_at: '2026-06-23T12:00:00.000Z',
		...overrides,
	};
}

describe('brain-sign · canonicalization', () => {
	it('is stable regardless of tag order and timestamp representation', () => {
		const a = canonicalizeMemory(fixtureMemory({ tags: ['feedback', 'tone'] }));
		const b = canonicalizeMemory(fixtureMemory({ tags: ['tone', 'feedback'] }));
		expect(a).toBe(b);

		// numeric ms vs ISO for the same instant
		const ms = canonicalizeMemory(fixtureMemory({ created_at: 1781524800000 }));
		const iso = canonicalizeMemory(fixtureMemory({ created_at: '2026-06-15T12:00:00.000Z' }));
		expect(ms).toBe(iso);
	});

	it('excludes mutable fields so re-tiering does not break authorship', () => {
		const a = memoryDigest(fixtureMemory({ tier: 'working', salience: 0.9, pinned: true }));
		const b = memoryDigest(fixtureMemory({ tier: 'archival', salience: 0.1, pinned: false }));
		expect(a).toBe(b);
	});

	it('changes the digest when content changes', () => {
		const a = memoryDigest(fixtureMemory());
		const b = memoryDigest(fixtureMemory({ content: 'tampered' }));
		expect(a).not.toBe(b);
	});
});

describe('brain-sign · sign + verify', () => {
	it('produces a signature that recovers to the signer and verifies', async () => {
		const mem = fixtureMemory();
		const digest = memoryDigest(mem);
		const { signature, signer_address } = await signDigest(TEST_PK, digest);
		expect(signer_address.toLowerCase()).toBe(wallet.address.toLowerCase());

		const v = verifyMemorySignature(mem, { signature, signer_address, content_hash: digest });
		expect(v.valid).toBe(true);
		expect(v.reason).toBe('ok');
		expect(v.recovered.toLowerCase()).toBe(wallet.address.toLowerCase());
	});

	it('rejects tampered content', async () => {
		const mem = fixtureMemory();
		const { signature, signer_address } = await signDigest(TEST_PK, memoryDigest(mem));
		const tampered = { ...mem, content: 'I have been edited' };
		const v = verifyMemorySignature(tampered, { signature, signer_address });
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('signer_mismatch');
	});

	it('detects a content_hash that does not match the memory', async () => {
		const mem = fixtureMemory();
		const v = verifyMemorySignature(mem, {
			signature: '0xdead',
			signer_address: wallet.address,
			content_hash: 'f'.repeat(64),
		});
		expect(v.valid).toBe(false);
		expect(v.reason).toBe('content_hash_mismatch');
	});

	it('reports unsigned and malformed honestly', async () => {
		const mem = fixtureMemory();
		expect(verifyMemorySignature(mem, {}).reason).toBe('unsigned');
		expect(verifyMemorySignature(mem, { signature: 'not-a-sig', signer_address: wallet.address }).reason).toBe(
			'malformed_signature',
		);
	});

	it('rejects a signature over a different message framing', async () => {
		// A raw signature over the digest WITHOUT the domain prefix must not verify.
		const mem = fixtureMemory();
		const digest = memoryDigest(mem);
		const rogue = await wallet.signMessage(digest); // missing MEMORY_SIG_VERSION prefix
		expect(MEMORY_SIG_VERSION).toBe('threews:brain:memory:v1');
		const v = verifyMemorySignature(mem, { signature: rogue, signer_address: wallet.address });
		expect(v.valid).toBe(false);
	});
});

describe('brain-bundle · build + verify round trip', () => {
	const agent = {
		id: '22222222-2222-2222-2222-222222222222',
		name: 'Atlas',
		description: 'A research agent',
		avatar_id: 'av_1',
		chain_id: 8453,
		erc8004_agent_id: 42,
		wallet_address: wallet.address,
	};
	const persona = {
		prompt: 'You are Atlas, a meticulous research agent.',
		prompt_hash: 'a'.repeat(64),
		prompt_sig: 'sig',
		tone_tags: ['precise', 'calm'],
		extracted_at: '2026-06-01T00:00:00.000Z',
	};

	async function signedRow(over = {}) {
		const row = fixtureMemory(over);
		const digest = memoryDigest(row);
		const { signature, signer_address } = await signDigest(TEST_PK, digest);
		return { ...row, content_hash: digest, signature, signer_address, signed_at: '2026-06-23T12:00:01.000Z' };
	}

	it('builds a schema-valid, signed bundle that verifies end to end', async () => {
		const rows = [
			await signedRow(),
			await signedRow({ id: '33333333-3333-3333-3333-333333333333', content: 'Second memory', is_public: true }),
		];
		const entries = rows.map((r) => buildMemoryEntry(r, { includePrivatePlaintext: true }));
		const bundle = await buildBundle({
			agent,
			persona,
			memoryEntries: entries,
			exportedAt: '2026-06-23T12:30:00.000Z',
			signerPrivKey: TEST_PK,
		});

		expect(bundle.version).toBe(BRAIN_BUNDLE_VERSION);
		expect(bundle.manifest.memory_count).toBe(2);
		expect(bundle.signature.signer_address.toLowerCase()).toBe(wallet.address.toLowerCase());

		const result = verifyBundle(bundle);
		expect(result.valid).toBe(true);
		expect(result.schemaValid).toBe(true);
		expect(result.brainHashValid).toBe(true);
		expect(result.bundleSignatureValid).toBe(true);
		expect(result.verifiedCount).toBe(2);
		expect(result.signedCount).toBe(2);
	});

	it('detects a tampered memory inside an otherwise valid bundle', async () => {
		const rows = [await signedRow()];
		const entries = rows.map((r) => buildMemoryEntry(r, { includePrivatePlaintext: true }));
		const bundle = await buildBundle({
			agent,
			persona,
			memoryEntries: entries,
			exportedAt: '2026-06-23T12:30:00.000Z',
			signerPrivKey: TEST_PK,
		});

		// Tamper the content but keep the original signature + content_hash.
		bundle.memories[0].content = 'malicious rewrite';
		const result = verifyBundle(bundle);
		expect(result.valid).toBe(false);
		// content_hash no longer matches the mutated content.
		expect(result.memories[0].valid).toBe(false);
	});

	it('detects a brain_hash that does not cover the memory set', async () => {
		const entries = [buildMemoryEntry(await signedRow(), { includePrivatePlaintext: true })];
		const bundle = await buildBundle({
			agent,
			persona,
			memoryEntries: entries,
			exportedAt: '2026-06-23T12:30:00.000Z',
			signerPrivKey: TEST_PK,
		});
		bundle.manifest.brain_hash = 'b'.repeat(64);
		const result = verifyBundle(bundle);
		expect(result.brainHashValid).toBe(false);
		expect(result.valid).toBe(false);
	});

	it('keeps private memories as encrypted references, not plaintext', async () => {
		const privateRow = await signedRow({
			id: '44444444-4444-4444-4444-444444444444',
			content: 'secret diary entry',
			is_public: false,
		});
		const cipherRefs = new Map([[privateRow.id, { cid: 'bafyTestCid', filename: 'mem-44.enc' }]]);
		const entry = buildMemoryEntry(privateRow, { includePrivatePlaintext: false, cipherRefs });
		expect(entry.content).toBeUndefined();
		expect(entry.cipher.cid).toBe('bafyTestCid');

		const bundle = await buildBundle({
			agent,
			persona: null,
			memoryEntries: [entry],
			exportedAt: '2026-06-23T12:30:00.000Z',
			signerPrivKey: TEST_PK,
		});
		expect(bundle.manifest.encrypted_count).toBe(1);
		const result = verifyBundle(bundle);
		// Encrypted entries are reported, not penalized; the bundle stays valid.
		expect(result.memories[0].reason).toBe('encrypted');
		expect(result.valid).toBe(true);
	});

	it('excludes a private memory with no cipher reference', async () => {
		const privateRow = await signedRow({ is_public: false });
		const entry = buildMemoryEntry(privateRow, { includePrivatePlaintext: false, cipherRefs: new Map() });
		expect(entry).toBeNull();
	});
});

describe('brain-bundle · brain hash + bundle signature', () => {
	it('is deterministic over the memory set and persona', () => {
		const h1 = computeBrainHash({ personaPromptHash: 'a'.repeat(64), memoryHashes: ['1', '2'], agentId: 'x' });
		const h2 = computeBrainHash({ personaPromptHash: 'a'.repeat(64), memoryHashes: ['2', '1'], agentId: 'x' });
		expect(h1).toBe(h2);
		const h3 = computeBrainHash({ personaPromptHash: 'a'.repeat(64), memoryHashes: ['2', '1', '3'], agentId: 'x' });
		expect(h3).not.toBe(h1);
	});

	it('round-trips a standalone brain_hash signature', async () => {
		const brainHash = computeBrainHash({ personaPromptHash: null, memoryHashes: ['abc'], agentId: 'a' });
		const { signature, signer_address } = await signDigest(TEST_PK, brainHash);
		expect(verifyBrainHashSignature(brainHash, { value: signature, signer_address })).toBe(true);
		expect(verifyBrainHashSignature('c'.repeat(64), { value: signature, signer_address })).toBe(false);
	});

	it('uses the documented message framing', () => {
		expect(signMessageBody('deadbeef')).toBe('threews:brain:memory:v1:deadbeef');
	});
});
