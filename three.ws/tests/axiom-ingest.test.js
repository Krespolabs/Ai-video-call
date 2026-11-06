// api/_lib/axiom.js — Axiom event ingest for payment/business metrics.
//
// The module gates on AXIOM_TOKEN + AXIOM_DATASET and is a strict no-op until
// both are set (local/CI/pre-account), mirroring the SENTRY_DSN gate. When set,
// it fires one authenticated POST per event and never throws. These tests cover
// both states by resetting the module registry between env configs (cfg() caches
// once per module load), with global.fetch stubbed so no network is hit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const REAL_FETCH = global.fetch;
const SAVED = { token: process.env.AXIOM_TOKEN, dataset: process.env.AXIOM_DATASET, url: process.env.AXIOM_URL };

function stubFetch() {
	const fn = vi.fn(async () => ({ ok: true, status: 200 }));
	global.fetch = fn;
	return fn;
}

beforeEach(() => {
	vi.resetModules();
	delete process.env.AXIOM_TOKEN;
	delete process.env.AXIOM_DATASET;
	delete process.env.AXIOM_URL;
});

afterEach(() => {
	global.fetch = REAL_FETCH;
	process.env.AXIOM_TOKEN = SAVED.token;
	process.env.AXIOM_DATASET = SAVED.dataset;
	process.env.AXIOM_URL = SAVED.url;
});

describe('axiom ingest — disabled (no env)', () => {
	it('axiomEnabled() is false and nothing is sent', async () => {
		const fetchSpy = stubFetch();
		const { axiomEnabled, recordPaymentMetric, ingestEvent } = await import('../api/_lib/axiom.js');
		expect(axiomEnabled()).toBe(false);
		recordPaymentMetric({ kind: 'avatar_payout', status: 'ok', amountUsd: 5 });
		ingestEvent({ type: 'test' });
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe('axiom ingest — enabled', () => {
	beforeEach(() => {
		process.env.AXIOM_TOKEN = 'xaat-test-token';
		process.env.AXIOM_DATASET = 'threews-payments';
	});

	it('axiomEnabled() is true', async () => {
		stubFetch();
		const { axiomEnabled } = await import('../api/_lib/axiom.js');
		expect(axiomEnabled()).toBe(true);
	});

	it('POSTs to the dataset ingest URL with Bearer auth', async () => {
		const fetchSpy = stubFetch();
		const { recordPaymentMetric } = await import('../api/_lib/axiom.js');
		recordPaymentMetric({ kind: 'avatar_payout', status: 'ok', network: 'mainnet', amountUsd: 5, latencyMs: 1200, signature: 'SIG_1' });
		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, opts] = fetchSpy.mock.calls[0];
		expect(url).toBe('https://api.axiom.co/v1/datasets/threews-payments/ingest');
		expect(opts.method).toBe('POST');
		expect(opts.headers.authorization).toBe('Bearer xaat-test-token');
		expect(opts.headers['content-type']).toBe('application/json');
		expect(opts.keepalive).toBe(true);
	});

	it('builds a payment event row with envelope fields', async () => {
		const fetchSpy = stubFetch();
		const { recordPaymentMetric } = await import('../api/_lib/axiom.js');
		recordPaymentMetric({ kind: 'avatar_payout', status: 'failed', network: 'mainnet', amountUsd: 5, latencyMs: 800, reason: 'rpc timeout' });
		const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
		expect(Array.isArray(body)).toBe(true);
		expect(body).toHaveLength(1);
		const row = body[0];
		expect(row).toMatchObject({ type: 'payment', kind: 'avatar_payout', status: 'failed', network: 'mainnet', amount_usd: 5, latency_ms: 800, reason: 'rpc timeout' });
		expect(typeof row._time).toBe('string');
		expect(row.environment).toBeTruthy();
	});

	it('honors AXIOM_URL host override (EU/self-host)', async () => {
		process.env.AXIOM_URL = 'https://api.eu.axiom.co';
		const fetchSpy = stubFetch();
		const { ingestEvent } = await import('../api/_lib/axiom.js');
		ingestEvent({ type: 'test' });
		expect(fetchSpy.mock.calls[0][0]).toBe('https://api.eu.axiom.co/v1/datasets/threews-payments/ingest');
	});

	it('never throws when fetch rejects (fire-and-forget)', async () => {
		global.fetch = vi.fn(async () => { throw new Error('network down'); });
		const { recordPaymentMetric } = await import('../api/_lib/axiom.js');
		expect(() => recordPaymentMetric({ kind: 'x402', status: 'ok' })).not.toThrow();
	});
});
