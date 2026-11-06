// Tests for the avatar snapshot capture module.
//
// The actual WebGL → JPEG pipeline can't be exercised in jsdom (no GPU, no
// real canvas), so this suite covers the contract surface: precondition
// validation, threshold constants, error propagation. The end-to-end render
// path is exercised by the customizer in a real browser.

import { describe, it, expect } from 'vitest';
import {
	captureSnapshotBlob,
	uploadAvatarSnapshot,
	SNAPSHOT_CONSTANTS,
} from '../src/voice/avatar-snapshot.js';

describe('captureSnapshotBlob — preconditions', () => {
	it('rejects when scene is missing', () => {
		expect(() => captureSnapshotBlob(null)).toThrow(/required/i);
		expect(() => captureSnapshotBlob({})).toThrow(/required/i);
		expect(() => captureSnapshotBlob({ renderer: {}, scene: {} })).toThrow(/required/i);
	});

	it('rejects when renderer.domElement is not a canvas', () => {
		const fakeScene = {
			renderer: {
				render: () => {},
				domElement: { /* no toBlob */ },
			},
			scene: {},
			camera: {},
		};
		expect(() => captureSnapshotBlob(fakeScene)).toThrow(/HTMLCanvasElement/);
	});

	it('rejects blank frames via the MIN_BYTES floor', async () => {
		const fakeScene = {
			renderer: {
				render: () => {},
				domElement: {
					toBlob: (cb) => cb(new Blob(['tiny'], { type: 'image/jpeg' })),
				},
			},
			scene: {},
			camera: {},
		};
		await expect(captureSnapshotBlob(fakeScene)).rejects.toThrow(/blank/i);
	});

	it('rejects oversize frames via the MAX_BYTES ceiling', async () => {
		const huge = new Uint8Array(SNAPSHOT_CONSTANTS.MAX_BYTES + 10);
		const fakeScene = {
			renderer: {
				render: () => {},
				domElement: {
					toBlob: (cb) => cb(new Blob([huge], { type: 'image/jpeg' })),
				},
			},
			scene: {},
			camera: {},
		};
		await expect(captureSnapshotBlob(fakeScene)).rejects.toThrow(/too large/i);
	});

	it('rejects when canvas.toBlob returns null', async () => {
		const fakeScene = {
			renderer: {
				render: () => {},
				domElement: {
					toBlob: (cb) => cb(null),
				},
			},
			scene: {},
			camera: {},
		};
		await expect(captureSnapshotBlob(fakeScene)).rejects.toThrow(/null/i);
	});

	it('forces a render call before reading the buffer', async () => {
		let rendered = false;
		const valid = new Uint8Array(SNAPSHOT_CONSTANTS.MIN_BYTES + 100);
		const fakeScene = {
			renderer: {
				render: () => { rendered = true; },
				domElement: {
					toBlob: (cb) => cb(new Blob([valid], { type: 'image/jpeg' })),
				},
			},
			scene: {},
			camera: {},
		};
		await captureSnapshotBlob(fakeScene);
		expect(rendered).toBe(true);
	});
});

describe('uploadAvatarSnapshot — preconditions', () => {
	it('rejects when avatarId is missing', async () => {
		await expect(uploadAvatarSnapshot({ scene: {} })).rejects.toThrow(/avatarId required/);
		await expect(uploadAvatarSnapshot({ avatarId: '', scene: {} })).rejects.toThrow(/avatarId required/);
	});
});

describe('SNAPSHOT_CONSTANTS', () => {
	it('exposes the three guardrails', () => {
		expect(SNAPSHOT_CONSTANTS.JPEG_QUALITY).toBeGreaterThan(0.5);
		expect(SNAPSHOT_CONSTANTS.JPEG_QUALITY).toBeLessThanOrEqual(1);
		expect(SNAPSHOT_CONSTANTS.MIN_BYTES).toBeGreaterThan(0);
		expect(SNAPSHOT_CONSTANTS.MAX_BYTES).toBeGreaterThan(SNAPSHOT_CONSTANTS.MIN_BYTES);
	});

	it('MAX_BYTES matches the server-side cap (2 MB)', () => {
		// thumbnailPresignSchema in api/avatars/_actions.js declares
		// size_bytes.max(2 * 1024 * 1024). Keep these in sync — a mismatch
		// produces confusing client-side success followed by server 400s.
		expect(SNAPSHOT_CONSTANTS.MAX_BYTES).toBe(2 * 1024 * 1024);
	});
});
