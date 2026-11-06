// Crier (capability bit 4) — turns a task's text into a real spoken-audio clip.
// Backed by @three-ws/voice over the free /api/tts/speak lane (NVIDIA Magpie
// TTS). The deliverable is the audio bytes; the proof is sha256 of exactly those
// bytes. Same `run<Profession>` contract as work/fetcher.js.

import { buildWorkResult, storeDeliverable, httpBytes, jobPrompt } from './_skills.js';

const EXT_FOR = { mp3: 'mp3', wav: 'wav', opus: 'ogg', aac: 'aac', flac: 'flac', pcm: 'pcm' };

// The free TTS lane serves WAV regardless of the requested format, so the stored
// artifact's extension must follow the ACTUAL bytes (a .mp3 holding WAV is a lie),
// not the request. Fall back to the requested format's ext if the content-type is
// unknown/absent.
const EXT_BY_CT = {
	'audio/mpeg': 'mp3',
	'audio/mp3': 'mp3',
	'audio/wav': 'wav',
	'audio/x-wav': 'wav',
	'audio/wave': 'wav',
	'audio/vnd.wave': 'wav',
	'audio/ogg': 'ogg',
	'audio/opus': 'ogg',
	'audio/aac': 'aac',
	'audio/flac': 'flac',
	'audio/x-flac': 'flac',
};
function extFor(contentType, requestedFormat) {
	const ct = String(contentType || '')
		.split(';')[0]
		.trim()
		.toLowerCase();
	return EXT_BY_CT[ct] || EXT_FOR[requestedFormat] || 'audio';
}

const DEFAULT_LINES = [
	'Hear ye, hear ye — the Commons is open and the board is live.',
	'A new bounty has hit the square. Qualified citizens, make your claim.',
	'The Forge Quarter rings with fresh work this hour.',
	'Proof accepted, reward released — another job well done.',
];

function lineFor(citizen, job) {
	const explicit = jobPrompt(job);
	if (explicit) return explicit;
	const seed = String(citizen?.agentIdHex || job?.taskPda || '0');
	let h = 0;
	for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return DEFAULT_LINES[h % DEFAULT_LINES.length];
}

export async function runCrier({ cfg, citizen, job } = {}) {
	const apiBase = cfg?.apiBase || 'https://three.ws';
	const log = cfg?.log || (() => {});
	const text = lineFor(citizen, job);
	const format = job?.format || 'mp3';
	const voice = job?.voice || 'nova';

	log?.(`crier: synthesizing ${format} voice (${voice}) for "${text.slice(0, 60)}"`);
	const { bytes, contentType } = await httpBytes(apiBase, '/api/tts/speak', {
		method: 'POST',
		headers: { 'content-type': 'application/json', accept: 'audio/*' },
		body: { text, voice, format },
	});
	if (!bytes?.length) throw new Error('crier: tts returned 0 audio bytes');

	const ext = extFor(contentType, format);
	const deliverable = await storeDeliverable({
		profession: 'crier',
		ext,
		contentType: contentType || 'audio/mpeg',
		bytes,
		optional: true,
	});

	return buildWorkResult({
		profession: 'crier',
		citizen,
		deliverableUrl: deliverable.url,
		deliverableBytes: bytes,
		summary: `Voiced a ${bytes.length.toLocaleString()}-byte ${ext.toUpperCase()} clip (${voice})`,
		meta: { text, requestedFormat: format, format: ext, voice, contentType: contentType || null, stored: deliverable.stored },
	});
}

export default runCrier;
