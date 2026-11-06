// Target resolution — the graceful-fallback chain a curriculum's `targets`
// selectors rely on: primary → secondary → the built-in page heading/CTA
// fallback → null. Pinned here because a partner preset (e.g. the Sperax
// template in the Tour Builder) ships selector chains authored against a real
// third-party site, where a stop's primary or even secondary selector can
// legitimately miss (a re-theme, an A/B test, a selector typo) — a stop must
// never hard-fail when that happens; it should just skip the spotlight and
// keep narrating.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { TourDirector } from '../src/director.js';

let dom;

beforeAll(() => {
	dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' });
	global.window = dom.window;
	global.document = dom.window.document;
	global.localStorage = dom.window.localStorage;
	global.sessionStorage = dom.window.sessionStorage;
	global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
	global.matchMedia = () => ({ matches: false });
	dom.window.matchMedia = global.matchMedia;
});

afterAll(() => {
	delete global.window;
	delete global.document;
	delete global.localStorage;
	delete global.sessionStorage;
	delete global.getComputedStyle;
	delete global.matchMedia;
});

beforeEach(() => {
	document.body.innerHTML = '';
});

// jsdom never runs real layout, so every element's getBoundingClientRect() is
// zero-sized by default (and isVisible() in director.js requires width/height
// >= 4). Stamp a visible rect on the elements a test wants "on screen" — the
// selector-fallback logic under test, not layout.
function makeVisible(el) {
	el.getBoundingClientRect = () => ({ width: 100, height: 40, top: 0, left: 0, right: 100, bottom: 40 });
	// jsdom's getComputedStyle() returns '' (not the browser's initial "1") for
	// opacity when nothing set it explicitly, and isVisible() in director.js
	// requires Number(opacity) > 0.05 — so pin it explicitly for anything this
	// test wants treated as on-screen.
	el.style.opacity = '1';
	return el;
}

function director() {
	return new TourDirector({ curriculum: { stops: [] } });
}

describe('TourDirector._resolveTarget', () => {
	it('resolves the primary selector when it matches a visible element', () => {
		document.body.innerHTML = '<div id="secondary"></div><div id="primary"></div>';
		makeVisible(document.getElementById('primary'));
		makeVisible(document.getElementById('secondary'));
		const el = director()._resolveTarget({ targets: ['#primary', '#secondary'] });
		expect(el.id).toBe('primary');
	});

	it('falls through to the secondary selector when the primary is absent', () => {
		document.body.innerHTML = '<div id="secondary"></div>';
		makeVisible(document.getElementById('secondary'));
		const el = director()._resolveTarget({ targets: ['#missing-primary', '#secondary'] });
		expect(el.id).toBe('secondary');
	});

	it('falls through to the page heading when neither stop selector matches', () => {
		document.body.innerHTML = '<h1>Fallback heading</h1>';
		makeVisible(document.querySelector('h1'));
		const el = director()._resolveTarget({ targets: ['#nope-primary', '#nope-secondary'] });
		expect(el.tagName).toBe('H1');
	});

	it('never throws, and returns null, when nothing on the page matches at all', () => {
		// No heading, no CTA, no [data-tour-target] — the true "hard miss" case a
		// partner preset's selector chain can hit on a page it wasn't tested
		// against (a re-theme, an A/B test, a renamed section).
		document.body.innerHTML = '<p>No headings, no CTAs, no matching selectors here.</p>';
		const d = director();
		const stop = { targets: ['#nope-primary', '#nope-secondary'] };
		expect(() => d._resolveTarget(stop)).not.toThrow();
		expect(d._resolveTarget(stop)).toBeNull();
	});

	it('skips an invalid selector in the chain instead of throwing', () => {
		document.body.innerHTML = '<div id="ok"></div>';
		makeVisible(document.getElementById('ok'));
		const el = director()._resolveTarget({ targets: [':::not-a-selector', '#ok'] });
		expect(el.id).toBe('ok');
	});

	it('ignores a matching but invisible (zero-size) element and keeps looking', () => {
		// Unmocked rect stays zero-size — isVisible() must reject it, not crash.
		document.body.innerHTML = '<div id="hidden-match"></div><div id="visible-fallback"></div>';
		makeVisible(document.getElementById('visible-fallback'));
		const el = director()._resolveTarget({ targets: ['#hidden-match', '#visible-fallback'] });
		expect(el.id).toBe('visible-fallback');
	});

	it('honours a page-authored [data-tour-target] ahead of the generic heading/CTA fallback', () => {
		document.body.innerHTML = '<h1>Heading</h1><div data-tour-target id="marked"></div>';
		makeVisible(document.querySelector('h1'));
		makeVisible(document.getElementById('marked'));
		const el = director()._resolveTarget({ targets: ['#nope'] });
		expect(el.id).toBe('marked');
	});
});
