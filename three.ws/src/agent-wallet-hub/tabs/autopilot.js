/**
 * Agent Wallet hub — Treasury Autopilot tab (task 14).
 *
 * Owner-only. The agent that funds its own existence: write a treasury policy in
 * plain English, review the compiled rules, arm it, and watch a real runway view.
 * Every armed rule executes as a real, idempotent, spend-policy-gated, audited
 * on-chain action on the agent's own wallet (api/_lib/treasury-autopilot.js):
 * self-fund compute, hold a buffer, DCA income into $THREE, compound coin fees
 * into buybacks, sweep profit to the owner. A prominent kill switch halts
 * everything; every rule pauses/edits in one tap.
 *
 * Nothing here is simulated: the runway numbers come from real ledger reads and
 * real chain balances; "Run now" performs real cycles with explorer links; a
 * net-negative agent shows the honest truth, not a projection.
 */

import { registerWalletTab } from '../registry.js';
import { formatUsd, formatSol, explorerTxUrl } from '../util.js';
import { consumeCsrfToken } from '../../api.js';
import { ensureRiskAck } from '../../shared/risk-ack.js';

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const STYLE_ID = 'awh-autopilot-style';

const KIND_ICON = { self_fund: '🧠', buffer: '🛟', dca: '📈', buyback: '🔥', sweep: '🏦' };
const STATUS_TONE = {
	ok: 'ok', would_run: 'ok', confirmed: 'ok',
	skipped: 'muted', alert: 'warn', paused: 'warn',
	error: 'bad', failed: 'bad',
};

const STYLE = `
.ap-wrap { display:flex; flex-direction:column; gap: var(--space-lg,1.618rem); }
.ap-hero { background: linear-gradient(160deg, var(--wallet-accent-soft,rgba(139,92,246,.1)), var(--surface-1,rgba(255,255,255,.03))); border:1px solid var(--wallet-stroke,rgba(139,92,246,.3)); border-radius: var(--radius-lg,14px); padding: var(--space-lg,18px); position:relative; overflow:hidden; }
.ap-hero::after { content:''; position:absolute; inset:0; background: radial-gradient(120% 80% at 90% -10%, var(--wallet-glow,rgba(139,92,246,.25)), transparent 60%); pointer-events:none; opacity:.7; }
.ap-hero-top { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
.ap-badge { display:inline-flex; align-items:center; gap:6px; font-size: var(--text-2xs,.6875rem); font-weight:600; letter-spacing:.02em; text-transform:uppercase; padding:4px 10px; border-radius: var(--radius-pill,999px); border:1px solid currentColor; }
.ap-badge.live { color: var(--success,#4ade80); }
.ap-badge.off { color: var(--ink-dim,#888); }
.ap-badge.killed { color: var(--danger,#f87171); }
.ap-badge .dot { width:7px; height:7px; border-radius:50%; background: currentColor; box-shadow:0 0 8px currentColor; }
.ap-badge.live .dot { animation: ap-pulse 1.8s ease-in-out infinite; }
@keyframes ap-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
.ap-runway { margin-top: var(--space-md,14px); display:flex; align-items:baseline; gap:10px; flex-wrap:wrap; }
.ap-runway .big { font-family: var(--font-display,'Space Grotesk',sans-serif); font-size: var(--text-3xl,2rem); line-height:1; font-weight:600; color: var(--ink-bright,#fff); }
.ap-runway .lab { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); }
.ap-net { font-size: var(--text-sm,.764rem); font-weight:600; }
.ap-net.pos { color: var(--success,#4ade80); }
.ap-net.neg { color: var(--danger,#f87171); }

.ap-bars { margin-top: var(--space-md,14px); display:flex; flex-direction:column; gap:8px; }
.ap-bar-row { display:grid; grid-template-columns: 64px 1fr auto; align-items:center; gap:10px; font-size: var(--text-sm,.764rem); }
.ap-bar-row .k { color: var(--ink-dim,#888); }
.ap-bar { height:8px; border-radius: var(--radius-pill,999px); background: var(--surface-2,rgba(255,255,255,.06)); overflow:hidden; }
.ap-bar > i { display:block; height:100%; border-radius:inherit; transition: width var(--duration-base,220ms) var(--ease-standard,ease); }
.ap-bar.income > i { background: var(--success,#4ade80); }
.ap-bar.cost > i { background: var(--warn,#fbbf24); }
.ap-bar-row .v { font-family: var(--font-mono,ui-monospace,monospace); color: var(--ink,#e8e8e8); text-align:right; }

.ap-stats { display:grid; grid-template-columns: repeat(auto-fit, minmax(120px,1fr)); gap:8px; margin-top: var(--space-md,14px); }
.ap-stat { background: var(--surface-1,rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); padding:10px 12px; }
.ap-stat .l { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform:uppercase; letter-spacing:.03em; }
.ap-stat .n { font-family: var(--font-mono,ui-monospace,monospace); font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); margin-top:3px; }
.ap-stat .s { font-size: var(--text-2xs,.6875rem); color: var(--ink-faint,rgba(255,255,255,.45)); }

.ap-card { background: var(--surface-1,rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-lg,14px); padding: var(--space-lg,18px); }
.ap-card h3 { margin:0 0 4px; font-size: var(--text-ui,.875rem); color: var(--ink-bright,#fff); font-weight:600; }
.ap-card .sub { margin:0 0 var(--space-md,14px); font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); }
.ap-ta { width:100%; box-sizing:border-box; min-height:96px; resize:vertical; font:inherit; font-size: var(--text-md,.8125rem); line-height:1.5; color: var(--ink,#e8e8e8); background: var(--surface-1,rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:11px 13px; transition: border-color var(--duration-fast,140ms); }
.ap-ta:focus { outline:none; border-color: var(--wallet-stroke-strong,rgba(139,92,246,.5)); }
.ap-egs { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }
.ap-eg { appearance:none; font:inherit; font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#aaa); background: var(--surface-2,rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-pill,999px); padding:4px 10px; cursor:pointer; transition: color var(--duration-fast,140ms), border-color var(--duration-fast,140ms); }
.ap-eg:hover { color: var(--ink-bright,#fff); border-color: var(--wallet-stroke,rgba(139,92,246,.3)); }

.ap-actions { display:flex; gap:8px; flex-wrap:wrap; margin-top: var(--space-md,14px); }
.ap-btn { appearance:none; font:inherit; font-size: var(--text-sm,.764rem); font-weight:600; cursor:pointer; border-radius: var(--radius-md,10px); padding:9px 16px; border:1px solid var(--stroke-strong,rgba(255,255,255,.14)); background: var(--surface-2,rgba(255,255,255,.06)); color: var(--ink,#e8e8e8); transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms), transform var(--duration-fast,140ms); }
.ap-btn:hover { background: var(--surface-3,rgba(255,255,255,.09)); color: var(--ink-bright,#fff); }
.ap-btn:active { transform: translateY(1px); }
.ap-btn:disabled { opacity:.5; cursor:not-allowed; }
.ap-btn:focus-visible { outline: 2px solid var(--wallet-focus,rgba(139,92,246,.7)); outline-offset:2px; }
.ap-btn.primary { background: var(--wallet-accent,#c4b5fd); border-color: var(--wallet-accent,#c4b5fd); color:#160d28; }
.ap-btn.primary:hover { background: var(--wallet-accent-strong,#a78bfa); border-color: var(--wallet-accent-strong,#a78bfa); color:#160d28; }
.ap-btn.danger { color: var(--danger,#f87171); border-color: color-mix(in srgb, var(--danger,#f87171) 40%, transparent); background: color-mix(in srgb, var(--danger,#f87171) 8%, transparent); }
.ap-btn.danger:hover { background: color-mix(in srgb, var(--danger,#f87171) 16%, transparent); color:#fff; }
.ap-btn.ghost { background:transparent; border-color: var(--stroke,rgba(255,255,255,.1)); }

.ap-rules { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.ap-rule { display:flex; gap:11px; padding:11px 12px; border-radius: var(--radius-md,10px); border:1px solid var(--stroke,rgba(255,255,255,.08)); background: var(--surface-1,rgba(255,255,255,.03)); align-items:flex-start; }
.ap-rule[data-paused="true"] { opacity:.55; }
.ap-rule .ic { font-size:18px; line-height:1.2; flex:none; }
.ap-rule .body { flex:1; min-width:0; }
.ap-rule .ttl { font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); }
.ap-rule .note { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); margin-top:3px; }
.ap-rule .note a { color: var(--wallet-accent,#c4b5fd); border-bottom:1px dotted currentColor; }
.ap-rule .ctl { display:flex; gap:6px; align-items:center; flex:none; }
.ap-chip { font-size: var(--text-2xs,.6875rem); padding:2px 9px; border-radius: var(--radius-pill,999px); border:1px solid currentColor; text-transform:capitalize; }
.ap-chip.ok { color: var(--success,#4ade80); }
.ap-chip.warn { color: var(--warn,#fbbf24); }
.ap-chip.bad { color: var(--danger,#f87171); }
.ap-chip.muted { color: var(--ink-dim,#888); }
.ap-toggle { appearance:none; background:transparent; border:0; color: var(--ink-dim,#888); cursor:pointer; font-size: var(--text-2xs,.6875rem); padding:3px 6px; border-radius:6px; }
.ap-toggle:hover { color: var(--ink-bright,#fff); background: var(--surface-2,rgba(255,255,255,.06)); }

.ap-warn { border-radius: var(--radius-md,10px); padding:10px 12px; font-size: var(--text-sm,.764rem); margin-top:10px; }
.ap-warn.amber { background: color-mix(in srgb, var(--warn,#fbbf24) 10%, transparent); border:1px solid color-mix(in srgb, var(--warn,#fbbf24) 30%, transparent); color: var(--warn,#fbbf24); }
.ap-warn.red { background: color-mix(in srgb, var(--danger,#f87171) 10%, transparent); border:1px solid color-mix(in srgb, var(--danger,#f87171) 32%, transparent); color: var(--danger,#f87171); }
.ap-warn ul { margin:6px 0 0; padding-left:18px; }
.ap-warn li { margin:2px 0; }

.ap-fld { margin-top: var(--space-md,14px); }
.ap-fld label { display:block; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-bottom:6px; }
.ap-in { width:100%; box-sizing:border-box; font:inherit; font-size: var(--text-md,.8125rem); font-family: var(--font-mono,ui-monospace,monospace); color: var(--ink,#e8e8e8); background: var(--surface-1,rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:9px 12px; }
.ap-in:focus { outline:none; border-color: var(--wallet-stroke-strong,rgba(139,92,246,.5)); }

.ap-kill { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top: var(--space-md,14px); padding:11px 14px; border-radius: var(--radius-md,10px); border:1px solid color-mix(in srgb, var(--danger,#f87171) 28%, transparent); background: color-mix(in srgb, var(--danger,#f87171) 6%, transparent); }
.ap-kill .t { font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); }
.ap-kill .t b { color: var(--ink-bright,#fff); }

.ap-empty { text-align:center; padding: var(--space-lg,18px) var(--space-md,14px); color: var(--ink-dim,#888); font-size: var(--text-sm,.764rem); }
.ap-empty .ic { font-size:30px; margin-bottom:8px; }
.ap-skel { height:14px; border-radius:6px; background: var(--surface-2,rgba(255,255,255,.05)); animation: ap-sk 1.4s ease-in-out infinite; margin:10px 0; }
.ap-spin { display:inline-block; width:13px; height:13px; border:2px solid rgba(0,0,0,.25); border-top-color: currentColor; border-radius:50%; animation: ap-rot .7s linear infinite; vertical-align:-2px; margin-right:6px; }
@keyframes ap-rot { to { transform: rotate(360deg); } }
@keyframes ap-sk { 0%,100%{opacity:.4} 50%{opacity:.8} }
.ap-err { background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger,#f87171) 32%, transparent); color: var(--danger,#f87171); border-radius: var(--radius-md,10px); padding:10px 12px; font-size: var(--text-sm,.764rem); }
@media (prefers-reduced-motion: reduce) { .ap-skel, .ap-spin, .ap-badge.live .dot, .ap-bar > i { animation:none; transition:none; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

const EXAMPLES = [
	'Pay your own compute. Keep a 1 SOL buffer. Put 10% of tips into $THREE. Compound coin fees into buybacks weekly. Sweep anything over 3 SOL to me on Fridays.',
	'Settle your own LLM bills, hold a 0.5 SOL floor, and DCA 0.1 SOL a day into $THREE.',
	'Keep 2 SOL. Sweep everything above 5 SOL to my wallet every week.',
];

// ── fetch helper: never throws, always a designed result ──────────────────────
async function call(url, { method = 'GET', body = null } = {}) {
	try {
		const opts = { method, credentials: 'include', headers: {} };
		if (body != null) {
			opts.headers['content-type'] = 'application/json';
			opts.body = JSON.stringify(body);
		}
		if (method !== 'GET') {
			const token = await consumeCsrfToken();
			if (token) opts.headers['x-csrf-token'] = token;
		}
		const r = await fetch(url, opts);
		let j = null;
		try { j = await r.json(); } catch { /* empty body */ }
		if (!r.ok) {
			return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})` };
		}
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

function esc(s) {
	return String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
function fmtDays(d) {
	if (d == null) return null;
	if (!Number.isFinite(d)) return null;
	if (d >= 365) return `${(d / 365).toFixed(1)} yr`;
	if (d >= 1) return `${Math.round(d)} d`;
	return `${Math.round(d * 24)} h`;
}

registerWalletTab({
	id: 'autopilot',
	label: 'Autopilot',
	order: 48,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const base = (sub) => `/api/agents/${ctx.agentId}/autopilot${sub ? '/' + sub : ''}?network=${ctx.getNetwork()}`;

		let destroyed = false;
		const state = {
			loading: true,
			error: null,
			policy: null,
			runway: null,
			editing: false,
			source: '',
			compiled: null, // last compile preview
			compiling: false,
			running: false,
			lastRun: null,
		};

		async function load() {
			state.loading = true;
			render();
			const res = await call(base(''));
			if (destroyed) return;
			state.loading = false;
			if (!res.ok) {
				state.error = res.message;
			} else {
				state.error = null;
				state.policy = res.data.policy;
				state.runway = res.data.runway;
				state.source = state.policy?.source_text || '';
				// First-run: no rules yet → open the editor.
				if (!state.policy?.rules?.length && !state.compiled) state.editing = true;
			}
			render();
		}

		// ── renderers ────────────────────────────────────────────────────────────
		function render() {
			if (destroyed) return;
			if (state.loading) {
				panel.innerHTML = `<div class="ap-wrap" role="status" aria-busy="true" aria-label="Loading Autopilot"><div class="ap-card"><div class="ap-skel" style="width:40%"></div><div class="ap-skel"></div><div class="ap-skel" style="width:80%"></div></div><div class="ap-card"><div class="ap-skel" style="width:30%"></div><div class="ap-skel"></div></div></div>`;
				return;
			}
			if (state.error) {
				panel.innerHTML = `<div class="ap-wrap"><div class="ap-err" role="alert">Couldn’t load Autopilot: ${esc(state.error)}</div><div class="ap-actions"><button class="ap-btn" id="ap-retry" type="button">Retry</button></div></div>`;
				panel.querySelector('#ap-retry')?.addEventListener('click', load);
				return;
			}

			const p = state.policy;
			const killed = !!p.kill_switch;

			panel.innerHTML = `<div class="ap-wrap">${renderHero()}${killed ? renderKilledBanner() : ''}${state.editing ? renderEditor() : renderActiveRules()}</div>`;
			wire();
		}

		function renderHero() {
			const r = state.runway || {};
			const p = state.policy || {};
			const killed = !!p.kill_switch;
			const armed = !!p.armed && !killed;
			const badge = killed
				? `<span class="ap-badge killed"><span class="dot"></span>Halted</span>`
				: armed
					? `<span class="ap-badge live"><span class="dot"></span>Self-funding</span>`
					: `<span class="ap-badge off"><span class="dot"></span>Disarmed</span>`;

			const runwayDays = fmtDays(r.runway_days);
			const heroMain = r.self_sustaining
				? `<span class="big">Self-sustaining</span><span class="lab">income covers the burn</span>`
				: runwayDays
					? `<span class="big">${esc(runwayDays)}</span><span class="lab">runway at the current burn</span>`
					: `<span class="big">—</span><span class="lab">runway (needs balance + cost data)</span>`;

			const net = r.net_usd != null
				? `<span class="ap-net ${r.net_positive ? 'pos' : 'neg'}">${r.net_positive ? '▲' : '▼'} ${formatUsd(Math.abs(r.net_usd))} net / 30d</span>`
				: '';

			const incomeUsd = r.income_usd || 0;
			const costUsd = r.cost_usd || 0;
			const maxV = Math.max(incomeUsd, costUsd, 0.01);
			const bars = `
				<div class="ap-bars">
					<div class="ap-bar-row"><span class="k">Income</span><span class="ap-bar income" aria-hidden="true"><i style="width:${Math.round((incomeUsd / maxV) * 100)}%"></i></span><span class="v">${formatUsd(incomeUsd)}</span></div>
					<div class="ap-bar-row"><span class="k">Compute</span><span class="ap-bar cost" aria-hidden="true"><i style="width:${Math.round((costUsd / maxV) * 100)}%"></i></span><span class="v">${formatUsd(costUsd)}</span></div>
				</div>`;

			const stats = `
				<div class="ap-stats">
					<div class="ap-stat"><div class="l">Balance</div><div class="n">${formatSol(r.balance_sol || 0)} SOL</div><div class="s">${r.balance_usd != null ? formatUsd(r.balance_usd) : '—'}</div></div>
					<div class="ap-stat"><div class="l">Buffer</div><div class="n">${p.buffer_sol != null ? formatSol(p.buffer_sol) + ' SOL' : '—'}</div><div class="s">safety floor</div></div>
					<div class="ap-stat"><div class="l">$THREE held</div><div class="n">${r.three_accumulated != null ? Number(r.three_accumulated).toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}</div><div class="s">accumulated</div></div>
					<div class="ap-stat"><div class="l">Self-funded</div><div class="n">${formatUsd(r.self_funded_usd || 0)}</div><div class="s">compute paid</div></div>
					<div class="ap-stat"><div class="l">Buybacks</div><div class="n">${r.buyback_count || 0}</div><div class="s">${formatUsd(r.buyback_usd || 0)}</div></div>
					<div class="ap-stat"><div class="l">Swept to you</div><div class="n">${formatSol(r.swept_sol || 0)} SOL</div><div class="s">${r.sweep_count || 0} sweeps</div></div>
				</div>`;

			return `<div class="ap-hero" role="region" aria-label="Treasury runway">
				<div class="ap-hero-top">
					<div>${badge}</div>
					${net}
				</div>
				<div class="ap-runway" aria-live="polite">${heroMain}</div>
				${(incomeUsd > 0 || costUsd > 0) ? bars : ''}
				${stats}
			</div>`;
		}

		function renderKilledBanner() {
			return `<div class="ap-warn red" role="alert"><strong>Autopilot is halted.</strong> The kill switch is on — no rule will run until you re-enable it.
				<div class="ap-actions"><button class="ap-btn primary" id="ap-unkill" type="button">Re-enable autopilot</button></div></div>`;
		}

		function renderEditor() {
			const c = state.compiled;
			const hasRules = c?.rules?.length;
			const contradictions = c?.contradictions || [];
			const warnings = c?.warnings || [];
			const sweepDest = state.policy?.sweep_destination || '';

			const preview = c
				? `<div style="margin-top:var(--space-md,14px)">
						${hasRules ? `<ul class="ap-rules">${c.rules.map((r) => renderRuleLi(r, false)).join('')}</ul>` : `<div class="ap-empty"><div class="ic" aria-hidden="true">🤔</div>No rules were recognized. Try a clearer policy.</div>`}
						${contradictions.length ? `<div class="ap-warn red" role="alert"><strong>Conflicts — fix before arming:</strong><ul>${contradictions.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
						${warnings.length ? `<div class="ap-warn amber"><strong>Assumptions:</strong><ul>${warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
						${c.via ? `<p class="sub" style="margin-top:8px">Compiled ${c.via === 'model' ? 'by the model' : 'from your wording'}. Review every rule — this is exactly what you’ll arm.</p>` : ''}
					</div>`
				: '';

			return `<div class="ap-card">
				<h3 id="ap-policy-h">Treasury policy</h3>
				<p class="sub">Describe in plain English how the agent should manage its own money. We compile it into bounded rules you approve before anything runs.</p>
				<textarea class="ap-ta" id="ap-src" aria-labelledby="ap-policy-h" placeholder="e.g. Pay your own compute. Keep a 1 SOL buffer. Put 10% of tips into $THREE. Sweep anything over 3 SOL to me on Fridays.">${esc(state.source)}</textarea>
				<div class="ap-egs" role="group" aria-label="Example policies">${EXAMPLES.map((e, i) => `<button class="ap-eg" type="button" data-eg="${i}" title="${esc(e)}" aria-label="Use example: ${esc(e)}">${esc(e.length > 54 ? e.slice(0, 52) + '…' : e)}</button>`).join('')}</div>
				<div class="ap-fld">
					<label for="ap-sweep">Sweep destination (your wallet — required if you sweep profit)</label>
					<input class="ap-in" id="ap-sweep" placeholder="Your Solana address" value="${esc(sweepDest)}" spellcheck="false" autocomplete="off" />
				</div>
				<div class="ap-actions">
					<button class="ap-btn primary" id="ap-compile" type="button" ${state.compiling ? 'disabled aria-busy="true"' : ''}>${state.compiling ? '<span class="ap-spin" aria-hidden="true"></span>Compiling…' : 'Compile policy'}</button>
					${hasRules && !contradictions.length ? `<button class="ap-btn" id="ap-arm" type="button">Arm autopilot</button>` : ''}
					${state.policy?.rules?.length ? `<button class="ap-btn ghost" id="ap-cancel" type="button">Cancel</button>` : ''}
				</div>
				${preview}
			</div>`;
		}

		function renderRuleLi(r, withControls) {
			const tone = STATUS_TONE[r.last_status] || 'muted';
			const statusChip = r.last_status
				? `<span class="ap-chip ${tone}">${esc(r.last_status.replace('_', ' '))}</span>`
				: '';
			const sig = r.last_signature || r.signature;
			const explorer = r.explorer || (sig ? explorerTxUrl(sig, ctx.getNetwork()) : null);
			const noteHtml = r.last_note
				? `<div class="note">${esc(r.last_note)}${explorer ? ` · <a href="${esc(explorer)}" target="_blank" rel="noopener">view tx ↗</a>` : ''}</div>`
				: explorer ? `<div class="note"><a href="${esc(explorer)}" target="_blank" rel="noopener">view tx ↗</a></div>` : '';
			const ctlHtml = withControls
				? `<div class="ctl">${statusChip}<button class="ap-toggle" type="button" data-toggle="${esc(r.id)}" aria-label="${r.paused ? 'Resume' : 'Pause'} rule: ${esc(r.label)}">${r.paused ? 'Resume' : 'Pause'}</button></div>`
				: '';
			return `<li class="ap-rule" data-paused="${r.paused ? 'true' : 'false'}">
				<span class="ic" aria-hidden="true">${KIND_ICON[r.kind] || '•'}</span>
				<div class="body"><div class="ttl">${esc(r.label)}</div>${noteHtml}</div>
				${ctlHtml}
			</li>`;
		}

		function renderActiveRules() {
			const p = state.policy;
			const armed = !!p.armed && !p.kill_switch;
			if (!p.rules?.length) {
				return `<div class="ap-card"><div class="ap-empty"><div class="ic" aria-hidden="true">🛰️</div>No autopilot rules yet.<br/>Write a policy to let this agent fund its own existence.</div>
					<div class="ap-actions"><button class="ap-btn primary" id="ap-edit" type="button">Write a policy</button></div></div>`;
			}
			return `<div class="ap-card">
				<h3>Armed rules</h3>
				<p class="sub">${armed ? 'These rules run automatically on the schedule and on demand — every action real, gated by your spend policy, and logged.' : 'Compiled but not armed. Arm to let them run.'}</p>
				<ul class="ap-rules">${p.rules.map((r) => renderRuleLi(r, true)).join('')}</ul>
				<div class="ap-actions">
					${armed
						? `<button class="ap-btn primary" id="ap-run" type="button" ${state.running ? 'disabled aria-busy="true"' : ''}>${state.running ? '<span class="ap-spin" aria-hidden="true"></span>Running…' : 'Run now'}</button>`
						: `<button class="ap-btn primary" id="ap-arm-existing" type="button">Arm autopilot</button>`}
					<button class="ap-btn ghost" id="ap-edit" type="button">Edit policy</button>
				</div>
				${state.lastRun ? renderLastRun() : ''}
				<div class="ap-kill">
					<div class="t"><b>Kill switch.</b> Halts every autopilot action instantly.</div>
					<button class="ap-btn danger" id="ap-kill" type="button">Halt autopilot</button>
				</div>
			</div>`;
		}

		function renderLastRun() {
			const res = state.lastRun;
			if (!res) return '';
			if (!res.ran) {
				const reason = (res.reason || '').replace(/_/g, ' ');
				return `<div class="ap-warn amber" role="status">Last run did nothing — ${esc(res.note || reason || 'no due rules')}.</div>`;
			}
			const rows = (res.results || []).map((r) => {
				const tone = STATUS_TONE[r.last_status] || 'muted';
				const explorer = r.explorer || (r.signature ? explorerTxUrl(r.signature, ctx.getNetwork()) : null);
				return `<li class="ap-rule"><span class="ic" aria-hidden="true">${KIND_ICON[r.kind] || '•'}</span><div class="body"><div class="ttl">${esc(r.label)}</div><div class="note">${esc(r.last_note || r.last_status || '')}${explorer ? ` · <a href="${esc(explorer)}" target="_blank" rel="noopener">view tx ↗</a>` : ''}</div></div><div class="ctl"><span class="ap-chip ${tone}">${esc((r.last_status || '').replace('_', ' '))}</span></div></li>`;
			}).join('');
			return `<div style="margin-top:var(--space-md,14px)"><p class="sub" style="margin:0 0 8px">Last run</p><ul class="ap-rules">${rows}</ul></div>`;
		}

		// ── wiring ────────────────────────────────────────────────────────────────
		function wire() {
			panel.querySelector('#ap-edit')?.addEventListener('click', () => { state.editing = true; state.compiled = null; render(); });
			panel.querySelector('#ap-cancel')?.addEventListener('click', () => { state.editing = false; state.compiled = null; render(); });
			panel.querySelector('#ap-unkill')?.addEventListener('click', () => savePolicy({ kill_switch: false }, 'Autopilot re-enabled'));
			panel.querySelector('#ap-kill')?.addEventListener('click', onKill);

			panel.querySelectorAll('[data-eg]').forEach((b) => b.addEventListener('click', () => {
				const ta = panel.querySelector('#ap-src');
				if (ta) { ta.value = EXAMPLES[Number(b.dataset.eg)] || ''; state.source = ta.value; ta.focus(); }
			}));
			panel.querySelector('#ap-src')?.addEventListener('input', (e) => { state.source = e.target.value; });
			panel.querySelector('#ap-compile')?.addEventListener('click', onCompile);
			panel.querySelector('#ap-arm')?.addEventListener('click', onArm);
			panel.querySelector('#ap-arm-existing')?.addEventListener('click', () => savePolicy({ armed: true }, 'Autopilot armed'));
			panel.querySelector('#ap-run')?.addEventListener('click', onRun);

			panel.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => onTogglePause(b.dataset.toggle)));
		}

		function sweepInput() {
			const v = (panel.querySelector('#ap-sweep')?.value || '').trim();
			if (!v) return { ok: true, value: null };
			if (!SOL_ADDR_RE.test(v)) return { ok: false, message: 'Sweep destination is not a valid Solana address.' };
			return { ok: true, value: v };
		}

		async function onCompile() {
			const text = (panel.querySelector('#ap-src')?.value || '').trim();
			if (!text) { ctx.toast('Write a policy first.'); return; }
			const sweep = sweepInput();
			if (!sweep.ok) { ctx.toast(sweep.message); return; }
			state.compiling = true; state.source = text; render();
			const res = await call(base('compile'), { method: 'POST', body: { text, sweep_destination: sweep.value } });
			if (destroyed) return;
			state.compiling = false;
			if (!res.ok) { ctx.toast(res.message || 'Could not compile'); render(); return; }
			state.compiled = res.data;
			render();
		}

		async function onArm() {
			const c = state.compiled;
			if (!c || !c.rules?.length) { ctx.toast('Compile a policy first.'); return; }
			if (c.contradictions?.length) { ctx.toast('Resolve the conflicts before arming.'); return; }
			const sweep = sweepInput();
			if (!sweep.ok) { ctx.toast(sweep.message); return; }
			const needsSweepDest = c.rules.some((r) => r.kind === 'sweep') && !(sweep.value || c.sweep_destination);
			if (needsSweepDest) { ctx.toast('Set a sweep destination — your policy sweeps profit.'); return; }
			if (!(await ensureRiskAck({ context: 'autopilot' }))) return;
			await savePolicy({
				rules: c.rules,
				buffer_sol: c.buffer_sol,
				sweep_destination: sweep.value || c.sweep_destination || null,
				source_text: c.source_text,
				armed: true,
				kill_switch: false,
			}, 'Autopilot armed — your agent now funds itself.');
			state.editing = false;
			state.compiled = null;
		}

		async function savePolicy(patch, successMsg) {
			const res = await call(base(''), { method: 'PUT', body: patch });
			if (destroyed) return;
			if (!res.ok) { ctx.toast(res.message || 'Save failed'); return; }
			state.policy = res.data.policy;
			state.source = state.policy?.source_text || state.source;
			if (successMsg) ctx.toast(successMsg);
			// Refresh the runway after any policy change.
			await load();
		}

		async function onKill() {
			await savePolicy({ kill_switch: true }, 'Autopilot halted.');
		}

		async function onTogglePause(ruleId) {
			const p = state.policy;
			const rules = (p.rules || []).map((r) => (r.id === ruleId ? { ...r, paused: !r.paused } : r));
			await savePolicy({ rules }, 'Rule updated');
		}

		async function onRun() {
			state.running = true; render();
			const res = await call(base('run'), { method: 'POST', body: {} });
			if (destroyed) return;
			state.running = false;
			if (!res.ok) { ctx.toast(res.message || 'Run failed'); render(); return; }
			state.lastRun = res.data;
			const did = (res.data.results || []).filter((r) => r.last_status === 'ok').length;
			ctx.toast(res.data.ran ? (did ? `Ran ${did} action${did === 1 ? '' : 's'}.` : 'Nothing was due this cycle.') : 'Autopilot is not active.');
			await load();
			state.lastRun = res.data; // keep the run summary visible after reload
			render();
		}

		load();
		return { destroy() { destroyed = true; } };
	},
});
