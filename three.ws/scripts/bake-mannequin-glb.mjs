// Bake the procedural /pose mannequin into a real GLB asset.
//
// The mannequin is generated in code (src/pose-mannequin.js) from Three.js
// primitives — it has no on-disk model. This script instantiates that exact
// class in its rest pose and exports it through GLTFExporter, so the baked
// asset and the live /pose figure stay a single source of truth: change the
// proportions in pose-mannequin.js, re-run this, and the GLB follows.
//
// Output: public/avatars/mannequin.glb  (the universal base avatar).
//
// Usage: node scripts/bake-mannequin-glb.mjs [--build male|female] [--out path]

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// GLTFExporter's binary path reads the assembled Blob through a FileReader,
// which exists in browsers but not in Node. Provide a minimal shim backed by
// Node's global Blob before importing the exporter.
if (typeof globalThis.FileReader === 'undefined') {
	globalThis.FileReader = class {
		readAsArrayBuffer(blob) {
			blob.arrayBuffer().then((buf) => {
				this.result = buf;
				this.onloadend?.();
			}).catch((err) => {
				this.error = err;
				this.onerror?.(err);
			});
		}
	};
}

import { Scene } from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Mannequin } from '../src/pose-mannequin.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

function arg(flag, fallback) {
	const i = process.argv.indexOf(flag);
	return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const build = arg('--build', 'male');
const outPath = resolve(repoRoot, arg('--out', 'public/avatars/mannequin.glb'));

// Build the figure in its neutral rest pose (all joint rotations zero → the
// figure stands upright, arms at sides). Name it so downstream loaders and the
// pose rig can recognise the root.
const mannequin = new Mannequin({ build, color: '#d4d4d8' });
mannequin.resetPose();

const scene = new Scene();
scene.name = 'three-ws-mannequin';
scene.add(mannequin.root);

const exporter = new GLTFExporter();
const result = await exporter.parseAsync(scene, {
	binary: true,
	// No textures on the mannequin, so embedImages is a no-op — kept explicit
	// for parity with the /pose export path.
	embedImages: true,
	onlyVisible: true,
});

const buffer = Buffer.from(result instanceof ArrayBuffer ? result : new Uint8Array(result));
writeFileSync(outPath, buffer);

const kb = (buffer.byteLength / 1024).toFixed(1);
console.log(`Baked ${build} mannequin → ${outPath} (${kb} KB)`);
