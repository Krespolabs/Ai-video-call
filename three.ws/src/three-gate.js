// <three-gate feature="forge.high"> — the drop-in $THREE paywall element.
//
// Wrap any premium UI in this element and it renders a designed lock for
// non-holders (what you hold vs. what's required, why it's gated, a working
// "Get $THREE" path) and reveals the real UI — your slotted children — for
// holders. The host page stays declarative:
//
//   <three-gate feature="forge.high">
//     <button class="generate-high">Generate (High)</button>
//   </three-gate>
//
// Attributes:
//   • feature  (required) — a gated feature id (forge.high, worlds.private, …).
//   • mode     (optional) — "overlay" (default): dim + frost the children behind a
//                lock card; "replace": hide the children entirely, show only the
//                card.
//
// Data comes from GET /api/three/access?feature= (via three-tier-pass.js), which
// already returns the tier, required tier, held USD, lock reason, and the
// pay-per-use price. The server stays the only authority — this element only
// renders affordances; it never grants access on its own.
//
// Emits `three-gate:unlocked` (bubbling, composed) when the holder is eligible, so
// the host can enable its control. Re-checks on `three:tier-changed` and
// `wallet:changed`. Reduced-motion aware, fully keyboard-navigable, scoped styles.

import gateStyles from './three-gate.css?inline';
import { getAccess } from './three-tier-pass.js';
import { log } from './shared/log.js';
import { countUp } from './ui-juice.js';

// The one and only coin. Hardcoded (matching src/pump/three-token-data.js) so the
// acquire links work even before any access payload resolves.
const THREE_MINT = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const JUPITER_SWAP_URL = `https://jup.ag/swap/SOL-${THREE_MINT}`;
const ECONOMY_URL = '/three-token';
const SIGN_IN_URL = '/login'; // matches src/three-lock.js

const LOCK_GLYPH =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	'<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/></svg>';

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

// Compact USD: integers for ≥ $1, fixed two decimals for sub-dollar amounts
// (so a $0.50 pay-per-use reads as currency, not "$0.5"), "$0" floor.
function fmtUsd(n) {
	const v = Number(n) || 0;
	if (v <= 0) return '$0';
	if (v < 1) {
		return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	}
	return `$${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

// Tier tone, mirroring three-lock.js / nav-tier-badge so the gate reads as one system.
function tierTone(id) {
	if (id === 'gold' || id === 'genesis') return 'tg-gold';
	if (id === 'silver') return 'tg-silver';
	return 'tg-green';
}

// Open the in-page Jupiter swap when a Solana wallet is present; otherwise fall
// back to the canonical Jupiter swap URL in a new tab. Mirrors the buy flow in
// src/three-token-page.js so "Get $THREE" behaves consistently across the site.
async function acquireThree() {
	const provider =
		(typeof window !== 'undefined' && (window.solana || window.phantom?.solana)) || null;
	if (provider && (provider.isPhantom || provider.isThreeWs)) {
		try {
			const resp = provider.publicKey
				? { publicKey: provider.publicKey }
				: await provider.connect();
			const wallet = resp?.publicKey?.toString?.();
			if (wallet) {
				const mod = await import('./swap-jupiter.js').catch(() => null);
				if (mod && typeof mod.openSwapModal === 'function') {
					mod.openSwapModal({
						wallet,
						getProvider: () => provider,
						defaultInputMint: SOL_MINT,
						defaultOutputMint: THREE_MINT,
					});
					return;
				}
			}
		} catch {
			/* fall through to the hosted swap URL */
		}
	}
	window.open(JUPITER_SWAP_URL, '_blank', 'noopener');
}

// Run the same connect flow the nav button uses, without coupling to it: prefer the
// programmatic export, else click an on-page connect button if one exists.
async function connectWallet() {
	try {
		const mod = await import('./wallet.js').catch(() => null);
		if (mod && typeof mod.connectWallet === 'function') {
			await mod.connectWallet();
			return;
		}
	} catch {
		/* fall through */
	}
	document.getElementById('connect-wallet-btn')?.click();
}

class ThreeGate extends HTMLElement {
	static get observedAttributes() {
		return ['feature', 'mode'];
	}

	constructor() {
		super();
		this._root = this.attachShadow({ mode: 'open' });
		this._reqToken = 0; // guards against a stale fetch resolving after a newer one
		this._gatedChildren = []; // light-DOM children we marked inert while locked
		this._onExternalChange = this._onExternalChange.bind(this);
		this._scheduled = false;
		this._root.innerHTML = `<style>${gateStyles}</style>
			<div class="tg-root" data-state="loading" data-mode="overlay">
				<div class="tg-content"><slot></slot></div>
				<div class="tg-veil"><div class="tg-veil-inner"></div></div>
			</div>`;
		this._rootEl = this._root.querySelector('.tg-root');
		this._veil = this._root.querySelector('.tg-veil-inner');
	}

	connectedCallback() {
		this._rootEl.dataset.mode = this._mode();
		this._renderLoading();
		this.refresh();
		window.addEventListener('three:tier-changed', this._onExternalChange);
		window.addEventListener('wallet:changed', this._onExternalChange);
	}

	disconnectedCallback() {
		window.removeEventListener('three:tier-changed', this._onExternalChange);
		window.removeEventListener('wallet:changed', this._onExternalChange);
		this._setGatedInert(false);
	}

	attributeChangedCallback(name, oldVal, newVal) {
		if (oldVal === newVal || !this.isConnected) return;
		if (name === 'mode') this._rootEl.dataset.mode = this._mode();
		this.refresh();
	}

	_mode() {
		return this.getAttribute('mode') === 'replace' ? 'replace' : 'overlay';
	}

	// `three:tier-changed` is dispatched off `wallet:changed`, so both can fire for a
	// single connect — coalesce into one refresh on the next frame.
	_onExternalChange() {
		if (this._scheduled) return;
		this._scheduled = true;
		const run = () => {
			this._scheduled = false;
			if (this.isConnected) this.refresh();
		};
		if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
		else setTimeout(run, 0);
	}

	/** Re-read access and render the matching state. Safe to call repeatedly. */
	async refresh() {
		const feature = (this.getAttribute('feature') || '').trim();
		if (!feature) {
			// A gate with no feature can't be evaluated — fail closed (never reveal the
			// premium UI) and surface the misconfiguration to the developer.
			log.warn('[three-gate] missing required "feature" attribute — staying locked.');
			this._renderError(false);
			return;
		}

		const token = ++this._reqToken;
		this._renderLoading();
		const data = await getAccess(feature);
		if (token !== this._reqToken || !this.isConnected) return; // superseded

		const access = data?.access;
		if (data?._error || !access) {
			this._renderError(true);
			return;
		}
		if (access.eligible) {
			this._renderUnlocked(data.tier || access.held);
			return;
		}
		this._renderLocked(access);
	}

	// ── State renderers ──────────────────────────────────────────────────────

	_renderLoading() {
		this._setGatedInert(true);
		this._rootEl.dataset.state = 'loading';
		this._veil.innerHTML =
			`<div class="tg-card tg-card--skel" aria-hidden="true">` +
			`<span class="tg-skel tg-skel--glyph"></span>` +
			`<span class="tg-skel-lines"><span class="tg-skel tg-skel--l1"></span>` +
			`<span class="tg-skel tg-skel--l2"></span><span class="tg-skel tg-skel--l3"></span></span>` +
			`</div>` +
			`<span class="tg-sr" role="status">Checking your $THREE access…</span>`;
	}

	_renderError(retryable) {
		this._setGatedInert(true);
		this._rootEl.dataset.state = 'error';
		this._veil.innerHTML =
			`<div class="tg-card tg-card--err" role="alert">` +
			`<span class="tg-err-ico" aria-hidden="true">!</span>` +
			`<div class="tg-err-body">` +
			`<p class="tg-err-text">Couldn’t check your $THREE access.</p>` +
			(retryable
				? `<button type="button" class="tg-btn tg-btn--ghost tg-btn--sm" data-tg-retry>Retry</button>`
				: '') +
			`</div></div>`;
		const retry = this._veil.querySelector('[data-tg-retry]');
		if (retry) retry.addEventListener('click', () => this.refresh());
	}

	_renderUnlocked(tier) {
		this._setGatedInert(false);
		this._rootEl.dataset.state = 'unlocked';
		this._veil.innerHTML = '';
		this.dispatchEvent(
			new CustomEvent('three-gate:unlocked', {
				bubbles: true,
				composed: true,
				detail: { feature: this.getAttribute('feature'), tier: tier || null },
			}),
		);
	}

	_renderLocked(access) {
		this._setGatedInert(true);
		this._rootEl.dataset.state = 'locked';

		const required = access.required || { label: 'a higher tier', id: '', min_usd: 0 };
		const held = access.held || { label: 'Member', id: 'member', usd: 0 };
		const reason = access.reason || 'insufficient_tier';
		const tone = tierTone(required.id);
		const heldUsd = Number(held.usd) || 0;
		const reqMin = Number(required.min_usd) || 0;
		const pct =
			reqMin > 0 ? Math.max(0, Math.min(100, Math.round((heldUsd / reqMin) * 100))) : 100;
		const pay =
			access.pay_per_use && access.pay_per_use.usd != null ? access.pay_per_use : null;

		const secondary =
			reason === 'sign_in'
				? `<a class="tg-btn tg-btn--ghost" href="${SIGN_IN_URL}">Sign in</a>`
				: reason === 'link_wallet'
					? `<button type="button" class="tg-btn tg-btn--ghost" data-tg-connect>Connect wallet</button>`
					: `<span class="tg-hold-hint">Hold to unlock — your tier is read live from your wallet.</span>`;

		this._veil.innerHTML =
			`<div class="tg-card ${tone}" role="group" aria-label="Locked — requires ${escapeHtml(required.label)} ($THREE holder)">` +
			`<div class="tg-card-head">` +
			`<span class="tg-glyph">${LOCK_GLYPH}</span>` +
			`<div class="tg-card-titles">` +
			`<p class="tg-eyebrow">$THREE holder perk</p>` +
			`<h3 class="tg-label">${escapeHtml(access.label || 'Holder feature')}</h3>` +
			`</div></div>` +
			(access.why ? `<p class="tg-why">${escapeHtml(access.why)}</p>` : '') +
			`<div class="tg-meta">` +
			`<div class="tg-meta-col"><span class="tg-meta-k">You hold</span>` +
			`<span class="tg-meta-v">${fmtUsd(heldUsd)} · ${escapeHtml(held.label || 'Member')}</span></div>` +
			`<span class="tg-meta-arrow" aria-hidden="true">→</span>` +
			`<div class="tg-meta-col tg-meta-col--req"><span class="tg-meta-k">Requires</span>` +
			`<span class="tg-meta-v">${escapeHtml(required.label)} · ${fmtUsd(reqMin)}</span></div>` +
			`</div>` +
			`<div class="tg-prog">` +
			`<span class="tg-prog-track"><span class="tg-prog-fill tg-prog-fill--grow" style="width:${pct}%"></span></span>` +
			`<span class="tg-prog-cap"><span class="tg-prog-cap-n">${pct}</span>% there</span>` +
			`</div>` +
			`<div class="tg-actions">` +
			`<a class="tg-btn tg-btn--primary" data-tg-get href="${JUPITER_SWAP_URL}" target="_blank" rel="noopener">Get $THREE</a>` +
			secondary +
			`</div>` +
			(pay
				? `<p class="tg-pay">or pay <strong>${fmtUsd(pay.usd)}</strong> per use</p>`
				: '') +
			`<a class="tg-perks" href="${ECONOMY_URL}">Get $THREE →</a>` +
			`</div>`;

		this._wireLocked();

		// Count the "% there" cap up to the live percentage. The bar itself is
		// rendered at its real width (so the static state is correct and assertable)
		// and grows in with the scoped scaleX sweep; countUp lands on the same real
		// number and respects reduced motion via its instant-final path.
		const capN = this._veil.querySelector('.tg-prog-cap-n');
		if (capN) countUp(capN, 0, pct, { format: (n) => String(Math.round(n)) });
	}

	_wireLocked() {
		const get = this._veil.querySelector('[data-tg-get]');
		if (get) {
			get.addEventListener('click', (e) => {
				e.preventDefault();
				acquireThree();
			});
		}
		const connect = this._veil.querySelector('[data-tg-connect]');
		if (connect) connect.addEventListener('click', () => connectWallet());
	}

	// Block keyboard/AT interaction with the gated children while locked. `inert`
	// removes them from the tab order and the accessibility tree; we only touch the
	// children we set so re-entrancy can't strand a child as permanently inert.
	_setGatedInert(on) {
		if (on) {
			for (const child of Array.from(this.children)) {
				if (child.nodeType !== 1) continue;
				child.inert = true;
				if (!this._gatedChildren.includes(child)) this._gatedChildren.push(child);
			}
		} else {
			for (const child of this._gatedChildren) {
				try {
					child.inert = false;
				} catch {
					/* child detached — nothing to clear */
				}
			}
			this._gatedChildren = [];
		}
	}
}

if (typeof customElements !== 'undefined' && !customElements.get('three-gate')) {
	customElements.define('three-gate', ThreeGate);
}

export { ThreeGate };
