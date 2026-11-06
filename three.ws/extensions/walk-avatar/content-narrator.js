// content-narrator.js — page-section narrator for the Walk Avatar extension.
//
// Injected as a CLASSIC script before content.js. Exposes a constructor on
// window.__ThreewsWalkNarrator so content.js can instantiate it without ES
// modules. The narrator:
//   • Finds readable sections (Readability for the lead block, plus the page's
//     own headings/paragraphs so scrolling tracks individual sections).
//   • Tracks which section is ≥60% in view with an IntersectionObserver.
//   • Debounces active-section changes by 600 ms to avoid double-narration.
//   • Fetches real audio from POST /api/tts/speak and plays it in the page.
//   • Posts walk:narrate / walk:narrateEnd to the iframe so the avatar shows a
//     speech bubble and plays its reading gesture.

(function () {
	'use strict';
	if (window.__ThreewsWalkNarrator) return;

	const THREEWS = 'https://three.ws';
	const SECTION_DEBOUNCE_MS = 600;
	const MAX_CHARS = 400;
	const MIN_SECTION_CHARS = 80;
	const VISIBILITY_RATIO = 0.6;

	class Narrator {
		constructor({ getIframe, getSession, getSettings, isMuted }) {
			this.getIframe = getIframe;
			this.getSession = getSession;
			this.getSettings = getSettings;
			this.isMuted = isMuted || (() => false);

			this._observer = null;
			this._currentSection = null;
			this._debounceTimer = null;
			this._audio = null;
			this._controller = null;
			this._sections = [];
		}

		start() {
			this._collectSections();
		}

		refresh() {
			// Re-scan after settings change or significant DOM mutation.
			this._collectSections();
		}

		stop() {
			clearTimeout(this._debounceTimer);
			this._observer?.disconnect();
			this._observer = null;
			this._cancelAudio();
			this._currentSection = null;
		}

		mute() { this._cancelAudio(); this._endBubble(); }
		unmute() { /* next visible section narrates again */ }

		// ── Section discovery ──────────────────────────────────────────────────
		_collectSections() {
			this._observer?.disconnect();
			const sections = this._findReadableSections();
			this._sections = sections;
			if (sections.length === 0) return;

			this._observer = new IntersectionObserver((entries) => {
				// Pick the most-visible intersecting section.
				let best = null;
				for (const entry of entries) {
					if (entry.isIntersecting && entry.intersectionRatio >= VISIBILITY_RATIO) {
						if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
					}
				}
				if (best) this._onSectionVisible(best.target);
			}, { threshold: [VISIBILITY_RATIO, 0.75, 1] });

			for (const el of sections) this._observer.observe(el);
		}

		_findReadableSections() {
			// 1) Use Readability to isolate the main article, then narrate its
			//    block-level children. This strips nav/footer/ads reliably.
			const fromReadability = this._readabilitySections();
			if (fromReadability.length > 0) return fromReadability;

			// 2) Author-marked sections.
			const marked = Array.from(document.querySelectorAll('[data-walk-narrate]'))
				.filter((el) => el.dataset.walkNarrate !== 'skip' && this._textOf(el).length >= 20);
			if (marked.length > 0) return marked;

			// 3) Semantic fallback: headings, article/section/main paragraphs.
			const root = document.querySelector('article, main, [role="main"]') || document.body;
			const candidates = Array.from(
				root.querySelectorAll('h1, h2, h3, p, li, blockquote'),
			);
			return candidates.filter((el) => {
				if (this._isChrome(el)) return false;
				return this._textOf(el).length >= MIN_SECTION_CHARS;
			});
		}

		_readabilitySections() {
			const R = window.__ThreewsReadability;
			if (!R) return [];
			let articleRoot = null;
			try {
				// Parse a clone so the live page is never mutated.
				const clone = document.cloneNode(true);
				const parsed = new R(clone, { charThreshold: 200 }).parse();
				if (!parsed || !parsed.content) return [];
				// Re-anchor parsed blocks back onto live nodes by matching text, so
				// the IntersectionObserver observes elements that actually scroll.
				const holder = document.createElement('div');
				holder.innerHTML = parsed.content;
				const blocks = Array.from(holder.querySelectorAll('p, h1, h2, h3, li, blockquote'))
					.map((b) => b.textContent.replace(/\s+/g, ' ').trim())
					.filter((t) => t.length >= MIN_SECTION_CHARS);
				if (blocks.length === 0) return [];

				const live = Array.from(document.querySelectorAll('p, h1, h2, h3, li, blockquote'))
					.filter((el) => !this._isChrome(el));
				const liveByText = new Map();
				for (const el of live) {
					const t = this._textOf(el);
					if (t.length >= MIN_SECTION_CHARS && !liveByText.has(t)) liveByText.set(t, el);
				}
				articleRoot = [];
				for (const t of blocks) {
					const el = liveByText.get(t);
					if (el && !articleRoot.includes(el)) articleRoot.push(el);
				}
			} catch {
				return [];
			}
			return articleRoot || [];
		}

		_isChrome(el) {
			// Skip nav/header/footer/aside chrome and hidden nodes.
			if (el.closest('nav, header, footer, aside, [role="navigation"], [aria-hidden="true"]')) return true;
			const cs = window.getComputedStyle(el);
			return cs.display === 'none' || cs.visibility === 'hidden';
		}

		_textOf(el) {
			return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
		}

		_onSectionVisible(el) {
			if (el === this._currentSection) return;
			clearTimeout(this._debounceTimer);
			this._debounceTimer = setTimeout(() => {
				this._currentSection = el;
				if (!this.isMuted()) this._narrate(el);
			}, SECTION_DEBOUNCE_MS);
		}

		// ── Narration ──────────────────────────────────────────────────────────
		_extractText(el) {
			if (el.dataset?.walkScript) return el.dataset.walkScript.trim().slice(0, MAX_CHARS);
			return this._textOf(el).slice(0, MAX_CHARS);
		}

		async _narrate(el) {
			const text = this._extractText(el);
			if (!text) return;

			this._cancelAudio();

			const settings = this.getSettings() || {};
			const session = this.getSession();
			const voice = settings.voice || 'nova';
			const iframe = this.getIframe();

			// Avatar: reading gesture + speech bubble.
			iframe?.contentWindow?.postMessage({ type: 'walk:setMotion', motion: 'idle' }, THREEWS);
			iframe?.contentWindow?.postMessage({ type: 'walk:narrate', text }, THREEWS);

			try {
				this._controller = new AbortController();
				const headers = { 'Content-Type': 'application/json' };
				if (session) headers['Authorization'] = `Bearer ${session}`;

				const res = await fetch(`${THREEWS}/api/tts/speak`, {
					method: 'POST',
					headers,
					credentials: 'include',
					body: JSON.stringify({ text, voice, format: 'mp3' }),
					signal: this._controller.signal,
				});
				if (!res.ok || this.isMuted()) { this._endBubble(); return; }

				const blob = await res.blob();
				if (this.isMuted()) { this._endBubble(); return; }

				const url = URL.createObjectURL(blob);
				this._audio = new Audio(url);
				this._audio.onended = () => { URL.revokeObjectURL(url); this._endBubble(); };
				this._audio.onerror = () => { URL.revokeObjectURL(url); this._endBubble(); };
				await this._audio.play().catch(() => { this._endBubble(); });
			} catch (err) {
				if (err.name !== 'AbortError') this._endBubble();
			}
		}

		_endBubble() {
			this.getIframe()?.contentWindow?.postMessage({ type: 'walk:narrateEnd' }, THREEWS);
		}

		_cancelAudio() {
			if (this._controller) { this._controller.abort(); this._controller = null; }
			if (this._audio) {
				this._audio.pause();
				this._audio.onended = null;
				this._audio.onerror = null;
				this._audio.src = '';
				this._audio = null;
			}
		}
	}

	window.__ThreewsWalkNarrator = Narrator;
})();
