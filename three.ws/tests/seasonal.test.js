// @vitest-environment jsdom
//
// Seasonal decorations (public/seasonal.js) — DOM contract + date gate.
//
// seasonal.js is a self-contained IIFE that runs on load and is gated to
// July 1–5. These tests pin the contracts the rest of the platform leans on:
//   1. Outside the window it injects NOTHING — no dead controls ship.
//   2. Inside the window it injects the ribbon; with a `.hero` present it also
//      builds the fireworks canvas and the chip row controls.
//   3. The 🎆 chip carries data-anim="torch-light" and is a real <button>, so
//      home.html's own delegated chip handler plays the avatar's torch clip.
//   4. The 🔊 mute toggle persists to localStorage and reflects its state.
//   5. Re-running is idempotent (the guard prevents double-injection).
//
// The browser APIs seasonal.js touches (rAF, Resize/Intersection observers,
// canvas 2D, matchMedia, AudioContext) are stubbed to no-ops — these tests
// assert wiring, not rendering. The animation loop never advances (rAF is a
// no-op) so no frame/burst/audio code runs.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(resolve(__dirname, '../public/seasonal.js'), 'utf8');

// Execute the IIFE fresh against the current jsdom document.
function runSeasonal() { new Function(SRC)(); }

// July 4 2026 by default; pass a Date to move the clock (month is 0-indexed).
function setClock(date) { vi.setSystemTime(date); }

function makeMatchMedia({ reducedMotion = false } = {}) {
	return (query) => ({
		matches: reducedMotion && /reduced-motion/.test(query),
		media: query,
		onchange: null,
		addEventListener() {}, removeEventListener() {},
		addListener() {}, removeListener() {},
		dispatchEvent() { return false; },
	});
}

function stub2DContext() {
	const noop = () => {};
	const ctx = {
		setTransform: noop, clearRect: noop, fillRect: noop, beginPath: noop,
		moveTo: noop, lineTo: noop, stroke: noop, arc: noop, fill: noop,
		createRadialGradient: () => ({ addColorStop: noop }),
		fillStyle: '', strokeStyle: '', globalAlpha: 1, lineWidth: 1,
		lineCap: 'butt', globalCompositeOperation: 'source-over',
	};
	HTMLCanvasElement.prototype.getContext = () => ctx;
}

class FakeObserver {
	observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
}

class FakeAudioContext {
	constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.sampleRate = 44100; }
	createBuffer(_c, len) { return { getChannelData: () => new Float32Array(len) }; }
	createBufferSource() { return { buffer: null, connect() {}, start() {} }; }
	createBiquadFilter() { return { type: '', frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
	createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
	resume() {} close() {}
}

function buildDom({ hero = true, chipRow = true } = {}) {
	document.documentElement.removeAttribute('data-theme');
	document.head.innerHTML = '';
	document.body.innerHTML = '';
	if (hero) {
		const h = document.createElement('div');
		h.className = 'hero';
		document.body.appendChild(h);
		if (chipRow) {
			const row = document.createElement('div');
			row.id = 'hero-chips';
			h.appendChild(row);
		}
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['Date'] });
	setClock(new Date(2026, 6, 4, 12)); // July 4
	window.requestAnimationFrame = () => 0;
	window.cancelAnimationFrame = () => {};
	window.ResizeObserver = FakeObserver;
	window.IntersectionObserver = FakeObserver;
	window.AudioContext = FakeAudioContext;
	window.matchMedia = makeMatchMedia();
	stub2DContext();
	try { localStorage.removeItem('threews-fireworks-sound'); } catch (_) { /* ignore */ }
	buildDom();
});

afterEach(() => {
	vi.useRealTimers();
	document.head.innerHTML = '';
	document.body.innerHTML = '';
});

describe('date gate', () => {
	it('injects nothing outside July 1–5', () => {
		setClock(new Date(2025, 11, 25)); // Dec 25
		runSeasonal();
		expect(document.getElementById('seasonal-ribbon')).toBeNull();
		expect(document.querySelector('.seasonal-fireworks')).toBeNull();
		expect(document.querySelector('.hero-chip--fireworks')).toBeNull();
	});

	it('is a no-op on July 6 (just past the window)', () => {
		setClock(new Date(2026, 6, 6));
		runSeasonal();
		expect(document.getElementById('seasonal-ribbon')).toBeNull();
	});

	it('is active on July 1 and July 5 (window edges)', () => {
		setClock(new Date(2026, 6, 1));
		runSeasonal();
		expect(document.getElementById('seasonal-ribbon')).not.toBeNull();

		buildDom();
		setClock(new Date(2026, 6, 5, 23));
		runSeasonal();
		expect(document.getElementById('seasonal-ribbon')).not.toBeNull();
	});
});

describe('in-window injection', () => {
	it('builds the ribbon, the fireworks canvas, and the chip', () => {
		runSeasonal();
		expect(document.getElementById('seasonal-ribbon')).not.toBeNull();
		const canvas = document.querySelector('.seasonal-fireworks canvas');
		expect(canvas).not.toBeNull();
		expect(document.querySelector('.hero-chip--fireworks')).not.toBeNull();
	});

	it('the 🎆 chip is a real button wired to the torch-light avatar clip', () => {
		runSeasonal();
		const chip = document.querySelector('#hero-chips .hero-chip--fireworks[data-anim="torch-light"]');
		expect(chip).not.toBeNull();
		expect(chip.tagName).toBe('BUTTON');
		expect(chip.textContent).toContain('Fireworks');
		expect(chip.getAttribute('aria-label')).toBeTruthy();
	});

	it('still injects the ribbon but no fireworks when there is no .hero', () => {
		buildDom({ hero: false });
		runSeasonal();
		expect(document.getElementById('seasonal-ribbon')).not.toBeNull();
		expect(document.querySelector('.seasonal-fireworks')).toBeNull();
		expect(document.querySelector('.hero-chip--fireworks')).toBeNull();
	});

	it('re-running does not double-inject (idempotent guard)', () => {
		runSeasonal();
		runSeasonal();
		expect(document.querySelectorAll('#seasonal-ribbon').length).toBe(1);
		expect(document.querySelectorAll('.seasonal-fireworks').length).toBe(1);
		expect(document.querySelectorAll('[data-anim="torch-light"]').length).toBe(1);
	});
});

describe('reduced motion', () => {
	it('shows the ribbon and keeps the controls (gestures still allowed)', () => {
		window.matchMedia = makeMatchMedia({ reducedMotion: true });
		runSeasonal();
		// Ribbon always shows; the canvas + chip remain so an explicit click can
		// still fire — only the ambient auto-launch is suppressed.
		expect(document.getElementById('seasonal-ribbon')).not.toBeNull();
		expect(document.querySelector('.seasonal-fireworks')).not.toBeNull();
		expect(document.querySelector('.hero-chip--fireworks')).not.toBeNull();
	});
});

describe('sound mute toggle', () => {
	it('persists the muted state and reflects it in the button', () => {
		runSeasonal();
		const mute = document.querySelector('#hero-chips button[aria-pressed]');
		expect(mute).not.toBeNull();
		expect(mute.getAttribute('aria-pressed')).toBe('true'); // sound on by default
		expect(mute.textContent).toBe('🔊');

		mute.click();
		expect(localStorage.getItem('threews-fireworks-sound')).toBe('off');
		expect(mute.getAttribute('aria-pressed')).toBe('false');
		expect(mute.textContent).toBe('🔇');

		mute.click();
		expect(localStorage.getItem('threews-fireworks-sound')).toBe('on');
		expect(mute.textContent).toBe('🔊');
	});

	it('starts muted when localStorage says off', () => {
		localStorage.setItem('threews-fireworks-sound', 'off');
		runSeasonal();
		const mute = document.querySelector('#hero-chips button[aria-pressed]');
		expect(mute.getAttribute('aria-pressed')).toBe('false');
		expect(mute.textContent).toBe('🔇');
	});
});
