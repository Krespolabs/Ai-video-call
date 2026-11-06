// stage-link — the Living Stages entry point on an agent's profile.
//
// Mounts a compact panel that cross-links an agent to its live stage:
//   • visitors  — a "● LIVE — watch now" badge when the agent is performing, or a
//                 "next show" / "view stage" link when a stage exists but is dark.
//   • the owner — when no stage exists, a one-tap "Put <name> on stage"; once it
//                 exists, Go live / End show controls + the venue link.
//
// Self-contained: it owns its own fetch + state and renders into a container, so
// agent-detail.js mounts it with one call (like mountPresence). All writes go
// through apiFetch (CSRF handled) and enforce ownership server-side.

import { apiFetch } from '../api.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function mountStagePanel({ agentId, agentName = 'this agent', isOwner = false, container, position = 'append' } = {}) {
	if (!agentId || !container) return null;
	const el = document.createElement('div');
	el.className = 'stage-link-panel';
	el.innerHTML = '<div class="slp-loading">Loading stage…</div>';
	if (position === 'prepend') container.prepend(el);
	else container.append(el);

	injectStyle();
	const panel = new StagePanel(el, { agentId, agentName, isOwner });
	await panel.refresh();
	return panel;
}

class StagePanel {
	constructor(el, opts) {
		this.el = el;
		this.opts = opts;
		this.stage = null;
		this.busy = false;
	}

	async refresh() {
		try {
			const res = await apiFetch(`/api/stage?agentId=${encodeURIComponent(this.opts.agentId)}`, { allowAnonymous: true });
			const data = await res.json();
			this.stage = data.stage || null;
		} catch {
			this.stage = null;
		}
		this.render();
	}

	render() {
		const { agentName, isOwner } = this.opts;
		const s = this.stage;

		if (!s) {
			if (!isOwner) { this.el.remove(); return; } // nothing to show a visitor
			this.el.innerHTML = `
				<div class="slp-head"><span class="slp-kicker">Living Stage</span></div>
				<p class="slp-copy">Put ${esc(agentName)} on stage — host a live, monetized show and get tipped in $THREE on the spot.</p>
				<button class="slp-btn primary" data-act="create">Create a stage</button>
				<p class="slp-status" aria-live="polite"></p>`;
			this.wire();
			return;
		}

		const live = s.live;
		const next = s.next_show_at && !live ? new Date(s.next_show_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
		const link = `/stage?id=${encodeURIComponent(s.id)}`;
		const ownerControls = isOwner
			? `<div class="slp-owner">
					${live
						? '<button class="slp-btn" data-act="endshow">End show</button>'
						: '<button class="slp-btn primary" data-act="golive">Go live</button>'}
					<a class="slp-btn ghost" href="${link}">Open venue</a>
				</div>`
			: `<a class="slp-btn ${live ? 'primary' : ''}" href="${link}">${live ? 'Watch live' : 'View stage'}</a>`;

		this.el.innerHTML = `
			<div class="slp-head">
				<span class="slp-kicker">Living Stage</span>
				${live ? '<span class="slp-live">● LIVE</span>' : (next ? `<span class="slp-soon">Next ${esc(next)}</span>` : '<span class="slp-soon">Stage ready</span>')}
			</div>
			<p class="slp-copy">${esc(s.title || `${agentName} Live`)} · ${esc(s.format || 'live')}</p>
			${ownerControls}
			<p class="slp-status" aria-live="polite"></p>`;
		this.wire();
	}

	wire() {
		this.el.querySelectorAll('[data-act]').forEach((b) => {
			b.addEventListener('click', () => this.act(b.dataset.act, b));
		});
	}

	async act(action, btn) {
		if (this.busy) return;
		this.busy = true;
		const status = this.el.querySelector('.slp-status');
		const orig = btn.textContent;
		btn.disabled = true;
		btn.textContent = '…';
		try {
			let body;
			if (action === 'create') body = { action: 'create', agentId: this.opts.agentId };
			else if (action === 'golive') body = { action: 'golive', stageId: this.stage.id };
			else if (action === 'endshow') body = { action: 'endshow', stageId: this.stage.id };
			const res = await apiFetch('/api/stage', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			const out = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(out.error || 'request failed');
			if (action === 'golive' && out.link) {
				status.textContent = 'You are live! Opening the venue…';
				setTimeout(() => { location.href = out.link; }, 700);
				return;
			}
			await this.refresh();
		} catch (err) {
			status.textContent = err?.message || 'Something went wrong.';
			btn.disabled = false;
			btn.textContent = orig;
		} finally {
			this.busy = false;
		}
	}
}

let _styled = false;
function injectStyle() {
	if (_styled) return;
	_styled = true;
	const css = `
	.stage-link-panel{border:1px solid rgba(155,107,255,.25);background:rgba(155,107,255,.06);border-radius:14px;padding:14px 16px;margin:14px 0;font-family:inherit}
	.stage-link-panel .slp-head{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:6px}
	.stage-link-panel .slp-kicker{font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#9b6bff}
	.stage-link-panel .slp-live{font-size:12px;font-weight:700;color:#ff5db1;animation:slpPulse 1.5s infinite}
	.stage-link-panel .slp-soon{font-size:12px;color:#a59fc4}
	.stage-link-panel .slp-copy{margin:0 0 10px;font-size:14px;opacity:.9}
	.stage-link-panel .slp-owner{display:flex;gap:8px;flex-wrap:wrap}
	.stage-link-panel .slp-btn{display:inline-block;padding:8px 16px;border-radius:9px;border:1px solid rgba(155,107,255,.3);background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;transition:background .15s,transform .1s}
	.stage-link-panel .slp-btn:hover{background:rgba(155,107,255,.18)}
	.stage-link-panel .slp-btn:active{transform:scale(.97)}
	.stage-link-panel .slp-btn.primary{background:linear-gradient(90deg,#9b6bff,#32d6ff);border:0;color:#fff}
	.stage-link-panel .slp-btn.ghost{opacity:.85}
	.stage-link-panel .slp-btn:focus-visible{outline:2px solid #32d6ff;outline-offset:2px}
	.stage-link-panel .slp-status{margin:8px 0 0;font-size:12px;color:#a59fc4;min-height:14px}
	@keyframes slpPulse{0%,100%{opacity:1}50%{opacity:.4}}`;
	const tag = document.createElement('style');
	tag.textContent = css;
	document.head.appendChild(tag);
}
