/**
 * Agent Wallet hub — Signals tab.
 *
 * Owner-only. Two halves of the reputation-gated signal marketplace, for THIS
 * agent:
 *
 *   PUBLISH — if the agent has a verified on-chain track record (the same badge
 *   the leaderboard computes), the owner can publish/edit a paid signal feed:
 *   per-signal and/or per-epoch USDC pricing, what it emits, visibility. Below
 *   the verification bar, the owner sees exactly what they still have to prove.
 *
 *   SUBSCRIPTIONS — every feed this agent follows, with its mode (simulate/live),
 *   sizing, real spend + fill counts, and the controls that matter: an INSTANT
 *   kill (no further pay/trade), pause/resume, "sync now", and stop. The kill is
 *   the safety guarantee — one click halts everything immediately.
 */

import { registerWalletTab } from '../registry.js';
import { apiFetch } from '../../api.js';

const STYLE_ID = 'awh-signals-style';
const STYLE = `
.asg-wrap { display:flex; flex-direction:column; gap: var(--space-lg,1.6rem); }
.asg-card { background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke, rgba(255,255,255,.08)); border-radius: var(--radius-lg,14px); padding: var(--space-lg,18px); }
.asg-card h3 { margin:0 0 4px; font-size: var(--text-ui,.9rem); color: var(--ink-bright,#fff); font-weight:600; display:flex; align-items:center; gap:8px; justify-content:space-between; }
.asg-card .sub { margin:0 0 var(--space-md,14px); font-size: var(--text-sm,.78rem); color: var(--ink-dim,#888); line-height:1.5; }
.asg-fld { margin-bottom: 13px; }
.asg-fld label { display:block; font-size: var(--text-sm,.76rem); color: var(--ink-dim,#888); margin-bottom:6px; }
.asg-in, .asg-sel { width:100%; box-sizing:border-box; font:inherit; font-size: var(--text-md,.82rem); color: var(--ink,#e8e8e8); background: var(--surface-2, rgba(255,255,255,.04)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:9px 12px; }
.asg-in:focus, .asg-sel:focus { outline:none; border-color: var(--wallet-accent,#c4b5fd); box-shadow: 0 0 0 2px color-mix(in srgb, var(--wallet-accent,#c4b5fd) 40%, transparent); }
.asg-row2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.asg-checks { display:flex; flex-wrap:wrap; gap:14px; margin-bottom:13px; }
.asg-check { display:inline-flex; align-items:center; gap:7px; font-size: var(--text-sm,.78rem); color: var(--ink,#ccc); cursor:pointer; }
.asg-check input, .asg-in[type=checkbox] { accent-color: var(--wallet-accent,#c4b5fd); }
.asg-btn { appearance:none; cursor:pointer; font:inherit; font-size: var(--text-sm,.78rem); font-weight:600; border-radius: var(--radius-md,10px); padding:10px 16px; border:1px solid var(--stroke-strong,rgba(255,255,255,.14)); background: var(--surface-2,rgba(255,255,255,.06)); color: var(--ink,#e8e8e8); transition: background .14s, transform .1s; }
.asg-btn:hover:not(:disabled) { background: var(--surface-3,rgba(255,255,255,.09)); color:#fff; }
.asg-btn:active:not(:disabled) { transform: translateY(1px); }
.asg-btn:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; }
.asg-btn:disabled { opacity:.5; cursor:not-allowed; }
.asg-btn.primary { background: var(--wallet-accent,#c4b5fd); border-color: var(--wallet-accent,#c4b5fd); color:#160d28; }
.asg-btn.danger { color: var(--danger,#f87171); border-color: color-mix(in srgb, var(--danger,#f87171) 40%, transparent); background: color-mix(in srgb, var(--danger,#f87171) 8%, transparent); }
.asg-btn.danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger,#f87171) 16%, transparent); color:#fff; }
.asg-btn.sm { padding:6px 11px; font-size: var(--text-2xs,.69rem); }
.asg-gate { display:flex; flex-direction:column; gap:12px; }
.asg-bars { display:flex; flex-direction:column; gap:10px; }
.asg-bar { }
.asg-bar .lbl { display:flex; justify-content:space-between; font-size: var(--text-sm,.76rem); color: var(--ink-dim,#999); margin-bottom:5px; }
.asg-bar .lbl b { color: var(--ink-bright,#fff); font-weight:600; }
.asg-track { height:7px; border-radius:999px; background: var(--surface-2,rgba(255,255,255,.06)); overflow:hidden; }
.asg-fill { height:100%; border-radius:999px; background: linear-gradient(90deg,#8b5cf6,#34d399); transition: width .5s ease; }
.asg-fill.met { background: #34d399; }
.asg-feedlink { display:inline-flex; align-items:center; gap:6px; font-size: var(--text-sm,.78rem); color: var(--wallet-accent,#c4b5fd); text-decoration:none; }
.asg-feedlink:hover { text-decoration:underline; }
.asg-feedlink:focus-visible, .asg-sub-name a:focus-visible, .asg-empty a:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: 2px; border-radius: 4px; }
.asg-sub { border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-md,11px); padding:13px; margin-bottom:10px; }
.asg-sub.killed { border-color: color-mix(in srgb, var(--danger,#f87171) 35%, transparent); }
.asg-sub-top { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
.asg-sub-name { font-size: var(--text-md,.84rem); font-weight:600; color: var(--ink-bright,#fff); }
.asg-sub-name a { color:inherit; text-decoration:none; }
.asg-sub-name a:hover { color: var(--wallet-accent,#c4b5fd); }
.asg-pill { font-size: var(--text-2xs,.66rem); font-weight:600; text-transform:uppercase; letter-spacing:.04em; padding:3px 8px; border-radius:999px; }
.asg-pill.live { color:#160d28; background:#34d399; }
.asg-pill.simulate { color: var(--ink-dim,#aaa); background: var(--surface-3,rgba(255,255,255,.08)); }
.asg-pill.killed { color:#fff; background: var(--danger,#f87171); }
.asg-pill.paused { color: var(--warn,#fbbf24); background: color-mix(in srgb,#fbbf24 14%,transparent); }
.asg-sub-meta { display:flex; flex-wrap:wrap; gap:12px; margin:10px 0; font-size: var(--text-sm,.74rem); color: var(--ink-dim,#999); }
.asg-sub-meta b { color: var(--ink,#ddd); font-weight:600; }
.asg-sub-actions { display:flex; flex-wrap:wrap; gap:7px; }
.asg-empty { text-align:center; padding:26px 14px; color: var(--ink-dim,#999); font-size: var(--text-sm,.8rem); line-height:1.5; }
.asg-empty a { color: var(--wallet-accent,#c4b5fd); text-decoration:none; font-weight:600; }
.asg-note { font-size: var(--text-sm,.74rem); margin-top:8px; line-height:1.5; }
.asg-note.err { color: var(--danger,#f87171); }
.asg-note.ok { color: var(--success,#4ade80); }
.asg-skel { height:90px; border-radius: var(--radius-md,11px); background: var(--surface-2,rgba(255,255,255,.05)); animation: asg-pulse 1.3s ease infinite; }
@keyframes asg-pulse { 50% { opacity:.5; } }
@media (max-width: 380px) { .asg-row2 { grid-template-columns:1fr; } }
@media (prefers-reduced-motion: reduce) { .asg-skel, .asg-fill, .asg-btn { animation:none; transition:none; } }
`;

function injectStyle() {
	if (document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = STYLE;
	document.head.appendChild(el);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

registerWalletTab({
	id: 'signals',
	label: 'Signals',
	order: 26,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		let destroyed = false;
		const net = () => ctx.getNetwork();

		panel.innerHTML = `<div class="asg-wrap" role="status" aria-busy="true" aria-label="Loading signals"><div class="asg-skel"></div><div class="asg-skel"></div></div>`;

		async function load() {
			let feedData = null;
			let subs = [];
			try {
				const [fRes, sRes] = await Promise.all([
					apiFetch(`/api/signals/feeds?agent_id=${encodeURIComponent(ctx.agentId)}&network=${net()}`),
					apiFetch('/api/signals/subscribe'),
				]);
				feedData = fRes.ok ? await fRes.json() : null;
				const sJson = sRes.ok ? await sRes.json() : { subscriptions: [] };
				subs = (sJson.subscriptions || []).filter((s) => s.subscriber_agent_id === ctx.agentId);
			} catch {
				if (!destroyed) {
					panel.innerHTML = `<div class="asg-card"><p class="asg-note err" role="alert">Could not load signals — check your connection and try again. <button class="asg-btn sm" type="button" data-retry>Retry</button></p></div>`;
					panel.querySelector('[data-retry]')?.addEventListener('click', load);
				}
				return;
			}
			if (destroyed) return;
			render(feedData, subs);
		}

		function render(feedData, subs) {
			panel.innerHTML = `<div class="asg-wrap">${publishCard(feedData)}${subsCard(subs)}</div>`;
			wirePublish(feedData);
			wireSubs();
		}

		// ── Publish half ──────────────────────────────────────────────────────────
		function publishCard(d) {
			const elig = d?.eligibility || {};
			const feed = d?.feed || null;
			if (!elig.verified) {
				const req = elig.requirements || { min_closed: 12, min_unique_coins: 5, max_churn_pct: 40 };
				const bar = (label, have, need, met) => `
					<div class="asg-bar">
						<div class="lbl"><span>${label}</span><b>${have} / ${need}</b></div>
						<div class="asg-track" role="progressbar" aria-label="${label}" aria-valuemin="0" aria-valuemax="${need}" aria-valuenow="${have}" aria-valuetext="${have} of ${need}${met ? ' — met' : ''}"><span class="asg-fill ${met ? 'met' : ''}" style="width:${Math.min(100, need ? (have / need) * 100 : 0)}%"></span></div>
					</div>`;
				const closed = num(elig.closed_trades);
				const coins = num(elig.unique_coins);
				const churn = num(elig.churn_pct);
				const realized = num(elig.realized_pnl_sol);
				return `
					<div class="asg-card">
						<h3>Publish a signal feed</h3>
						<p class="sub">Only a <b>verified track record</b> can publish — your signals must be backed by real, closed, on-chain trades, never self-declared. Here's what this agent still has to prove:</p>
						<div class="asg-bars">
							${bar('Closed trades', closed, req.min_closed, closed >= req.min_closed)}
							${bar('Unique coins', coins, req.min_unique_coins, coins >= req.min_unique_coins)}
							<div class="asg-bar"><div class="lbl"><span>Churn (lower is better)</span><b>${churn.toFixed(0)}% / ≤${req.max_churn_pct}%</b></div>
								<div class="asg-track" role="progressbar" aria-label="Churn" aria-valuemin="0" aria-valuemax="${req.max_churn_pct}" aria-valuenow="${churn.toFixed(0)}" aria-valuetext="${churn.toFixed(0)}% churn, target ${req.max_churn_pct}% or lower${churn <= req.max_churn_pct ? ' — met' : ''}"><span class="asg-fill ${churn <= req.max_churn_pct ? 'met' : ''}" style="width:${Math.min(100, churn <= req.max_churn_pct ? 100 : 40)}%"></span></div></div>
							<div class="asg-bar"><div class="lbl"><span>Realized P&amp;L</span><b>${realized > 0 ? '✓ positive' : 'must be positive'}</b></div>
								<div class="asg-track" role="img" aria-label="Realized profit and loss ${realized > 0 ? 'positive — met' : 'not yet positive'}"><span class="asg-fill ${realized > 0 ? 'met' : ''}" style="width:${realized > 0 ? 100 : 10}%"></span></div></div>
						</div>
						<p class="asg-note">Keep trading from this agent's wallet — the moment it clears the bar, publishing unlocks here automatically.</p>
					</div>`;
			}

			// Verified → create / edit feed form.
			const f = feed || {};
			const v = (k, d2) => (f[k] != null ? f[k] : d2);
			const slugLink = f.slug ? `<a class="asg-feedlink" href="/signals/${encodeURIComponent(f.slug)}" target="_blank" rel="noopener">View public feed ↗</a>` : '';
			const statusBtn = feed
				? (f.status === 'active'
					? `<button class="asg-btn sm" type="button" data-feed-status="paused">Pause feed</button>`
					: `<button class="asg-btn sm primary" type="button" data-feed-status="active">Resume feed</button>`)
				: '';
			return `
				<div class="asg-card">
					<h3><span>${feed ? 'Your signal feed' : 'Publish a signal feed'}</span><span>${slugLink}</span></h3>
					<p class="sub">✓ Verified. Followers' agents pay USDC per signal (or per epoch) and auto-mirror your real entries/exits, fully spend-guarded. You earn real USDC; your feed ranks by proven accuracy.</p>
					<div class="asg-fld"><label for="asg-title">Feed title</label>
						<input class="asg-in" id="asg-title" maxlength="80" value="${esc(v('title', ''))}" placeholder="${esc(d?.feed?.title || 'My alpha')}" /></div>
					<div class="asg-row2">
						<div class="asg-fld"><label for="asg-ps">Price / signal (USDC)</label><input class="asg-in" id="asg-ps" type="number" min="0" step="0.05" value="${num(v('price_per_signal_usdc', 0.25))}" /></div>
						<div class="asg-fld"><label for="asg-pe">Price / epoch (USDC)</label><input class="asg-in" id="asg-pe" type="number" min="0" step="0.5" value="${num(v('price_per_epoch_usdc', 0))}" /></div>
					</div>
					<div class="asg-fld"><label for="asg-epoch">Epoch length</label>
						<select class="asg-sel" id="asg-epoch">
							${[['3600', '1 hour'], ['21600', '6 hours'], ['86400', '1 day'], ['604800', '1 week']].map(([s, l]) => `<option value="${s}" ${num(v('epoch_seconds', 86400)) === Number(s) ? 'selected' : ''}>${l}</option>`).join('')}
						</select></div>
					<div class="asg-checks">
						<label class="asg-check"><input type="checkbox" id="asg-entries" ${v('emit_entries', true) !== false ? 'checked' : ''} /> Emit entries</label>
						<label class="asg-check"><input type="checkbox" id="asg-exits" ${v('emit_exits', true) !== false ? 'checked' : ''} /> Emit exits</label>
						<label class="asg-check"><input type="checkbox" id="asg-sizing" ${v('reveal_sizing', true) !== false ? 'checked' : ''} /> Reveal sizing</label>
					</div>
					<div class="asg-row2">
						<div class="asg-fld"><label for="asg-conv">Min conviction (0–1)</label><input class="asg-in" id="asg-conv" type="number" min="0" max="1" step="0.1" value="${num(v('min_conviction', 0))}" /></div>
						<div class="asg-fld"><label for="asg-vis">Visibility</label>
							<select class="asg-sel" id="asg-vis"><option value="public" ${v('visibility', 'public') === 'public' ? 'selected' : ''}>Public (in directory)</option><option value="unlisted" ${v('visibility') === 'unlisted' ? 'selected' : ''}>Unlisted</option></select></div>
					</div>
					<div style="display:flex; gap:8px; flex-wrap:wrap;">
						<button class="asg-btn primary" type="button" id="asg-publish">${feed ? 'Save changes' : 'Publish feed'}</button>
						${statusBtn}
					</div>
					<p class="asg-note" id="asg-pub-note" role="status" aria-live="polite"></p>
				</div>`;
		}

		function wirePublish(d) {
			const btn = panel.querySelector('#asg-publish');
			if (btn) {
				btn.addEventListener('click', async () => {
					const note = panel.querySelector('#asg-pub-note');
					note.className = 'asg-note';
					btn.disabled = true;
					try {
						const res = await apiFetch('/api/signals/feeds', {
							method: 'POST', headers: { 'content-type': 'application/json' },
							body: JSON.stringify({
								agent_id: ctx.agentId, network: net(),
								title: panel.querySelector('#asg-title').value,
								price_per_signal_usdc: Number(panel.querySelector('#asg-ps').value) || 0,
								price_per_epoch_usdc: Number(panel.querySelector('#asg-pe').value) || 0,
								epoch_seconds: Number(panel.querySelector('#asg-epoch').value) || 86400,
								emit_entries: panel.querySelector('#asg-entries').checked,
								emit_exits: panel.querySelector('#asg-exits').checked,
								reveal_sizing: panel.querySelector('#asg-sizing').checked,
								min_conviction: Number(panel.querySelector('#asg-conv').value) || 0,
								visibility: panel.querySelector('#asg-vis').value,
							}),
						});
						const j = await res.json().catch(() => ({}));
						if (!res.ok) throw new Error(j.message || j.error || `HTTP ${res.status}`);
						ctx.toast('Feed published');
						load();
					} catch (e) {
						note.textContent = e.message;
						note.classList.add('err');
						btn.disabled = false;
					}
				});
			}
			const statusBtn = panel.querySelector('[data-feed-status]');
			if (statusBtn && d?.feed) {
				statusBtn.addEventListener('click', async () => {
					statusBtn.disabled = true;
					try {
						await apiFetch('/api/signals/feeds', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: d.feed.id, status: statusBtn.dataset.feedStatus }) });
						load();
					} catch { statusBtn.disabled = false; }
				});
			}
		}

		// ── Subscriptions half ──────────────────────────────────────────────────────
		function subsCard(subs) {
			if (!subs.length) {
				return `
					<div class="asg-card">
						<h3>Following</h3>
						<div class="asg-empty">This agent isn't following any feeds yet.<br /><a href="/signals">Browse the marketplace →</a></div>
					</div>`;
			}
			return `
				<div class="asg-card">
					<h3><span>Following</span><a class="asg-feedlink" href="/signals">Find more →</a></h3>
					<p class="sub">Each subscription pays USDC from this agent's wallet and auto-mirrors within its spend policy. <b>Kill</b> halts pay + trade instantly.</p>
					${subs.map(subRow).join('')}
				</div>`;
		}

		function subRow(s) {
			const f = s.feed || {};
			const modePill = s.killed ? `<span class="asg-pill killed">Killed</span>`
				: s.status === 'paused' ? `<span class="asg-pill paused">Paused</span>`
				: `<span class="asg-pill ${s.mode}">${s.mode}</span>`;
			const price = s.billing === 'per_epoch'
				? `$${num(f.price_per_epoch_usdc)}/epoch`
				: `$${num(f.price_per_signal_usdc)}/signal`;
			return `
				<div class="asg-sub ${s.killed ? 'killed' : ''}" data-sub="${s.id}">
					<div class="asg-sub-top">
						<div class="asg-sub-name"><a href="/signals/${encodeURIComponent(f.slug || '')}">${esc(f.title || 'Feed')}</a><div style="font-size:.7rem;color:var(--ink-dim,#888);margin-top:2px">by ${esc(f.publisher_name || '')}</div></div>
						${modePill}
					</div>
					<div class="asg-sub-meta">
						<span><b>${price}</b></span>
						<span>base <b>${num(s.base_sol)} SOL</b> · ${num(s.size_scaling)}×</span>
						<span>max <b>${num(s.max_per_trade_sol)} SOL</b></span>
						<span><b>${num(s.stats?.executed)}</b> fills</span>
						<span>spent <b>$${num(s.stats?.usdc_spent).toFixed(2)}</b></span>
					</div>
					<div class="asg-sub-actions">
						${s.killed
							? `<button class="asg-btn sm primary" type="button" data-act="resume">Resume</button>`
							: `<button class="asg-btn sm danger" type="button" data-act="kill">Kill now</button>`}
						${!s.killed && s.status === 'active' ? `<button class="asg-btn sm" type="button" data-act="pause">Pause</button>` : ''}
						${!s.killed && s.status === 'paused' ? `<button class="asg-btn sm" type="button" data-act="resume">Resume</button>` : ''}
						<button class="asg-btn sm" type="button" data-act="sync">Sync now</button>
						<button class="asg-btn sm" type="button" data-act="stop">Stop</button>
					</div>
				</div>`;
		}

		function wireSubs() {
			panel.querySelectorAll('.asg-sub').forEach((row) => {
				const id = row.dataset.sub;
				row.querySelectorAll('[data-act]').forEach((btn) => {
					btn.addEventListener('click', async () => {
						const act = btn.dataset.act;
						btn.disabled = true;
						try {
							let body;
							if (act === 'kill') body = { id, killed: true };
							else if (act === 'resume') body = { id, killed: false };
							else if (act === 'pause') body = { id, status: 'paused' };
							else if (act === 'sync') body = { id, action: 'sync' };
							else if (act === 'stop') body = { id, status: 'stopped' };
							const res = await apiFetch('/api/signals/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
							const j = await res.json().catch(() => ({}));
							if (!res.ok) throw new Error(j.message || j.error || 'failed');
							if (act === 'sync') ctx.toast(`Synced — ${j.delivered || 0} delivered`);
							else if (act === 'kill') ctx.toast('Killed — no further pay or trade');
							load();
						} catch (e) {
							ctx.toast(e.message || 'Action failed');
							btn.disabled = false;
						}
					});
				});
			});
		}

		load();
		const off = ctx.onNetworkChange ? ctx.onNetworkChange(() => load()) : null;

		return {
			destroy() { destroyed = true; if (typeof off === 'function') off(); },
			onShow() { if (!destroyed) load(); },
		};
	},
});
