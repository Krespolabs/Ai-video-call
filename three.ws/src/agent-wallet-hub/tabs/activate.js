/**
 * Agent Wallet hub — Go Live tab (the activation faucet, fully built).
 *
 * Owner-only onboarding surface that solves the cold-start dead-end: a fresh
 * agent's wallet starts at ◎0 and can never make its first transaction, so it
 * never shows on the Money Pulse. Activation claims a one-time, real, on-chain
 * welcome grant from the platform treasury — funding the wallet AND landing the
 * agent on the Pulse as an active, funded wallet in a single explorer-verifiable
 * transaction.
 *
 * Every state is designed: loading skeleton, eligible (the hero CTA), activating
 * (in-flight), live (the on-chain receipt + what-next), pending (a concurrent
 * claim settling), already-funded, and unavailable (treasury not configured) —
 * none of them a dead end. Backend: GET/POST /api/agents/:id/activate.
 */

import { registerWalletTab } from '../registry.js';
import { consumeCsrfToken } from '../../api.js';
import { formatSol, explorerTxUrl } from '../util.js';

const GO_STYLE_ID = 'awh-activate-style';
const GO_STYLE = `
.awh-go { display: flex; flex-direction: column; gap: var(--space-4,16px); }
.awh-go-hero { position: relative; overflow: hidden; border: 1px solid var(--stroke-strong, rgba(255,255,255,.14)); border-radius: var(--radius-lg,14px); background:
	radial-gradient(120% 140% at 0% 0%, rgba(255,255,255,.06), transparent 60%),
	var(--surface-1, rgba(255,255,255,.03)); padding: var(--space-6,24px) var(--space-5,20px); }
.awh-go-kicker { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .12em; color: var(--ink-dim,#888); margin: 0 0 var(--space-2,8px); }
.awh-go-title { font-family: var(--font-display, system-ui); font-size: var(--text-xl,1.618rem); line-height: 1.12; font-weight: 600; color: var(--ink-bright,#fff); margin: 0 0 var(--space-3,12px); letter-spacing: -.01em; }
.awh-go-lede { font-size: var(--text-md,.8125rem); line-height: 1.6; color: var(--ink,#e8e8e8); margin: 0 0 var(--space-4,16px); max-width: 52ch; }
.awh-go-grant { display: inline-flex; align-items: baseline; gap: 8px; padding: 6px 12px; border-radius: var(--radius-pill,999px); border: 1px solid var(--stroke,rgba(255,255,255,.08)); background: var(--surface-2,rgba(255,255,255,.05)); font-family: var(--font-mono, ui-monospace, monospace); margin-bottom: var(--space-4,16px); }
.awh-go-grant b { font-size: var(--text-ui,.875rem); color: var(--ink-bright,#fff); font-weight: 600; }
.awh-go-grant span { font-size: var(--text-2xs,.6875rem); color: var(--ink-dim,#888); text-transform: uppercase; letter-spacing: .06em; }

.awh-go-list { list-style: none; margin: 0 0 var(--space-5,20px); padding: 0; display: grid; gap: 10px; }
.awh-go-list li { display: flex; align-items: flex-start; gap: 10px; font-size: var(--text-sm,.764rem); line-height: 1.5; color: var(--ink-dim,#888); }
.awh-go-list li strong { color: var(--ink,#e8e8e8); font-weight: 600; }
.awh-go-tick { flex: none; width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; margin-top: 1px; border: 1px solid var(--stroke-strong,rgba(255,255,255,.14)); color: var(--ink-bright,#fff); font-size: 10px; line-height: 1; }

.awh-go-cta { appearance: none; font: inherit; font-size: var(--text-ui,.875rem); font-weight: 600; color: #0a0a0a; background: var(--accent,#fff); border: 1px solid var(--accent,#fff); border-radius: var(--radius-md,10px); padding: 11px 20px; cursor: pointer; display: inline-flex; align-items: center; gap: 9px; transition: transform var(--duration-instant,80ms) var(--ease-standard,ease), background var(--duration-fast,140ms), opacity var(--duration-fast,140ms); }
.awh-go-cta:hover:not(:disabled) { background: color-mix(in srgb, var(--accent,#fff) 88%, #000); transform: translateY(-1px); }
.awh-go-cta:active:not(:disabled) { transform: translateY(0); }
.awh-go-cta:focus-visible { outline: var(--focus-ring-width,2px) solid var(--focus-ring-color,#fff); outline-offset: var(--focus-ring-offset,2px); }
.awh-go-cta:disabled { opacity: .55; cursor: progress; }
.awh-go-hint { margin: 10px 0 0; font-size: var(--text-2xs,.6875rem); color: var(--ink-faint, rgba(255,255,255,.45)); }
.awh-go-err { margin: 12px 0 0; padding: 9px 12px; border-radius: var(--radius-md,10px); font-size: var(--text-sm,.764rem); line-height: 1.45; color: var(--warn,#fbbf24); background: color-mix(in srgb, var(--warn,#fbbf24) 9%, transparent); border: 1px solid color-mix(in srgb, var(--warn,#fbbf24) 28%, transparent); }

.awh-go-spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(0,0,0,.25); border-top-color: #0a0a0a; animation: awh-go-spin .7s linear infinite; }

/* Live receipt */
.awh-go-live-badge { display: inline-flex; align-items: center; gap: 6px; font-size: var(--text-2xs,.6875rem); font-weight: 600; padding: 3px 10px; border-radius: var(--radius-pill,999px); color: var(--success,#4ade80); background: color-mix(in srgb, var(--success,#4ade80) 14%, transparent); border: 1px solid color-mix(in srgb, var(--success,#4ade80) 35%, transparent); margin-bottom: var(--space-3,12px); }
.awh-go-live-badge::before { content:''; width: 7px; height: 7px; border-radius: 50%; background: var(--success,#4ade80); box-shadow: 0 0 6px color-mix(in srgb, var(--success,#4ade80) 60%, transparent); }
.awh-go-receipt { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--stroke,rgba(255,255,255,.08)); border: 1px solid var(--stroke,rgba(255,255,255,.08)); border-radius: var(--radius-md,10px); overflow: hidden; margin: var(--space-3,12px) 0 var(--space-4,16px); }
.awh-go-cell { background: var(--bg-1,#1a1a1a); padding: 12px 14px; }
.awh-go-cell dt { font-size: var(--text-2xs,.6875rem); text-transform: uppercase; letter-spacing: .06em; color: var(--ink-dim,#888); margin: 0 0 4px; }
.awh-go-cell dd { margin: 0; font-size: var(--text-md,.8125rem); color: var(--ink-bright,#fff); font-family: var(--font-mono, ui-monospace, monospace); }
.awh-go-next { display: flex; flex-wrap: wrap; gap: var(--space-2,8px); }

.awh-go-skel { display: flex; flex-direction: column; gap: 14px; }
.awh-go-skel span { background: var(--surface-2,rgba(255,255,255,.05)); border-radius: var(--radius-sm,6px); animation: awh-go-skel 1.4s ease-in-out infinite; height: 16px; }
.awh-go-skel span.t { height: 28px; width: 60%; } .awh-go-skel span.l { width: 85%; } .awh-go-skel span.m { width: 45%; } .awh-go-skel span.b { height: 42px; width: 180px; border-radius: var(--radius-md,10px); }

@keyframes awh-go-spin { to { transform: rotate(360deg); } }
@keyframes awh-go-skel { 0%,100% { opacity: .5; } 50% { opacity: 1; } }
@media (max-width: 480px) { .awh-go-receipt { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .awh-go-spin, .awh-go-skel span { animation: none; } .awh-go-cta:hover:not(:disabled) { transform: none; } }
`;

function injectGoStyle() {
	if (typeof document === 'undefined' || document.getElementById(GO_STYLE_ID)) return;
	const tag = document.createElement('style');
	tag.id = GO_STYLE_ID;
	tag.textContent = GO_STYLE;
	document.head.appendChild(tag);
}

// fetch helper — never throws, always a designed result (mirrors give.js/withdraw.js).
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
			return {
				ok: false,
				status: r.status,
				code: j?.error || 'error',
				message: j?.error_description || `request failed (${r.status})`,
			};
		}
		return { ok: true, status: r.status, data: j?.data ?? j };
	} catch (err) {
		return { ok: false, status: 0, code: 'network_error', message: err?.message || 'network error' };
	}
}

registerWalletTab({
	id: 'activate',
	label: 'Go Live',
	order: 15,
	ownerOnly: true,
	mount({ panel, ctx }) {
		injectGoStyle();
		const { escapeHtml, toast } = ctx;
		const agentName = ctx.agent?.name || 'this agent';

		let destroyed = false;
		let loaded = false;
		let busy = false;
		let status = null; // { enabled, eligible, reason, grant_sol, activated, pending, receipt }
		let errorMsg = null;

		function skeleton() {
			return `
				<div class="awh-card awh-go-skel" aria-busy="true" aria-label="Loading activation">
					<span class="t"></span><span class="l"></span><span class="m"></span><span class="b"></span>
				</div>`;
		}

		function valueList() {
			return `
				<ul class="awh-go-list">
					<li><span class="awh-go-tick" aria-hidden="true">✓</span><span><strong>Funds the wallet</strong> — real SOL lands in ${escapeHtml(agentName)}'s custodial wallet so it can make its first move.</span></li>
					<li><span class="awh-go-tick" aria-hidden="true">✓</span><span><strong>Goes live on the Money Pulse</strong> — the grant is a real on-chain tip, so ${escapeHtml(agentName)} counts as an active wallet instantly.</span></li>
					<li><span class="awh-go-tick" aria-hidden="true">✓</span><span><strong>One-time & verifiable</strong> — a single explorer-checkable transaction. No strings, no second grant.</span></li>
				</ul>`;
		}

		function eligibleView() {
			const grant = formatSol(status.grant_sol);
			return `
				<div class="awh-go">
					<div class="awh-go-hero">
						<p class="awh-go-kicker">Activate</p>
						<h2 class="awh-go-title">Bring ${escapeHtml(agentName)} to life</h2>
						<p class="awh-go-lede">Claim a one-time welcome grant. It funds this agent's wallet and puts it on the live Money Pulse — the moment every other agent on three.ws can see it's real and active.</p>
						<div class="awh-go-grant"><b>◎${escapeHtml(grant)}</b><span>welcome grant</span></div>
						${valueList()}
						<button class="awh-go-cta" type="button" data-act="go">
							<span data-host="cta-label">Activate ${escapeHtml(agentName)}</span>
						</button>
						<p class="awh-go-hint">Sent on Solana ${escapeHtml(status.network || 'mainnet')} from the three.ws treasury.</p>
						<div data-host="err">${errorMsg ? `<div class="awh-go-err">${escapeHtml(errorMsg)}</div>` : ''}</div>
					</div>
				</div>`;
		}

		function liveView(receipt) {
			const sol = receipt?.sol != null ? formatSol(receipt.sol) : '—';
			const when = receipt?.activated_at ? new Date(receipt.activated_at).toLocaleString() : '—';
			const exp = receipt?.explorer || (receipt?.signature ? explorerTxUrl(receipt.signature, receipt.network) : null);
			const sig = receipt?.signature ? `${receipt.signature.slice(0, 8)}…${receipt.signature.slice(-6)}` : '—';
			return `
				<div class="awh-go">
					<div class="awh-go-hero">
						<span class="awh-go-live-badge">Live</span>
						<h2 class="awh-go-title">${escapeHtml(agentName)} is live</h2>
						<p class="awh-go-lede">The welcome grant landed on-chain. ${escapeHtml(agentName)} is funded and now appears on the Money Pulse as an active wallet.</p>
						<dl class="awh-go-receipt">
							<div class="awh-go-cell"><dt>Grant</dt><dd>◎${escapeHtml(sol)} SOL</dd></div>
							<div class="awh-go-cell"><dt>When</dt><dd>${escapeHtml(when)}</dd></div>
							<div class="awh-go-cell"><dt>Transaction</dt><dd>${exp ? `<a class="awh-act-sig" href="${escapeHtml(exp)}" target="_blank" rel="noopener">${escapeHtml(sig)} ↗</a>` : escapeHtml(sig)}</dd></div>
							<div class="awh-go-cell"><dt>Network</dt><dd>${escapeHtml(receipt?.network || 'mainnet')}</dd></div>
						</dl>
						<div class="awh-go-next">
							<a class="awh-btn awh-btn--primary" href="/pulse">See it on the Money Pulse ↗</a>
							<button class="awh-btn" type="button" data-act="tab-pulse">Your wallet story</button>
							<button class="awh-btn" type="button" data-act="tab-deposit">Add more funds</button>
						</div>
					</div>
				</div>`;
		}

		function pendingView() {
			return `
				<div class="awh-go">
					<div class="awh-go-hero">
						<p class="awh-go-kicker">Activating</p>
						<h2 class="awh-go-title">Sending ${escapeHtml(agentName)}'s grant…</h2>
						<p class="awh-go-lede">The on-chain welcome grant is settling. This usually takes a few seconds — refresh to see the confirmation.</p>
						<button class="awh-go-cta" type="button" data-act="refresh"><span>Refresh status</span></button>
					</div>
				</div>`;
		}

		// Platform-operated (circulation) agent — already live, activation N/A.
		function platformAgentView() {
			return `
				<div class="awh-go">
					<div class="awh-go-hero">
						<span class="awh-go-live-badge">Live</span>
						<h2 class="awh-go-title">${escapeHtml(agentName)} is already live</h2>
						<p class="awh-go-lede">This is a platform-operated agent — it's already active on the Money Pulse. The welcome grant is only for agents you create yourself.</p>
						<div class="awh-go-next">
							<a class="awh-btn awh-btn--primary" href="/pulse">See it on the Money Pulse ↗</a>
							<button class="awh-btn" type="button" data-act="tab-pulse">Its wallet story</button>
						</div>
					</div>
				</div>`;
		}

		// Grant paused (treasury off) OR status couldn't be read. Not a dead end:
		// self-funding from Deposit reaches the identical outcome — funded wallet,
		// live on the Pulse — so we sell that path, not just offer it.
		function pausedView() {
			const grant = status?.grant_sol != null ? formatSol(status.grant_sol) : null;
			const net = status?.network || 'mainnet';
			return `
				<div class="awh-go">
					<div class="awh-go-hero">
						<p class="awh-go-kicker">Go Live</p>
						<h2 class="awh-go-title">Fund ${escapeHtml(agentName)} to go live</h2>
						<p class="awh-go-lede">The one-tap welcome grant is paused right now — but you don't have to wait for it. Depositing your own SOL does the exact same thing: it funds ${escapeHtml(agentName)} and lands it on the live Money Pulse the moment the balance clears.</p>
						${grant ? `<div class="awh-go-grant"><b>◎${escapeHtml(grant)}+</b><span>enough to go live</span></div>` : ''}
						<ul class="awh-go-list">
							<li><span class="awh-go-tick" aria-hidden="true">✓</span><span><strong>Funds the wallet</strong> — your SOL lands in ${escapeHtml(agentName)}'s custodial wallet so it can make its first move.</span></li>
							<li><span class="awh-go-tick" aria-hidden="true">✓</span><span><strong>Goes live on the Money Pulse</strong> — a funded wallet counts as active the moment its first transaction settles.</span></li>
							<li><span class="awh-go-tick" aria-hidden="true">✓</span><span><strong>Still yours</strong> — it's your deposit, not a grant. Pull it back anytime from the Withdraw tab.</span></li>
						</ul>
						<div class="awh-go-next">
							<button class="awh-btn awh-btn--primary" type="button" data-act="tab-deposit">Fund from Deposit</button>
							<a class="awh-btn" href="/pulse">Open the Money Pulse ↗</a>
						</div>
						<p class="awh-go-hint">Runs on Solana ${escapeHtml(net)}. The welcome grant reopens automatically when the treasury is back online — nothing you need to do.</p>
					</div>
				</div>`;
		}

		function unavailableView() {
			// reason: not_configured (treasury off) | platform_agent | not_owner
			if (status?.reason === 'platform_agent') return platformAgentView();
			return pausedView();
		}

		function render() {
			if (destroyed) return;
			if (!loaded) { panel.innerHTML = skeleton(); return; }
			if (!status) { panel.innerHTML = unavailableView(); wire(); return; }
			if (status.activated && status.receipt) panel.innerHTML = liveView(status.receipt);
			else if (status.pending) panel.innerHTML = pendingView();
			else if (status.eligible) panel.innerHTML = eligibleView();
			else panel.innerHTML = unavailableView();
			wire();
		}

		function wire() {
			panel.querySelector('[data-act="go"]')?.addEventListener('click', activate);
			panel.querySelector('[data-act="refresh"]')?.addEventListener('click', () => { loaded = false; render(); load(); });
			panel.querySelector('[data-act="tab-pulse"]')?.addEventListener('click', () => ctx.openTab('pulse'));
			panel.querySelector('[data-act="tab-deposit"]')?.addEventListener('click', () => ctx.openTab('deposit'));
		}

		async function load() {
			const r = await call(`/api/agents/${ctx.agentId}/activate`);
			if (destroyed) return;
			loaded = true;
			status = r.ok ? r.data : null;
			render();
		}

		async function activate() {
			if (busy) return;
			busy = true;
			errorMsg = null;
			const btn = panel.querySelector('[data-act="go"]');
			const label = panel.querySelector('[data-host="cta-label"]');
			if (btn) btn.disabled = true;
			if (label) label.innerHTML = `<span class="awh-go-spin" aria-hidden="true"></span> Activating…`;

			const r = await call(`/api/agents/${ctx.agentId}/activate`, { method: 'POST' });
			busy = false;
			if (destroyed) return;

			if (r.ok) {
				const d = r.data || {};
				if (d.pending && !d.signature) {
					status = { ...(status || {}), pending: true, eligible: false };
					render();
					return;
				}
				// Confirmed (fresh grant or already-activated receipt).
				status = {
					...(status || {}),
					activated: true,
					eligible: false,
					pending: false,
					receipt: {
						signature: d.signature,
						explorer: d.explorer,
						sol: d.sol,
						usd: d.usd,
						network: d.network,
						activated_at: d.activated_at || new Date().toISOString(),
					},
				};
				render();
				toast(d.already ? `${agentName} is already live` : `◎${formatSol(d.sol)} SOL granted — ${agentName} is live`);
				return;
			}

			// Designed failure — keep the CTA, surface a recoverable message.
			errorMsg =
				r.code === 'not_configured' || r.code === 'treasury_low'
					? 'Activation is paused right now. You can fund this agent from the Deposit tab instead — that also brings it live.'
					: r.code === 'cap_reached'
						? "Today's activation grants are all claimed. Try again tomorrow, or fund from the Deposit tab now."
						: r.message || 'Activation failed — please try again.';
			render();
		}

		render();

		return {
			onShow() {
				if (!loaded) load();
				else render();
			},
			destroy() {
				destroyed = true;
			},
		};
	},
});
