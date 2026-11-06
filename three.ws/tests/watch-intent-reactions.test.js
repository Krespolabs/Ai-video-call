// Validation + throttle decisioning for spectator reactions on watch-intent.
// These are the pure rules the endpoint enforces; testing them here keeps the
// allowlist and throttle math honest without booting the serverless handler.

import { describe, it, expect } from 'vitest';
import {
	REACTION_EMOJI,
	normalizeReaction,
	isAllowedReaction,
	shouldThrottleReaction,
	REACTION_THROTTLE_MS,
	reactionsRecentKey,
	reactionsTotalKey,
	reactionThrottleKey,
} from '../api/_lib/reaction-rules.js';

describe('normalizeReaction', () => {
	it('accepts every allowlisted emoji as itself', () => {
		for (const e of REACTION_EMOJI) expect(normalizeReaction(e)).toBe(e);
	});

	it('trims surrounding whitespace', () => {
		expect(normalizeReaction('  🔥 ')).toBe('🔥');
	});

	it('reconciles the bare heart without its variation selector', () => {
		expect(normalizeReaction('❤')).toBe('❤️');
	});

	it('rejects anything off the allowlist', () => {
		expect(normalizeReaction('💀')).toBeNull();
		expect(normalizeReaction('🔥🔥')).toBeNull();
		expect(normalizeReaction('not-an-emoji')).toBeNull();
	});

	it('rejects non-strings and empty input', () => {
		expect(normalizeReaction(null)).toBeNull();
		expect(normalizeReaction(undefined)).toBeNull();
		expect(normalizeReaction(42)).toBeNull();
		expect(normalizeReaction('')).toBeNull();
		expect(normalizeReaction('   ')).toBeNull();
	});
});

describe('isAllowedReaction', () => {
	it('mirrors normalizeReaction as a boolean', () => {
		expect(isAllowedReaction('🚀')).toBe(true);
		expect(isAllowedReaction('💩')).toBe(false);
	});
});

describe('shouldThrottleReaction', () => {
	const now = 1_000_000;

	it('allows the first reaction (no prior timestamp)', () => {
		expect(shouldThrottleReaction(null, now)).toBe(false);
		expect(shouldThrottleReaction(0, now)).toBe(false);
		expect(shouldThrottleReaction(undefined, now)).toBe(false);
	});

	it('throttles a reaction inside the window', () => {
		expect(shouldThrottleReaction(now - 100, now)).toBe(true);
	});

	it('allows a reaction once the window has elapsed', () => {
		expect(shouldThrottleReaction(now - REACTION_THROTTLE_MS, now)).toBe(false);
		expect(shouldThrottleReaction(now - REACTION_THROTTLE_MS - 1, now)).toBe(false);
	});

	it('honours a custom window', () => {
		expect(shouldThrottleReaction(now - 500, now, 1000)).toBe(true);
		expect(shouldThrottleReaction(now - 1500, now, 1000)).toBe(false);
	});
});

describe('redis key helpers', () => {
	const agentId = '550e8400-e29b-41d4-a716-446655440000';

	it('namespace per agent and per IP', () => {
		expect(reactionsRecentKey(agentId)).toBe(`agent:screen:${agentId}:reactions`);
		expect(reactionsTotalKey(agentId)).toBe(`agent:screen:${agentId}:rtotal`);
		expect(reactionThrottleKey(agentId, '1.2.3.4')).toBe(`screen:react:t:${agentId}:1.2.3.4`);
	});
});
