import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectModel } from '../src/gltf-inspect.js';

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);

// inspectModel powers /api/mcp (inspect_model), the endpoint the Rig Complexity
// Scorer pays to call. It must report counts.totalJoints (the avatar's bone
// count) — the scorer tiers marketplace pricing on it, so a regression to 0
// would silently mis-price every rig as bone-free.
const RIGGED = ['cesium-man.glb', 'fox.glb'];
const STATIC = ['mannequin.glb'];

describe('inspectModel counts.totalJoints (bone count)', () => {
	for (const name of RIGGED) {
		it.runIf(existsSync(avatar(name)))(`reports a positive bone count — ${name}`, async () => {
			const info = await inspectModel(new Uint8Array(readFileSync(avatar(name))));
			expect(info.counts.skins).toBeGreaterThan(0);
			expect(info.counts.totalJoints).toBeGreaterThan(0);
		});
	}

	for (const name of STATIC) {
		it.runIf(existsSync(avatar(name)))(`reports zero bones for a skin-less mesh — ${name}`, async () => {
			const info = await inspectModel(new Uint8Array(readFileSync(avatar(name))));
			expect(info.counts.skins).toBe(0);
			expect(info.counts.totalJoints).toBe(0);
		});
	}
});
