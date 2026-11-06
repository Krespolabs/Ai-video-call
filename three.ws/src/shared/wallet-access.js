// Wallet access (client) — reads an agent's reputation-derived unlocks and renders
// them, and gates world surfaces on the server's verdict.
//
// The SERVER is authoritative: every unlock here comes from GET
// /api/agents/:id/unlocks, computed from the agent's real reputation (tier, score,
// $THREE held + holding duration) which a client cannot forge. This module only
// reflects that state and offers owner-only "claim" affordances — the protected
// routes (and the claim endpoint) re-authorize server-side. A tampered client that
// flips an unlock locally gains nothing real.
//
// Surfaces use this two ways:
//   • renderUnlocksSection(agentId, {isOwner}) — the "what unlocks next" tracker on
//     the reputation panel (transparent: every requirement + your progress shown).
//   • gateWorldArea(agentId, key) — a world (e.g. the arena elite floor) asks the
//     server whether the viewer's agent may enter; admission follows the verdict.

import { apiFetch } from '../api.js';

const isBrowser = () => typeof window !== 'undefined' && typeof document !== 'undefined';
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const _unlocks = new Map(); // agentId -> promise of unlock payload

/**
 * Fetch (and cache per page) an agent's full unlock state. Pass force to bypass.
 * @returns {Promise<object|null>} { tier, unlocks[], claimed[], is_owner, ... }
 */
export async function fetchUnlocks(agentId, { force = false } = {}) {
	if (!agentId || !UUID_RE.test(String(agentId))) return null;
	if (!force && _unlocks.has(agentId)) return _unlocks.get(agentId);
	const p = (async () => {
		const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/unlocks`, { allowAnonymous: true });
		if (!res.ok) throw new Error(`unlocks ${res.status}`);
		return res.json();
	})();
	_unlocks.set(agentId, p);
	p.catch(() => _unlocks.delete(agentId));
	return p;
}

/** The single unlock entry for a key, or null. */
export async function checkUnlock(agentId, key) {
	const data = await fetchUnlocks(agentId).catch(() => null);
	return data?.unlocks?.find((u) => u.key === key) || null;
}

/**
 * Server-authoritative world-area gate. Returns the server's verdict for the
 * viewer's agent. The world surface admits ONLY when `allowed` is true; the server
 * is the source of truth, so a faked client flag never grants entry.
 *
 * @returns {Promise<{ allowed: boolean, unlock: object|null, reason: string|null }>}
 */
export async function gateWorldArea(agentId, key) {
	const u = await checkUnlock(agentId, key).catch(() => null);
	if (!u) return { allowed: false, unlock: null, reason: 'unavailable' };
	return { allowed: Boolean(u.unlocked), unlock: u, reason: u.unlocked ? null : u.nextHint || 'locked' };
}

/**
 * Owner-only: claim an unlocked cosmetic. CSRF + ownership + requirement are all
 * re-checked server-side. Returns the updated claimed-set on success; throws with
 * a readable message otherwise.
 */
export async function claimCosmetic(agentId, key) {
	const res = await apiFetch(`/api/agents/${encodeURIComponent(agentId)}/unlocks/claim`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ key }),
	});
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body?.error || body?.message || `claim failed (${res.status})`);
	_unlocks.delete(agentId); // refresh on next read
	return body;
}

// ── "what unlocks next" tracker ───────────────────────────────────────────────

function condPaths(u) {
	// Render the OR-paths: each condition is a set of ANDed requirements.
	return u.conditions
		.map((c, ci) => {
			const parts = c.parts
				.map(
					(p) =>
						`<span class="acc-req ${p.met ? 'met' : ''}">${p.met ? '✓' : '○'} ${esc(p.label)}` +
						`${p.met ? '' : ` <em>(${esc(p.have)})</em>`}</span>`,
				)
				.join('<span class="acc-and">and</span>');
			return `<div class="acc-path ${c.met ? 'met' : ''}">${parts}</div>`;
		})
		.join('<div class="acc-or">or</div>');
}

function unlockCard(u, { isOwner }) {
	const state = u.claimed ? 'claimed' : u.unlocked ? 'unlocked' : 'locked';
	const pct = Math.round((u.progress || 0) * 100);
	let cta = '';
	if (u.surface === 'cosmetic' && u.claimable) {
		if (u.claimed) cta = `<span class="acc-chip acc-chip--owned">✓ Equipped</span>`;
		else if (u.unlocked && isOwner)
			cta = `<button type="button" class="acc-claim" data-acc-claim="${esc(u.key)}">Claim</button>`;
		else if (u.unlocked) cta = `<span class="acc-chip acc-chip--ready">Unlocked</span>`;
	} else if (u.surface === 'world') {
		cta = u.unlocked ? `<span class="acc-chip acc-chip--ready">Access granted</span>` : '';
	}
	return (
		`<li class="acc-card acc-${state}" style="--acc-accent:${esc(u.accent || '#a78bfa')}">` +
		`<div class="acc-card-head">` +
		`<span class="acc-icon" aria-hidden="true">${esc(u.icon || '◆')}</span>` +
		`<span class="acc-card-title">${esc(u.label)}</span>` +
		`<span class="acc-card-tag">${state === 'claimed' ? 'Equipped' : state === 'unlocked' ? 'Unlocked' : `${pct}%`}</span>` +
		cta +
		`</div>` +
		`<p class="acc-blurb">${esc(u.blurb)}</p>` +
		(u.unlocked ? '' : `<div class="acc-bar"><div class="acc-bar-fill" style="width:${pct}%"></div></div>`) +
		(u.unlocked ? '' : `<div class="acc-paths">${condPaths(u)}</div>`) +
		`</li>`
	);
}

/**
 * Build the "Access & unlocks" section as a self-loading DOM node. Designed to sit
 * under the reputation breakdown. Loading → populated, with empty + error states.
 *
 * @param {string} agentId
 * @param {object} [opts] { isOwner?:boolean, force?:boolean }
 * @returns {HTMLElement}
 */
export function renderUnlocksSection(agentId, opts = {}) {
	ensureAccessStyles();
	const root = document.createElement('section');
	root.className = 'acc-section';
	root.setAttribute('aria-label', 'Reputation unlocks');
	root.innerHTML = skeleton();

	const load = async () => {
		root.innerHTML = skeleton();
		try {
			const data = await fetchUnlocks(agentId, { force: opts.force });
			if (!data?.unlocks?.length) {
				root.innerHTML =
					`<div class="acc-head"><span class="acc-h-title">Access &amp; unlocks</span></div>` +
					`<p class="acc-empty">No unlocks are defined yet.</p>`;
				return;
			}
			const isOwner = opts.isOwner != null ? opts.isOwner : Boolean(data.is_owner);
			const unlockedCount = data.unlocks.filter((u) => u.unlocked).length;
			root.innerHTML =
				`<div class="acc-head"><span class="acc-h-title">Access &amp; unlocks</span>` +
				`<span class="acc-h-count">${unlockedCount}/${data.unlocks.length} unlocked</span></div>` +
				`<p class="acc-intro">Reputation is a key. Earn a tier — or hold $THREE — to open worlds and cosmetics. Every requirement is shown; the server enforces it.</p>` +
				`<ul class="acc-list">${data.unlocks.map((u) => unlockCard(u, { isOwner })).join('')}</ul>`;

			root.querySelectorAll('[data-acc-claim]').forEach((btn) => {
				btn.addEventListener('click', async (e) => {
					e.preventDefault();
					e.stopPropagation();
					const key = btn.getAttribute('data-acc-claim');
					btn.disabled = true;
					btn.textContent = 'Claiming…';
					try {
						await claimCosmetic(agentId, key);
						await load(); // reflect the new claimed state
					} catch (err) {
						btn.disabled = false;
						btn.textContent = 'Claim';
						const msg = document.createElement('span');
						msg.className = 'acc-err-inline';
						msg.setAttribute('role', 'alert');
						msg.textContent = err?.message || 'Could not claim';
						btn.after(msg);
						setTimeout(() => msg.remove(), 4000);
					}
				});
			});
		} catch {
			root.innerHTML =
				`<div class="acc-head"><span class="acc-h-title">Access &amp; unlocks</span></div>` +
				`<div class="acc-error" role="alert"><p>Couldn't load unlocks just now.</p>` +
				`<button type="button" class="acc-retry">Try again</button></div>`;
			root.querySelector('.acc-retry')?.addEventListener('click', load);
		}
	};
	load();
	return root;
}

function skeleton() {
	return (
		`<div class="acc-head"><span class="acc-h-title">Access &amp; unlocks</span></div>` +
		`<ul class="acc-list">${Array.from({ length: 3 })
			.map(() => `<li class="acc-card acc-sk"><div class="acc-sk-line" style="height:46px"></div></li>`)
			.join('')}</ul>`
	);
}

// ── styles (injected once, token-driven, matches the reputation panel) ─────────
let _styled = false;
export function ensureAccessStyles() {
	if (_styled || !isBrowser()) return;
	_styled = true;
	const css = `
.acc-section{display:flex;flex-direction:column;gap:var(--space-sm,10px);padding-top:var(--space-md,16px);margin-top:var(--space-sm,10px);border-top:1px solid var(--stroke,rgba(255,255,255,.08));font-family:var(--font-body,Inter,system-ui,sans-serif);color:var(--ink,#e5e7eb)}
.acc-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.acc-h-title{font-family:var(--font-display,Space Grotesk,sans-serif);font-weight:700;font-size:var(--text-md,15px);color:var(--ink-bright,#fff)}
.acc-h-count{font-size:var(--text-2xs,11px);color:var(--ink-dim,#9ca3af);font-family:var(--font-mono,monospace)}
.acc-intro,.acc-empty{font-size:var(--text-xs,12px);color:var(--ink-dim,#9ca3af);line-height:1.45;margin:0}
.acc-list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:var(--space-sm,10px)}
.acc-card{background:var(--surface-1,rgba(255,255,255,.03));border:1px solid var(--stroke,rgba(255,255,255,.08));border-radius:var(--radius-md,10px);padding:11px 12px;display:flex;flex-direction:column;gap:8px;transition:border-color var(--duration-fast,120ms) ease,background var(--duration-fast,120ms) ease}
.acc-card.acc-unlocked,.acc-card.acc-claimed{border-color:color-mix(in srgb,var(--acc-accent,#a78bfa) 45%,transparent);background:color-mix(in srgb,var(--acc-accent,#a78bfa) 8%,transparent)}
.acc-card-head{display:flex;align-items:center;gap:8px}
.acc-icon{font-size:16px;line-height:1;filter:saturate(1.1)}
.acc-card-title{font-weight:600;font-size:var(--text-sm,13px);color:var(--ink-bright,#fff);flex:1;min-width:0}
.acc-card-tag{font-family:var(--font-mono,monospace);font-size:var(--text-2xs,11px);color:var(--acc-accent,#a78bfa)}
.acc-locked .acc-card-tag{color:var(--ink-faint,#6b7280)}
.acc-blurb{font-size:var(--text-xs,12px);color:var(--ink-dim,#9ca3af);line-height:1.45;margin:0}
.acc-bar{height:4px;border-radius:2px;background:var(--surface-3,rgba(255,255,255,.08));overflow:hidden}
.acc-bar-fill{height:100%;border-radius:2px;background:linear-gradient(90deg,color-mix(in srgb,var(--acc-accent,#a78bfa) 60%,transparent),var(--acc-accent,#a78bfa));transition:width var(--duration-base,300ms) var(--ease-standard,ease)}
.acc-paths{display:flex;flex-direction:column;gap:3px}
.acc-path{display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:var(--text-2xs,11px);color:var(--ink-dim,#9ca3af)}
.acc-req{display:inline-flex;align-items:center;gap:3px}
.acc-req.met{color:var(--success,#4ade80)}
.acc-req em{font-style:normal;color:var(--ink-faint,#6b7280)}
.acc-and{color:var(--ink-faint,#6b7280);opacity:.7}
.acc-or{font-size:var(--text-2xs,10px);text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint,#6b7280);margin:1px 0}
.acc-chip{font-size:var(--text-2xs,11px);font-weight:600;padding:3px 8px;border-radius:var(--radius-pill,999px);white-space:nowrap}
.acc-chip--owned{color:var(--success,#4ade80);background:color-mix(in srgb,var(--success,#4ade80) 12%,transparent)}
.acc-chip--ready{color:var(--acc-accent,#a78bfa);background:color-mix(in srgb,var(--acc-accent,#a78bfa) 14%,transparent)}
.acc-claim{font:inherit;font-size:var(--text-xs,12px);font-weight:600;color:var(--bg-0,#0a0a0a);background:var(--acc-accent,#a78bfa);border:none;border-radius:var(--radius-pill,999px);padding:4px 12px;cursor:pointer;transition:filter var(--duration-fast,120ms) ease,transform var(--duration-fast,120ms) ease}
.acc-claim:hover{filter:brightness(1.08);transform:translateY(-1px)}
.acc-claim:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--acc-accent,#a78bfa) 55%,transparent)}
.acc-claim:disabled{opacity:.6;cursor:default;transform:none}
.acc-err-inline{display:block;font-size:var(--text-2xs,11px);color:var(--danger,#f87171);margin-top:4px}
.acc-error{text-align:center;padding:var(--space-md,16px) 0}
.acc-error p{font-size:var(--text-sm,13px);color:var(--ink-dim,#9ca3af);margin:0 0 10px}
.acc-retry{font:inherit;font-size:var(--text-xs,12px);font-weight:600;color:var(--ink-bright,#fff);background:var(--wallet-accent-fill,rgba(139,92,246,.15));border:1px solid var(--wallet-stroke,rgba(139,92,246,.4));border-radius:var(--radius-md,10px);padding:6px 14px;cursor:pointer}
.acc-sk{padding:0;border:none;background:transparent}
.acc-sk-line{background:linear-gradient(90deg,var(--surface-1,rgba(255,255,255,.03)) 25%,var(--surface-2,rgba(255,255,255,.06)) 37%,var(--surface-1,rgba(255,255,255,.03)) 63%);background-size:400% 100%;animation:acc-shimmer 1.4s ease infinite;border-radius:var(--radius-md,10px)}
@keyframes acc-shimmer{0%{background-position:100% 50%}100%{background-position:0 50%}}
@media (prefers-reduced-motion:reduce){.acc-bar-fill,.acc-claim,.acc-card,.acc-sk-line{transition:none;animation:none}}
`;
	const style = document.createElement('style');
	style.id = 'wallet-access-styles';
	style.textContent = css;
	document.head.appendChild(style);
}
