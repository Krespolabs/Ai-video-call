/**
 * Agent Memory Diary — pure layout/ranking + digest-shaping unit tests.
 *
 * Covers the deterministic math behind the Diary's memory graph and the
 * shaping the reflection digest relies on (counts, entity dedupe/ranking, link
 * mapping). The canvas renderer (AgentMemoryGraph) is intentionally NOT
 * constructed here — it needs a DOM; these tests exercise only the pure
 * functions it and api/agent-reflect-digest.js share.
 */

import { describe, it, expect } from 'vitest';
import {
	rankByMentions,
	entityHref,
	shapeDigestEntities,
	digestCounts,
	layoutGraph,
	ENTITY_KINDS,
} from '../src/agent-memory-graph.js';

describe('rankByMentions', () => {
	it('orders by mentions desc, then salience, then label — deterministically', () => {
		const nodes = [
			{ id: 'a', label: 'Bravo', mentions: 2, salience: 0.5 },
			{ id: 'b', label: 'Alpha', mentions: 5, salience: 0.2 },
			{ id: 'c', label: 'Charlie', mentions: 2, salience: 0.9 },
		];
		const ranked = rankByMentions(nodes).map((n) => n.id);
		// b (5) first; then the two 2-mention nodes by salience: c (0.9) > a (0.5).
		expect(ranked).toEqual(['b', 'c', 'a']);
	});

	it('breaks full ties by label so the order is stable across renders', () => {
		const nodes = [
			{ id: '1', label: 'Zeta', mentions: 3, salience: 0.5 },
			{ id: '2', label: 'Apple', mentions: 3, salience: 0.5 },
		];
		expect(rankByMentions(nodes).map((n) => n.label)).toEqual(['Apple', 'Zeta']);
	});

	it('drops entries without an id and never mutates the input', () => {
		const input = [{ id: 'x', mentions: 1 }, { mentions: 9 }, null];
		const out = rankByMentions(input);
		expect(out.map((n) => n.id)).toEqual(['x']);
		expect(input.length).toBe(3); // untouched
	});

	it('handles empty / nullish input', () => {
		expect(rankByMentions()).toEqual([]);
		expect(rankByMentions(null)).toEqual([]);
	});
});

describe('entityHref', () => {
	it('maps a mint to its addressable launch page (URL-encoded)', () => {
		const href = entityHref({ kind: 'mint', normalized: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump' });
		expect(href).toBe('/launches/FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump');
	});

	it('falls back to the label when a mint has no normalized form', () => {
		expect(entityHref({ kind: 'mint', label: 'So 11111' })).toBe('/launches/So%2011111');
	});

	it('resolves a person to an agent screen via a Map index', () => {
		const idx = new Map([['kestrel', 'agent-123']]);
		expect(entityHref({ kind: 'person', label: 'Kestrel' }, idx)).toBe('/agent-screen?agentId=agent-123');
	});

	it('resolves via a plain-object index too', () => {
		expect(entityHref({ kind: 'agent', label: 'Nova' }, { nova: 'a-9' })).toBe('/agent-screen?agentId=a-9');
	});

	it('returns null for an unresolved person and for non-addressable kinds', () => {
		expect(entityHref({ kind: 'person', label: 'Ghost' }, new Map())).toBeNull();
		expect(entityHref({ kind: 'topic', label: 'settlement' })).toBeNull();
		expect(entityHref({ kind: 'wallet', label: 'abc' })).toBeNull();
		expect(entityHref(null)).toBeNull();
	});
});

describe('shapeDigestEntities', () => {
	it('ranks, dedupes by id, caps to topN, and attaches resolved hrefs', () => {
		const nodes = [
			{ id: 'm1', kind: 'mint', normalized: 'MINT1', label: '$THREE', mentions: 9 },
			{ id: 'm1', kind: 'mint', normalized: 'MINT1', label: '$THREE', mentions: 9 }, // dup id
			{ id: 'p1', kind: 'person', label: 'Kestrel', mentions: 4 },
			{ id: 't1', kind: 'topic', label: 'liquidity', mentions: 1 },
		];
		const out = shapeDigestEntities(nodes, { topN: 2, agentIndex: new Map([['kestrel', 'ag-1']]) });
		expect(out).toHaveLength(2);
		expect(out[0]).toMatchObject({ id: 'm1', mentions: 9, href: '/launches/MINT1' });
		expect(out[1]).toMatchObject({ id: 'p1', href: '/agent-screen?agentId=ag-1' });
	});

	it('normalizes unknown kinds and truncates very long labels', () => {
		const long = 'x'.repeat(200);
		const [e] = shapeDigestEntities([{ id: 'z', kind: 'weird', label: long, mentions: 1 }]);
		expect(ENTITY_KINDS.includes(e.kind) || e.kind === 'weird').toBe(true);
		expect(e.label.length).toBeLessThanOrEqual(80);
		expect(e.href).toBeNull();
	});
});

describe('digestCounts', () => {
	it('derives learned/decided/interacted strictly from the rows', () => {
		const memories = [
			{ tags: ['decision'] },
			{ tags: [], context: { kind: 'decision' } },
			{ tags: ['note'] },
		];
		const entities = [
			{ kind: 'person' }, { kind: 'agent' }, { kind: 'mint' }, { kind: 'topic' },
		];
		expect(digestCounts(memories, entities)).toEqual({ learned: 3, decided: 2, interacted: 2 });
	});

	it('is honest about zero — no decisions, no people', () => {
		expect(digestCounts([{ tags: [] }], [{ kind: 'mint' }])).toEqual({ learned: 1, decided: 0, interacted: 0 });
		expect(digestCounts([], [])).toEqual({ learned: 0, decided: 0, interacted: 0 });
	});

	it('matches the "decided" tag case-insensitively', () => {
		expect(digestCounts([{ tags: ['Decided'] }], []).decided).toBe(1);
	});
});

describe('layoutGraph', () => {
	const W = 320, H = 220;

	it('returns nothing for an empty graph', () => {
		expect(layoutGraph([], [], { width: W, height: H })).toEqual([]);
	});

	it('centres the single most-mentioned node and makes it the brightest', () => {
		const nodes = [
			{ id: 'top', label: 'A', mentions: 10 },
			{ id: 'b', label: 'B', mentions: 1 },
			{ id: 'c', label: 'C', mentions: 1 },
		];
		const out = layoutGraph(nodes, [], { width: W, height: H });
		const top = out.find((n) => n.id === 'top');
		expect(top.x).toBeCloseTo(W / 2, 5);
		expect(top.y).toBeCloseTo(H / 2, 5);
		expect(top.brightness).toBe(1);
		// Brightest of all.
		expect(Math.max(...out.map((n) => n.brightness))).toBe(top.brightness);
	});

	it('keeps every node inside the padded bounds', () => {
		const nodes = Array.from({ length: 20 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, mentions: 20 - i }));
		const out = layoutGraph(nodes, [], { width: W, height: H, padding: 24 });
		for (const n of out) {
			expect(n.x).toBeGreaterThanOrEqual(24);
			expect(n.x).toBeLessThanOrEqual(W - 24);
			expect(n.y).toBeGreaterThanOrEqual(24);
			expect(n.y).toBeLessThanOrEqual(H - 24);
		}
	});

	it('caps the laid-out node count at maxNodes', () => {
		const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, label: `n${i}`, mentions: 100 - i }));
		const out = layoutGraph(nodes, [], { width: W, height: H, maxNodes: 12 });
		expect(out).toHaveLength(12);
	});

	it('is deterministic — identical input yields identical positions', () => {
		const nodes = [
			{ id: 'a', label: 'A', mentions: 5 },
			{ id: 'b', label: 'B', mentions: 3 },
			{ id: 'c', label: 'C', mentions: 2 },
		];
		const a = layoutGraph(nodes, [], { width: W, height: H });
		const b = layoutGraph(nodes, [], { width: W, height: H });
		expect(a).toEqual(b);
	});

	it('scales node radius with mention share', () => {
		const nodes = [
			{ id: 'big', label: 'big', mentions: 10 },
			{ id: 'small', label: 'small', mentions: 1 },
		];
		const out = layoutGraph(nodes, [], { width: W, height: H });
		const big = out.find((n) => n.id === 'big');
		const small = out.find((n) => n.id === 'small');
		expect(big.r).toBeGreaterThan(small.r);
	});
});
