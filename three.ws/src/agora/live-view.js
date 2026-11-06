// Agora — the shared live view for a multi-worker task (Task 09). One accessible,
// self-disposing overlay that both the Arena (race) and the Guild (fill) mount into.
// It owns:
//   • a focus-trapped modal shell (Escape / backdrop / restore-focus),
//   • a small real Three.js scene the caller populates via a scene adapter,
//   • a live poll of /api/agora/task (real roster + on-chain fill + settlement),
//   • a leaderboard / roster HUD bound to that live state, and every state
//     (loading, empty, error, live, settled) designed.
//
// The 3D differs per kind (a race track vs a rising structure) so the caller hands
// in a scene adapter; the roster HUD, polling and chrome are shared. Nothing here
// decides an outcome — it renders whatever the chain settled, read through the API.

import * as THREE from 'three';
import { injectArenaGuildCss } from './arena-guild.css.js';
import { rankRoster, stateProgress, stateLabel } from './task-progress.js';
import { taskTypeBadge, isArena } from './task-types.js';
import { professionColor, professionLabelFor } from './professions.js';
import { explorerTxUrl, shortId } from './format.js';

const POLL_MS = 4000;
const POLL_MAX_BACKOFF = 30000;
const SETTLED_GRACE_POLLS = 1; // one more poll after settle, then stop

const FOCUSABLE = 'a[href],button:not([disabled]),[tabindex]:not([tabindex="-1"])';

export class LiveView {
	// kind: 'arena' | 'guild'; sceneAdapter: { build(ctx), sync(view), frame(dt,reduced), dispose() }
	constructor({ kind, sceneAdapter }) {
		injectArenaGuildCss();
		this.kind = kind;
		this.sceneAdapter = sceneAdapter;
		this.reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
		this._open = false;
		this._opener = null;
		this._taskPda = null;
		this._cluster = 'devnet';
		this._view = null;
		this._timer = null;
		this._backoff = 0;
		this._settledPolls = 0;
		this._raf = null;
		this._renderer = null;
		this._three = null;
		this._buildDom();
	}

	// ── DOM shell ───────────────────────────────────────────────────────────────
	_buildDom() {
		const root = document.createElement('div');
		root.className = 'agora-live-root';
		root.setAttribute('role', 'dialog');
		root.setAttribute('aria-modal', 'true');
		root.setAttribute('aria-label', this.kind === 'arena' ? 'Live Arena race' : 'Live Guild');
		root.hidden = true;

		root.innerHTML = `
			<div class="agora-live-backdrop" data-close></div>
			<div class="agora-live-card is-${this.kind}" role="document">
				<header class="agora-live-head">
					<div class="agora-live-head-text">
						<h2 class="agora-live-title"></h2>
						<div class="agora-live-sub"></div>
					</div>
					<button class="agora-live-close" type="button" aria-label="Close (Esc)" title="Close (Esc)">✕</button>
				</header>
				<div class="agora-live-stage" aria-hidden="true"><span class="agora-live-finish"></span></div>
				<div class="agora-live-body"></div>
			</div>`;

		this.root = root;
		this.titleEl = root.querySelector('.agora-live-title');
		this.subEl = root.querySelector('.agora-live-sub');
		this.stageEl = root.querySelector('.agora-live-stage');
		this.finishEl = root.querySelector('.agora-live-finish');
		this.bodyEl = root.querySelector('.agora-live-body');
		this.closeBtn = root.querySelector('.agora-live-close');

		this.closeBtn.addEventListener('click', () => this.close());
		root.querySelector('[data-close]').addEventListener('click', () => this.close());
		root.addEventListener('keydown', (e) => {
			if (!this._open) return;
			if (e.key === 'Escape') { e.stopPropagation(); this.close(); }
			else if (e.key === 'Tab') this._trapTab(e);
		});
		document.body.appendChild(root);
	}

	_trapTab(e) {
		const items = [...this.root.querySelectorAll(FOCUSABLE)].filter((n) => n.offsetParent !== null);
		if (!items.length) { e.preventDefault(); this.closeBtn.focus(); return; }
		const first = items[0], last = items[items.length - 1];
		if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
		else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
	}

	// ── Three.js mini-scene (lazy, reused across opens) ─────────────────────────
	_ensureThree() {
		if (this._three) return this._three;
		const width = this.stageEl.clientWidth || 880;
		const height = this.stageEl.clientHeight || 300;
		const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
		renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
		renderer.setSize(width, height, false);
		renderer.setClearColor(0x000000, 0);
		this.stageEl.insertBefore(renderer.domElement, this.finishEl);

		const scene = new THREE.Scene();
		const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
		camera.position.set(0, 4.2, 9.5);
		camera.lookAt(0, 0.6, 0);

		scene.add(new THREE.AmbientLight(0xffffff, 0.75));
		const key = new THREE.DirectionalLight(0xffffff, 1.1);
		key.position.set(4, 8, 6);
		scene.add(key);

		const group = new THREE.Group();
		scene.add(group);

		this._renderer = renderer;
		this._three = { renderer, scene, camera, group, width, height };

		// Keep the canvas sized to the stage.
		this._ro = new ResizeObserver(() => this._resize());
		this._ro.observe(this.stageEl);

		this.sceneAdapter.build({ THREE, scene, group, camera, reduced: this.reduced, kind: this.kind });
		return this._three;
	}

	_resize() {
		if (!this._three) return;
		const w = this.stageEl.clientWidth || 880;
		const h = this.stageEl.clientHeight || 300;
		if (w === this._three.width && h === this._three.height) return;
		this._three.width = w; this._three.height = h;
		this._three.renderer.setSize(w, h, false);
		this._three.camera.aspect = w / h;
		this._three.camera.updateProjectionMatrix();
	}

	_startRaf() {
		if (this._raf) return;
		let last = performance.now();
		const loop = () => {
			this._raf = requestAnimationFrame(loop);
			const now = performance.now();
			const dt = Math.min((now - last) / 1000, 0.05);
			last = now;
			const t = this._three;
			if (t) {
				this.sceneAdapter.frame(dt, this.reduced);
				t.renderer.render(t.scene, t.camera);
			}
		};
		this._raf = requestAnimationFrame(loop);
	}

	_stopRaf() {
		if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
	}

	// ── Open / close ────────────────────────────────────────────────────────────
	open(taskPda, cluster, opener) {
		this._taskPda = taskPda;
		this._cluster = cluster || 'devnet';
		this._opener = opener || document.activeElement;
		this._view = null;
		this._settledPolls = 0;
		this._backoff = 0;

		this.root.hidden = false;
		requestAnimationFrame(() => this.root.classList.add('is-open'));
		this._open = true;
		this._renderLoading();
		this._ensureThree();
		this._resize();
		this._startRaf();
		this._poll(true);
		requestAnimationFrame(() => this.closeBtn.focus());
	}

	close() {
		if (!this._open) return;
		this._open = false;
		this.root.classList.remove('is-open');
		this._stopPolling();
		this._stopRaf();
		const hide = () => { if (!this._open) this.root.hidden = true; };
		this.root.addEventListener('transitionend', hide, { once: true });
		setTimeout(hide, 300);
		if (this._opener?.focus) { try { this._opener.focus(); } catch { /* opener gone */ } }
		this._opener = null;
		this._clearDeepLink();
	}

	get isOpen() { return this._open; }

	// ── Polling ─────────────────────────────────────────────────────────────────
	_stopPolling() { if (this._timer) { clearTimeout(this._timer); this._timer = null; } }

	_schedule() {
		this._stopPolling();
		if (!this._open) return;
		const delay = this._backoff > 0 ? Math.min(POLL_MAX_BACKOFF, this._backoff) : POLL_MS;
		this._timer = setTimeout(() => this._poll(), delay + Math.random() * 500);
	}

	async _poll(immediate = false) {
		if (!this._open) return;
		if (immediate) this._stopPolling();
		const url = `/api/agora/task?taskPda=${encodeURIComponent(this._taskPda)}&cluster=${encodeURIComponent(this._cluster)}`;
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), 12000);
		try {
			const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = await res.json();
			this._backoff = 0;
			this._apply(data);
			// Stop polling a beat after the task has settled — nothing more will change.
			if (data?.settlement?.settled) {
				this._settledPolls++;
				if (this._settledPolls > SETTLED_GRACE_POLLS) { this._stopPolling(); return; }
			} else {
				this._settledPolls = 0;
			}
		} catch (err) {
			this._backoff = this._backoff ? this._backoff * 2 : 2000;
			if (!this._view) this._renderError(err?.message || 'Could not load this task.');
		} finally {
			clearTimeout(to);
			this._schedule();
		}
	}

	_apply(view) {
		this._view = view;
		this._renderChrome(view);
		try { this.sceneAdapter.sync(view); } catch (err) { /* scene best-effort */ }
		this._renderBody(view);
	}

	// ── Rendering ───────────────────────────────────────────────────────────────
	_renderChrome(view) {
		const badge = taskTypeBadge(view.taskType) || { label: this.kind === 'arena' ? 'Arena' : 'Guild', icon: '' };
		const prize = view.posting?.rewardLabel || view.settlement?.prizeLabel || view.settlement?.poolLabel || '';
		this.titleEl.innerHTML = '';
		const b = document.createElement('span');
		b.className = 'agora-live-typebadge';
		b.textContent = `${badge.icon} ${badge.label}`.trim();
		this.titleEl.appendChild(b);
		const title = document.createElement('span');
		title.textContent = this.kind === 'arena' ? 'Race for the escrow' : 'Guild build';
		this.titleEl.appendChild(title);

		this.subEl.innerHTML = '';
		if (view.posting?.poster) this.subEl.appendChild(txt(`opened by ${view.posting.poster}`));
		if (prize) { const p = document.createElement('span'); p.className = 'agora-live-prize'; p.textContent = this.kind === 'arena' ? `${prize} · winner takes all` : `${prize} · split`; this.subEl.appendChild(p); }
		const fill = document.createElement('span');
		fill.textContent = `${view.workersCurrent ?? 0}/${view.workersMax ?? '?'} ${this.kind === 'arena' ? 'racers' : 'contributors'}`;
		this.subEl.appendChild(fill);
		this._setDeepLink();
	}

	_renderLoading() {
		this.bodyEl.innerHTML = `<div class="agora-live-status"><span class="agora-live-pill is-live"><span class="dot"></span>Loading</span></div><div class="agora-live-skel"></div><div class="agora-live-skel"></div><div class="agora-live-skel"></div>`;
	}

	_renderError(msg) {
		this.bodyEl.innerHTML = '';
		const el = document.createElement('div');
		el.className = 'agora-live-error';
		el.setAttribute('role', 'alert');
		el.textContent = `Couldn't load this ${this.kind === 'arena' ? 'race' : 'guild'}: ${msg}`;
		const retry = document.createElement('button');
		retry.className = 'agora-live-btn';
		retry.type = 'button';
		retry.textContent = 'Try again';
		retry.style.marginTop = '12px';
		retry.addEventListener('click', () => { this._backoff = 0; this._renderLoading(); this._poll(true); });
		el.appendChild(document.createElement('br'));
		el.appendChild(retry);
		this.bodyEl.appendChild(el);
	}

	_renderBody(view) {
		const arena = this.kind === 'arena';
		const settled = !!view.settlement?.settled;
		const roster = rankRoster(view.roster || []);

		const frag = document.createDocumentFragment();

		// Status pill row.
		const status = document.createElement('div');
		status.className = 'agora-live-status';
		const state = settled ? (view.settlement?.expiredUnderTarget ? 'expired' : 'settled') : 'live';
		const pill = document.createElement('span');
		pill.className = `agora-live-pill is-${state}`;
		pill.innerHTML = `<span class="dot"></span>${state === 'live' ? (arena ? 'Racing now' : 'Filling now') : state === 'expired' ? 'Expired — reward returned' : 'Settled'}`;
		status.appendChild(pill);
		frag.appendChild(status);

		// Outcome banner once decided.
		const outcome = this._outcomeBanner(view, arena);
		if (outcome) frag.appendChild(outcome);

		// Roster / leaderboard.
		if (!roster.length) {
			const empty = document.createElement('div');
			empty.className = 'agora-live-empty';
			empty.textContent = arena
				? 'No racers have entered yet. Eligible citizens claim and race the moment they pass the board.'
				: 'No contributors yet. Citizens join and raise their part as they claim.';
			frag.appendChild(empty);
		} else {
			const list = document.createElement('div');
			list.className = 'agora-live-roster';
			list.setAttribute('role', 'list');
			roster.forEach((w, i) => list.appendChild(this._rosterRow(w, i, arena, view.cluster)));
			frag.appendChild(list);
		}

		this.bodyEl.innerHTML = '';
		this.bodyEl.appendChild(frag);
	}

	_outcomeBanner(view, arena) {
		const s = view.settlement;
		if (!s) return null;
		if (arena) {
			if (s.winner) {
				const el = document.createElement('div');
				el.className = 'agora-live-outcome';
				el.innerHTML = `<strong>${escapeHtml(s.winner.displayName || 'A racer')}</strong> won — first valid proof took the full ${escapeHtml(s.winner.rewardLabel || s.prizeLabel || 'purse')}. ${s.stoodDownCount ? `${s.stoodDownCount} racer${s.stoodDownCount === 1 ? '' : 's'} stood down.` : ''}`;
				return el;
			}
			return null;
		}
		if (s.expiredUnderTarget) {
			const el = document.createElement('div');
			el.className = 'agora-live-outcome';
			el.innerHTML = `This Guild expired before filling — the unclaimed pool <strong>returned to the creator</strong>. ${s.contributorCount || 0} part${s.contributorCount === 1 ? '' : 's'} landed.`;
			return el;
		}
		if (s.settled && s.contributorCount) {
			const el = document.createElement('div');
			el.className = 'agora-live-outcome';
			el.innerHTML = `Guild complete — <strong>${s.contributorCount}</strong> contributor${s.contributorCount === 1 ? '' : 's'} split the ${escapeHtml(s.poolLabel || 'pool')}.`;
			return el;
		}
		return null;
	}

	_rosterRow(w, i, arena, cluster) {
		const row = document.createElement('div');
		row.className = `agora-live-row is-${w.state}`;
		row.setAttribute('role', 'listitem');

		const rank = document.createElement('div');
		rank.className = `agora-live-rank${w.won ? ' is-won' : ''}`;
		rank.textContent = w.won ? '★' : String(i + 1);
		row.appendChild(rank);

		const who = document.createElement('div');
		who.className = 'agora-live-who';
		const name = document.createElement('div');
		name.className = 'agora-live-name';
		const sw = document.createElement('span');
		sw.className = 'swatch';
		sw.style.background = professionColor(w.profession);
		name.appendChild(sw);
		name.appendChild(txt(w.displayName || 'Citizen'));
		who.appendChild(name);

		const meta = document.createElement('div');
		meta.className = 'agora-live-meta';
		meta.appendChild(txt(professionLabelFor(w.profession)));
		if (arena && w.state === 'lost' && w.lostTo) meta.appendChild(txt(`lost to ${w.lostTo}`));
		if (!arena && w.shareLabel) { const s = document.createElement('span'); s.className = 'agora-live-share'; s.textContent = `share ${w.shareLabel}`; meta.appendChild(s); }
		const tx = w.completeTx || w.claimTx;
		if (tx) {
			const a = document.createElement('a');
			a.className = 'agora-live-tx';
			a.href = explorerTxUrl(tx, cluster);
			a.target = '_blank'; a.rel = 'noopener noreferrer';
			a.textContent = `tx ${shortId(tx, 4, 4)} ↗`;
			meta.appendChild(a);
		}
		who.appendChild(meta);

		// Per-worker progress bar (its position along the track / up the structure).
		const bar = document.createElement('div');
		bar.className = 'agora-live-bar';
		const fill = document.createElement('span');
		fill.style.width = `${Math.round(stateProgress(w.state) * 100)}%`;
		bar.appendChild(fill);
		who.appendChild(bar);
		row.appendChild(who);

		const st = document.createElement('div');
		st.className = `agora-live-state is-${w.state}`;
		st.textContent = stateLabel(w.state, { arena });
		row.appendChild(st);

		return row;
	}

	// ── Deep link (?arena= / ?guild=) ───────────────────────────────────────────
	_setDeepLink() {
		try {
			const url = new URL(window.location.href);
			url.searchParams.set(this.kind, this._taskPda);
			if (this._cluster && this._cluster !== 'devnet') url.searchParams.set('cluster', this._cluster);
			window.history.replaceState(null, '', url);
		} catch { /* history blocked */ }
	}
	_clearDeepLink() {
		try {
			const url = new URL(window.location.href);
			url.searchParams.delete(this.kind);
			window.history.replaceState(null, '', url);
		} catch { /* non-fatal */ }
	}

	dispose() {
		this._stopPolling();
		this._stopRaf();
		this._ro?.disconnect();
		try { this.sceneAdapter.dispose(); } catch { /* best-effort */ }
		this._renderer?.dispose();
		this.root?.remove();
	}
}

function txt(s) { return document.createTextNode(String(s ?? '')); }
function escapeHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
export { isArena };
