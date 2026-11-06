/**
 * Tests for the GLB Size Optimizer autonomous pipeline (self/018).
 *
 * Two contracts are pinned here:
 *   1. projectOptimization() turns a model's *measured* stats into a grounded
 *      size + load-time projection — never NaN, never larger than the original,
 *      and zero-ish when the model is already compressed.
 *   2. The registry entry is wired correctly (enabled, self pipeline, 6h
 *      cooldown, run() present) so the autonomous loop will actually call it.
 */

import { describe, it, expect } from 'vitest';

import { projectOptimization } from '../api/_lib/x402/glb-size-optimizer.js';
import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';

describe('GLB Size Optimizer — projectOptimization', () => {
	it('projects a large win for a heavy, uncompressed model with 4K PNG textures', () => {
		const info = {
			fileSize: 12 * 1024 * 1024,
			counts: { totalVertices: 180_000, totalTriangles: 340_000, meshes: 4, materials: 3, textures: 2 },
			textures: [
				{ width: 4096, height: 4096, mimeType: 'image/png', byteSize: 5_000_000 },
				{ width: 4096, height: 4096, mimeType: 'image/png', byteSize: 4_000_000 },
			],
			extensionsUsed: [],
		};
		const p = projectOptimization(info, info.fileSize);
		expect(p.estimatedOptimizedBytes).toBeLessThan(p.fileSize);
		expect(p.estimatedSavingsBytes).toBe(p.fileSize - p.estimatedOptimizedBytes);
		expect(p.savingsPct).toBeGreaterThan(50);
		// Load-time delta tracks the byte delta exactly (same reference bandwidth).
		expect(p.loadAfterMs).toBeLessThan(p.loadBeforeMs);
		expect(p.alreadyCompressed).toBe(false);
	});

	it('projects near-zero savings for an already-Draco model with small textures', () => {
		const info = {
			fileSize: 6 * 1024 * 1024,
			counts: { totalVertices: 90_000, totalTriangles: 150_000, meshes: 2, materials: 2, textures: 1 },
			textures: [{ width: 1024, height: 1024, mimeType: 'image/jpeg', byteSize: 400_000 }],
			extensionsUsed: ['KHR_draco_mesh_compression'],
		};
		const p = projectOptimization(info, info.fileSize);
		expect(p.alreadyCompressed).toBe(true);
		expect(p.savingsPct).toBeLessThan(10);
		expect(p.estimatedOptimizedBytes).toBeLessThanOrEqual(p.fileSize);
	});

	it('never returns NaN or exceeds the original size on empty/degenerate input', () => {
		const p = projectOptimization({ fileSize: 0, counts: {}, textures: [], extensionsUsed: [] }, 0);
		expect(Number.isNaN(p.savingsPct)).toBe(false);
		expect(p.estimatedSavingsBytes).toBe(0);
		expect(p.estimatedOptimizedBytes).toBe(0);
		expect(p.loadBeforeMs).toBe(0);
	});

	it('never projects an optimized size below the 10% sanity floor', () => {
		const info = {
			fileSize: 20 * 1024 * 1024,
			counts: { totalVertices: 2_000_000, totalTriangles: 4_000_000, meshes: 1, materials: 1, textures: 1 },
			textures: [{ width: 8192, height: 8192, mimeType: 'image/png', byteSize: 18_000_000 }],
			extensionsUsed: [],
		};
		const p = projectOptimization(info, info.fileSize);
		expect(p.estimatedOptimizedBytes).toBeGreaterThanOrEqual(Math.round(p.fileSize * 0.10));
	});
});

describe('autonomous registry — glb-size-optimizer entry', () => {
	const entry = getSelfRegistry().find((e) => e.id === 'glb-size-optimizer');

	it('exists, enabled, self pipeline, POST /api/mcp, 6h cooldown, run() wired', () => {
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.method).toBe('POST');
		expect(entry.pipeline).toBe('self');
		expect(entry.cooldown_s).toBe(21_600);
		expect(entry.path).toBe('/api/mcp');
		expect(typeof entry.run).toBe('function');
	});
});
