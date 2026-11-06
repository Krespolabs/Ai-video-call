// $THREE lock — the in-place, designed gate that renders over a holder-gated
// control. Sibling to three-access.js: that module owns the data (access matrix,
// tier pass) and the full-screen upsell modal; this one owns the *affordance the
// user sees on the control itself* — a frosted lock panel in every state:
//
//   • loading  — skeleton shimmer while access is being checked.
//   • locked   — frosted overlay + lock glyph, "Requires {tier} — hold $THREE",
//                the held-vs-required progress, and a working Get $THREE CTA
//                (plus reason-specific secondaries: Sign in / Link a wallet /
//                Use a free tier / Pay per use when a handler is supplied).
//   • unlocked — a subtle "✓ Unlocked · {tier}" ribbon, no overlay.
//   • error    — inline, actionable: "Couldn't check access — retry".
//   • cleared  — empty + hidden (the control is ungated).
//
// One entry point: renderLock(target, state). Pass the access payload through
// lockStateFromAccess() to map it to a state, or build the state object by hand.
// Fully keyboard-navigable (real <a>/<button>), ARIA-labelled, reduced-motion
// aware, and responsive. Never throws — a missing target is a no-op.

import { safeUrl } from './safe-url.js';

// Default upgrade destination: the canonical $THREE tier surface (/three), where
// the holder sees the full ladder and the "Hold more $THREE" buy action. Callers
// may override per-control via lockStateFromAccess(access, { getThreeUrl }).
const ECONOMY_URL = '/three';
const SIGN_IN_URL = '/login';
const LINK_WALLET_URL = '/dashboard/account#wallets';

let _stylesInjected = false;

function escapeHtml(s) {
	return String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function resolveEl(target) {
	return typeof target === 'string' ? document.querySelector(target) : target;
}

// Tone class by tier id, mirroring three-access.js so the lock, the badge, and
// the upsell modal read as one system (gold for the top tiers, silver, else green).
function tierTone(id) {
	if (id === 'gold' || id === 'genesis') return 'tl-gold';
	if (id === 'silver') return 'tl-silver';
	return 'tl-green';
}

function usdLabel(usd) {
	const n = Number(usd) || 0;
	if (n <= 0) return '';
	return `≈ $${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

const LOCK_GLYPH =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
	'<rect x="4.5" y="10.5" width="15" height="10" rx="2.2"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><circle cx="12" cy="15.5" r="1.4" fill="currentColor" stroke="none"/></svg>';

/**
 * Map a single-feature access payload (the `.access` object from
 * getAccess(feature)) to a renderLock state. `extra` is merged in so callers can
 * attach handlers/urls (onGetThree, onPayPerUse, onUseFree, getThreeUrl). A null
 * access (network failure) maps to the error state so the UI degrades safely.
 */
export function lockStateFromAccess(access, extra = {}) {
	if (!access) return { error: true, ...extra };
	if (access.eligible) return { eligible: true, tier: access.held, ...extra };
	const pay = access.pay_per_use && access.pay_per_use.usd != null ? access.pay_per_use : null;
	return {
		feature: access.feature,
		label: access.label,
		why: access.why,
		required: access.required,
		held: access.held,
		reason: access.reason,
		payPerUse: pay,
		...extra,
	};
}

/**
 * Render the lock for a gated control into `target`.
 * @param {Element|string} target
 * @param {object} state  one of:
 *   { clear:true }                                   → empty + hidden
 *   { loading:true }                                 → skeleton shimmer
 *   { error:true, onRetry? }                         → inline retry
 *   { eligible:true, tier:{id,label} }               → unlocked ribbon
 *   { required, held, reason, payPerUse?, label?, why?,
 *     getThreeUrl?, onGetThree?, onPayPerUse?, onUseFree?, useFreeLabel? } → locked
 */
export function renderLock(target, state = {}) {
	const el = resolveEl(target);
	if (!el) return;
	injectStyles();
	el.classList.add('tl-host');

	if (!state || state.clear) {
		el.hidden = true;
		el.innerHTML = '';
		return;
	}
	el.hidden = false;

	if (state.loading) {
		el.innerHTML = renderLoading();
		return;
	}
	if (state.error) {
		el.innerHTML = renderError();
		const retry = el.querySelector('[data-tl-retry]');
		if (retry && typeof state.onRetry === 'function') {
			retry.addEventListener('click', () => state.onRetry());
		} else if (retry) {
			retry.remove();
		}
		return;
	}
	if (state.eligible) {
		el.innerHTML = renderUnlocked(state.tier || {});
		return;
	}

	el.innerHTML = renderLocked(state);
	wireLocked(el, state);
}

// ── State renderers ─────────────────────────────────────────────────────────

function renderLoading() {
	return (
		`<div class="tl-card tl-card--skel" aria-hidden="true">` +
		`<span class="tl-skel tl-skel--glyph"></span>` +
		`<span class="tl-skel-lines"><span class="tl-skel tl-skel--l1"></span><span class="tl-skel tl-skel--l2"></span></span>` +
		`</div>` +
		`<span class="tl-sr" role="status">Checking your $THREE access…</span>`
	);
}

function renderError() {
	return (
		`<div class="tl-card tl-card--err" role="alert">` +
		`<span class="tl-err-ico" aria-hidden="true">!</span>` +
		`<span class="tl-err-text">Couldn’t check access.</span>` +
		`<button type="button" class="tl-btn tl-btn--ghost tl-btn--sm" data-tl-retry>Retry</button>` +
		`</div>`
	);
}

function renderUnlocked(tier) {
	const tone = tierTone(tier.id);
	const label = escapeHtml(tier.label || 'Holder');
	return (
		`<div class="tl-ribbon ${tone}" role="status">` +
		`<span class="tl-ribbon-ico" aria-hidden="true">✓</span>` +
		`<span>Unlocked · <strong>${label}</strong></span>` +
		`</div>`
	);
}

function renderLocked(state) {
	const required = state.required || { label: 'a higher tier', id: '' };
	const held = state.held || { label: 'Member', level: 0 };
	const reason = state.reason || 'insufficient_tier';
	const tone = tierTone(required.id);
	const getUrl = escapeHtml(safeUrl(state.getThreeUrl || ECONOMY_URL));

	const sub =
		reason === 'sign_in'
			? 'Sign in to check your tier.'
			: reason === 'link_wallet'
				? 'Link a Solana wallet so we can read your $THREE.'
				: heldLine(held);

	const progress = reason === 'insufficient_tier' ? renderProgress(held, required) : '';

	const actions = [
		`<a class="tl-btn tl-btn--primary" data-tl-get href="${getUrl}">Get $THREE</a>`,
	];
	if (reason === 'sign_in') {
		actions.push(`<a class="tl-btn tl-btn--ghost" href="${SIGN_IN_URL}">Sign in</a>`);
	} else if (reason === 'link_wallet') {
		actions.push(`<a class="tl-btn tl-btn--ghost" href="${LINK_WALLET_URL}">Link a wallet</a>`);
	}
	// Pay-per-use is only offered when the caller wires a working handler — a
	// button that does nothing is worse than no button.
	if (state.payPerUse && typeof state.onPayPerUse === 'function') {
		actions.push(
			`<button type="button" class="tl-btn tl-btn--ghost" data-tl-pay>Pay $${Number(state.payPerUse.usd).toFixed(2)} per generation</button>`,
		);
	}
	if (typeof state.onUseFree === 'function') {
		actions.push(
			`<button type="button" class="tl-btn tl-btn--quiet" data-tl-free>${escapeHtml(state.useFreeLabel || 'Use a free tier')}</button>`,
		);
	}

	const feature = escapeHtml(state.label || 'This is a $THREE holder feature.');

	return (
		`<div class="tl-card tl-card--lock ${tone}" role="group" aria-label="Locked — requires ${escapeHtml(required.label)} ($THREE holder)">` +
		`<span class="tl-glyph" aria-hidden="true">${LOCK_GLYPH}</span>` +
		`<div class="tl-body">` +
		`<p class="tl-headline">Requires <strong>${escapeHtml(required.label)}</strong> — hold $THREE</p>` +
		`<p class="tl-sub">${sub}</p>` +
		(state.why ? `<p class="tl-why">${escapeHtml(state.why)}</p>` : '') +
		progress +
		`<div class="tl-actions">${actions.join('')}</div>` +
		`<p class="tl-foot">${feature}</p>` +
		`</div>` +
		`</div>`
	);
}

function heldLine(held) {
	const usd = usdLabel(held.usd);
	return `You hold <strong>${escapeHtml(held.label || 'Member')}</strong>${usd ? ` (${usd})` : ''}.`;
}

// A small held→required tier-ladder track. Honest with the data we have (tier
// levels, not exact thresholds): the fill is the held level as a fraction of the
// required level, so a Silver holder facing a Gold gate reads as two-thirds there.
function renderProgress(held, required) {
	const reqLevel = Math.max(1, Number(required.level) || 1);
	const heldLevel = Math.max(0, Number(held.level) || 0);
	const pct = Math.min(100, Math.round((heldLevel / reqLevel) * 100));
	return (
		`<div class="tl-prog" role="presentation">` +
		`<span class="tl-prog-track"><span class="tl-prog-fill" style="width:${pct}%"></span></span>` +
		`<span class="tl-prog-cap">${escapeHtml(held.label || 'Member')} → <strong>${escapeHtml(required.label)}</strong></span>` +
		`</div>`
	);
}

function wireLocked(el, state) {
	const get = el.querySelector('[data-tl-get]');
	if (get && typeof state.onGetThree === 'function') {
		get.addEventListener('click', (e) => {
			e.preventDefault();
			state.onGetThree();
		});
	}
	const pay = el.querySelector('[data-tl-pay]');
	if (pay && typeof state.onPayPerUse === 'function') {
		pay.addEventListener('click', () => state.onPayPerUse(state.payPerUse));
	}
	const free = el.querySelector('[data-tl-free]');
	if (free && typeof state.onUseFree === 'function') {
		free.addEventListener('click', () => state.onUseFree());
	}
}

// ── Styles ───────────────────────────────────────────────────────────────────

function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const css = `
	.tl-host{display:block;margin:10px 0 2px;font-family:Inter,system-ui,sans-serif;}
	.tl-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;
		clip:rect(0 0 0 0);white-space:nowrap;border:0;}

	/* Frosted lock panel */
	.tl-card{position:relative;display:flex;gap:13px;align-items:flex-start;
		border-radius:16px;padding:15px 16px;overflow:hidden;
		background:linear-gradient(180deg,rgba(20,20,27,.92),rgba(12,12,17,.92));
		border:1px solid #23232c;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
		box-shadow:0 14px 40px -22px rgba(0,0,0,.85);
		animation:tl-rise .26s cubic-bezier(.22,1,.36,1);}
	.tl-card--lock.tl-green{border-color:rgba(110,231,168,.28);}
	.tl-card--lock.tl-silver{border-color:rgba(207,214,228,.28);}
	.tl-card--lock.tl-gold{border-color:rgba(245,196,81,.30);}

	.tl-glyph{flex-shrink:0;width:38px;height:38px;border-radius:11px;display:inline-flex;
		align-items:center;justify-content:center;color:#6ee7a8;
		background:rgba(110,231,168,.1);border:1px solid rgba(110,231,168,.22);}
	.tl-glyph svg{width:19px;height:19px;}
	.tl-silver .tl-glyph{color:#cfd6e4;background:rgba(207,214,228,.1);border-color:rgba(207,214,228,.22);}
	.tl-gold .tl-glyph{color:#f5c451;background:rgba(245,196,81,.1);border-color:rgba(245,196,81,.24);}

	.tl-body{min-width:0;flex:1;}
	.tl-headline{margin:0 0 3px;font-size:13.5px;font-weight:700;color:#f6f6f8;line-height:1.35;}
	.tl-headline strong{color:#6ee7a8;}
	.tl-silver .tl-headline strong{color:#dfe5ef;}
	.tl-gold .tl-headline strong{color:#f5c451;}
	.tl-sub{margin:0 0 6px;font-size:12.5px;color:#a6a6b0;line-height:1.5;}
	.tl-sub strong{color:#e9e9ee;}
	.tl-why{margin:0 0 9px;font-size:11.5px;color:#7c7c86;font-style:italic;line-height:1.5;}

	.tl-prog{display:flex;align-items:center;gap:9px;margin:0 0 12px;}
	.tl-prog-track{flex:1;height:6px;border-radius:999px;background:rgba(255,255,255,.07);overflow:hidden;}
	.tl-prog-fill{display:block;height:100%;border-radius:999px;
		background:linear-gradient(90deg,#6ee7a8,#9bf0c4);transition:width .4s cubic-bezier(.22,1,.36,1);}
	.tl-silver .tl-prog-fill{background:linear-gradient(90deg,#cfd6e4,#eef2f8);}
	.tl-gold .tl-prog-fill{background:linear-gradient(90deg,#f5c451,#ffd980);}
	.tl-prog-cap{flex-shrink:0;font-size:11px;color:#8c8c96;white-space:nowrap;}
	.tl-prog-cap strong{color:#cfcfd6;}

	.tl-actions{display:flex;flex-wrap:wrap;gap:8px;}
	.tl-btn{display:inline-flex;align-items:center;justify-content:center;font:700 12.5px/1 Inter,system-ui,sans-serif;
		padding:9px 14px;border-radius:10px;text-decoration:none;cursor:pointer;border:1px solid #2a2a33;
		background:#13131a;color:#f1f1f4;transition:transform .15s cubic-bezier(.22,1,.36,1),
		background .15s ease,border-color .15s ease;}
	.tl-btn--sm{padding:7px 11px;font-size:12px;}
	.tl-btn--primary{background:#6ee7a8;color:#06120c;border-color:#6ee7a8;}
	.tl-btn--primary:hover{background:#8af0c0;transform:translateY(-1px);}
	.tl-silver .tl-btn--primary{background:#dfe5ef;color:#10131a;border-color:#dfe5ef;}
	.tl-silver .tl-btn--primary:hover{background:#eef2f8;}
	.tl-gold .tl-btn--primary{background:#f5c451;color:#1a1303;border-color:#f5c451;}
	.tl-gold .tl-btn--primary:hover{background:#ffd980;}
	.tl-btn--ghost:hover{border-color:#3a3a44;background:#181820;transform:translateY(-1px);}
	.tl-btn--quiet{background:transparent;border-color:transparent;color:#9a9aa4;padding-left:8px;padding-right:8px;}
	.tl-btn--quiet:hover{color:#e9e9ee;background:rgba(255,255,255,.04);}
	.tl-foot{margin:11px 0 0;font-size:11px;color:#6c6c76;line-height:1.5;}

	/* Unlocked ribbon */
	.tl-ribbon{display:inline-flex;align-items:center;gap:7px;font:700 12.5px/1 Inter,system-ui,sans-serif;
		padding:8px 13px;border-radius:999px;color:#6ee7a8;
		background:rgba(110,231,168,.1);border:1px solid rgba(110,231,168,.26);
		animation:tl-rise .26s cubic-bezier(.22,1,.36,1);}
	.tl-ribbon strong{font-weight:800;}
	.tl-ribbon-ico{font-size:11px;}
	.tl-ribbon.tl-silver{color:#dfe5ef;background:rgba(207,214,228,.1);border-color:rgba(207,214,228,.26);}
	.tl-ribbon.tl-gold{color:#f5c451;background:rgba(245,196,81,.11);border-color:rgba(245,196,81,.28);}

	/* Error */
	.tl-card--err{align-items:center;gap:10px;border-color:#3a2222;
		background:linear-gradient(180deg,rgba(34,18,18,.92),rgba(22,12,12,.92));}
	.tl-err-ico{flex-shrink:0;width:22px;height:22px;border-radius:50%;display:inline-flex;
		align-items:center;justify-content:center;font-weight:800;font-size:13px;
		color:#ff9b9b;background:rgba(255,120,120,.12);border:1px solid rgba(255,120,120,.3);}
	.tl-err-text{flex:1;font-size:12.5px;color:#f0c2c2;}

	/* Loading skeleton */
	.tl-card--skel{gap:13px;align-items:center;}
	.tl-skel{display:block;border-radius:9px;
		background:linear-gradient(90deg,#15151b,#20202a,#15151b);background-size:200% 100%;
		animation:tl-sh 1.3s infinite;}
	.tl-skel--glyph{width:38px;height:38px;flex-shrink:0;border-radius:11px;}
	.tl-skel-lines{flex:1;display:flex;flex-direction:column;gap:7px;}
	.tl-skel--l1{height:11px;width:72%;}
	.tl-skel--l2{height:11px;width:46%;}

	.tl-btn:focus-visible,.tl-ribbon:focus-visible{outline:2px solid #6ee7a8;outline-offset:2px;}

	@keyframes tl-sh{0%{background-position:200% 0}100%{background-position:-200% 0}}
	@keyframes tl-rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}

	@media (max-width:480px){
		.tl-card{flex-direction:column;}
		.tl-actions{width:100%;}
		.tl-btn{flex:1;}
		.tl-prog-cap{white-space:normal;}
	}
	@media (prefers-reduced-motion: reduce){
		.tl-card,.tl-ribbon{animation:none;}
		.tl-skel{animation:none;}
		.tl-prog-fill,.tl-btn{transition:none;}
	}`;
	const el = document.createElement('style');
	el.id = 'tl-styles';
	el.textContent = css;
	document.head.appendChild(el);
}
