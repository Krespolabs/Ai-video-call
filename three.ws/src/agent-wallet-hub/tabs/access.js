/**
 * Agent Wallet hub — Access tab (owner-only): scoped session keys.
 *
 * Least-privilege for autonomous money. Every skill, strategy, and integration an
 * agent runs would otherwise wield the FULL authority of the wallet. A capability
 * narrows that to a specific actor + action(s) + target allowlist + spend ceiling
 * + expiry — "this sniper strategy may spend up to $40 on these mints for 24h, and
 * nothing else." Each grant is independently revocable; revoking takes effect on
 * the very next spend check. The owner can also turn on least-privilege MODE, where
 * every autonomous spend must present a covering capability or be denied (fail safe).
 *
 * All state changes hit the real owner-gated API (CSRF-protected); the panel only
 * ever renders real DB state. The wallet's private key is never involved here — a
 * capability is a server-enforced policy grant, not a delegated signing key.
 */

import { registerWalletTab } from '../registry.js';
import { consumeCsrfToken } from '../../api.js';

const STYLE_ID = 'awh-access-style';
const STYLE = `
.awh-acc { display:flex; flex-direction:column; gap:var(--space-3,12px); }
.awh-acc h2 { margin:0 0 6px; font-size:var(--text-md,.8125rem); color:var(--ink-bright,#fff); font-family:var(--font-display,system-ui); font-weight:600; }
.awh-acc-lead { color:var(--ink-dim,#888); font-size:var(--text-sm,.764rem); line-height:1.55; margin:0; max-width:62ch; }
.awh-acc-key { display:inline-grid; place-items:center; width:30px; height:30px; border-radius:var(--radius-md,10px); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 16%,transparent); border:1px solid color-mix(in srgb,var(--wallet-accent,#8b5cf6) 36%,transparent); color:var(--wallet-accent-ink,#c4b5fd); font-size:15px; flex:none; }
.awh-acc-mode { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; border-top:1px solid var(--stroke,rgba(255,255,255,.08)); margin-top:10px; padding-top:12px; }
.awh-acc-mode .copy { min-width:0; flex:1; }
.awh-acc-mode .copy strong { font-size:var(--text-sm,.764rem); color:var(--ink-bright,#fff); display:block; }
.awh-acc-mode .copy span { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); line-height:1.45; }
.awh-acc-switch { display:inline-flex; align-items:center; gap:8px; font-size:var(--text-sm,.764rem); color:var(--ink,#c8c8c8); white-space:nowrap; }
.awh-acc-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; }
.awh-acc-cap { border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:var(--radius-md,10px); background:var(--surface-1,rgba(255,255,255,.03)); padding:12px 14px; display:flex; flex-direction:column; gap:8px; transition:border-color var(--duration-fast,140ms), background var(--duration-fast,140ms); }
.awh-acc-cap:not(.is-dead):hover { border-color:var(--stroke-strong,rgba(255,255,255,.14)); background:var(--surface-2,rgba(255,255,255,.05)); }
.awh-acc-cap.is-dead { opacity:.6; }
.awh-acc-cap-top { display:flex; align-items:flex-start; gap:10px; }
.awh-acc-cap-main { min-width:0; flex:1; display:flex; flex-direction:column; gap:2px; }
.awh-acc-cap-label { font-size:var(--text-sm,.764rem); color:var(--ink-bright,#fff); font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.awh-acc-cap-desc { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); line-height:1.5; }
.awh-acc-badge { font-size:var(--text-2xs,.6875rem); font-weight:600; padding:2px 8px; border-radius:var(--radius-pill,999px); border:1px solid transparent; white-space:nowrap; flex:none; text-transform:capitalize; }
.awh-acc-badge.active { color:var(--success,#4ade80); background:color-mix(in srgb,var(--success,#4ade80) 12%,transparent); border-color:color-mix(in srgb,var(--success,#4ade80) 30%,transparent); }
.awh-acc-badge.revoked,.awh-acc-badge.tampered { color:var(--danger,#f87171); background:color-mix(in srgb,var(--danger,#f87171) 12%,transparent); border-color:color-mix(in srgb,var(--danger,#f87171) 30%,transparent); }
.awh-acc-badge.expired { color:var(--ink-dim,#999); background:var(--surface-3,rgba(255,255,255,.06)); border-color:var(--stroke,rgba(255,255,255,.1)); }
.awh-acc-bar { height:6px; border-radius:999px; background:var(--surface-3,rgba(255,255,255,.08)); overflow:hidden; }
.awh-acc-bar > i { display:block; height:100%; border-radius:999px; background:linear-gradient(90deg,var(--success,#4ade80),var(--warn,#fbbf24)); transition:width var(--duration-base,220ms); }
.awh-acc-bar.full > i { background:linear-gradient(90deg,var(--warn,#fbbf24),var(--danger,#f87171)); }
.awh-acc-meta { display:flex; align-items:center; gap:10px; flex-wrap:wrap; font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); }
.awh-acc-meta .spent { color:var(--ink,#c8c8c8); font-family:var(--font-mono,monospace); }
.awh-acc-cap-act { display:flex; gap:8px; }
.awh-acc-chip { display:inline-block; font-size:var(--text-2xs,.6875rem); padding:1px 7px; border-radius:var(--radius-sm,6px); background:var(--surface-2,rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.08)); color:var(--ink,#c8c8c8); margin-right:4px; }
.awh-acc-sug { border:1px dashed color-mix(in srgb,var(--wallet-accent,#8b5cf6) 40%,transparent); border-radius:var(--radius-md,10px); padding:10px 12px; display:flex; align-items:center; gap:10px; background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 6%,transparent); }
.awh-acc-sug .copy { min-width:0; flex:1; }
.awh-acc-sug .copy strong { font-size:var(--text-sm,.764rem); color:var(--ink-bright,#fff); display:block; }
.awh-acc-sug .copy span { font-size:var(--text-2xs,.6875rem); color:var(--ink-dim,#888); line-height:1.45; }
.awh-acc-form { display:flex; flex-direction:column; gap:10px; }
.awh-acc-field { display:flex; flex-direction:column; gap:5px; }
.awh-acc-field > label { font-size:var(--text-2xs,.6875rem); text-transform:uppercase; letter-spacing:.05em; color:var(--ink-dim,#888); }
.awh-acc-form input[type=text],.awh-acc-form input[type=number],.awh-acc-form select,.awh-acc-form textarea { font:inherit; font-size:var(--text-sm,.764rem); color:var(--ink,#e8e8e8); background:var(--surface-2,rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:var(--radius-md,10px); padding:8px 11px; width:100%; }
.awh-acc-form textarea { resize:vertical; min-height:54px; font-family:var(--font-mono,monospace); }
.awh-acc-form input:focus-visible,.awh-acc-form select:focus-visible,.awh-acc-form textarea:focus-visible { outline:var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset:2px; }
.awh-acc-row { display:flex; gap:10px; flex-wrap:wrap; }
.awh-acc-row > .awh-acc-field { flex:1; min-width:130px; }
.awh-acc-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.awh-acc-checks { display:flex; gap:8px; flex-wrap:wrap; }
.awh-acc-check { display:inline-flex; align-items:center; gap:6px; font-size:var(--text-sm,.764rem); color:var(--ink,#c8c8c8); padding:6px 10px; border:1px solid var(--stroke,rgba(255,255,255,.08)); border-radius:var(--radius-md,10px); cursor:pointer; user-select:none; }
.awh-acc-check input { accent-color:var(--wallet-accent,#8b5cf6); }
.awh-acc-check:has(input:checked) { border-color:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 50%,transparent); background:color-mix(in srgb,var(--wallet-accent,#8b5cf6) 8%,transparent); }
.awh-acc-err { font-size:var(--text-2xs,.6875rem); color:var(--danger,#f87171); }
.awh-acc-empty-ill { font-size:26px; opacity:.5; margin-bottom:4px; display:block; }
.awh-acc-skel { height:60px; border-radius:var(--radius-md,10px); background:linear-gradient(90deg,var(--surface-1,rgba(255,255,255,.03)) 25%,var(--surface-2,rgba(255,255,255,.05)) 37%,var(--surface-1,rgba(255,255,255,.03)) 63%); background-size:400% 100%; animation:awh-acc-shimmer 1.4s ease infinite; }
@keyframes awh-acc-shimmer { 0%{background-position:100% 0} 100%{background-position:-100% 0} }
@media (prefers-reduced-motion: reduce){ .awh-acc-skel{animation:none} .awh-acc-bar > i{transition:none} }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = STYLE_ID;
	tag.textContent = STYLE;
	document.head.appendChild(tag);
}

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
		try { j = await r.json(); } catch { /* empty */ }
		if (!r.ok) return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})`, detail: j?.detail || null };
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

const fmtUsd = (n) => (n == null ? null : `$${Number(n).toFixed(Number(n) < 1 && Number(n) > 0 ? 4 : 2)}`);

function fmtRemaining(expiresAt) {
	const ms = new Date(expiresAt).getTime() - Date.now();
	if (!Number.isFinite(ms)) return '';
	if (ms <= 0) return 'expired';
	const s = Math.floor(ms / 1000);
	const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
	if (d > 0) return `${d}d ${h}h left`;
	if (h > 0) return `${h}h ${m}m left`;
	if (m > 0) return `${m}m left`;
	return `${s}s left`;
}

// Plain-language sentence: what THIS capability lets its holder do.
function describeCapability(c, esc) {
	const verbs = (c.actions || []).map((a) => ({ trade: 'trade', snipe: 'snipe', x402: 'pay services' }[a] || a));
	const verb = verbs.length ? verbs.join(' / ') : 'spend';
	let limit;
	if (c.per_use_usd != null && c.aggregate_usd != null) limit = `up to ${fmtUsd(c.per_use_usd)}/use, ${fmtUsd(c.aggregate_usd)} total`;
	else if (c.aggregate_usd != null) limit = `up to ${fmtUsd(c.aggregate_usd)} total`;
	else if (c.per_use_usd != null) limit = `up to ${fmtUsd(c.per_use_usd)} per use`;
	else limit = 'within the wallet limits';
	let scope = '';
	if (c.target_kind === 'mint' && c.targets?.length) scope = ` on ${c.targets.length} allowed mint${c.targets.length > 1 ? 's' : ''}`;
	else if (c.target_kind === 'service' && c.targets?.length) scope = ` to ${esc(c.targets.join(', '))}`;
	else if (c.target_kind === 'destination' && c.targets?.length) scope = ` to ${c.targets.length} allowed destination${c.targets.length > 1 ? 's' : ''}`;
	return `Can ${esc(verb)} ${esc(limit)}${scope}, and nothing else.`;
}

registerWalletTab({
	id: 'access',
	label: 'Access',
	order: 72,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml: esc, agentId, toast } = ctx;
		let data = null;
		let busy = false;

		function setBusy(b) {
			busy = b;
			panel.querySelectorAll('button, input, select, textarea').forEach((el) => { el.disabled = b; });
		}

		async function load() {
			const res = await call(`/api/agents/${encodeURIComponent(agentId)}/capabilities`);
			if (!res.ok) { renderError(res); return; }
			data = res.data;
			render();
		}

		function renderLoading() {
			panel.innerHTML = `<div class="awh-card"><div class="awh-acc-skel"></div></div><div class="awh-card"><div class="awh-acc-skel"></div></div>`;
		}

		function renderError(res) {
			panel.innerHTML = `<div class="awh-card"><p class="awh-empty" role="alert">Couldn’t load access settings — ${esc(res.message || 'try again')}.
				<button class="awh-btn" type="button" data-act="retry">Try again</button></p></div>`;
			panel.querySelector('[data-act="retry"]')?.addEventListener('click', () => { renderLoading(); load(); });
		}

		function render() {
			const caps = data.capabilities || [];
			const active = caps.filter((c) => c.status === 'active');
			const suggestions = data.suggestions || [];
			const req = !!data.settings?.require_capabilities;

			panel.innerHTML = `
				${headerCardHTML(req, active.length)}
				${suggestions.length ? suggestionsCardHTML(suggestions) : ''}
				${capsCardHTML(caps, active.length)}
				${mintCardHTML()}
			`;
			wire();
		}

		function headerCardHTML(req, activeCount) {
			return `
				<div class="awh-card">
					<div class="awh-acc">
						<div style="display:flex;gap:10px;align-items:flex-start;">
							<span class="awh-acc-key" aria-hidden="true">🔑</span>
							<div>
								<h2>Scoped access keys</h2>
								<p class="awh-acc-lead">Give each skill, strategy, or integration its own narrow leash instead of the whole wallet. A key can only do what you grant — a set of actions, a spend ceiling, specific targets, and an expiry — and you can revoke any one of them instantly. ${activeCount === 1 ? '1 key is' : activeCount + ' keys are'} live right now.</p>
							</div>
						</div>
						<div class="awh-acc-mode">
							<div class="copy">
								<strong>Require a key for every autonomous spend</strong>
								<span>Strict least-privilege: with this on, any trade, snipe, or payment without a covering key is denied. Your own actions here and withdrawals are never affected.</span>
							</div>
							<label class="awh-acc-switch">
								<input type="checkbox" data-act="toggle-require" ${req ? 'checked' : ''} aria-label="Require a capability for every autonomous spend" />
								<span>${req ? 'On' : 'Off'}</span>
							</label>
						</div>
					</div>
				</div>`;
		}

		function suggestionsCardHTML(suggestions) {
			return `
				<div class="awh-card">
					<p class="awh-card-h">Suggested keys</p>
					<div style="display:flex;flex-direction:column;gap:8px;">
						${suggestions.map((s, i) => `
							<div class="awh-acc-sug">
								<span class="awh-acc-key" aria-hidden="true">✨</span>
								<div class="copy">
									<strong>${esc(s.label || 'Suggested key')}</strong>
									<span>${esc(s.reason || '')}</span>
								</div>
								<button class="awh-btn awh-btn--primary" type="button" data-act="accept-sug" data-i="${i}">Create</button>
							</div>`).join('')}
					</div>
				</div>`;
		}

		function capsCardHTML(caps, activeCount) {
			if (caps.length === 0) {
				return `
					<div class="awh-card">
						<p class="awh-empty" style="text-align:center;padding:18px 8px;">
							<span class="awh-acc-empty-ill" aria-hidden="true">🗝️</span>
							No access keys yet. Today every automated path can spend up to your wallet limits. Mint a key below to give a single skill or strategy its own tight, revocable budget.
						</p>
					</div>`;
			}
			return `
				<div class="awh-card">
					<p class="awh-card-h">Keys ${activeCount > 0 ? `· <button class="awh-btn awh-btn--danger" type="button" data-act="revoke-all" style="padding:3px 9px;font-size:var(--text-2xs,.6875rem);">Revoke all</button>` : ''}</p>
					<ul class="awh-acc-list">${caps.map((c) => capRowHTML(c)).join('')}</ul>
				</div>`;
		}

		function capRowHTML(c) {
			const dead = c.status !== 'active';
			const spent = Number(c.spent_usd || 0);
			const agg = c.aggregate_usd != null ? Number(c.aggregate_usd) : null;
			const pct = agg ? Math.min(100, Math.round((spent / agg) * 100)) : 0;
			const remaining = c.status === 'active' ? fmtRemaining(c.expires_at) : c.status;
			return `
				<li class="awh-acc-cap ${dead ? 'is-dead' : ''}">
					<div class="awh-acc-cap-top">
						<div class="awh-acc-cap-main">
							<span class="awh-acc-cap-label">${esc(c.label || 'Key')}</span>
							<span class="awh-acc-cap-desc">${describeCapability(c, esc)}</span>
						</div>
						<span class="awh-acc-badge ${esc(c.status)}">${esc(c.status)}</span>
					</div>
					${agg != null ? `
						<div class="awh-acc-bar ${pct >= 90 ? 'full' : ''}" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Budget used"><i style="width:${pct}%"></i></div>
						<div class="awh-acc-meta"><span class="spent">${fmtUsd(spent)} of ${fmtUsd(agg)} used</span> · <span>${esc(remaining)}</span></div>
					` : `<div class="awh-acc-meta"><span class="spent">${fmtUsd(spent)} spent</span> · <span>${esc(remaining)}</span></div>`}
					${c.status === 'active' ? `<div class="awh-acc-cap-act"><button class="awh-btn awh-btn--danger" type="button" data-act="revoke" data-id="${esc(c.id)}" style="padding:5px 11px;">Revoke</button></div>` : ''}
				</li>`;
		}

		function mintCardHTML() {
			return `
				<div class="awh-card">
					<p class="awh-card-h">Mint a key</p>
					<form class="awh-acc-form" data-form="mint">
						<div class="awh-acc-field">
							<label for="awh-acc-label">Label (who holds it)</label>
							<input type="text" id="awh-acc-label" data-f="label" placeholder="e.g. Weather API integration" maxlength="120" autocomplete="off" />
						</div>
						<div class="awh-acc-field">
							<label id="awh-acc-actions-label">Allowed actions</label>
							<div class="awh-acc-checks" role="group" aria-labelledby="awh-acc-actions-label">
								<label class="awh-acc-check"><input type="checkbox" data-f="action" value="trade" /> Trade</label>
								<label class="awh-acc-check"><input type="checkbox" data-f="action" value="snipe" /> Snipe</label>
								<label class="awh-acc-check"><input type="checkbox" data-f="action" value="x402" /> Pay services (x402)</label>
							</div>
						</div>
						<div class="awh-acc-row">
							<div class="awh-acc-field">
								<label for="awh-acc-peruse">Max per use (USD)</label>
								<input type="number" id="awh-acc-peruse" data-f="per_use" min="0" step="0.01" inputmode="decimal" placeholder="optional" />
							</div>
							<div class="awh-acc-field">
								<label for="awh-acc-agg">Total budget (USD)</label>
								<input type="number" id="awh-acc-agg" data-f="aggregate" min="0" step="0.01" inputmode="decimal" placeholder="optional" />
							</div>
							<div class="awh-acc-field">
								<label for="awh-acc-ttl">Expires in</label>
								<select id="awh-acc-ttl" data-f="ttl">
									<option value="3600">1 hour</option>
									<option value="21600">6 hours</option>
									<option value="86400" selected>24 hours</option>
									<option value="604800">7 days</option>
									<option value="2592000">30 days</option>
								</select>
							</div>
						</div>
						<div class="awh-acc-row">
							<div class="awh-acc-field" style="flex:0 0 auto;min-width:150px;">
								<label for="awh-acc-tkind">Restrict to</label>
								<select id="awh-acc-tkind" data-f="target_kind">
									<option value="any" selected>Any target</option>
									<option value="mint">Specific mints</option>
									<option value="service">Specific services</option>
									<option value="destination">Specific destinations</option>
								</select>
							</div>
							<div class="awh-acc-field" data-targets-wrap hidden style="flex:1;">
								<label for="awh-acc-targets">Allowed targets (one per line)</label>
								<textarea id="awh-acc-targets" data-f="targets" placeholder="mint address, service host, or destination — one per line"></textarea>
							</div>
						</div>
						<p class="awh-acc-err" data-err role="alert" aria-live="assertive" hidden></p>
						<div class="awh-acc-actions">
							<button class="awh-btn awh-btn--primary" type="submit">Mint key</button>
							<span class="awh-acc-cap-desc" style="color:var(--ink-faint,#666);">A key always narrows authority — it can never spend more than your wallet allows.</span>
						</div>
					</form>
				</div>`;
		}

		// ── wire ──────────────────────────────────────────────────────────────────
		function wire() {
			const q = (s) => panel.querySelector(s);

			q('[data-act="toggle-require"]')?.addEventListener('change', async (e) => {
				const on = e.target.checked;
				if (busy) return;
				setBusy(true);
				const res = await call(`/api/agents/${encodeURIComponent(agentId)}/capabilities/settings`, { method: 'PUT', body: { require_capabilities: on } });
				setBusy(false);
				if (!res.ok) { toast(res.message || 'Could not update'); e.target.checked = !on; return; }
				toast(on ? 'Least-privilege mode on' : 'Least-privilege mode off');
				await load();
			});

			panel.querySelectorAll('[data-act="accept-sug"]').forEach((btn) => {
				btn.addEventListener('click', async () => {
					const i = Number(btn.dataset.i);
					const sug = (data.suggestions || [])[i];
					if (!sug?.draft || busy) return;
					setBusy(true);
					const res = await call(`/api/agents/${encodeURIComponent(agentId)}/capabilities`, { method: 'POST', body: sug.draft });
					setBusy(false);
					toast(res.ok ? 'Key created' : (res.message || 'Could not create'));
					await load();
				});
			});

			panel.querySelectorAll('[data-act="revoke"]').forEach((btn) => {
				btn.addEventListener('click', async () => {
					if (!confirm('Revoke this key? It stops working on the very next spend — immediately and permanently.')) return;
					if (busy) return;
					setBusy(true);
					const res = await call(`/api/agents/${encodeURIComponent(agentId)}/capabilities/${encodeURIComponent(btn.dataset.id)}/revoke`, { method: 'POST', body: {} });
					setBusy(false);
					toast(res.ok ? 'Key revoked' : (res.message || 'Could not revoke'));
					await load();
				});
			});

			q('[data-act="revoke-all"]')?.addEventListener('click', async () => {
				if (!confirm('Revoke ALL live keys? Every skill and strategy loses its delegated budget immediately.')) return;
				if (busy) return;
				setBusy(true);
				const res = await call(`/api/agents/${encodeURIComponent(agentId)}/capabilities/revoke-all`, { method: 'POST', body: {} });
				setBusy(false);
				toast(res.ok ? `Revoked ${res.data?.count ?? ''} key(s)` : (res.message || 'Could not revoke'));
				await load();
			});

			// target-kind toggles the targets textarea
			const tkind = q('[data-f="target_kind"]');
			const tgtWrap = q('[data-targets-wrap]');
			tkind?.addEventListener('change', () => { if (tgtWrap) tgtWrap.hidden = tkind.value === 'any'; });

			q('[data-form="mint"]')?.addEventListener('submit', async (e) => {
				e.preventDefault();
				if (busy) return;
				const errEl = q('[data-err]');
				const showErr = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
				if (errEl) errEl.hidden = true;

				const actions = [...panel.querySelectorAll('[data-f="action"]:checked')].map((c) => c.value);
				if (actions.length === 0) return showErr('Pick at least one action.');
				const perUse = q('[data-f="per_use"]').value.trim();
				const aggregate = q('[data-f="aggregate"]').value.trim();
				const targetKind = tkind.value;
				const targetsRaw = q('[data-f="targets"]').value;
				const targets = targetKind === 'any' ? [] : targetsRaw.split(/[\n,]+/).map((t) => t.trim()).filter(Boolean);
				if (targetKind !== 'any' && targets.length === 0) return showErr('Add at least one target, or choose “Any target”.');
				if ((perUse && Number(perUse) < 0) || (aggregate && Number(aggregate) < 0)) return showErr('Spend limits can’t be negative.');
				if (!perUse && !aggregate && targetKind === 'any') return showErr('Set a spend ceiling or restrict to specific targets — a key must narrow something.');

				const body = {
					label: q('[data-f="label"]').value.trim(),
					actions,
					per_use_usd: perUse ? Number(perUse) : null,
					aggregate_usd: aggregate ? Number(aggregate) : null,
					target_kind: targetKind,
					targets,
					ttl_seconds: Number(q('[data-f="ttl"]').value) || 86400,
				};
				setBusy(true);
				const res = await call(`/api/agents/${encodeURIComponent(agentId)}/capabilities`, { method: 'POST', body });
				setBusy(false);
				if (!res.ok) { showErr(res.message || 'Could not mint key'); return; }
				toast('Key minted');
				await load();
			});
		}

		let pollTimer = null;
		function startPoll() {
			stopPoll();
			// Refresh live spend + countdowns while the tab is visible.
			pollTimer = setInterval(() => { if (!document.hidden && !busy) load(); }, 20000);
		}
		function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

		return {
			onShow() { renderLoading(); load(); startPoll(); },
			onHide() { stopPoll(); },
			destroy() { stopPoll(); panel.innerHTML = ''; },
		};
	},
});
