// @vitest-environment jsdom
//
// DOM-level tests for mountCoinStatus: each variant renders against a stubbed
// /api/pump/coin response, the error state recovers via Retry, and destroy()
// stops the refresh timer. fetch is stubbed at the global boundary.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mountCoinStatus } from './coin-status-card.js';

const MINT = 'THREEsynthetic1111111111111111111111111111';

// A representative pump.fun coin object (the shape /api/pump/coin proxies).
function coinBody(overrides = {}) {
	return {
		mint: MINT,
		name: 'Synthetic Coin',
		symbol: 'SYN',
		image_uri: 'https://example.test/logo.png',
		usd_market_cap: 34_500, // ~50% to the ~$69k graduation cap
		total_supply: 1_000_000_000_000_000, // 1e9 tokens at 6 decimals
		complete: false,
		created_timestamp: Date.now() - 5 * 60_000,
		volume_24h: 12_345,
		...overrides,
	};
}

function okFetch(body) {
	return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(body) });
}

let container;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	container.remove();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('mountCoinStatus — variants', () => {
	it('renders the chip variant with symbol, price, mcap and graduation', async () => {
		vi.stubGlobal('fetch', okFetch(coinBody()));
		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0 });
		// Wait for a populated-only marker (the skeleton shares the .csc-chip base class).
		await vi.waitFor(() => expect(container.querySelector('.csc-sym')).toBeTruthy());

		expect(container.querySelector('.csc-sym').textContent).toBe('$SYN');
		expect(container.querySelector('.csc-mcap').textContent).toBe('$34.5K');
		expect(container.querySelector('.csc-price')).toBeTruthy();
		expect(container.querySelector('.csc-grad').textContent).toMatch(/to grad/);
		expect(container.getAttribute('aria-busy')).toBe('false');
		handle.destroy();
	});

	it('renders the row variant inside its container', async () => {
		vi.stubGlobal('fetch', okFetch(coinBody()));
		const handle = mountCoinStatus(container, MINT, { variant: 'row', refreshMs: 0 });
		await vi.waitFor(() => expect(container.querySelector('.csc-sym')).toBeTruthy());

		expect(container.querySelector('.csc-mint').textContent).toContain('…');
		expect(container.querySelector('.csc-vol').textContent).toContain('Vol');
		handle.destroy();
	});

	it('renders the card variant with a graduation ring and crossfaded placeholder', async () => {
		vi.stubGlobal('fetch', okFetch(coinBody()));
		const placeholder = document.createElement('span');
		placeholder.className = 'my-placeholder';
		const handle = mountCoinStatus(container, MINT, { variant: 'card', refreshMs: 0, placeholder, showBuy: true });
		await vi.waitFor(() => expect(container.querySelector('.csc-card-name')).toBeTruthy());

		expect(container.querySelector('.csc-ring')).toBeTruthy();
		expect(container.querySelector('.csc-avatar .my-placeholder')).toBeTruthy();
		expect(container.querySelector('.csc-card-img')).toBeTruthy();
		expect(container.querySelector('.csc-buy').getAttribute('href')).toBe(`https://pump.fun/${MINT}`);
		handle.destroy();
	});

	it('marks a graduated coin as graduated', async () => {
		vi.stubGlobal('fetch', okFetch(coinBody({ complete: true })));
		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0 });
		await vi.waitFor(() => expect(container.querySelector('.csc-grad-done')).toBeTruthy());
		expect(container.querySelector('.csc-grad-done').textContent).toBe('Graduated');
		handle.destroy();
	});
});

describe('mountCoinStatus — error + lifecycle', () => {
	it('shows an error state with a Retry button that re-fetches and recovers', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 502, json: () => Promise.resolve({}) })
			.mockResolvedValue({ ok: true, json: () => Promise.resolve(coinBody()) });
		vi.stubGlobal('fetch', fetchMock);

		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 0 });
		await vi.waitFor(() => expect(container.querySelector('.csc-error')).toBeTruthy());
		expect(container.querySelector('[role="alert"]')).toBeTruthy();

		container.querySelector('.csc-retry').click();
		await vi.waitFor(() => expect(container.querySelector('.csc-chip')).toBeTruthy());
		expect(container.querySelector('.csc-error')).toBeFalsy();
		handle.destroy();
	});

	it('stops fetching after destroy()', async () => {
		vi.useFakeTimers();
		const fetchMock = okFetch(coinBody());
		vi.stubGlobal('fetch', fetchMock);

		const handle = mountCoinStatus(container, MINT, { variant: 'chip', refreshMs: 1000 });
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

		handle.destroy();
		const callsAtDestroy = fetchMock.mock.calls.length;
		await vi.advanceTimersByTimeAsync(3000);
		expect(fetchMock.mock.calls.length).toBe(callsAtDestroy); // timer cleared
	});
});
