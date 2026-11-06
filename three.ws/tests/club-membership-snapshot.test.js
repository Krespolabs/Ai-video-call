// Tests for the club membership snapshot logic added in USE-066.
//
// Covers: classifyMembership signal classification, extractSignal in the
// autonomous registry, and the numeric edge cases the autonomous loop may
// encounter (zero membership, single member, growth threshold boundary).

import { describe, it, expect } from 'vitest';
import { classifyMembership } from '../api/_lib/club/cover-pass.js';

// Mirror of the extractSignal closure from autonomous-registry.js — testing
// it inline keeps the test independent of the registry's DB imports.
function extractSignal(r) {
	return {
		topic: 'club:three_holders',
		club: r?.club ?? 'three_holders',
		member_count: r?.member_count ?? null,
		active_last_7d: r?.active_last_7d ?? null,
		new_this_week: r?.new_this_week ?? null,
		growth_rate: r?.growth_rate ?? null,
		active_rate: r?.active_rate ?? null,
		signal: r?.signal ?? null,
		headline: r?.headline ?? null,
		confidence: r?.confidence ?? null,
	};
}

describe('classifyMembership', () => {
	it('returns empty signal when member_count is 0', () => {
		const r = classifyMembership({ member_count: 0, active_last_7d: 0, new_this_week: 0 });
		expect(r.signal).toBe('empty');
		expect(r.member_count).toBe(0);
		expect(r.active_last_7d).toBe(0);
		expect(r.new_this_week).toBe(0);
		expect(r.growth_rate).toBe(0);
		expect(r.active_rate).toBe(0);
		expect(r.confidence).toBe(0.3);
		expect(r.headline).toMatch(/no club members/i);
	});

	it('returns growing when new_this_week / member_count >= 10%', () => {
		const r = classifyMembership({ member_count: 10, active_last_7d: 5, new_this_week: 2 });
		expect(r.signal).toBe('growing');
		expect(r.growth_rate).toBe(0.2);
		expect(r.headline).toMatch(/growing/i);
	});

	it('boundary: exactly 10% growth is growing', () => {
		const r = classifyMembership({ member_count: 10, active_last_7d: 5, new_this_week: 1 });
		expect(r.signal).toBe('growing');
	});

	it('returns churning when active_last_7d / member_count < 10%', () => {
		const r = classifyMembership({ member_count: 20, active_last_7d: 1, new_this_week: 0 });
		expect(r.signal).toBe('churning');
		expect(r.headline).toMatch(/churning/i);
	});

	it('returns stable for a healthy but slow-growing club', () => {
		const r = classifyMembership({ member_count: 100, active_last_7d: 40, new_this_week: 2 });
		expect(r.signal).toBe('stable');
		expect(r.active_rate).toBe(0.4);
	});

	it('attaches the club label', () => {
		const r = classifyMembership({ club: 'vip_room', member_count: 5, active_last_7d: 5, new_this_week: 1 });
		expect(r.club).toBe('vip_room');
	});

	it('defaults club to three_holders when not provided', () => {
		const r = classifyMembership({ member_count: 5, active_last_7d: 5, new_this_week: 1 });
		expect(r.club).toBe('three_holders');
	});

	it('clamps confidence to 0.95 for large memberships', () => {
		const r = classifyMembership({ member_count: 1000, active_last_7d: 500, new_this_week: 10 });
		expect(r.confidence).toBe(0.95);
	});

	it('returns confidence 0.3 for a single member (weak read)', () => {
		const r = classifyMembership({ member_count: 1, active_last_7d: 1, new_this_week: 1 });
		expect(r.confidence).toBe(0.3);
	});

	it('confidence scales linearly up to the 50-member mark', () => {
		const r = classifyMembership({ member_count: 25, active_last_7d: 20, new_this_week: 0 });
		// 25/50 = 0.5 → clamped to [0.3, 0.95] → 0.5
		expect(r.confidence).toBe(0.5);
	});

	it('coerces non-numeric inputs to 0 gracefully', () => {
		const r = classifyMembership({ member_count: '42', active_last_7d: null, new_this_week: undefined });
		expect(r.member_count).toBe(42);
		expect(r.active_last_7d).toBe(0);
		expect(r.new_this_week).toBe(0);
	});

	it('returns all required output fields', () => {
		const r = classifyMembership({ member_count: 10, active_last_7d: 3, new_this_week: 1 });
		for (const key of ['club', 'member_count', 'active_last_7d', 'new_this_week',
			'growth_rate', 'active_rate', 'signal', 'headline', 'confidence']) {
			expect(r).toHaveProperty(key);
		}
	});
});

describe('extractSignal (registry closure)', () => {
	it('lifts all fields and sets topic correctly', () => {
		const response = {
			ok: true,
			mode: 'snapshot',
			club: 'three_holders',
			member_count: 50,
			active_last_7d: 20,
			new_this_week: 5,
			growth_rate: 0.1,
			active_rate: 0.4,
			signal: 'growing',
			headline: 'Club growing — 5 new members this week.',
			confidence: 0.85,
		};
		const s = extractSignal(response);
		expect(s.topic).toBe('club:three_holders');
		expect(s.club).toBe('three_holders');
		expect(s.member_count).toBe(50);
		expect(s.active_last_7d).toBe(20);
		expect(s.new_this_week).toBe(5);
		expect(s.growth_rate).toBe(0.1);
		expect(s.active_rate).toBe(0.4);
		expect(s.signal).toBe('growing');
		expect(s.headline).toMatch(/growing/i);
		expect(s.confidence).toBe(0.85);
	});

	it('handles a null response body without throwing', () => {
		const s = extractSignal(null);
		expect(s.topic).toBe('club:three_holders');
		expect(s.member_count).toBeNull();
		expect(s.signal).toBeNull();
	});

	it('handles a partial response (missing optional fields)', () => {
		const s = extractSignal({ member_count: 10 });
		expect(s.member_count).toBe(10);
		expect(s.active_last_7d).toBeNull();
		expect(s.new_this_week).toBeNull();
	});
});
