// Config resolution — the contract every host-specific concern flows through.

import { describe, it, expect } from 'vitest';
import { resolveTourConfig, DEFAULT_VOICES, DEFAULT_COPY } from '../src/config.js';

describe('resolveTourConfig defaults', () => {
	it('applies brand-neutral, graceful defaults', () => {
		const c = resolveTourConfig();
		expect(c.curriculum).toBe('/tour/curriculum.json');
		expect(c.ttsEndpoint).toBeNull(); // silent captions out of the box
		expect(c.defaultVoice).toBe('nova');
		expect(c.voices).toBe(DEFAULT_VOICES);
		expect(c.guideAvatarId).toBe('realistic-female');
		expect(c.manifestUrl).toBe('/animations/manifest.json');
		expect(c.avatarStorageKey).toBe('walk:companion:avatar');
		expect(c.deepLinkParam).toBe('tour');
		expect(typeof c.navigate).toBe('function');
		expect(c.keys).toEqual({ state: 'tws:tour:state', resume: 'tws:tour:resume' });
		expect(c.copy.outro).toBe(DEFAULT_COPY.outro);
		expect(c.copy.completion.primary).toBeNull();
	});

	it('defaults the walk-companion integration on', () => {
		const c = resolveTourConfig();
		expect(c.companion).toEqual({
			global: '__walkCompanion',
			changeEvent: 'walk-companion:change',
		});
	});
});

describe('resolveTourConfig overrides', () => {
	it('threads through explicit values', () => {
		const navigate = () => {};
		const c = resolveTourConfig({
			curriculum: { stops: [{ path: '/', narration: 'hi' }] },
			ttsEndpoint: '/api/tts/speak',
			defaultVoice: 'fable',
			guideAvatarId: 'fox',
			navigate,
			deepLinkParam: 'guide',
		});
		expect(c.ttsEndpoint).toBe('/api/tts/speak');
		expect(c.defaultVoice).toBe('fable');
		expect(c.guideAvatarId).toBe('fox');
		expect(c.navigate).toBe(navigate);
		expect(c.deepLinkParam).toBe('guide');
		expect(c.curriculum).toEqual({ stops: [{ path: '/', narration: 'hi' }] });
	});

	it('scopes storage keys to storagePrefix', () => {
		const c = resolveTourConfig({ storagePrefix: 'acme:tour' });
		expect(c.keys).toEqual({ state: 'acme:tour:state', resume: 'acme:tour:resume' });
	});

	it('disables the companion integration when companion is false', () => {
		expect(resolveTourConfig({ companion: false }).companion).toBeNull();
	});

	it('customises the companion change-event name', () => {
		const c = resolveTourConfig({ companion: { changeEvent: 'acme:companion' } });
		expect(c.companion).toEqual({ global: '__walkCompanion', changeEvent: 'acme:companion' });
	});

	it('deep-merges copy while keeping unspecified defaults', () => {
		const c = resolveTourConfig({
			copy: { outro: 'bye!', completion: { primary: { label: 'Go', href: '/start' } } },
		});
		expect(c.copy.outro).toBe('bye!');
		expect(c.copy.offRoute).toBe(DEFAULT_COPY.offRoute); // untouched default
		expect(c.copy.completion.primary).toEqual({ label: 'Go', href: '/start' });
		expect(c.copy.completion.title).toBe(DEFAULT_COPY.completion.title); // untouched
	});

	it('ignores an empty voices array and keeps the default catalogue', () => {
		expect(resolveTourConfig({ voices: [] }).voices).toBe(DEFAULT_VOICES);
		const custom = [{ id: 'x', name: 'X' }];
		expect(resolveTourConfig({ voices: custom }).voices).toBe(custom);
	});

	it('accepts the three modes and falls back to guided on anything else', () => {
		expect(resolveTourConfig().mode).toBe('guided');
		expect(resolveTourConfig({ mode: 'explore' }).mode).toBe('explore');
		expect(resolveTourConfig({ mode: 'platformer' }).mode).toBe('platformer');
		expect(resolveTourConfig({ mode: 'stroll' }).mode).toBe('guided'); // movement ≠ tour mode
		expect(resolveTourConfig({ mode: 'EXPLORE' }).mode).toBe('guided');
	});
});
