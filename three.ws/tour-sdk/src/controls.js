// controls.js — the tour's playback bar: chapter + progress readout, a
// clickable scrub track, and previous / play-pause / next / mute / exit. It is
// pure UI — every button forwards to a handler the director supplies, and the
// director calls back into update()/setPaused()/setMuted() to keep it in sync.

const Z_CONTROLS = 2147483400;

export class TourControls {
	constructor(handlers) {
		this.handlers = handlers; // { onPrev, onNext, onToggle, onSeek, onMute, onExit }
		ensureStyles();
		this._build();
	}

	_build() {
		const bar = document.createElement('div');
		bar.className = 'tws-tour-bar';
		bar.setAttribute('role', 'group');
		bar.setAttribute('aria-label', 'Guided tour controls');
		bar.innerHTML = `
			<button class="tws-tour-btn" data-act="menu" aria-label="Chapters and settings" title="Chapters & settings" aria-haspopup="dialog" aria-expanded="false">☰</button>
			<button class="tws-tour-btn" data-act="prev" aria-label="Previous feature" title="Previous">⏮</button>
			<button class="tws-tour-btn tws-tour-btn--play" data-act="toggle" aria-label="Pause tour" title="Pause / resume">⏸</button>
			<button class="tws-tour-btn" data-act="next" aria-label="Next feature" title="Next">⏭</button>
			<div class="tws-tour-meta">
				<div class="tws-tour-meta__top"><span class="tws-tour-chapter"></span><span class="tws-tour-count"></span></div>
				<div class="tws-tour-track" role="slider" aria-label="Tour progress" tabindex="0" aria-valuemin="1" aria-valuemax="1" aria-valuenow="1">
					<div class="tws-tour-track__fill"></div>
				</div>
			</div>
			<button class="tws-tour-btn tws-tour-btn--speed" data-act="speed" aria-label="Playback speed" title="Playback speed">1×</button>
			<button class="tws-tour-btn" data-act="roam" aria-label="Free roam — drive the guide yourself" title="Free roam" aria-pressed="false">🧭</button>
			<button class="tws-tour-btn" data-act="mute" aria-label="Mute narration" title="Mute / unmute voice">🔊</button>
			<button class="tws-tour-btn tws-tour-btn--exit" data-act="exit" aria-label="Exit tour" title="Exit tour">✕</button>
		`;
		document.body.appendChild(bar);
		this.bar = bar;
		this.menuBtn = bar.querySelector('[data-act="menu"]');
		this.playBtn = bar.querySelector('[data-act="toggle"]');
		this.muteBtn = bar.querySelector('[data-act="mute"]');
		this.speedBtn = bar.querySelector('[data-act="speed"]');
		this.roamBtn = bar.querySelector('[data-act="roam"]');
		this.chapterEl = bar.querySelector('.tws-tour-chapter');
		this.countEl = bar.querySelector('.tws-tour-count');
		this.track = bar.querySelector('.tws-tour-track');
		this.fill = bar.querySelector('.tws-tour-track__fill');

		bar.addEventListener('click', (e) => {
			const act = e.target.closest('[data-act]')?.dataset.act;
			if (!act) return;
			if (act === 'menu') this.handlers.onMenu?.();
			else if (act === 'prev') this.handlers.onPrev?.();
			else if (act === 'next') this.handlers.onNext?.();
			else if (act === 'toggle') this.handlers.onToggle?.();
			else if (act === 'speed') this.handlers.onSpeed?.();
			else if (act === 'roam') this.handlers.onRoam?.();
			else if (act === 'mute') this.handlers.onMute?.();
			else if (act === 'exit') this.handlers.onExit?.();
		});
		this.track.addEventListener('click', (e) => this._seekFromEvent(e));
		this.track.addEventListener('keydown', (e) => {
			if (e.key === 'ArrowRight') this.handlers.onNext?.();
			else if (e.key === 'ArrowLeft') this.handlers.onPrev?.();
		});
		requestAnimationFrame(() => bar.classList.add('is-in'));
	}

	_seekFromEvent(e) {
		const rect = this.track.getBoundingClientRect();
		const frac = clamp((e.clientX - rect.left) / rect.width, 0, 1);
		const total = this._total || 1;
		const index = Math.round(frac * (total - 1));
		this.handlers.onSeek?.(index);
	}

	update({ chapter, index, total }) {
		this._total = total;
		this.chapterEl.textContent = chapter || '';
		this.countEl.textContent = `${index + 1} / ${total}`;
		const frac = total > 1 ? index / (total - 1) : 1;
		this.fill.style.width = (frac * 100).toFixed(1) + '%';
		this.track.setAttribute('aria-valuemax', String(total));
		this.track.setAttribute('aria-valuenow', String(index + 1));
		this.track.setAttribute('aria-valuetext', `${chapter}, feature ${index + 1} of ${total}`);
	}

	setPaused(paused) {
		this.playBtn.textContent = paused ? '▶' : '⏸';
		this.playBtn.setAttribute('aria-label', paused ? 'Resume tour' : 'Pause tour');
		this.bar.classList.toggle('is-paused', paused);
	}

	setMuted(muted) {
		this.muteBtn.textContent = muted ? '🔇' : '🔊';
		this.muteBtn.setAttribute('aria-label', muted ? 'Unmute narration' : 'Mute narration');
	}

	setSpeed(speed) {
		// Show a tidy "1×" / "1.5×" label; drop the trailing ".0".
		const label = (Number(speed) || 1).toFixed(2).replace(/\.?0+$/, '');
		this.speedBtn.textContent = label + '×';
		this.speedBtn.setAttribute('aria-label', `Playback speed ${label} times — tap to change`);
	}

	setMenuOpen(open) {
		this.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
		this.menuBtn.classList.toggle('is-active', open);
	}

	setRoam(on) {
		this.roamBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
		this.roamBtn.classList.toggle('is-active', on);
		this.roamBtn.setAttribute('title', on ? 'Rejoin the tour' : 'Free roam');
		this.bar.classList.toggle('is-roaming', on);
	}

	dispose() {
		this.bar?.remove();
		this.bar = null;
	}
}

function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

let _stylesInjected = false;
function ensureStyles() {
	if (_stylesInjected) return;
	_stylesInjected = true;
	const style = document.createElement('style');
	style.id = 'tws-tour-bar-style';
	style.textContent = `
.tws-tour-bar{position:fixed;left:50%;bottom:18px;transform:translateX(-50%) translateY(14px);z-index:${Z_CONTROLS};display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(14,16,22,.92);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.1);border-radius:16px;box-shadow:0 16px 40px rgba(0,0,0,.45);opacity:0;transition:opacity .35s ease,transform .35s ease;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;max-width:min(560px,calc(100vw - 24px))}
.tws-tour-bar.is-in{opacity:1;transform:translateX(-50%) translateY(0)}
.tws-tour-btn{appearance:none;border:none;background:rgba(255,255,255,.06);color:#eef1f6;width:36px;height:36px;border-radius:10px;font-size:15px;line-height:1;cursor:pointer;display:grid;place-items:center;transition:background .18s ease,transform .12s ease}
.tws-tour-btn:hover{background:rgba(122,162,255,.22)}
.tws-tour-btn:active{transform:scale(.92)}
.tws-tour-btn:focus-visible{outline:2px solid #7aa2ff;outline-offset:2px}
.tws-tour-btn--play{background:rgba(122,162,255,.9);color:#0b0e16}
.tws-tour-btn--play:hover{background:rgba(122,162,255,1)}
.tws-tour-btn--speed{width:auto;min-width:40px;padding:0 9px;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
.tws-tour-btn.is-active{background:rgba(122,162,255,.28);color:#cdd8ff}
.tws-tour-btn--exit:hover{background:rgba(220,70,70,.85)}
.tws-tour-meta{display:flex;flex-direction:column;gap:5px;min-width:160px;flex:1}
.tws-tour-meta__top{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px}
.tws-tour-chapter{color:#aeb6c6;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tws-tour-count{color:#7f8aa0;font-variant-numeric:tabular-nums;white-space:nowrap}
.tws-tour-track{position:relative;height:6px;border-radius:99px;background:rgba(255,255,255,.12);cursor:pointer}
.tws-tour-track:focus-visible{outline:2px solid #7aa2ff;outline-offset:3px}
.tws-tour-track__fill{position:absolute;left:0;top:0;height:100%;border-radius:99px;background:linear-gradient(90deg,#7aa2ff,#9d7bff);transition:width .4s ease}
@media (max-width:560px){.tws-tour-meta{min-width:96px}.tws-tour-chapter{max-width:120px}}
@media (prefers-reduced-motion:reduce){.tws-tour-bar,.tws-tour-track__fill{transition:opacity .2s ease}}
`;
	document.head.appendChild(style);
}
