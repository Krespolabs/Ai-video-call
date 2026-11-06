#!/usr/bin/env node
// Live verification for the free NVIDIA Magpie TTS lane (task T2.1).
//
//   node scripts/verify-nvidia-tts.mjs            # full check (needs NVIDIA_API_KEY in .env.local)
//   node scripts/verify-nvidia-tts.mjs --quick    # skip the voice-map sweep
//
// 1. Synthesizes a short sentence through api/_lib/tts-nvidia.js and asserts
//    real audio came back (RIFF/WAVE magic, duration > 0). Prints latency.
// 2. Sweeps every mapped Magpie persona + the opus path so the voice map is
//    proven against the live model, not assumed.
// 3. Forces the NIM lane to fail (bad key) and runs the real /api/tts/speak
//    handler to prove the failover ORDER: nvidia attempted first, OpenAI
//    backstop attempted second, clean JSON error when both fail. This runs in
//    a CHILD PROCESS because NVCF authorizes at gRPC stream/connection setup —
//    a warm channel that already authenticated keeps serving even after the
//    key in env changes, so an in-process key swap proves nothing.
//
// Everything stays in memory — no scratch audio files are written.

import { config as dotenv } from 'dotenv';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// dotenv never overrides vars already present, so the bogus key injected by
// the parent for --failover-only survives this load.
dotenv({ path: new URL('../.env.local', import.meta.url) });
// .env.local can carry prod flags; clear them so the critical rate limiter
// doesn't fail closed (no local Redis) when we exercise the real handler.
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;

const quick = process.argv.includes('--quick');
const failoverOnly = process.argv.includes('--failover-only');
if (!process.env.NVIDIA_API_KEY) {
	console.error('[tts] NVIDIA_API_KEY missing from environment/.env.local — cannot live-verify');
	process.exit(1);
}

const { synthesizeNvidiaTts, VOICE_TO_MAGPIE } = await import('../api/_lib/tts-nvidia.js');

function assert(cond, msg) {
	if (!cond) {
		console.error(`[tts] FAIL — ${msg}`);
		process.exit(1);
	}
}

function wavDurationSeconds(buf) {
	return (buf.length - 44) / (44100 * 2); // mono s16 @ 44100
}

// ── 1. One real sentence through the module ────────────────────────────────
if (!failoverOnly) {
	const t0 = Date.now();
	const out = await synthesizeNvidiaTts({
		text: 'Hello from three dot W S. The free NVIDIA voice lane is live.',
		voice: 'nova',
		format: 'mp3', // mp3 is the platform default — NIM serves it as WAV
	});
	const ms = Date.now() - t0;
	assert(Buffer.isBuffer(out.audio), 'module did not return a Buffer');
	assert(out.audio.subarray(0, 4).toString('ascii') === 'RIFF', `bad magic: ${out.audio.subarray(0, 4)}`);
	assert(out.audio.subarray(8, 12).toString('ascii') === 'WAVE', 'no WAVE marker');
	assert(out.contentType === 'audio/wav' && out.format === 'wav', 'content-type/format not truthful');
	assert(out.model === 'magpie-tts-multilingual', `model: ${out.model}`);
	const dur = wavDurationSeconds(out.audio);
	assert(dur > 0, `duration ${dur}`);
	console.log(
		`[tts] ✓ synthesize ok — voice ${out.voiceName}, ${out.audio.length} bytes, ${dur.toFixed(2)}s audio, latency ${ms}ms`,
	);
}

// ── 2. Voice-map sweep + opus path ─────────────────────────────────────────
if (!quick && !failoverOnly) {
	const personas = new Map(); // persona → one representative OpenAI voice name
	for (const [openaiVoice, persona] of Object.entries(VOICE_TO_MAGPIE)) {
		if (!personas.has(persona)) personas.set(persona, openaiVoice);
	}
	for (const [persona, openaiVoice] of personas) {
		const t0 = Date.now();
		const out = await synthesizeNvidiaTts({ text: 'Quick voice check.', voice: openaiVoice, format: 'wav' });
		assert(out.audio.length > 44 && out.audio.subarray(0, 4).toString('ascii') === 'RIFF',
			`persona ${persona} returned no audio`);
		console.log(`[tts] ✓ ${openaiVoice} → ${out.voiceName} (${out.audio.length} bytes, ${Date.now() - t0}ms)`);
	}
	// Opus requests are served as WAV on the NIM lane (NVCF Magpie's OGGOPUS
	// output is containerless raw packets — see resolveMagpieFormat); the
	// served format/content-type must say so truthfully.
	const opus = await synthesizeNvidiaTts({ text: 'Format truthfulness check.', voice: 'nova', format: 'opus' });
	assert(opus.audio.subarray(0, 4).toString('ascii') === 'RIFF', `opus→wav magic: ${opus.audio.subarray(0, 4)}`);
	assert(opus.contentType === 'audio/wav' && opus.format === 'wav', 'opus→wav labels not truthful');
	console.log(`[tts] ✓ opus request truthfully served as WAV (${opus.audio.length} bytes)`);
}

// ── 3. Failover order through the real handler (forced NIM failure) ────────
if (!failoverOnly) {
	// Fresh process so the bogus key is the FIRST thing the gRPC channel ever
	// authenticates with (see header note on NVCF connection-level auth).
	const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--failover-only'], {
		env: {
			...process.env,
			NVIDIA_API_KEY: 'nvapi-deliberately-invalid-for-failover-check',
			OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-invalid-local-failover-check',
		},
		stdio: 'inherit',
		timeout: 120_000,
	});
	if (r.status !== 0) {
		console.error('[tts] FAIL — failover child exited with', r.status);
		process.exit(1);
	}
} else {
	const handler = (await import('../api/tts/speak.js')).default;
	const body = Buffer.from(JSON.stringify({ text: 'Failover order check.', voice: 'nova' }));
	const req = Readable.from([body]);
	req.method = 'POST';
	req.url = '/api/tts/speak';
	req.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
	const chunks = [];
	const res = {
		statusCode: 200,
		_h: {},
		writableEnded: false,
		headersSent: false,
		setHeader(k, v) { this._h[k.toLowerCase()] = v; },
		getHeader(k) { return this._h[k.toLowerCase()]; },
		write(c) { chunks.push(Buffer.from(c)); },
		end(c) { if (c) chunks.push(Buffer.from(c)); this.writableEnded = true; },
	};
	await handler(req, res);
	const payload = Buffer.concat(chunks);

	if (res.statusCode === 200) {
		// A working local OpenAI key served the backstop — order is still proven:
		// NIM was forced invalid, headers must say OpenAI served.
		assert(res._h['x-tts-model'] !== 'magpie-tts-multilingual', 'NIM claimed to serve with an invalid key');
		console.log(`[tts] ✓ failover — NIM failed, OpenAI backstop SERVED (model ${res._h['x-tts-model']})`);
	} else {
		assert(res.statusCode === 502, `expected 502 when both lanes fail, got ${res.statusCode}`);
		const err = JSON.parse(payload.toString('utf8'));
		const detail = err.error_description || '';
		const iNvidia = detail.indexOf('nvidia:');
		const iOpenai = detail.indexOf('openai:');
		assert(iNvidia !== -1, `nvidia lane missing from error: ${detail}`);
		assert(iOpenai !== -1, `openai lane was never attempted: ${detail}`);
		assert(iNvidia < iOpenai, `lane order wrong: ${detail}`);
		console.log(`[tts] ✓ failover order — nvidia first, openai second, clean 502: ${detail.slice(0, 160)}…`);
	}
}

if (!failoverOnly) console.log('[tts] PASS');
