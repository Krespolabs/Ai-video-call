import { describe, it, expect } from 'vitest';
import { resolveSocialReward, resolveGithubReward, SOCIAL_PLATFORM_ID } from '../api/_lib/github-reward.js';

// These exercise the no-DB paths (missing identity → unresolved) so they run
// without a database. The wallet / social_pda paths are covered by integration.

describe('SOCIAL_PLATFORM_ID', () => {
	it('matches the pump.fun SDK Platform enum', () => {
		expect(SOCIAL_PLATFORM_ID).toEqual({ pump: 0, x: 1, github: 2 });
	});
});

describe('resolveSocialReward', () => {
	it('returns unresolved (no DB hit) when no identity is given', async () => {
		const r = await resolveSocialReward({ platform: 'x' });
		expect(r.platform).toBe('x');
		expect(r.mode).toBe('unresolved');
		expect(r.address).toBeNull();
		expect(r.note).toMatch(/X account/);
	});
	it('defaults the platform to github', async () => {
		const r = await resolveSocialReward({});
		expect(r.platform).toBe('github');
		expect(r.note).toMatch(/GitHub user/);
	});
});

describe('resolveGithubReward (back-compat wrapper)', () => {
	it('preserves the original github_* field shape', async () => {
		const r = await resolveGithubReward({});
		expect(r).toHaveProperty('github_username');
		expect(r).toHaveProperty('github_user_id');
		expect(r.mode).toBe('unresolved');
	});
});
