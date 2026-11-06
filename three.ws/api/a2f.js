// POST /api/a2f — free facial animation (Audio2Face-3D) for the talking avatar.
//
// The third leg of the avatar voice loop: /api/tts/speak gives every avatar a
// voice (Magpie), /api/asr lets users talk back (Riva), and THIS endpoint turns
// the spoken audio into a per-frame ARKit blendshape track so the avatar's mouth
// and face animate in sync with the words. Two named NVIDIA models on one face:
// Magpie voice + Audio2Face-3D animation (api/_lib/a2f-nvidia.js).
//
// Lane: NVIDIA NIM Audio2Face-3D (free, bidirectional gRPC). Purely additive —
// when the lane is unconfigured (no NVIDIA_API_KEY) the client keeps speaking and
// falls back to its in-browser amplitude lipsync, so nothing depends on this and
// nothing breaks when it is absent.
//
// Two ways to call it:
//
//   1. Animate audio you already have (lips match the EXACT bytes you'll play):
//      • raw audio body with Content-Type audio/wav | audio/pcm (+ ?rate=)
//      • or JSON { audio: <base64>, format?, sampleRate? }
//      → { ok, animation: { fps, blendShapeNames, frames, durationSec, … } }
//
//   2. One-shot text→speech→animation (server synthesizes via Magpie, then
//      animates that exact clip, and returns BOTH so you can play + drive):
//      • JSON { text, voice?, language? }
//      → { ok, audio: { base64, contentType, format }, animation: { … } }
//
// A frame is { t, w }: t = time code in seconds from clip start, w = weights in
// the order of blendShapeNames (ARKit naming). The browser plays the audio and
// samples the track by the audio element's currentTime — see
// src/voice/a2f-blendshapes.js for the morph-target mapping + player.

import { cors, method, readBody, readJson, error, json, wrap, rateLimited } from './_lib/http.js';
import { getSessionUser, authenticateBearer, extractBearer } from './_lib/auth.js';
import { limits, clientIp } from './_lib/rate-limit.js';
import { animateNvidiaA2F, nvidiaA2fConfigured, resolveA2fFunctionId } from './_lib/a2f-nvidia.js';
import { synthesizeNvidiaTts, nvidiaTtsConfigured } from './_lib/tts-nvidia.js';
import { TTS_VOICE_IDS } from './_lib/tts-voices.js';

export const maxDuration = 60;

// 8 MiB of audio — generous for an avatar line (~4 min of 16 kHz mono PCM) while
// bounding the in-memory buffer per request.
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const A2F_TIMEOUT_MS = 40_000;
const TTS_TIMEOUT_MS = 30_000;
const VOICES = new Set(TTS_VOICE_IDS);

function encodingFromContentType(ct) {
	const type = String(ct || '').split(';')[0].trim().toLowerCase();
	switch (type) {
		case 'audio/wav':
		case 'audio/x-wav':
		case 'audio/wave':
			return 'wav';
		case 'audio/l16':
		case 'audio/pcm':
		case 'audio/x-pcm':
			return 'pcm';
		default:
			return null;
	}
}

export default wrap(async function handler(req, res) {
	if (cors(req, res, { methods: 'GET,POST,OPTIONS' })) return;
	if (!method(req, res, ['GET', 'POST'])) return;

	// Capability probe — lets the avatar UI decide whether to request a real A2F
	// track or go straight to the amplitude fallback, without browser-sniffing.
	if (req.method === 'GET' || req.method === 'HEAD') {
		return json(
			res,
			200,
			{
				configured: nvidiaA2fConfigured(),
				canSynthesize: nvidiaTtsConfigured(),
				model: 'audio2face-3d',
				functionId: nvidiaA2fConfigured() ? resolveA2fFunctionId() : null,
				fps: 30,
				// A2F emits ARKit-52 blendshape names; the client maps them onto
				// whatever convention the loaded GLB exposes (ARKit/RPM/VRM/Oculus).
				blendshapeFormat: 'arkit',
				sampleRate: 16000,
				accepts: { audio: ['wav', 'pcm'], json: ['audio', 'text'] },
			},
			{ 'cache-control': 'public, max-age=60' },
		);
	}

	if (!nvidiaA2fConfigured()) {
		return error(
			res,
			503,
			'not_configured',
			'Audio2Face is not configured (set NVIDIA_API_KEY). The avatar still speaks and falls back to amplitude lipsync.',
		);
	}

	// Metered like the other free NVIDIA lanes: per-user budget for signed-in
	// callers, a tighter per-IP one otherwise. The text path also burns a Magpie
	// synthesis, so the bucket covers both.
	const session = await getSessionUser(req);
	const bearer = session ? null : await authenticateBearer(extractBearer(req));
	const userId = session?.id ?? bearer?.userId ?? null;
	if (userId) {
		const rl = await limits.a2fUser(userId);
		if (!rl.success) return rateLimited(res, rl, 'Audio2Face rate limit exceeded, try again later');
	} else {
		const rl = await limits.a2fIp(clientIp(req));
		if (!rl.success) return rateLimited(res, rl, 'Audio2Face rate limit exceeded, sign in for a higher limit');
	}

	const url = new URL(req.url, 'http://localhost');
	const q = url.searchParams;
	const contentType = req.headers['content-type'] || '';
	const isJson = contentType.split(';')[0].trim().toLowerCase() === 'application/json';

	// ── Gather the audio (and, on the text path, synthesize it first) ─────────
	let wavBuffer = null; // a RIFF/WAVE buffer handed straight to A2F
	let rawPcm = null;
	let rawRate = 0;
	let audioOut = null; // { base64, contentType, format } when we synthesized

	try {
		if (isJson) {
			const body = await readJson(req, Math.ceil(MAX_AUDIO_BYTES * 1.4)); // base64 inflates ~33%

			const text = typeof body.text === 'string' ? body.text.trim() : '';
			const b64 = typeof body.audio === 'string' ? body.audio.replace(/^data:[^,]*,/, '') : '';

			if (b64) {
				const buf = Buffer.from(b64, 'base64');
				const fmt = String(body.format || 'wav').toLowerCase();
				if (fmt === 'pcm' || fmt === 'l16') {
					rawPcm = buf;
					rawRate = Number(body.sampleRate) || 16000;
				} else {
					wavBuffer = buf;
				}
			} else if (text) {
				if (!nvidiaTtsConfigured()) {
					return error(res, 503, 'not_configured', 'Text path needs Magpie TTS (NVIDIA_API_KEY) — pass pre-synthesized audio instead.');
				}
				if (text.length > 4096) return error(res, 400, 'bad_request', 'text exceeds 4096 characters');
				const voice = VOICES.has(body.voice) ? body.voice : 'nova';
				const language = typeof body.language === 'string' ? body.language : 'en-US';
				// WAV so A2F can parse the rate from the header and we can hand the
				// same bytes back to the browser to play.
				const tts = await synthesizeNvidiaTts({ text, voice, language, format: 'wav', timeoutMs: TTS_TIMEOUT_MS });
				wavBuffer = tts.audio;
				audioOut = {
					base64: tts.audio.toString('base64'),
					contentType: tts.contentType,
					format: tts.format,
					voiceName: tts.voiceName,
					sampleRateHz: tts.sampleRateHz,
				};
			} else {
				return error(res, 400, 'bad_request', 'provide { text } to synthesize, or { audio: <base64> } to animate');
			}
		} else {
			const fmt = encodingFromContentType(contentType);
			if (!fmt) {
				return error(res, 415, 'unsupported_media_type', `Unsupported audio Content-Type "${contentType.split(';')[0] || 'none'}". Send audio/wav or audio/pcm (with ?rate=), or a JSON body.`);
			}
			const buf = await readBody(req, MAX_AUDIO_BYTES);
			if (fmt === 'pcm') {
				rawPcm = buf;
				rawRate = Number(q.get('rate') || q.get('sampleRate')) || 16000;
			} else {
				wavBuffer = buf;
			}
		}
	} catch (e) {
		if (e?.status === 413) return error(res, 413, 'payload_too_large', 'audio exceeds the 8 MB limit');
		// A synthesis failure on the text path surfaces as a provider error.
		if (e?.code && e.code !== 'bad_request') {
			const status = e.code === 'rate_limited' ? 429 : e.code === 'invalid_key' ? 502 : 502;
			return error(res, status, e.code, `Speech synthesis failed: ${e.message || 'unknown error'}`);
		}
		return error(res, e?.status || 400, 'bad_request', e?.message || 'could not read request body');
	}

	if (!wavBuffer?.length && !rawPcm?.length) {
		return error(res, 400, 'bad_request', 'no audio to animate');
	}

	// ── Drive Audio2Face-3D ───────────────────────────────────────────────────
	try {
		const animation = await animateNvidiaA2F(
			wavBuffer
				? { wav: wavBuffer, timeoutMs: A2F_TIMEOUT_MS }
				: { pcm: rawPcm, sampleRateHz: rawRate, timeoutMs: A2F_TIMEOUT_MS },
		);
		return json(
			res,
			200,
			{
				ok: true,
				...(audioOut ? { audio: audioOut } : {}),
				animation,
			},
			{ 'cache-control': 'no-store' },
		);
	} catch (e) {
		const code = e?.code || 'provider_error';
		const status =
			code === 'rate_limited' ? 429 :
			code === 'invalid_argument' ? 400 :
			code === 'not_configured' ? 503 :
			code === 'timeout' ? 504 :
			502;
		return error(res, status, code, `Audio2Face failed: ${e?.message || 'unknown error'}`);
	}
});
