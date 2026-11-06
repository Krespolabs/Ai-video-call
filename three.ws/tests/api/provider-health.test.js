// Tests for api/_lib/provider-health.js — the LLM provider circuit breaker.
// Runs against the in-memory cache fallback (no UPSTASH_* env), so no network.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Ensure the cache layer uses its in-memory fallback (not Redis).
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;

const { markProviderCooldown, providersInCooldown } = await import('../../api/_lib/provider-health.js');

const ALL = ['anthropic', 'groq', 'openrouter', 'openai'];

describe('provider-health circuit breaker', () => {
	it('reports no cooldowns before anything is marked', async () => {
		const cooling = await providersInCooldown(ALL);
		expect(cooling.size).toBe(0);
	});

	it('marks a provider in cooldown and reports it', async () => {
		await markProviderCooldown('groq', 30);
		const cooling = await providersInCooldown(ALL);
		expect(cooling.has('groq')).toBe(true);
		// Only the marked provider is cooling.
		expect(cooling.has('anthropic')).toBe(false);
		expect(cooling.has('openrouter')).toBe(false);
	});

	it('only surfaces a provider once it has actually been marked', async () => {
		// A name never marked is never reported as cooling.
		const fresh = await providersInCooldown(['never-marked-xyz']);
		expect(fresh.has('never-marked-xyz')).toBe(false);
		// After marking, it surfaces.
		await markProviderCooldown('openai', 30);
		const after = await providersInCooldown(['openai']);
		expect(after.has('openai')).toBe(true);
	});

	it('is best-effort: a falsy provider is a no-op, never throws', async () => {
		await expect(markProviderCooldown('')).resolves.toBeUndefined();
		await expect(markProviderCooldown(undefined)).resolves.toBeUndefined();
	});

	it('tags the cooldown reason so selection can tell a dead key from a throttle', async () => {
		// Default (transient throttle) reports 'health'; an explicit auth/billing
		// failure reports 'auth'. pickProvider() skips an *explicitly requested*
		// provider only when it is auth-cooled, so a deploy-wide-bad key is not
		// re-probed on attempt-0 of every request.
		await markProviderCooldown('groq', 30);
		await markProviderCooldown('anthropic', 30, 'auth');
		const cooling = await providersInCooldown(ALL);
		expect(cooling.get('groq')).toBe('health');
		expect(cooling.get('anthropic')).toBe('auth');
	});
});
