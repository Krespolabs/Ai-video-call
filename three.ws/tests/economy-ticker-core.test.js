import { describe, it, expect } from 'vitest';
import {
	formatUsd,
	shortAddr,
	relTime,
	flowHeadline,
	rowHref,
	flowExplorer,
	summarizeFlows,
	hottestEarner,
	KIND_COLORS,
} from '../src/economy-ticker-core.js';

// A flow shaped exactly like /api/galaxy/flows → shapeFlow output.
const tip = (over = {}) => ({
	id: 'c1',
	kind: 'tip',
	direction: 'in',
	ts: '2026-06-23T12:00:00.000Z',
	usd: 12.5,
	sol: 0.5,
	actor: { id: 'agent-A', name: 'Nova', wallet: 'NOVAwallet' },
	counterparty: { id: 'agent-B', name: 'Atlas', wallet: 'ATLASwallet' },
	from: { id: 'agent-B', name: 'Atlas', wallet: 'ATLASwallet' },
	to: { id: 'agent-A', name: 'Nova', wallet: 'NOVAwallet' },
	explorer: 'https://solscan.io/tx/SIGTIP',
	mint_explorer: null,
	...over,
});

describe('formatUsd', () => {
	it('formats ranges and drops non-positive', () => {
		expect(formatUsd(0)).toBe('');
		expect(formatUsd(-5)).toBe('');
		expect(formatUsd(0.4)).toBe('$0.40');
		expect(formatUsd(42)).toBe('$42');
		expect(formatUsd(12500)).toBe('$12,500');
		expect(formatUsd(2_400_000)).toBe('$2.40M');
	});
});

describe('shortAddr', () => {
	it('truncates long addresses, passes short/empty', () => {
		expect(shortAddr('ABCDEFGHIJKLMNOP')).toBe('ABCD…MNOP');
		expect(shortAddr('short')).toBe('short');
		expect(shortAddr(null)).toBe('');
	});
});

describe('relTime', () => {
	it('renders compact ages against an injected now', () => {
		const now = new Date('2026-06-23T12:00:30.000Z').getTime();
		expect(relTime('2026-06-23T12:00:00.000Z', now)).toBe('30s');
		expect(relTime('2026-06-23T11:55:30.000Z', now)).toBe('5m');
		expect(relTime('2026-06-23T09:00:00.000Z', now)).toBe('3h');
		expect(relTime('bad-date', now)).toBe('');
	});
});

describe('flowHeadline', () => {
	it('reads naturally per kind and never invents a counterparty', () => {
		expect(flowHeadline(tip())).toBe('Atlas tipped Nova');
		expect(flowHeadline(tip({ kind: 'launch', symbol: 'THREE' }))).toBe('Nova launched $THREE');
		expect(
			flowHeadline(tip({ kind: 'payment', direction: 'out', to: { id: 'agent-C', name: 'Sol' } })),
		).toBe('Nova paid Sol');
		// one-sided trade against the market (no resolved counterparty)
		expect(
			flowHeadline(tip({ kind: 'trade', direction: 'out', to: { id: null, wallet: 'DEXpool123456' } })),
		).toBe('Nova traded with DEXp…3456');
	});
});

describe('rowHref + flowExplorer', () => {
	it('prefers the agent profile, then explorer, then galaxy', () => {
		expect(rowHref(tip())).toBe('/agents/agent-A');
		expect(rowHref(tip({ actor: { id: null }, explorer: 'https://solscan.io/tx/X' }))).toBe(
			'https://solscan.io/tx/X',
		);
		expect(rowHref(tip({ actor: { id: null }, explorer: null }))).toBe('/galaxy');
	});
	it('returns the real explorer link, mint for launches', () => {
		expect(flowExplorer(tip())).toBe('https://solscan.io/tx/SIGTIP');
		expect(flowExplorer(tip({ kind: 'launch', explorer: null, mint_explorer: 'https://solscan.io/account/M' }))).toBe(
			'https://solscan.io/account/M',
		);
	});
});

describe('summarizeFlows', () => {
	it('counts flows, sums usd, and only counts resolved agent↔agent edges', () => {
		const flows = [
			tip(), // edge (A↔B)
			tip({ id: 'c2', kind: 'trade', direction: 'out', usd: 5, counterparty: { id: null, wallet: 'DEX' }, to: { id: null, wallet: 'DEX' } }), // flare
			tip({ id: 'l1', kind: 'launch', usd: null, counterparty: null, to: null }), // launch
		];
		const s = summarizeFlows(flows);
		expect(s.count).toBe(3);
		expect(s.usd).toBe(17.5);
		expect(s.edges).toBe(1);
		expect(s.byKind.tip).toBe(1);
		expect(s.byKind.launch).toBe(1);
	});
	it('is null-safe', () => {
		expect(summarizeFlows(null).count).toBe(0);
	});
});

describe('hottestEarner', () => {
	it('credits inbound USD to the receiving agent and returns the top', () => {
		const flows = [
			tip({ id: 't1', usd: 10 }), // Nova receives 10
			tip({ id: 't2', usd: 25 }), // Nova receives 25 → 35 total
			tip({ id: 'p1', kind: 'payment', direction: 'out', usd: 50, to: { id: 'agent-C', name: 'Sol', wallet: 'SOLw' } }), // Sol receives 50
		];
		const hot = hottestEarner(flows);
		expect(hot.id).toBe('agent-C');
		expect(hot.usd).toBe(50);
		expect(hot.count).toBe(1);
	});
	it('ignores outbound trades and unpriced/unresolved flows', () => {
		const flows = [
			tip({ id: 'x1', kind: 'trade', direction: 'out', usd: 999, to: { id: 'agent-Z', name: 'Z' } }), // trade, not earnings
			tip({ id: 'x2', usd: null }), // unpriced
			tip({ id: 'x3', usd: 5, to: { id: null, wallet: 'bare' } }), // unresolved receiver
		];
		expect(hottestEarner(flows)).toBeNull();
	});
	it('is null-safe', () => {
		expect(hottestEarner(undefined)).toBeNull();
	});
});

describe('KIND_COLORS', () => {
	it('uses the wallet-violet accent for payments (shared with Money-Cam)', () => {
		expect(KIND_COLORS.payment).toBe('#c4b5fd');
	});
});
