/**
 * Agent Wallet hub — Pulse tab ("this wallet's story").
 *
 * The same real-data Money Pulse used on /pulse, scoped to ONE agent. Shows this
 * wallet's public lifetime: tips received, launches, trades and agent-to-agent
 * payments — every row a real, explorer-verifiable event from
 * GET /api/pulse?agent_id=. A lifetime summary (tips in, biggest tip, public
 * outflow, launches) sits on top, computed from the real ledger.
 *
 * Visible to owner AND visitor — it's the public story, identical for both.
 * Private withdrawals / custody / security events never appear here (they live in
 * the owner-only Custody trail). The OWNER additionally gets a server-enforced
 * toggle to include or hide this wallet from the GLOBAL public pulse feed.
 */

import { registerWalletTab } from '../registry.js';
import { mountMoneyPulse } from '../../shared/money-pulse.js';
import { consumeCsrfToken } from '../../api.js';

const PULSE_STYLE_ID = 'awh-pulse-style';
const PULSE_STYLE = `
.awp-summary { display:grid; grid-template-columns: repeat(4, 1fr); gap:8px; margin-bottom: var(--space-4,16px); }
.awp-stat { background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.07)); border-radius: var(--radius-md,10px); padding:11px 12px; }
.awp-stat dt { font-size: var(--text-2xs,.66rem); text-transform:uppercase; letter-spacing:.06em; color: var(--ink-dim,#888); margin-bottom:5px; }
.awp-stat dd { margin:0; font-family: var(--font-mono,ui-monospace,monospace); font-size: var(--text-lg,1rem); font-weight:700; color: var(--ink-bright,#fff); }
.awp-stat dd small { display:block; font-family: var(--font-body,sans-serif); font-weight:400; font-size: var(--text-2xs,.66rem); color: var(--wallet-accent,#c4b5fd); margin-top:2px; }
.awp-toggle { display:flex; align-items:center; justify-content:space-between; gap:12px; background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding:12px 14px; margin-bottom: var(--space-4,16px); }
.awp-toggle-txt { font-size: var(--text-sm,.78rem); color: var(--ink,#e8e8e8); }
.awp-toggle-txt small { display:block; color: var(--ink-dim,#888); font-size: var(--text-2xs,.66rem); margin-top:3px; line-height:1.4; }
.awp-switch { position:relative; flex:0 0 auto; width:42px; height:24px; }
.awp-switch input { position:absolute; opacity:0; width:100%; height:100%; margin:0; cursor:pointer; }
.awp-switch .track { position:absolute; inset:0; border-radius:999px; background: var(--surface-3, rgba(255,255,255,.12)); transition: background .16s ease; }
.awp-switch .track::before { content:""; position:absolute; top:3px; left:3px; width:18px; height:18px; border-radius:50%; background:#fff; transition: transform .16s ease; }
.awp-switch input:checked + .track { background: var(--wallet-accent, #c4b5fd); }
.awp-switch input:checked + .track::before { transform: translateX(18px); }
.awp-switch input:focus-visible + .track { outline: 2px solid var(--wallet-accent,#c4b5fd); outline-offset:2px; }
.awp-switch input:disabled { cursor: default; }
.awp-skel-bar { display:block; background: var(--surface-2, rgba(255,255,255,.06)); border-radius: var(--radius-sm,6px); animation: awp-skel 1.4s ease-in-out infinite; }
.awp-skel-bar.dt { height:9px; width:60%; margin-bottom:9px; }
.awp-skel-bar.dd { height:16px; width:45%; }
@keyframes awp-skel { 0%,100%{ opacity:.5; } 50%{ opacity:1; } }
@media (max-width:520px){ .awp-summary { grid-template-columns: repeat(2,1fr); } }
@media (prefers-reduced-motion: reduce){ .awp-switch .track, .awp-switch .track::before { transition: none; } .awp-skel-bar { animation: none; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(PULSE_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = PULSE_STYLE_ID;
	tag.textContent = PULSE_STYLE;
	document.head.appendChild(tag);
}

const fmtSol = (n) => `◎${Number(n) >= 1 ? Number(n).toFixed(2) : Number(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
const fmtUsd = (n) => (Number(n) > 0 ? `$${Number(n).toFixed(Number(n) < 10 ? 2 : 0)}` : '');

async function fetchSummary(agentId, network) {
	try {
		const r = await fetch(`/api/pulse?view=agent-summary&agent_id=${encodeURIComponent(agentId)}&network=${network}`, {
			headers: { accept: 'application/json' },
		});
		if (!r.ok) return null;
		const j = await r.json();
		return j.data;
	} catch {
		return null;
	}
}

registerWalletTab({
	id: 'pulse',
	label: 'Pulse',
	order: 35,
	ownerOnly: false,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml: esc } = ctx;
		let destroyed = false;
		let pulse = null;
		let detachNet = null;

		panel.innerHTML =
			`<div class="awp-summary" id="awp-summary" role="group" aria-label="Wallet lifetime summary"></div>` +
			(ctx.isOwner ? `<div id="awp-toggle"></div>` : '') +
			`<div id="awp-feed"></div>`;

		const summaryHost = panel.querySelector('#awp-summary');
		const feedHost = panel.querySelector('#awp-feed');

		function skeletonSummary() {
			return Array.from({ length: 4 }, () =>
				`<dl class="awp-stat" aria-hidden="true"><span class="awp-skel-bar dt"></span><span class="awp-skel-bar dd"></span></dl>`,
			).join('');
		}

		function renderSummary(s) {
			summaryHost.removeAttribute('aria-busy');
			if (!s) { summaryHost.style.display = 'none'; return; }
			summaryHost.style.removeProperty('display');
			const tipMain = s.tips.usd > 0 ? fmtUsd(s.tips.usd) : fmtSol(s.tips.sol);
			const biggest = s.tips.biggest_usd > 0 ? fmtUsd(s.tips.biggest_usd) : (s.tips.biggest_sol > 0 ? fmtSol(s.tips.biggest_sol) : '—');
			summaryHost.innerHTML =
				`<dl class="awp-stat"><dt>Tips received</dt><dd>${esc(tipMain)}<small>${s.tips.count} tip${s.tips.count === 1 ? '' : 's'}</small></dd></dl>` +
				`<dl class="awp-stat"><dt>Biggest tip</dt><dd>${esc(biggest)}</dd></dl>` +
				`<dl class="awp-stat"><dt>Public outflow</dt><dd>${esc(s.outflow.usd > 0 ? fmtUsd(s.outflow.usd) : fmtSol(s.outflow.sol))}<small>${s.outflow.count} move${s.outflow.count === 1 ? '' : 's'}</small></dd></dl>` +
				`<dl class="awp-stat"><dt>Launches</dt><dd>${s.launches}</dd></dl>`;
		}

		async function loadSummary() {
			summaryHost.setAttribute('aria-busy', 'true');
			summaryHost.innerHTML = skeletonSummary();
			const s = await fetchSummary(ctx.agentId, ctx.getNetwork());
			if (!destroyed) renderSummary(s);
		}

		// Owner-only: include/hide from the global public pulse (server-enforced).
		async function mountToggle() {
			if (!ctx.isOwner) return;
			const host = panel.querySelector('#awp-toggle');
			if (!host) return;
			let cur = null;
			try {
				const r = await fetch(`/api/agents/${encodeURIComponent(ctx.agentId)}/solana/pulse-visibility`, { credentials: 'include' });
				if (r.ok) cur = (await r.json()).data;
			} catch { /* render with a safe default */ }
			if (destroyed) return;
			const inFeed = cur ? cur.in_public_pulse : true;
			const isPublic = cur ? cur.is_public : true;
			host.innerHTML =
				`<div class="awp-toggle">` +
				`<div class="awp-toggle-txt">Show in the public Money Pulse` +
				`<small id="awp-vis-desc">${isPublic ? 'Your wallet’s already-public events appear in the platform-wide /pulse discovery feed. Turn off to keep them off the global feed (your own profile still shows them).' : 'This agent is private, so it never appears in the public pulse regardless of this setting.'}</small></div>` +
				`<label class="awp-switch"><input type="checkbox" id="awp-vis" ${inFeed ? 'checked' : ''} ${isPublic ? '' : 'disabled'} aria-label="Show this wallet in the public Money Pulse" aria-describedby="awp-vis-desc" /><span class="track"></span></label>`;
			const input = host.querySelector('#awp-vis');
			input?.addEventListener('change', async () => {
				const optOut = !input.checked;
				input.disabled = true;
				try {
					const token = await consumeCsrfToken();
					const r = await fetch(`/api/agents/${encodeURIComponent(ctx.agentId)}/solana/pulse-visibility`, {
						method: 'PUT',
						credentials: 'include',
						headers: { 'content-type': 'application/json', ...(token ? { 'x-csrf-token': token } : {}) },
						body: JSON.stringify({ opt_out: optOut }),
					});
					if (!r.ok) throw new Error('save failed');
					ctx.toast?.(optOut ? 'Hidden from the public pulse' : 'Showing in the public pulse');
				} catch {
					input.checked = !input.checked; // revert on failure
					ctx.toast?.('Couldn’t update — try again', 'error');
				} finally {
					if (!destroyed) input.disabled = !isPublic ? true : false;
				}
			});
		}

		pulse = mountMoneyPulse({
			mount: feedHost,
			variant: 'agent',
			agentId: ctx.agentId,
			network: ctx.getNetwork(),
			controls: true,
			live: true,
			emptyHint: ctx.isOwner
				? 'No public activity yet. Launch a coin, make a trade, or share your wallet to get tipped — it shows here.'
				: 'This wallet has no public activity yet.',
		});

		loadSummary();
		mountToggle();

		detachNet = ctx.onNetworkChange((net) => {
			pulse?.setNetwork(net);
			loadSummary();
		});

		return {
			onShow() { pulse?.refresh?.(); },
			destroy() {
				destroyed = true;
				detachNet?.();
				pulse?.destroy?.();
			},
		};
	},
});
