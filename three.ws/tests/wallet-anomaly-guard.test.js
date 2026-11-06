// Integration-ish tests for api/_lib/anomaly-events.js guardOutboundAnomaly() —
// the live wiring that scores an outbound action, freezes the wallet, records the
// timeline row, and notifies the owner. The DB (sql) and notifier are mocked with
// a content-routed fake so we can assert the real control flow without a database.
//
// Headline: the simulated drain attack — many small payments to a never-seen
// address, staying under the daily USD cap — must FREEZE + RECORD + NOTIFY.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Content-routed sql mock: returns a shape based on what the query is doing, and
// records every call so tests can assert which side effects fired.
const calls = [];
let velocity = { c1: 1, c10: 1 };
let historyRows = [];

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings) => {
		const q = strings.join(' ');
		calls.push(q.replace(/\s+/g, ' ').trim());
		if (q.includes('SELECT user_id, meta FROM agent_identities')) return [{ user_id: 'owner-1', meta: METphase() }];
		if (q.includes("FILTER (WHERE created_at > now() - interval '1 minute'")) return [{ c1: velocity.c1, c10: velocity.c10 }];
		if (q.includes('SELECT usd, destination, asset, category, created_at')) return historyRows;
		if (q.includes('anomaly_baseline')) return []; // cache write
		if (q.includes("jsonb_build_object") && q.includes('frozen')) return [{ id: 'agent-1' }]; // freeze flipped
		if (q.includes('INSERT INTO agent_custody_events')) return [];
		if (q.includes('INSERT INTO agent_anomaly_events')) return [{ id: '99' }];
		return [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const notifySpy = vi.fn(() => ({ id: 'n1' }));
vi.mock('../api/_lib/notify.js', () => ({ insertNotification: (...a) => notifySpy(...a) }));

const { guardOutboundAnomaly } = await import('../api/_lib/anomaly-events.js');

// meta carrying an anomaly config; baseline is recomputed from historyRows.
let _meta = { anomaly: { sensitivity: 'balanced', enabled: true } };
function METphase() { return _meta; }

const KNOWN = 'KNOWNaddr1111111111111111111111111111111';
const NEW = 'NEWaddrZZZZ2222222222222222222222222222222';

function steadyHistory(n) {
	const out = [];
	for (let i = 0; i < n; i++) {
		out.push({ usd: 5, destination: KNOWN, asset: 'USDC', category: 'x402', created_at: `2026-05-${String((i % 27) + 1).padStart(2, '0')}T12:00:00Z` });
	}
	return out;
}

beforeEach(() => {
	calls.length = 0;
	notifySpy.mockClear();
	velocity = { c1: 1, c10: 1 };
	historyRows = steadyHistory(12);
	_meta = { anomaly: { sensitivity: 'balanced', enabled: true } };
});

describe('guardOutboundAnomaly — drain-within-the-cap attack', () => {
	it('freezes, records a flag, and notifies on a velocity-spike drain to a new address', async () => {
		velocity = { c1: 10, c10: 12 }; // burst — leaked-session signature
		const res = await guardOutboundAnomaly({
			agentId: 'agent-1', meta: _meta, category: 'x402', usdValue: 2, destination: NEW,
			asset: 'USDC', network: 'mainnet', selfCounted: true,
		});
		expect(res.decision).toBe('freeze');
		expect(res.message).toMatch(/frozen/i);
		// The wallet freeze flag was flipped …
		expect(calls.some((c) => c.includes('jsonb_build_object') && c.includes('frozen'))).toBe(true);
		// … a timeline flag row was inserted …
		expect(calls.some((c) => c.includes('INSERT INTO agent_anomaly_events'))).toBe(true);
		// … and the owner was notified.
		expect(notifySpy).toHaveBeenCalledTimes(1);
		expect(notifySpy.mock.calls[0][1]).toBe('wallet_anomaly_frozen');
	});
});

describe('guardOutboundAnomaly — normal activity', () => {
	it('allows a normal spend to a known address and does NOT freeze or notify', async () => {
		const res = await guardOutboundAnomaly({
			agentId: 'agent-1', meta: _meta, category: 'x402', usdValue: 5, destination: KNOWN,
			asset: 'USDC', network: 'mainnet', selfCounted: true,
		});
		expect(res.decision).toBe('allow');
		expect(calls.some((c) => c.includes('jsonb_build_object') && c.includes('frozen'))).toBe(false);
		expect(notifySpy).not.toHaveBeenCalled();
	});

	it('is a no-op when the owner disabled the guard', async () => {
		_meta = { anomaly: { enabled: false } };
		velocity = { c1: 30, c10: 50 };
		const res = await guardOutboundAnomaly({ agentId: 'agent-1', meta: _meta, category: 'x402', usdValue: 999, destination: NEW });
		expect(res.decision).toBe('allow');
		expect(notifySpy).not.toHaveBeenCalled();
	});
});

describe('guardOutboundAnomaly — withdraw is never blocked', () => {
	it('scores + records a critical withdraw but returns allow (owner escape hatch)', async () => {
		const res = await guardOutboundAnomaly({
			agentId: 'agent-1', meta: _meta, category: 'withdraw', usdValue: 5000, destination: NEW, asset: 'SOL',
		});
		expect(res.decision).toBe('allow'); // withdraw never frozen
		expect(calls.some((c) => c.includes('jsonb_build_object') && c.includes('frozen'))).toBe(false);
	});
});

describe('guardOutboundAnomaly — fail-safe on internal error', () => {
	it('strict sensitivity freezes when scoring cannot complete (never fails open)', async () => {
		_meta = { anomaly: { sensitivity: 'strict', enabled: true } };
		historyRows = null; // force the baseline recompute path to throw downstream
		// Make the velocity query throw to simulate an IO failure inside the try.
		const dbmod = await import('../api/_lib/db.js');
		dbmod.sql.mockImplementationOnce(async () => { throw new Error('db down'); });
		const res = await guardOutboundAnomaly({ agentId: 'agent-1', userId: 'owner-1', meta: _meta, category: 'x402', usdValue: 10, destination: NEW });
		expect(res.decision).toBe('freeze');
		expect(res.detail?.reason).toBe('scoring_error');
	});

	it('balanced sensitivity allows (records nothing fatal) when scoring errors', async () => {
		_meta = { anomaly: { sensitivity: 'balanced', enabled: true } };
		const dbmod = await import('../api/_lib/db.js');
		dbmod.sql.mockImplementationOnce(async () => { throw new Error('db down'); });
		const res = await guardOutboundAnomaly({ agentId: 'agent-1', userId: 'owner-1', meta: _meta, category: 'x402', usdValue: 10, destination: NEW });
		expect(res.decision).toBe('allow');
	});
});
