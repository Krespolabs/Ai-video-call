// Unit tests for the AI bounty judge's pure normalisation logic.
//
// The judge feeds untrusted model output back into a poster-facing UI, so the
// normaliser must be defensive: drop hallucinated ids, clamp scores, sort, and
// never trust the model's recommended id blindly. These tests pin that contract
// without touching the LLM, DB, or cache.

import { describe, it, expect } from 'vitest';
import { buildJudgePrompt, normalizeJudgement, extractJson } from '../api/_lib/bounty-judge.js';

const IDS = [
	'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
	'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
	'cccccccc-cccc-cccc-cccc-cccccccccccc',
];

describe('extractJson', () => {
	it('parses a bare JSON object', () => {
		expect(extractJson('{"a":1}')).toEqual({ a: 1 });
	});

	it('parses JSON wrapped in a ```json fence', () => {
		expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
	});

	it('parses JSON embedded in prose by brace-slicing', () => {
		expect(extractJson('Here is my verdict: {"a":1} — done.')).toEqual({ a: 1 });
	});

	it('returns null for non-JSON', () => {
		expect(extractJson('no json here')).toBeNull();
		expect(extractJson('')).toBeNull();
	});
});

describe('normalizeJudgement', () => {
	const valid = new Set(IDS);

	it('keeps only known ids, clamps scores, and sorts best-first', () => {
		const raw = JSON.stringify({
			summary: 'A clear winner.',
			recommended_id: IDS[1],
			rankings: [
				{ submission_id: IDS[0], score: 40, verdict: 'ok' },
				{ submission_id: IDS[1], score: 150, verdict: 'great' }, // clamps to 100
				{
					submission_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
					score: 99,
					verdict: 'fake',
				}, // dropped
				{ submission_id: IDS[2], score: -5, verdict: 'bad' }, // clamps to 0
			],
		});
		const out = normalizeJudgement(raw, valid);
		expect(out.rankings.map((r) => r.submission_id)).toEqual([IDS[1], IDS[0], IDS[2]]);
		expect(out.rankings.map((r) => r.score)).toEqual([100, 40, 0]);
		expect(out.recommended_id).toBe(IDS[1]);
	});

	it('falls back to the top-ranked id when recommended_id is invalid', () => {
		const raw = JSON.stringify({
			recommended_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
			rankings: [
				{ submission_id: IDS[0], score: 70 },
				{ submission_id: IDS[1], score: 90 },
			],
		});
		const out = normalizeJudgement(raw, valid);
		expect(out.recommended_id).toBe(IDS[1]); // highest score
	});

	it('de-duplicates repeated submission ids', () => {
		const raw = JSON.stringify({
			rankings: [
				{ submission_id: IDS[0], score: 50 },
				{ submission_id: IDS[0], score: 80 },
			],
		});
		const out = normalizeJudgement(raw, valid);
		expect(out.rankings).toHaveLength(1);
		expect(out.rankings[0].score).toBe(50); // first occurrence wins
	});

	it('handles non-numeric scores as 0', () => {
		const raw = JSON.stringify({
			rankings: [{ submission_id: IDS[0], score: 'not a number' }],
		});
		const out = normalizeJudgement(raw, valid);
		expect(out.rankings[0].score).toBe(0);
	});

	it('throws when output is unparseable', () => {
		expect(() => normalizeJudgement('garbage', valid)).toThrow();
	});

	it('throws when no rankings reference a real submission', () => {
		const raw = JSON.stringify({
			rankings: [{ submission_id: 'ffffffff-ffff-ffff-ffff-ffffffffffff', score: 90 }],
		});
		expect(() => normalizeJudgement(raw, valid)).toThrow();
	});
});

describe('buildJudgePrompt', () => {
	const bounty = {
		title: 'Do a backflip on camera',
		description: 'Must be one continuous shot.',
	};
	const subs = [
		{
			id: IDS[0],
			username: 'alice',
			content: 'Here is my flip',
			media_url: 'https://x.com/a',
			media_type: 'link',
			like_count: 3,
		},
		{ id: IDS[1], username: 'bob', content: '', media_url: null, like_count: 0 },
	];

	it('includes every submission id and the bounty title in the user prompt', () => {
		const { user, system } = buildJudgePrompt(bounty, subs);
		for (const id of [IDS[0], IDS[1]]) expect(user).toContain(id);
		expect(user).toContain('Do a backflip on camera');
		expect(user).toContain('community_likes: 3');
		expect(user).toContain('[no media attached]');
		// The judge must be instructed to emit JSON-only and stay coin-agnostic.
		expect(system.toLowerCase()).toContain('json');
		expect(system.toLowerCase()).toContain('coin');
	});
});
