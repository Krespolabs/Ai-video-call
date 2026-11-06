// chapters.js — the tour's navigation drawer. A long tour needs a map, so this
// panel lays the whole curriculum out as chapters → stops, marks the one you're
// on, and lets you jump to any of them. It doubles as the settings surface:
// switch between tracks (e.g. Quick highlights vs Full), change the narration
// voice, set the playback speed, and search across every stop's title. It is
// pure UI — every action forwards to a handler the director supplies, and the
// director calls setActive()/setTrack()/setVoice()/setSpeed() to keep it in
// sync. Open/close is fully keyboard- and screen-reader-friendly.

const Z_PANEL = 2147483450;

// Fallback voice catalogue if a host doesn't pass one. Kept small so the menu
// stays scannable.
const FALLBACK_VOICES = [
	{ id: 'nova', name: 'Nova' },
	{ id: 'alloy', name: 'Alloy' },
	{ id: 'fable', name: 'Fable' },
];

const SPEEDS = [0.75, 1, 1.25, 1.5];

export class ChapterPanel {
	constructor(curriculum, handlers, voices) {
		this.curriculum = curriculum;
		this.handlers = handlers; // { onJump(abs), onTrack, onVoice, onSpeed, onOpenChange }
		this.voices = Array.isArray(voices) && voices.length ? voices : FALLBACK_VOICES;
		this.open = false;
		this.activeAbs = 0;
		this._query = '';
		this._onKey = this._onKey.bind(this);
		ensureStyles();
		this._build();
	}

	_build() {
		const root = document.createElement('div');
		root.className = 'tws-tour-menu';
		root.innerHTML = `
			<div class="tws-tour-menu__scrim" data-act="close"></div>
			<aside class="tws-tour-menu__panel" role="dialog" aria-modal="false" aria-label="Tour chapters and settings" tabindex="-1">
				<div class="tws-tour-menu__head">
					<div class="tws-tour-menu__title">Tour map</div>
					<button class="tws-tour-menu__x" data-act="close" aria-label="Close menu" title="Close">✕</button>
				</div>
				<div class="tws-tour-menu__settings">
					<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl">Track</span>
						<div class="tws-tour-seg" data-group="track" role="radiogroup" aria-label="Tour length"></div>
					</label>
					<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl">Speed</span>
						<div class="tws-tour-seg" data-group="speed" role="radiogroup" aria-label="Playback speed"></div>
					</label>
					<label class="tws-tour-menu__field">
						<span class="tws-tour-menu__lbl" id="tws-tour-voice-lbl">Voice</span>
						<select class="tws-tour-menu__select" data-act="voice" aria-labelledby="tws-tour-voice-lbl"></select>
					</label>
				</div>
				<div class="tws-tour-menu__search">
					<input type="search" class="tws-tour-menu__input" placeholder="Search features…" aria-label="Search tour stops" autocomplete="off" spellcheck="false" />
				</div>
				<nav class="tws-tour-menu__list" aria-label="Tour chapters"></nav>
			</aside>`;
		document.body.appendChild(root);
		this.root = root;
		this.panel = root.querySelector('.tws-tour-menu__panel');
		this.listEl = root.querySelector('.tws-tour-menu__list');
		this.trackSeg = root.querySelector('[data-group="track"]');
		this.speedSeg = root.querySelector('[data-group="speed"]');
		this.voiceSel = root.querySelector('[data-act="voice"]');
		this.searchInput = root.querySelector('.tws-tour-menu__input');

		this._buildSegments();
		this._buildVoices();
		this._buildList();

		root.addEventListener('click', (e) => {
			if (e.target.closest('[data-act="close"]')) this.close();
		});
		this.trackSeg.addEventListener('click', (e) => {
			const id = e.target.closest('[data-val]')?.dataset.val;
			if (id) this.handlers.onTrack?.(id);
		});
		this.speedSeg.addEventListener('click', (e) => {
			const v = e.target.closest('[data-val]')?.dataset.val;
			if (v) this.handlers.onSpeed?.(Number(v));
		});
		this.voiceSel.addEventListener('change', () => this.handlers.onVoice?.(this.voiceSel.value));
		this.searchInput.addEventListener('input', () => {
			this._query = this.searchInput.value.trim().toLowerCase();
			this._buildList();
		});
		this.listEl.addEventListener('click', (e) => {
			const abs = e.target.closest('[data-abs]')?.dataset.abs;
			if (abs != null) {
				this.handlers.onJump?.(Number(abs));
				this.close();
			}
		});
	}

	_buildSegments() {
		const tracks = this.curriculum.tracks?.length
			? this.curriculum.tracks
			: [{ id: 'full', title: 'Full' }];
		this.trackSeg.innerHTML = tracks
			.map(
				(t) =>
					`<button class="tws-tour-seg__btn" data-val="${t.id}" role="radio" aria-checked="false" title="${esc(t.description || '')}">${esc((t.title || '').replace(/ tour| highlights/i, ''))}${t.estimatedMinutes ? ` · ~${t.estimatedMinutes}m` : ''}</button>`,
			)
			.join('');
		this.speedSeg.innerHTML = SPEEDS.map(
			(s) =>
				`<button class="tws-tour-seg__btn" data-val="${s}" role="radio" aria-checked="false">${String(s).replace(/\.?0+$/, '')}×</button>`,
		).join('');
	}

	_buildVoices() {
		this.voiceSel.innerHTML = this.voices
			.map((v) => `<option value="${esc(v.id)}">${esc(v.name)}</option>`)
			.join('');
	}

	_buildList() {
		const { sections = [], stops } = this.curriculum;
		const q = this._query;
		const rows = [];
		// Stops whose section isn't declared in `sections` still need a home, so
		// render any leftover sections referenced only by stops, in first-seen order.
		const sectionList = sections.length ? sections : inferSections(stops);
		for (const section of sectionList) {
			const items = stops
				.map((s, abs) => ({ s, abs }))
				.filter(({ s }) => s.section === section.id)
				.filter(({ s }) => !q || s.title.toLowerCase().includes(q));
			if (!items.length) continue;
			rows.push(
				`<div class="tws-tour-chap"><span class="tws-tour-chap__t">${esc(section.title)}</span><span class="tws-tour-chap__n">${items.length}</span></div>`,
			);
			for (const { s, abs } of items) {
				rows.push(
					`<button class="tws-tour-stop${abs === this.activeAbs ? ' is-current' : ''}" data-abs="${abs}" aria-current="${abs === this.activeAbs ? 'true' : 'false'}">
						<span class="tws-tour-stop__dot"${s.highlight ? ' data-hl="1"' : ''}></span>
						<span class="tws-tour-stop__title">${esc(s.title)}</span>
						${s.highlight ? '<span class="tws-tour-stop__star" title="In the Quick highlights">★</span>' : ''}
					</button>`,
				);
			}
		}
		this.listEl.innerHTML =
			rows.join('') ||
			`<div class="tws-tour-menu__empty">No features match “${esc(this._query)}”.</div>`;
	}

	// ── Director-driven sync ────────────────────────────────────────────────────
	setActive(abs) {
		this.activeAbs = abs;
		this.listEl.querySelectorAll('.tws-tour-stop').forEach((el) => {
			const on = Number(el.dataset.abs) === abs;
			el.classList.toggle('is-current', on);
			el.setAttribute('aria-current', on ? 'true' : 'false');
		});
		if (this.open) this._scrollToActive();
	}

	setTrack(track) {
		this._mark(this.trackSeg, track);
	}
	setSpeed(speed) {
		this._mark(this.speedSeg, String(speed));
	}
	setVoice(voice) {
		this.voiceSel.value = voice;
	}

	_mark(seg, val) {
		seg.querySelectorAll('.tws-tour-seg__btn').forEach((b) => {
			const on = b.dataset.val === val;
			b.classList.toggle('is-on', on);
			b.setAttribute('aria-checked', on ? 'true' : 'false');
		});
	}

	// ── Open / close ────────────────────────────────────────────────────────────
	toggle() {
		this.open ? this.close() : this.show();
	}
	show() {
		if (this.open) return;
		this.open = true;
		this.root.classList.add('is-open');
		this._scrollToActive();
		document.addEventListener('keydown', this._onKey, true);
		// Focus the search box for instant filter-and-jump.
		requestAnimationFrame(() => this.searchInput.focus());
		this.handlers.onOpenChange?.(true);
	}
	close() {
		if (!this.open) return;
		this.open = false;
		this.root.classList.remove('is-open');
		document.removeEventListener('keydown', this._onKey, true);
		this.handlers.onOpenChange?.(false);
	}

	_scrollToActive() {
		const el = this.listEl.querySelector('.tws-tour-stop.is-current');
		el?.scrollIntoView({ block: 'center', behavior: 'auto' });
	}

	_onKey(e) {
		// Swallow Escape here so it closes the menu instead of exiting the tour.
		if (e.key === 'Escape') {
			e.stopPropagation();
			e.preventDefault();
			this.close();
		}
	}

	dispose() {
		document.removeEventListener('keydown', this._onKey, true);
		this.root?.remove();
		this.root = null;
	}
}

// Derive section headers from the stops themselves when a curriculum omits the
// top-level `sections` array — first-seen order, titled by the section id.
function inferSections(stops) {
	const seen = new Map();
	for (const s of stops) {
		const id = s.section || 'tour';
		if (!seen.has(id)) seen.set(id, { id, title: titleCase(id) });
	}
	return [...seen.values()];
}

function titleCase(id) {
	return String(id || '')
		.replace(/[-_]+/g, ' ')
		.replace(/\b\w/g, (c) => c.toUpperCase());
}

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-menu-style';
	style.textContent = `
.tws-tour-menu{position:fixed;inset:0;z-index:${Z_PANEL};pointer-events:none;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}
.tws-tour-menu__scrim{position:absolute;inset:0;background:rgba(6,8,12,.5);opacity:0;transition:opacity .3s ease;pointer-events:none}
.tws-tour-menu.is-open .tws-tour-menu__scrim{opacity:1;pointer-events:auto}
.tws-tour-menu__panel{position:absolute;left:0;top:0;height:100%;width:min(360px,86vw);display:flex;flex-direction:column;background:#0e1118;border-right:1px solid rgba(122,162,255,.18);box-shadow:24px 0 60px rgba(0,0,0,.5);transform:translateX(-104%);transition:transform .34s cubic-bezier(.4,0,.2,1);pointer-events:auto;color:#e7eaf2}
.tws-tour-menu.is-open .tws-tour-menu__panel{transform:translateX(0)}
.tws-tour-menu__head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px 12px;border-bottom:1px solid rgba(255,255,255,.07)}
.tws-tour-menu__title{font-weight:700;font-size:16px}
.tws-tour-menu__x{appearance:none;border:none;background:rgba(255,255,255,.06);color:#cfd5e2;width:30px;height:30px;border-radius:9px;cursor:pointer;font-size:13px;display:grid;place-items:center;transition:background .16s ease}
.tws-tour-menu__x:hover{background:rgba(220,70,70,.8);color:#fff}
.tws-tour-menu__settings{padding:14px 18px;display:flex;flex-direction:column;gap:12px;border-bottom:1px solid rgba(255,255,255,.07)}
.tws-tour-menu__field{display:flex;align-items:center;gap:12px;justify-content:space-between}
.tws-tour-menu__lbl{font-size:12.5px;color:#9aa3b6;font-weight:600;flex:0 0 auto;width:48px}
.tws-tour-seg{display:flex;gap:4px;background:rgba(255,255,255,.05);padding:3px;border-radius:10px;flex:1}
.tws-tour-seg__btn{flex:1;appearance:none;border:none;background:transparent;color:#aeb6c6;font:600 12px/1 inherit;padding:7px 6px;border-radius:7px;cursor:pointer;white-space:nowrap;transition:background .16s ease,color .16s ease}
.tws-tour-seg__btn:hover{color:#e7eaf2}
.tws-tour-seg__btn.is-on{background:linear-gradient(90deg,#7aa2ff,#9d7bff);color:#0b0e16}
.tws-tour-seg__btn:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__select{flex:1;appearance:none;background:rgba(255,255,255,.05);color:#e7eaf2;border:1px solid rgba(255,255,255,.12);border-radius:9px;padding:8px 10px;font:600 13px/1 inherit;cursor:pointer}
.tws-tour-menu__select:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__search{padding:12px 18px 8px}
.tws-tour-menu__input{width:100%;box-sizing:border-box;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);border-radius:10px;color:#e7eaf2;font:500 13.5px/1 inherit;padding:10px 12px}
.tws-tour-menu__input::placeholder{color:#7f8aa0}
.tws-tour-menu__input:focus-visible{outline:2px solid #7aa2ff;outline-offset:1px}
.tws-tour-menu__list{flex:1;overflow-y:auto;padding:4px 10px 18px;scrollbar-width:thin}
.tws-tour-chap{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:14px 8px 6px;font-size:11.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:#7f8aa0;position:sticky;top:0;background:#0e1118}
.tws-tour-chap__n{font-weight:600;color:#5f697e;font-variant-numeric:tabular-nums}
.tws-tour-stop{display:flex;align-items:center;gap:10px;width:100%;text-align:left;appearance:none;border:none;background:transparent;color:#c4ccda;font:500 13.5px/1.3 inherit;padding:9px 8px;border-radius:9px;cursor:pointer;transition:background .14s ease,color .14s ease}
.tws-tour-stop:hover{background:rgba(255,255,255,.05);color:#fff}
.tws-tour-stop.is-current{background:rgba(122,162,255,.16);color:#fff}
.tws-tour-stop__dot{flex:0 0 auto;width:7px;height:7px;border-radius:50%;background:rgba(255,255,255,.22)}
.tws-tour-stop__dot[data-hl="1"]{background:linear-gradient(135deg,#7aa2ff,#9d7bff)}
.tws-tour-stop.is-current .tws-tour-stop__dot{background:#7aa2ff;box-shadow:0 0 0 3px rgba(122,162,255,.3)}
.tws-tour-stop__title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tws-tour-stop__star{flex:0 0 auto;color:#9d7bff;font-size:11px}
.tws-tour-menu__empty{padding:30px 14px;text-align:center;color:#7f8aa0;font-size:13px}
@media (prefers-reduced-motion:reduce){.tws-tour-menu__panel{transition:none}.tws-tour-menu__scrim{transition:none}}
`;
	document.head.appendChild(style);
}
