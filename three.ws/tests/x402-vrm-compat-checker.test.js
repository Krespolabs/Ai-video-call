// Unit tests for the VRM 1.0 Compatibility Checker pipeline (USE-019):
// api/_lib/x402/pipelines/vrm-compat-checker.js.
//
// The DB and the R2 public-URL helper are mocked. The sql mock dispatches on
// query text so the idempotent schema DDL (ensureVrmSchema) is ignored and only
// the meaningful SELECT/INSERT are asserted on.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── mock R2 public-URL helper (avoids env / CDN config) ──────────────────────
vi.mock('../api/_lib/r2.js', () => ({
	// Pass through absolute URLs; resolve bare keys against a fake CDN.
	publicUrl: (key) => (/^https?:\/\//i.test(key) ? key : `https://cdn.example/${key}`),
}));

// ── mock DB: route by query text ─────────────────────────────────────────────
const dbState = {
	candidate: null, // row nextVrmTarget's SELECT returns (or null → [])
	calls: [],       // captured { text, values }
};

function makeSql() {
	return vi.fn(async (strings, ...values) => {
		const text = Array.isArray(strings) ? strings.join('?') : String(strings);
		dbState.calls.push({ text, values });
		if (/CREATE\s+TABLE/i.test(text)) return [];
		if (/FROM\s+avatars\s+a/i.test(text)) {
			return dbState.candidate ? [dbState.candidate] : [];
		}
		if (/INSERT\s+INTO\s+avatar_vrm_compat/i.test(text)) return [];
		return [];
	});
}

import { classifyVrmCompat, vrmCompatEntry } from '../api/_lib/x402/pipelines/vrm-compat-checker.js';

beforeEach(() => {
	dbState.candidate = null;
	dbState.calls = [];
});

// ── classifyVrmCompat ────────────────────────────────────────────────────────

describe('classifyVrmCompat', () => {
	it('classifies a VRM 0.x avatar as upgradeable with a migration checklist', () => {
		const v = classifyVrmCompat(
			{
				extensionsUsed: ['VRM', 'KHR_materials_unlit'],
				counts: { skins: 1, materials: 3, nodes: 60 },
				materials: [{}, {}, {}],
				filename: 'alicia.vrm',
				container: 'glb',
			},
			'https://cdn.example/alicia.vrm',
		);
		expect(v.vrm_version).toBe('0.x');
		expect(v.is_vrm).toBe(true);
		expect(v.upgradeable).toBe(true);
		const codes = v.issues.map((i) => i.code).sort();
		expect(codes).toEqual(['coordinate_space', 'expression_remap', 'mtoon_migration', 'springbone_remap']);
		// blocker_count counts warn/critical only (mtoon is info)
		expect(v.blocker_count).toBe(3);
	});

	it('classifies a VRM 1.0 avatar as already on-spec (not an upgrade candidate)', () => {
		const v = classifyVrmCompat(
			{ extensionsUsed: ['VRMC_vrm', 'VRMC_springBone', 'VRMC_materials_mtoon'], counts: { skins: 1 } },
			'u',
		);
		expect(v.vrm_version).toBe('1.0');
		expect(v.is_vrm).toBe(true);
		expect(v.upgradeable).toBeNull();
		expect(v.issues).toEqual([]);
	});

	it('classifies a non-VRM model as none / not applicable', () => {
		const v = classifyVrmCompat({ extensionsUsed: ['KHR_draco_mesh_compression'], counts: { skins: 0 } }, 'u');
		expect(v.vrm_version).toBe('none');
		expect(v.is_vrm).toBe(false);
		expect(v.upgradeable).toBeNull();
	});

	it('omits the spring-bone item when the model has no skins', () => {
		const v = classifyVrmCompat({ extensionsUsed: ['VRM'], counts: { skins: 0, materials: 0 } }, 'u');
		expect(v.issues.map((i) => i.code)).not.toContain('springbone_remap');
		expect(v.upgradeable).toBe(true);
	});
});

// ── registry entry wiring ────────────────────────────────────────────────────

describe('vrmCompatEntry', () => {
	it('exposes the correct registry shape', () => {
		expect(vrmCompatEntry.id).toBe('vrm-compat-checker');
		expect(vrmCompatEntry.path).toBe('/api/mcp');
		expect(vrmCompatEntry.method).toBe('POST');
		expect(vrmCompatEntry.pipeline).toBe('vrm-compat');
		expect(vrmCompatEntry.enabled).toBe(true);
		expect(vrmCompatEntry.cooldown_s).toBeGreaterThan(0);
	});

	it('builds an MCP inspect_model tools/call body from the resolved target URL', () => {
		const body = vrmCompatEntry.body({ targetUrl: 'https://three.ws/avatars/a.vrm' });
		expect(body.method).toBe('tools/call');
		expect(body.params.name).toBe('inspect_model');
		expect(body.params.arguments.url).toBe('https://three.ws/avatars/a.vrm');
	});

	it('returns a null body when there is no target (loop skips without paying)', () => {
		expect(vrmCompatEntry.body({ targetUrl: null })).toBeNull();
	});

	it('extractSignal summarizes the inspect_model response into signal_data', () => {
		const sig = vrmCompatEntry.extractSignal({
			result: { structuredContent: { extensionsUsed: ['VRM'], counts: { skins: 1, materials: 2 }, materials: [{}, {}] } },
		});
		expect(sig.is_vrm).toBe(true);
		expect(sig.vrm_version).toBe('0.x');
		expect(sig.upgradeable).toBe(true);
		expect(sig.blocker_count).toBe(3);
	});

	it('extractSignal degrades gracefully on a malformed response', () => {
		expect(vrmCompatEntry.extractSignal({}).ok).toBe(false);
	});
});

// ── resolveTarget (avatar selection) ─────────────────────────────────────────

describe('vrmCompatEntry.resolveTarget', () => {
	it('selects a VRM-candidate avatar and resolves its public URL + context', async () => {
		dbState.candidate = { id: 'avatar-uuid-1', name: 'My VRM', storage_key: 'u/owner/avatar.vrm' };
		const sql = makeSql();
		const out = await vrmCompatEntry.resolveTarget({ sql, origin: 'https://three.ws' });
		expect(out.targetUrl).toBe('https://cdn.example/u/owner/avatar.vrm');
		expect(out.context.avatar_id).toBe('avatar-uuid-1');
		expect(out.context.canary).toBe(false);
		// the SELECT ran against the avatars table
		expect(dbState.calls.some((c) => /FROM\s+avatars\s+a/i.test(c.text))).toBe(true);
	});

	it('yields no target when no candidate avatar exists and no canary is set', async () => {
		dbState.candidate = null;
		const sql = makeSql();
		const out = await vrmCompatEntry.resolveTarget({ sql, origin: 'https://three.ws' });
		expect(out).toBeNull();
	});
});

// ── storeValue (per-avatar persistence) ──────────────────────────────────────

describe('vrmCompatEntry.storeValue', () => {
	it('upserts the migration report keyed by avatar_id', async () => {
		const sql = makeSql();
		await vrmCompatEntry.storeValue({
			sql,
			runId: 'run-1',
			targetUrl: 'https://cdn.example/u/owner/avatar.vrm',
			targetContext: { avatar_id: 'avatar-uuid-1', canary: false },
			txSig: 'sig123',
			responseBody: { result: { structuredContent: { extensionsUsed: ['VRM'], counts: { skins: 1, materials: 2 }, materials: [{}, {}] } } },
		});
		const insert = dbState.calls.find((c) => /INSERT\s+INTO\s+avatar_vrm_compat/i.test(c.text));
		expect(insert).toBeTruthy();
		// avatar_id is the first bound value
		expect(insert.values[0]).toBe('avatar-uuid-1');
		// the report payload contains the classified version
		expect(insert.values.some((val) => typeof val === 'string' && /"vrm_version":"0\.x"/.test(val))).toBe(true);
	});

	it('skips persistence for a canary target (no avatar_id to key on)', async () => {
		const sql = makeSql();
		await vrmCompatEntry.storeValue({
			sql,
			runId: 'run-1',
			targetUrl: 'https://example/canary.vrm',
			targetContext: { avatar_id: null, canary: true },
			responseBody: { result: { structuredContent: { extensionsUsed: ['VRM'], counts: { skins: 1 } } } },
		});
		expect(dbState.calls.some((c) => /INSERT\s+INTO\s+avatar_vrm_compat/i.test(c.text))).toBe(false);
	});
});
