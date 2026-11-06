#!/usr/bin/env node
/**
 * extract-glb-animations.mjs
 *
 * Downloads GLB files from public URLs, splits each animation track into its
 * own source file under animation-sources/, then upserts entries into
 * scripts/animations.config.json so npm run build:animations picks them up.
 *
 * No credentials required — only uses MIT-licensed public assets.
 *
 * Usage:
 *   node scripts/extract-glb-animations.mjs
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SOURCES_DIR = join(ROOT, 'animation-sources');
const CONFIG_PATH = join(__dirname, 'animations.config.json');

mkdirSync(SOURCES_DIR, { recursive: true });

// ── Free public animated GLB sources (MIT / CC0 licensed) ─────────────────
const BASE = 'https://raw.githubusercontent.com/mrdoob/three.js/dev/examples/models/gltf';

const SOURCES = [
	{
		url: `${BASE}/Soldier.glb`,
		prefix: 'soldier',
		skip: ['TPose'],
		overrides: {
			Idle: { icon: '🧍', loop: true },
			Walk: { icon: '🚶', loop: true },
			Run:  { icon: '🏃', loop: true },
		},
	},
	{
		url: `${BASE}/Michelle.glb`,
		prefix: 'michelle',
		skip: ['TPose'],
		overrides: {
			SambaDance: { icon: '💃', loop: true, label: 'Samba Dance' },
		},
	},
	{
		url: `${BASE}/Xbot.glb`,
		prefix: 'xbot',
		skip: [],
		overrides: {
			agree:      { icon: '👍', loop: false, label: 'Agree' },
			headShake:  { icon: '🙅', loop: false, label: 'Head Shake' },
			idle:       { icon: '🧍', loop: true,  label: 'Idle (Xbot)' },
			run:        { icon: '🏃', loop: true,  label: 'Run' },
			sad_pose:   { icon: '😔', loop: true,  label: 'Sad' },
			sneak_pose: { icon: '🕵️', loop: true,  label: 'Sneak' },
			walk:       { icon: '🚶', loop: true,  label: 'Walk (Xbot)' },
		},
	},
	{
		url: `${BASE}/RobotExpressive/RobotExpressive.glb`,
		prefix: 'robot',
		skip: [],
		overrides: {
			Dance:     { icon: '🤖', loop: true  },
			Death:     { icon: '💀', loop: false },
			Idle:      { icon: '🤖', loop: true  },
			Jump:      { icon: '🦘', loop: false },
			No:        { icon: '🙅', loop: false },
			Punch:     { icon: '👊', loop: false },
			Running:   { icon: '🏃', loop: true  },
			Sitting:   { icon: '🪑', loop: true  },
			Standing:  { icon: '🧍', loop: false },
			ThumbsUp:  { icon: '👍', loop: false, label: 'Thumbs Up' },
			Walking:   { icon: '🚶', loop: true  },
			WalkJump:  { icon: '🦘', loop: false, label: 'Walk Jump' },
			Wave:      { icon: '👋', loop: false },
			Yes:       { icon: '✅', loop: false },
		},
	},
];

// ── GLB parse / write helpers ──────────────────────────────────────────────

function parseGlb(buf) {
	const magic = buf.readUInt32LE(0);
	if (magic !== 0x46546C67) throw new Error('Not a GLB file');

	const chunks = [];
	let offset = 12;
	while (offset < buf.length) {
		const chunkLen  = buf.readUInt32LE(offset);
		const chunkType = buf.readUInt32LE(offset + 4);
		const data = buf.slice(offset + 8, offset + 8 + chunkLen);
		chunks.push({ type: chunkType, data });
		offset += 8 + chunkLen;
	}

	const jsonChunk = chunks.find((c) => c.type === 0x4E4F534A); // 'JSON'
	const binChunk  = chunks.find((c) => c.type === 0x004E4942); // 'BIN\0'
	if (!jsonChunk) throw new Error('GLB missing JSON chunk');

	const gltf = JSON.parse(jsonChunk.data.toString('utf8'));
	return { gltf, binData: binChunk?.data ?? null };
}

function writeGlb(gltf, binData) {
	// JSON chunk — must be padded to 4-byte alignment with spaces (0x20)
	let jsonStr = JSON.stringify(gltf);
	while (jsonStr.length % 4 !== 0) jsonStr += ' ';
	const jsonBuf = Buffer.from(jsonStr, 'utf8');

	const chunks = [];

	// JSON chunk header (length + type)
	const jsonHeader = Buffer.allocUnsafe(8);
	jsonHeader.writeUInt32LE(jsonBuf.length, 0);
	jsonHeader.writeUInt32LE(0x4E4F534A, 4);
	chunks.push(jsonHeader, jsonBuf);

	if (binData && binData.length > 0) {
		// BIN chunk — must be padded to 4-byte alignment with zeros
		let padded = binData;
		if (binData.length % 4 !== 0) {
			padded = Buffer.concat([binData, Buffer.alloc(4 - (binData.length % 4))]);
		}
		const binHeader = Buffer.allocUnsafe(8);
		binHeader.writeUInt32LE(padded.length, 0);
		binHeader.writeUInt32LE(0x004E4942, 4);
		chunks.push(binHeader, padded);
	}

	const body = Buffer.concat(chunks);

	// GLB header (12 bytes)
	const header = Buffer.allocUnsafe(12);
	header.writeUInt32LE(0x46546C67, 0); // magic
	header.writeUInt32LE(2, 4);           // version
	header.writeUInt32LE(12 + body.length, 8);
	return Buffer.concat([header, body]);
}

function slugify(s) {
	return s
		.replace(/([A-Z])/g, (m) => `-${m.toLowerCase()}`)
		.replace(/^-/, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 64);
}

// ── Extract one animation track into its own GLB ──────────────────────────

function extractAnimation(gltf, binData, animIndex) {
	const anim = gltf.animations[animIndex];
	if (!anim) throw new Error(`No animation at index ${animIndex}`);

	// Collect all accessor indices referenced by this animation's samplers
	const usedAccessors = new Set();
	for (const sampler of anim.samplers ?? []) {
		if (sampler.input  != null) usedAccessors.add(sampler.input);
		if (sampler.output != null) usedAccessors.add(sampler.output);
	}

	// Build a minimal gltf with only this animation
	// Keep all nodes, skins, meshes, accessors, bufferViews, and the buffer —
	// it's wasteful to strip them since the retargeter needs the full skeleton.
	const out = {
		asset: gltf.asset,
		scene: gltf.scene,
		scenes: gltf.scenes,
		nodes: gltf.nodes,
		skins: gltf.skins,
		meshes: gltf.meshes,
		materials: gltf.materials,
		textures: gltf.textures,
		images: gltf.images,
		samplers: gltf.samplers,
		accessors: gltf.accessors,
		bufferViews: gltf.bufferViews,
		buffers: gltf.buffers,
		animations: [anim],
		extensionsUsed: gltf.extensionsUsed,
		extensionsRequired: gltf.extensionsRequired,
		extensions: gltf.extensions,
		extras: gltf.extras,
	};

	// Strip undefined keys
	for (const k of Object.keys(out)) {
		if (out[k] == null) delete out[k];
	}

	return writeGlb(out, binData);
}

// ── Download + split ───────────────────────────────────────────────────────

async function download(url) {
	const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
	if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
	return Buffer.from(await res.arrayBuffer());
}

// ── Main ──────────────────────────────────────────────────────────────────

const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const existingNames    = new Set(config.map((e) => e.name));
const existingSources  = new Set(config.map((e) => e.source));

let totalAdded = 0;

for (const source of SOURCES) {
	console.log(`\n📦 ${source.url.split('/').pop()}`);

	let glbBuf;
	try {
		glbBuf = await download(source.url);
		console.log(`  ✅ Downloaded (${(glbBuf.length / 1024).toFixed(0)} KB)`);
	} catch (err) {
		console.error(`  ❌ ${err.message}`);
		continue;
	}

	let gltf, binData;
	try {
		({ gltf, binData } = parseGlb(glbBuf));
	} catch (err) {
		console.error(`  ❌ Parse error: ${err.message}`);
		continue;
	}

	const animations = gltf.animations ?? [];
	console.log(`  ${animations.length} animation tracks`);

	for (let i = 0; i < animations.length; i++) {
		const animName = animations[i].name ?? `anim${i}`;

		// Skip blacklisted tracks
		if (source.skip.includes(animName)) {
			console.log(`  ⏭  ${animName} (skipped)`);
			continue;
		}

		const ov     = source.overrides?.[animName] ?? {};
		const label  = ov.label ?? animName;
		const slug   = `${source.prefix}-${slugify(animName)}`;
		const filename = `${slug}.glb`;
		const name   = slug;

		if (existingSources.has(filename)) {
			// animation-sources/ is gitignored, so on a fresh checkout the config
			// entry survives but its source file doesn't. Regenerate the file
			// (without duplicating the config entry) so build:animations can bake it.
			const outPath = join(SOURCES_DIR, filename);
			if (existsSync(outPath)) {
				console.log(`  ⏭  ${animName} → ${filename} (already in config)`);
			} else {
				try {
					const extracted = extractAnimation(gltf, binData, i);
					writeFileSync(outPath, extracted);
					console.log(`  ♻️  ${animName} → ${filename} regenerated (${(extracted.length / 1024).toFixed(0)} KB)`);
				} catch (err) {
					console.error(`  ❌ Re-extract failed for ${animName}: ${err.message}`);
				}
			}
			continue;
		}
		if (existingNames.has(name)) {
			console.log(`  ⏭  ${animName} → name "${name}" already exists`);
			continue;
		}

		// Extract and save
		const outPath = join(SOURCES_DIR, filename);
		try {
			const extracted = extractAnimation(gltf, binData, i);
			writeFileSync(outPath, extracted);
			console.log(`  ✅ ${animName} → ${filename} (${(extracted.length / 1024).toFixed(0)} KB)`);
		} catch (err) {
			console.error(`  ❌ Extract failed for ${animName}: ${err.message}`);
			continue;
		}

		const entry = {
			name,
			source: filename,
			label,
			icon: ov.icon ?? '🎬',
			loop: ov.loop ?? false,
		};

		config.push(entry);
		existingNames.add(name);
		existingSources.add(filename);
		totalAdded++;
	}
}

if (totalAdded > 0) {
	writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
	console.log(`\n✅ Added ${totalAdded} entries to animations.config.json (total: ${config.length})`);
	console.log('   Run: npm run build:animations');
} else {
	console.log('\nℹ️  No new entries added (all already present).');
}
