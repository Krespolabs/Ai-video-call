/**
 * Agent Wallet hub — Give tab (charity + round-up).
 *
 * Owner-only. Turns the agent's self-custodied Solana wallet into a giving
 * wallet. Two primitives, both 100% real on-chain — there is no client key, so
 * every donation is a server-signed, idempotent transfer through the same
 * POST /api/agents/:id/solana/withdraw the Withdraw tab uses; the destination is
 * the chosen cause wallet instead of the owner's. No mocks, no fake balances.
 *
 *   Cause           Pick where giving goes — a Solana address or a .sol name,
 *                   resolved live via /api/sns. Saved per-agent so it's one tap
 *                   next time. A donation is just a withdrawal to this address.
 *   Give now        Donate a chosen amount of SOL or USDC, or a quick % of the
 *                   live balance. Reviewed + confirmed (crypto is final).
 *   Round-up        "Spare change" — donate the fractional remainder of a balance
 *                   (e.g. 12.37 USDC → give $0.37, keep $12.00). One tap per asset.
 *   Impact          Total given to this cause, summed from the real custody trail
 *                   (withdrawals whose destination is the cause wallet).
 *
 * Giving prefs (cause address + label) live in localStorage — a client
 * convenience; the money movement is always real and audited server-side.
 */

import { registerWalletTab } from '../registry.js';
import { formatUsd, explorerTxUrl, shortAddress as shortAddr } from '../util.js';
import { consumeCsrfToken } from '../../api.js';
import { ensureRiskAck } from '../../shared/risk-ack.js';

const SOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const PREF_KEY = (agentId) => `awh:give:${agentId}`;

const GIVE_STYLE_ID = 'awh-give-style';
const GIVE_STYLE = `
.awg-fld { margin-bottom: var(--space-4,16px); }
.awg-fld label { display:block; font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-bottom:6px; }
.awg-in, .awg-sel { width:100%; box-sizing:border-box; font:inherit; font-size: var(--text-md,.8125rem); color: var(--ink,#e8e8e8); background: var(--surface-1, rgba(255,255,255,.03)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:9px 12px; transition: border-color var(--duration-fast,140ms); }
.awg-in:focus, .awg-sel:focus { outline:none; border-color: var(--stroke-strong, rgba(255,255,255,.2)); }
.awg-row { display:flex; gap:8px; }
.awg-row .awg-in { flex:1; }
.awg-resolved { font-size: var(--text-sm,.764rem); margin-top:6px; font-family: var(--font-mono,ui-monospace,monospace); word-break:break-all; }
.awg-resolved.ok { color: var(--success,#4ade80); }
.awg-resolved.warn { color: var(--warn,#fbbf24); }
.awg-note { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); margin-top:6px; line-height:1.45; }
.awg-err { background: color-mix(in srgb, var(--danger,#f87171) 12%, transparent); border:1px solid color-mix(in srgb, var(--danger,#f87171) 32%, transparent); color: var(--danger,#f87171); border-radius: var(--radius-md,10px); padding:10px 12px; font-size: var(--text-sm,.764rem); margin-bottom: var(--space-3,12px); }
.awg-err .why { color: var(--ink-dim,#aaa); font-size: var(--text-2xs,.6875rem); margin-top:4px; text-transform:capitalize; }
.awg-cause { display:flex; align-items:center; gap:10px; justify-content:space-between; flex-wrap:wrap; }
.awg-cause-id { display:flex; flex-direction:column; gap:2px; min-width:0; }
.awg-cause-id strong { font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
.awg-cause-id .addr { font-family: var(--font-mono,ui-monospace,monospace); font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); word-break:break-all; }
.awg-heart { font-size:22px; line-height:1; flex:none; }
.awg-chips { display:flex; gap:6px; flex-wrap:wrap; margin:10px 0 6px; }
.awg-chip { appearance:none; font:inherit; font-size: var(--text-2xs,.6875rem); color: var(--ink,#e8e8e8); background: var(--surface-2,rgba(255,255,255,.06)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-pill,999px); padding:4px 11px; cursor:pointer; transition: background var(--duration-fast,140ms), border-color var(--duration-fast,140ms); }
.awg-chip:hover { background: var(--surface-3,rgba(255,255,255,.1)); border-color: var(--stroke-strong,rgba(255,255,255,.14)); }
.awg-chip:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset:2px; }
.awg-sum { background: var(--surface-2, rgba(255,255,255,.05)); border:1px solid var(--stroke,rgba(255,255,255,.1)); border-radius: var(--radius-md,10px); padding:12px 14px; margin-bottom: var(--space-3,12px); }
.awg-sum .r { display:flex; justify-content:space-between; gap:12px; padding:4px 0; font-size: var(--text-sm,.764rem); }
.awg-sum .r > span:first-child { color: var(--ink-dim,#888); flex:none; }
.awg-sum .r .v { font-family: var(--font-mono,ui-monospace,monospace); text-align:right; word-break:break-all; color: var(--ink,#e8e8e8); }
.awg-warn { margin-top: var(--space-3,12px); padding: 9px 12px; border-radius: var(--radius-md,10px); font-size: var(--text-sm,.764rem); line-height:1.45; color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 9%, transparent); border:1px solid color-mix(in srgb, var(--warn,#fbbf24) 28%, transparent); }
.awg-actions { display:flex; gap:8px; margin-top: var(--space-3,12px); }
.awg-spare { list-style:none; margin:0; padding:0; }
.awg-spare li { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px solid var(--stroke,rgba(255,255,255,.06)); }
.awg-spare li:last-child { border-bottom:none; }
.awg-spare .lab { font-size: var(--text-sm,.764rem); color: var(--ink,#e8e8e8); }
.awg-spare .lab b { color: var(--ink-bright,#fff); font-family: var(--font-mono,ui-monospace,monospace); }
.awg-spare .lab small { display:block; color: var(--ink-dim,#888); font-size: var(--text-2xs,.6875rem); margin-top:1px; }
.awg-impact { display:flex; align-items:baseline; gap:8px; }
.awg-impact .big { font-family: var(--font-display,system-ui); font-size: var(--text-2xl,1.9rem); font-weight:700; color: var(--ink-bright,#fff); line-height:1; }
.awg-impact .unit { font-size: var(--text-sm,.764rem); color: var(--ink-dim,#888); }
.awg-give-list { list-style:none; margin:8px 0 0; padding:0; }
.awg-give-list li { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--stroke,rgba(255,255,255,.06)); font-size: var(--text-sm,.764rem); }
.awg-give-list li:last-child { border-bottom:none; }
.awg-give-list .t { color: var(--ink-dim,#888); font-family: var(--font-mono,ui-monospace,monospace); font-size: var(--text-2xs,.6875rem); }
.awg-give-list .a { font-family: var(--font-mono,ui-monospace,monospace); color: var(--ink,#e8e8e8); }
.awg-give-list a { color: inherit; border-bottom:1px dotted currentColor; text-decoration:none; }
.awg-ok { text-align:center; padding: var(--space-4,16px) var(--space-2,8px); }
.awg-ok .ic { font-size:34px; line-height:1; margin-bottom:8px; }
.awg-skel { height:14px; border-radius:6px; background: var(--surface-2, rgba(255,255,255,.05)); animation: awg-pulse 1.4s ease-in-out infinite; margin:9px 0; }
.awg-spin { display:inline-block; width:13px; height:13px; border:2px solid rgba(255,255,255,.3); border-top-color: currentColor; border-radius:50%; animation: awg-rot .7s linear infinite; vertical-align:-2px; margin-right:6px; }
@keyframes awg-rot { to { transform: rotate(360deg); } }
@keyframes awg-pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
@media (prefers-reduced-motion: reduce) { .awg-skel, .awg-spin { animation:none; } }
`;

function injectStyle() {
	if (typeof document === 'undefined' || document.getElementById(GIVE_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = GIVE_STYLE_ID;
	tag.textContent = GIVE_STYLE;
	document.head.appendChild(tag);
}

// fetch helper — never throws, always a designed result (mirrors withdraw.js).
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
			return { ok: false, status: r.status, code: j?.error || 'error', message: j?.error_description || `request failed (${r.status})`, extra: j || null };
		}
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

function fmtAmount(n, max = 6) {
	if (n == null) return '0';
	const num = Number(n);
	if (!Number.isFinite(num)) return String(n);
	return num.toLocaleString(undefined, { maximumFractionDigits: max });
}

async function resolveRecipient(raw) {
	const v = (raw || '').trim();
	if (!v) return { error: 'Enter a cause address.' };
	if (SOL_ADDR_RE.test(v)) return { address: v };
	if (/\.sol$/i.test(v)) {
		const res = await call(`/api/sns?name=${encodeURIComponent(v)}`);
		if (res.ok && res.data?.address) return { address: res.data.address, name: v };
		return { error: `Could not resolve “${v}”.` };
	}
	return { error: 'Not a valid Solana address or .sol name.' };
}

function loadPref(agentId) {
	try {
		const raw = localStorage.getItem(PREF_KEY(agentId));
		if (!raw) return null;
		const p = JSON.parse(raw);
		return p && SOL_ADDR_RE.test(p.address || '') ? p : null;
	} catch { return null; }
}
function savePref(agentId, pref) {
	try { localStorage.setItem(PREF_KEY(agentId), JSON.stringify(pref)); } catch { /* storage may be blocked */ }
}
function clearPref(agentId) {
	try { localStorage.removeItem(PREF_KEY(agentId)); } catch { /* ignore */ }
}

registerWalletTab({
	id: 'give',
	label: 'Give',
	order: 70,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectStyle();
		const { escapeHtml, toast } = ctx;
		const esc = escapeHtml;
		const base = (sub) => `/api/agents/${encodeURIComponent(ctx.agentId)}/solana/${sub}`;

		let destroyed = false;
		let detachNet = null;
		const state = {
			pref: loadPref(ctx.agentId),   // { address, label, name } | null
			editing: false,                // editing/setting the cause
			holdings: null,                // { sol, tokens } | null
			holdingsErr: null,
			impact: null,                  // { totalUsd, count, recent:[] } | null
			// give-now form
			selectedAsset: 0,
			amount: '',
			phase: 'form',                 // 'form' | 'confirm' | 'sending' | 'success'
			intent: null,
			result: null,
		};

		// ── assets from live holdings ────────────────────────────────────────────
		function assetList() {
			const out = [];
			const { sol = 0, tokens = [] } = state.holdings || {};
			if (Number(sol) > 0) out.push({ kind: 'SOL', name: 'SOL', max: Number(sol), decimals: 9 });
			for (const t of tokens) {
				if (!(Number(t.ui_amount) > 0)) continue;
				out.push({
					kind: t.mint,
					name: t.is_usdc ? 'USDC' : shortAddr(t.mint, 4, 4),
					max: Number(t.ui_amount),
					decimals: t.decimals,
					isUsdc: !!t.is_usdc,
				});
			}
			return out;
		}

		// Fractional "spare change" of each held asset.
		function spareChange() {
			return assetList()
				.map((a) => ({ ...a, spare: +(a.max - Math.floor(a.max)).toFixed(Math.min(a.decimals, 9)) }))
				.filter((a) => a.spare > 0);
		}

		// ── top-level render ─────────────────────────────────────────────────────
		function render() {
			if (destroyed) return;
			if (!state.pref || state.editing) { panel.innerHTML = renderCauseSetup(); wireCauseSetup(); return; }
			if (state.phase === 'success') { panel.innerHTML = renderSuccess(); wireSuccess(); return; }
			if (state.phase === 'confirm' && state.intent) { panel.innerHTML = renderConfirm(); wireConfirm(); return; }
			panel.innerHTML = renderHome();
			wireHome();
		}

		// ── cause setup ──────────────────────────────────────────────────────────
		function renderCauseSetup() {
			const p = state.pref || {};
			return `
				<div class="awh-card">
					<p class="awh-card-h">💚 Your cause</p>
					<p class="awg-note" style="margin-top:0;">Pick where this wallet's giving goes — any Solana wallet or <span class="awh-mono">.sol</span> name. A donation is a real on-chain transfer to this address.</p>
					<div class="awg-fld" style="margin-top:14px;">
						<label for="awg-cause-label">Cause name <span style="opacity:.6">(optional)</span></label>
						<input class="awg-in" id="awg-cause-label" autocomplete="off" maxlength="60" placeholder="e.g. Ocean Cleanup" value="${esc(p.label || '')}">
					</div>
					<div class="awg-fld">
						<label for="awg-cause-addr">Cause wallet — address or .sol name</label>
						<input class="awg-in" id="awg-cause-addr" autocomplete="off" spellcheck="false" placeholder="Wallet address or name.sol" value="${esc(p.name || p.address || '')}">
						<div class="awg-resolved" id="awg-cause-resolved" role="status" aria-live="polite" hidden></div>
					</div>
					<div class="awg-err" id="awg-cause-err" role="alert" hidden></div>
					<div class="awg-actions">
						${state.pref ? '<button class="awh-btn" id="awg-cause-cancel" type="button" style="flex:1;">Cancel</button>' : ''}
						<button class="awh-btn awh-btn--primary" id="awg-cause-save" type="button" style="flex:2;">Save cause</button>
					</div>
				</div>`;
		}

		function wireCauseSetup() {
			const addrInput = panel.querySelector('#awg-cause-addr');
			const resolvedEl = panel.querySelector('#awg-cause-resolved');
			const errEl = panel.querySelector('#awg-cause-err');
			let resolved = state.pref ? { address: state.pref.address, name: state.pref.name } : null;
			let seq = 0;

			async function doResolve() {
				const myId = ++seq;
				const raw = addrInput.value.trim();
				resolved = null;
				if (!raw) { resolvedEl.hidden = true; return; }
				if (SOL_ADDR_RE.test(raw)) {
					resolved = { address: raw };
					resolvedEl.hidden = false; resolvedEl.className = 'awg-resolved ok'; resolvedEl.textContent = `✓ ${shortAddr(raw, 6, 6)}`;
					return;
				}
				const res = await resolveRecipient(raw);
				if (myId !== seq) return;
				if (res.address) {
					resolved = { address: res.address, name: res.name };
					resolvedEl.hidden = false; resolvedEl.className = 'awg-resolved ok'; resolvedEl.textContent = `→ ${res.address}`;
				} else {
					resolvedEl.hidden = false; resolvedEl.className = 'awg-resolved warn'; resolvedEl.textContent = res.error || 'unresolved';
				}
			}
			addrInput.addEventListener('input', () => { clearTimeout(addrInput._t); addrInput._t = setTimeout(doResolve, 250); });
			if (addrInput.value.trim()) doResolve();

			panel.querySelector('#awg-cause-cancel')?.addEventListener('click', () => { state.editing = false; render(); });

			panel.querySelector('#awg-cause-save')?.addEventListener('click', async () => {
				errEl.hidden = true;
				if (!resolved) { await doResolve(); }
				if (!resolved?.address) { errEl.hidden = false; errEl.textContent = 'Enter a valid Solana address or .sol name for the cause.'; return; }
				const label = (panel.querySelector('#awg-cause-label').value || '').trim();
				state.pref = { address: resolved.address, name: resolved.name || null, label: label || null };
				savePref(ctx.agentId, state.pref);
				state.editing = false;
				state.impact = null;
				toast('Cause saved');
				render();
				loadHoldings();
				loadImpact();
			});
		}

		// ── home (cause set) ─────────────────────────────────────────────────────
		function causeName() {
			const p = state.pref || {};
			return p.label || p.name || shortAddr(p.address, 4, 4);
		}

		function renderHome() {
			const p = state.pref;
			const spare = state.holdings ? spareChange() : null;
			return `
				<div class="awh-card">
					<div class="awg-cause">
						<span class="awg-heart" aria-hidden="true">💚</span>
						<div class="awg-cause-id">
							<strong>${esc(causeName())}</strong>
							<span class="addr">${esc(p.name ? `${p.name} · ` : '')}${esc(shortAddr(p.address, 6, 6))}</span>
						</div>
						<button class="awh-btn" id="awg-change" type="button">Change</button>
					</div>
				</div>

				<div class="awh-card">
					<p class="awh-card-h">Your impact</p>
					${renderImpact()}
				</div>

				<div class="awh-card">
					<p class="awh-card-h">Give now</p>
					${renderGiveForm()}
				</div>

				<div class="awh-card">
					<p class="awh-card-h">Round up · spare change</p>
					${spare === null && !state.holdingsErr
						? '<div class="awg-skel" style="width:60%"></div><div class="awg-skel"></div>'
						: state.holdingsErr
							? `<div class="awg-err" role="alert">Couldn’t load balances.<div class="why">${esc(state.holdingsErr)}</div></div><button class="awh-btn" id="awg-reload" type="button">Retry</button>`
							: renderSpare(spare)}
				</div>`;
		}

		function renderImpact() {
			if (state.impact === null) return '<div class="awg-skel" style="width:40%"></div><div class="awg-skel" style="width:70%"></div>';
			const { totalUsd = 0, count = 0, recent = [] } = state.impact;
			if (!count) {
				return `<div class="awg-impact"><span class="big">$0.00</span><span class="unit">given so far</span></div>
					<p class="awg-note">Your donations to ${esc(causeName())} will tally here, settled on-chain and pulled from this wallet's custody trail.</p>`;
			}
			return `
				<div class="awg-impact"><span class="big">${esc(formatUsd(totalUsd) || '$0.00')}</span><span class="unit">given · ${count} donation${count === 1 ? '' : 's'}</span></div>
				<ul class="awg-give-list">
					${recent.slice(0, 5).map((e) => {
						const when = e.created_at ? new Date(e.created_at).toLocaleDateString() : '';
						const amt = e.usd != null ? (formatUsd(e.usd) || '') : (e.asset === 'SOL' && e.amount_lamports != null ? `${fmtAmount(Number(e.amount_lamports) / 1e9, 6)} SOL` : '');
						const link = e.explorer ? `<a href="${esc(e.explorer)}" target="_blank" rel="noopener">tx ↗</a>` : '';
						return `<li><span class="t">${esc(when)} ${link}</span><span class="a">${esc(amt)}</span></li>`;
					}).join('')}
				</ul>`;
		}

		function renderGiveForm() {
			if (state.holdings === null && !state.holdingsErr) return '<div class="awg-skel" style="width:50%"></div><div class="awg-skel"></div><div class="awg-skel" style="width:30%"></div>';
			if (state.holdingsErr) return `<div class="awg-err" role="alert">Couldn’t load balances.<div class="why">${esc(state.holdingsErr)}</div></div><button class="awh-btn" id="awg-reload2" type="button">Retry</button>`;
			const assets = assetList();
			if (!assets.length) return `<div class="awh-empty" style="padding:8px 0;">This wallet holds no funds on ${esc(ctx.getNetwork())} yet. Fund it from the Deposit tab, then give from here.</div>`;
			const a = assets[Math.min(state.selectedAsset, assets.length - 1)];
			return `
				<div class="awg-fld">
					<label for="awg-asset">Donate</label>
					<select class="awg-sel" id="awg-asset">
						${assets.map((x, i) => `<option value="${i}" ${i === state.selectedAsset ? 'selected' : ''}>${esc(x.name)} — ${esc(fmtAmount(x.max, x.decimals))} available</option>`).join('')}
					</select>
				</div>
				<div class="awg-chips" id="awg-pcts" role="group" aria-label="Quick amounts">
					${[1, 5, 10, 25].map((p) => `<button class="awg-chip" type="button" data-pct="${p}">${p}%</button>`).join('')}
					<button class="awg-chip" type="button" data-pct="100">Max</button>
				</div>
				<div class="awg-fld">
					<label for="awg-amount">Amount (${esc(a.name)})</label>
					<input class="awg-in" id="awg-amount" type="text" inputmode="decimal" placeholder="0.0" value="${esc(state.amount)}">
					<div class="awg-note" id="awg-avail">Available: ${esc(fmtAmount(a.max, a.decimals))} ${esc(a.name)}</div>
				</div>
				<div class="awg-err" id="awg-give-err" role="alert" hidden></div>
				<button class="awh-btn awh-btn--primary" id="awg-review" type="button" style="width:100%;">Review donation</button>`;
		}

		function renderSpare(spare) {
			if (!spare || !spare.length) {
				return `<div class="awh-empty" style="padding:8px 0;">No spare change right now — balances are whole. As fractions build up, round them off here into a donation.</div>`;
			}
			return `<ul class="awg-spare">
				${spare.map((a, i) => `
					<li>
						<span class="lab"><b>${esc(fmtAmount(a.spare, a.decimals))} ${esc(a.name)}</b><small>round ${esc(fmtAmount(a.max, a.decimals))} → ${esc(fmtAmount(Math.floor(a.max), 0))} ${esc(a.name)}</small></span>
						<button class="awh-btn" type="button" data-spare="${i}">Donate spare</button>
					</li>`).join('')}
			</ul>
			<p class="awg-note">Gives the fractional remainder to ${esc(causeName())} and keeps the whole units. Real on-chain transfer.</p>`;
		}

		// ── confirm / success ────────────────────────────────────────────────────
		function renderConfirm() {
			const it = state.intent;
			return `
				<div class="awh-card">
					<p class="awh-card-h">Confirm donation</p>
					<div class="awg-sum">
						<div class="r"><span>To</span><span class="v">${esc(causeName())}</span></div>
						<div class="r"><span>Address</span><span class="v awh-mono">${esc(it.destination)}</span></div>
						<div class="r"><span>Amount</span><span class="v">${esc(fmtAmount(it.amount, it.decimals))} ${esc(it.assetName)}</span></div>
						<div class="r"><span>Network</span><span class="v">${esc(ctx.getNetwork())}</span></div>
					</div>
					<div class="awg-warn" role="note">⚠ Crypto transfers are final. Once submitted, this donation cannot be undone or reversed.</div>
					<div class="awg-err" id="awg-cf-err" role="alert" hidden></div>
					<div class="awg-actions">
						<button class="awh-btn" id="awg-back" type="button" style="flex:1;" ${state.phase === 'sending' ? 'disabled' : ''}>Back</button>
						<button class="awh-btn awh-btn--primary" id="awg-confirm" type="button" style="flex:2;" ${state.phase === 'sending' ? 'disabled' : ''}>
							${state.phase === 'sending' ? '<span class="awg-spin"></span>Sending…' : 'Confirm donation'}
						</button>
					</div>
				</div>`;
		}

		function renderSuccess() {
			const r = state.result || {};
			const it = state.intent || {};
			const sig = r.signature || null;
			const explorer = r.explorer || (sig ? explorerTxUrl(sig, ctx.getNetwork()) : null);
			return `
				<div class="awh-card awg-ok">
					<div class="ic">${state.unconfirmed ? '⏳' : '💚'}</div>
					<div style="font-size:var(--text-md,.8125rem);font-weight:600;color:var(--ink-bright,#fff);margin-bottom:4px;">
						${state.unconfirmed ? 'Donation submitted' : 'Thank you — donation sent'}
					</div>
					<div class="awh-empty" style="padding:0 0 12px;">
						${state.unconfirmed
							? 'Submitted to the network — confirm it on the explorer before retrying.'
							: `${esc(fmtAmount(it.amount, it.decimals))} ${esc(it.assetName)} given to ${esc(causeName())}.`}
					</div>
					${explorer ? `<a class="awh-btn awh-btn--primary" href="${esc(explorer)}" target="_blank" rel="noopener" style="text-decoration:none;display:inline-block;">View on explorer ↗</a>` : ''}
					<div style="margin-top:14px;"><button class="awh-btn" id="awg-again" type="button">Give again</button></div>
				</div>`;
		}

		// ── wiring ───────────────────────────────────────────────────────────────
		function wireHome() {
			panel.querySelector('#awg-change')?.addEventListener('click', () => { state.editing = true; render(); });
			panel.querySelector('#awg-reload')?.addEventListener('click', () => { state.holdings = null; state.holdingsErr = null; render(); loadHoldings(); });
			panel.querySelector('#awg-reload2')?.addEventListener('click', () => { state.holdings = null; state.holdingsErr = null; render(); loadHoldings(); });

			const assets = assetList();
			const assetSel = panel.querySelector('#awg-asset');
			const amountInput = panel.querySelector('#awg-amount');
			const availEl = panel.querySelector('#awg-avail');
			const errEl = panel.querySelector('#awg-give-err');
			const currentAsset = () => assets[Math.min(Number(assetSel?.value || 0), assets.length - 1)];

			assetSel?.addEventListener('change', () => {
				state.selectedAsset = Number(assetSel.value);
				const a = currentAsset();
				if (availEl) availEl.textContent = `Available: ${fmtAmount(a.max, a.decimals)} ${a.name}`;
			});
			amountInput?.addEventListener('input', () => { state.amount = amountInput.value; });

			panel.querySelectorAll('#awg-pcts [data-pct]').forEach((b) => b.addEventListener('click', () => {
				const a = currentAsset();
				if (!a) return;
				const pct = Number(b.dataset.pct);
				const v = +(a.max * (pct / 100)).toFixed(Math.min(a.decimals, 9));
				if (amountInput) { amountInput.value = String(v); state.amount = String(v); }
			}));

			panel.querySelector('#awg-review')?.addEventListener('click', () => {
				if (!errEl) return;
				errEl.hidden = true;
				const a = currentAsset();
				if (!a) { errEl.hidden = false; errEl.textContent = 'No asset available to donate.'; return; }
				const amt = Number((amountInput.value || '').trim());
				if (!Number.isFinite(amt) || amt <= 0) { errEl.hidden = false; errEl.textContent = 'Enter an amount, or tap a quick %.'; return; }
				if (amt > a.max + 1e-12) { errEl.hidden = false; errEl.textContent = 'Amount exceeds the available balance.'; return; }
				beginConfirm(a, amt);
			});

			// Round-up donations — one per asset row.
			const spare = spareChange();
			panel.querySelectorAll('[data-spare]').forEach((b) => b.addEventListener('click', () => {
				const a = spare[Number(b.dataset.spare)];
				if (a) beginConfirm(a, a.spare);
			}));
		}

		function beginConfirm(asset, amount) {
			state.intent = {
				kind: asset.kind,
				assetName: asset.name,
				decimals: asset.decimals,
				amount,
				destination: state.pref.address,
				idem: (crypto?.randomUUID?.() || `give-${Date.now()}-${Math.round(Math.random() * 1e9)}`),
			};
			state.phase = 'confirm';
			render();
		}

		function wireConfirm() {
			panel.querySelector('#awg-back')?.addEventListener('click', () => { state.phase = 'form'; render(); });
			panel.querySelector('#awg-confirm')?.addEventListener('click', submitDonation);
		}

		function wireSuccess() {
			panel.querySelector('#awg-again')?.addEventListener('click', () => {
				state.phase = 'form'; state.intent = null; state.result = null; state.amount = ''; state.unconfirmed = false;
				state.holdings = null; state.impact = null;
				render();
				loadHoldings();
				loadImpact();
			});
		}

		async function submitDonation() {
			const it = state.intent;
			if (!it || state.phase === 'sending') return;
			if (ctx.getNetwork() !== 'devnet' && !(await ensureRiskAck({ context: 'give' }))) return;
			state.phase = 'sending';
			render();
			const res = await call(base('withdraw'), {
				method: 'POST',
				body: { asset: it.kind, amount: it.amount, destination: it.destination, network: ctx.getNetwork(), idempotency_key: it.idem },
			});
			if (destroyed) return;
			if (res.ok || res.status === 202) {
				state.result = res.ok ? res.data : (res.extra?.data ?? res.extra ?? {});
				state.unconfirmed = res.status === 202;
				state.phase = 'success';
				toast(state.unconfirmed ? 'Donation submitted' : 'Donation sent 💚');
				render();
				return;
			}
			state.phase = 'confirm';
			render();
			const errEl = panel.querySelector('#awg-cf-err');
			if (errEl) {
				errEl.hidden = false;
				errEl.innerHTML = `${esc(res.message)}${res.code ? `<div class="why">${esc(String(res.code).replace(/_/g, ' '))}</div>` : ''}`;
			}
		}

		// ── data loads ───────────────────────────────────────────────────────────
		async function loadHoldings() {
			const res = await call(`${base('holdings')}?network=${ctx.getNetwork()}`);
			if (destroyed) return;
			if (!res.ok) { state.holdingsErr = res.message; state.holdings = null; }
			else { state.holdingsErr = null; state.holdings = res.data; }
			if (state.pref && !state.editing && state.phase === 'form') render();
		}

		// Impact = withdrawals from the custody trail whose destination is the cause.
		async function loadImpact() {
			if (!state.pref) return;
			const res = await call(`${base('custody')}?network=${ctx.getNetwork()}&limit=100`);
			if (destroyed) return;
			if (!res.ok) { state.impact = { totalUsd: 0, count: 0, recent: [] }; if (!state.editing && state.phase === 'form') render(); return; }
			const dest = state.pref.address;
			const gifts = (res.data?.items || []).filter(
				(e) => e.event_type === 'spend' && e.category === 'withdraw' && e.destination === dest,
			);
			const totalUsd = gifts.reduce((s, e) => s + (Number(e.usd) || 0), 0);
			state.impact = { totalUsd, count: gifts.length, recent: gifts };
			if (state.pref && !state.editing && state.phase === 'form') render();
		}

		detachNet = ctx.onNetworkChange(() => {
			state.holdings = null; state.holdingsErr = null; state.impact = null;
			state.phase = 'form'; state.intent = null; state.amount = '';
			render();
			if (state.pref && !state.editing) { loadHoldings(); loadImpact(); }
		});

		render();

		return {
			onShow() {
				if (!state.pref || state.editing) return;
				if (state.holdings === null && state.phase === 'form') loadHoldings();
				if (state.impact === null) loadImpact();
			},
			destroy() { destroyed = true; detachNet?.(); },
		};
	},
});

// Exported for unit tests — pure helpers with no DOM dependency.
export const __test = { SOL_ADDR_RE, fmtAmount, loadPref, savePref, clearPref, PREF_KEY };
