/**
 * Body Studio — controller (P3)
 * =============================
 * The avatar surface of Agent Studio: choose the 3D body, customize its outfit,
 * and shape how it moves. Every change drives the live stage avatar instantly
 * (via the shared store + <agent-presence>) and persists the real record.
 *
 *   • Body      — the bound avatar (thumbnail + name), swap via the shared avatar
 *                 picker (writes agent.avatar_id), deep-customize in the avatar
 *                 editor, or spin up a new one. The default avatar is a real,
 *                 always-present starter — an agent is never bodiless.
 *   • Movement  — the full retargetable clip library (animation-presets.curate):
 *                 click any clip to play it live on the stage, and pin a looping
 *                 idle as the agent's resting pose (meta.studio.body.idleClip),
 *                 which <agent-presence> honors everywhere on the platform.
 *
 * Mount: import { mountBodyStudio } from './body/body-studio.js';
 *        mountBodyStudio(container, { studio });
 */

import { apiFetch } from '../../api.js';
import { createAvatarPicker } from '../../avatar-picker.js';
import { curate } from '../../animation-presets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DEFAULT_AVATAR = { id: null, name: 'Default starter', url: '/avatars/default.glb', thumbnailUrl: null };

export function mountBodyStudio(container, { studio }) {
	if (container.dataset.bodyMounted) return;
	container.dataset.bodyMounted = '1';
	container.querySelector('.studio-empty')?.remove();
	return new BodyStudio(container, studio);
}

class BodyStudio {
	constructor(el, studio) {
		this.el = el;
		this.studio = studio;
		this.state = {
			loading: true,
			error: null,
			avatar: null, // resolved { id, name, url, thumbnailUrl }
			clips: null, // { featured, groups } from curate()
			openCat: null,
			playing: null, // clip name currently previewing
		};
		this._picker = null;
		this._render();
		this._load();
	}

	_q(sel) { return this.el.querySelector(sel); }

	get _idleClip() {
		return this.studio.agent?.meta?.studio?.body?.idleClip || 'idle';
	}

	// The live stage avatar lives in the shell's stage; drive it directly for
	// instant, real preview (the same element every other surface renders).
	get _stage() {
		return document.querySelector('.studio-stage agent-presence') || document.querySelector('agent-presence');
	}

	// ── Data ────────────────────────────────────────────────────────────────

	async _load() {
		this.state.loading = true;
		this._renderBody();
		try {
			const [avatar, clips] = await Promise.all([this._resolveAvatar(), this._loadClips()]);
			this.state.avatar = avatar;
			this.state.clips = clips;
			this.state.error = null;
		} catch (err) {
			this.state.error = err?.message || 'Could not load the body studio.';
		} finally {
			this.state.loading = false;
			this._renderBody();
		}
	}

	async _resolveAvatar() {
		const id = this.studio.agent?.avatarId || null;
		if (!id) return { ...DEFAULT_AVATAR };
		try {
			const res = await apiFetch(`/api/avatars/${id}`, { allowAnonymous: true });
			if (!res.ok) return { ...DEFAULT_AVATAR, id, name: 'Your avatar' };
			const { avatar } = await res.json();
			return {
				id,
				name: avatar?.name || 'Your avatar',
				url: avatar?.url || avatar?.model_url || avatar?.base_model_url || null,
				thumbnailUrl: avatar?.thumbnail_url || null,
			};
		} catch {
			return { ...DEFAULT_AVATAR, id, name: 'Your avatar' };
		}
	}

	async _loadClips() {
		const res = await fetch('/animations/manifest.json');
		if (!res.ok) throw new Error('Could not load the animation library.');
		const manifest = await res.json();
		const defs = Array.isArray(manifest) ? manifest : manifest.clips || manifest.animations || [];
		return curate(defs);
	}

	// ── Shell ─────────────────────────────────────────────────────────────────

	_render() {
		this.el.innerHTML = `<div class="bdy" data-root></div>`;
		// Keep the resting-pose pin in sync if another surface edits the body bag.
		this._unsub = this.studio.subscribe(() => {
			if (!this.state.loading && this.state.clips) this._syncIdleMarks();
		});
	}

	_renderBody() {
		const host = this._q('[data-root]');
		if (this.state.loading) { host.innerHTML = this._skeleton(); return; }
		if (this.state.error) { host.innerHTML = this._errorState(this.state.error); this._bindError(); return; }
		host.innerHTML = `${this._bodySection()}${this._movementSection()}`;
		this._bind();
		this._syncIdleMarks();
	}

	_skeleton() {
		return `
			<div class="bdy-skel">
				<div class="bdy-skel-card"></div>
				<div class="bdy-skel-row"></div>
				<div class="bdy-skel-grid">${'<div class="bdy-skel-chip"></div>'.repeat(8)}</div>
			</div>`;
	}

	_errorState(msg) {
		return `
			<div class="bdy-empty">
				<div class="bdy-empty-glyph" aria-hidden="true">⚠</div>
				<h3>Couldn’t load the body studio</h3>
				<p>${esc(msg)}</p>
				<button class="studio-btn studio-btn-ghost" data-action="retry">Try again</button>
			</div>`;
	}

	// ── Body (avatar) ──────────────────────────────────────────────────────────

	_bodySection() {
		const a = this.state.avatar || DEFAULT_AVATAR;
		const thumb = a.thumbnailUrl
			? `<img src="${esc(a.thumbnailUrl)}" alt="" loading="lazy" />`
			: `<div class="bdy-avatar-fallback" aria-hidden="true">◓</div>`;
		const isDefault = !a.id;
		return `
			<section class="bdy-section" aria-labelledby="bdy-body-h">
				<div class="bdy-section-head">
					<h3 id="bdy-body-h">Body</h3>
					<p>The 3D avatar your agent wears everywhere — chat, world, profile, and feed.</p>
				</div>
				<div class="bdy-avatar-card">
					<div class="bdy-avatar-thumb">${thumb}</div>
					<div class="bdy-avatar-meta">
						<span class="bdy-avatar-name">${esc(a.name)}</span>
						<span class="bdy-avatar-sub">${isDefault ? 'Default starter — swap it for your own anytime.' : 'Live on the stage →'}</span>
						<div class="bdy-avatar-actions">
							<button class="studio-btn studio-btn-primary studio-action" data-action="change">Change avatar</button>
							<a class="studio-btn studio-btn-ghost studio-action" data-action="customize"
								href="${isDefault ? '/create' : `/avatars/${encodeURIComponent(a.id)}/edit`}">
								${isDefault ? 'Create your own ↗' : 'Customize outfit ↗'}
							</a>
						</div>
					</div>
				</div>
			</section>`;
	}

	// ── Movement (animations) ───────────────────────────────────────────────────

	_movementSection() {
		const { featured, groups } = this.state.clips;
		return `
			<section class="bdy-section" aria-labelledby="bdy-move-h">
				<div class="bdy-section-head">
					<h3 id="bdy-move-h">Movement</h3>
					<p>Click any move to preview it live. Pin a looping idle as the resting pose your agent holds everywhere.</p>
				</div>
				<div class="bdy-resting" aria-live="polite">
					<span class="bdy-resting-label">Resting pose</span>
					<span class="bdy-resting-val" data-resting>${esc(this._restingLabel())}</span>
				</div>
				<div class="bdy-featured">
					${featured.map((c) => this._chip(c, true)).join('')}
				</div>
				<div class="bdy-cats">
					${groups.map((g) => this._catBlock(g)).join('')}
				</div>
			</section>`;
	}

	_restingLabel() {
		const idle = this._idleClip;
		const all = [...(this.state.clips?.featured || []), ...(this.state.clips?.groups || []).flatMap((g) => g.items)];
		return all.find((c) => c.name === idle)?.label || idle;
	}

	_catBlock(g) {
		const open = this.state.openCat === g.key;
		return `
			<details class="bdy-cat" ${open ? 'open' : ''} data-cat="${esc(g.key)}">
				<summary class="bdy-cat-summary">
					<span>${g.icon} ${esc(g.label)}</span>
					<span class="bdy-cat-count">${g.items.length}</span>
				</summary>
				<div class="bdy-grid">${g.items.map((c) => this._chip(c, false)).join('')}</div>
			</details>`;
	}

	_chip(c, featured) {
		const loop = c.loop !== false;
		const canPin = loop; // only loops make sense as a held resting pose
		return `
			<div class="bdy-chip ${featured ? 'bdy-chip--featured' : ''}" data-clip="${esc(c.name)}" data-loop="${loop}">
				<button class="bdy-chip-play" data-action="play" data-clip="${esc(c.name)}" data-loop="${loop}"
					title="Preview ${esc(c.label || c.name)}">
					<span class="bdy-chip-icon" aria-hidden="true">${c.icon || '▶'}</span>
					<span class="bdy-chip-label">${esc(c.label || c.name)}</span>
				</button>
				${canPin ? `<button class="bdy-chip-pin" data-action="pin" data-clip="${esc(c.name)}"
					title="Set as resting pose" aria-label="Set ${esc(c.label || c.name)} as resting pose">☆</button>` : ''}
			</div>`;
	}

	// ── Bind ────────────────────────────────────────────────────────────────────

	_bindError() {
		this._q('[data-action="retry"]')?.addEventListener('click', () => this._load());
	}

	_bind() {
		this.el.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-action]');
			if (!btn) return;
			const action = btn.dataset.action;
			if (action === 'change') return this._openPicker();
			if (action === 'play') return this._preview(btn.dataset.clip, btn.dataset.loop === 'true');
			if (action === 'pin') return this._pinResting(btn.dataset.clip);
			// 'customize' is a real <a> — let it navigate.
		});
		// Track which category the user expands so a re-render keeps it open.
		this.el.querySelectorAll('.bdy-cat').forEach((d) =>
			d.addEventListener('toggle', () => { if (d.open) this.state.openCat = d.dataset.cat; }));
	}

	_openPicker() {
		if (!this._picker) {
			this._picker = createAvatarPicker({
				onSelect: ({ id }) => this._setAvatar(id),
			});
		}
		this._picker.open(this.studio.agent?.avatarId || null);
	}

	async _setAvatar(avatarId) {
		// null = the default starter. patch() drives the live stage immediately
		// (presence reloads on avatarId change) and debounce-PUTs avatar_id.
		this.studio.patch({ avatarId: avatarId || null });
		this.studio.emit('body:change', { avatarId: avatarId || null });
		this.state.avatar = await this._resolveAvatar();
		this._renderBody();
	}

	_preview(name, loop) {
		if (!name) return;
		this.state.playing = name;
		this._stage?.playClip?.(name, { loop });
		this.studio.emit('body:preview', { clip: name, loop });
		// Flash the active chip so the click registers even on a clip-less rig.
		this.el.querySelectorAll('.bdy-chip').forEach((c) =>
			c.classList.toggle('bdy-chip--playing', c.dataset.clip === name));
		clearTimeout(this._playFlash);
		this._playFlash = setTimeout(() => {
			this.el.querySelectorAll('.bdy-chip--playing').forEach((c) => c.classList.remove('bdy-chip--playing'));
		}, loop ? 1200 : 2200);
	}

	_pinResting(name) {
		if (!name) return;
		this.studio.patch({ meta: { studio: { body: { idleClip: name } } } });
		this.studio.emit('body:change', { idleClip: name });
		this._preview(name, true); // show the new resting pose immediately
		const restingEl = this._q('[data-resting]');
		if (restingEl) restingEl.textContent = this._restingLabel();
		this._syncIdleMarks();
	}

	// Reflect the pinned resting pose on the matching chip (filled star + ring).
	_syncIdleMarks() {
		const idle = this._idleClip;
		this.el.querySelectorAll('.bdy-chip').forEach((chip) => {
			const on = chip.dataset.clip === idle;
			chip.classList.toggle('bdy-chip--resting', on);
			const pin = chip.querySelector('.bdy-chip-pin');
			if (pin) {
				pin.textContent = on ? '★' : '☆';
				pin.classList.toggle('on', on);
				pin.title = on ? 'Current resting pose' : 'Set as resting pose';
			}
		});
		const restingEl = this._q('[data-resting]');
		if (restingEl) restingEl.textContent = this._restingLabel();
	}

	destroy() {
		this._unsub?.();
		clearTimeout(this._playFlash);
	}
}
