/**
 * Reasoning-trace stripper — unit tests.
 *
 * Covers the full-string helper and the streaming filter, including the cases
 * that matter for live chat: tags split across SSE chunk boundaries, partial
 * closers, unterminated traces, and stray "<" characters in normal prose that
 * must NOT be swallowed.
 */

import { describe, it, expect } from 'vitest';
import { stripReasoning, createReasoningStripper } from '../api/_lib/strip-reasoning.js';

// Feed a string through the streaming filter one chunk at a time and collect the
// emitted output, so we can assert that chunking never changes the result.
function streamThrough(chunks) {
	const s = createReasoningStripper();
	let out = '';
	for (const c of chunks) out += s.push(c);
	out += s.flush();
	return out;
}

describe('stripReasoning (full string)', () => {
	it('leaves text with no reasoning tags untouched', () => {
		expect(stripReasoning('Just a normal answer.')).toBe('Just a normal answer.');
	});

	it('removes a single <think> block and keeps the answer', () => {
		expect(stripReasoning('<think>plan the reply</think>The answer is 42.')).toBe('The answer is 42.');
	});

	it('keeps text that comes before the trace', () => {
		expect(stripReasoning('Sure. <think>hmm</think>Done.')).toBe('Sure. Done.');
	});

	it('handles <thinking>, <reason>, and <reasoning> variants', () => {
		expect(stripReasoning('<thinking>x</thinking>A')).toBe('A');
		expect(stripReasoning('<reason>y</reason>B')).toBe('B');
		expect(stripReasoning('<reasoning>z</reasoning>C')).toBe('C');
	});

	it('is case-insensitive', () => {
		expect(stripReasoning('<THINK>secret</THINK>Visible')).toBe('Visible');
	});

	it('removes multiple blocks', () => {
		expect(stripReasoning('<think>a</think>One <think>b</think>Two')).toBe('One Two');
	});

	it('drops an unterminated trace (no closing tag)', () => {
		expect(stripReasoning('<think>this never closes and is all scratch work')).toBe('');
	});

	it('does not swallow a stray "<" in normal prose', () => {
		expect(stripReasoning('if a < b then ok')).toBe('if a < b then ok');
	});

	it('preserves a non-reasoning angle-bracket tag', () => {
		expect(stripReasoning('use <div> for layout')).toBe('use <div> for layout');
	});

	it('handles multiline reasoning content', () => {
		expect(stripReasoning('<think>line1\nline2\nline3</think>final')).toBe('final');
	});
});

describe('createReasoningStripper (streaming)', () => {
	it('catches an opening tag split across chunks', () => {
		expect(streamThrough(['<thi', 'nk>hidden</thi', 'nk>shown'])).toBe('shown');
	});

	it('catches a closing tag split across chunks', () => {
		expect(streamThrough(['<think>secret</thin', 'k>answer'])).toBe('answer');
	});

	it('emits leading real text before the trace promptly', () => {
		const s = createReasoningStripper();
		const first = s.push('Hello there <thi');
		expect(first).toBe('Hello there '); // the partial "<thi" is held back
		const rest = s.push('nk>scratch</think> world') + s.flush();
		expect(first + rest).toBe('Hello there  world');
	});

	it('matches the full-string helper for an arbitrary chunking', () => {
		const full = 'Intro <think>reasoning A</think>middle <reasoning>reasoning B</reasoning>end';
		const chunked = streamThrough(['Int', 'ro <th', 'ink>reason', 'ing A</think>mid', 'dle <reason', 'ing>reasoning B</reaso', 'ning>end']);
		// stripReasoning trims; the raw streamed output should equal the untrimmed clean text.
		expect(chunked).toBe('Intro middle end');
		expect(stripReasoning(full)).toBe('Intro middle end');
	});

	it('drops an unterminated trace at flush', () => {
		expect(streamThrough(['answer first... ', '<think>then it rambles forever'])).toBe('answer first... ');
	});

	it('passes a stray "<" through across chunks', () => {
		expect(streamThrough(['a <', ' b'])).toBe('a < b');
	});

	it('handles a chunk boundary that lands exactly on a complete tag', () => {
		expect(streamThrough(['pre <think>', 'mid', '</think> post'])).toBe('pre  post');
	});
});
