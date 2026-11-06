// The thumbnail endpoint must reject degenerate (1px / blank) PNG posters so the
// gallery never publishes an empty thumbnail. readPngSize parses the IHDR chunk;
// these tests lock its behavior on well-formed and malformed inputs.

import { describe, it, expect } from 'vitest';
import { readPngSize } from '../../api/avatars/thumbnail.js';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Build a minimal PNG: signature + IHDR(length=13, type, width, height, …).
function pngWith(width, height) {
	const ihdr = Buffer.alloc(25); // 4 len + 4 type + 13 data
	ihdr.writeUInt32BE(13, 0);
	ihdr.write('IHDR', 4, 'ascii');
	ihdr.writeUInt32BE(width, 8);
	ihdr.writeUInt32BE(height, 12);
	return Buffer.concat([PNG_SIG, ihdr]);
}

describe('readPngSize', () => {
	it('parses width/height from a valid IHDR', () => {
		expect(readPngSize(pngWith(512, 512))).toEqual({ width: 512, height: 512 });
		expect(readPngSize(pngWith(64, 96))).toEqual({ width: 64, height: 96 });
	});

	it('reads a degenerate 1×1 poster as 1×1 (so the handler can reject it)', () => {
		expect(readPngSize(pngWith(1, 1))).toEqual({ width: 1, height: 1 });
	});

	it('returns null for non-PNG, truncated, or non-IHDR buffers', () => {
		expect(readPngSize(Buffer.alloc(4))).toBeNull();
		expect(readPngSize(Buffer.concat([PNG_SIG, Buffer.alloc(4)]))).toBeNull();
		const wrongChunk = Buffer.concat([PNG_SIG, Buffer.alloc(25)]); // zero-filled → not "IHDR"
		expect(readPngSize(wrongChunk)).toBeNull();
		expect(readPngSize('not a buffer')).toBeNull();
	});

	it('returns null when a dimension is zero', () => {
		expect(readPngSize(pngWith(0, 512))).toBeNull();
		expect(readPngSize(pngWith(512, 0))).toBeNull();
	});
});
