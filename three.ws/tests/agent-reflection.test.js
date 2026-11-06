import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the data + LLM layers so we can drive runReflection deterministically.
const sqlMock = vi.fn();
vi.mock('../api/_lib/db.js', () => ({ sql: sqlMock, isDbUnavailableError: () => false, isDbCapacityError: () => false }));

class LlmUnavailableError extends Error {
	constructor() {
		super('no provider');
		this.code = 'llm_unavailable';
		this.status = 503;
	}
}
const llmCompleteMock = vi.fn();
vi.mock('../api/_lib/llm.js', () => ({
	llmComplete: (...a) => llmCompleteMock(...a),
	LlmUnavailableError,
}));

const {
	parseInsightPayload,
	validateInsight,
	runReflection,
	MIN_NEW_SIGNALS,
} = await import('../api/_lib/reflection.js');

const ID_A = '11111111-1111-1111-1111-111111111111';
const ID_B = '22222222-2222-2222-2222-222222222222';
const ID_C = '33333333-3333-3333-3333-333333333333';

beforeEach(() => {
	sqlMock.mockReset();
	llmCompleteMock.mockReset();
});

// Helper: feed runReflection a scripted sequence of sql() results, in call order.
function scriptSql(results) {
	let i = 0;
	sqlMock.mockImplementation(() => Promise.resolve(results[i++] ?? []));
}

describe('parseInsightPayload', () => {
	it('parses a bare JSON object', () => {
		expect(parseInsightPayload('{"insights":[]}')).toEqual({ insights: [] });
	});
	it('parses JSON inside a ```json fence', () => {
		const txt = 'Here you go:\n```json\n{"insights":[{"statement":"x"}]}\n```';
		expect(parseInsightPayload(txt)).toEqual({ insights: [{ statement: 'x' }] });
	});
	it('parses JSON wrapped in stray prose', () => {
		const txt = 'Sure! {"insights":[{"statement":"y"}]} hope that helps';
		expect(parseInsightPayload(txt)).toEqual({ insights: [{ statement: 'y' }] });
	});
	it('returns null on unparseable output', () => {
		expect(parseInsightPayload('not json at all')).toBeNull();
		expect(parseInsightPayload('')).toBeNull();
		expect(parseInsightPayload(null)).toBeNull();
	});
});

describe('validateInsight — provenance + schema', () => {
	const ids = new Set([ID_A, ID_B]);

	it('drops an insight with no cited source memories (provenance mandatory)', () => {
		expect(validateInsight({ statement: 'no sources', source_memory_ids: [] }, ids)).toBeNull();
	});

	it('drops an insight whose cited ids are not in the provided context', () => {
		expect(validateInsight({ statement: 'fabricated', source_memory_ids: [ID_C] }, ids)).toBeNull();
	});

	it('filters cited ids down to the real ones and de-dupes', () => {
		const v = validateInsight(
			{ statement: 'real', source_memory_ids: [ID_A, ID_A, ID_C] },
			ids,
		);
		expect(v).not.toBeNull();
		expect(v.sourceIds).toEqual([ID_A]);
	});

	it('clamps proposed salience into the elevated band and defaults type', () => {
		const v = validateInsight(
			{ statement: 's', source_memory_ids: [ID_A], proposed_salience: 5, proposed_type: 'bogus' },
			ids,
		);
		expect(v.proposedSalience).toBeLessThanOrEqual(0.95);
		expect(v.proposedSalience).toBeGreaterThanOrEqual(0.5);
		expect(v.proposedType).toBe('project');
	});

	it('reclassifies a low-confidence insight with a question as kind=question', () => {
		const v = validateInsight(
			{ statement: 's', source_memory_ids: [ID_A], confidence: 0.3, question: 'Do you prefer X?' },
			ids,
		);
		expect(v.kind).toBe('question');
		expect(v.question).toBe('Do you prefer X?');
	});

	it('rejects an empty or oversized statement', () => {
		expect(validateInsight({ statement: '', source_memory_ids: [ID_A] }, ids)).toBeNull();
		expect(validateInsight({ statement: 'x'.repeat(1001), source_memory_ids: [ID_A] }, ids)).toBeNull();
	});
});

describe('runReflection — eligibility gates', () => {
	it('skips (and logs a run) when there is not enough new material', async () => {
		// gather: lastRun, runs-count, lastOk, memories, actions, then recordRun insert
		scriptSql([
			[], // lastRun (none)
			[{ runs: 0 }], // daily count
			[], // lastOk (none)
			[{ id: ID_A, type: 'user', content: 'a', tags: [], salience: 0.5, created_at: new Date() }], // 1 memory
			[], // actions
			[{ id: 'run1', created_at: new Date() }], // recordRun insert
		]);
		const res = await runReflection({ agentId: 'agent-1', trigger: 'cron' });
		expect(res.status).toBe('skipped');
		expect(res.reason).toMatch(/not enough new material/);
		expect(res.created).toEqual([]);
		expect(llmCompleteMock).not.toHaveBeenCalled();
		expect(MIN_NEW_SIGNALS).toBeGreaterThan(1);
	});

	it('persists only groundable dreams from a real model pass', async () => {
		const now = new Date();
		const mems = [
			{ id: ID_A, type: 'user', content: 'asked about settlement speed', tags: [], salience: 0.6, created_at: now },
			{ id: ID_B, type: 'project', content: 'wants finality over fees', tags: [], salience: 0.6, created_at: now },
			{ id: ID_C, type: 'reference', content: 'reads $THREE alerts daily', tags: [], salience: 0.6, created_at: now },
		];
		scriptSql([
			[], // lastRun
			[{ runs: 0 }], // daily count
			[], // lastOk
			mems, // memories (3 → enough signal)
			[], // actions
			[], // rejected
			[{ id: 'run-ok', created_at: now }], // recordRun (ok)
			[{
				id: 'dream-1', agent_id: 'agent-1', status: 'pending', kind: 'belief',
				statement: 'You prioritize finality over fees.', rationale: 'from 2 memories',
				confidence: 0.8, source_memory_ids: [ID_A, ID_B], proposed_type: 'user',
				proposed_salience: 0.85, proposed_action: null, question: null,
				run_id: 'run-ok', accepted_memory_id: null, created_at: now, reviewed_at: null,
			}], // reflection insert RETURNING *
		]);
		llmCompleteMock.mockResolvedValue({
			text: JSON.stringify({
				insights: [
					// valid — cites real ids
					{ kind: 'belief', statement: 'You prioritize finality over fees.', confidence: 0.8, source_memory_ids: [ID_A, ID_B], proposed_type: 'user', proposed_salience: 0.85 },
					// invalid — no real provenance, must be dropped (not inserted)
					{ kind: 'insight', statement: 'fabricated', confidence: 0.9, source_memory_ids: ['99999999-9999-9999-9999-999999999999'] },
				],
			}),
			provider: 'groq', model: 'llama-3.3-70b-versatile', usage: { input: 100, output: 50 },
		});

		const res = await runReflection({ agentId: 'agent-1', userId: 'user-1', trigger: 'on-demand', agent: { name: 'Aria' } });
		expect(res.status).toBe('ok');
		expect(res.candidates).toBe(2); // model proposed 2
		expect(res.created).toHaveLength(1); // only the groundable one persisted
		expect(res.created[0].statement).toMatch(/finality over fees/);
		expect(res.created[0].sourceMemoryIds).toEqual([ID_A, ID_B]);
		expect(llmCompleteMock).toHaveBeenCalledOnce();
	});

	it('records an error run when the model output is unparseable', async () => {
		const now = new Date();
		const mems = [
			{ id: ID_A, type: 'user', content: 'a', tags: [], salience: 0.6, created_at: now },
			{ id: ID_B, type: 'user', content: 'b', tags: [], salience: 0.6, created_at: now },
			{ id: ID_C, type: 'user', content: 'c', tags: [], salience: 0.6, created_at: now },
		];
		scriptSql([[], [{ runs: 0 }], [], mems, [], [], [{ id: 'run-err', created_at: now }]]);
		llmCompleteMock.mockResolvedValue({ text: 'totally not json', provider: 'groq', model: 'm', usage: {} });
		const res = await runReflection({ agentId: 'agent-1', trigger: 'cron' });
		expect(res.status).toBe('error');
		expect(res.reason).toMatch(/unparseable/);
	});
});
