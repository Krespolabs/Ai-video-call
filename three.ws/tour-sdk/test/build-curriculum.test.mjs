// buildCurriculum — turning a pages document into a well-formed curriculum.

import { describe, it, expect } from 'vitest';
import { buildCurriculum } from '../src/build-curriculum.js';
import { buildPlaylist, trackMeta } from '../src/curriculum.js';

const pagesDoc = {
	sections: [
		{
			id: 'main',
			title: 'Overview',
			pages: [
				{ path: '/', title: 'Home', description: 'The front door.', added: '2024-01-01' },
				{ path: '/pricing', title: 'Pricing', description: 'Pricing — simple plans.', added: '2024-02-01' },
				{ path: '/login', title: 'Log in', description: 'Sign in.', auth: 'required' },
				{ path: '/secret', title: 'Secret', description: 'Hidden.' },
			],
		},
		{
			id: 'build',
			title: 'Build',
			pages: [
				{ path: '/studio', title: 'Studio', description: 'Build things.', added: '2024-03-01' },
				{ path: '/deploy', title: 'Deploy', description: 'Ship it.', added: '2024-01-15' },
			],
		},
		{ id: 'empty', title: 'Empty', pages: [] },
	],
};

describe('buildCurriculum', () => {
	const cur = buildCurriculum(pagesDoc, {
		sectionOrder: ['main', 'build'],
		sectionIntros: { main: 'Welcome.', build: 'Now the fun part.' },
		sectionHeroes: { main: ['/', '/pricing'] },
		targets: { '/': ['a.cta'] },
		deny: ['/secret'],
		quickPerSection: 1,
		title: 'Acme Tour',
	});

	it('produces a versioned, well-formed curriculum', () => {
		expect(cur.version).toBe(2);
		expect(cur.title).toBe('Acme Tour');
		expect(Array.isArray(cur.stops)).toBe(true);
		expect(cur.stopCount).toBe(cur.stops.length);
	});

	it('skips auth-required and denied pages', () => {
		const paths = cur.stops.map((s) => s.path);
		expect(paths).not.toContain('/login'); // auth: required
		expect(paths).not.toContain('/secret'); // denied
		expect(paths).toContain('/');
		expect(paths).toContain('/studio');
	});

	it('drops empty sections', () => {
		expect(cur.sections.map((s) => s.id)).toEqual(['main', 'build']);
	});

	it('orders heroes first, then remaining pages newest-first', () => {
		const buildStops = cur.stops.filter((s) => s.section === 'build').map((s) => s.path);
		// No heroes declared for build → newest (2024-03-01 studio) before older deploy.
		expect(buildStops).toEqual(['/studio', '/deploy']);
		const mainStops = cur.stops.filter((s) => s.section === 'main').map((s) => s.path);
		expect(mainStops[0]).toBe('/'); // hero order honoured
		expect(mainStops[1]).toBe('/pricing');
	});

	it('marks quickPerSection leading stops of each chapter as highlights', () => {
		// quickPerSection: 1 → exactly the first stop of each section.
		const highlights = cur.stops.filter((s) => s.highlight);
		expect(highlights.map((s) => s.path).sort()).toEqual(['/', '/studio']);
	});

	it('keeps track metadata consistent with the stops', () => {
		expect(trackMeta(cur, 'full').stopCount).toBe(cur.stops.length);
		expect(trackMeta(cur, 'quick').stopCount).toBe(cur.stops.filter((s) => s.highlight).length);
		expect(buildPlaylist(cur, 'quick')).toEqual(
			cur.stops.map((s, i) => (s.highlight ? i : -1)).filter((i) => i >= 0),
		);
	});

	it('attaches the section intro to the first stop of each chapter only', () => {
		const firstMain = cur.stops.find((s) => s.section === 'main');
		expect(firstMain.sectionIntro).toBe('Welcome.');
		const laterMain = cur.stops.filter((s) => s.section === 'main')[1];
		expect(laterMain.sectionIntro).toBeUndefined();
	});

	it('carries through per-path targets and synthesises narration', () => {
		const home = cur.stops.find((s) => s.path === '/');
		expect(home.targets).toEqual(['a.cta']);
		expect(home.narration).toContain('Home');
		// The leading "Pricing — " in the description isn't repeated after the title.
		const pricing = cur.stops.find((s) => s.path === '/pricing');
		expect(pricing.narration).not.toMatch(/Pricing\.\s*Pricing/);
	});

	it('handles an empty document without throwing', () => {
		const empty = buildCurriculum({ sections: [] });
		expect(empty.stops).toEqual([]);
		expect(empty.stopCount).toBe(0);
	});
});
