// Provider failover for the reconstruct (selfie / text → 3D) submit path.
//
// getRegenProviderCandidates() enumerates every configured platform provider in
// precedence order so handleReconstruct can fail over from one to the next
// instead of dead-ending at a 502 when a single provider is down, throttled, or
// out of credits. These tests pin the ordering, de-duplication, and the
// "nothing configured" empty result.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getRegenProviderCandidates } from '../../api/_lib/regen-provider.js';

const PROVIDER_ENV = [
	'AVATAR_REGEN_PROVIDER',
	'REPLICATE_API_TOKEN',
	'GCP_RECONSTRUCTION_URL',
	'GCP_RECONSTRUCTION_KEY',
	'HF_TOKEN',
];

describe('getRegenProviderCandidates — failover ordering', () => {
	let saved;

	beforeEach(() => {
		saved = {};
		for (const k of PROVIDER_ENV) {
			saved[k] = process.env[k];
			delete process.env[k];
		}
	});

	afterEach(() => {
		for (const k of PROVIDER_ENV) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	it('returns no candidates when nothing is configured', async () => {
		const candidates = await getRegenProviderCandidates();
		expect(candidates).toEqual([]);
	});

	it('returns the single configured platform provider', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const names = (await getRegenProviderCandidates()).map((c) => c.name);
		expect(names).toEqual(['replicate']);
	});

	it('enumerates multiple configured providers in paid → free order', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		process.env.GCP_RECONSTRUCTION_URL = 'https://recon.example.com';
		process.env.GCP_RECONSTRUCTION_KEY = 'gcp_test_key';
		const names = (await getRegenProviderCandidates()).map((c) => c.name);
		expect(names).toEqual(['replicate', 'gcp']);
	});

	it('puts the explicit AVATAR_REGEN_PROVIDER first, then the rest, de-duplicated', async () => {
		process.env.AVATAR_REGEN_PROVIDER = 'gcp';
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		process.env.GCP_RECONSTRUCTION_URL = 'https://recon.example.com';
		process.env.GCP_RECONSTRUCTION_KEY = 'gcp_test_key';
		const names = (await getRegenProviderCandidates()).map((c) => c.name);
		expect(names).toEqual(['gcp', 'replicate']);
		// No provider appears twice even though gcp is named explicitly and inferred.
		expect(new Set(names).size).toBe(names.length);
	});

	it('skips a provider whose credentials are absent', async () => {
		// URL present but KEY missing — the gcp constructor throws and the
		// candidate is skipped rather than blocking replicate.
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		process.env.GCP_RECONSTRUCTION_URL = 'https://recon.example.com';
		const names = (await getRegenProviderCandidates()).map((c) => c.name);
		expect(names).toEqual(['replicate']);
	});

	it('each candidate exposes a usable instance', async () => {
		process.env.REPLICATE_API_TOKEN = 'r8_test_token';
		const candidates = await getRegenProviderCandidates();
		expect(candidates).toHaveLength(1);
		expect(typeof candidates[0].instance?.submit).toBe('function');
	});
});
