// agent-sniper ops/deploy hardening — config fail-closed + error-spike tracker.
//
// These cover the deploy-safety guarantees the Cloud Run worker depends on:
//   1. loadConfig() refuses to start on missing/invalid env (fail closed), so a
//      misconfigured revision crash-loops loudly instead of trading half-blind.
//   2. live mode refuses a missing RPC (a public RPC 429s under the firehose).
//   3. the error-spike tracker pages ONCE per run-up and re-arms only after the
//      window drains — so a sustained RPC outage alerts once, not on every error.
//
// Pure logic only: no DB, no network, no pump SDK — fast and deterministic.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../workers/agent-sniper/config.js';
import { makeErrorTracker } from '../workers/agent-sniper/error-tracker.js';
import { shouldSelfHeal } from '../workers/agent-sniper/heartbeat.js';

const SNIPER_KEYS = Object.keys(process.env).filter((k) => k.startsWith('SNIPER_'));

describe('agent-sniper loadConfig — fail closed', () => {
	let saved;
	beforeEach(() => {
		saved = { ...process.env };
		// Start from a clean sniper env each test.
		for (const k of [...SNIPER_KEYS, 'DATABASE_URL', 'JWT_SECRET', 'SOLANA_RPC_URL', 'HELIUS_API_KEY']) {
			delete process.env[k];
		}
	});
	afterEach(() => {
		for (const k of Object.keys(process.env)) delete process.env[k];
		Object.assign(process.env, saved);
	});

	it('throws when DATABASE_URL is missing', () => {
		process.env.JWT_SECRET = 'x';
		expect(() => loadConfig()).toThrow(/DATABASE_URL/);
	});

	it('throws when JWT_SECRET is missing', () => {
		process.env.DATABASE_URL = 'postgres://x';
		expect(() => loadConfig()).toThrow(/JWT_SECRET/);
	});

	it('throws on an invalid SNIPER_MODE', () => {
		process.env.DATABASE_URL = 'postgres://x';
		process.env.JWT_SECRET = 'x';
		process.env.SNIPER_MODE = 'yolo';
		expect(() => loadConfig()).toThrow(/SNIPER_MODE/);
	});

	it('throws on an invalid SNIPER_NETWORK', () => {
		process.env.DATABASE_URL = 'postgres://x';
		process.env.JWT_SECRET = 'x';
		process.env.SNIPER_NETWORK = 'testnet';
		expect(() => loadConfig()).toThrow(/SNIPER_NETWORK/);
	});

	it('refuses live mode without a real RPC', () => {
		process.env.DATABASE_URL = 'postgres://x';
		process.env.JWT_SECRET = 'x';
		process.env.SNIPER_MODE = 'live';
		expect(() => loadConfig()).toThrow(/SOLANA_RPC_URL|HELIUS_API_KEY/);
	});

	it('allows live mode once an RPC is present', () => {
		process.env.DATABASE_URL = 'postgres://x';
		process.env.JWT_SECRET = 'x';
		process.env.SNIPER_MODE = 'live';
		process.env.SOLANA_RPC_URL = 'https://rpc.example';
		const cfg = loadConfig();
		expect(cfg.mode).toBe('live');
	});

	it('defaults to simulate with sane ops knobs', () => {
		process.env.DATABASE_URL = 'postgres://x';
		process.env.JWT_SECRET = 'x';
		const cfg = loadConfig();
		expect(cfg.mode).toBe('simulate');
		expect(cfg.network).toBe('mainnet');
		expect(cfg.heartbeatMs).toBeGreaterThanOrEqual(10_000);
		expect(cfg.errorAlertThreshold).toBeGreaterThanOrEqual(1);
		expect(cfg.errorAlertWindowMs).toBeGreaterThanOrEqual(60_000);
		expect(cfg.announceLifecycle).toBe(true);
	});

	it('clamps the heartbeat cadence to a 10s floor', () => {
		process.env.DATABASE_URL = 'postgres://x';
		process.env.JWT_SECRET = 'x';
		process.env.SNIPER_HEARTBEAT_MS = '1';
		expect(loadConfig().heartbeatMs).toBe(10_000);
	});
});

describe('agent-sniper error-spike tracker', () => {
	it('fires once exactly when the threshold is crossed, not before', () => {
		const t = makeErrorTracker({ threshold: 3, windowMs: 60_000 });
		expect(t.record('a')).toBeNull();
		expect(t.record('b')).toBeNull();
		const spike = t.record('c');
		expect(spike).toMatchObject({ count: 3, windowMs: 60_000, lastError: 'c' });
	});

	it('does not re-fire while still above threshold (armed=false)', () => {
		const t = makeErrorTracker({ threshold: 2, windowMs: 60_000 });
		t.record('a');
		expect(t.record('b')).toMatchObject({ count: 2 }); // trips
		expect(t.record('c')).toBeNull(); // still hot — no second page
		expect(t.record('d')).toBeNull();
	});

	it('re-arms after the window drains below threshold', () => {
		let now = 1_000_000;
		const realNow = Date.now;
		Date.now = () => now;
		try {
			const t = makeErrorTracker({ threshold: 2, windowMs: 10_000 });
			t.record('a');
			expect(t.record('b')).toMatchObject({ count: 2 }); // trips, armed=false
			now += 20_000; // window fully drains
			t.tick(); // prunes + re-arms
			expect(t.total).toBe(0);
			t.record('c');
			expect(t.record('d')).toMatchObject({ count: 2 }); // can trip again
		} finally {
			Date.now = realNow;
		}
	});

	it('tracks the most recent error message and rolling total', () => {
		const t = makeErrorTracker({ threshold: 100, windowMs: 60_000 });
		t.record('first');
		t.record('second');
		expect(t.lastError).toBe('second');
		expect(t.total).toBe(2);
	});
});

// Heartbeat dead-man switch — the worker must restart itself (Cloud Run brings
// it back with fresh connections + secrets) once heartbeat writes have failed
// continuously past the self-heal window, instead of running as a 36-hour
// zombie the way it did on 2026-07-03. Transient blips inside the window must
// NOT trigger it, and 0 disables it.
describe('agent-sniper heartbeat self-heal verdict', () => {
	const NOW = 1_800_000_000_000;

	it('does not fire inside the failure window (a Neon blip is not a death)', () => {
		expect(shouldSelfHeal(NOW - 5 * 60_000, NOW, 15 * 60_000)).toBe(false);
	});

	it('fires once writes have failed continuously past the window', () => {
		expect(shouldSelfHeal(NOW - 16 * 60_000, NOW, 15 * 60_000)).toBe(true);
	});

	it('is disabled by a non-positive window', () => {
		expect(shouldSelfHeal(NOW - 10 * 3_600_000, NOW, 0)).toBe(false);
		expect(shouldSelfHeal(NOW - 10 * 3_600_000, NOW, -1)).toBe(false);
	});
});
