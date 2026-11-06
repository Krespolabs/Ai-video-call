// Unit coverage for the pure cinematic-feed presentation logic. No DOM, no
// network — every assertion is deterministic, matching how the renderers depend
// on it: classify (icon/colour/severity per action_type), coalesce (beat
// grouping + counts + boundaries), and timeline (typed-reveal timing).

import { describe, it, expect } from 'vitest';
import {
	classify,
	coalesce,
	timeline,
	categoryOf,
	severityOf,
	colorHex,
	COLOR_HEX,
} from '../src/activity-cinema.js';

describe('categoryOf', () => {
	const cases = [
		['buy', 'buy'],
		['sell', 'sell'],
		['trade', 'trade'],
		['buyback', 'trade'],
		['trade_pnl_pct', 'trade'],
		['defend_buy', 'defend'],
		['recycle_sell', 'recycle'],
		['graduated', 'graduate'],
		['launch', 'launch'],
		['deploy', 'launch'],
		['hired', 'hire'],
		['memory', 'memory'],
		['think', 'memory'],
		['reflect', 'memory'],
		['error', 'error'],
		['analysis', 'analysis'],
		['signal', 'analysis'],
		['sign', 'sign'],
		['something_unknown', 'default'],
		['', 'default'],
		[undefined, 'default'],
	];
	for (const [type, expected] of cases) {
		it(`maps ${JSON.stringify(type)} → ${expected}`, () => {
			expect(categoryOf(type)).toBe(expected);
		});
	}

	it('prefers the specific prefix over the generic action', () => {
		// defend_buy must not fall through to "buy", recycle_sell not to "sell".
		expect(categoryOf('defend_buy')).toBe('defend');
		expect(categoryOf('recycle_sell')).toBe('recycle');
	});
});

describe('severityOf', () => {
	it('flags failures as high regardless of the base action', () => {
		expect(severityOf('trade_error', '')).toBe('high');
		expect(severityOf('buy', 'buy yields nothing')).toBe('high');
		expect(severityOf('launch', 'launch failed: insufficient SOL')).toBe('high');
		expect(severityOf('defend_fail', '')).toBe('high');
	});
	it('flags wins as celebratory', () => {
		expect(severityOf('graduated', '')).toBe('celebratory');
		expect(severityOf('launch', 'launched $THREE')).toBe('celebratory');
		expect(severityOf('jackpot', '')).toBe('celebratory');
		expect(severityOf('earn', 'earned 12 USDC')).toBe('celebratory');
	});
	it('defaults to normal', () => {
		expect(severityOf('think', 'considering the market')).toBe('normal');
		expect(severityOf('buy', 'bought 0.1 SOL')).toBe('normal');
		expect(severityOf('', '')).toBe('normal');
	});
	it('lets failure win over celebration when both keywords appear', () => {
		expect(severityOf('launch', 'launch failed')).toBe('high');
	});
});

describe('classify', () => {
	it('returns the icon/colour/severity/label/category for a trade', () => {
		const c = classify({ type: 'buy', activity: 'bought 0.1 SOL of $THREE' });
		expect(c.category).toBe('buy');
		expect(c.icon).toBe('▲');
		expect(c.colorToken).toBe('green');
		expect(c.severity).toBe('normal');
		expect(c.label).toBe('Buy');
	});

	it('grades a failed defense amber + high severity', () => {
		const c = classify({ type: 'defend_buy', activity: 'defense failed — floor breached' });
		expect(c.category).toBe('defend');
		expect(c.icon).toBe('🛡');
		expect(c.severity).toBe('high');
		expect(c.colorToken).toBe('amber'); // severity overrides the base colour
	});

	it('flares a graduation gold + celebratory', () => {
		const c = classify({ type: 'graduated', activity: 'graduated to Raydium' });
		expect(c.category).toBe('graduate');
		expect(c.icon).toBe('🎓');
		expect(c.severity).toBe('celebratory');
		expect(c.colorToken).toBe('gold');
	});

	it('covers every documented category with a distinct icon', () => {
		const types = {
			trade: '⇄', defend: '🛡', recycle: '♻', graduate: '🎓',
			launch: '🚀', hire: '🤝', memory: '🧠', error: '⚠', default: '›',
		};
		const sampleType = {
			trade: 'trade', defend: 'defend_buy', recycle: 'recycle_sell',
			graduate: 'graduated', launch: 'launch', hire: 'hired',
			memory: 'memory', error: 'error', default: 'whatever',
		};
		for (const [cat, icon] of Object.entries(types)) {
			const c = classify({ type: sampleType[cat] });
			expect(c.category).toBe(cat);
			expect(c.icon).toBe(icon);
		}
	});

	it('never throws on a malformed / empty entry and yields default', () => {
		for (const e of [undefined, null, {}, { type: null }, { activity: 42 }]) {
			const c = classify(e);
			expect(c.category).toBe('default');
			expect(c.icon).toBe('›');
			expect(typeof c.label).toBe('string');
		}
	});

	it('every colour token resolves to a hex/rgba string', () => {
		const tokens = ['gold', 'amber', 'green', 'red', 'cyan', 'sky', 'violet', 'neutral'];
		for (const t of tokens) expect(typeof COLOR_HEX[t]).toBe('string');
		expect(colorHex('green')).toBe(COLOR_HEX.green);
		expect(colorHex('nonexistent')).toBe(COLOR_HEX.neutral);
	});
});

describe('coalesce', () => {
	it('groups consecutive same-category actions with a count', () => {
		const beats = coalesce([
			{ type: 'defend_buy', activity: 'held the floor', ts: 1 },
			{ type: 'defend_buy', activity: 'held again', ts: 2 },
			{ type: 'defend_buy', activity: 'held a third time', ts: 3 },
		]);
		expect(beats).toHaveLength(1);
		expect(beats[0].key).toBe('defend');
		expect(beats[0].count).toBe(3);
		// representative is the LATEST member
		expect(beats[0].ts).toBe(3);
		expect(beats[0].activity).toBe('held a third time');
		expect(beats[0].members).toHaveLength(3);
	});

	it('starts a new beat at a category boundary, preserving order', () => {
		const beats = coalesce([
			{ type: 'buy', ts: 1 },
			{ type: 'buy', ts: 2 },
			{ type: 'sell', ts: 3 },
			{ type: 'think', ts: 4 },
			{ type: 'think', ts: 5 },
		]);
		expect(beats.map((b) => b.key)).toEqual(['buy', 'sell', 'memory']);
		expect(beats.map((b) => b.count)).toEqual([2, 1, 2]);
		expect(beats.map((b) => b.ts)).toEqual([2, 3, 5]);
	});

	it('does not merge non-adjacent same-category runs', () => {
		const beats = coalesce([
			{ type: 'buy', ts: 1 },
			{ type: 'sell', ts: 2 },
			{ type: 'buy', ts: 3 },
		]);
		expect(beats.map((b) => b.key)).toEqual(['buy', 'sell', 'buy']);
		expect(beats.every((b) => b.count === 1)).toBe(true);
	});

	it('classifies each beat from its representative', () => {
		const [beat] = coalesce([{ type: 'graduated', activity: 'graduated!' }]);
		expect(beat.severity).toBe('celebratory');
		expect(beat.colorToken).toBe('gold');
		expect(beat.icon).toBe('🎓');
	});

	it('returns an empty array for empty / invalid input', () => {
		expect(coalesce([])).toEqual([]);
		expect(coalesce(undefined)).toEqual([]);
		expect(coalesce(null)).toEqual([]);
	});
});

describe('timeline', () => {
	it('scales type duration with text length and caps it', () => {
		const short = timeline({ activity: 'hi', type: 'think' });
		const long = timeline({ activity: 'x'.repeat(400), type: 'think' });
		expect(short.typeMs).toBe(2 * 16);
		expect(long.typeMs).toBe(1400); // capped
	});

	it('types high-severity faster and celebratory slower', () => {
		const high = timeline({ type: 'error', activity: 'failed' });
		const norm = timeline({ type: 'think', activity: 'failed' }); // same length, normal
		const win = timeline({ type: 'graduated', activity: 'failed' });
		// "failed" makes norm high too — use a clean normal instead
		const cleanNorm = timeline({ type: 'think', activity: 'ideass' }); // 6 chars
		expect(high.charMs).toBe(12);
		expect(cleanNorm.charMs).toBe(16);
		// win contains 'failed' → high, so assert celebratory via a clean win
		const cleanWin = timeline({ type: 'graduated', activity: 'graduated now' });
		expect(cleanWin.charMs).toBe(22);
		expect(norm.charMs).toBe(12); // 'failed' forced high
		expect(win.charMs).toBe(12);  // 'failed' forced high
	});

	it('holds celebratory beats longest, then high, then normal', () => {
		const win = timeline({ type: 'graduated', activity: 'graduated' });
		const high = timeline({ type: 'error', activity: 'boom' });
		const norm = timeline({ type: 'think', activity: 'idea' });
		expect(win.holdMs).toBeGreaterThan(high.holdMs);
		expect(high.holdMs).toBeGreaterThan(norm.holdMs);
	});

	it('enters faster when continuing the previous category', () => {
		const fresh = timeline({ type: 'buy', activity: 'b' }, { type: 'sell' });
		const cont = timeline({ type: 'buy', activity: 'b' }, { type: 'buy' });
		expect(fresh.enterMs).toBe(220);
		expect(cont.enterMs).toBe(140);
		// no prev → fresh enter
		expect(timeline({ type: 'buy', activity: 'b' }).enterMs).toBe(220);
	});

	it('is deterministic', () => {
		const a = timeline({ type: 'buy', activity: 'bought 1 SOL' }, { type: 'think' });
		const b = timeline({ type: 'buy', activity: 'bought 1 SOL' }, { type: 'think' });
		expect(a).toEqual(b);
	});
});
