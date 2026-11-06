// Tests for the talk-mode emote controller.
//
// The AnimationManager dependency touches three.js, which only meaningfully
// executes with a WebGL context. We focus on the controller's curation +
// catalog-fetch logic, which is testable without a renderer.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TALK_EMOTE_BAR, TalkEmotes } from '../src/voice/talk-emotes.js';

describe('TALK_EMOTE_BAR — curation', () => {
	it('is short (≤ 8) and ordered deliberately', () => {
		// More than ~8 buttons creates choice paralysis during a live
		// conversation; if we ever bump this, intentionally update the test.
		expect(TALK_EMOTE_BAR.length).toBeGreaterThan(0);
		expect(TALK_EMOTE_BAR.length).toBeLessThanOrEqual(8);
	});

	it('every entry has the shape the UI needs', () => {
		for (const e of TALK_EMOTE_BAR) {
			expect(typeof e.name).toBe('string');
			expect(e.name.length).toBeGreaterThan(0);
			expect(typeof e.label).toBe('string');
			expect(typeof e.icon).toBe('string');
			expect(typeof e.loop).toBe('boolean');
		}
	});

	it('names are unique', () => {
		const names = new Set(TALK_EMOTE_BAR.map((e) => e.name));
		expect(names.size).toBe(TALK_EMOTE_BAR.length);
	});

	it('includes idle (the baseline conversational loop)', () => {
		const names = new Set(TALK_EMOTE_BAR.map((e) => e.name));
		expect(names.has('idle')).toBe(true);
	});
});

describe('TalkEmotes — manifest loading + curation', () => {
	let emotes;
	beforeEach(() => {
		emotes = new TalkEmotes();
	});

	it('getBarDefs returns [] before the manifest loads', () => {
		expect(emotes.getBarDefs()).toEqual([]);
		expect(emotes.getAllDefs()).toEqual([]);
	});

	it('filters the curated bar by what the manifest actually ships', async () => {
		// Manifest covers idle + dance but NOT celebrate.
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [
				{ name: 'idle', url: '/animations/clips/idle.json', label: 'Idle', icon: '🧍', loop: true },
				{ name: 'dance', url: '/animations/clips/dance.json', label: 'Dance', icon: '💃', loop: true },
				{ name: 'other', url: '/animations/clips/other.json', label: 'Other', icon: '?', loop: true },
			],
		});
		await emotes.loadManifest();
		const bar = emotes.getBarDefs();
		const names = bar.map((d) => d.name);
		expect(names).toContain('idle');
		expect(names).toContain('dance');
		expect(names).not.toContain('celebrate');   // not in manifest
		expect(names).not.toContain('other');        // not in curated bar
	});

	it('survives a 404 manifest fetch without throwing', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
		const ok = await emotes.loadManifest();
		expect(ok).toBe(false);
		expect(emotes.getBarDefs()).toEqual([]);
	});

	it('loadManifest is idempotent (same promise on second call)', async () => {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [],
		});
		globalThis.fetch = fetchMock;
		const p1 = emotes.loadManifest();
		const p2 = emotes.loadManifest();
		expect(p1).toBe(p2);
		await p1;
		// fetch fires exactly once.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('rejects malformed manifests without crashing', async () => {
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ not: 'an-array' }),
		});
		const ok = await emotes.loadManifest();
		expect(ok).toBe(false);
		expect(emotes.getBarDefs()).toEqual([]);
	});
});

describe('TalkEmotes — play preconditions', () => {
	it('returns false when called with an unknown emote', async () => {
		const emotes = new TalkEmotes();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => [],
		});
		await emotes.loadManifest();
		const result = await emotes.play('nope-not-here');
		expect(result).toBe(false);
	});
});
