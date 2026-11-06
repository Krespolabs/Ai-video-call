// Tests for GET /api/tts/voices — the catalog that drives every voice picker
// (the Walk Avatar extension settings, demo surfaces).
//
// Contract under test:
//   • Returns the shared catalog (api/_lib/tts-voices.js), so a voice listed
//     here is always one /api/tts/speak will accept.
//   • `default` is a real catalog id.
//   • `providers` truthfully reports which synthesis lanes are configured, and
//     `enabled` is the OR of them.
//   • Public, cacheable metadata — no auth required.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TTS_VOICE_IDS, DEFAULT_VOICE } from '../../api/_lib/tts-voices.js';

const ENV_KEYS = ['NVIDIA_API_KEY', 'OPENAI_API_KEY'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function makeReq(method = 'GET') {
	return { method, url: '/api/tts/voices', headers: {} };
}

function makeRes() {
	const chunks = [];
	return {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		write(c) { chunks.push(Buffer.from(c)); },
		end(c) { if (c) chunks.push(Buffer.from(c)); this.writableEnded = true; },
		body() { return Buffer.concat(chunks); },
		json() { return JSON.parse(this.body().toString('utf8')); },
	};
}

async function callVoices(method) {
	const handler = (await import('../../api/tts/voices.js')).default;
	const res = makeRes();
	await handler(makeReq(method), res);
	return res;
}

beforeEach(() => {
	delete process.env.NVIDIA_API_KEY;
	delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
		else process.env[k] = ORIGINAL_ENV[k];
	}
});

describe('GET /api/tts/voices', () => {
	it('returns the shared catalog with ids speak() accepts', async () => {
		const res = await callVoices('GET');
		expect(res.statusCode).toBe(200);
		const body = res.json();

		expect(Array.isArray(body.voices)).toBe(true);
		expect(body.voices.length).toBe(TTS_VOICE_IDS.length);
		const ids = body.voices.map((v) => v.id);
		expect(ids).toEqual(TTS_VOICE_IDS);
		for (const v of body.voices) {
			expect(typeof v.name).toBe('string');
			expect(v.name.length).toBeGreaterThan(0);
		}
	});

	it('default voice is a real catalog id', async () => {
		const body = (await callVoices('GET')).json();
		expect(body.default).toBe(DEFAULT_VOICE);
		expect(TTS_VOICE_IDS).toContain(body.default);
	});

	it('reports no lanes when nothing is configured', async () => {
		const body = (await callVoices('GET')).json();
		expect(body.providers).toEqual({ nvidia: false, openai: false });
		expect(body.enabled).toBe(false);
	});

	it('enabled is the OR of the configured lanes', async () => {
		process.env.NVIDIA_API_KEY = 'nvapi-test';
		const body = (await callVoices('GET')).json();
		expect(body.providers.nvidia).toBe(true);
		expect(body.providers.openai).toBe(false);
		expect(body.enabled).toBe(true);
	});

	it('serves cacheable metadata', async () => {
		const res = await callVoices('GET');
		expect(res.getHeader('cache-control')).toMatch(/max-age/);
	});
});
