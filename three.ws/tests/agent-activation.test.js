/**
 * Agent activation config — pure-helper unit tests.
 *
 * activationConfig gates a real, treasury-funded on-chain grant, so its env
 * parsing (enable flag, grant clamps, daily cap, treasury detection, network)
 * is pinned down here without a database or RPC. The full activateAgent path is
 * integration-tested against a live treasury; these guard the knobs that decide
 * whether — and how much — it spends.
 */

import { describe, it, expect } from 'vitest';
import { activationConfig, evaluateActivation } from '../api/_lib/agent-activation.js';

const SOL = 1_000_000_000;

describe('activationConfig', () => {
	it('is disabled and unconfigured for an empty env', () => {
		const c = activationConfig({});
		expect(c.enabled).toBe(false);
		expect(c.configured).toBe(false);
		expect(c.network).toBe('mainnet');
		expect(c.grantSol).toBe(0.004);
		expect(c.grantLamports).toBe(Math.round(0.004 * SOL));
		expect(c.dailyCap).toBe(500);
	});

	it('enables only on an explicit truthy flag', () => {
		expect(activationConfig({ AGENT_ACTIVATION_ENABLED: 'true' }).enabled).toBe(true);
		expect(activationConfig({ AGENT_ACTIVATION_ENABLED: '1' }).enabled).toBe(true);
		expect(activationConfig({ AGENT_ACTIVATION_ENABLED: 'yes' }).enabled).toBe(true);
		expect(activationConfig({ AGENT_ACTIVATION_ENABLED: 'false' }).enabled).toBe(false);
		expect(activationConfig({ AGENT_ACTIVATION_ENABLED: 'no' }).enabled).toBe(false);
		expect(activationConfig({ AGENT_ACTIVATION_ENABLED: 'maybe' }).enabled).toBe(false);
	});

	it('detects a treasury from either the override or the shared secret', () => {
		expect(activationConfig({ CIRCULATION_TREASURY_SECRET: 'abc' }).configured).toBe(true);
		expect(activationConfig({ AGENT_ACTIVATION_TREASURY_SECRET: 'xyz' }).configured).toBe(true);
		expect(activationConfig({ CIRCULATION_TREASURY_SECRET: '   ' }).configured).toBe(false);
	});

	it('clamps the grant to the safe 0.0001–0.05 SOL band', () => {
		expect(activationConfig({ AGENT_ACTIVATION_GRANT_SOL: '10' }).grantSol).toBe(0.05);
		expect(activationConfig({ AGENT_ACTIVATION_GRANT_SOL: '0' }).grantSol).toBe(0.0001);
		expect(activationConfig({ AGENT_ACTIVATION_GRANT_SOL: '-5' }).grantSol).toBe(0.0001);
		expect(activationConfig({ AGENT_ACTIVATION_GRANT_SOL: '0.01' }).grantSol).toBe(0.01);
		// non-numeric falls back to the default
		expect(activationConfig({ AGENT_ACTIVATION_GRANT_SOL: 'free' }).grantSol).toBe(0.004);
	});

	it('clamps the daily cap and keeps lamports in lockstep with grantSol', () => {
		expect(activationConfig({ AGENT_ACTIVATION_DAILY_CAP: '0' }).dailyCap).toBe(1);
		expect(activationConfig({ AGENT_ACTIVATION_DAILY_CAP: '999999999' }).dailyCap).toBe(100_000);
		const c = activationConfig({ AGENT_ACTIVATION_GRANT_SOL: '0.02' });
		expect(c.grantLamports).toBe(Math.round(0.02 * SOL));
	});

	it('honours the devnet network selector', () => {
		expect(activationConfig({ CIRCULATION_NETWORK: 'devnet' }).network).toBe('devnet');
		expect(activationConfig({ CIRCULATION_NETWORK: 'mainnet' }).network).toBe('mainnet');
		expect(activationConfig({ CIRCULATION_NETWORK: 'whatever' }).network).toBe('mainnet');
	});
});

describe('evaluateActivation (pure decision matrix)', () => {
	const base = { owner: true, circulation: false, status: null, enabled: true, configured: true };

	it('proceeds for a real, owned, eligible agent on a live platform', () => {
		expect(evaluateActivation(base)).toEqual({ decision: 'proceed', reason: null });
	});

	it('blocks a non-owner before anything else', () => {
		// non-owner outranks every other condition, including already-activated
		expect(evaluateActivation({ ...base, owner: false, status: 'confirmed' }))
			.toEqual({ decision: 'forbidden', reason: 'not_owner' });
	});

	it('treats circulation (platform) agents as already live', () => {
		expect(evaluateActivation({ ...base, circulation: true }))
			.toEqual({ decision: 'platform_agent', reason: 'platform_agent' });
	});

	it('is idempotent — confirmed returns "already", never re-grants', () => {
		expect(evaluateActivation({ ...base, status: 'confirmed' }))
			.toEqual({ decision: 'already', reason: 'already_activated' });
	});

	it('reports an in-flight pending claim rather than racing a second grant', () => {
		expect(evaluateActivation({ ...base, status: 'pending' }))
			.toEqual({ decision: 'pending', reason: 'in_progress' });
	});

	it('is not_configured when disabled OR when no treasury is set', () => {
		expect(evaluateActivation({ ...base, enabled: false }).decision).toBe('not_configured');
		expect(evaluateActivation({ ...base, configured: false }).decision).toBe('not_configured');
	});

	it('orders checks so ownership and idempotency win over config', () => {
		// already-confirmed beats not_configured (don't tell an activated owner it's off)
		expect(evaluateActivation({ ...base, status: 'confirmed', enabled: false }).decision).toBe('already');
	});
});
