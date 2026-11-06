// Tests for GET /api/mcp3d/persona — the durable-reload endpoint the embodiment
// embed calls to bring a body back by id in a fresh session. Uses the filesystem
// persona backend (no DB, no R2) so the round-trip is hermetic.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.PUBLIC_APP_ORIGIN = 'https://three.ws';

const { createPersona } = await import('../../api/_lib/persona-store.js');
const { default: handler } = await import('../../api/mcp3d/persona.js');

let tmpDir;
const saved = {};
let personaId;

beforeAll(async () => {
	tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'persona-route-test-'));
	for (const k of ['PERSONA_STORE_DIR', 'DATABASE_URL', 'S3_BUCKET', 'S3_PUBLIC_DOMAIN']) saved[k] = process.env[k];
	process.env.PERSONA_STORE_DIR = tmpDir;
	delete process.env.DATABASE_URL;
	delete process.env.S3_BUCKET;
	delete process.env.S3_PUBLIC_DOMAIN;
	const rec = await createPersona({ name: 'Nova', glbUrl: 'https://three.ws/cdn/creations/nova.glb', ownerId: 'secret-owner' });
	personaId = rec.id;
});

afterAll(async () => {
	for (const [k, v] of Object.entries(saved)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeReq({ method = 'GET', url = '/' } = {}) {
	const req = Readable.from([]);
	req.method = method;
	req.url = url;
	req.headers = { host: 'three.ws' };
	return req;
}
function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
		getHeader(k) { return this.headers[k.toLowerCase()]; },
		end(chunk) { if (chunk !== undefined) this.body += chunk; this.writableEnded = true; },
	};
}
async function invoke(url, method = 'GET') {
	const req = makeReq({ url, method });
	const res = makeRes();
	await handler(req, res);
	return { res, status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
}

describe('GET /api/mcp3d/persona', () => {
	it('resolves a known persona to its public projection', async () => {
		const { status, body, res } = await invoke(`/api/mcp3d/persona?id=${personaId}`);
		expect(status).toBe(200);
		expect(body.persona_id).toBe(personaId);
		expect(body.name).toBe('Nova');
		expect(body.glb_url).toBe('https://three.ws/cdn/creations/nova.glb');
		// CORS + short cache so the cross-origin embed can fetch it.
		expect(res.headers['access-control-allow-origin']).toBe('*');
		expect(res.headers['cache-control']).toMatch(/s-maxage/);
		// Never leaks storage keys or owner ids.
		expect(res.body).not.toContain('secret-owner');
		expect(res.body).not.toContain('glb_key');
	});

	it('400 on a malformed id', async () => {
		const { status, body } = await invoke('/api/mcp3d/persona?id=not-a-persona');
		expect(status).toBe(400);
		expect(body.error).toBe('invalid_id');
	});

	it('404 on a well-formed but unknown id', async () => {
		const { status, body } = await invoke('/api/mcp3d/persona?id=persona_deadbeefdeadbeefdead');
		expect(status).toBe(404);
		expect(body.error).toBe('not_found');
	});

	it('405 on a non-GET method', async () => {
		const { status } = await invoke(`/api/mcp3d/persona?id=${personaId}`, 'POST');
		expect(status).toBe(405);
	});
});
