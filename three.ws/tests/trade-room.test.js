import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';

// The loaders import the database client; everything under test is pure.
vi.mock('../api/_lib/db.js', () => ({ sql: () => Promise.resolve([]) }));

// Presence reads Redis through this singleton; each test picks the client.
let redisClient = null;
vi.mock('../api/_lib/redis.js', () => ({ getRedis: () => redisClient }));

const {
	positionEvents, eventsSince, roomState, rankRooms, sanitizeSession, streamStartCursor,
	STREAM_SINCE_MAX_AGE_MS, LIVE_WINDOW_MS, WARM_WINDOW_MS,
} = await import('../api/_lib/trade-room.js');
const presence = await import('../api/_lib/trade-room-presence.js');
const model = await import('../src/trade-room/model.js');

const SIG_BUY = '4M7puu2FyPbLqtW9fML9QaNuupCpGDhw3xh26EHA7PJcUdwY1TkfdxDnregfuUcqp8fPxLrBMtcvnxnhHNXxswhW';
const SIG_SELL = '2zMLQ2E8spH2toFyAyhvkroyw8akATyrgdYkzvW6fzWLRB4Xyfwv76FrgotiQvNKXoSjE9LonAVNUkFvVuReprC4';
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

/** A closed live round-trip on $THREE. Tests override one field at a time. */
function row(over = {}) {
	return {
		id: '11111111-2222-3333-4444-555555555555',
		agent_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
		mint: THREE,
		symbol: 'THREE',
		name: 'three.ws',
		status: 'closed',
		exit_reason: 'trailing_stop',
		entry_quote_lamports: '2000000',
		exit_quote_lamports: '1379766',
		last_value_lamports: '1379766',
		realized_pnl_lamports: '-620234',
		realized_pnl_pct: '-31.0117',
		buy_sig: SIG_BUY,
		sell_sig: SIG_SELL,
		opened_at: '2026-09-29T06:08:17.327Z',
		closed_at: '2026-09-29T06:09:12.197Z',
		last_quoted_at: '2026-09-29T06:09:10.000Z',
		...over,
	};
}

describe('positionEvents', () => {
	it('turns a closed round-trip into a sell then its buy, newest first', () => {
		const [sell, buy] = positionEvents([row()]);
		expect(sell).toMatchObject({
			id: '11111111-2222-3333-4444-555555555555:sell',
			kind: 'sell',
			at: '2026-09-29T06:09:12.197Z',
			size_sol: 0.001379766,
			pnl_sol: -0.000620234,
			exit_label: 'Trailing stop',
			hold_seconds: 55,
			share_url: '/trade/11111111-2222-3333-4444-555555555555',
			paper: false,
		});
		expect(sell.tx_url).toBe(`https://solscan.io/tx/${SIG_SELL}`);
		expect(buy).toMatchObject({ kind: 'buy', size_sol: 0.002, entry_sol: 0.002, at: '2026-09-29T06:08:17.327Z' });
		expect(buy.tx_url).toBe(`https://solscan.io/tx/${SIG_BUY}`);
		expect(buy.share_url).toBeUndefined();
	});

	it('shows an open position as a buy only', () => {
		const events = positionEvents([row({ status: 'open', closed_at: null, sell_sig: null })]);
		expect(events.map((e) => e.kind)).toEqual(['buy']);
	});

	it('never shows a failed position as a trade', () => {
		expect(positionEvents([row({ status: 'failed', buy_sig: null })])).toEqual([]);
		expect(positionEvents([row({ status: 'opening', buy_sig: null })])).toEqual([]);
	});

	it('labels paper fills and gives them no Solscan link', () => {
		const [sell, buy] = positionEvents([row({ buy_sig: 'SIMULATED', sell_sig: 'SIMULATED' })]);
		expect(buy.paper).toBe(true);
		expect(sell.paper).toBe(true);
		expect(buy.tx_url).toBeNull();
		expect(sell.tx_url).toBeNull();
	});

	it('links devnet trades to the devnet explorer', () => {
		const [sell] = positionEvents([row()], { network: 'devnet' });
		expect(sell.tx_url).toBe(`https://solscan.io/tx/${SIG_SELL}?cluster=devnet`);
	});

	it('merges several positions by time and honours the limit', () => {
		const older = row({ id: 'p-old', opened_at: '2026-09-29T05:00:00.000Z', closed_at: '2026-09-29T05:10:00.000Z' });
		const events = positionEvents([older, row()], { limit: 3 });
		expect(events.map((e) => e.id)).toEqual([
			'11111111-2222-3333-4444-555555555555:sell',
			'11111111-2222-3333-4444-555555555555:buy',
			'p-old:sell',
		]);
	});
});

describe('eventsSince', () => {
	const opened = Date.parse('2026-09-29T06:08:17.327Z');

	it('emits the buy before the sell when both land inside one poll', () => {
		const { trades } = eventsSince([row()], opened - 1000);
		expect(trades.map((t) => t.kind)).toEqual(['buy', 'sell']);
	});

	it('skips what the page already painted', () => {
		const { trades } = eventsSince([row()], opened);
		expect(trades.map((t) => t.kind)).toEqual(['sell']);
	});

	it('emits a quote for an open position whose value moved', () => {
		const open = row({ status: 'open', closed_at: null, sell_sig: null, last_value_lamports: '2500000' });
		const { trades, quotes } = eventsSince([open], opened + 1000);
		expect(trades).toEqual([]);
		expect(quotes).toHaveLength(1);
		expect(quotes[0]).toMatchObject({ position_id: open.id, current_sol: 0.0025 });
		expect(quotes[0].unrealized_pct).toBeCloseTo(25, 6);
	});

	it('does not quote a closed position', () => {
		expect(eventsSince([row()], Date.parse('2026-09-29T06:09:13.000Z')).quotes).toEqual([]);
	});
});

describe('roomState', () => {
	const now = Date.parse('2026-09-29T12:00:00.000Z');
	const ago = (ms) => new Date(now - ms).toISOString();

	it('is live while a position is open, however old the last fill', () => {
		expect(roomState({ lastTradeAt: ago(3 * WARM_WINDOW_MS), openCount: 1, now })).toBe('live');
	});
	it('is live inside the live window', () => {
		expect(roomState({ lastTradeAt: ago(LIVE_WINDOW_MS - 1), now })).toBe('live');
	});
	it('cools to warm, then quiet', () => {
		expect(roomState({ lastTradeAt: ago(LIVE_WINDOW_MS + 1), now })).toBe('warm');
		expect(roomState({ lastTradeAt: ago(WARM_WINDOW_MS + 1), now })).toBe('quiet');
	});
	it('is quiet for a leader who never traded', () => {
		expect(roomState({ lastTradeAt: null, now })).toBe('quiet');
		expect(roomState({ lastTradeAt: 'not a date', now })).toBe('quiet');
	});
});

describe('rankRooms', () => {
	it('puts live rooms first, then by spectators, then by recency', () => {
		const ranked = rankRooms([
			{ agent_id: 'quiet', state: 'quiet', spectators: 9, last_trade_at: '2026-09-01T00:00:00Z' },
			{ agent_id: 'warm-old', state: 'warm', spectators: 0, last_trade_at: '2026-09-29T01:00:00Z' },
			{ agent_id: 'warm-new', state: 'warm', spectators: 0, last_trade_at: '2026-09-29T02:00:00Z' },
			{ agent_id: 'live', state: 'live', spectators: 0, last_trade_at: '2026-09-29T03:00:00Z' },
			{ agent_id: 'warm-watched', state: 'warm', spectators: 3, last_trade_at: '2026-09-28T23:00:00Z' },
		]);
		expect(ranked.map((r) => r.agent_id)).toEqual(['live', 'warm-watched', 'warm-new', 'warm-old', 'quiet']);
	});
});

describe('stream inputs', () => {
	it('accepts only short plain session ids', () => {
		expect(sanitizeSession('a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
		expect(sanitizeSession('short')).toBeNull();
		expect(sanitizeSession('x'.repeat(41))).toBeNull();
		expect(sanitizeSession('has space 12345')).toBeNull();
		expect(sanitizeSession(null)).toBeNull();
	});

	it('clamps the stream start to a recent, non-future instant', () => {
		const now = Date.parse('2026-09-29T12:00:00.000Z');
		expect(streamStartCursor(undefined, now)).toBe(now);
		expect(streamStartCursor('garbage', now)).toBe(now);
		expect(streamStartCursor('2026-09-29T13:00:00.000Z', now)).toBe(now);
		expect(streamStartCursor('2026-09-29T11:58:00.000Z', now)).toBe(now - 120_000);
		expect(streamStartCursor('2026-09-01T00:00:00.000Z', now)).toBe(now - STREAM_SINCE_MAX_AGE_MS);
	});
});

describe('spectator presence', () => {
	const AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
	beforeEach(() => {
		presence._resetLocalPresence();
		redisClient = null;
	});

	it('counts in-process when Redis is not configured, and ages sessions out', async () => {
		const t0 = 1_000_000;
		expect(await presence.touchSpectator(AGENT, 'session-aaaa', t0)).toBe('instance');
		await presence.touchSpectator(AGENT, 'session-bbbb', t0);
		expect(await presence.countSpectators(AGENT, t0 + 1)).toEqual({ count: 2, scope: 'instance' });
		await presence.leaveSpectator(AGENT, 'session-aaaa');
		expect((await presence.countSpectators(AGENT, t0 + 1)).count).toBe(1);
		expect((await presence.countSpectators(AGENT, t0 + presence.SPECTATOR_TTL_MS + 1)).count).toBe(0);
	});

	it('uses the shared sorted set when Redis answers', async () => {
		const sets = new Map();
		redisClient = {
			zadd: async (k, { score, member }) => { if (!sets.has(k)) sets.set(k, new Map()); sets.get(k).set(member, score); return 1; },
			expire: async () => 1,
			zrem: async (k, m) => { sets.get(k)?.delete(m); return 1; },
			zcount: async (k, min) => [...(sets.get(k)?.values() || [])].filter((s) => s >= min).length,
		};
		expect(await presence.touchSpectator(AGENT, 'session-aaaa', 5_000)).toBe('shared');
		expect(await presence.countSpectators(AGENT, 5_001)).toEqual({ count: 1, scope: 'shared' });
		const many = await presence.countSpectatorsMany([AGENT, 'other-agent'], 5_001);
		expect(many.get(AGENT)).toBe(1);
		expect(many.get('other-agent')).toBe(0);
		await presence.leaveSpectator(AGENT, 'session-aaaa');
		expect((await presence.countSpectators(AGENT, 5_001)).count).toBe(0);
	});

	it('falls back to the in-process count when Redis errors', async () => {
		const boom = async () => { throw new Error('down'); };
		redisClient = { zadd: boom, expire: boom, zrem: boom, zcount: boom };
		expect(await presence.touchSpectator(AGENT, 'session-aaaa', 10)).toBe('instance');
		expect(await presence.countSpectators(AGENT, 11)).toEqual({ count: 1, scope: 'instance' });
		expect((await presence.countSpectatorsMany([AGENT], 11)).get(AGENT)).toBe(1);
	});
});

describe('trade room client model', () => {
	const sell = positionEvents([row()])[0];
	const buy = positionEvents([row()])[1];

	it('reads a trade as one plain sentence', () => {
		expect(model.tradeLine(buy)).toBe('Bought $THREE for 0.002 ◎');
		expect(model.tradeLine(sell, 'Crosshair')).toBe('Crosshair sold $THREE for 0.00138 ◎, −31.0% on trailing stop');
		expect(model.tradeLine({ ...buy, paper: true })).toBe('Paper-bought $THREE for 0.002 ◎');
	});

	it('picks a reaction clip that exists in the animation manifest', () => {
		const manifest = JSON.parse(readFileSync(new URL('../public/animations/manifest.json', import.meta.url), 'utf8'));
		const names = new Set(manifest.map((d) => d.name));
		const cases = [buy, sell, { ...sell, pnl_pct: 0.2 }, { ...sell, pnl_pct: 12 }, { ...sell, pnl_pct: 80 }, { ...sell, pnl_pct: -5 }];
		for (const t of cases) expect(names.has(model.reactionFor(t))).toBe(true);
		expect(model.reactionFor(buy)).toBe('point');
		expect(model.reactionFor(sell)).toBe('defeated');
		expect(model.reactionFor({ ...sell, pnl_pct: 80 })).toBe('av-cheering');
	});

	it('merges live trades newest first without duplicates', () => {
		let list = model.mergeTrade([], buy);
		list = model.mergeTrade(list, sell);
		list = model.mergeTrade(list, sell);
		expect(list.map((t) => t.kind)).toEqual(['sell', 'buy']);
		expect(model.mergeTrade(list, { ...buy, id: 'x', at: '2026-09-29T07:00:00Z' }, 2)).toHaveLength(2);
	});

	it('parses the room id from the URL', () => {
		const id = '6287faf3-d41b-43cb-97bb-d305c1ac6e45';
		expect(model.roomIdFromLocation('/trade-rooms')).toEqual({ id: '', invalid: false });
		expect(model.roomIdFromLocation(`/trade-rooms/${id}/`)).toEqual({ id, invalid: false });
		expect(model.roomIdFromLocation(`/trade-rooms/${id.toUpperCase()}`)).toEqual({ id, invalid: false });
		expect(model.roomIdFromLocation('/trade-rooms', `?agent=${id}`)).toEqual({ id, invalid: false });
		expect(model.roomIdFromLocation('/trade-rooms/not-a-room')).toEqual({ id: '', invalid: true });
	});

	it('backs off the stream reconnect up to 30s', () => {
		expect([0, 1, 2, 3, 10].map(model.backoffMs)).toEqual([1000, 2000, 4000, 8000, 30000]);
	});

	it('writes an honest ticker for an empty room', () => {
		expect(model.tickerText([])).toBe('Waiting for the first trade');
		expect(model.lastTradedText(null)).toBe('No trades yet');
	});

	it('seats every spectator beside or behind the pedestal, facing it', () => {
		const seats = model.spectatorSeats(24);
		expect(seats).toHaveLength(24);
		for (const s of seats) {
			// Nobody stands between the camera (+z) and the leader.
			expect(Math.atan2(Math.abs(s.x), s.z)).toBeGreaterThan((80 * Math.PI) / 180);
			// Facing the pedestal: the seat's forward (+z rotated by ry) points at the origin.
			const fx = Math.sin(s.ry);
			const fz = Math.cos(s.ry);
			expect(fx * -s.x + fz * -s.z).toBeGreaterThan(0);
		}
	});

	it('mints URL-safe session ids the API accepts', () => {
		for (let i = 0; i < 5; i++) expect(sanitizeSession(model.newSessionId())).not.toBeNull();
	});
});
