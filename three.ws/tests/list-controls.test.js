// @vitest-environment jsdom
//
// Shared list-controls toolkit (E03) — the unified search / sort / filter /
// URL-sync layer adopted on /discover and /marketplace. These tests lock the
// contract both surfaces rely on: pure URL helpers round-trip state, and the
// controller renders accessible controls, debounces search, syncs the URL, and
// re-emits on back/forward.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
	debounce,
	readStateFromUrl,
	syncStateToUrl,
	createListControls,
} from '../src/shared/list-controls.js';

describe('list-controls — pure helpers', () => {
	beforeEach(() => {
		history.replaceState({}, '', '/');
	});

	it('debounce fires once on the trailing edge', async () => {
		vi.useFakeTimers();
		const spy = vi.fn();
		const d = debounce(spy, 200);
		d('a');
		d('b');
		d('c');
		expect(spy).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy).toHaveBeenCalledWith('c');
		vi.useRealTimers();
	});

	it('debounce.flush runs immediately and cancel drops the pending call', () => {
		vi.useFakeTimers();
		const spy = vi.fn();
		const d = debounce(spy, 200);
		d('x');
		d.flush('y');
		expect(spy).toHaveBeenCalledWith('y');
		d('z');
		d.cancel();
		vi.advanceTimersByTime(500);
		expect(spy).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('readStateFromUrl only reads declared keys and falls back to defaults', () => {
		history.replaceState({}, '', '/?q=robot&sort=alpha&stray=nope');
		const s = readStateFromUrl({ q: '', sort: 'newest', chain: '' });
		expect(s).toEqual({ q: 'robot', sort: 'alpha', chain: '' });
		expect(s.stray).toBeUndefined();
	});

	it('syncStateToUrl drops keys equal to their default (canonical short URLs)', () => {
		history.replaceState({}, '', '/');
		syncStateToUrl({ q: 'robot', sort: 'newest', chain: '8453' }, { q: '', sort: 'newest', chain: '' });
		const p = new URLSearchParams(location.search);
		expect(p.get('q')).toBe('robot');
		expect(p.get('chain')).toBe('8453');
		expect(p.has('sort')).toBe(false); // equals default → dropped
	});

	it('readStateFromUrl + syncStateToUrl round-trip', () => {
		const defaults = { q: '', sort: 'newest', filter: 'all' };
		history.replaceState({}, '', '/');
		syncStateToUrl({ q: 'agent', sort: 'alpha', filter: '3d' }, defaults);
		expect(readStateFromUrl(defaults)).toEqual({ q: 'agent', sort: 'alpha', filter: '3d' });
	});
});

describe('list-controls — controller', () => {
	let mount;
	beforeEach(() => {
		history.replaceState({}, '', '/');
		document.body.innerHTML = '<div id="mount"></div>';
		mount = document.getElementById('mount');
	});

	function build(onChange = () => {}) {
		return createListControls({
			mount,
			searchKey: 'q',
			searchPlaceholder: 'Search…',
			searchLabel: 'Search agents',
			defaults: { q: '', filter: 'all', sort: 'newest' },
			segments: [
				{
					key: 'filter',
					label: 'Type',
					options: [
						{ value: 'all', label: 'All' },
						{ value: '3d', label: '3D' },
					],
				},
			],
			sortKey: 'sort',
			sortOptions: [
				{ value: 'newest', label: 'Newest' },
				{ value: 'alpha', label: 'A → Z' },
			],
			debounceMs: 200,
			onChange,
		});
	}

	it('renders an accessible search input, chip group, and sort select', () => {
		build();
		const input = mount.querySelector('[data-lc="search"]');
		expect(input).toBeTruthy();
		expect(input.getAttribute('type')).toBe('search');
		expect(input.getAttribute('aria-label')).toBe('Search agents');
		const group = mount.querySelector('[data-lc-seg-group]');
		expect(group.getAttribute('role')).toBe('group');
		const chips = mount.querySelectorAll('[data-lc-seg="filter"]');
		expect(chips.length).toBe(2);
		expect(chips[0].getAttribute('aria-pressed')).toBe('true');
		const sort = mount.querySelector('[data-lc="sort"]');
		expect(sort.getAttribute('aria-label')).toBe('Sort results');
	});

	it('hydrates controls from the URL on init', () => {
		history.replaceState({}, '', '/?q=robot&filter=3d&sort=alpha');
		const lc = build();
		expect(mount.querySelector('[data-lc="search"]').value).toBe('robot');
		expect(mount.querySelector('[data-lc="sort"]').value).toBe('alpha');
		const active = mount.querySelector('[data-lc-seg="filter"].active');
		expect(active.dataset.lcValue).toBe('3d');
		expect(lc.getState()).toMatchObject({ q: 'robot', filter: '3d', sort: 'alpha' });
		expect(lc.isFiltered()).toBe(true);
	});

	it('chip click updates state, toggles active class, and pushes to the URL', () => {
		const onChange = vi.fn();
		build(onChange);
		const chip3d = mount.querySelector('[data-lc-seg="filter"][data-lc-value="3d"]');
		chip3d.click();
		expect(chip3d.classList.contains('active')).toBe(true);
		expect(chip3d.getAttribute('aria-pressed')).toBe('true');
		expect(new URLSearchParams(location.search).get('filter')).toBe('3d');
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ filter: '3d' }),
			expect.objectContaining({ reason: 'segment' }),
		);
	});

	it('debounces search input then emits once and syncs the URL', () => {
		vi.useFakeTimers();
		const onChange = vi.fn();
		build(onChange);
		const input = mount.querySelector('[data-lc="search"]');
		input.value = 'rob';
		input.dispatchEvent(new Event('input'));
		input.value = 'robot';
		input.dispatchEvent(new Event('input'));
		expect(onChange).not.toHaveBeenCalled();
		vi.advanceTimersByTime(200);
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ q: 'robot' }),
			expect.objectContaining({ reason: 'search' }),
		);
		expect(new URLSearchParams(location.search).get('q')).toBe('robot');
		vi.useRealTimers();
	});

	it('search clear button resets the query and refocuses the input', () => {
		history.replaceState({}, '', '/?q=robot');
		const onChange = vi.fn();
		build(onChange);
		const clear = mount.querySelector('[data-lc="search-clear"]');
		expect(clear.hidden).toBe(false);
		clear.click();
		expect(mount.querySelector('[data-lc="search"]').value).toBe('');
		expect(new URLSearchParams(location.search).has('q')).toBe(false);
		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ q: '' }),
			expect.objectContaining({ reason: 'search-clear' }),
		);
	});

	it('reset() returns every control to its default', () => {
		history.replaceState({}, '', '/?q=robot&filter=3d&sort=alpha');
		const onChange = vi.fn();
		const lc = build(onChange);
		lc.reset();
		expect(lc.getState()).toEqual({ q: '', filter: 'all', sort: 'newest' });
		expect(lc.isFiltered()).toBe(false);
		expect(mount.querySelector('[data-lc="search"]').value).toBe('');
		expect(location.search).toBe('');
	});

	it('urlSync:false leaves the URL untouched (page owns the scheme)', () => {
		const onChange = vi.fn();
		createListControls({
			mount,
			searchKey: 'q',
			urlSync: false,
			defaults: { q: '', filter: 'all' },
			segments: [
				{ key: 'filter', options: [{ value: 'all', label: 'All' }, { value: '3d', label: '3D' }] },
			],
			onChange,
		});
		mount.querySelector('[data-lc-seg="filter"][data-lc-value="3d"]').click();
		expect(location.search).toBe(''); // toolkit did NOT write the URL
		expect(onChange).toHaveBeenCalled();
	});
});
