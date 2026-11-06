// Forge embed panel — turn a finished creation into a one-line embed for any
// website, agent, or companion. Self-contained: it reads the live GLB URL
// straight off the result bar's Download link, so it never needs Forge's
// internal state and stays decoupled from src/forge.js (which is edited often).
//
// Five flavours, all real:
//   • iframe        — points at /forge/embed?src=<glb>, a zero-dependency
//     three.ws viewer page (orbit + AR + branding). Works on any site, no
//     scripts, no CORS to worry about.
//   • web component  — a <model-viewer> snippet for builders who want the
//     model inline in their own DOM with their own controls.
//   • <agent-3d>     — the platform's own pure-3D web component.
//   • page-agent     — "add to your agent": a @three-ws/page-agent guide that
//     narrates your page with this exact body (Option B custom-avatar path).
//   • walk companion — "add to your site": a @three-ws/walk corner companion
//     roster entry for this exact body.
// The last two turn a Forge creation into distribution beyond a static
// viewer — the same rigged model becomes a talking guide or a walking
// companion elsewhere, one paste.

import { Modal } from './shared/modal.js';
import {
	EMBED_SIZES,
	embedSize,
	escEmbed as esc,
	absoluteGlb,
	embedPageUrl as embedPageUrlFor,
	embedPreviewUrl,
	buildIframeSnippet,
	buildWebComponentSnippet,
	buildAgentThreeDSnippet,
	buildPageAgentSnippet,
	buildWalkCompanionSnippet,
} from './forge-embed-snippets.js';

const STYLE_ID = 'tws-forge-embed-styles';

// Snippet shapes, size presets, and /forge/embed URLs all live in
// ./forge-embed-snippets.js so the homepage mini Forge embed sheet stays
// byte-identical. These thin wrappers just bind the module's pure builders to
// this panel's `state`, keeping every call site below unchanged.
const SIZES = EMBED_SIZES;

let state = { sizeId: 'wide', tab: 'iframe', glbUrl: '', title: '' };

function size() {
	return embedSize(state.sizeId);
}

function embedPageUrl() {
	return embedPageUrlFor(state.glbUrl, state.title);
}

function previewSrc() {
	return embedPreviewUrl(state.glbUrl, state.title);
}

function iframeSnippet() {
	return buildIframeSnippet(state.glbUrl, state.title, state.sizeId);
}

function webComponentSnippet() {
	return buildWebComponentSnippet(state.glbUrl, state.title, state.sizeId);
}

function agentThreeDSnippet() {
	return buildAgentThreeDSnippet(state.glbUrl, state.title, state.sizeId);
}

function pageAgentSnippet() {
	return buildPageAgentSnippet(state.glbUrl, state.title);
}

function walkCompanionSnippet() {
	return buildWalkCompanionSnippet(state.glbUrl, state.title);
}

const TAB_FOOTERS = {
	iframe: 'Drops a live, orbitable model on any site — AR-ready on phones.',
	component: 'A <model-viewer> element you style and control yourself.',
	agent3d: "Drops the platform's own pure-3D web component — no third-party script.",
	'page-agent': 'Add to your agent: a talking, lipsync guide that narrates your page as this body.',
	walk: 'Add to your site: a corner companion visitors can walk around as this body.',
};

function currentSnippet() {
	if (state.tab === 'iframe') return iframeSnippet();
	if (state.tab === 'agent3d') return agentThreeDSnippet();
	if (state.tab === 'page-agent') return pageAgentSnippet();
	if (state.tab === 'walk') return walkCompanionSnippet();
	return webComponentSnippet();
}

function ensureStyles() {
	if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
	const el = document.createElement('style');
	el.id = STYLE_ID;
	el.textContent = CSS;
	(document.head || document.documentElement).appendChild(el);
}

function bodyHtml() {
	const s = size();
	const tabBtn = (id, label) =>
		`<button type="button" class="tws-emb-tab" data-tab="${id}" aria-pressed="${state.tab === id}">${label}</button>`;
	const sizeBtn = (sz) =>
		`<button type="button" class="tws-emb-size" data-size="${sz.id}" aria-pressed="${state.sizeId === sz.id}">${sz.label}</button>`;

	return `
		<div class="tws-emb">
			<div class="tws-emb-preview" style="aspect-ratio:${s.ratio}">
				<iframe class="tws-emb-frame" src="${esc(previewSrc())}" title="Embed preview"
					allow="xr-spatial-tracking; fullscreen" loading="lazy"></iframe>
			</div>

			<div class="tws-emb-controls">
				<div class="tws-emb-seg" role="group" aria-label="Embed type">
					${tabBtn('iframe', 'iframe')}
					${tabBtn('component', 'Web component')}
					${tabBtn('agent3d', esc('<agent-3d>'))}
					${tabBtn('page-agent', 'Page agent')}
					${tabBtn('walk', 'Walk companion')}
				</div>
				<div class="tws-emb-seg" role="group" aria-label="Size">
					${SIZES.map(sizeBtn).join('')}
				</div>
			</div>

			<label class="tws-emb-codelabel" for="tws-emb-code">Paste this where you want the model</label>
			<textarea id="tws-emb-code" class="tws-emb-code" readonly spellcheck="false" rows="5">${esc(currentSnippet())}</textarea>

			<button type="button" class="tws-emb-copy" data-emb-copy>
				<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
				<span class="tws-emb-copy-label">Copy embed code</span>
			</button>

			<p class="tws-emb-foot">
				${esc(TAB_FOOTERS[state.tab] || TAB_FOOTERS.iframe)}
				<a href="${esc(embedPageUrl())}" target="_blank" rel="noopener">Open the standalone viewer ↗</a>
			</p>
		</div>
	`;
}

function rerender(modalBody) {
	const codeEl = modalBody.querySelector('#tws-emb-code');
	if (codeEl) codeEl.value = currentSnippet();
	const preview = modalBody.querySelector('.tws-emb-preview');
	if (preview) preview.style.aspectRatio = size().ratio;
	for (const b of modalBody.querySelectorAll('.tws-emb-tab')) {
		b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab));
	}
	for (const b of modalBody.querySelectorAll('.tws-emb-size')) {
		b.setAttribute('aria-pressed', String(b.dataset.size === state.sizeId));
	}
	const foot = modalBody.querySelector('.tws-emb-foot');
	if (foot) {
		const link = foot.querySelector('a');
		foot.firstChild.textContent = `${TAB_FOOTERS[state.tab] || TAB_FOOTERS.iframe} `;
		if (link) link.href = embedPageUrl();
	}
}

async function copyText(text, btn) {
	const label = btn.querySelector('.tws-emb-copy-label');
	const original = label ? label.textContent : '';
	try {
		if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
		else {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.position = 'fixed';
			ta.style.opacity = '0';
			document.body.appendChild(ta);
			ta.select();
			document.execCommand('copy');
			ta.remove();
		}
		btn.classList.add('is-copied');
		if (label) label.textContent = 'Copied ✓';
	} catch {
		if (label) label.textContent = 'Press ⌘/Ctrl+C to copy';
	}
	setTimeout(() => {
		btn.classList.remove('is-copied');
		if (label) label.textContent = original;
	}, 2400);
}

export function showEmbedPanel({ glbUrl, title } = {}, triggerEl = null) {
	ensureStyles();
	state = {
		sizeId: 'wide',
		tab: 'iframe',
		glbUrl: absoluteGlb(glbUrl),
		title: (title || '').trim(),
	};

	if (!state.glbUrl) return null;

	const modal = new Modal({ title: 'Embed this model', body: bodyHtml(), dismissible: true }).open(triggerEl);
	const root = modal.bodyEl;

	root.addEventListener('click', (e) => {
		const tab = e.target.closest('.tws-emb-tab');
		if (tab) {
			state.tab = tab.dataset.tab;
			rerender(root);
			return;
		}
		const sz = e.target.closest('.tws-emb-size');
		if (sz) {
			state.sizeId = sz.dataset.size;
			rerender(root);
			return;
		}
		const copy = e.target.closest('[data-emb-copy]');
		if (copy) {
			copyText(currentSnippet(), copy);
		}
	});

	return modal;
}

// Wire the result-bar button. The button lives in forge.html; we read the GLB
// URL from the Download link's href at click time (always set in result state)
// and the prompt from the result label, so no coupling to forge.js internals.
function wire() {
	const btn = document.getElementById('forge-embed-btn');
	if (!btn || btn.dataset.embedWired) return;
	btn.dataset.embedWired = '1';
	btn.addEventListener('click', () => {
		const dl = document.getElementById('download');
		const glbUrl = dl?.getAttribute('href') || '';
		const label = document.getElementById('result-label')?.textContent || '';
		if (!glbUrl) return;
		showEmbedPanel({ glbUrl, title: label }, btn);
	});
}

if (typeof document !== 'undefined') {
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', wire, { once: true });
	} else {
		wire();
	}
}

const CSS = `
.tws-emb { display: flex; flex-direction: column; gap: 12px; padding: 2px 0; }
.tws-emb-preview {
	width: 100%;
	border-radius: 12px;
	overflow: hidden;
	border: 1px solid var(--stroke, rgba(255,255,255,0.1));
	background: #0b0b0b;
}
.tws-emb-frame { display: block; width: 100%; height: 100%; border: 0; }
.tws-emb-controls { display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between; }
.tws-emb-seg {
	display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px;
	background: var(--surface-1, rgba(255,255,255,0.03));
	border: 1px solid var(--stroke, rgba(255,255,255,0.1));
	border-radius: 10px;
}
.tws-emb-tab, .tws-emb-size {
	background: transparent; border: 0; cursor: pointer;
	color: var(--ink-dim, #9a9aa8);
	font: 600 12px/1 var(--font-mono, ui-monospace, monospace);
	padding: 7px 11px; border-radius: 8px;
	transition: background 0.14s, color 0.14s;
}
.tws-emb-tab:hover, .tws-emb-size:hover { color: var(--ink, #ececf4); }
.tws-emb-tab[aria-pressed='true'], .tws-emb-size[aria-pressed='true'] {
	background: var(--surface-3, rgba(255,255,255,0.1)); color: var(--ink, #fff);
}
.tws-emb-tab:focus-visible, .tws-emb-size:focus-visible, .tws-emb-copy:focus-visible {
	outline: 2px solid var(--accent, #6ee7b7); outline-offset: 2px;
}
.tws-emb-codelabel {
	font: 600 11px/1 var(--font-mono, ui-monospace, monospace);
	text-transform: uppercase; letter-spacing: 0.06em;
	color: var(--ink-dim, #9a9aa8); margin-top: 2px;
}
.tws-emb-code {
	width: 100%; box-sizing: border-box; resize: vertical;
	background: var(--surface-1, rgba(0,0,0,0.35));
	border: 1px solid var(--stroke, rgba(255,255,255,0.1));
	border-radius: 10px; padding: 11px 12px;
	color: var(--ink, #e8e8e8);
	font: 12.5px/1.55 var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	white-space: pre; overflow-x: auto;
}
.tws-emb-code:focus-visible { outline: 2px solid var(--accent, #6ee7b7); outline-offset: 1px; }
.tws-emb-copy {
	display: inline-flex; align-items: center; justify-content: center; gap: 8px;
	width: 100%; box-sizing: border-box; cursor: pointer;
	padding: 12px 16px; border-radius: 10px;
	border: 1px solid transparent;
	background: var(--btn-primary-bg, rgba(255,255,255,0.92)); color: var(--btn-primary-fg, #0a0a0f);
	font: 600 14px/1 var(--font-body, system-ui, sans-serif);
	transition: background 0.14s, transform 0.1s;
}
.tws-emb-copy:hover { background: var(--btn-primary-bg-hover, rgba(255,255,255,0.85)); }
.tws-emb-copy:active { transform: translateY(1px); }
.tws-emb-copy.is-copied { background: var(--success, #6ee7b7); }
.tws-emb-foot {
	margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--ink-dim, #9a9aa8);
}
.tws-emb-foot a { color: var(--accent, #6ee7b7); text-decoration: none; }
.tws-emb-foot a:hover { text-decoration: underline; }
`;
