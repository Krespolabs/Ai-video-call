/**
 * Dashboard UI layer for the rigged-or-not category — the styled pill and the
 * filter chips shared by the agents and avatars list pages.
 *
 * The *predicate* (is this avatar rigged?) lives in ./rig-classify.js, which is
 * also mirrored by the SQL filter in api/_lib/avatars.js. This module owns only
 * presentation: an injected stylesheet (the gallery's `.rig-badge` styles aren't
 * in scope inside dashboard-next) plus a binary filter the chips drive. Keeping
 * classification in one place means a server-filtered list and a client-painted
 * badge can never disagree.
 *
 * Mirrors the design of shared/onchain-badge.js.
 */

import { classifyRig } from './rig-classify.js';

const STYLE_ID = 'tws-rig-badge-styles';

/**
 * Canonical binary view of the rig state, delegating to classifyRig so there is
 * a single source of truth. Rigged ⇔ a confirmed skeleton; everything else
 * (confirmed-static and never-inspected uploads alike) is not rigged.
 * @param {object|null|undefined} avatar
 * @returns {boolean}
 */
export function isRigged(avatar) {
	return classifyRig(avatar).rigged;
}

/**
 * Does an avatar pass the active rig filter? `'all'` always passes; a missing
 * avatar (e.g. an agent with no body) only passes `'all'` and `'static'`.
 * @param {object|null|undefined} avatar
 * @param {'all'|'rigged'|'static'} filter
 */
export function matchesRigFilter(avatar, filter) {
	if (!filter || filter === 'all') return true;
	if (filter === 'rigged') return isRigged(avatar);
	return !isRigged(avatar); // 'static' — includes no-avatar / uninspected
}

/** Filter chip definitions, shared so every list surface offers the same options. */
export const RIG_FILTERS = [
	{ key: 'all', label: 'All' },
	{ key: 'rigged', label: 'Rigged' },
	{ key: 'static', label: 'Static' },
];

const RIGGED_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="3" r="1.6"/><path d="M8 4.6v4M8 5.6 4.8 7.4M8 5.6l3.2 1.8M8 8.6 5.4 13M8 8.6 10.6 13"/></svg>`;
const STATIC_ICON = `<svg viewBox="0 0 16 16" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 1.8 13.5 4.9v6.2L8 14.2 2.5 11.1V4.9z"/><path d="M2.6 5 8 8.1 13.4 5M8 8.1V14"/></svg>`;

export function ensureRigBadgeStyles() {
	if (typeof document === 'undefined') return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.tws-rig{display:inline-flex;align-items:center;gap:5px;padding:3px 9px;border-radius:999px;
	font:600 11px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.01em;
	white-space:nowrap;vertical-align:middle;border:1px solid transparent;cursor:default;}
.tws-rig svg{flex:none;opacity:.85;}
.tws-rig--rigged{color:#a78bfa;background:rgba(139,92,246,.13);border-color:rgba(139,92,246,.34);}
.tws-rig--static{color:var(--nxt-ink-dim,#8a8f98);background:rgba(255,255,255,.045);border-color:rgba(255,255,255,.1);}
.tws-rig--sm{padding:2px 7px;font-size:10px;gap:4px;}
.tws-rig--sm svg{width:9px;height:9px;}
`;
	(document.head || document.documentElement).appendChild(style);
}

/**
 * Render the dashboard rigged-or-not pill. Returns '' when there is no avatar to
 * judge (callers render nothing rather than a misleading "Static"). Unlike the
 * gallery badge in rig-classify.js, this paints a "Static" pill for inspected
 * static meshes AND never-inspected uploads, matching the binary chips.
 * @param {object|null|undefined} avatar
 * @param {{ size?: 'sm'|'md' }} [opts]
 */
export function rigBadgeHTML(avatar, opts = {}) {
	if (!avatar) return '';
	ensureRigBadgeStyles();
	const rigged = isRigged(avatar);
	const sizeCls = opts.size === 'sm' ? ' tws-rig--sm' : '';
	const cls = rigged ? 'tws-rig--rigged' : 'tws-rig--static';
	const label = rigged ? 'Rigged' : 'Static';
	const title = rigged
		? 'Rigged — has a skeleton, plays the animation library'
		: 'Static — no skeleton yet, open in the editor to auto-rig it';
	const icon = rigged ? RIGGED_ICON : STATIC_ICON;
	return `<span class="tws-rig ${cls}${sizeCls}" title="${title}" aria-label="${title}">${icon}<span>${label}</span></span>`;
}
