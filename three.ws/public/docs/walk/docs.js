// Walk documentation hub — shared client behaviour for /docs/walk/*
// ----------------------------------------------------------------------------
// Three small, dependency-free enhancements that every doc page opts into by
// loading this module:
//   1. Copy-to-clipboard buttons on code blocks (built from the raw text so the
//      clipboard never picks up the highlight <span>s).
//   2. A minimal, safe syntax tint for fenced code (keywords / strings /
//      comments / numbers) — no external highlighter, no CDN.
//   3. A responsive sidebar disclosure for narrow viewports.
//
// Everything degrades gracefully: with JS off, code blocks are still readable
// plain text and the sidebar is plain navigation.

(() => {
	'use strict';

	// ── 1 + 2. Code blocks ──────────────────────────────────────────────────
	const KEYWORDS = new Set([
		'const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while',
		'new', 'await', 'async', 'import', 'export', 'from', 'class', 'extends',
		'true', 'false', 'null', 'undefined', 'typeof', 'this', 'try', 'catch',
		'window', 'document', 'script',
	]);

	function escapeHtml(s) {
		return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
	}

	// Tokenise a single line for tinting. HTML/markup samples and shell are left
	// mostly alone (only strings + comments) to avoid mangling tags.
	function tintLine(line, mode) {
		const out = [];
		let i = 0;
		const push = (cls, text) => out.push(cls ? `<span class="${cls}">${escapeHtml(text)}</span>` : escapeHtml(text));
		while (i < line.length) {
			const rest = line.slice(i);
			// Line comment (// or #)
			if ((mode !== 'html') && (rest.startsWith('//') || (mode === 'shell' && rest.startsWith('#')))) {
				push('t-com', rest);
				break;
			}
			// HTML comment
			if (mode === 'html' && rest.startsWith('<!--')) {
				push('t-com', rest);
				break;
			}
			// String literals
			const q = rest[0];
			if (q === '"' || q === "'" || q === '`') {
				let j = 1;
				while (j < rest.length && rest[j] !== q) {
					if (rest[j] === '\\') j++;
					j++;
				}
				push('t-str', rest.slice(0, Math.min(j + 1, rest.length)));
				i += Math.min(j + 1, rest.length);
				continue;
			}
			// Identifiers / keywords (JS/JSON only)
			if ((mode === 'js' || mode === 'json') && /[A-Za-z_$]/.test(q)) {
				const m = rest.match(/^[A-Za-z0-9_$]+/);
				const word = m[0];
				push(KEYWORDS.has(word) ? 't-key' : null, word);
				i += word.length;
				continue;
			}
			// Numbers
			if (/[0-9]/.test(q) && (i === 0 || !/[A-Za-z0-9_]/.test(line[i - 1]))) {
				const m = rest.match(/^[0-9][0-9_.eE+-]*/);
				push('t-num', m[0]);
				i += m[0].length;
				continue;
			}
			push(null, q);
			i++;
		}
		return out.join('');
	}

	function enhanceCodeBlocks() {
		document.querySelectorAll('.wd-code').forEach((block) => {
			const pre = block.querySelector('pre');
			const code = pre && pre.querySelector('code');
			if (!pre || !code) return;
			const raw = code.textContent;
			const mode = block.dataset.lang || 'js';

			// Tint (skip 'text' / 'plain' blocks).
			if (mode !== 'text' && mode !== 'plain') {
				code.innerHTML = raw
					.split('\n')
					.map((l) => tintLine(l, mode))
					.join('\n');
			}

			// Build the head + copy button if not already present.
			if (!block.querySelector('.wd-code-head')) {
				const head = document.createElement('div');
				head.className = 'wd-code-head';
				const lang = document.createElement('span');
				lang.className = 'wd-code-lang';
				lang.textContent = block.dataset.label || mode;
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'wd-copy';
				btn.textContent = 'Copy';
				btn.setAttribute('aria-label', 'Copy code to clipboard');
				btn.addEventListener('click', async () => {
					try {
						await navigator.clipboard.writeText(raw);
					} catch {
						// Fallback for non-secure contexts / older browsers.
						const ta = document.createElement('textarea');
						ta.value = raw;
						ta.style.position = 'fixed';
						ta.style.opacity = '0';
						document.body.appendChild(ta);
						ta.select();
						try { document.execCommand('copy'); } catch { /* nothing more we can do */ }
						ta.remove();
					}
					btn.textContent = 'Copied';
					btn.dataset.copied = 'true';
					setTimeout(() => {
						btn.textContent = 'Copy';
						btn.dataset.copied = 'false';
					}, 1600);
				});
				head.append(lang, btn);
				block.insertBefore(head, pre);
			}
		});
	}

	// ── 3. Responsive sidebar ───────────────────────────────────────────────
	function wireSidebar() {
		const toggle = document.querySelector('.wd-side-toggle');
		const side = document.getElementById('wd-side');
		if (!toggle || !side) return;
		const mq = window.matchMedia('(max-width: 880px)');
		const apply = () => {
			if (mq.matches) {
				side.hidden = true;
				toggle.setAttribute('aria-expanded', 'false');
			} else {
				side.hidden = false;
			}
		};
		toggle.addEventListener('click', () => {
			const open = side.hidden;
			side.hidden = !open;
			toggle.setAttribute('aria-expanded', String(open));
		});
		mq.addEventListener('change', apply);
		apply();
	}

	function init() {
		enhanceCodeBlocks();
		wireSidebar();
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
