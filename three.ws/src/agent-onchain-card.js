/**
 * Agent On-Chain Card — owner-only profile control.
 * -------------------------------------------------
 * Surfaces the "Register on-chain" action on an existing agent's profile and
 * renders every state of its ERC-8004 binding: not-registered (CTA), pending
 * (tx in flight, live log), registered (badge + network + agent id + explorer /
 * card links), and error (actionable + retry).
 *
 * Binding reuses the agent's stored body, persona, voice, and skills — no
 * re-entry — via bindExistingAgentOnchain(). The flow is idempotent: if the
 * agent is already bound on the chosen chain, it shows the existing identity
 * instead of minting a second token.
 *
 * Mounted from src/agent-home.js alongside the other owner cards.
 */

import {
	getOnchainStatus,
	onchainBadgeHTML,
	ensureOnchainBadgeStyles,
} from './shared/onchain-badge.js';
import {
	CHAIN_META,
	DEFAULT_CHAIN_ID,
	supportedChainIdsGrouped,
} from './erc8004/chain-meta.js';
import { resolveURI } from './ipfs.js';

const STYLE_ID = 'agent-onchain-card-styles';

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

/** A minimal agent-record shape the badge + status helpers understand. */
function statusShape(identity) {
	const meta = identity.meta || {};
	return {
		onchain: meta.onchain || null,
		meta,
		is_registered: identity.isRegistered,
		erc8004_agent_id: meta.onchain?.onchain_id || null,
	};
}

/**
 * @param {{ panel: HTMLElement, identity: import('./agent-identity.js').AgentIdentity }} opts
 * @returns {{ destroy: () => void } | null}
 */
export function mountAgentOnchainCard({ panel, identity }) {
	if (!panel || !identity?.id) return null;
	ensureOnchainBadgeStyles();
	ensureStyles();

	const section = document.createElement('section');
	section.className = 'agent-onchain-card';
	section.setAttribute('aria-label', 'On-chain identity');

	// Place it directly above the permissions panel (or before the memory bar).
	const anchor =
		panel.querySelector('#agent-permissions-container') ||
		panel.querySelector('#agent-memory-bar');
	if (anchor) panel.insertBefore(section, anchor);
	else panel.appendChild(section);

	let busy = false;

	function render() {
		const status = getOnchainStatus(statusShape(identity));
		section.innerHTML = status ? registeredHTML(status) : ctaHTML();
		wire(status);
	}

	function ctaHTML() {
		const { mainnets, testnets } = supportedChainIdsGrouped();
		const opt = (id) =>
			`<option value="${id}"${id === DEFAULT_CHAIN_ID ? ' selected' : ''}>${esc(CHAIN_META[id].name)}</option>`;
		return `
			<div class="aoc-head">
				<span class="aoc-title">On-chain identity</span>
				<span class="aoc-tag">Not registered</span>
			</div>
			<p class="aoc-sub">Mint an ERC-8004 identity for this agent. Reuses its 3D model, persona, voice, and skills, and pins a full agent manifest so it stays portable across the open web.</p>
			<div class="aoc-controls">
				<label class="aoc-field">
					<span class="aoc-field-label">Network</span>
					<select class="aoc-chain-select" aria-label="Target network">
						<optgroup label="Mainnet">${mainnets.map(opt).join('')}</optgroup>
						<optgroup label="Testnet">${testnets.map(opt).join('')}</optgroup>
					</select>
				</label>
				<button type="button" class="aoc-btn aoc-register">
					<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5l-8-3zm-1.2 14.2L7 12.4l1.4-1.4 2.4 2.4 4.8-4.8L17 10l-6.2 6.2z"/></svg>
					<span>Register on-chain</span>
				</button>
			</div>
			<div class="aoc-log" role="status" aria-live="polite" hidden></div>
			<div class="aoc-error" role="alert" hidden></div>
		`;
	}

	function registeredHTML(status) {
		const badge = onchainBadgeHTML(statusShape(identity), { size: 'md', label: 'On-chain' });
		const onchain = identity.meta?.onchain || {};
		const cardUri = onchain.metadata_uri ? resolveURI(onchain.metadata_uri) : null;
		const agentIdLabel = onchain.onchain_id ? `#${onchain.onchain_id}` : status.registry || '—';
		return `
			<div class="aoc-head">
				<span class="aoc-title">On-chain identity</span>
				${badge}
			</div>
			<dl class="aoc-meta">
				<div class="aoc-meta-row"><dt>Network</dt><dd>${esc(status.chainLabel)}</dd></div>
				<div class="aoc-meta-row"><dt>Agent ID</dt><dd>${esc(agentIdLabel)}</dd></div>
			</dl>
			<div class="aoc-links">
				${
					status.explorerUrl
						? `<a class="aoc-link" href="${esc(status.explorerUrl)}" target="_blank" rel="noopener noreferrer">View on explorer ↗</a>`
						: ''
				}
				${
					status.txExplorerUrl
						? `<a class="aoc-link" href="${esc(status.txExplorerUrl)}" target="_blank" rel="noopener noreferrer">View transaction ↗</a>`
						: ''
				}
				${
					cardUri
						? `<a class="aoc-link" href="${esc(cardUri)}" target="_blank" rel="noopener noreferrer">View agent card ↗</a>`
						: ''
				}
			</div>
		`;
	}

	function wire(status) {
		if (status) return; // registered state has no interactive controls beyond links

		const btn = section.querySelector('.aoc-register');
		const select = section.querySelector('.aoc-chain-select');
		const logEl = section.querySelector('.aoc-log');
		const errEl = section.querySelector('.aoc-error');

		const appendLog = (msg) => {
			logEl.hidden = false;
			const line = document.createElement('div');
			line.className = 'aoc-log-line';
			line.textContent = msg;
			logEl.appendChild(line);
			logEl.scrollTop = logEl.scrollHeight;
		};

		btn?.addEventListener('click', async () => {
			if (busy) return;
			busy = true;
			const chainId = Number(select.value) || DEFAULT_CHAIN_ID;
			errEl.hidden = true;
			errEl.textContent = '';
			logEl.innerHTML = '';
			logEl.hidden = false;
			btn.disabled = true;
			select.disabled = true;
			btn.classList.add('is-busy');
			btn.querySelector('span').textContent = 'Registering…';

			try {
				const { bindExistingAgentOnchain } = await import('./erc8004/agent-registry.js');
				const result = await bindExistingAgentOnchain(identity.id, chainId, {
					onStatus: appendLog,
				});

				// Reflect the new identity locally so the badge + state update without
				// a reload (and persist for the next mount).
				if (result.onchain && identity._record) {
					identity._record.meta = { ...(identity._record.meta || {}), onchain: result.onchain };
					identity._record.isRegistered = true;
					identity._persist?.();
				}
				injectNameBadge();
				render();
			} catch (err) {
				errEl.hidden = false;
				errEl.textContent = friendlyError(err);
				btn.disabled = false;
				select.disabled = false;
				btn.classList.remove('is-busy');
				btn.querySelector('span').textContent = 'Try again';
			} finally {
				busy = false;
			}
		});
	}

	// If the name-row badge isn't already present (it keys on the agent record at
	// first paint), inject it now that the agent is on-chain.
	function injectNameBadge() {
		const nameRow = panel.querySelector('.agent-home-name-row');
		if (!nameRow || nameRow.querySelector('.agent-home-badge, .tws-ocb')) return;
		const badge = onchainBadgeHTML(statusShape(identity), { size: 'sm', showChain: false });
		if (!badge) return;
		const tpl = document.createElement('template');
		tpl.innerHTML = badge.trim();
		const node = tpl.content.firstElementChild;
		if (node) nameRow.appendChild(node);
	}

	render();

	return {
		destroy() {
			section.remove();
		},
	};
}

function friendlyError(err) {
	const m = String(err?.message || err || 'Registration failed.');
	if (/user rejected|denied|rejected the request/i.test(m)) {
		return 'You cancelled the wallet request. Click "Try again" when ready.';
	}
	if (/no wallet detected/i.test(m)) {
		return 'No wallet detected. Install a wallet extension (MetaMask, Coinbase Wallet) and try again.';
	}
	if (/insufficient funds/i.test(m)) {
		return 'Insufficient funds for gas on the target network. Top up and try again.';
	}
	return m;
}

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const style = document.createElement('style');
	style.id = STYLE_ID;
	style.textContent = `
.agent-onchain-card{margin:12px 0;padding:14px;border:1px solid var(--border,rgba(255,255,255,.1));
	border-radius:12px;background:var(--surface-2,rgba(255,255,255,.03));}
.aoc-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;}
.aoc-title{font:600 12px/1.2 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;
	text-transform:uppercase;opacity:.7;}
.aoc-tag{font:500 10px/1 ui-sans-serif,system-ui,sans-serif;padding:3px 8px;border-radius:999px;
	color:var(--muted,#9aa);background:rgba(148,163,184,.14);border:1px solid rgba(148,163,184,.28);}
.aoc-sub{margin:0 0 12px;font:400 12.5px/1.5 ui-sans-serif,system-ui,sans-serif;opacity:.75;}
.aoc-controls{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;}
.aoc-field{display:flex;flex-direction:column;gap:4px;flex:1 1 140px;min-width:0;}
.aoc-field-label{font:500 10.5px/1 ui-sans-serif,system-ui,sans-serif;opacity:.6;
	text-transform:uppercase;letter-spacing:.04em;}
.aoc-chain-select{appearance:none;width:100%;padding:8px 10px;border-radius:8px;
	border:1px solid var(--border,rgba(255,255,255,.14));background:var(--surface,rgba(0,0,0,.25));
	color:inherit;font:500 13px/1 ui-sans-serif,system-ui,sans-serif;cursor:pointer;}
.aoc-chain-select:focus-visible{outline:2px solid #34d399;outline-offset:1px;}
.aoc-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 14px;border-radius:8px;border:0;
	cursor:pointer;font:600 13px/1 ui-sans-serif,system-ui,sans-serif;color:#04130d;
	background:linear-gradient(180deg,#5ee9b5,#2bb98a);box-shadow:0 1px 0 rgba(255,255,255,.25) inset;
	transition:transform .12s ease,filter .12s ease,opacity .12s ease;}
.aoc-btn:hover{filter:brightness(1.06);transform:translateY(-1px);}
.aoc-btn:active{transform:translateY(0);}
.aoc-btn:focus-visible{outline:2px solid #34d399;outline-offset:2px;}
.aoc-btn:disabled{cursor:default;opacity:.7;transform:none;filter:none;}
.aoc-btn.is-busy svg{animation:aoc-spin .9s linear infinite;}
@keyframes aoc-spin{to{transform:rotate(360deg);}}
@media (prefers-reduced-motion: reduce){.aoc-btn.is-busy svg{animation:none;}}
.aoc-log{margin-top:10px;max-height:140px;overflow:auto;padding:8px 10px;border-radius:8px;
	background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.08);
	font:400 11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.9;}
.aoc-log-line{white-space:pre-wrap;word-break:break-word;}
.aoc-log-line+.aoc-log-line{margin-top:2px;}
.aoc-error{margin-top:10px;padding:9px 11px;border-radius:8px;color:#fca5a5;
	background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.32);
	font:400 12px/1.45 ui-sans-serif,system-ui,sans-serif;}
.aoc-meta{display:flex;gap:18px;margin:0 0 10px;flex-wrap:wrap;}
.aoc-meta-row{display:flex;flex-direction:column;gap:2px;}
.aoc-meta dt{font:500 10px/1 ui-sans-serif,system-ui,sans-serif;opacity:.55;
	text-transform:uppercase;letter-spacing:.04em;}
.aoc-meta dd{margin:0;font:600 13px/1.2 ui-sans-serif,system-ui,sans-serif;}
.aoc-links{display:flex;gap:14px;flex-wrap:wrap;}
.aoc-link{font:500 12px/1 ui-sans-serif,system-ui,sans-serif;color:#5ee9b5;text-decoration:none;}
.aoc-link:hover{text-decoration:underline;}
.aoc-link:focus-visible{outline:2px solid #34d399;outline-offset:2px;border-radius:3px;}
`;
	(document.head || document.documentElement).appendChild(style);
}
