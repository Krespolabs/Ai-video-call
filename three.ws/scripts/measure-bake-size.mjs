// scripts/measure-bake-size.mjs
//
// Measures the size reduction the meshopt() transform contributes to the
// avatar bake pipeline. Bakes a reference avatar GLB twice — once through
// the production transform chain in api/_lib/bake.js, once through the
// same chain with meshopt() removed — and reports both byte sizes plus
// the after/before ratio.
//
// Usage:
//   node scripts/measure-bake-size.mjs              # default rig (default.glb)
//   node scripts/measure-bake-size.mjs <path.glb>   # explicit GLB path
//
// Defaults to public/avatars/default.glb because that's the rig three.ws
// hands every new user — its profile (full-body, skinned, multiple meshes)
// is the realistic case for the bake pipeline. Smaller / hand-modeled
// avatars get less from meshopt and are not a fair benchmark.
//
// The "after" pipeline mirrors bakeAppearance() in api/_lib/bake.js
// exactly except for the level: 'medium' meshopt() step. The "before"
// pipeline runs the same steps minus that one transform, so the delta is
// fully attributable to meshopt.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
	unpartition,
	prune,
	dedup,
	weld,
	quantize,
	meshopt,
	textureCompress,
} from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const QUANTIZE_OPTS = {
	quantizePosition: 14,
	quantizeNormal: 10,
	quantizeTexcoord: 12,
	quantizeColor: 8,
	quantizeWeight: 8,
	quantizeGeneric: 12,
};

const TEXTURE_OPTS = {
	encoder: sharp,
	targetFormat: 'webp',
	resize: [1024, 1024],
	quality: 85,
};

async function makeIO() {
	await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready]);
	return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
		'meshopt.encoder': MeshoptEncoder,
		'meshopt.decoder': MeshoptDecoder,
	});
}

async function bake(bytes, { withMeshopt }) {
	const io = await makeIO();
	const doc = await io.readBinary(new Uint8Array(bytes));
	const steps = [
		unpartition(),
		prune(),
		dedup(),
		weld(),
		quantize(QUANTIZE_OPTS),
	];
	if (withMeshopt) {
		steps.push(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
	}
	steps.push(textureCompress(TEXTURE_OPTS));
	await doc.transform(...steps);
	return io.writeBinary(doc);
}

function fmt(bytes) {
	if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${bytes} B`;
}

async function main() {
	const inputPath =
		process.argv[2] || path.resolve(process.cwd(), 'public/avatars/default.glb');
	const sourceBytes = await readFile(inputPath);

	console.log(`Source: ${inputPath}`);
	console.log(`  size: ${fmt(sourceBytes.byteLength)}`);
	console.log('');

	const t0 = Date.now();
	const baselineBytes = await bake(sourceBytes, { withMeshopt: false });
	const t1 = Date.now();
	const meshoptBytes = await bake(sourceBytes, { withMeshopt: true });
	const t2 = Date.now();

	const baseline = baselineBytes.byteLength;
	const after = meshoptBytes.byteLength;
	const ratio = after / baseline;
	const reduction = 1 - ratio;

	console.log(`Baseline (weld+quantize+textureCompress):`);
	console.log(`  size: ${fmt(baseline)}`);
	console.log(`  bake time: ${t1 - t0} ms`);
	console.log('');
	console.log(`With meshopt() (level=medium):`);
	console.log(`  size: ${fmt(after)}`);
	console.log(`  bake time: ${t2 - t1} ms`);
	console.log('');
	console.log(`Δ: ${fmt(baseline - after)} smaller`);
	console.log(`Ratio after/before: ${ratio.toFixed(3)}`);
	console.log(`Reduction: ${(reduction * 100).toFixed(1)}%`);
	console.log('');

	// Sanity gate matching the task's expected band.
	if (ratio > 0.6) {
		console.warn(
			`WARN: after/before ratio ${ratio.toFixed(3)} is worse than 0.6.`,
		);
		console.warn(
			'meshopt should yield 30–50% reduction on top of the existing pipeline.',
		);
		console.warn('Investigate the transform parameters.');
		process.exitCode = 1;
	}
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
