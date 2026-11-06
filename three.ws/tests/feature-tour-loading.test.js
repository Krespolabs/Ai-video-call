/**
 * Feature Tour loading state — unit tests.
 *
 * The director shows an honest "preparing" overlay while the curriculum manifest
 * and the guide GLB stream in (no fake progress bar), and clears it the moment
 * the real assets mount. These tests pin the lifecycle and the teardown invariant
 * a stuck overlay would otherwise violate:
 *   1. _showLoading() mounts a single, accessible (role=status / aria-live) overlay.
 *   2. _hideLoading() begins removing it.
 *   3. exit() never leaves a lingering overlay behind (the tour-exit failure mode).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { JSDOM } from 'jsdom';

let TourDirector;
let dom;

beforeAll(async () => {
	dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
	global.window = dom.window;
	global.document = dom.window.document;
	global.localStorage = dom.window.localStorage;
	global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
	global.cancelAnimationFrame = (id) => clearTimeout(id);
	// jsdom has no matchMedia; the director/guide read prefers-reduced-motion.
	global.matchMedia = (q) => ({
		matches: false, media: q,
		addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
	});
	dom.window.matchMedia = global.matchMedia;
	({ TourDirector } = await import('../src/feature-tour/director.js'));
});

afterEach(() => {
	// _hideLoading() detaches the overlay on a fade timer; isolate tests so a
	// still-fading element from one case can't be counted by the next.
	document.body.innerHTML = '';
});

afterAll(() => {
	delete global.window;
	delete global.document;
	delete global.localStorage;
	delete global.requestAnimationFrame;
	delete global.cancelAnimationFrame;
	delete global.matchMedia;
});

describe('feature tour loading state', () => {
	it('mounts a single, accessible loading overlay', () => {
		const d = new TourDirector();
		d._showLoading();
		const els = document.querySelectorAll('.tws-tour-loading');
		expect(els.length).toBe(1);
		const el = els[0];
		expect(el.getAttribute('role')).toBe('status');
		expect(el.getAttribute('aria-live')).toBe('polite');
		// Honest copy — no progress percentage / fake bar.
		expect(el.querySelector('.tws-tour-loading__label')?.textContent).toBeTruthy();
		expect(el.innerHTML).not.toMatch(/%/);
		d.exit();
	});

	it('does not duplicate the overlay when shown twice', () => {
		const d = new TourDirector();
		d._showLoading();
		d._showLoading();
		expect(document.querySelectorAll('.tws-tour-loading').length).toBe(1);
		d.exit();
	});

	it('_hideLoading() removes the visible (is-in) overlay', () => {
		const d = new TourDirector();
		d._showLoading();
		document.querySelector('.tws-tour-loading')?.classList.add('is-in');
		d._hideLoading();
		expect(document.querySelector('.tws-tour-loading.is-in')).toBeNull();
		d.exit();
	});

	it('exit() clears a lingering loading overlay (no stuck state)', () => {
		const d = new TourDirector();
		d._showLoading();
		expect(document.querySelectorAll('.tws-tour-loading').length).toBe(1);
		expect(() => d.exit()).not.toThrow();
		expect(document.querySelectorAll('.tws-tour-loading').length).toBe(0);
	});
});
