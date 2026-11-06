/**
 * Agent achievements panel.
 * =========================
 *
 * Renders an agent's earned badges + in-progress achievements from the real
 * GET /api/agents/:id/achievements feed (computed server-side from launches,
 * graduations/migrations, market caps, supporters, burns, reputation, tenure).
 *
 * Self-manages loading → populated / empty / error states so the caller just
 * hands it a mount node, an agent id, and whether the viewer is the owner.
 * Returns a { destroy } handle that aborts any in-flight fetch.
 */

const TIER_META = {
	bronze: { label: 'Bronze', accent: '#cd7f32' },
	silver: { label: 'Silver', accent: '#cbd5e1' },
	gold: { label: 'Gold', accent: '#fbbf24' },
	legendary: { label: 'Legendary', accent: '#c084fc' },
};

const TIER_RANK = { bronze: 0, silver: 1, gold: 2, legendary: 3 };

function el(tag, props = {}, children = []) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k === 'text') node.textContent = v;
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of [].concat(children || [])) {
		if (c == null) continue;
		node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
	}
	return node;
}

function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '$0';
	if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
	if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
	if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
	return `$${Math.round(v)}`;
}

// Human progress label for a still-locked achievement, e.g. "7 / 10",
// "$42K / $100K", "12 / 30 days", "Established / Trusted".
function progressLabel(a) {
	const p = a.progress || {};
	const cur = p.value ?? p.current ?? 0;
	const target = p.target ?? 0;
	switch (a.unit) {
		case 'usd':
			return `${fmtUsd(cur)} / ${fmtUsd(target)}`;
		case 'days':
			return `${Math.floor(cur)} / ${target} days`;
		case 'rank':
			return 'Keep building reputation';
		default:
			return `${Math.floor(cur)} / ${target}`;
	}
}

function whenAgo(iso) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (Date.now() - t) / 1000);
	if (s < 86400) return 'today';
	if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
	return new Date(t).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}

function summaryChips(summary) {
	const chips = [];
	if (summary.graduations > 0) {
		chips.push(`🎓 ${summary.graduations} graduated`);
	}
	if (summary.launches > 0) {
		chips.push(`🚀 ${summary.launches} launched`);
	}
	if (summary.topMcap >= 1000) {
		chips.push(`💰 ${fmtUsd(summary.topMcap)} peak`);
	}
	if (summary.uniquePayers > 0) {
		chips.push(`👥 ${summary.uniquePayers} supporters`);
	}
	if (summary.reputationTier) {
		chips.push(`🛡️ ${summary.reputationTier}`);
	}
	return chips;
}

function badgeTile(a) {
	const tier = TIER_META[a.tier] || TIER_META.bronze;
	const tile = el('div', {
		class: `aap-badge aap-tier-${a.tier}`,
		style: `--aap-accent:${tier.accent}`,
		title: a.earnedAt ? `${a.title} · earned ${whenAgo(a.earnedAt)}` : a.title,
		role: 'listitem',
		tabindex: '0',
		'aria-label': `${a.title}, ${tier.label} achievement${a.earnedAt ? `, earned ${whenAgo(a.earnedAt)}` : ''}. ${a.description}`,
	}, [
		el('span', { class: 'aap-badge-icon', 'aria-hidden': 'true', text: a.icon }),
		el('span', { class: 'aap-badge-title', text: a.title }),
		el('span', { class: 'aap-badge-tier', text: tier.label }),
		a.earnedAt ? el('span', { class: 'aap-badge-when', text: whenAgo(a.earnedAt) }) : null,
	]);
	return tile;
}

function lockedRow(a) {
	const pct = Math.max(0, Math.min(1, a.progress?.pct ?? 0));
	return el('div', { class: 'aap-locked-row', title: a.description, role: 'listitem' }, [
		el('span', { class: 'aap-locked-icon', 'aria-hidden': 'true', text: a.icon }),
		el('div', { class: 'aap-locked-main' }, [
			el('div', { class: 'aap-locked-head' }, [
				el('span', { class: 'aap-locked-title', text: a.title }),
				el('span', { class: 'aap-locked-prog', text: progressLabel(a) }),
			]),
			el('div', {
				class: 'aap-locked-bar',
				role: 'progressbar',
				'aria-valuemin': '0',
				'aria-valuemax': '100',
				'aria-valuenow': String(Math.round(pct * 100)),
				'aria-label': `${a.title} progress`,
			}, [
				el('div', { class: 'aap-locked-fill', style: `width:${(pct * 100).toFixed(1)}%` }),
			]),
		]),
	]);
}

function skeleton() {
	return el('div', { class: 'aap-skeleton', 'aria-hidden': 'true' },
		Array.from({ length: 6 }, () => el('span', { class: 'aap-skel-tile' })),
	);
}

function emptyState(isOwner) {
	return el('div', { class: 'aap-empty' }, [
		el('span', { class: 'aap-empty-icon', 'aria-hidden': 'true', text: '🏅' }),
		el('p', {
			class: 'aap-empty-text',
			text: isOwner
				? 'No achievements yet. Launch a coin, earn supporters, and graduate a token to start collecting badges.'
				: 'No achievements yet — this agent is just getting started.',
		}),
		isOwner
			? el('a', { class: 'aap-empty-cta', href: '/launch', text: 'Launch a coin →' })
			: null,
	]);
}

function errorState(retry) {
	return el('div', { class: 'aap-error', role: 'alert' }, [
		el('span', { class: 'aap-error-msg', text: 'Couldn’t load achievements.' }),
		el('button', { class: 'aap-retry', type: 'button', text: 'Retry', onclick: retry }),
	]);
}

function render(data, isOwner) {
	const earned = (data.earned || []).slice().sort((a, b) => {
		const t = (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0);
		if (t) return t;
		return new Date(b.earnedAt || 0) - new Date(a.earnedAt || 0);
	});
	const summary = data.summary || {};

	const frag = document.createDocumentFragment();

	// Summary line — earned count + headline real-world stats.
	const sumChips = summaryChips(summary);
	frag.appendChild(
		el('div', { class: 'aap-summary' }, [
			el('span', { class: 'aap-count', text: `${summary.earnedCount || 0} / ${summary.total || 0} earned` }),
			...sumChips.map((c) => el('span', { class: 'aap-stat-chip', text: c })),
		]),
	);

	if (!earned.length) {
		frag.appendChild(emptyState(isOwner));
	} else {
		frag.appendChild(
			el('div', { class: 'aap-grid', role: 'list', 'aria-label': 'Earned achievements' },
				earned.map(badgeTile),
			),
		);
	}

	// In-progress: the locked achievements closest to unlocking — a clear "what's
	// next" ladder. Show the top 4 by completion so the section stays focused.
	const next = (data.locked || [])
		.filter((a) => (a.progress?.pct ?? 0) > 0)
		.sort((a, b) => (b.progress?.pct ?? 0) - (a.progress?.pct ?? 0))
		.slice(0, 4);
	if (next.length) {
		frag.appendChild(el('div', { class: 'aap-next-head', text: 'In progress' }));
		frag.appendChild(
			el('div', { class: 'aap-locked-list', role: 'list', 'aria-label': 'Achievements in progress' },
				next.map(lockedRow),
			),
		);
	}

	return frag;
}

let stylesInjected = false;
const STYLES = `
.aap { display: block; }
.aap-summary { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 14px; }
.aap-count { font-size: 12px; font-weight: 700; letter-spacing: .03em; color: var(--ink-bright, #e8e8e8);
	background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); padding: 3px 10px; border-radius: 999px; }
.aap-stat-chip { font-size: 12px; color: var(--ink-dim, rgba(255,255,255,0.7)); background: rgba(255,255,255,0.04);
	border: 1px solid rgba(255,255,255,0.07); padding: 3px 9px; border-radius: 999px; }
.aap-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.aap-badge { position: relative; display: flex; flex-direction: column; align-items: center; gap: 4px; text-align: center;
	padding: 14px 8px 10px; border-radius: 14px; cursor: default;
	background: linear-gradient(160deg, color-mix(in srgb, var(--aap-accent) 16%, transparent), rgba(255,255,255,0.02));
	border: 1px solid color-mix(in srgb, var(--aap-accent) 38%, transparent);
	box-shadow: inset 0 1px 0 rgba(255,255,255,0.06); transition: transform .15s ease, box-shadow .15s ease; }
.aap-badge:hover, .aap-badge:focus-visible { transform: translateY(-2px);
	box-shadow: 0 6px 20px color-mix(in srgb, var(--aap-accent) 24%, transparent), inset 0 1px 0 rgba(255,255,255,0.08); outline: none; }
.aap-badge:focus-visible { outline: 2px solid var(--aap-accent); outline-offset: 2px; }
.aap-badge-icon { font-size: 30px; line-height: 1; filter: drop-shadow(0 2px 4px rgba(0,0,0,0.4)); }
.aap-badge-title { font-size: 12px; font-weight: 600; color: var(--ink-bright, #f0f0f0); line-height: 1.2; }
.aap-badge-tier { font-size: 9px; text-transform: uppercase; letter-spacing: .08em; font-weight: 700;
	color: var(--aap-accent); }
.aap-badge-when { font-size: 10px; color: var(--ink-dim, rgba(255,255,255,0.45)); }
.aap-tier-legendary { background: linear-gradient(160deg, rgba(192,132,252,0.22), rgba(251,191,36,0.1)); }

.aap-next-head { margin: 18px 0 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
	color: var(--ink-dim, rgba(255,255,255,0.5)); font-weight: 700; }
.aap-locked-list { display: flex; flex-direction: column; gap: 10px; }
.aap-locked-row { display: flex; align-items: center; gap: 10px; opacity: .92; }
.aap-locked-icon { font-size: 20px; line-height: 1; filter: grayscale(.5) opacity(.85); flex: 0 0 auto; }
.aap-locked-main { flex: 1 1 auto; min-width: 0; }
.aap-locked-head { display: flex; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.aap-locked-title { font-size: 12px; font-weight: 600; color: var(--ink-bright, #e8e8e8); }
.aap-locked-prog { font-size: 11px; color: var(--ink-dim, rgba(255,255,255,0.55)); white-space: nowrap;
	font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.aap-locked-bar { height: 5px; border-radius: 999px; background: rgba(255,255,255,0.08); overflow: hidden; }
.aap-locked-fill { height: 100%; border-radius: 999px;
	background: linear-gradient(90deg, var(--accent, #7c83ff), #a78bfa); transition: width .5s ease; }

.aap-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 8px; padding: 18px 12px; }
.aap-empty-icon { font-size: 30px; opacity: .8; }
.aap-empty-text { margin: 0; font-size: 13px; color: var(--ink-dim, rgba(255,255,255,0.6)); max-width: 36ch; }
.aap-empty-cta { font-size: 13px; font-weight: 600; color: var(--accent, #7c83ff); text-decoration: none; }
.aap-empty-cta:hover { opacity: .8; }

.aap-skeleton { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 10px; }
.aap-skel-tile { height: 92px; border-radius: 14px;
	background: linear-gradient(90deg, rgba(255,255,255,0.05) 25%, rgba(255,255,255,0.1) 37%, rgba(255,255,255,0.05) 63%);
	background-size: 400% 100%; animation: aap-shimmer 1.4s ease infinite; }
@keyframes aap-shimmer { 0% { background-position: 100% 50%; } 100% { background-position: 0 50%; } }
@media (prefers-reduced-motion: reduce) { .aap-skel-tile { animation: none; } .aap-badge, .aap-locked-fill { transition: none; } }

.aap-error { display: flex; align-items: center; gap: 10px; color: var(--ink-dim, rgba(255,255,255,0.6)); font-size: 13px; }
.aap-error-msg { flex: 1 1 auto; }
.aap-retry { background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: inherit;
	border-radius: 7px; padding: 3px 10px; font-size: 12px; cursor: pointer; transition: background .15s; }
.aap-retry:hover { background: rgba(255,255,255,0.14); }
.aap-retry:focus-visible { outline: 2px solid var(--accent, #7c83ff); outline-offset: 1px; }
`;

function injectStyles() {
	if (stylesInjected || typeof document === 'undefined') return;
	const tag = document.createElement('style');
	tag.dataset.aapStyles = '1';
	tag.textContent = STYLES;
	document.head.appendChild(tag);
	stylesInjected = true;
}

/**
 * Mount the achievements panel.
 *
 * @param {object} opts
 * @param {HTMLElement} opts.mount    — container to render into
 * @param {string}      opts.agentId  — agent UUID
 * @param {boolean}     [opts.isOwner]— tailors the empty-state copy + CTA
 * @param {HTMLElement} [opts.card]   — optional wrapping card to hide when there
 *                                      is genuinely nothing to show to a visitor
 * @returns {{ destroy: () => void }}
 */
export function mountAchievements({ mount, agentId, isOwner = false, card = null } = {}) {
	if (!mount || !agentId) return { destroy() {} };
	injectStyles();
	mount.classList.add('aap');

	let destroyed = false;
	let abort = null;

	async function load() {
		if (destroyed) return;
		if (abort) abort.abort();
		abort = new AbortController();
		mount.replaceChildren(skeleton());
		try {
			const r = await fetch(`/api/agents/${encodeURIComponent(agentId)}/achievements`, {
				signal: abort.signal,
			});
			if (!r.ok) throw new Error(`achievements ${r.status}`);
			const data = await r.json();
			if (destroyed) return;

			const hasContent =
				(data.earned?.length || 0) > 0 ||
				(data.locked || []).some((a) => (a.progress?.pct ?? 0) > 0);
			// For a visitor on a brand-new agent with literally nothing, hide the
			// whole card rather than show an empty shell. The owner always sees it
			// (with the encouraging empty state + launch CTA).
			if (!hasContent && !isOwner && card) {
				card.hidden = true;
				return;
			}
			if (card) card.hidden = false;
			mount.replaceChildren(render(data, isOwner));
		} catch (err) {
			if (err?.name === 'AbortError' || destroyed) return;
			mount.replaceChildren(errorState(load));
		}
	}

	load();

	return {
		destroy() {
			destroyed = true;
			if (abort) abort.abort();
		},
	};
}
