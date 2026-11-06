// The $THREE access gate — the modal src/three/access.js opens when a caller is not
// yet entitled to a gated feature. It is honest and actionable: it shows what the
// user holds vs. what the feature needs, gives a real path to fix it (sign in, link a
// wallet, or get $THREE), and lets them Recheck in place so acquiring access proceeds
// the original action without a reload.
//
// Contract with access.js:
//   openGateModal({ feature, trigger, snapshot, recheck }) → Promise<
//       { ok:true, pass:string|null } | { ok:false, reason:string }>
//   • snapshot — the single-feature /api/three/access payload that failed the gate.
//   • recheck  — async () => the same attempt() result access.js uses internally:
//                { ok:true, pass } when newly eligible, or { ok:false, reason, snapshot }.
//   • trigger  — the element that opened the gate; focus returns to it on close.
//
// Resolves { ok:true, pass } when a Recheck lands the user in eligibility, else
// { ok:false, reason } on cancel. The server stays the authority — this only shapes
// the path back to eligibility, it never grants it.

const ECONOMY_URL = '/three-token'; // the $THREE token page — live price, chart & one-click buy

let _active = null; // the single live instance: { overlay, resolve, restoreFocus, onKey }
let _stylesInjected = false;

const esc = (s) =>
	String(s ?? '').replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);

const fmtUsd = (n) => {
	const v = Number(n);
	if (!Number.isFinite(v) || v <= 0) return '';
	return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v < 1 ? 2 : 0 });
};

// Reason → the user-facing framing of why they're locked + which action leads out.
// `held`/`required` come from the access payload; `feature` is its holder-readable label.
function describe(access) {
	const reason = access?.reason || 'insufficient_tier';
	const held = access?.held || { label: 'Member', level: 0, usd: 0 };
	const required = access?.required || null;
	const reqLabel = required?.label || 'a higher tier';
	const heldUsd = fmtUsd(held.usd);

	if (reason === 'sign_in') {
		return {
			title: 'Sign in to unlock',
			body: `Sign in with your Solana wallet so we can read your $THREE and check your tier.`,
			primary: 'signin',
			primaryLabel: 'Sign in',
		};
	}
	if (reason === 'link_wallet') {
		return {
			title: 'Link a Solana wallet',
			body: `You're signed in, but no Solana wallet is linked yet. Connect one so we can read your $THREE.`,
			primary: 'signin',
			primaryLabel: 'Link a wallet',
		};
	}
	if (reason === 'error') {
		return {
			title: "Couldn't check your tier",
			body: `We couldn't read your $THREE just now. Recheck in a moment — or get $THREE to unlock this.`,
			primary: 'get',
			primaryLabel: 'Get $THREE',
		};
	}
	// insufficient_tier — a real holder under the bar.
	return {
		title: `Hold ${esc(reqLabel)} to unlock`,
		body: `You hold <strong>${esc(held.label)}</strong>${heldUsd ? ` (≈ ${esc(heldUsd)})` : ''}. Reach <strong>${esc(reqLabel)}</strong> to unlock this.`,
		primary: 'get',
		primaryLabel: 'Get $THREE',
	};
}

// The modal's inner markup, rebuilt on every (re)check so held-vs-required stays live.
function bodyHTML(snapshot) {
	const access = snapshot?.access || {};
	const d = describe(access);
	const featureLabel = access.label || 'This is a $THREE holder feature.';
	const why = access.why ? `<p class="tga-why">${esc(access.why)}</p>` : '';
	// Pay-per-use is shown as honest context, not a button — paying is the caller's own
	// flow, so we never render a control here that wouldn't do anything.
	const ppu =
		access.pay_per_use && Number(access.pay_per_use.usd) > 0
			? `<p class="tga-ppu">No $THREE yet? This action can also be paid per use — about ${esc(fmtUsd(access.pay_per_use.usd))} each — at checkout.</p>`
			: '';

	const primaryBtn =
		d.primary === 'signin'
			? `<button class="tga-btn tga-btn--primary" data-act="signin" type="button">${esc(d.primaryLabel)}</button>`
			: `<a class="tga-btn tga-btn--primary" data-act="get" href="${ECONOMY_URL}" target="_blank" rel="noopener">${esc(d.primaryLabel)}</a>`;

	return `
		<button class="tga-x" data-act="close" type="button" aria-label="Close">✕</button>
		<div class="tga-mark" aria-hidden="true">◆</div>
		<h2 class="tga-title" id="tga-title">${d.title}</h2>
		<p class="tga-feature">${esc(featureLabel)}</p>
		<p class="tga-body" id="tga-desc">${d.body}</p>
		${why}
		<div class="tga-actions">
			${primaryBtn}
			<button class="tga-btn tga-btn--ghost" data-act="recheck" type="button">Recheck access</button>
		</div>
		<a class="tga-tiers" href="${ECONOMY_URL}" target="_blank" rel="noopener">Get $THREE →</a>
		${ppu}
		<p class="tga-note" id="tga-note" role="status" aria-live="polite"></p>
		<p class="tga-foot">$THREE is the only coin on three.ws. Draft &amp; Standard generation stay free, forever.</p>`;
}

function focusable(root) {
	return [...root.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter(
		(el) => el.offsetParent !== null || el === document.activeElement,
	);
}

function setNote(overlay, text, tone = 'info') {
	const note = overlay.querySelector('#tga-note');
	if (!note) return;
	note.textContent = text || '';
	note.dataset.tone = tone;
}

function setBusy(overlay, act, busy, busyLabel) {
	const btn = overlay.querySelector(`[data-act="${act}"]`);
	if (!btn) return null;
	if (busy) {
		btn._label = btn.textContent;
		btn.textContent = busyLabel || btn.textContent;
		btn.setAttribute('aria-busy', 'true');
		btn.disabled = true;
	} else {
		if (btn._label) btn.textContent = btn._label;
		btn.removeAttribute('aria-busy');
		btn.disabled = false;
	}
	return btn;
}

/**
 * Open the gate. See the module header for the full contract.
 * @returns {Promise<{ ok:true, pass:string|null } | { ok:false, reason:string }>}
 */
export function openGateModal({ feature, trigger, snapshot, recheck } = {}) {
	if (typeof document === 'undefined') return Promise.resolve({ ok: false, reason: 'no_dom' });
	injectStyles();
	closeActive({ ok: false, reason: 'superseded' }); // never stack two gates

	let current = snapshot; // updated by each recheck so the copy stays accurate
	const restoreFocus = trigger && typeof trigger.focus === 'function' ? trigger : null;

	return new Promise((resolve) => {
		const overlay = document.createElement('div');
		overlay.className = 'tga-overlay';
		overlay.innerHTML = `<div class="tga-modal" role="dialog" aria-modal="true" aria-labelledby="tga-title" aria-describedby="tga-desc">${bodyHTML(current)}</div>`;
		document.body.appendChild(overlay);
		const modal = overlay.querySelector('.tga-modal');

		const finish = (outcome) => {
			if (_active !== inst) return;
			_active = null;
			document.removeEventListener('keydown', onKey, true);
			overlay.classList.remove('tga-in');
			const remove = () => overlay.remove();
			overlay.addEventListener('transitionend', remove, { once: true });
			setTimeout(remove, 260); // fallback when transitions are disabled
			if (restoreFocus && document.contains(restoreFocus)) {
				try {
					restoreFocus.focus();
				} catch {
					/* element may have been detached — nothing to restore */
				}
			}
			resolve(outcome);
		};

		const onKey = (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				finish({ ok: false, reason: 'cancelled' });
			} else if (e.key === 'Tab') {
				const items = focusable(modal);
				if (!items.length) return;
				const first = items[0];
				const last = items[items.length - 1];
				if (e.shiftKey && document.activeElement === first) {
					e.preventDefault();
					last.focus();
				} else if (!e.shiftKey && document.activeElement === last) {
					e.preventDefault();
					first.focus();
				}
			}
		};

		// Re-resolve eligibility in place; proceed on success, refresh the copy otherwise.
		const doRecheck = async () => {
			setNote(overlay, 'Checking your access…');
			setBusy(overlay, 'recheck', true, 'Checking…');
			let res;
			try {
				res = typeof recheck === 'function' ? await recheck() : { ok: false };
			} catch {
				res = { ok: false };
			}
			if (_active !== inst) return; // closed mid-flight
			if (res && res.ok) {
				finish({ ok: true, pass: res.pass ?? null });
				return;
			}
			if (res && res.snapshot) {
				current = res.snapshot;
				modal.innerHTML = bodyHTML(current);
				wire();
			}
			setBusy(overlay, 'recheck', false);
			setNote(overlay, 'Not unlocked yet — get $THREE, then Recheck.', 'warn');
		};

		// Real auth: SIWS connects a Solana wallet and signs in (or links one to the
		// session). On success the wallet:changed event busts access.js's cache; we then
		// recheck to proceed the original action.
		const doSignIn = async () => {
			setNote(overlay, '');
			setBusy(overlay, 'signin', true, 'Signing in…');
			try {
				const { signInWithWallet } = await import('../wallet-auth.js');
				await signInWithWallet();
			} catch {
				if (_active !== inst) return;
				setBusy(overlay, 'signin', false);
				setNote(overlay, 'Sign-in was cancelled or failed. Try again.', 'warn');
				return;
			}
			if (_active !== inst) return;
			await doRecheck();
		};

		const onClick = (e) => {
			const actEl = e.target.closest('[data-act]');
			if (!actEl) {
				if (e.target === overlay) finish({ ok: false, reason: 'cancelled' });
				return;
			}
			const act = actEl.dataset.act;
			if (act === 'close') finish({ ok: false, reason: 'cancelled' });
			else if (act === 'recheck') doRecheck();
			else if (act === 'signin') {
				e.preventDefault();
				doSignIn();
			}
			// 'get' is a real <a> → let it navigate (opens /three in a new tab).
		};

		// (Re)bind the delegated click handler after each innerHTML rebuild.
		const wire = () => {
			modal.onclick = onClick;
		};
		wire();

		const inst = { overlay, finish };
		_active = inst;
		document.addEventListener('keydown', onKey, true);
		requestAnimationFrame(() => {
			overlay.classList.add('tga-in');
			const primary = modal.querySelector('.tga-btn--primary') || modal.querySelector('[data-act="close"]');
			if (primary) primary.focus();
		});
	});
}

/** Close any open gate immediately, resolving its promise with `outcome`. */
export function closeActive(outcome = { ok: false, reason: 'cancelled' }) {
	if (_active && typeof _active.finish === 'function') _active.finish(outcome);
}

// ── styles ────────────────────────────────────────────────────────────────────────

function injectStyles() {
	if (_stylesInjected || typeof document === 'undefined') return;
	_stylesInjected = true;
	const css = `
	.tga-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;
		padding:20px;background:rgba(4,4,7,.68);backdrop-filter:blur(7px);opacity:0;transition:opacity .2s ease;}
	.tga-overlay.tga-in{opacity:1;}
	.tga-modal{position:relative;width:min(440px,100%);background:linear-gradient(180deg,#0e0e13,#0a0a0e);
		border:1px solid #23232c;border-radius:20px;padding:34px 30px 26px;text-align:center;color:#f6f6f8;
		font-family:Inter,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
		box-shadow:0 30px 80px -30px rgba(0,0,0,.8);
		transform:translateY(10px) scale(.985);transition:transform .24s cubic-bezier(.22,1,.36,1);}
	.tga-overlay.tga-in .tga-modal{transform:none;}
	.tga-x{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:9px;border:1px solid #23232c;
		background:transparent;color:#9a9aa4;cursor:pointer;font-size:13px;transition:.15s cubic-bezier(.22,1,.36,1);}
	.tga-x:hover{color:#f6f6f8;border-color:#34343f;}
	.tga-mark{font-size:34px;color:#6ee7a8;filter:drop-shadow(0 0 14px rgba(110,231,168,.5));margin-bottom:8px;}
	.tga-title{font-size:22px;font-weight:820;letter-spacing:-.02em;margin:2px 0 8px;}
	.tga-feature{font-size:14.5px;color:#c9c9d2;margin:0 0 10px;line-height:1.45;}
	.tga-body{font-size:13.5px;color:#9a9aa4;margin:0 0 8px;line-height:1.5;}
	.tga-body strong{color:#f6f6f8;}
	.tga-why{font-size:12.5px;color:#80808b;margin:0 0 16px;line-height:1.5;font-style:italic;}
	.tga-actions{display:flex;flex-direction:column;gap:9px;margin:10px 0 6px;}
	.tga-btn{display:inline-flex;align-items:center;justify-content:center;font:700 14px/1 Inter,system-ui,sans-serif;
		padding:12px 18px;border-radius:12px;text-decoration:none;cursor:pointer;border:1px solid #2a2a33;
		transition:.16s cubic-bezier(.22,1,.36,1);}
	.tga-btn[aria-busy="true"],.tga-btn:disabled{opacity:.62;cursor:default;}
	.tga-btn--primary{background:#6ee7a8;color:#06120c;border-color:#6ee7a8;}
	.tga-btn--primary:not(:disabled):hover{background:#8af0c0;transform:translateY(-1px);}
	.tga-btn--ghost{background:#0e0e13;color:#f6f6f8;}
	.tga-btn--ghost:not(:disabled):hover{border-color:#3a3a44;transform:translateY(-1px);}
	.tga-tiers{display:inline-block;margin:8px 0 0;font:600 12.5px/1 Inter,system-ui,sans-serif;color:#6ee7a8;
		text-decoration:none;}
	.tga-tiers:hover{text-decoration:underline;}
	.tga-ppu{font-size:12px;color:#9a9aa4;margin:14px 0 0;line-height:1.5;}
	.tga-note{font-size:12.5px;margin:12px 0 0;line-height:1.45;min-height:0;}
	.tga-note[data-tone="warn"]{color:#f0c886;}
	.tga-note[data-tone="info"]{color:#80808b;}
	.tga-foot{font-size:11px;color:#6a6a74;margin:14px 0 0;line-height:1.5;}
	:where(.tga-btn,.tga-tiers,.tga-x):focus-visible{outline:2px solid #6ee7a8;outline-offset:2px;border-radius:9px;}
	@media (prefers-reduced-motion: reduce){
		.tga-overlay,.tga-modal,.tga-btn,.tga-x{transition:none;}
		.tga-modal{transform:none;}
		.tga-btn--primary:hover,.tga-btn--ghost:hover{transform:none;}
	}`;
	const el = document.createElement('style');
	el.id = 'tga-styles';
	el.textContent = css;
	document.head.appendChild(el);
}
