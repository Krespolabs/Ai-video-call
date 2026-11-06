/**
 * Persona persistence — the identity layer behind an embodied agent.
 *
 * The promise of embodiment is continuity: a named body you return to across
 * sessions. These tests pin that on the filesystem backend (no DATABASE_URL) —
 * create a persona, then read it back through a FRESH call (a stand-in for a new
 * session / new process), and prove it's the same body with a growing turn count.
 * They also pin the public projection never leaking storage keys or owner ids, and
 * the id helpers a caller uses to guard a lookup.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
	makePersonaId,
	isPersonaId,
	normalizePersonaInput,
	personaPublicView,
	createPersona,
	getPersona,
	updatePersona,
	touchPersona,
} from '../api/_lib/persona-store.js';

let tmpDir;
const savedEnv = {};

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-store-test-'));
	// Force the filesystem backend: no DB, no R2. Persona persists to disk and the
	// GLB source URL is kept as-is (durable copy is a prod-only concern).
	for (const k of ['PERSONA_STORE_DIR', 'DATABASE_URL', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN']) savedEnv[k] = process.env[k];
	process.env.PERSONA_STORE_DIR = tmpDir;
	delete process.env.DATABASE_URL;
	delete process.env.S3_BUCKET;
	delete process.env.S3_PUBLIC_DOMAIN;
});

afterAll(async () => {
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('persona id helpers', () => {
	it('mints URL-safe, well-formed ids — deterministic with a seed', () => {
		const a = makePersonaId('seed-one');
		const b = makePersonaId('seed-one');
		const c = makePersonaId('seed-two');
		expect(a).toBe(b); // seed → stable
		expect(a).not.toBe(c);
		expect(isPersonaId(a)).toBe(true);
		expect(a.startsWith('persona_')).toBe(true);
	});

	it('rejects malformed ids', () => {
		expect(isPersonaId('')).toBe(false);
		expect(isPersonaId('nope')).toBe(false);
		expect(isPersonaId('persona_')).toBe(false);
		expect(isPersonaId(null)).toBe(false);
		expect(isPersonaId('persona_with spaces!!')).toBe(false);
	});
});

describe('normalizePersonaInput', () => {
	it('clamps strings and defaults name + emotion baseline', () => {
		const n = normalizePersonaInput({ name: '  ', glbUrl: 'https://three.ws/a.glb' });
		expect(n.name).toBe('Agent');
		expect(n.emotion_baseline).toBe('neutral');
		expect(n.glb_url).toBe('https://three.ws/a.glb');
	});

	it('carries the look flags through', () => {
		const n = normalizePersonaInput({ name: 'Nova', glbUrl: 'https://three.ws/a.glb', look: { rigged: true, mesh_count: 3 } });
		expect(n.look.rigged).toBe(true);
		expect(n.look.mesh_count).toBe(3);
	});
});

describe('persona persistence (filesystem backend)', () => {
	it('creates a persona and reloads the SAME body by id in a fresh call', async () => {
		const created = await createPersona({
			name: 'Nova',
			glbUrl: 'https://three.ws/cdn/creations/nova.glb',
			voice: 'aria',
			sourcePrompt: 'a friendly astronaut mascot',
			ownerId: 'owner-123',
			look: { rigged: true, mesh_count: 2, animation_count: 1 },
		});
		expect(isPersonaId(created.id)).toBe(true);
		expect(created.turn_count).toBe(0);

		// A durable file exists on disk — the continuity substrate.
		const onDisk = await fs.readFile(path.join(tmpDir, `${created.id}.json`), 'utf8');
		expect(JSON.parse(onDisk).name).toBe('Nova');

		// "New session": reload purely by id.
		const reloaded = await getPersona(created.id);
		expect(reloaded).toBeTruthy();
		expect(reloaded.id).toBe(created.id);
		expect(reloaded.name).toBe('Nova');
		expect(reloaded.glb_url).toBe('https://three.ws/cdn/creations/nova.glb');
		expect(reloaded.look.rigged).toBe(true);
	});

	it('touchPersona bumps the turn count — the same-body-reused signal', async () => {
		const p = await createPersona({ name: 'Sable', glbUrl: 'https://three.ws/cdn/creations/sable.glb' });
		expect(p.turn_count).toBe(0);
		const t1 = await touchPersona(p.id);
		expect(t1.turn_count).toBe(1);
		const t2 = await touchPersona(p.id);
		expect(t2.turn_count).toBe(2);
		// The bump is durable — a fresh read sees it.
		const reread = await getPersona(p.id);
		expect(reread.turn_count).toBe(2);
	});

	it('updatePersona patches identity but reloads under the same id', async () => {
		const p = await createPersona({ name: 'Orin', glbUrl: 'https://three.ws/cdn/creations/orin.glb' });
		const updated = await updatePersona(p.id, { name: 'Orin the Guide', voice: ' collins' });
		expect(updated.id).toBe(p.id);
		expect(updated.name).toBe('Orin the Guide');
		expect((await getPersona(p.id)).name).toBe('Orin the Guide');
	});

	it('getPersona returns null for a well-formed but unknown id', async () => {
		expect(await getPersona(makePersonaId('never-created'))).toBe(null);
	});

	it('public projection never leaks storage keys or owner ids', async () => {
		const p = await createPersona({
			name: 'Vex',
			glbUrl: 'https://three.ws/cdn/creations/vex.glb',
			ownerId: 'secret-owner',
		});
		const view = personaPublicView(await getPersona(p.id));
		expect(view.persona_id).toBe(p.id);
		expect(view.name).toBe('Vex');
		expect(view).not.toHaveProperty('owner_id');
		expect(view).not.toHaveProperty('glb_key');
		expect(view).not.toHaveProperty('source_prompt');
		expect(JSON.stringify(view)).not.toContain('secret-owner');
	});
});
