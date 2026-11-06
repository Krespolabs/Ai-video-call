// Tests for the /irl smart-glasses HUD protocol (src/irl/glasses/protocol.js).
//
// This is the pure core of the glasses bridge: it turns the live proximity read
// (nearest agent name, distance, screen-relative bearing) into a device-agnostic HUD
// model and serialises that model to each device's wire format. The transport +
// adapters above only move the bytes produced here, so pinning the formatting, the
// direction mapping and the byte-level packet framing here is what makes the whole
// bridge trustworthy without hardware in the loop.

import { describe, it, expect } from 'vitest';

import {
	formatDistance,
	normalizeAngle,
	arrowGlyph,
	turnHint,
	clampName,
	buildHud,
	buildAnnouncement,
	hudSignature,
	LINE_SLOTS,
	luaEscape,
	frameLuaStatements,
	g1TextPackets,
	g1Text,
	G1_CMD_SEND_TEXT,
	G1_SCREEN_TEXT_SHOW,
} from '../src/irl/glasses/protocol.js';

describe('formatDistance — one short token for a tiny lens', () => {
	it('rounds metres to a whole number', () => {
		expect(formatDistance(12.4)).toBe('12 m');
		expect(formatDistance(12.6)).toBe('13 m');
	});
	it('says "here" under a metre rather than "0 m"', () => {
		expect(formatDistance(0)).toBe('here');
		expect(formatDistance(0.6)).toBe('here');
	});
	it('collapses to one-decimal km past 1000 m', () => {
		expect(formatDistance(1500)).toBe('1.5 km');
	});
	it('returns empty for non-finite / negative input', () => {
		expect(formatDistance(NaN)).toBe('');
		expect(formatDistance(-5)).toBe('');
	});
});

describe('normalizeAngle — shortest-turn wrapping', () => {
	it('leaves an in-range angle untouched', () => {
		expect(normalizeAngle(0)).toBe(0);
		expect(normalizeAngle(Math.PI / 4)).toBeCloseTo(Math.PI / 4, 10);
	});
	it('wraps past +π to the negative equivalent', () => {
		expect(normalizeAngle((3 * Math.PI) / 2)).toBeCloseTo(-Math.PI / 2, 10);
	});
});

describe('arrowGlyph — eight-way pointer toward the agent', () => {
	it('points up when the agent is dead ahead', () => {
		expect(arrowGlyph(0)).toBe('↑');
	});
	it('points right for a +90° (turn-right) bearing', () => {
		expect(arrowGlyph(Math.PI / 2)).toBe('→');
	});
	it('points left for a −90° (turn-left) bearing', () => {
		expect(arrowGlyph(-Math.PI / 2)).toBe('←');
	});
	it('points down when the agent is directly behind', () => {
		expect(arrowGlyph(Math.PI)).toBe('↓');
	});
	it('uses the diagonal for a 45° bearing', () => {
		expect(arrowGlyph(Math.PI / 4)).toBe('↗');
		expect(arrowGlyph(-Math.PI / 4)).toBe('↖');
	});
	it('returns empty for a non-finite bearing', () => {
		expect(arrowGlyph(NaN)).toBe('');
	});
});

describe('turnHint — the glyph in words, so meaning survives a missing glyph', () => {
	it('reads "ahead" inside the dead-ahead cone', () => {
		expect(turnHint(0)).toBe('ahead');
		expect(turnHint(Math.PI / 10)).toBe('ahead');
	});
	it('distinguishes slight / square / hard on each side', () => {
		expect(turnHint(Math.PI / 4)).toBe('slight right');
		expect(turnHint(Math.PI / 2)).toBe('right');
		expect(turnHint((3 * Math.PI) / 4)).toBe('hard right');
		expect(turnHint(-Math.PI / 4)).toBe('slight left');
		expect(turnHint(-Math.PI / 2)).toBe('left');
		expect(turnHint(-(3 * Math.PI) / 4)).toBe('hard left');
	});
	it('reads "behind" past 157.5°', () => {
		expect(turnHint(Math.PI)).toBe('behind');
		expect(turnHint(-Math.PI)).toBe('behind');
	});
});

describe('clampName — fits a name on a 640px lens', () => {
	it('passes a short name through', () => {
		expect(clampName('Nyx')).toBe('Nyx');
	});
	it('falls back to "Agent" for an empty name', () => {
		expect(clampName('')).toBe('Agent');
		expect(clampName(null)).toBe('Agent');
	});
	it('ellipsises an over-long name', () => {
		const out = clampName('A very long agent display name', 18);
		expect(out.length).toBeLessThanOrEqual(18);
		expect(out.endsWith('…')).toBe(true);
	});
});

describe('buildHud — the device-agnostic frame', () => {
	it('renders a fixed number of line slots, padding short frames', () => {
		const m = buildHud({ nearest: null, count: 0 });
		expect(m.lines).toHaveLength(LINE_SLOTS);
	});
	it('shows the keep-exploring empty state when nothing is in range', () => {
		const m = buildHud({ nearest: null, count: 0 });
		expect(m.hasTarget).toBe(false);
		expect(m.lines.join(' ')).toMatch(/No agents near/);
	});
	it('builds the head line as arrow + name and the detail as distance · turn', () => {
		const m = buildHud({
			nearest: { name: 'Nyx', distanceM: 12, relBearingRad: -Math.PI / 2 },
			count: 1,
		});
		expect(m.hasTarget).toBe(true);
		expect(m.lines[0]).toBe('← Nyx');
		expect(m.lines[1]).toBe('12 m · left');
		expect(m.arrow).toBe('←');
		expect(m.distance).toBe('12 m');
		expect(m.turn).toBe('left');
	});
	it('tallies extra agents without listing them (privacy: a count, never a roster)', () => {
		const m = buildHud({
			nearest: { name: 'Nyx', distanceM: 5, relBearingRad: 0 },
			count: 3,
		});
		expect(m.countText).toBe('+2 more nearby');
		expect(m.lines[2]).toBe('+2 more nearby');
	});
	it('omits the tally when only the pointed-at agent is in range', () => {
		const m = buildHud({ nearest: { name: 'Nyx', distanceM: 5, relBearingRad: 0 }, count: 1 });
		expect(m.countText).toBe('');
	});
	it('clamps a long name into the head line', () => {
		const m = buildHud({
			nearest: { name: 'An extremely long agent name here', distanceM: 4, relBearingRad: 0 },
			count: 1,
		});
		expect(m.lines[0].length).toBeLessThanOrEqual(2 + 18); // arrow + space + clamped name
	});
});

describe('buildAnnouncement — a transient flash', () => {
	it('wraps the headline in the fixed slot count', () => {
		const m = buildAnnouncement('Agent nearby');
		expect(m.announcement).toBe(true);
		expect(m.lines).toHaveLength(LINE_SLOTS);
		expect(m.lines.join(' ')).toMatch(/Agent nearby/);
	});
	it('falls back to a default headline for empty text', () => {
		expect(buildAnnouncement('').lines.join(' ')).toMatch(/Agent nearby/);
	});
});

describe('hudSignature — change detection for the bridge throttle', () => {
	it('is stable for identical content and differs when a line changes', () => {
		const a = buildHud({ nearest: { name: 'Nyx', distanceM: 12, relBearingRad: 0 }, count: 1 });
		const b = buildHud({ nearest: { name: 'Nyx', distanceM: 12, relBearingRad: 0 }, count: 1 });
		const c = buildHud({ nearest: { name: 'Nyx', distanceM: 13, relBearingRad: 0 }, count: 1 });
		expect(hudSignature(a)).toBe(hudSignature(b));
		expect(hudSignature(a)).not.toBe(hudSignature(c));
	});
});

describe('luaEscape — safe Lua string literals', () => {
	it('escapes quotes and backslashes', () => {
		expect(luaEscape('a"b\\c')).toBe('a\\"b\\\\c');
	});
	it('flattens newlines so a statement stays one line', () => {
		expect(luaEscape('a\nb')).toBe('a\\nb');
	});
});

describe('frameLuaStatements — Brilliant Labs Frame draw calls', () => {
	it('emits one text() per slot then a single show() flip', () => {
		const stmts = frameLuaStatements(buildHud({
			nearest: { name: 'Nyx', distanceM: 12, relBearingRad: 0 }, count: 1,
		}));
		expect(stmts).toHaveLength(LINE_SLOTS + 1);
		expect(stmts.slice(0, LINE_SLOTS).every((s) => s.startsWith('frame.display.text('))).toBe(true);
		expect(stmts[stmts.length - 1]).toBe('frame.display.show()');
	});
	it('escapes a quote inside an agent name so the Lua stays valid', () => {
		const stmts = frameLuaStatements(buildHud({
			nearest: { name: 'A"B', distanceM: 1, relBearingRad: 0 }, count: 1,
		}));
		expect(stmts[0]).toContain('\\"');
	});
	it('keeps each statement well under the BLE MTU', () => {
		const stmts = frameLuaStatements(buildHud({
			nearest: { name: 'An extremely long agent name', distanceM: 12, relBearingRad: Math.PI }, count: 9,
		}));
		for (const s of stmts) expect(s.length).toBeLessThan(180);
	});
});

describe('g1TextPackets — Even Realities G1 0x4E framing', () => {
	it('frames short text in a single packet with the documented header', () => {
		const pkts = g1TextPackets('12 m · left', { seq: 7 });
		expect(pkts).toHaveLength(1);
		const p = pkts[0];
		expect(p[0]).toBe(G1_CMD_SEND_TEXT);   // command
		expect(p[1]).toBe(7);                   // seq
		expect(p[2]).toBe(1);                   // total packets
		expect(p[3]).toBe(0);                   // packet index
		expect(p[4]).toBe(G1_SCREEN_TEXT_SHOW); // screen status
		expect(p[7]).toBe(1);                   // current page
		expect(p[8]).toBe(1);                   // max page
	});
	it('carries the UTF-8 text after the 9-byte header', () => {
		const pkts = g1TextPackets('ab', { seq: 0 });
		const p = pkts[0];
		expect(p.length).toBe(9 + 2);
		expect(p[9]).toBe('a'.charCodeAt(0));
		expect(p[10]).toBe('b'.charCodeAt(0));
	});
	it('masks the seq byte to 8 bits', () => {
		expect(g1TextPackets('x', { seq: 300 })[0][1]).toBe(300 & 0xff);
	});
	it('splits long text across packets, each tagged with its index and the total', () => {
		const long = 'x'.repeat(500);
		const pkts = g1TextPackets(long, { seq: 1 });
		expect(pkts.length).toBeGreaterThan(1);
		pkts.forEach((p, i) => {
			expect(p[2]).toBe(pkts.length); // total
			expect(p[3]).toBe(i);           // index
			expect(p.length).toBeLessThanOrEqual(180);
		});
		// All payload bytes reassemble to the original length.
		const payloadBytes = pkts.reduce((n, p) => n + (p.length - 9), 0);
		expect(payloadBytes).toBe(500);
	});
	it('never splits a multibyte glyph across a packet boundary', () => {
		// '•' is 3 UTF-8 bytes; a wall of them stresses the boundary-healing logic.
		const pkts = g1TextPackets('•'.repeat(200), { seq: 0 });
		// Each packet's payload length must be a multiple of 3 (no straddled glyph).
		for (const p of pkts) expect((p.length - 9) % 3).toBe(0);
	});
	it('emits a single blank packet for empty text (a clear-screen push)', () => {
		const pkts = g1TextPackets('', { seq: 0 });
		expect(pkts).toHaveLength(1);
		expect(pkts[0].length).toBe(9);
	});
});

describe('g1Text — the joined block for the green display', () => {
	it('joins line slots with newlines and trims trailing blank slots', () => {
		const m = buildHud({ nearest: { name: 'Nyx', distanceM: 5, relBearingRad: 0 }, count: 1 });
		// slot 3 (count tally) is empty here, so it should be trimmed off the block.
		expect(g1Text(m)).toBe('↑ Nyx\n5 m · ahead');
	});
	it('converts padded space slots to empty and drops them', () => {
		expect(g1Text({ lines: ['hi', ' ', ' '] })).toBe('hi');
	});
});
