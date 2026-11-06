#!/usr/bin/env node
/**
 * Convert a skinned, animated FBX avatar to a binary GLB the site can load.
 *
 * Backed by FBX2glTF (Meta's converter, prebuilt binary shipped by the
 * `fbx2gltf` npm package). Unlike scripts/convert-fbx-to-glb.py (trimesh —
 * static geometry only, drops the rig) and unlike a headless three.js
 * GLTFExporter round-trip (stalls on FBX materials in Node), FBX2glTF
 * preserves the skeleton, skin weights, animation clips, AND textures in one
 * pass. It is the right tool for an animated character.
 *
 * The site loads GLB via three.js GLTFLoader and drives clips with
 * AnimationManager, so the output drops straight into public/avatars/.
 *
 * Usage:
 *   node scripts/fbx-to-glb.mjs <input.fbx> [output.glb]
 *   npm run convert:fbx -- character.fbx
 *   npm run convert:fbx -- character.fbx public/avatars/my-avatar.glb
 *
 * With no output path, writes public/avatars/<sanitized-name>.glb.
 *
 * After converting, shrink it for the web:  npm run optimize:glb
 */
import { readFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename, extname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function sanitize(p) {
	return basename(p, extname(p))
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Read a binary GLB's JSON chunk and summarize what survived the conversion. */
function summarizeGlb(path) {
	const b = readFileSync(path);
	if (b.length < 20 || b.toString('ascii', 0, 4) !== 'glTF') {
		throw new Error('output is not a valid binary GLB');
	}
	const jsonLen = b.readUInt32LE(12);
	const json = JSON.parse(b.toString('utf8', 20, 20 + jsonLen));
	return {
		bytes: b.length,
		meshes: (json.meshes || []).length,
		skins: (json.skins || []).length,
		nodes: (json.nodes || []).length,
		images: (json.images || []).length,
		animations: (json.animations || []).map((a, i) => a.name || `clip${i}`),
	};
}

async function main() {
	const [inputArg, outputArg] = process.argv.slice(2);
	if (!inputArg || !inputArg.toLowerCase().endsWith('.fbx')) {
		console.error('Usage: node scripts/fbx-to-glb.mjs <input.fbx> [output.glb]');
		process.exit(1);
	}

	let convert;
	try {
		convert = require('fbx2gltf');
	} catch {
		console.error('fbx2gltf is not installed. Run:  npm i -D fbx2gltf');
		process.exit(1);
	}

	const inputPath = isAbsolute(inputArg) ? inputArg : resolve(process.cwd(), inputArg);
	const outputPath = outputArg
		? (isAbsolute(outputArg) ? outputArg : resolve(process.cwd(), outputArg))
		: resolve(ROOT, 'public/avatars', `${sanitize(inputPath)}.glb`);
	mkdirSync(dirname(outputPath), { recursive: true });

	console.log(`Converting ${basename(inputPath)} -> ${outputPath} ...`);

	// FBX2glTF emits binary glTF when the destination ends in .glb. It keeps
	// PBR metallic-roughness materials and embeds textures by default. No Draco:
	// the site's GLTFLoader is not wired with a Draco decoder, and optimize:glb
	// handles web compression afterward.
	let written;
	try {
		written = await convert(inputPath, outputPath, ['--khr-materials-unlit', '--pbr-metallic-roughness']);
	} catch (err) {
		// convert() rejects with the destination path on some builds even when the
		// file was produced; surface the real error text if present.
		const msg = Array.isArray(err) ? err.join(' ') : (err?.message || String(err));
		throw new Error(msg);
	}

	// Some FBX2glTF builds write to "<output>_out/..." or append; normalize to
	// the requested path if the convert() return differs.
	if (written && written !== outputPath) {
		try { renameSync(written, outputPath); } catch { /* already at outputPath */ }
	}

	const s = summarizeGlb(outputPath);
	console.log(`\nWrote ${outputPath} (${(s.bytes / 1024).toFixed(0)} KB)`);
	console.log(`  meshes: ${s.meshes} | skins: ${s.skins} | nodes: ${s.nodes} | textures: ${s.images}`);
	console.log(`  animations: ${s.animations.length}${s.animations.length ? ' -> ' + s.animations.join(', ') : ''}`);
	if (!s.skins) console.warn('  NOTE: no skin found — this FBX carries a skeleton/animation but no skinned mesh.');
	if (!s.animations.length) console.warn('  NOTE: no animation clips found in this FBX.');
	console.log('\nNext: optimize for the web ->  npm run optimize:glb');
}

main().catch((err) => {
	console.error('Conversion failed:', err?.message || err);
	process.exit(1);
});
