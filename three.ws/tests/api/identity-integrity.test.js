// api/_lib/identity-integrity — the Granite identity-integrity gate. Exercises
// the verdict logic (impersonation block, self-resemblance review, Guardian
// content block, clear, and degrade-without-watsonx) with all watsonx/DB calls
// mocked, so it runs offline and deterministically.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/_lib/db.js', () => ({ sql: vi.fn(), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../../api/_lib/watsonx.js', () => ({
	watsonxConfig: vi.fn(),
	watsonxEmbed: vi.fn(),
}));
vi.mock('../../api/_lib/agent-embeddings.js', async (importOriginal) => {
	const actual = await importOriginal();
	return { ...actual, readAgentVectors: vi.fn(), agentEmbedders: vi.fn(actual.agentEmbedders) };
});
vi.mock('../../api/_lib/granite-guardian.js', async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		guardianConfig: vi.fn(() => ({ configured: true, model: 'ibm/granite-guardian-3-8b', wx: {} })),
		assess: vi.fn(),
	};
});

import { sql } from '../../api/_lib/db.js';
import { watsonxConfig, watsonxEmbed } from '../../api/_lib/watsonx.js';
import { readAgentVectors, agentEmbedders } from '../../api/_lib/agent-embeddings.js';
import { guardianConfig, assess } from '../../api/_lib/granite-guardian.js';
import { checkIdentityIntegrity } from '../../api/_lib/identity-integrity.js';

const ME = '11111111-1111-1111-1111-111111111111';
const OTHER = '22222222-2222-2222-2222-222222222222';
const AGENT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

// A candidate with enough text to clear the min-signal threshold for blocking.
const CANDIDATE = { name: 'Granite Oracle', description: 'Forecasts live Solana token prices with IBM Granite.' };

// Cosine on these is exact: identical → 1.0, orthogonal → 0.
const SAME = [1, 0, 0];
const ORTHO = [0, 1, 0];

function safeVerdicts() {
	return [{ risk: 'harm', label: 'Harm', flagged: false, probability: 0.04, confidence: 'high', model: 'g' }];
}

beforeEach(() => {
	vi.clearAllMocks();
	watsonxConfig.mockReturnValue({ configured: true, embedModel: 'ibm/granite-embedding-278m-multilingual' });
	watsonxEmbed.mockResolvedValue({ vectors: [SAME], model: 'ibm/granite-embedding-278m-multilingual', dimensions: 3 });
	guardianConfig.mockReturnValue({ configured: true, model: 'ibm/granite-guardian-3-8b', wx: {} });
	assess.mockResolvedValue(safeVerdicts());
});

describe('checkIdentityIntegrity', () => {
	it('blocks an identity that impersonates another owner\'s public agent', async () => {
		sql.mockResolvedValue([
			{ id: AGENT_A, name: 'Granite Oracle', description: 'forecasts solana prices', user_id: OTHER, is_public: true },
		]);
		readAgentVectors.mockResolvedValue(new Map([[AGENT_A, SAME]]));

		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(r.configured).toBe(true);
		expect(r.status).toBe('block');
		expect(r.duplicateOf).toEqual({ id: AGENT_A, name: 'Granite Oracle', score: 1 });
		expect(r.uniqueness).toBe(0);
		expect(r.reasons[0]).toMatch(/impersonation/i);
	});

	it('does not block when the look-alike is one of your own agents (review only)', async () => {
		sql.mockResolvedValue([
			{ id: AGENT_A, name: 'My Oracle', description: 'forecasts solana prices', user_id: ME, is_public: false },
		]);
		readAgentVectors.mockResolvedValue(new Map([[AGENT_A, SAME]]));

		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(r.status).toBe('review');
		expect(r.duplicateOf).toBeNull();
		expect(r.similar[0].owned).toBe(true);
		expect(r.reasons[0]).toMatch(/your own/i);
	});

	it('blocks when Granite Guardian flags the identity content', async () => {
		sql.mockResolvedValue([
			{ id: AGENT_A, name: 'Unrelated', description: 'a totally different agent', user_id: OTHER, is_public: true },
		]);
		readAgentVectors.mockResolvedValue(new Map([[AGENT_A, ORTHO]])); // not similar
		assess.mockResolvedValue([
			{ risk: 'harm', label: 'Harm', flagged: true, probability: 0.95, confidence: 'high', model: 'g' },
		]);

		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(r.status).toBe('block');
		expect(r.guardian.decision).toBe('block');
		expect(r.reasons.join(' ')).toMatch(/guardian/i);
	});

	it('clears a distinct, clean identity', async () => {
		sql.mockResolvedValue([
			{ id: AGENT_A, name: 'Unrelated', description: 'a totally different agent', user_id: OTHER, is_public: true },
		]);
		readAgentVectors.mockResolvedValue(new Map([[AGENT_A, ORTHO]]));

		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(r.status).toBe('clear');
		expect(r.duplicateOf).toBeNull();
		expect(r.uniqueness).toBe(1);
		expect(r.similar[0].score).toBe(0);
	});

	it('degrades to unavailable (never blocks) when no embedder and no Guardian lane is configured', async () => {
		watsonxConfig.mockReturnValue({ configured: false });
		agentEmbedders.mockReturnValueOnce([]);
		guardianConfig.mockReturnValue({ configured: false, model: 'ibm/granite-guardian-3-8b', wx: {} });
		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(r.configured).toBe(false);
		expect(r.status).toBe('unavailable');
		expect(sql).not.toHaveBeenCalled();
		expect(watsonxEmbed).not.toHaveBeenCalled();
	});

	it('lists but never scores neighbours from a non-Granite embedder', async () => {
		watsonxConfig.mockReturnValue({ configured: false });
		agentEmbedders.mockReturnValueOnce([
			{ provider: 'platform', model: 'nvidia/nemotron-3-embed-1b@2048', embedQuery: async () => SAME },
		]);
		sql.mockResolvedValue([
			{ id: AGENT_A, name: 'Granite Oracle', description: 'forecasts solana prices', user_id: OTHER, is_public: true },
		]);
		readAgentVectors.mockResolvedValue(new Map([[AGENT_A, SAME]]));

		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(readAgentVectors).toHaveBeenCalledWith([AGENT_A], { model: 'nvidia/nemotron-3-embed-1b@2048' });
		expect(r.configured).toBe(true);
		expect(r.status).toBe('clear');
		expect(r.similarityScored).toBe(false);
		expect(r.uniqueness).toBeNull();
		expect(r.duplicateOf).toBeNull();
		expect(r.similar[0]).toMatchObject({ id: AGENT_A, score: 1 });
		expect(r.model.embed).toBe('nvidia/nemotron-3-embed-1b@2048');
	});

	it('still blocks on Granite Guardian when only the Guardian lane is configured', async () => {
		watsonxConfig.mockReturnValue({ configured: false });
		agentEmbedders.mockReturnValueOnce([]);
		assess.mockResolvedValue([
			{ risk: 'harm', label: 'Harm', flagged: true, probability: 0.95, confidence: 'high', model: 'ibm-granite/granite-guardian-3.3-8b' },
		]);

		const r = await checkIdentityIntegrity(CANDIDATE, { userId: ME });
		expect(r.status).toBe('block');
		expect(r.model.guardian).toBe('ibm-granite/granite-guardian-3.3-8b');
	});

	it('returns clear with no text to evaluate', async () => {
		const r = await checkIdentityIntegrity({ name: '', description: '' }, { userId: ME });
		expect(r.configured).toBe(true);
		expect(r.status).toBe('clear');
		expect(r.uniqueness).toBe(1);
	});
});
