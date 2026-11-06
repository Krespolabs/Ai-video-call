// Library — animations, memory, strategy, voice tabs in one page.
// Hash-driven tab switcher (#tab=animations|memory|strategy|voice).

import { mountShell } from '../shell.js';
import { requireUser, esc } from '../api.js';
import { skeletonHTML, errorStateHTML, attachRetry, ensureStateKitStyles } from '../../shared/state-kit.js';
import { renderAnimations } from './library/animations.js';
import { renderMemory }     from './library/memory.js';
import { renderStrategy }   from './library/strategy.js';
import { renderVoice }      from './library/voice.js';
import { renderBrain }      from './library/brain.js';

const TABS = [
	{ key: 'brain',      label: 'Brain'      },
	{ key: 'animations', label: 'Animations' },
	{ key: 'memory',     label: 'Memory'     },
	{ key: 'strategy',   label: 'Strategy'   },
	{ key: 'voice',      label: 'Voice'      },
];

const RENDERERS = {
	brain:      renderBrain,
	animations: renderAnimations,
	memory:     renderMemory,
	strategy:   renderStrategy,
	voice:      renderVoice,
};

function readTab() {
	const m = /(?:^|[#&])tab=([a-z]+)/.exec(location.hash || '');
	const t = m?.[1];
	return TABS.some((x) => x.key === t) ? t : 'brain';
}

function writeTab(tab) {
	const hash = `#tab=${tab}`;
	if (location.hash !== hash) history.replaceState(null, '', hash);
}

(async function boot() {
	const main = await mountShell();
	const me = await requireUser();
	if (!me) return;

	ensureStateKitStyles();

	main.innerHTML = `
		<h1 class="dn-h1">Library</h1>
		<p class="dn-h1-sub">Brain, animations, memories, strategy, and voices your agents can draw on.</p>

		<div class="lib-tabstrip" role="tablist" aria-label="Library sections">
			${TABS.map((t) => `
				<button
					class="dn-tag lib-tab"
					role="tab"
					data-tab="${t.key}"
					aria-controls="tab-body"
					id="tab-${t.key}"
					type="button"
					tabindex="-1"
				>${esc(t.label)}</button>
			`).join('')}
		</div>

		<div data-slot="tab-body" id="tab-body" role="tabpanel" aria-labelledby="tab-animations"></div>

		<style>
			.lib-tabstrip {
				position: sticky;
				top: 0;
				z-index: 5;
				display: flex;
				gap: 8px;
				flex-wrap: wrap;
				padding: 12px 0 14px;
				margin-bottom: 6px;
				background: linear-gradient(to bottom, var(--nxt-bg-0) 70%, transparent);
			}
			.lib-tab {
				cursor: pointer;
				border: 1px solid var(--nxt-border, rgba(255,255,255,0.08));
				background: rgba(255,255,255,0.02);
				color: var(--nxt-ink-dim);
				padding: 7px 14px;
				font-size: 13px;
				font-weight: 500;
				border-radius: 999px;
				transition: background 0.12s ease, color 0.12s ease, border-color 0.12s ease;
			}
			.lib-tab:hover { color: var(--nxt-ink); border-color: var(--nxt-stroke-strong); }
			.lib-tab:active { transform: translateY(0.5px); }
			.lib-tab:focus-visible { outline: 2px solid var(--nxt-accent); outline-offset: 2px; }
			.lib-tab[aria-selected="true"] {
				background: rgba(106, 220, 142, 0.16);
				color: #b3f0c5;
				border-color: rgba(106, 220, 142, 0.45);
			}
			.lib-tabstrip + [data-slot="tab-body"] { min-height: 60vh; }
			.lib-loading {
				display: grid;
				gap: 10px;
				padding: 8px 0;
			}
			@media (prefers-reduced-motion: reduce) {
				.lib-tab { transition: none; }
				.lib-tab:active { transform: none; }
			}
		</style>
	`;

	const body = main.querySelector('[data-slot="tab-body"]');
	const tabBtns = Array.from(main.querySelectorAll('.lib-tab'));

	function activate(tab) {
		writeTab(tab);
		body.id = 'tab-body';
		body.setAttribute('aria-labelledby', `tab-${tab}`);
		tabBtns.forEach((b) => {
			const on = b.dataset.tab === tab;
			b.setAttribute('aria-selected', on ? 'true' : 'false');
			// Roving tabindex: only the active tab is in the sequential tab order;
			// the arrow keys move focus between the rest.
			b.tabIndex = on ? 0 : -1;
		});
		body.innerHTML = `
			<div class="lib-loading">
				${skeletonHTML(1, 'text')}
				${skeletonHTML(3, 'row')}
			</div>
		`;
		const render = RENDERERS[tab];
		Promise.resolve()
			.then(() => render(body, { me }))
			.catch((err) => {
				const raw = err?.message || String(err);
				const status = err?.status || 0;
				const friendly = (status === 401 || /unauthorized|sign in|bearer/i.test(raw))
					? 'Your session expired. Refresh the page to sign back in.'
					: (status === 403 || /forbidden/i.test(raw))
						? "You don't have permission to view this."
						: (status === 429 || /rate.?limit/i.test(raw))
							? 'Slow down — try again in a moment.'
							: raw.replace(/^HTTP\s+\d+\s*/i, '') || 'Unknown error.';
				body.innerHTML = errorStateHTML({
					title: "Couldn't load this tab",
					body: esc(friendly),
					scope: tab,
				});
				attachRetry(body, () => activate(tab));
			});
	}

	tabBtns.forEach((b) => b.addEventListener('click', () => activate(b.dataset.tab)));

	// Arrow-key navigation across the tablist (WAI-ARIA tabs pattern).
	main.querySelector('.lib-tabstrip')?.addEventListener('keydown', (e) => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
		const idx = tabBtns.findIndex((b) => b === document.activeElement);
		if (idx === -1) return;
		e.preventDefault();
		let next = idx;
		if (e.key === 'ArrowLeft') next = (idx - 1 + tabBtns.length) % tabBtns.length;
		else if (e.key === 'ArrowRight') next = (idx + 1) % tabBtns.length;
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = tabBtns.length - 1;
		const btn = tabBtns[next];
		btn.focus();
		activate(btn.dataset.tab);
	});

	window.addEventListener('hashchange', () => activate(readTab()));

	activate(readTab());
})();
