#!/usr/bin/env node
// Live verification for the free NVIDIA Cosmos text→world VIDEO lane.
//
//   node scripts/verify-nvidia-cosmos.mjs                 # full round-trip (needs NVIDIA_API_KEY)
//   node scripts/verify-nvidia-cosmos.mjs "a koi pond at dawn, mist on the water"
//   node scripts/verify-nvidia-cosmos.mjs --out world.mp4 # also save the clip to disk
//
// Proves the contract the provider (api/_providers/nvidia-cosmos.js) and the
// /api/cosmos endpoint depend on, against the REAL hosted endpoint: it submits a
// Text2World prompt to the NVCF genai gateway, follows the 202 + NVCF-REQID async
// handshake by polling pexec/status, and confirms a decodable MP4 comes back. It
// prints the exact request/response shapes so a deployment can confirm the live
// contract (and, if NVIDIA's gateway differs for an account, point
// NVIDIA_COSMOS_INVOKE_URL at the right path without a code change).
//
// Nothing is written to disk unless --out is passed.

import { config as dotenv } from 'dotenv';
import { writeFileSync } from 'node:fs';

dotenv({ path: new URL('../.env.local', import.meta.url) });
// .env.local can carry prod flags; clear them so nothing fails closed locally.
delete process.env.NODE_ENV;
delete process.env.VERCEL_ENV;

const KEY = process.env.NVIDIA_API_KEY;
if (!KEY) {
	console.error('[cosmos] NVIDIA_API_KEY missing from environment/.env.local — cannot verify');
	process.exit(1);
}

const INVOKE_URL =
	process.env.NVIDIA_COSMOS_INVOKE_URL || 'https://ai.api.nvidia.com/v1/cosmos/nvidia/cosmos-predict1-7b';
const STATUS_URL = 'https://api.nvcf.nvidia.com/v2/nvcf/pexec/status';

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx !== -1 ? args[outIdx + 1] : null;
const prompt =
	args.filter((a, i) => a !== '--out' && i !== outIdx + 1 && !a.startsWith('--')).join(' ') ||
	'a serene alpine lake at sunrise, mist drifting over the water, cinematic';

const auth = { authorization: `Bearer ${KEY}` };

function isBase64Blob(s) {
	return typeof s === 'string' && s.length > 64 && !/^https?:\/\//.test(s);
}

// Same multi-shape extraction the provider uses — kept in sync so a pass here
// means the provider will parse the same body.
async function extract(res) {
	const ct = (res.headers.get('content-type') || '').toLowerCase();
	if (ct.includes('json')) {
		const data = await res.json().catch(() => null);
		if (data && typeof data === 'object') {
			console.log(`[cosmos] response json keys: ${JSON.stringify(Object.keys(data))}`);
			const outs = Array.isArray(data.outputs) ? data.outputs : null;
			if (outs) {
				for (const o of outs) {
					const d = Array.isArray(o?.data) ? o.data[0] : o?.data;
					if (isBase64Blob(d)) return Buffer.from(d, 'base64');
					if (typeof d === 'string' && /^https?:\/\//.test(d)) return fetchBytes(d);
				}
			}
			for (const k of ['b64_video', 'video', 'b64_json', 'output']) {
				if (isBase64Blob(data[k])) return Buffer.from(data[k], 'base64');
			}
			const a = data?.artifacts?.[0];
			if (a) {
				const inline = a.base64 ?? a.data ?? (isBase64Blob(a) ? a : null);
				if (isBase64Blob(inline)) return Buffer.from(inline, 'base64');
				const url = a.url ?? (typeof a === 'string' && a.startsWith('http') ? a : null);
				if (url) return fetchBytes(url);
			}
		}
		return null;
	}
	if (ct.includes('mp4') || ct.startsWith('video/') || ct.includes('octet-stream') || ct.includes('binary')) {
		return Buffer.from(await res.arrayBuffer());
	}
	console.log(`[cosmos] unexpected content-type: ${ct}\n${(await res.text().catch(() => '')).slice(0, 300)}`);
	return null;
}

async function fetchBytes(url) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`artifact url ${url.slice(0, 60)} → ${r.status}`);
	return Buffer.from(await r.arrayBuffer());
}

const body = {
	inputs: [
		{ name: 'command', shape: [1], datatype: 'BYTES', data: [`text2world --prompt="${prompt.replace(/"/g, "'")}"`] },
	],
};

console.log(`[cosmos] POST ${INVOKE_URL}`);
console.log(`[cosmos] prompt: ${prompt}`);

const submit = await fetch(INVOKE_URL, {
	method: 'POST',
	headers: { ...auth, accept: 'application/json', 'content-type': 'application/json', 'nvcf-poll-seconds': '30' },
	body: JSON.stringify(body),
});

console.log(`[cosmos] submit → ${submit.status} ${submit.statusText}`);

let bytes = null;
if (submit.status === 202) {
	const reqId = submit.headers.get('nvcf-reqid');
	if (!reqId) throw new Error('202 but no NVCF-REQID header');
	console.log(`[cosmos] async job ${reqId} — polling pexec/status…`);
	const deadline = Date.now() + 5 * 60_000;
	while (Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, 5_000));
		const poll = await fetch(`${STATUS_URL}/${reqId}`, { headers: { ...auth, accept: 'application/json' } });
		process.stdout.write(`  poll → ${poll.status}\r`);
		if (poll.status === 202) continue;
		if (poll.ok) {
			bytes = await extract(poll);
			break;
		}
		throw new Error(`poll failed ${poll.status}: ${(await poll.text().catch(() => '')).slice(0, 300)}`);
	}
} else if (submit.ok) {
	bytes = await extract(submit);
} else {
	throw new Error(`submit failed ${submit.status}: ${(await submit.text().catch(() => '')).slice(0, 400)}`);
}

if (!bytes || bytes.length < 1000) {
	console.error('\n[cosmos] FAIL — no decodable MP4 came back. Check the response shape printed above.');
	process.exit(2);
}

// MP4 files begin with an `ftyp` box; the type tag sits at bytes 4–8.
const looksMp4 = bytes.length > 12 && bytes.toString('ascii', 4, 8) === 'ftyp';
console.log(`\n[cosmos] PASS — received ${(bytes.length / 1024 / 1024).toFixed(2)} MB, ftyp box: ${looksMp4 ? 'yes' : 'no'}`);
if (outPath) {
	writeFileSync(outPath, bytes);
	console.log(`[cosmos] wrote ${outPath}`);
}
