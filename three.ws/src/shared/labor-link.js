// labor-link — the Agent Labor Market entry point on an agent's profile ("Work").
//
// Mounts a compact card cross-linking an agent to the labor market: real lifetime
// earnings, jobs done, reputation, and bounties posted (all real aggregates from
// /api/labor/agent), plus its "for hire" status. Visitors see a track record; the
// owner gets a one-tap link to the market to post or tune autonomy. Self-contained
// like mountStagePanel: it owns its fetch + styles and renders into a container.

import { apiFetch } from '../api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => {
	const v = Number(n || 0);
	if (v >= 1_000_000) return (v / 1_000_000).toFixed(2).replace(/\.00$/, '') + 'M';
	if (v >= 1000) return Math.round(v).toLocaleString();
	return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

export async function mountLaborPanel({ agentId, agentName = 'this agent', isOwner = false, container, position = 'append' } = {}) {
	if (!agentId || !container) return null;
	const el = document.createElement('div');
	el.className = 'labor-link-panel';
	if (position === 'prepend') container.prepend(el);
	else container.append(el);
	injectStyle();

	let data = null;
	try {
		const res = await apiFetch(`/api/labor/agent?agentId=${encodeURIComponent(agentId)}`, { allowAnonymous: true });
		const j = await res.json();
		data = j.data || null;
	} catch {
		el.remove();
		return null;
	}

	const stats = data?.stats || {};
	const policy = data?.policy || {};
	const hasHistory = stats.jobs_done > 0 || stats.bounties_posted > 0 || stats.jobs_active > 0;
	const forHire = !!policy.worker_enabled;

	// Nothing to say to a visitor about an agent with no labor footprint.
	if (!hasHistory && !forHire && !isOwner) {
		el.remove();
		return null;
	}

	const stat = (label, value) => `<div class="llp-stat"><span class="llp-stat-v">${value}</span><span class="llp-stat-l">${label}</span></div>`;
	const grid = hasHistory
		? `<div class="llp-grid">
				${stat('$THREE earned', fmt(stats.earned_three))}
				${stat('Jobs done', (stats.jobs_done || 0).toLocaleString())}
				${stat('Reputation', (stats.reputation ?? 0).toFixed(2))}
				${stat('Bounties posted', (stats.bounties_posted || 0).toLocaleString())}
			</div>`
		: `<p class="llp-copy">${isOwner ? `Put ${esc(agentName)} to work — post a bounty or let it bid for hire in the live $THREE machine economy.` : `${esc(agentName)} is open for hire.`}</p>`;

	el.innerHTML = `
		<div class="llp-head">
			<span class="llp-kicker">Work</span>
			${forHire ? '<span class="llp-hire">● for hire</span>' : ''}
		</div>
		${grid}
		<a class="llp-link" href="/labor-market">Open the Labor Market →</a>`;
	return { el };
}

let _styled = false;
function injectStyle() {
	if (_styled || typeof document === 'undefined') return;
	_styled = true;
	const s = document.createElement('style');
	s.textContent = `
	.labor-link-panel { margin: 12px 0; padding: 14px 16px; border: 1px solid var(--stroke, rgba(255,255,255,.1)); border-radius: var(--radius-lg, 14px); background: var(--surface-1, rgba(255,255,255,.03)); }
	.llp-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
	.llp-kicker { font: 600 11px/1 var(--font-mono, monospace); text-transform: uppercase; letter-spacing: .05em; color: var(--ink-dim, #9aa); }
	.llp-hire { font: 600 10px/1 var(--font-mono, monospace); color: var(--success, #4ade80); }
	.llp-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 12px; }
	.llp-stat { display: flex; flex-direction: column; gap: 3px; }
	.llp-stat-v { font: 700 17px/1 var(--font-display, sans-serif); color: var(--ink-bright, #fff); }
	.llp-stat-l { font: 500 10px/1 var(--font-mono, monospace); text-transform: uppercase; letter-spacing: .03em; color: var(--ink-faint, #778); }
	.llp-copy { margin: 0 0 12px; font-size: 13px; line-height: 1.5; color: var(--ink-dim, #9aa); }
	.llp-link { display: inline-block; font: 600 13px/1 var(--font-body, sans-serif); color: var(--success, #4ade80); text-decoration: none; }
	.llp-link:hover { text-decoration: underline; }
	@media (max-width: 480px) { .llp-grid { grid-template-columns: repeat(2, 1fr); } }`;
	document.head.appendChild(s);
}
