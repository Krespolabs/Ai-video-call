// @vitest-environment jsdom
//
// async-state boundary contract — the unit-level proof of the A04 audit goal:
// "a forced network failure never yields a blank page or an unhandled
// rejection." Every data-driven surface routes its loading → fetch →
// empty / error / retry lifecycle through src/shared/async-state.js, so the
// guarantees that keep a void off the screen live here. These tests lock that
// behaviour in: a rejected load resolves into a *designed, retryable* error
// state (not a throw), empty data renders the empty shell, and Retry re-runs
// the original load.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadInto, renderError } from '../src/shared/async-state.js';

// Note: resolveError logs technical detail via log.js, which binds
// console.error at import time — a later spy cannot intercept it. These tests
// therefore assert the user-facing contract (a designed shell, never a raw
// message), not the console channel; the stderr line on a failing load is the
// by-design "errors always log" behaviour.

describe('async-state — loadInto boundary', () => {
	let container;

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		container.remove();
	});

	it('renders the populated state on a successful load', async () => {
		const data = await loadInto(container, {
			load: () => Promise.resolve(['a', 'b', 'c']),
			render: (items, el) => {
				el.innerHTML = items.map((i) => `<div class="card">${i}</div>`).join('');
			},
			skeleton: { count: 3, variant: 'card' },
		});

		expect(data).toEqual(['a', 'b', 'c']);
		expect(container.querySelectorAll('.card')).toHaveLength(3);
		// No leftover skeleton / error shells.
		expect(container.querySelector('.tws-sk')).toBeNull();
		expect(container.querySelector('.tws-es--error')).toBeNull();
	});

	it('renders a designed empty state (not the populated render) when data is empty', async () => {
		const render = vi.fn();
		const data = await loadInto(container, {
			load: () => Promise.resolve([]),
			render,
			empty: { title: 'No agents yet', body: 'Deploy your first agent to see it here.' },
		});

		expect(data).toBeNull();
		expect(render).not.toHaveBeenCalled();
		const empty = container.querySelector('.tws-es');
		expect(empty).not.toBeNull();
		expect(empty.textContent).toContain('No agents yet');
	});

	it('a rejected load fails into a retryable error state instead of throwing', async () => {
		// The promise must RESOLVE (to null) — an unhandled rejection here would be
		// exactly the blank-screen failure A04 exists to prevent.
		const data = await loadInto(container, {
			load: () => Promise.reject(new Error('boom: network down')),
			render: () => {
				throw new Error('render must not run on a failed load');
			},
			context: 'test:boundary',
		});

		expect(data).toBeNull();
		const errShell = container.querySelector('.tws-es--error');
		expect(errShell).not.toBeNull();
		expect(errShell.getAttribute('role')).toBe('alert');
		// An actionable recovery affordance is present.
		expect(container.querySelector('[data-sk-retry]')).not.toBeNull();
		// The raw error message is never surfaced verbatim in the user-facing copy.
		expect(errShell.textContent).not.toContain('boom: network down');
	});

	it('Retry re-runs the original load and recovers into the populated state', async () => {
		let attempt = 0;
		const load = vi.fn(() => {
			attempt += 1;
			return attempt === 1
				? Promise.reject(new Error('transient'))
				: Promise.resolve(['recovered']);
		});

		await loadInto(container, {
			load,
			render: (items, el) => {
				el.innerHTML = items.map((i) => `<div class="card">${i}</div>`).join('');
			},
		});

		// First attempt failed → error shell with a retry button.
		const retry = container.querySelector('[data-sk-retry]');
		expect(retry).not.toBeNull();

		// Clicking Retry re-runs loadInto; await a microtask flush for the re-render.
		retry.click();
		await vi.waitFor(() => {
			expect(container.querySelector('.card')).not.toBeNull();
		});

		expect(load).toHaveBeenCalledTimes(2);
		expect(container.querySelector('.card').textContent).toBe('recovered');
		expect(container.querySelector('.tws-es--error')).toBeNull();
	});

	it('loadInto on a null container is a no-op (defensive, never throws)', async () => {
		await expect(loadInto(null, { load: () => Promise.resolve([]), render: () => {} }))
			.resolves.toBeNull();
	});
});

describe('async-state — renderError direct shell', () => {
	let container;

	beforeEach(() => {
		container = document.createElement('div');
		document.body.appendChild(container);
	});

	afterEach(() => {
		container.remove();
	});

	it('renders the shared error shell and wires the retry callback', () => {
		const onRetry = vi.fn();
		renderError(container, new Error('offline'), { context: 'test:direct' }, onRetry);

		const errShell = container.querySelector('.tws-es--error');
		expect(errShell).not.toBeNull();
		const retry = container.querySelector('[data-sk-retry]');
		expect(retry).not.toBeNull();
		retry.click();
		expect(onRetry).toHaveBeenCalledTimes(1);
	});

	it('honours a caller-supplied error title/body override', () => {
		renderError(
			container,
			new Error('raw detail'),
			{ error: { title: 'Couldn’t load your agents', body: 'Check your connection.' } },
		);
		const errShell = container.querySelector('.tws-es--error');
		expect(errShell.textContent).toContain('Couldn’t load your agents');
		expect(errShell.textContent).toContain('Check your connection.');
		expect(errShell.textContent).not.toContain('raw detail');
	});
});
