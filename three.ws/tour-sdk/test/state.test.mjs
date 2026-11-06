// Cross-page tour state + inline curriculum loading + the free-roam activation
// guard — the DOM-touching surfaces, exercised under jsdom.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { JSDOM } from 'jsdom';
import { createTourState, loadCurriculum } from '../src/curriculum.js';
import { resolveTourConfig } from '../src/config.js';

let dom;

beforeAll(() => {
	dom = new JSDOM('<!doctype html><body></body>', { url: 'https://example.test/' });
	global.window = dom.window;
	global.document = dom.window.document;
	global.localStorage = dom.window.localStorage;
	global.sessionStorage = dom.window.sessionStorage;
	global.matchMedia = () => ({ matches: false });
	dom.window.matchMedia = global.matchMedia;
});

afterAll(() => {
	delete global.window;
	delete global.document;
	delete global.localStorage;
	delete global.sessionStorage;
	delete global.matchMedia;
});

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
});

describe('createTourState', () => {
	const config = resolveTourConfig({ storagePrefix: 'acme:tour', defaultVoice: 'fable' });
	const state = createTourState(config);

	it('returns defaults (with the configured voice) when nothing is stored', () => {
		const s = state.readState();
		expect(s.active).toBe(false);
		expect(s.voice).toBe('fable');
		expect(s.index).toBe(0);
	});

	it('round-trips live state through sessionStorage under the prefixed key', () => {
		state.writeState({ active: true, index: 3, track: 'quick' });
		expect(state.readState().index).toBe(3);
		expect(sessionStorage.getItem('acme:tour:state')).toContain('"index":3');
	});

	it('mirrors durable progress to localStorage only while active', () => {
		state.writeState({ active: true, index: 5, track: 'full', voice: 'echo', speed: 1.25 });
		const resume = state.readResume();
		expect(resume.index).toBe(5);
		expect(resume.voice).toBe('echo');
		expect(resume.speed).toBe(1.25);
		expect(localStorage.getItem('acme:tour:resume')).toBeTruthy();
	});

	it('clearState wipes live state but leaves durable resume', () => {
		state.writeState({ active: true, index: 7 });
		state.clearState();
		expect(state.readState().active).toBe(false);
		expect(state.readResume().index).toBe(7); // durable memory survives
	});

	it('markCompleted records completion and resets the resume index', () => {
		state.writeState({ active: true, index: 9 });
		state.markCompleted();
		const resume = state.readResume();
		expect(resume.completed).toBe(true);
		expect(resume.index).toBe(0);
	});

	it('isolates two tours with different prefixes', () => {
		const a = createTourState(resolveTourConfig({ storagePrefix: 'a' }));
		const b = createTourState(resolveTourConfig({ storagePrefix: 'b' }));
		a.writeState({ active: true, index: 1 });
		b.writeState({ active: true, index: 2 });
		expect(a.readState().index).toBe(1);
		expect(b.readState().index).toBe(2);
	});
});

describe('loadCurriculum', () => {
	it('uses an inline curriculum object as-is', async () => {
		const inline = { stops: [{ path: '/', narration: 'hi' }] };
		const cur = await loadCurriculum(resolveTourConfig({ curriculum: inline }));
		expect(cur).toBe(inline);
	});

	it('rejects an empty inline curriculum', async () => {
		await expect(loadCurriculum(resolveTourConfig({ curriculum: { stops: [] } }))).rejects.toThrow(
			/empty/,
		);
	});
});

describe('free-roam activation guard', () => {
	let isInteractiveTarget;

	beforeAll(async () => {
		({ isInteractiveTarget } = await import('../src/free-roam.js'));
	});

	function make(html) {
		document.body.innerHTML = html;
		return document.body.firstElementChild;
	}

	it('treats links, buttons, inputs and canvases as page interactions', () => {
		expect(isInteractiveTarget(make('<a href="/x">x</a>'))).toBe(true);
		expect(isInteractiveTarget(make('<button>x</button>'))).toBe(true);
		expect(isInteractiveTarget(make('<input>'))).toBe(true);
		expect(isInteractiveTarget(make('<canvas></canvas>'))).toBe(true);
		expect(isInteractiveTarget(make('<div data-walk-block>x</div>'))).toBe(true);
	});

	it('counts a child of an interactive element as interactive', () => {
		const a = make('<a href="/x"><span>deep</span></a>');
		expect(isInteractiveTarget(a.querySelector('span'))).toBe(true);
	});

	it('treats plain empty space as walkable (not interactive)', () => {
		expect(isInteractiveTarget(make('<div><p>just text</p></div>'))).toBe(false);
		expect(isInteractiveTarget(null)).toBe(false);
	});
});
