// @vitest-environment jsdom
//
// Render test for the live hire visualizer client (src/agent-screen-hire.js),
// driven by the EXACT meta payloads the server emits (api/_lib/a2a-hire-phases.js
// → hirePhaseFrame). This exercises the real client render path: quote card, the
// cap badge, the step progression, the coin-transfer animation (which must fire
// ONLY on a live settle), the provenance receipt with explorer links, the amber
// over-cap card, and reconnect backfill re-sync without a coin re-fire.

import { describe, it, expect, beforeEach } from 'vitest';
import { createHireVisualizer } from '../src/agent-screen-hire.js';
import { hirePhaseFrame } from '../api/_lib/a2a-hire-phases.js';

const HIRE = {
	hireId: 'h1',
	slug: 'forge_logo',
	skill: 'Forge Logo',
	providerName: 'AGENT-B',
	providerId: 'p1',
	hirerId: 'a1',
	hirerName: 'AGENT-A',
	usd: 0.04,
	maxUsd: 0.1,
	network: 'mainnet',
};

// Server-side frame → the meta the client ingests.
const metaFor = (phase, extra = {}) => hirePhaseFrame(phase, { ...HIRE, ...extra }).meta;

let body;
beforeEach(() => {
	document.body.innerHTML = '<div id="host"></div>';
	body = document.getElementById('host');
});

describe('createHireVisualizer', () => {
	it('renders the idle empty state before any hire', () => {
		createHireVisualizer(body);
		const empty = body.querySelector('#asc-hire-empty');
		expect(empty.hidden).toBe(false);
		expect(empty.textContent).toMatch(/hires others/i);
	});

	it('renders the quote card with provider, slug, price and cap badge', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('quote', { cap: { perCallCap: 0.1, dailyUsd: 1, dailyRemaining: 1 } }));

		expect(body.querySelector('#asc-hire-empty').hidden).toBe(true);
		const quote = body.querySelector('.asc-hire-quote');
		expect(quote).toBeTruthy();
		expect(quote.textContent).toContain('AGENT-B');
		expect(quote.textContent).toContain('forge_logo');
		expect(quote.textContent).toContain('0.04');
		// persistent cap badge
		const cap = body.querySelector('#asc-hire-cap');
		expect(cap.hidden).toBe(false);
		expect(cap.textContent).toContain('0.10');
	});

	it('fires the coin animation only on a LIVE settle, once', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('quote'));
		viz.ingest(metaFor('reserved', { cap: { perCallCap: 0.1, dailyUsd: 1, dailyRemaining: 0.96 } }));
		viz.ingest(metaFor('running'));
		// before settle: no flying coin
		expect(body.querySelector('.asc-hire-coinrail.flying')).toBeFalsy();

		viz.ingest(metaFor('settled', { txSig: 'PAYSIG' }), { live: true });
		const rail = body.querySelector('.asc-hire-coinrail');
		expect(rail.classList.contains('flying')).toBe(true);
		expect(rail.classList.contains('settled')).toBe(true);
	});

	it('does NOT fire the coin on backfill (live: false) — that is history', () => {
		const viz = createHireVisualizer(body);
		// reconnect backfill replays straight to settled
		viz.ingest(metaFor('settled', { txSig: 'PAYSIG' }), { live: false });
		const rail = body.querySelector('.asc-hire-coinrail');
		expect(rail.classList.contains('flying')).toBe(false);
		// coin is parked at the provider instead
		expect(rail.classList.contains('arrived')).toBe(true);
	});

	it('resolves the receipt with real explorer links to settlement + invocation', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('quote'));
		viz.ingest(metaFor('settled', { txSig: 'PAYSIG' }), { live: true });
		viz.ingest(metaFor('recorded', { txSig: 'PAYSIG', invocationSig: 'INVSIG', resultSummary: 'logo.svg ready' }));

		const links = [...body.querySelectorAll('.asc-hire-receipt-links a')];
		const hrefs = links.map((a) => a.getAttribute('href'));
		expect(hrefs).toContain('https://solscan.io/tx/PAYSIG');
		expect(hrefs).toContain('https://solscan.io/tx/INVSIG');
		// external links open safely
		links.forEach((a) => {
			expect(a.getAttribute('target')).toBe('_blank');
			expect(a.getAttribute('rel')).toBe('noopener');
		});
		expect(body.querySelector('.asc-hire-receipt').textContent).toContain('logo.svg ready');
	});

	it('shows the settlement link as pending when no signature is present', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('settled', { txSig: null }), { live: true });
		const pending = body.querySelector('.asc-hire-link.pending');
		expect(pending).toBeTruthy();
		expect(pending.textContent.toLowerCase()).toContain('pending');
		// no fabricated link
		expect(body.querySelector('.asc-hire-receipt-links a[href*="solscan"]')).toBeFalsy();
	});

	it('renders an amber over-cap card instead of crashing or spending', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('over_cap', { usd: 0.2, cap: { perCallCap: 0.1 } }));
		const amber = body.querySelector('.asc-hire-result.amber');
		expect(amber).toBeTruthy();
		expect(amber.textContent.toLowerCase()).toContain('cap');
		// no coin rail in an over-cap render
		expect(body.querySelector('.asc-hire-coinrail')).toBeFalsy();
	});

	it('renders a red no-charge card on a failed skill', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('quote'));
		viz.ingest(metaFor('failed', { error: 'upstream 500' }));
		const red = body.querySelector('.asc-hire-result.red');
		expect(red).toBeTruthy();
		expect(red.textContent.toLowerCase()).toContain('no charge');
	});

	it('calls onSettled once with the hire meta on a live settle', () => {
		const seen = [];
		const viz = createHireVisualizer(body, { onSettled: (m) => seen.push(m) });
		viz.ingest(metaFor('quote'));
		viz.ingest(metaFor('settled', { txSig: 'PAYSIG' }), { live: true });
		expect(seen.length).toBe(1);
		expect(seen[0].providerName).toBe('AGENT-B');
		expect(seen[0].usd).toBe(0.04);
	});

	it('archives a finished hire into the history strip when a new hire starts', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('recorded', { txSig: 'P1', invocationSig: 'I1' }));
		// a different hire begins
		viz.ingest(metaFor('quote', { hireId: 'h2', providerName: 'AGENT-C', slug: 'transcribe' }));
		const rows = body.querySelectorAll('.asc-hire-hrow');
		expect(rows.length).toBe(1);
		expect(rows[0].textContent).toContain('AGENT-B');
	});

	it('drops stale out-of-order happy-path frames for the active hire', () => {
		const viz = createHireVisualizer(body);
		viz.ingest(metaFor('recorded', { txSig: 'P1', invocationSig: 'I1' }));
		// a late-arriving 'running' frame for the same hire must not regress the UI
		viz.ingest(metaFor('running'));
		// still shows the resolved receipt, not the running spinner
		expect(body.querySelector('.asc-hire-receipt.resolved')).toBeTruthy();
		expect(body.querySelector('.asc-hire-running')).toBeFalsy();
	});
});
