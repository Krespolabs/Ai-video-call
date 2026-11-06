// Pure curriculum helpers + playlist invariants — the same guarantees the
// runtime relies on, independent of the DOM.

import { describe, it, expect } from 'vitest';
import {
	buildPlaylist,
	trackMeta,
	stopIndexForPath,
	sectionTitle,
	normalizePath,
} from '../src/curriculum.js';

const curriculum = {
	tracks: [
		{ id: 'full', title: 'Full tour', stopCount: 4 },
		{ id: 'quick', title: 'Quick highlights', stopCount: 2 },
	],
	sections: [
		{ id: 'main', title: 'Overview' },
		{ id: 'build', title: 'Build' },
	],
	stops: [
		{ path: '/', section: 'main', title: 'Home', highlight: true },
		{ path: '/pricing', section: 'main', title: 'Pricing', highlight: false },
		{ path: '/studio', section: 'build', title: 'Studio', highlight: true },
		{ path: '/deploy', section: 'build', title: 'Deploy', highlight: false },
	],
};

describe('buildPlaylist', () => {
	it('returns every stop index for the full track', () => {
		expect(buildPlaylist(curriculum, 'full')).toEqual([0, 1, 2, 3]);
	});

	it('returns only highlighted indices for the quick track, in order', () => {
		const quick = buildPlaylist(curriculum, 'quick');
		expect(quick).toEqual([0, 2]);
		expect(quick.every((i) => curriculum.stops[i].highlight)).toBe(true);
	});

	it('defaults to the full track for an unknown / missing track id', () => {
		expect(buildPlaylist(curriculum, 'nope')).toHaveLength(4);
		expect(buildPlaylist(curriculum)).toHaveLength(4);
	});

	it('falls back to the full list when no stops are highlighted', () => {
		const flat = { stops: [{ highlight: false }, { highlight: false }] };
		expect(buildPlaylist(flat, 'quick')).toEqual([0, 1]);
	});
});

describe('trackMeta', () => {
	it('finds a declared track', () => {
		expect(trackMeta(curriculum, 'quick').stopCount).toBe(2);
	});
	it('returns null for an unknown track', () => {
		expect(trackMeta(curriculum, 'nope')).toBeNull();
		expect(trackMeta({}, 'full')).toBeNull();
	});
});

describe('stopIndexForPath', () => {
	it('matches a stop by normalized path', () => {
		expect(stopIndexForPath(curriculum, '/studio')).toBe(2);
		expect(stopIndexForPath(curriculum, '/studio/')).toBe(2); // trailing slash
		expect(stopIndexForPath(curriculum, '/missing')).toBe(-1);
	});
});

describe('sectionTitle', () => {
	it('resolves a section id to its title', () => {
		expect(sectionTitle(curriculum, 'build')).toBe('Build');
		expect(sectionTitle(curriculum, 'nope')).toBe('');
		expect(sectionTitle({}, 'main')).toBe('');
	});
});

describe('normalizePath', () => {
	it('keeps root as "/" and strips trailing slashes elsewhere', () => {
		expect(normalizePath('/')).toBe('/');
		expect(normalizePath('/a/b/')).toBe('/a/b');
		expect(normalizePath('')).toBe('/');
	});
});
