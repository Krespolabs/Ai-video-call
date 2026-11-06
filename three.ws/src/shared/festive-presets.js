/**
 * Seasonal preset injector — shared across the creation surfaces so the
 * Independence Day (July 1–5, viewer's local time) moment is consistent and
 * self-retiring. Outside the window this injects nothing, so the themed presets
 * never ship as dead copy and the callers need no seasonal branching of their
 * own.
 *
 * The helper only builds and inserts the preset buttons; each surface keeps its
 * own click idiom. Two surfaces already delegate clicks from the container
 * (`/create/prompt` fills the composer, `/forge` fills + generates), so simply
 * prepending buttons with the surface's chip class wires them for free. Callers
 * that wire per-element can use the returned button list.
 *
 * @example
 *   import { injectFestivePresets } from './shared/festive-presets.js';
 *   injectFestivePresets({
 *     container: document.querySelector('.examples'),
 *     prompts: ['Uncle Sam in a star-spangled top hat…'],
 *   });
 */

/**
 * True during the Independence Day decoration window (July 1–5 inclusive) in
 * the given date's local time. Matches the gate used by public/seasonal.js so
 * every seasonal surface appears and retires together.
 * @param {Date} [date]
 * @returns {boolean}
 */
export function isIndependenceDayWindow(date = new Date()) {
	return date.getMonth() === 6 && date.getDate() <= 5;
}

/**
 * Prepend festive preset buttons to a container when in season.
 *
 * @param {object} opts
 * @param {Element|null} opts.container       Where the presets are inserted.
 * @param {string[]} opts.prompts             Preset prompt strings (button text).
 * @param {string} [opts.chipClass='example'] Base class the surface's click
 *                                            handler/delegation matches on.
 * @param {string} [opts.festiveClass='example--festive'] Seasonal modifier class
 *                                            for styling and shuffle-exclusion.
 * @param {Date}   [opts.now]                 Injectable clock (for tests).
 * @returns {HTMLButtonElement[]} The inserted buttons (empty out of season, or
 *                                if the container is missing / already injected).
 */
export function injectFestivePresets({
	container,
	prompts,
	chipClass = 'example',
	festiveClass = 'example--festive',
	now = new Date(),
} = {}) {
	if (!isIndependenceDayWindow(now)) return [];
	if (!container || !Array.isArray(prompts) || prompts.length === 0) return [];
	// Idempotent: never double-inject if a surface re-runs its init.
	if (container.dataset.festiveInjected === '1') return [];
	container.dataset.festiveInjected = '1';

	const frag = document.createDocumentFragment();
	const made = /** @type {HTMLButtonElement[]} */ ([]);
	for (const text of prompts) {
		const btn = document.createElement('button');
		btn.type = 'button';
		btn.className = `${chipClass} ${festiveClass}`;
		btn.textContent = text;
		frag.appendChild(btn);
		made.push(btn);
	}
	container.prepend(frag);
	return made;
}
