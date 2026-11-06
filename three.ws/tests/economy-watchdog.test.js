import { describe, it, expect } from 'vitest';

import { classifyEngine, purgeStaleHistory, UPTIME_TARGETS } from '../api/cron/uptime-check.js';

// The economy watchdog's judgment call: which heartbeat engine results page an
// operator, and which are benign cadence skips. Getting this wrong either
// hides a weeks-long stall (July 2026) or pages all night for nothing.

describe('economy watchdog — classifyEngine', () => {
	it('a hard failure always pages (404 route gap, timeout, 5xx)', () => {
		expect(classifyEngine({ label: 'buyback', ok: false, status: 404 })).toBe('buyback: HTTP 404');
		expect(classifyEngine({ label: 'dca', ok: false, status: 0, error: 'timeout' })).toBe('dca: timeout');
		expect(classifyEngine({ label: 'launcher', ok: false, status: 500 })).toBe('launcher: HTTP 500');
	});

	it('actionable skip reasons page: misconfig, funding, storage, key parsing', () => {
		for (const reason of [
			'disabled',
			'Non-base58 character',
			'x402 pay: seed keypair undecodable — X402_SEED_SOLANA_SECRET_BASE58 must be 64 bytes as base58, base64, or a JSON array of 64 ints',
			'db_at_storage_cap',
			'insufficient_payer_usdc',
			'sponsor_sol_floor',
			'settle_unaffordable',
			'treasury balance 0.0100 SOL too low to fund 0.0300 SOL',
			'ring_config_invalid',
			'redis_unavailable: connect ETIMEDOUT',
		]) {
			expect(classifyEngine({ label: 'ring-tick', ok: true, skipped: true, reason }), reason).toBeTruthy();
		}
	});

	it('benign cadence skips stay quiet', () => {
		expect(classifyEngine({ label: 'buyback', ok: true, skipped: true, reason: 'not_due' })).toBeNull();
		expect(classifyEngine({ label: 'buyback', ok: true, skipped: true, reason: 'already_ran_today' })).toBeNull();
		expect(classifyEngine({ label: 'pulse', ok: true, skipped: true })).toBeNull();
		expect(classifyEngine({ label: 'ring-tick', ok: true, status: 200 })).toBeNull();
	});

	it('tolerates malformed entries', () => {
		expect(classifyEngine(null)).toBeNull();
		expect(classifyEngine({})).toBeNull();
	});
});

// History recorded against a corrected probe path measured the OLD URL, not the
// service — the July 2026 x402/viewer probes 404'd against paths that never
// existed while the real surfaces were healthy, painting a phantom 0%-uptime
// outage on the status page. The purge drops exactly that history and nothing else.
describe('uptime history — purgeStaleHistory', () => {
	const targets = [
		{ id: 'site', label: 'Website', path: '/' },
		{ id: 'x402', label: 'x402 paid-API discovery', path: '/.well-known/x402.json' },
	];

	it('drops rows stamped with a different path, keeps rows stamped with the current one', () => {
		const snapshots = [
			{ t: 1, results: { site: { ok: true, p: '/' }, x402: { ok: false, p: '/.well-known/x402-discovery' } } },
			{ t: 2, results: { site: { ok: true, p: '/' }, x402: { ok: true, p: '/.well-known/x402.json' } } },
		];
		const daily = [
			{ d: '2026-07-04', targets: { site: { n: 288, up: 288, msSum: 1, p: '/' }, x402: { n: 288, up: 0, msSum: 1, p: '/.well-known/x402-discovery' } } },
			{ d: '2026-07-05', targets: { site: { n: 10, up: 10, msSum: 1, p: '/' }, x402: { n: 10, up: 10, msSum: 1, p: '/.well-known/x402.json' } } },
		];
		purgeStaleHistory(snapshots, daily, targets);
		expect(snapshots[0].results.x402).toBeUndefined();
		expect(snapshots[1].results.x402).toBeDefined();
		expect(daily[0].targets.x402).toBeUndefined();
		expect(daily[1].targets.x402).toBeDefined();
		expect(snapshots[0].results.site).toBeDefined();
		expect(daily[0].targets.site).toBeDefined();
	});

	it('purges un-stamped rows only for reprobed ids; grandfathers everyone else', () => {
		const snapshots = [{ t: 1, results: { site: { ok: true }, x402: { ok: false }, viewer: { ok: false } } }];
		const daily = [{ d: '2026-07-04', targets: { site: { n: 5, up: 5, msSum: 1 }, x402: { n: 5, up: 0, msSum: 1 }, viewer: { n: 5, up: 0, msSum: 1 } } }];
		const all = [...targets, { id: 'viewer', label: '3D viewer', path: '/app' }];
		purgeStaleHistory(snapshots, daily, all);
		expect(snapshots[0].results.site).toBeDefined(); // genuine un-stamped history kept
		expect(snapshots[0].results.x402).toBeUndefined();
		expect(snapshots[0].results.viewer).toBeUndefined();
		expect(daily[0].targets.site).toBeDefined();
		expect(daily[0].targets.x402).toBeUndefined();
		expect(daily[0].targets.viewer).toBeUndefined();
	});

	it('tolerates snapshots and days with missing shapes', () => {
		expect(() => purgeStaleHistory([{ t: 1 }, {}], [{ d: 'x' }, {}], targets)).not.toThrow();
	});

	it('live targets probe real public paths (the 2026-07 phantom paths stay dead)', () => {
		const paths = UPTIME_TARGETS.map((t) => t.path);
		expect(paths).toContain('/.well-known/x402.json');
		expect(paths).toContain('/app');
		expect(paths).not.toContain('/viewer');
		expect(paths.some((p) => p.startsWith('/.well-known/x402-discovery'))).toBe(false);
	});
});
