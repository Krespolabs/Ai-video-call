// Forge: Content Generation Health (USE-072). The paid /api/x402/forge
// health_check mode runs ONE fast, real text completion over the platform's
// free-first LLM chain to canary the generative content lane, and must ALWAYS
// return a settled { generated, latency_ms, token_count } verdict — never throw —
// because a generator outage is the very signal the probe exists to catch. These
// prove the verdict shape, the latency-budget flag, the no-throw contract, and
// the autonomous registry entry that lifts the verdict into signal_data and
// raises/clears the forge performance alert.

import { describe, it, expect, vi } from 'vitest';

// State-driven mock of the LLM chain (mirrors the pattern in
// x402-thumbnail-regen.test.js): a single vi.fn impl defined in the factory,
// mutated per test via `llmState`. When `llmState.error` is set the completion
// rejects (generator outage); otherwise it resolves with `llmState.result` after
// an optional delay. The single awaiting consumer in runForgeHealthCheck handles
// the rejection, so vitest never sees an unhandled one.
const llmState = { result: null, error: null, delayMs: 0, lastArgs: null };
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: vi.fn(async (args) => {
		llmState.lastArgs = args;
		if (llmState.delayMs) await new Promise((r) => setTimeout(r, llmState.delayMs));
		if (llmState.error) throw llmState.error;
		return llmState.result;
	}),
}));

const { runForgeHealthCheck } = await import('../api/x402/forge.js');
const { getSelfRegistry } = await import('../api/_lib/x402/autonomous-registry.js');

function setLlm({ result = null, error = null, delayMs = 0 }) {
	llmState.result = result;
	llmState.error = error;
	llmState.delayMs = delayMs;
	llmState.lastArgs = null;
}

function forgeHealthEntry() {
	const entry = getSelfRegistry().find((e) => e.id === 'forge-content-health');
	expect(entry, 'forge-content-health entry must be registered').toBeTruthy();
	return entry;
}

describe('runForgeHealthCheck — content-generation verdict', () => {
	it('returns a generated verdict with the provider token count', async () => {
		setLlm({ result: { text: 'Solana is a high-throughput proof-of-stake blockchain.', provider: 'groq', model: 'llama-3.3-70b-versatile', usage: { input: 12, output: 11 } } });

		const r = await runForgeHealthCheck({ prompt: 'Write one sentence about Solana.' });

		expect(r.mode).toBe('health_check');
		expect(r.type).toBe('text');
		expect(r.generated).toBe(true);
		expect(r.token_count).toBe(11); // provider-reported output tokens
		expect(r.provider).toBe('groq');
		expect(typeof r.latency_ms).toBe('number');
		expect(r.within_budget).toBe(true);
		expect(r.sample).toContain('Solana');
	});

	it('falls back to a char/4 token estimate when usage is absent', async () => {
		setLlm({ result: { text: 'abcdefgh', provider: 'nvidia', model: 'x', usage: undefined } });
		const r = await runForgeHealthCheck({});
		expect(r.generated).toBe(true);
		expect(r.token_count).toBe(2); // ceil(8/4)
	});

	it('supplies its own default prompt when none is given', async () => {
		setLlm({ result: { text: 'ok', provider: 'groq', model: 'x', usage: { output: 1 } } });
		await runForgeHealthCheck({});
		expect(llmState.lastArgs.user).toBe('Write one sentence about Solana.');
	});

	it('flips within_budget false when the completion exceeds the 5s SLA', async () => {
		setLlm({ result: { text: 'slow', provider: 'groq', model: 'x', usage: { output: 1 } }, delayMs: 5010 });
		const r = await runForgeHealthCheck({});
		expect(r.generated).toBe(true);
		expect(r.within_budget).toBe(false);
		expect(r.latency_ms).toBeGreaterThan(5000);
	}, 10_000);

	it('never throws — a generator outage settles as generated:false', async () => {
		setLlm({ error: Object.assign(new Error('no provider'), { code: 'llm_unavailable' }) });
		const r = await runForgeHealthCheck({ prompt: 'Write one sentence about Solana.' });
		expect(r.generated).toBe(false);
		expect(r.token_count).toBe(0);
		expect(r.within_budget).toBe(false);
		expect(r.error).toBe('llm_unavailable');
	});
});

describe('registry entry — extractSignal lifts the verdict into signal_data', () => {
	it('marks a healthy fast probe', () => {
		const sig = forgeHealthEntry().extractSignal({
			mode: 'health_check', type: 'text', generated: true,
			latency_ms: 820, token_count: 14, within_budget: true,
			provider: 'groq', model: 'llama-3.3-70b-versatile',
		});
		expect(sig).toMatchObject({ generated: true, latency_ms: 820, token_count: 14, slow: false });
	});

	it('flags a slow probe (>5s) as slow', () => {
		const sig = forgeHealthEntry().extractSignal({ generated: true, latency_ms: 6200, token_count: 9, within_budget: false });
		expect(sig.slow).toBe(true);
	});

	it('carries the failure verdict through', () => {
		const sig = forgeHealthEntry().extractSignal({ generated: false, latency_ms: 4100, token_count: 0, error: 'generation_failed' });
		expect(sig.generated).toBe(false);
		expect(sig.error).toBe('generation_failed');
		expect(sig.slow).toBe(false); // 4.1s is within budget; failure is signalled by generated:false
	});

	it('has the health pipeline wiring the spec requires', () => {
		const entry = forgeHealthEntry();
		expect(entry.pipeline).toBe('health');
		expect(entry.path).toBe('/api/x402/forge');
		expect(entry.method).toBe('POST');
		expect(entry.body).toEqual({ mode: 'health_check', type: 'text', prompt: 'Write one sentence about Solana.' });
		expect(entry.cooldown_s).toBe(600);
	});
});

describe('registry entry — storeValue raises/clears the forge performance alert', () => {
	function mockRedis() {
		const store = new Map();
		return {
			store,
			set: vi.fn((k, v) => { store.set(k, v); return Promise.resolve('OK'); }),
			del: vi.fn((k) => { store.delete(k); return Promise.resolve(1); }),
		};
	}

	it('sets the alert key when the probe is slow', async () => {
		const redis = mockRedis();
		await forgeHealthEntry().storeValue({ redis, signalData: { generated: true, slow: true, latency_ms: 6100, provider: 'groq' } });
		expect(redis.set).toHaveBeenCalledTimes(1);
		const [key, payload, opts] = redis.set.mock.calls[0];
		expect(key).toBe('x402:forge-health:alert');
		expect(JSON.parse(payload).reason).toBe('latency_budget_exceeded');
		expect(opts.ex).toBeGreaterThan(0);
	});

	it('sets the alert key when generation failed', async () => {
		const redis = mockRedis();
		await forgeHealthEntry().storeValue({ redis, signalData: { generated: false, slow: false, error: 'llm_unavailable' } });
		expect(redis.set).toHaveBeenCalledTimes(1);
		expect(JSON.parse(redis.set.mock.calls[0][1]).reason).toBe('generation_failed');
	});

	it('clears the alert key when healthy again', async () => {
		const redis = mockRedis();
		await forgeHealthEntry().storeValue({ redis, signalData: { generated: true, slow: false, latency_ms: 700 } });
		expect(redis.del).toHaveBeenCalledWith('x402:forge-health:alert');
		expect(redis.set).not.toHaveBeenCalled();
	});

	it('never throws without a redis client', async () => {
		await expect(forgeHealthEntry().storeValue({ redis: null, signalData: { generated: false } })).resolves.toBeUndefined();
	});
});
