// Tests for the Living Stages ShowDirector (multiplayer/src/stage-show.js) — the
// pure show brain the StageRoom shells. Covers the core live loop the moonshot's
// e2e calls out: a viewer joins, a real tip lands, and the host's NEXT beat is a
// shoutout for that tip — plus leaderboard math, the question queue, and the
// whale-jumps-the-queue ordering. No Colyseus / socket needed.

import { describe, it, expect } from 'vitest';
import { ShowDirector, BEAT } from '../multiplayer/src/stage-show.js';

function liveDirector() {
	const d = new ShowDirector({ stageId: 's1', hostName: 'Nova', format: 'game show' });
	// Open the show so subsequent beats are real performance beats (opener fires once).
	expect(d.nextBeat().kind).toBe(BEAT.OPENER);
	d.markSpoken(BEAT.OPENER);
	return d;
}

describe('beat selection — the live loop', () => {
	it('opens once, then a fresh tip pre-empts everything as a shoutout', () => {
		const d = liveDirector();
		// Join + tip.
		d.noteAudience(3);
		const { tip } = d.ingestTip({ tipperId: 'u1', label: 'Ada', amount: 2_000_000_000, mint: 'THREE', signature: 'sigA', ts: 1 });
		expect(tip.label).toBe('Ada');

		const beat = d.nextBeat();
		expect(beat.kind).toBe(BEAT.TIP_SHOUTOUT);
		expect(beat.tip.label).toBe('Ada');
		expect(beat.tip.amount).toBe(2_000_000_000);
	});

	it('answers a queued question once no tip is pending', () => {
		const d = liveDirector();
		d.queueQuestion({ id: 'q1', from: 'Lin', text: 'whats your name?', ts: 1 });
		const beat = d.nextBeat();
		expect(beat.kind).toBe(BEAT.ANSWER);
		expect(beat.question.from).toBe('Lin');
	});

	it('alternates game and banter as filler when nothing is pending', () => {
		const d = liveDirector();
		const a = d.nextBeat(); d.markSpoken(a.kind);
		const b = d.nextBeat(); d.markSpoken(b.kind);
		expect(a.kind).not.toBe(b.kind);
		expect([BEAT.GAME, BEAT.BANTER]).toContain(a.kind);
		expect([BEAT.GAME, BEAT.BANTER]).toContain(b.kind);
	});

	it('a whale tip jumps the shoutout queue ahead of a dust tip', () => {
		const d = liveDirector();
		d.ingestTip({ tipperId: 'u1', label: 'Dust', amount: 1_000, signature: 's1', ts: 1 });
		d.ingestTip({ tipperId: 'u2', label: 'Whale', amount: 9_000_000_000, signature: 's2', ts: 2 });
		const beat = d.nextBeat();
		expect(beat.kind).toBe(BEAT.TIP_SHOUTOUT);
		expect(beat.tip.label).toBe('Whale');
	});
});

describe('tip ledger + leaderboard', () => {
	it('accumulates per-tipper totals and ranks them, highest first', () => {
		const d = liveDirector();
		d.ingestTip({ tipperId: 'a', label: 'Ada', amount: 500, signature: 's1', ts: 1 });
		d.ingestTip({ tipperId: 'b', label: 'Bo', amount: 2000, signature: 's2', ts: 2 });
		d.ingestTip({ tipperId: 'a', label: 'Ada', amount: 600, signature: 's3', ts: 3 });

		const lb = d.leaderboard();
		expect(lb[0]).toMatchObject({ label: 'Bo', total: 2000, count: 1 });
		expect(lb[1]).toMatchObject({ label: 'Ada', total: 1100, count: 2 });
		expect(d.totalTipsAtomic).toBe(3100);
		expect(d.tipCount).toBe(3);
	});

	it('flags a new top tipper only when the crown actually changes', () => {
		const d = liveDirector();
		const first = d.ingestTip({ tipperId: 'a', label: 'Ada', amount: 1000, signature: 's1', ts: 1 });
		expect(first.isNewTopTipper).toBe(true); // first tipper takes the crown
		const same = d.ingestTip({ tipperId: 'a', label: 'Ada', amount: 50, signature: 's2', ts: 2 });
		expect(same.isNewTopTipper).toBe(false); // still Ada
		const flip = d.ingestTip({ tipperId: 'b', label: 'Bo', amount: 5000, signature: 's3', ts: 3 });
		expect(flip.isNewTopTipper).toBe(true); // Bo overtakes
	});
});

describe('question queue', () => {
	it('takes questions in order, dedupes ids, and bounds the queue', () => {
		const d = liveDirector();
		expect(d.queueQuestion({ id: 'q1', from: 'A', text: 'one', ts: 1 })).toBe(true);
		expect(d.queueQuestion({ id: 'q1', from: 'A', text: 'one again', ts: 2 })).toBe(false); // dup id
		expect(d.queueQuestion({ id: 'q2', from: 'B', text: 'two', ts: 3 })).toBe(true);
		expect(d.queueQuestion({ id: 'q3', from: 'C', text: '   ', ts: 4 })).toBe(false); // empty
		expect(d.pendingQuestionCount()).toBe(2);
		expect(d.takeQuestion().text).toBe('one');
		expect(d.takeQuestion().text).toBe('two');
		expect(d.takeQuestion()).toBeNull();
	});

	it('rejects past the queue cap', () => {
		const d = liveDirector();
		let accepted = 0;
		for (let i = 0; i < 100; i++) if (d.queueQuestion({ id: `q${i}`, from: 'x', text: `q ${i}`, ts: i })) accepted++;
		expect(accepted).toBeLessThanOrEqual(24);
		expect(d.pendingQuestionCount()).toBe(accepted);
	});
});

describe('show standings + audience', () => {
	it('tracks peak audience and exposes a standings snapshot', () => {
		const d = liveDirector();
		d.noteAudience(5);
		d.noteAudience(2);
		d.noteAudience(9);
		d.ingestTip({ tipperId: 'a', label: 'Ada', amount: 1000, signature: 's1', ts: 1 });
		const s = d.standings();
		expect(s.peakAudience).toBe(9);
		expect(s.totalTipsAtomic).toBe(1000);
		expect(s.format).toBe('game show');
		expect(s.leaderboard[0].label).toBe('Ada');
	});

	it('sanitizes control characters out of stored labels/messages', () => {
		const d = liveDirector();
		const { tip } = d.ingestTip({ tipperId: 'a', label: 'A d\na', amount: 10, message: 'hi\tthere', signature: 's1', ts: 1 });
		expect(/[\u0000-\u001f]/.test(tip.label)).toBe(false);
		expect(/[\u0000-\u001f]/.test(tip.message)).toBe(false);
		expect(tip.label).toBe('A d a'); // newline collapsed to a single space
	});
});

// The /agent-screen Stage Show (Moonshot 08) drives this director on a fixed
// cadence and relies on three guarantees: the loop NEVER returns an empty beat
// (the show never goes dead), a fresh tip pre-empts a waiting question, and
// queued questions are answered first-in-first-out across successive ANSWER beats.
describe('agent-screen stage loop guarantees', () => {
	it('never goes dead — 200 ticks of pure filler always yield a valid, non-repeating beat', () => {
		const d = liveDirector();
		let last = null;
		for (let i = 0; i < 200; i++) {
			const beat = d.nextBeat();
			expect([BEAT.GAME, BEAT.BANTER]).toContain(beat.kind); // always something to perform
			expect(beat.kind).not.toBe(last); // two identical fillers never run back to back
			d.markSpoken(beat.kind);
			last = beat.kind;
		}
	});

	it('a fresh tip pre-empts a queued question, then the question is answered next', () => {
		const d = liveDirector();
		d.queueQuestion({ id: 'q1', from: 'Lin', text: 'how are you?', ts: 1 });
		d.ingestTip({ tipperId: 'u1', label: 'Ada', amount: 5_000_000, signature: 'sig1', ts: 2 });

		const first = d.nextBeat();
		expect(first.kind).toBe(BEAT.TIP_SHOUTOUT); // money jumps the line
		d.markSpoken(first.kind);

		const second = d.nextBeat();
		expect(second.kind).toBe(BEAT.ANSWER); // the waiting question is still served
		expect(second.question.text).toBe('how are you?');
	});

	it('answers multiple queued questions in FIFO order across answer beats', () => {
		const d = liveDirector();
		d.queueQuestion({ id: 'q1', from: 'A', text: 'first?', ts: 1 });
		d.queueQuestion({ id: 'q2', from: 'B', text: 'second?', ts: 2 });

		const a = d.nextBeat();
		expect(a.kind).toBe(BEAT.ANSWER);
		expect(a.question.text).toBe('first?');
		d.markSpoken(a.kind);

		const b = d.nextBeat();
		expect(b.kind).toBe(BEAT.ANSWER);
		expect(b.question.text).toBe('second?');
		d.markSpoken(b.kind);

		// Both drained → the director falls straight back to filler, never null.
		const c = d.nextBeat();
		expect([BEAT.GAME, BEAT.BANTER]).toContain(c.kind);
	});
});
