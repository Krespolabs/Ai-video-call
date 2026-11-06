#!/usr/bin/env node
// Live verification for the free NVIDIA Riva ASR lane (voice IN).
//
//   node scripts/verify-nvidia-asr.mjs --list   # enumerate NVCF functions and
//                                                # print the ASR candidates +
//                                                # their ids (needs NVIDIA_API_KEY)
//   node scripts/verify-nvidia-asr.mjs           # full round-trip check (needs
//                                                # NVIDIA_API_KEY + NVIDIA_ASR_FUNCTION_ID)
//
// The function id for the hosted ASR model is deployment configuration, not a
// pinned constant (Parakeet/Canary, multiple versions). `--list` discovers the
// live id for your account by enumerating
//   GET https://api.nvcf.nvidia.com/v2/nvcf/functions
// and printing every function whose name looks like speech recognition. Copy the
// id into NVIDIA_ASR_FUNCTION_ID (.env.local / vercel env), then run the script
// with no args to prove the lane end to end.
//
// The full check is a self-contained round-trip across BOTH free lanes: it
// synthesizes a known sentence through the Magpie TTS lane (api/_lib/tts-nvidia.js)
// to get real spoken audio, transcribes it back through the Riva ASR lane
// (api/_lib/asr-nvidia.js), and asserts the transcript recovers the spoken words.
// No fixture audio files are needed and nothing is written to disk.

import { config as dotenv } from 'dotenv';

dotenv({ path: new URL('../.env.local', import.meta.url) });
// .env.local can carry prod flags; clear them so nothing fails closed locally.
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;

const listOnly = process.argv.includes('--list');

if (!process.env.NVIDIA_API_KEY) {
	console.error('[asr] NVIDIA_API_KEY missing from environment/.env.local — cannot verify');
	process.exit(1);
}

const NVCF_FUNCTIONS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/functions';
const ASR_NAME_HINT = /(asr|speech.?recognition|recognize|parakeet|canary|conformer|citrinet)/i;

async function listFunctions() {
	const res = await fetch(NVCF_FUNCTIONS_URL, {
		headers: { authorization: `Bearer ${process.env.NVIDIA_API_KEY}`, accept: 'application/json' },
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => '');
		throw new Error(`NVCF function list returned ${res.status}: ${detail.slice(0, 300)}`);
	}
	const data = await res.json();
	const functions = Array.isArray(data?.functions) ? data.functions : [];
	const asr = functions.filter((f) => ASR_NAME_HINT.test(`${f?.name || ''} ${f?.id || ''}`));
	console.log(`[asr] ${functions.length} NVCF functions visible; ${asr.length} look like ASR:\n`);
	for (const f of asr) {
		console.log(`  ${f.id}  ${f.status || ''}  ${f.name || ''}${f.versionId ? `  (v ${f.versionId})` : ''}`);
	}
	if (!asr.length) {
		console.log('  (none matched — list every function with: curl -H "Authorization: Bearer $NVIDIA_API_KEY" ' + NVCF_FUNCTIONS_URL + ')');
	} else {
		console.log('\n[asr] set NVIDIA_ASR_FUNCTION_ID to one of the ids above, then re-run without --list.');
	}
}

async function roundTrip() {
	if (!process.env.NVIDIA_ASR_FUNCTION_ID) {
		console.error('[asr] NVIDIA_ASR_FUNCTION_ID missing — run with --list to discover it first');
		process.exit(1);
	}
	const { synthesizeNvidiaTts } = await import('../api/_lib/tts-nvidia.js');
	const { transcribeNvidiaAsr, parseWav } = await import('../api/_lib/asr-nvidia.js');

	const sentence = 'the quick brown fox jumps over the lazy dog';
	console.log(`[asr] synthesizing reference audio via Magpie TTS: "${sentence}"`);
	const t0 = Date.now();
	const tts = await synthesizeNvidiaTts({ text: sentence, voice: 'nova', format: 'wav' });
	if (!tts.audio?.length || tts.audio.toString('ascii', 0, 4) !== 'RIFF') {
		throw new Error('TTS did not return a WAV — cannot build the ASR reference clip');
	}
	console.log(`[asr]   ${tts.audio.length} bytes of WAV in ${Date.now() - t0} ms`);

	const wav = parseWav(tts.audio);
	if (!wav) throw new Error('could not parse the synthesized WAV header');

	console.log('[asr] transcribing it back through Riva ASR…');
	const t1 = Date.now();
	const out = await transcribeNvidiaAsr({
		audio: wav.pcm,
		encoding: 'LINEAR_PCM',
		sampleRateHz: wav.sampleRateHz,
		language: 'en-US',
	});
	console.log(`[asr]   transcript in ${Date.now() - t1} ms: "${out.text}" (confidence ${out.confidence.toFixed(3)})`);

	const got = out.text.toLowerCase();
	const recovered = ['quick', 'brown', 'fox', 'lazy', 'dog'].filter((w) => got.includes(w));
	if (recovered.length < 3) {
		throw new Error(`transcript recovered only ${recovered.length}/5 key words — lane is not producing real recognition`);
	}
	console.log(`[asr] PASS — recovered ${recovered.length}/5 key words; round-trip across both free lanes works.`);
}

try {
	if (listOnly) await listFunctions();
	else await roundTrip();
} catch (e) {
	console.error(`[asr] FAIL — ${e?.message || e}`);
	process.exit(1);
}
