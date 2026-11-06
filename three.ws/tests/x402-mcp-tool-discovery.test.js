import { describe, it, expect } from 'vitest';

import { getSelfRegistry } from '../api/_lib/x402/autonomous-registry.js';

// A representative /api/x402/mcp-tool-catalog (mode:discover) response.
const SAMPLE = {
	ok: true,
	mode: 'discover',
	total_tools: 35,
	priced_tools: 7,
	free_tools: 28,
	new_tools: [
		{ name: 'segment_model', description: 'Split a mesh into named parts', priced: true, price_usdc: 0.04, input_fields: 2 },
		{ name: 'text_to_animation', description: 'Generate an animation from text', priced: false, price_usdc: null, input_fields: 5 },
	],
	changed_tools: [
		{ name: 'render_avatar', change: 'price', price_usdc: 0.005, prev_price_usdc: 0.003, priced: true },
	],
	removed_tools: ['legacy_tool'],
	ts: '2026-06-28T10:00:00Z',
};

describe('autonomous registry — mcp-tool-discovery entry', () => {
	const entry = getSelfRegistry().find((e) => e.id === 'mcp-tool-discovery');

	it('exists, is enabled, POST discover, discovery pipeline, 2h cooldown', () => {
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.method).toBe('POST');
		expect(entry.pipeline).toBe('discovery');
		expect(entry.cooldown_s).toBe(7200);
		expect(entry.path).toBe('/api/x402/mcp-tool-catalog');
		expect(entry.body).toEqual({ mode: 'discover' });
	});

	it('extractSignal lifts the diff into the actionable signal shape', () => {
		const sig = entry.extractSignal(SAMPLE);
		expect(sig.total_tools).toBe(35);
		expect(sig.priced_tools).toBe(7);
		expect(sig.free_tools).toBe(28);
		// new_tools is flattened to a name list for feature flagging.
		expect(sig.new_tools).toEqual(['segment_model', 'text_to_animation']);
		expect(sig.new_count).toBe(2);
		expect(sig.changed_count).toBe(1);
		expect(sig.removed_tools).toEqual(['legacy_tool']);
	});

	it('extractSignal is null-safe on an empty/failed response', () => {
		const sig = entry.extractSignal({});
		expect(sig.total_tools).toBeNull();
		expect(sig.new_tools).toEqual([]);
		expect(sig.new_count).toBe(0);
		expect(sig.changed_count).toBe(0);
		expect(sig.removed_tools).toEqual([]);
	});
});
