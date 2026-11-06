import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { inspectGlb, glbJsonChunkEnd } from '../api/_lib/glb-inspect.js';

const avatar = (name) => resolve(process.cwd(), 'public/avatars', name);

// Real bundled GLBs: rigged humanoids + one static mesh.
const RIGGED = ['cesium-man.glb', 'fox.glb', 'realistic-female.glb'];
const STATIC = ['mannequin.glb'];

describe('inspectGlb allowPartial (ranged-read prefix)', () => {
	for (const name of [...RIGGED, ...STATIC]) {
		const path = avatar(name);
		const present = existsSync(path);
		it.runIf(present)(`prefix inspection matches full inspection — ${name}`, () => {
			const full = readFileSync(path);
			const fromFull = inspectGlb(full);
			expect(fromFull).toBeTruthy();

			// A prefix covering exactly the JSON chunk yields the same rig verdict,
			// even though declaredLen (the full file size) exceeds the prefix length.
			const end = glbJsonChunkEnd(full);
			expect(end).toBeGreaterThan(20);
			const prefix = full.subarray(0, end);
			const fromPrefix = inspectGlb(prefix, { allowPartial: true });
			expect(fromPrefix).toBeTruthy();
			expect(fromPrefix.isRigged).toBe(fromFull.isRigged);
			expect(fromPrefix.skeletonJointCount).toBe(fromFull.skeletonJointCount);

			expect(fromFull.isRigged).toBe(RIGGED.includes(name));
		});
	}

	it.runIf(existsSync(avatar('cesium-man.glb')))(
		'a prefix too short to cover the JSON chunk returns null (refetch signal)',
		() => {
			const full = readFileSync(avatar('cesium-man.glb'));
			const tiny = full.subarray(0, 16);
			expect(inspectGlb(tiny, { allowPartial: true })).toBeNull();
			// …and a small (≥20-byte) header prefix is enough for glbJsonChunkEnd to
			// report how many bytes to refetch — it only reads the chunk-length field.
			const headerOnly = full.subarray(0, 64);
			expect(glbJsonChunkEnd(headerOnly)).toBe(glbJsonChunkEnd(full));
		},
	);

	it('full-buffer mode still rejects a truncated buffer (declaredLen > length)', () => {
		const path = avatar('fox.glb');
		if (!existsSync(path)) return;
		const full = readFileSync(path);
		const truncated = full.subarray(0, glbJsonChunkEnd(full)); // missing BIN chunk
		// Without allowPartial the declaredLen consistency check rejects it.
		expect(inspectGlb(truncated)).toBeNull();
		// With allowPartial it parses fine.
		expect(inspectGlb(truncated, { allowPartial: true })).toBeTruthy();
	});
});
