import { describe, it, expect } from 'vitest';

import {
	TOOL_NAME,
	ALERT_THRESHOLD,
	readRegistration,
	evaluateHealthy,
} from '../api/x402/solana-register-health.js';
import { getFullRegistry } from '../api/_lib/x402/autonomous-registry.js';

describe('solana-register-health — registration coordinate extraction', () => {
	it('reads a mainnet enrolment off meta', () => {
		const reg = readRegistration({
			sol_mint_address: 'AssetMain111',
			agent_registry: { identity_pda: 'PdaMain111', registration_uri: 'https://three.ws/r.json' },
		});
		expect(reg.network).toBe('mainnet');
		expect(reg.asset).toBe('AssetMain111');
		expect(reg.registry.identity_pda).toBe('PdaMain111');
	});

	it('falls back to devnet when no mainnet asset is present', () => {
		const reg = readRegistration({
			devnet: { sol_mint_address: 'AssetDev111', agent_registry: { identity_pda: 'PdaDev111' } },
		});
		expect(reg.network).toBe('devnet');
		expect(reg.asset).toBe('AssetDev111');
		expect(reg.registry.identity_pda).toBe('PdaDev111');
	});

	it('returns an unregistered shape for empty/missing meta (never throws)', () => {
		for (const meta of [null, undefined, {}, { foo: 'bar' }]) {
			const reg = readRegistration(meta);
			expect(reg.network).toBe('mainnet');
			expect(reg.asset).toBeNull();
			expect(reg.registry).toBeNull();
		}
	});

	it('prefers mainnet over devnet when both exist', () => {
		const reg = readRegistration({
			sol_mint_address: 'AssetMain111',
			agent_registry: { identity_pda: 'PdaMain111' },
			devnet: { sol_mint_address: 'AssetDev111', agent_registry: { identity_pda: 'PdaDev111' } },
		});
		expect(reg.network).toBe('mainnet');
		expect(reg.asset).toBe('AssetMain111');
	});
});

describe('solana-register-health — health verdict', () => {
	it('is healthy only when enrolled AND both accounts resolve on-chain', () => {
		expect(evaluateHealthy({ registry_enrolled: true, asset_onchain: true, identity_pda_onchain: true })).toBe(true);
	});

	it('is unhealthy when any single check fails', () => {
		expect(evaluateHealthy({ registry_enrolled: false, asset_onchain: true, identity_pda_onchain: true })).toBe(false);
		expect(evaluateHealthy({ registry_enrolled: true, asset_onchain: false, identity_pda_onchain: true })).toBe(false);
		expect(evaluateHealthy({ registry_enrolled: true, asset_onchain: true, identity_pda_onchain: false })).toBe(false);
	});

	it('is unhealthy on a missing/garbage checks object (never throws)', () => {
		expect(evaluateHealthy(undefined)).toBe(false);
		expect(evaluateHealthy({})).toBe(false);
		expect(evaluateHealthy(null)).toBe(false);
	});

	it('exposes a sane alert threshold and canonical tool name', () => {
		expect(ALERT_THRESHOLD).toBeGreaterThanOrEqual(1);
		expect(TOOL_NAME).toBe('solana_register');
	});
});

describe('solana-register-health — autonomous registry wiring', () => {
	it('is registered as an enabled, 6-hour health canary on the paid endpoint', () => {
		const entry = getFullRegistry().find((e) => e.id === 'mcp-solana-register-health');
		expect(entry).toBeTruthy();
		expect(entry.enabled).toBe(true);
		expect(entry.pipeline).toBe('health');
		expect(entry.method).toBe('GET');
		expect(entry.cooldown_s).toBe(21600);
		expect(entry.path).toBe('/api/x402/solana-register-health');
		expect(typeof entry.extractSignal).toBe('function');
	});

	it('extractSignal lifts the health verdict from a healthy response', () => {
		const entry = getFullRegistry().find((e) => e.id === 'mcp-solana-register-health');
		const sig = entry.extractSignal({
			healthy: true, tool: 'solana_register', network: 'mainnet',
			canary_agent_id: 'agent-1', asset: 'Asset111', identity_pda: 'Pda111',
			checks: { registry_enrolled: true, asset_onchain: true, identity_pda_onchain: true },
			consecutive_failures: 0, rpc_latency_ms: 142,
		});
		expect(sig.alive).toBe(true);
		expect(sig.registry_enrolled).toBe(true);
		expect(sig.asset_onchain).toBe(true);
		expect(sig.identity_pda_onchain).toBe(true);
		expect(sig.asset).toBe('Asset111');
	});

	it('extractSignal marks alive:false for an unhealthy response without throwing', () => {
		const entry = getFullRegistry().find((e) => e.id === 'mcp-solana-register-health');
		const sig = entry.extractSignal({
			healthy: false, tool: 'solana_register', network: 'mainnet',
			checks: { registry_enrolled: true, asset_onchain: false, identity_pda_onchain: true },
			consecutive_failures: 4,
		});
		expect(sig.alive).toBe(false);
		expect(sig.asset_onchain).toBe(false);
		expect(sig.consecutive_failures).toBe(4);
	});

	it('extractSignal tolerates an empty/garbage body', () => {
		const entry = getFullRegistry().find((e) => e.id === 'mcp-solana-register-health');
		expect(() => entry.extractSignal(null)).not.toThrow();
		expect(entry.extractSignal(null).alive).toBe(false);
		expect(entry.extractSignal({}).tool).toBe('solana_register');
	});
});
