// Unit tests for finalizeAutoRigStage — the sibling-materialization model.
//
// A completed 'rerig' job must mint a NEW avatar row (parent = the static
// source), re-point the owning agent identity at it, write an avatar_versions
// trail, and leave the source avatar byte-for-byte untouched. Storage and the
// provider are mocked so the control flow is exercised without live ML, while
// the sha256 of the rigged bytes is computed for real.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mutable test state, driven per-case ──────────────────────────────────────
let state;

function resetState() {
	state = {
		jobResultAvatarId: null, // what the job row currently reports
		finalizing: false, // is the job currently claimed by a finalizer?
		sourceRow: {
			id: 'src-1',
			slug: 'my-avatar',
			name: 'My Avatar',
			description: 'A cool avatar',
			storage_key: 'u/u1/my-avatar/static.glb',
			size_bytes: 1234,
			source_meta: { is_rigged: false, uploaded: true },
			tags: ['upload', 'unrigged'],
			visibility: 'unlisted',
			checksum_sha256: 'f'.repeat(64),
			storage_mode: null,
		},
		versionInserts: [],
		agentRepoints: [],
		sourceUpdates: [],
		closeJobCalls: [],
	};
}

// ── mocks ────────────────────────────────────────────────────────────────────
const sqlMock = vi.fn(async (strings, ...values) => {
	const text = Array.isArray(strings) ? strings.join('?') : String(strings);
	// Atomic claim: the winner gets a row, a loser (already-materialized or another
	// driver finalizing) gets none.
	if (/update avatar_regen_jobs/.test(text) && /status = 'finalizing'/.test(text)) {
		if (state.jobResultAvatarId || state.finalizing) return [];
		state.finalizing = true;
		return [{ job_id: 'job-1' }];
	}
	// Release on error: claim returns to a non-terminal status.
	if (/update avatar_regen_jobs/.test(text) && /status = 'running'/.test(text)) {
		state.finalizing = false;
		return [];
	}
	// closeJob — terminal transition with the (maybe-null) sibling id.
	if (/update avatar_regen_jobs/.test(text) && /result_avatar_id =/.test(text)) {
		state.closeJobCalls.push(values);
		state.jobResultAvatarId = values[0] ?? state.jobResultAvatarId;
		state.finalizing = false;
		return [];
	}
	if (/select result_avatar_id from avatar_regen_jobs/.test(text)) {
		return state.jobResultAvatarId ? [{ result_avatar_id: state.jobResultAvatarId }] : [];
	}
	if (/from avatars/.test(text) && /select id, slug, name/.test(text)) {
		return state.sourceRow ? [state.sourceRow] : [];
	}
	if (/insert into avatar_versions/.test(text)) {
		state.versionInserts.push(values);
		return [];
	}
	if (/update agent_identities/.test(text)) {
		state.agentRepoints.push(values);
		return [];
	}
	if (/update avatars\s+set source_meta/.test(text)) {
		state.sourceUpdates.push(values);
		return [];
	}
	return [];
});
vi.mock('../../api/_lib/db.js', () => ({ sql: (...a) => sqlMock(...a), isDbUnavailableError: () => false, isDbCapacityError: () => false }));

const putObjectMock = vi.fn(async () => undefined);
vi.mock('../../api/_lib/r2.js', () => ({
	putObject: (...a) => putObjectMock(...a),
	publicUrl: (key) => `https://cdn.test/${key}`,
}));

let createAvatarImpl = async ({ input }) => ({ id: 'sibling-1', name: input.name, slug: input.slug });
const createAvatarMock = vi.fn((...a) => createAvatarImpl(...a));
vi.mock('../../api/_lib/avatars.js', () => ({
	storageKeyFor: ({ userId, slug }) => `u/${userId}/${slug}/rigged.glb`,
	createAvatar: (...a) => createAvatarMock(...a),
}));

const inspectGlbMock = vi.fn(() => ({
	isRigged: true,
	skinCount: 1,
	skeletonJointCount: 52,
	nodeCount: 60,
	meshCount: 1,
	animationCount: 0,
	generator: 'test',
}));
vi.mock('../../api/_lib/glb-inspect.js', () => ({
	inspectGlb: (...a) => inspectGlbMock(...a),
	isValidGlbHeader: () => true,
}));

vi.mock('../../api/_lib/webhook-dispatch.js', () => ({ dispatchWebhooks: vi.fn(async () => {}) }));
vi.mock('../../api/_lib/regen-provider.js', () => ({ getRegenProvider: async () => ({ name: 'replicate', instance: null }), getRegenProviderForMode: async () => ({ name: 'replicate', instance: null }) }));

// The rigged-GLB fetch now flows through the shared provider-result-url guard
// (host allowlist + IP-pinned SSRF connect), which uses raw node http — not the
// global fetch — so stubbing global.fetch no longer intercepts it. Mock the one
// guarded helper instead; the real allowlist/extract logic stays intact for the
// SSRF specs. RIGGED_BYTES are the exact 4 bytes the checksum assertions expect.
const RIGGED_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]);
let fetchGlbImpl = async () => Buffer.from(RIGGED_BYTES);
const fetchProviderGlbBufferMock = vi.fn((...a) => fetchGlbImpl(...a));
vi.mock('../../api/_lib/provider-result-url.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, fetchProviderGlbBuffer: (...a) => fetchProviderGlbBufferMock(...a) };
});

const { finalizeAutoRigStage } = await import('../../api/_lib/auto-rig.js');
const { dispatchWebhooks } = await import('../../api/_lib/webhook-dispatch.js');

function mockFetchGlb(ok = true) {
	fetchGlbImpl = ok
		? async () => Buffer.from(RIGGED_BYTES)
		: async () => { throw new Error('fetch glb: 502'); };
}

const job = { source_avatar_id: 'src-1', mode: 'rerig', params: { auto_rig: true } };

beforeEach(() => {
	vi.clearAllMocks();
	resetState();
	createAvatarImpl = async ({ input }) => ({ id: 'sibling-1', name: input.name, slug: input.slug });
	mockFetchGlb(true);
});

describe('finalizeAutoRigStage — sibling materialization', () => {
	it('mints a sibling row parented to the source, never mutating the source bytes', async () => {
		const out = await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });

		expect(out).toEqual({ status: 'done', resultAvatarId: 'sibling-1' });
		expect(createAvatarMock).toHaveBeenCalledOnce();
		const input = createAvatarMock.mock.calls[0][0].input;
		expect(input.parent_avatar_id).toBe('src-1');
		expect(input.source).toBe('auto-rig');
		expect(input.tags).toContain('rigged');
		expect(input.tags).not.toContain('unrigged');
		expect(input.source_meta.is_rigged).toBe(true);
		expect(input.source_meta.unrigged_avatar_id).toBe('src-1');
		expect(input.source_meta.unrigged_storage_key).toBe('u/u1/my-avatar/static.glb');
		expect(input.source_meta.skeleton_joint_count).toBe(52);
		// Identity carried forward from the source.
		expect(input.name).toBe('My Avatar');
		expect(input.visibility).toBe('unlisted');
		// The source row is never UPDATEd with new bytes/meta (not pinned here).
		expect(state.sourceUpdates).toHaveLength(0);
	});

	it('computes a real sha256 of the rigged bytes for the sibling checksum', async () => {
		await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		const input = createAvatarMock.mock.calls[0][0].input;
		// sha256 of the 4-byte "glTF" buffer.
		const { createHash } = await import('node:crypto');
		const expected = createHash('sha256').update(Buffer.from([0x67, 0x6c, 0x54, 0x46])).digest('hex');
		expect(input.checksum_sha256).toBe(expected);
		expect(input.checksum_sha256).toMatch(/^[a-f0-9]{64}$/);
	});

	it('re-points the owning agent identity from source to sibling', async () => {
		await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(state.agentRepoints).toHaveLength(1);
		const values = state.agentRepoints[0];
		expect(values[0]).toBe('sibling-1'); // new avatar_id
		expect(values).toContain('src-1'); // old avatar_id matched in WHERE
	});

	it('writes an avatar_versions trail referencing the rigged storage key', async () => {
		await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(state.versionInserts).toHaveLength(1);
		const values = state.versionInserts[0];
		expect(values[0]).toBe('src-1'); // avatar_id anchored on source
		expect(values[1]).toBe('u/u1/rigged-' + values[1].split('rigged-')[1]); // rigged key
		expect(values[1]).toContain('/rigged.glb');
		expect(values[2]).toBe('u1'); // created_by
	});

	it('marks the job done with the sibling id and fires avatar.created', async () => {
		await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(state.closeJobCalls.at(-1)[0]).toBe('sibling-1');
		expect(dispatchWebhooks).toHaveBeenCalledOnce();
		expect(dispatchWebhooks.mock.calls[0][0]).toMatchObject({
			eventType: 'avatar.created',
			data: { id: 'sibling-1', source: 'auto-rig' },
		});
	});

	it('is idempotent: a second finalize yields one sibling and the same id', async () => {
		const a = await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		const b = await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(a.resultAvatarId).toBe('sibling-1');
		expect(b).toEqual({ status: 'done', resultAvatarId: 'sibling-1' });
		expect(createAvatarMock).toHaveBeenCalledOnce(); // not twice
	});

	it('marks the source superseded (without touching its bytes) when it was IPFS-pinned', async () => {
		state.sourceRow.storage_mode = { ipfs: { pinned: true, cid: 'bafyStatic' } };
		await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(state.sourceUpdates).toHaveLength(1);
		const meta = JSON.parse(state.sourceUpdates[0][0]);
		expect(meta.rigged_superseded_by).toBe('sibling-1');
		// storage_key / checksum untouched: only source_meta was written.
	});

	it('leaves the source intact when the rigged GLB cannot be fetched', async () => {
		mockFetchGlb(false);
		await expect(
			finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/down.glb' }),
		).rejects.toThrow();
		expect(createAvatarMock).not.toHaveBeenCalled();
		expect(putObjectMock).not.toHaveBeenCalled();
		expect(state.sourceUpdates).toHaveLength(0);
		expect(state.agentRepoints).toHaveLength(0);
	});

	it('is graceful at quota: no sibling, source untouched, job reaches a terminal state', async () => {
		createAvatarImpl = async () => {
			throw Object.assign(new Error('avatar count limit reached'), { status: 402, code: 'plan_limit_count' });
		};
		const out = await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(out).toEqual({ status: 'done' });
		expect(out.resultAvatarId).toBeUndefined();
		expect(state.agentRepoints).toHaveLength(0);
		expect(state.versionInserts).toHaveLength(0);
		// Job closed terminally with a note, no sibling id.
		const lastClose = state.closeJobCalls.at(-1);
		expect(lastClose[0]).toBeNull();
		expect(String(lastClose[1])).toContain('rig_sibling_skipped');
	});

	it('short-circuits when the avatar was deleted before completion', async () => {
		state.sourceRow = null;
		const out = await finalizeAutoRigStage({ userId: 'u1', jobId: 'job-1', job, glbUrl: 'https://x/rigged.glb' });
		expect(out).toEqual({ status: 'done', resultAvatarId: 'src-1' });
		expect(createAvatarMock).not.toHaveBeenCalled();
	});
});
