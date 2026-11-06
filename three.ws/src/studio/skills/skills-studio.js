/**
 * Skills Studio — controller (P5)
 * ===============================
 * The capabilities surface of Agent Studio: turn skills on, see which ones are
 * sellable, and jump to pricing. Core skills are the always-on baseline; optional
 * skills toggle live and persist to the agent's real `skills[]` array (the same
 * field the runtime + create-agent wizard read).
 *
 *   • Core      — locked-on foundation (greet, think, remember, …).
 *   • Optional  — toggle on/off; the change writes through immediately and the
 *                 live avatar acknowledges it. Sellable skills surface their
 *                 price (from /api/agents/:id/pricing) and cross-link to Money.
 *
 * Mount: import { mountSkillsStudio } from './skills/skills-studio.js';
 *        mountSkillsStudio(container, { studio });
 */

import { apiFetch } from '../../api.js';
import { CORE_SKILLS, OPTIONAL_SKILLS, skillMeta, isSellable, CORE_IDS } from './skills-catalog.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
	({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const USDC_DECIMALS = 6;
const fmtUsdc = (atomic) => (Number(atomic || 0) / 10 ** USDC_DECIMALS);

export function mountSkillsStudio(container, { studio }) {
	if (container.dataset.skillsMounted) return;
	container.dataset.skillsMounted = '1';
	container.querySelector('.studio-empty')?.remove();
	return new SkillsStudio(container, studio);
}

class SkillsStudio {
	constructor(el, studio) {
		this.el = el;
		this.studio = studio;
		this.agentId = studio.agent?.id;
		this.state = { prices: {}, loadedPrices: false };
		this._render();
		this._loadPrices();
		// React to skills changed elsewhere (e.g. wizard, another tab).
		this._unsub = this.studio.subscribe(() => this._syncToggles());
	}

	_q(sel) { return this.el.querySelector(sel); }

	get _skills() {
		return new Set(this.studio.agent?.skills || []);
	}

	// Custom skills present on the agent but not in the curated catalog.
	get _customSkills() {
		const known = new Set([...CORE_SKILLS, ...OPTIONAL_SKILLS].map((s) => s.id));
		return [...this._skills].filter((id) => !known.has(id));
	}

	async _loadPrices() {
		try {
			const res = await apiFetch(`/api/agents/${this.agentId}/pricing`, { allowAnonymous: true });
			if (res.ok) {
				const { prices = [] } = await res.json();
				const map = {};
				for (const p of prices) map[p.skill] = p;
				this.state.prices = map;
			}
		} catch { /* pricing chips are non-critical; cards still render */ }
		this.state.loadedPrices = true;
		this._renderPriceChips();
	}

	// ── Render ────────────────────────────────────────────────────────────────

	_render() {
		const customs = this._customSkills;
		this.el.innerHTML = `
			<div class="skl">
				<section class="skl-section" aria-labelledby="skl-core-h">
					<div class="skl-section-head">
						<h3 id="skl-core-h">Core skills</h3>
						<p>The always-on baseline every agent runs. These can’t be turned off.</p>
					</div>
					<ul class="skl-grid">${CORE_SKILLS.map((s) => this._card(s, { locked: true })).join('')}</ul>
				</section>

				<section class="skl-section" aria-labelledby="skl-opt-h">
					<div class="skl-section-head">
						<h3 id="skl-opt-h">Optional skills</h3>
						<p>Toggle capabilities on. Sellable ones can be priced in the Money tab.</p>
					</div>
					<ul class="skl-grid">${OPTIONAL_SKILLS.map((s) => this._card(s, { locked: false })).join('')}</ul>
				</section>

				${
					customs.length
						? `<section class="skl-section" aria-labelledby="skl-custom-h">
							<div class="skl-section-head"><h3 id="skl-custom-h">Custom skills</h3>
								<p>Skills added outside the studio. Toggle to keep or remove.</p></div>
							<ul class="skl-grid">${customs.map((id) => this._card(skillMeta(id), { locked: false })).join('')}</ul>
						</section>`
						: ''
				}
			</div>
			<div class="skl-toast" data-toast hidden></div>`;
		this._bind();
		this._syncToggles();
	}

	_card(s, { locked }) {
		const on = locked || this._skills.has(s.id);
		const sellable = isSellable(s.id);
		return `
			<li class="skl-card ${on ? 'is-on' : ''} ${locked ? 'is-locked' : ''}" data-skill="${esc(s.id)}">
				<div class="skl-card-icon" aria-hidden="true">${s.icon || '⚙️'}</div>
				<div class="skl-card-main">
					<div class="skl-card-top">
						<span class="skl-card-name">${esc(s.name)}</span>
						${sellable ? `<span class="skl-sellable-tag" title="Can be metered and sold">Sellable</span>` : ''}
					</div>
					<p class="skl-card-desc">${esc(s.desc)}</p>
					<div class="skl-card-foot" data-foot>${sellable ? this._priceChip(s.id) : ''}</div>
				</div>
				<div class="skl-card-toggle">
					${
						locked
							? `<span class="skl-locked-badge" title="Always on">●</span>`
							: `<button class="skl-switch" role="switch" aria-checked="${on}" data-action="toggle" data-skill="${esc(s.id)}" aria-label="Toggle ${esc(s.name)}"><span class="skl-switch-knob"></span></button>`
					}
				</div>
			</li>`;
	}

	_priceChip(id) {
		const enabled = this._skills.has(id) || CORE_IDS.has(id);
		if (!enabled) return '';
		const p = this.state.prices[id];
		if (p) {
			return `<button class="skl-price-chip is-priced" data-action="go-money" title="Edit price in Money">$${esc(fmtUsdc(p.amount).toFixed(2))}/call ✎</button>`;
		}
		if (!this.state.loadedPrices) return `<span class="skl-price-chip is-loading">…</span>`;
		return `<button class="skl-price-chip" data-action="go-money" title="Set a price">Free · price it →</button>`;
	}

	_renderPriceChips() {
		this.el.querySelectorAll('.skl-card').forEach((card) => {
			const id = card.dataset.skill;
			if (!isSellable(id)) return;
			const foot = card.querySelector('[data-foot]');
			if (foot) foot.innerHTML = this._priceChip(id);
		});
	}

	// ── Bind ────────────────────────────────────────────────────────────────────

	_bind() {
		this.el.addEventListener('click', (e) => {
			const btn = e.target.closest('[data-action]');
			if (!btn) return;
			const a = btn.dataset.action;
			if (a === 'toggle') return this._toggle(btn.dataset.skill);
			if (a === 'go-money') return document.dispatchEvent(new CustomEvent('studio:navigate', { detail: { tab: 'money' } }));
		});
		// Keyboard: space/enter on a switch toggles it.
		this.el.addEventListener('keydown', (e) => {
			const sw = e.target.closest('.skl-switch');
			if (sw && (e.key === ' ' || e.key === 'Enter')) {
				e.preventDefault();
				this._toggle(sw.dataset.skill);
			}
		});
	}

	_toggle(id) {
		if (!id || CORE_IDS.has(id)) return;
		const next = new Set(this._skills);
		const turningOn = !next.has(id);
		if (turningOn) next.add(id);
		else next.delete(id);
		const skills = [...next];
		this.studio.patch({ skills });
		this.studio.emit('skills:change', { skill: id, on: turningOn });
		// Acknowledge on the live avatar: enabling a movement skill previews it.
		if (turningOn) {
			const clip = id === 'wave' ? 'wave' : id === 'dance' ? 'dance' : null;
			const stage = document.querySelector('.studio-stage agent-presence') || document.querySelector('agent-presence');
			if (clip && stage?.playClip) stage.playClip(clip, { loop: id === 'dance' });
			else this.studio.emitMarket?.({ type: 'alert' });
		}
		this._syncCard(id, turningOn);
		this._toast(turningOn ? `${skillMeta(id).name} enabled` : `${skillMeta(id).name} turned off`);
	}

	_syncCard(id, on) {
		const card = this.el.querySelector(`.skl-card[data-skill="${CSS.escape(id)}"]`);
		if (!card) return;
		card.classList.toggle('is-on', on);
		const sw = card.querySelector('.skl-switch');
		if (sw) sw.setAttribute('aria-checked', String(on));
		const foot = card.querySelector('[data-foot]');
		if (foot && isSellable(id)) foot.innerHTML = this._priceChip(id);
	}

	// Reconcile toggles with the live store (covers edits from other surfaces).
	_syncToggles() {
		const skills = this._skills;
		this.el.querySelectorAll('.skl-card').forEach((card) => {
			const id = card.dataset.skill;
			if (card.classList.contains('is-locked')) return;
			const on = skills.has(id);
			card.classList.toggle('is-on', on);
			const sw = card.querySelector('.skl-switch');
			if (sw) sw.setAttribute('aria-checked', String(on));
		});
	}

	_toast(msg, isError = false) {
		const t = this._q('[data-toast]');
		if (!t) return;
		t.textContent = msg;
		t.hidden = false;
		t.className = `skl-toast ${isError ? 'skl-toast-err' : ''} show`;
		clearTimeout(this._toastTimer);
		this._toastTimer = setTimeout(() => { t.classList.remove('show'); setTimeout(() => { t.hidden = true; }, 300); }, 2400);
	}

	destroy() {
		this._unsub?.();
		clearTimeout(this._toastTimer);
	}
}
