// Tests for GET /api/club/tips — the recent-tips backfill that hydrates the
// /club "Live tips" widget on page boot. Mocks `sql` so the handler runs in
// pure-unit mode.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';

const sqlState = {
	queue: [],
	calls: [],
};

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const query = typeof strings === 'string' ? strings : strings.join('?');
		sqlState.calls.push({ query, values });
		return sqlState.queue.length === 0 ? [] : sqlState.queue.shift();
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { default: handler } = await import('../../api/club/tips.js');

function makeReq({ method = 'GET', url = '/api/club/tips', headers = {}, query = null } = {}) {
	const r = Readable.from([]);
	r.method = method;
	r.url = url;
	r.headers = { host: 'localhost', ...headers };
	if (query) r.query = query;
	return r;
}

function makeRes() {
	return {
		statusCode: 200,
		headers: {},
		body: '',
		writableEnded: false,
		writeHead(status, headers = {}) {
			this.statusCode = status;
			for (const [k, v] of Object.entries(headers)) {
				this.headers[k.toLowerCase()] = v;
			}
		},
		setHeader(k, v) {
			this.headers[k.toLowerCase()] = v;
		},
		write(chunk) {
			this.body += chunk;
		},
		end(chunk) {
			if (chunk !== undefined) this.body += chunk;
			this.writableEnded = true;
		},
		on() {},
	};
}

async function invoke(opts = {}) {
	const req = makeReq(opts);
	const res = makeRes();
	await handler(req, res);
	let payload = null;
	if (res.body) {
		try { payload = JSON.parse(res.body); } catch { payload = res.body; }
	}
	return { res, status: res.statusCode, body: payload };
}

const sampleRow = {
	ticket_id: 't-1',
	dancer: '1',
	dance: 'rumba',
	clip: 'rumba',
	label: 'Rumba',
	payer: '0xabc',
	network: 'base',
	amount_atomics: '1000',
	asset: '0xUSDC',
	started_at: new Date('2026-05-21T10:00:00Z'),
	ends_at: new Date('2026-05-21T10:00:14Z'),
	created_at: new Date('2026-05-21T10:00:01Z'),
};

beforeEach(() => {
	sqlState.queue = [];
	sqlState.calls = [];
});

describe('GET /api/club/tips', () => {
	it('returns the recent rows as { tips: [...] }', async () => {
		sqlState.queue.push([sampleRow]);
		const { status, body } = await invoke();
		expect(status).toBe(200);
		// Dates round-trip through JSON.stringify as ISO strings; rebuild the
		// expectation accordingly so the deep-equal compares apples to apples.
		// Each row also carries `agent` (payer is a platform wallet) and the
		// style's choreography, so a spectator replays the routine that was bought.
		expect(body).toEqual({
			tips: [{
				...sampleRow,
				started_at: sampleRow.started_at.toISOString(),
				ends_at: sampleRow.ends_at.toISOString(),
				created_at: sampleRow.created_at.toISOString(),
				agent: false,
				durationSec: 14,
				track: 'rumba',
			}],
		});
		expect(sqlState.calls).toHaveLength(1);
	});

	it('flags a platform-wallet payer as an agent and drops the raw column', async () => {
		sqlState.queue.push([{ ...sampleRow, is_agent: true }]);
		const { body } = await invoke();
		expect(body.tips[0].agent).toBe(true);
		expect(body.tips[0]).not.toHaveProperty('is_agent');
		expect(sqlState.calls[0].query).toContain('x402_ring_wallets');
	});

	it('attaches the clip sequence and pole flag a routine was sold with', async () => {
		sqlState.queue.push([
			{ ...sampleRow, ticket_id: 't-2', dance: 'combo', clip: 'rumba', label: 'Full Combo' },
			{ ...sampleRow, ticket_id: 't-3', dance: 'twerk', clip: 'twerk', label: 'Pole Twerk' },
		]);
		const { body } = await invoke();
		const [combo, twerk] = body.tips;
		expect(combo.sequence.map((s) => s.clip)).toEqual(['rumba', 'capoeira', 'thriller', 'silly', 'dance']);
		expect(combo.durationSec).toBe(18);
		expect(twerk.pole).toBe(true);
	});

	it('keeps a row whose style is no longer sold as-is', async () => {
		sqlState.queue.push([{ ...sampleRow, dance: 'retired-style' }]);
		const { body } = await invoke();
		expect(body.tips[0]).not.toHaveProperty('durationSec');
		expect(body.tips[0].clip).toBe('rumba');
	});

	it('defaults to limit=20 when not provided', async () => {
		sqlState.queue.push([]);
		await invoke();
		const call = sqlState.calls[0];
		expect(call.values).toEqual(expect.arrayContaining([20]));
	});

	it('clamps absurdly large limit to 100', async () => {
		sqlState.queue.push([]);
		await invoke({ query: { limit: '9999' } });
		const call = sqlState.calls[0];
		expect(call.values).toEqual(expect.arrayContaining([100]));
	});

	it('clamps non-positive limit to 1', async () => {
		sqlState.queue.push([]);
		await invoke({ query: { limit: '0' } });
		const call = sqlState.calls[0];
		expect(call.values).toEqual(expect.arrayContaining([1]));
	});

	it('falls back to default when limit is non-numeric', async () => {
		sqlState.queue.push([]);
		await invoke({ query: { limit: 'banana' } });
		const call = sqlState.calls[0];
		expect(call.values).toEqual(expect.arrayContaining([20]));
	});

	it('filters by dancer when the query is provided', async () => {
		sqlState.queue.push([sampleRow]);
		await invoke({ query: { dancer: '2' } });
		const call = sqlState.calls[0];
		expect(call.query).toMatch(/where dancer = \?/i);
		expect(call.values).toEqual(expect.arrayContaining(['2']));
	});

	it('truncates pathologically long dancer values to 4 chars (defense-in-depth)', async () => {
		sqlState.queue.push([]);
		await invoke({ query: { dancer: '1234567890' } });
		const call = sqlState.calls[0];
		expect(call.values).toEqual(expect.arrayContaining(['1234']));
	});

	it('handles OPTIONS preflight without hitting the DB', async () => {
		const { status } = await invoke({ method: 'OPTIONS', headers: { origin: 'https://example.com' } });
		expect(status).toBe(204);
		expect(sqlState.calls).toHaveLength(0);
	});

	it('rejects non-GET methods with 405', async () => {
		const { status, body } = await invoke({ method: 'POST' });
		expect(status).toBe(405);
		expect(body?.error).toBe('method_not_allowed');
	});
});
