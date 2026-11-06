/**
 * Frame-data validation for /api/agent-screen-push.
 *
 * Screen frames are pushed by an agent's own worker and then rendered to every
 * watcher's <img>. A frame's data URL must therefore be a base64 RASTER image
 * only. SVG is rejected: it can carry scripts / external fetches that would run
 * the instant a frame were ever inline-rendered instead of set as an <img src>.
 * This pins the allow/deny contract so the validator can't loosen unnoticed.
 */

import { describe, it, expect } from 'vitest';
import { isRasterDataUrl } from '../api/agent-screen-push.js';

// A minimal-but-valid base64 tail for the shapes under test.
const B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgAB';

describe('isRasterDataUrl', () => {
	it('accepts png / jpeg / webp / gif raster data URLs', () => {
		expect(isRasterDataUrl(`data:image/png;base64,${B64}`)).toBe(true);
		expect(isRasterDataUrl(`data:image/jpeg;base64,${B64}`)).toBe(true);
		expect(isRasterDataUrl(`data:image/webp;base64,${B64}`)).toBe(true);
		expect(isRasterDataUrl(`data:image/gif;base64,${B64}`)).toBe(true);
	});

	it('rejects SVG data URLs (active-content vector)', () => {
		const svg = 'data:image/svg+xml;base64,' + Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
		).toString('base64');
		expect(isRasterDataUrl(svg)).toBe(false);
	});

	it('rejects non-image, non-base64, and non-string inputs', () => {
		expect(isRasterDataUrl('data:text/html;base64,' + B64)).toBe(false);
		expect(isRasterDataUrl('data:image/png,not-base64!!')).toBe(false);
		expect(isRasterDataUrl('https://evil.example/x.png')).toBe(false);
		expect(isRasterDataUrl('javascript:alert(1)')).toBe(false);
		expect(isRasterDataUrl(null)).toBe(false);
		expect(isRasterDataUrl(undefined)).toBe(false);
		expect(isRasterDataUrl(12345)).toBe(false);
	});
});
