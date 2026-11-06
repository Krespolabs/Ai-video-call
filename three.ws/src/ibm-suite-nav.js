// Injects a consistent IBM Granite suite-switcher into every /ibm/* page.
// Each demo page imports this module; it adds a "IBM suite" pill with a
// dropdown listing all seven demos — current demo highlighted, siblings linked.
// Self-contained: creates its own <style> and appends to the page's .topbar.

const SUITE = [
	{ id: 'galaxy',      label: 'Agent Galaxy',     path: '/ibm/galaxy',      tag: 'embeddings' },
	{ id: 'oracle',      label: 'Granite Oracle',    path: '/ibm/oracle',      tag: 'TimeSeries' },
	{ id: 'twin',        label: 'Digital Twin',      path: '/ibm/twin',        tag: 'back-test + what-if' },
	{ id: 'trust-layer', label: 'Trust Layer',       path: '/ibm/trust-layer', tag: 'Guardian' },
	{ id: 'identity',    label: 'Identity Firewall', path: '/ibm/identity',    tag: 'embeddings + Guardian' },
	{ id: 'proof',       label: 'Granite Proof',     path: '/ibm/proof',       tag: 'on-chain attestation' },
	{ id: 'vision',      label: 'Granite Vision',    path: '/ibm/vision',      tag: 'multimodal' },
];

const curPath = window.location.pathname.replace(/\/$/, '');

function init() {
	const topbar = document.querySelector('.topbar');
	if (!topbar) return;

	injectStyles();

	const wrap = document.createElement('div');
	wrap.className = 'sn-wrap';
	wrap.setAttribute('role', 'navigation');
	wrap.setAttribute('aria-label', 'IBM Granite demo suite');

	const btn = document.createElement('button');
	btn.className = 'sn-btn';
	btn.type = 'button';
	btn.setAttribute('aria-haspopup', 'true');
	btn.setAttribute('aria-expanded', 'false');
	btn.innerHTML =
		'<span class="sn-dot"></span>IBM suite' +
		'<svg class="sn-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">' +
		'<path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
		'</svg>';

	const dropdown = document.createElement('div');
	dropdown.className = 'sn-drop';
	dropdown.setAttribute('role', 'menu');
	dropdown.id = 'ibm-suite-menu';
	btn.setAttribute('aria-controls', 'ibm-suite-menu');

	for (const demo of SUITE) {
		const isCurrent = demo.path === curPath;
		const item = document.createElement('a');
		item.className = 'sn-item' + (isCurrent ? ' sn-item--current' : '');
		item.href = isCurrent ? '#' : demo.path;
		item.setAttribute('role', 'menuitem');
		if (isCurrent) {
			item.setAttribute('aria-current', 'page');
			item.addEventListener('click', (e) => e.preventDefault());
		}
		item.innerHTML =
			`<span class="sn-name">${demo.label}</span>` +
			`<span class="sn-tag">${demo.tag}</span>`;
		dropdown.appendChild(item);
	}

	wrap.appendChild(btn);
	wrap.appendChild(dropdown);
	topbar.appendChild(wrap);

	let open = false;

	function setOpen(force) {
		open = typeof force === 'boolean' ? force : !open;
		btn.setAttribute('aria-expanded', String(open));
		dropdown.classList.toggle('sn-drop--open', open);
		btn.classList.toggle('sn-btn--open', open);
	}

	btn.addEventListener('click', (e) => {
		e.stopPropagation();
		setOpen();
	});

	document.addEventListener('click', (e) => {
		if (!wrap.contains(e.target)) setOpen(false);
	});

	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			setOpen(false);
			btn.focus();
		}
	});
}

function injectStyles() {
	const style = document.createElement('style');
	style.textContent = `
.sn-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  pointer-events: auto;
  flex-shrink: 0;
  z-index: 50;
}
.sn-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  background: var(--panel, rgba(255,255,255,0.06));
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: 99px;
  padding: 6px 12px;
  font: 12px/1 -apple-system, system-ui, "Segoe UI", Roboto, sans-serif;
  color: var(--muted, #9fb0c8);
  cursor: pointer;
  transition: border-color .15s, color .15s, background .15s;
  white-space: nowrap;
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}
.sn-btn:hover,
.sn-btn--open {
  border-color: rgba(120,169,255,0.5);
  color: var(--text, #e8edf5);
}
.sn-btn:focus-visible {
  outline: 2px solid rgba(120,169,255,0.7);
  outline-offset: 2px;
}
.sn-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand-blue, #0f62fe);
  box-shadow: 0 0 8px var(--brand-blue, #0f62fe);
  flex: none;
}
.sn-chevron {
  flex: none;
  opacity: 0.6;
  transition: transform .2s;
}
.sn-btn--open .sn-chevron {
  transform: rotate(180deg);
}
.sn-drop {
  display: none;
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 240px;
  background: var(--panel2, rgba(10,14,22,0.97));
  border: 1px solid var(--border, rgba(255,255,255,0.1));
  border-radius: 14px;
  overflow: hidden;
  box-shadow: 0 24px 60px rgba(0,0,0,0.65);
  backdrop-filter: blur(24px);
  -webkit-backdrop-filter: blur(24px);
  z-index: 200;
}
.sn-drop--open {
  display: block;
  animation: sn-in .15s ease;
}
@keyframes sn-in {
  from { opacity: 0; transform: translateY(-4px) scale(0.98); }
  to   { opacity: 1; transform: none; }
}
.sn-item {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  padding: 11px 16px;
  text-decoration: none;
  color: var(--text, #e8edf5);
  border-bottom: 1px solid var(--border, rgba(255,255,255,0.07));
  transition: background .1s;
}
.sn-item:last-child {
  border-bottom: none;
}
.sn-item:hover:not(.sn-item--current) {
  background: rgba(120,169,255,0.08);
}
.sn-item:focus-visible {
  outline: 2px solid rgba(120,169,255,0.7);
  outline-offset: -2px;
}
.sn-item--current {
  background: rgba(15,98,254,0.1);
  cursor: default;
  pointer-events: none;
}
.sn-item--current .sn-name {
  color: var(--brand-blue-light, #78a9ff);
}
.sn-name {
  font-size: 13px;
  font-weight: 500;
}
.sn-tag {
  font-size: 11px;
  color: var(--faint, #6b7b96);
  white-space: nowrap;
}
@media (max-width: 480px) {
  .sn-btn { padding: 5px 10px; font-size: 11px; gap: 5px; }
  .sn-drop { min-width: 200px; }
}
	`.trim();
	document.head.appendChild(style);
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', init);
} else {
	init();
}
