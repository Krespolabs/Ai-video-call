#!/usr/bin/env node
// Verify the IBM Granite Vision integration (/api/ibm/vision).
//
//   Phase 1 — offline, deterministic, always runs. Proves the wire contract the
//   endpoint sends to watsonx.ai (model id, the multimodal text+image_url message
//   shape), the SSRF allowlist on server-fetched images, and the reply parser
//   (clean JSON, code-fenced, prose-wrapped, garbage). No network — never flaky.
//
//   Phase 2 — live, best-effort. If WATSONX_API_KEY + a project/space are set, it
//   mints a real IAM token and sends a tiny image to the real Granite Vision model
//   on watsonx.ai, asserting a non-empty reply — proving the multimodal endpoint
//   accepts our exact payload. Skipped (not failed) when credentials are absent.
//
// Usage: node scripts/verify-granite-vision.mjs
// Exit 0 = pass, 1 = fail.

import {
	VISION_MODEL,
	buildPrompt,
	buildVisionMessages,
	parseVision,
	allowedImageHost,
} from '../api/ibm/vision.js';
import { watsonxConfig, watsonxChatComplete } from '../api/_lib/watsonx.js';

let failed = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
	failed++;
	console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`);
};
function assert(cond, name, detail) {
	if (cond) ok(name);
	else bad(name, detail);
}

// A real, minimal PNG (1×1 red) as a data URL — a valid image to prove the
// multimodal wire format end-to-end without shipping a large asset.
const TINY_PNG =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

console.log('\n\x1b[1mGranite Vision — wire contract (offline)\x1b[0m');

// 1. Default model id is Granite Vision on watsonx.ai.
assert(VISION_MODEL.startsWith('ibm/granite-vision'), 'default model is a Granite Vision model', VISION_MODEL);

// 2. The prompt asks for a structured JSON identity and adapts per subject.
for (const subject of ['avatar', 'token', 'image']) {
	const { system, user } = buildPrompt(subject, '');
	assert(
		typeof system === 'string' && system.length > 20 && /JSON/i.test(user),
		`buildPrompt("${subject}") yields a JSON-structured instruction`,
	);
}
// The hint is woven in when provided.
assert(/Nebula/.test(buildPrompt('avatar', 'call it Nebula').user), 'buildPrompt folds the caller hint into the prompt');

// 3. The multimodal message shape watsonx Granite Vision expects.
const messages = buildVisionMessages('avatar', '', TINY_PNG);
assert(Array.isArray(messages) && messages.length === 2, 'two messages: system + user');
assert(messages[0].role === 'system' && typeof messages[0].content === 'string', 'system message is a plain string');
const userMsg = messages[1];
assert(userMsg.role === 'user' && Array.isArray(userMsg.content), 'user message content is a block array');
const textBlock = userMsg.content.find((b) => b.type === 'text');
const imgBlock = userMsg.content.find((b) => b.type === 'image_url');
assert(textBlock && typeof textBlock.text === 'string', 'has a {type:"text"} block');
assert(
	imgBlock && imgBlock.image_url && typeof imgBlock.image_url.url === 'string' && imgBlock.image_url.url.startsWith('data:image/'),
	'has a {type:"image_url", image_url:{url:"data:image/…"}} block',
);

console.log('\n\x1b[1mSSRF allowlist for server-fetched images\x1b[0m');
const allowHosts = ['pub-abc123.r2.dev', 'three.ws', 'pump.mypinata.cloud', 'ipfs.io', 'arweave.net'];
const denyHosts = ['169.254.169.254', 'localhost', '127.0.0.1', 'metadata.google.internal', 'evil.example.com', '10.0.0.5'];
for (const h of allowHosts) assert(allowedImageHost(h), `allows public media host ${h}`);
for (const h of denyHosts) assert(!allowedImageHost(h), `rejects ${h}`);

console.log('\n\x1b[1mReply parser\x1b[0m');
// Clean JSON.
const clean = parseVision(
	'{"appearance":"A blue robot.","vibe":"calm, curious","persona":"A patient guide.","suggested_name":"Cobalt","bio":"Your steady co-pilot.","tone_tags":["calm","helpful"],"voice":"warm and measured"}',
);
assert(clean.structured && clean.suggested_name === 'Cobalt' && clean.tone_tags.length === 2, 'parses a clean JSON identity');
assert(Array.isArray(clean.tone_tags), 'tone_tags normalized to an array');
// Code-fenced + prose wrapped.
const fenced = parseVision('Here you go:\n```json\n{"appearance":"x","vibe":"bold","bio":"y","tone_tags":"bold, loud"}\n```\nHope that helps!');
assert(fenced.structured && fenced.tone_tags.join(',') === 'bold,loud', 'recovers JSON from code fence + splits string tags');
// Garbage → honest non-structured fallback, never invents fields.
const garbage = parseVision('I cannot quite tell what this is.');
assert(garbage.structured === false && garbage.suggested_name === '', 'garbage reply → structured:false, no invented fields');
assert(parseVision('').structured === false, 'empty reply → structured:false');

// ── Phase 2: live ────────────────────────────────────────────────────────────
const cfg = watsonxConfig();
if (!cfg.configured) {
	console.log('\n\x1b[33m∼ live Granite Vision check skipped\x1b[0m (WATSONX_API_KEY / project not set) — contract proven above.\n');
} else {
	console.log('\n\x1b[1mLive Granite Vision on watsonx.ai\x1b[0m');
	try {
		const reply = await watsonxChatComplete(cfg, {
			model: VISION_MODEL,
			maxTokens: 80,
			temperature: 0.2,
			messages: buildVisionMessages('image', 'a solid color test swatch', TINY_PNG),
		});
		assert(reply && typeof reply.text === 'string' && reply.text.trim().length > 0, 'real Granite Vision returned a non-empty reply');
		console.log(`    model: ${reply.model || VISION_MODEL}`);
		console.log(`    reply: ${reply.text.trim().slice(0, 140).replace(/\s+/g, ' ')}…`);
	} catch (e) {
		bad('live Granite Vision call', e.message);
		console.log('    (check WATSONX_VISION_MODEL_ID is available in your region/project)');
	}
}

console.log('');
if (failed) {
	console.log(`\x1b[31m${failed} check(s) failed.\x1b[0m\n`);
	process.exit(1);
}
console.log('\x1b[32mAll Granite Vision checks passed.\x1b[0m\n');
