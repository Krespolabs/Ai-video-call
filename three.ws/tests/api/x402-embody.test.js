// Tests for POST /api/x402/embody (api/x402/embody.js) — the paid one-call
// embodiment endpoint: prompt/image → rigged GLB → durable persona → embed.
//
// The generate/rig/persona boundaries are dependency-injected so runEmbodyChain
// is exercised end-to-end offline against real-shaped forge/persona payloads —
// no network, no GPU, no payment. Validation is checked directly (it runs
// post-verify / pre-settle, so a rejected body is never charged).

import { describe, it, expect } from 'vitest';
import { runEmbodyChain, _validate, _buildBundle } from '../../api/x402/embody.js';
import { TTS_VOICE_IDS, DEFAULT_VOICE } from '../../api/_lib/tts-voices.js';

const BASE = 'https://three.ws';

// Real-shaped forge terminal payloads.
const genDone = { status: 'done', glb_url: 'https://pub-xxxx.r2.dev/forge/anon/mesh.glb', backend: 'nvidia', tier: 'draft' };
const rigDone = { status: 'done', glb_url: 'https://pub-xxxx.r2.dev/forge/anon/rigged.glb' };

function fakeGenerate(result = genDone) { return async () => result; }
function fakeRig(result = rigDone) { return async () => result; }
function fakeCreatePersona() {
	return async (input) => ({
		id: 'persona_test123abc',
		owner_id: null,
		name: input.name,
		glb_url: input.glbUrl,
		glb_key: 'personas/persona_test123abc.glb',
		voice: input.voice,
		emotion_baseline: 'neutral',
		look: input.look,
		source_prompt: input.sourcePrompt,
		turn_count: 0,
	});
}

// ── Validation ──────────────────────────────────────────────────────────────
describe('embody validation', () => {
	it('requires a name', () => {
		expect(() => _validate({ prompt: 'a knight' })).toThrow(/name is required/);
	});
	it('rejects an over-long name', () => {
		expect(() => _validate({ name: 'x'.repeat(65), prompt: 'a knight' })).toThrow(/≤64/);
	});
	it('requires exactly one of prompt / image_url', () => {
		expect(() => _validate({ name: 'A' })).toThrow(/either a prompt or an image_url/);
		expect(() => _validate({ name: 'A', prompt: 'x', image_url: 'https://e.com/i.png' })).toThrow(/exactly one/);
	});
	it('rejects a malformed image_url', () => {
		expect(() => _validate({ name: 'A', image_url: 'not-a-url' })).toThrow(/valid URL/);
		expect(() => _validate({ name: 'A', image_url: 'ftp://e.com/i.png' })).toThrow(/http/);
	});
	it('defaults voice to the platform default and accepts a valid voice', () => {
		expect(_validate({ name: 'A', prompt: 'x' }).voice).toBe(DEFAULT_VOICE);
		expect(_validate({ name: 'A', prompt: 'x', voice: TTS_VOICE_IDS[1] }).voice).toBe(TTS_VOICE_IDS[1]);
	});
	it('rejects an unknown voice with the valid list', () => {
		let err;
		try { _validate({ name: 'A', prompt: 'x', voice: 'gilbert' }); } catch (e) { err = e; }
		expect(err.code).toBe('invalid_voice');
		expect(err.valid_voices).toEqual(TTS_VOICE_IDS);
	});
	it('accepts a valid prompt request and clamps personality', () => {
		const v = _validate({ name: '  Nova  ', prompt: '  a scout ', personality: 'p'.repeat(700) });
		expect(v.name).toBe('Nova');
		expect(v.prompt).toBe('a scout');
		expect(v.personality.length).toBe(600);
	});
});

// ── Chain ───────────────────────────────────────────────────────────────────
describe('runEmbodyChain', () => {
	it('generates, rigs, and mints a durable persona', async () => {
		const out = await runEmbodyChain(
			{ base: BASE, name: 'Nova', prompt: 'a scout', personality: 'curious', voice: 'nova' },
			{ generateFn: fakeGenerate(), rigFn: fakeRig(), createPersonaFn: fakeCreatePersona() },
		);
		expect(out.rigged).toBe(true);
		expect(out.glbUrl).toBe(rigDone.glb_url); // rigged GLB wins
		expect(out.persona.id).toBe('persona_test123abc');
		expect(out.persona.look).toEqual({ rigged: true, style: 'curious' });
	});

	it('passes image_url through as a reconstruction input', async () => {
		let captured;
		const gen = async (_b, args) => { captured = args; return genDone; };
		await runEmbodyChain(
			{ base: BASE, name: 'A', prompt: '', imageUrl: 'https://e.com/i.png', personality: '', voice: 'nova' },
			{ generateFn: gen, rigFn: fakeRig(), createPersonaFn: fakeCreatePersona() },
		);
		expect(captured.imageUrls).toEqual(['https://e.com/i.png']);
		expect(captured.prompt).toBeUndefined();
	});

	it('degrades to the un-rigged mesh when rigging fails (never a hard failure)', async () => {
		const out = await runEmbodyChain(
			{ base: BASE, name: 'A', prompt: 'a rock creature', personality: '', voice: 'nova' },
			{ generateFn: fakeGenerate(), rigFn: async () => { throw new Error('rig lane down'); }, createPersonaFn: fakeCreatePersona() },
		);
		expect(out.rigged).toBe(false);
		expect(out.glbUrl).toBe(genDone.glb_url); // falls back to the mesh
	});

	it('degrades to the mesh when rigging times out', async () => {
		const out = await runEmbodyChain(
			{ base: BASE, name: 'A', prompt: 'x', personality: '', voice: 'nova' },
			{ generateFn: fakeGenerate(), rigFn: fakeRig({ _timedOut: true }), createPersonaFn: fakeCreatePersona() },
		);
		expect(out.rigged).toBe(false);
		expect(out.glbUrl).toBe(genDone.glb_url);
	});

	it('throws generation_timeout (no persona) when generation times out', async () => {
		let err;
		try {
			await runEmbodyChain(
				{ base: BASE, name: 'A', prompt: 'x', personality: '', voice: 'nova' },
				{ generateFn: fakeGenerate({ _timedOut: true }), rigFn: fakeRig(), createPersonaFn: fakeCreatePersona() },
			);
		} catch (e) { err = e; }
		expect(err.code).toBe('generation_timeout');
		expect(err.status).toBe(504);
	});

	it('throws generation_failed when generation returns no model', async () => {
		let err;
		try {
			await runEmbodyChain(
				{ base: BASE, name: 'A', prompt: 'x', personality: '', voice: 'nova' },
				{ generateFn: fakeGenerate({ status: 'done' }), rigFn: fakeRig(), createPersonaFn: fakeCreatePersona() },
			);
		} catch (e) { err = e; }
		expect(err.code).toBe('generation_failed');
	});
});

// ── Bundle / embed ──────────────────────────────────────────────────────────
describe('buildBundle', () => {
	const chain = {
		persona: { id: 'persona_abc', glb_url: 'https://pub-xxxx.r2.dev/personas/persona_abc.glb' },
		glbUrl: 'https://pub-xxxx.r2.dev/personas/persona_abc.glb',
		rigged: true,
		voice: 'nova',
		name: 'Nova',
	};

	it('returns every documented field, all resolvable', () => {
		const b = _buildBundle(BASE, chain);
		expect(b.agent_id).toBe('persona_abc');
		expect(b.glb_url).toBe(chain.glbUrl);
		expect(b.viewer_url).toBe(`${BASE}/viewer?src=${encodeURIComponent(chain.glbUrl)}`);
		expect(b.reload_url).toBe(`${BASE}/api/mcp3d/persona?id=persona_abc`);
		expect(b.voice).toBe('nova');
		expect(b.rigged).toBe(true);
		expect(b.name).toBe('Nova');
	});

	it('embed_html is a single self-contained iframe pointing at the persona embed', () => {
		const b = _buildBundle(BASE, chain);
		expect(b.embed_html).toMatch(/^<iframe /);
		expect(b.embed_html).toContain('persona=persona_abc');
		expect(b.embed_html).toContain('allowfullscreen');
		// profile_url is the same hosted presence page the iframe frames
		expect(b.profile_url).toContain('/embodiment/embed');
		expect(b.profile_url).toContain('persona=persona_abc');
		expect(b.embed_html).toContain(b.profile_url.replace(/&/g, '&'));
	});
});
