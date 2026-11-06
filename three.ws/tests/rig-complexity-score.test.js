import { describe, it, expect } from 'vitest';
import { computeComplexity } from '../api/_lib/x402/pipelines/rig-complexity.js';

// Build an inspect_model-shaped payload for the scorer.
const info = ({ joints = 0, vertices = 0, triangles = 0, skins = 0, meshes = 1, materials = 1, fileSize = 0, textures = [] }) => ({
	fileSize,
	counts: { totalJoints: joints, totalVertices: vertices, totalTriangles: triangles, skins, meshes, materials },
	textures,
});

describe('computeComplexity', () => {
	it('scores a lean web avatar as light with no warning', () => {
		const c = computeComplexity(info({
			joints: 30, vertices: 20_000, triangles: 30_000, skins: 1, fileSize: 2 * 1024 * 1024,
			textures: [{ byteSize: 1 * 1024 * 1024, width: 1024, height: 1024 }],
		}));
		expect(c.tier).toBe('light');
		expect(c.perf_warning).toBe(false);
		expect(c.bone_count).toBe(30);
		expect(c.complexity_score).toBeLessThan(25);
	});

	it('flags a heavy avatar with a performance warning', () => {
		const c = computeComplexity(info({
			joints: 200, vertices: 600_000, triangles: 1_200_000, skins: 2, fileSize: 60 * 1024 * 1024,
			textures: [{ byteSize: 30 * 1024 * 1024, width: 8192, height: 8192 }],
		}));
		expect(c.tier).toBe('extreme');
		expect(c.perf_warning).toBe(true);
		expect(c.max_texture_dim).toBe(8192);
		expect(c.complexity_score).toBeLessThanOrEqual(100);
	});

	it('raises perf_warning on a single hard-limit breach even when the blended score is low', () => {
		// Everything tiny except one 8K texture — the score stays low but the
		// max-dimension hard limit must still warn (mobile GPU killer).
		const c = computeComplexity(info({
			joints: 10, vertices: 5_000, triangles: 8_000, skins: 1, fileSize: 1024 * 1024,
			textures: [{ byteSize: 2 * 1024 * 1024, width: 8192, height: 8192 }],
		}));
		expect(c.complexity_score).toBeLessThan(50);
		expect(c.perf_warning).toBe(true);
	});

	it('is total-safe on an empty / malformed payload', () => {
		const c = computeComplexity({});
		expect(c.complexity_score).toBe(0);
		expect(c.tier).toBe('light');
		expect(c.perf_warning).toBe(false);
		expect(c.bone_count).toBe(0);
	});

	it('clamps the score to 0-100 and exposes a per-dimension breakdown', () => {
		const c = computeComplexity(info({ vertices: 10_000_000, triangles: 10_000_000, fileSize: 500 * 1024 * 1024 }));
		expect(c.complexity_score).toBeLessThanOrEqual(100);
		expect(c.complexity_score).toBeGreaterThan(0);
		expect(c.breakdown).toHaveProperty('vertices');
		expect(c.breakdown).toHaveProperty('textureBytes');
		expect(c.breakdown.vertices.ratio).toBeLessThanOrEqual(2);
	});

	it('falls back to the DB file size when inspect_model omits fileSize', () => {
		const c = computeComplexity(info({ vertices: 1000 }), { fileBytes: 40 * 1024 * 1024 });
		expect(c.file_bytes).toBe(40 * 1024 * 1024);
	});
});
