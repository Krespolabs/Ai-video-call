// @vitest-environment jsdom
//
// The shared Independence Day preset injector feeds the create + forge flows.
// A wrong date gate would show July 4 chips in December (or hide them on the
// day), and a broken prepend/idempotency guard would duplicate or misorder the
// presets on every surface — so the window edges and DOM effects are pinned.

import { describe, expect, it, beforeEach } from 'vitest';
import { injectFestivePresets, isIndependenceDayWindow } from '../src/shared/festive-presets.js';

const JULY = (day) => new Date(2026, 6, day); // month 6 === July
const PROMPTS = ['Uncle Sam', 'A bald eagle', 'Lady Liberty'];

describe('isIndependenceDayWindow', () => {
	it('is true across July 1–5', () => {
		for (const d of [1, 2, 3, 4, 5]) expect(isIndependenceDayWindow(JULY(d))).toBe(true);
	});

	it('is false on July 6 and later', () => {
		expect(isIndependenceDayWindow(JULY(6))).toBe(false);
		expect(isIndependenceDayWindow(JULY(20))).toBe(false);
	});

	it('is false in other months (June 30, Dec 25)', () => {
		expect(isIndependenceDayWindow(new Date(2026, 5, 30))).toBe(false);
		expect(isIndependenceDayWindow(new Date(2026, 11, 25))).toBe(false);
	});
});

describe('injectFestivePresets', () => {
	let container;
	beforeEach(() => {
		document.body.innerHTML = '';
		container = document.createElement('div');
		const existing = document.createElement('button');
		existing.className = 'example';
		existing.textContent = 'Existing chip';
		container.appendChild(existing);
		document.body.appendChild(container);
	});

	it('prepends one button per prompt, ahead of existing chips', () => {
		const made = injectFestivePresets({ container, prompts: PROMPTS, now: JULY(4) });
		expect(made).toHaveLength(3);
		const buttons = [...container.querySelectorAll('button')];
		expect(buttons).toHaveLength(4); // 3 festive + 1 existing
		// festive come first, in order, existing last
		expect(buttons.map((b) => b.textContent)).toEqual([...PROMPTS, 'Existing chip']);
	});

	it('applies the base + festive classes and type=button', () => {
		const [btn] = injectFestivePresets({ container, prompts: PROMPTS, now: JULY(4) });
		expect(btn.classList.contains('example')).toBe(true);
		expect(btn.classList.contains('example--festive')).toBe(true);
		expect(btn.type).toBe('button');
	});

	it('honors custom chip/festive class names', () => {
		const [btn] = injectFestivePresets({
			container,
			prompts: PROMPTS,
			chipClass: 'chip',
			festiveClass: 'chip--festive',
			now: JULY(4),
		});
		expect(btn.className).toBe('chip chip--festive');
	});

	it('injects nothing outside the window', () => {
		const made = injectFestivePresets({ container, prompts: PROMPTS, now: new Date(2026, 11, 25) });
		expect(made).toEqual([]);
		expect(container.querySelectorAll('button')).toHaveLength(1);
	});

	it('is idempotent — a second call does not duplicate', () => {
		injectFestivePresets({ container, prompts: PROMPTS, now: JULY(4) });
		const second = injectFestivePresets({ container, prompts: PROMPTS, now: JULY(4) });
		expect(second).toEqual([]);
		expect(container.querySelectorAll('.example--festive')).toHaveLength(3);
	});

	it('returns [] for a missing container or empty prompts', () => {
		expect(injectFestivePresets({ container: null, prompts: PROMPTS, now: JULY(4) })).toEqual([]);
		expect(injectFestivePresets({ container, prompts: [], now: JULY(4) })).toEqual([]);
	});
});
