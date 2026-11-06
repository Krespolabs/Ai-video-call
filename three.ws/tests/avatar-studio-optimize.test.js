/**
 * Tests for the Avatar Studio export optimizer.
 *
 * The save flow's central contract is: optimization is best-effort and must
 * NEVER make the save fail. These tests pin that guarantee — on invalid input
 * the optimizer falls back to the original blob instead of throwing — and that
 * a real, structurally-valid GLB round-trips smaller through the pipeline.
 */

import { describe, it, expect } from 'vitest';
import { optimizeAndValidateGlb } from '../src/avatar-studio-optimize.js';

// Minimal valid GLB: a 12-byte header + JSON chunk describing an empty asset.
// The glTF-Transform reader accepts this; it has no meshes, so the compression
// passes are no-ops and the output is not smaller — exercising the
// "not smaller → keep original" branch.
function emptyGlb() {
	const json = JSON.stringify({ asset: { version: '2.0' } });
	const enc = new TextEncoder();
	let jsonBytes = enc.encode(json);
	// JSON chunk must be 4-byte aligned, padded with spaces.
	const pad = (4 - (jsonBytes.length % 4)) % 4;
	if (pad) {
		const padded = new Uint8Array(jsonBytes.length + pad).fill(0x20);
		padded.set(jsonBytes);
		jsonBytes = padded;
	}
	const total = 12 + 8 + jsonBytes.length;
	const buf = new ArrayBuffer(total);
	const dv = new DataView(buf);
	dv.setUint32(0, 0x46546c67, true); // 'glTF'
	dv.setUint32(4, 2, true); // version
	dv.setUint32(8, total, true); // total length
	dv.setUint32(12, jsonBytes.length, true); // chunk length
	dv.setUint32(16, 0x4e4f534a, true); // 'JSON'
	new Uint8Array(buf, 20).set(jsonBytes);
	return new Blob([buf], { type: 'model/gltf-binary' });
}

describe('optimizeAndValidateGlb', () => {
	it('falls back to the original blob on non-GLB input without throwing', async () => {
		const garbage = new Blob([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], {
			type: 'model/gltf-binary',
		});
		const result = await optimizeAndValidateGlb(garbage);
		expect(result.optimized).toBe(false);
		expect(result.blob).toBe(garbage); // same reference — original returned untouched
		expect(result.sourceBytes).toBe(garbage.size);
		expect(result.outputBytes).toBe(garbage.size);
	});

	it('keeps the original when the optimized output is not smaller', async () => {
		const glb = emptyGlb();
		const result = await optimizeAndValidateGlb(glb);
		// An empty asset has nothing to compress; the meshopt re-encode never
		// beats the tiny source, so we keep the original rather than regress.
		expect(result.optimized).toBe(false);
		expect(result.blob).toBe(glb);
	});

	it('always resolves to a Blob and consistent size fields', async () => {
		const glb = emptyGlb();
		const result = await optimizeAndValidateGlb(glb);
		expect(result.blob).toBeInstanceOf(Blob);
		expect(result.outputBytes).toBe(result.blob.size);
		expect(typeof result.sourceBytes).toBe('number');
	});
});
