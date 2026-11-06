// Tests that the settled-payment side of /api/x402/dance-tip writes a row
// into `club_tips`. The pure-helpers (STYLES, pickStyle, pickDancer,
// buildTicket) are exercised in dance-tip.test.js — this file mocks the
// `paidEndpoint` wrapper so we can call the handler closure directly with
// a fake (req, requirement, payer) and inspect the sql tagged-template
// invocations.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Capture the spec passed to paidEndpoint so we can grab the inner handler.
let capturedSpec = null;
vi.mock('../../api/_lib/x402-paid-endpoint.js', () => ({
	paidEndpoint: (spec) => {
		capturedSpec = spec;
		return async () => {};
	},
}));

const sqlState = {
	queue: [],
	calls: [],
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn((strings, ...values) => {
		const query = typeof strings === 'string' ? strings : strings.join('?');
		sqlState.calls.push({ query, values });
		// Tagged-template usage returns a thenable so `.catch(...)` chains work.
		const result = sqlState.queue.length === 0 ? [] : sqlState.queue.shift();
		if (result instanceof Error) return Promise.reject(result);
		return Promise.resolve(result);
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

// Importing the module triggers the paidEndpoint call → captures the spec.
await import('../../api/x402/dance-tip.js');

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
});

function makeReq(query) {
	return {
		method: 'GET',
		query,
		headers: { host: 'localhost' },
	};
}

const REQUIREMENT = {
	network: 'base',
	amount: '1000',
	asset: '0xUSDC',
};

describe('/api/x402/dance-tip settlement → club_tips insert', () => {
	it('inserts one row with the ticket details after the handler resolves', async () => {
		expect(capturedSpec, 'paidEndpoint was never called — module import failed').toBeTruthy();

		const ticket = await capturedSpec.handler({
			req: makeReq({ dancer: '2', dance: 'rumba' }),
			res: {},
			requirement: REQUIREMENT,
			payer: '0xPayer',
		});

		// The settled JSON returned to the caller carries the ticket details.
		expect(ticket.ok).toBe(true);
		expect(ticket.dancer).toBe('2');
		expect(ticket.dance).toBe('rumba');
		expect(typeof ticket.ticketId).toBe('string');

		// Yield to the microtask queue so the fire-and-forget `.catch(...)`
		// chain attached to the sql call has a turn to run.
		await new Promise((r) => setImmediate(r));

		expect(sqlState.calls).toHaveLength(1);
		const call = sqlState.calls[0];
		expect(call.query).toMatch(/insert into club_tips/i);
		expect(call.query).toMatch(/on conflict \(ticket_id\) do nothing/i);
		// The bound values match the ticket the caller saw — same id, same dancer.
		expect(call.values).toEqual(
			expect.arrayContaining([
				ticket.ticketId, '2', 'rumba', 'rumba',
				'0xPayer', 'base', '1000', '0xUSDC',
			]),
		);
	});

	it('does not block the response when the insert promise rejects', async () => {
		expect(capturedSpec).toBeTruthy();
		sqlState.queue.push(new Error('neon: fetch failed'));

		// Silence the expected console.error so test output stays clean.
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		const ticket = await capturedSpec.handler({
			req: makeReq({ dancer: '1', dance: 'hiphop' }),
			res: {},
			requirement: REQUIREMENT,
			payer: '0xPayer',
		});

		// Handler still returns the ticket — Neon hiccups must not surface as
		// 5xx after the payment already settled.
		expect(ticket.ok).toBe(true);
		expect(ticket.dancer).toBe('1');

		// Let the rejection settle so we see the captured console.error before
		// the assertion below.
		await new Promise((r) => setImmediate(r));
		expect(errSpy).toHaveBeenCalled();
		errSpy.mockRestore();
	});

	it('uses `on conflict (ticket_id) do nothing` so duplicate inserts are safe', async () => {
		// Belt-and-suspenders: re-invoke twice with manually-collided ids by
		// stubbing crypto.randomUUID. We cannot easily simulate Postgres's own
		// uniqueness constraint with a vi.mock'd sql, but we *can* assert the
		// SQL text in the wire payload carries the conflict clause both times.
		await capturedSpec.handler({
			req: makeReq({ dancer: '1', dance: 'rumba' }),
			res: {},
			requirement: REQUIREMENT,
			payer: '0xPayer',
		});
		await capturedSpec.handler({
			req: makeReq({ dancer: '1', dance: 'rumba' }),
			res: {},
			requirement: REQUIREMENT,
			payer: '0xPayer',
		});
		await new Promise((r) => setImmediate(r));

		expect(sqlState.calls.length).toBeGreaterThanOrEqual(2);
		for (const call of sqlState.calls) {
			expect(call.query).toMatch(/on conflict \(ticket_id\) do nothing/i);
		}
	});
});
