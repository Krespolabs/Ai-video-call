import { describe, it, expect } from 'vitest';
import {
	encodeCursor,
	decodeCursor,
	shapeFlow,
	isAgentEdge,
	txExplorerUrl,
	accountExplorerUrl,
	TYPE_KINDS,
	PUBLIC_SPEND_CATEGORIES,
} from '../api/_lib/galaxy-flows.js';

describe('galaxy-flows cursor', () => {
	it('round-trips a (ts, rowId) cursor', () => {
		const ts = '2026-06-23T12:34:56.000Z';
		const c = encodeCursor(ts, 'c123');
		const decoded = decodeCursor(c);
		expect(decoded).toEqual({ ts, rowId: 'c123' });
	});

	it('rejects malformed cursors', () => {
		expect(decodeCursor(null)).toBeNull();
		expect(decodeCursor('')).toBeNull();
		expect(decodeCursor('not-base64-!!!')).toBeNull();
		// base64 of "abc|" → missing rowId
		expect(decodeCursor(Buffer.from('abc|', 'utf8').toString('base64url'))).toBeNull();
	});
});

describe('explorer urls', () => {
	it('builds mainnet + devnet tx urls and null-safes', () => {
		expect(txExplorerUrl('SIG', 'mainnet')).toBe('https://solscan.io/tx/SIG');
		expect(txExplorerUrl('SIG', 'devnet')).toBe('https://solscan.io/tx/SIG?cluster=devnet');
		expect(txExplorerUrl(null, 'mainnet')).toBeNull();
		expect(accountExplorerUrl('ADDR', 'mainnet')).toBe('https://solscan.io/account/ADDR');
		expect(accountExplorerUrl(null, 'mainnet')).toBeNull();
	});
});

describe('type filter map', () => {
	it('keeps trades + payments + launches separable, never leaks private categories', () => {
		expect(TYPE_KINDS.tips).toEqual(['tip']);
		expect(TYPE_KINDS.trades).toEqual(['trade', 'snipe']);
		expect(TYPE_KINDS.all).toContain('launch');
		expect(PUBLIC_SPEND_CATEGORIES).not.toContain('withdraw');
		expect(PUBLIC_SPEND_CATEGORIES).not.toContain('vanity_swap');
	});
});

const TIP_ROW = {
	ts: new Date('2026-06-23T12:00:00Z'),
	kind: 'tip',
	direction: 'in',
	row_id: 'c1',
	network: 'mainnet',
	actor_id: 'agent-A',
	actor_name: 'Nova',
	actor_addr: 'NOVAwallet',
	actor_vp: 'NOVA',
	actor_vs: null,
	asset: 'SOL',
	amount_lamports: '500000000',
	amount_raw: null,
	usd: 12.5,
	signature: 'SIGTIP',
	counterparty_addr: 'SENDERwallet',
	counterparty_id: 'agent-B',
	counterparty_name: 'Atlas',
	mint: null,
	symbol: null,
	coin_name: null,
};

describe('shapeFlow — tip (inbound, agent↔agent)', () => {
	const f = shapeFlow(TIP_ROW);
	it('points the edge sender → receiver', () => {
		expect(f.direction).toBe('in');
		expect(f.from.id).toBe('agent-B'); // counterparty sent
		expect(f.to.id).toBe('agent-A'); // actor received
	});
	it('derives sol + explorer + iso ts', () => {
		expect(f.sol).toBe(0.5);
		expect(f.usd).toBe(12.5);
		expect(f.explorer).toBe('https://solscan.io/tx/SIGTIP');
		expect(f.ts).toBe('2026-06-23T12:00:00.000Z');
	});
	it('is a real agent edge', () => {
		expect(isAgentEdge(f)).toBe(true);
	});
});

describe('shapeFlow — spend (outbound, one-sided flare)', () => {
	const f = shapeFlow({
		...TIP_ROW,
		kind: 'trade',
		direction: 'out',
		row_id: 'c2',
		signature: 'SIGTRADE',
		counterparty_addr: 'DEXpool', // not a platform agent
		counterparty_id: null,
		counterparty_name: null,
	});
	it('flows out from the actor to a bare wallet', () => {
		expect(f.from.id).toBe('agent-A');
		expect(f.to.wallet).toBe('DEXpool');
		expect(f.to.id).toBeNull();
	});
	it('is NOT an agent edge (no second star) → renders as a flare', () => {
		expect(isAgentEdge(f)).toBe(false);
	});
});

describe('shapeFlow — launch (self event)', () => {
	const f = shapeFlow({
		...TIP_ROW,
		kind: 'launch',
		direction: 'launch',
		row_id: 'l1',
		signature: null,
		asset: null,
		amount_lamports: null,
		usd: null,
		counterparty_addr: null,
		counterparty_id: null,
		counterparty_name: null,
		mint: 'MINT123',
		symbol: 'THREE',
		coin_name: 'Three',
	});
	it('has the actor as source and no destination, with a mint explorer link', () => {
		expect(f.from.id).toBe('agent-A');
		expect(f.to).toBeNull();
		expect(f.mint_explorer).toBe('https://solscan.io/account/MINT123');
		expect(isAgentEdge(f)).toBe(false);
	});
});

describe('isAgentEdge — self-transfer is never an edge', () => {
	it('rejects counterparty === actor', () => {
		const f = shapeFlow({ ...TIP_ROW, counterparty_id: 'agent-A' });
		expect(isAgentEdge(f)).toBe(false);
	});
});
