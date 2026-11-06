// /glossary — full plain-language glossary page.
//
// Renders every term from the single source of truth in public/glossary.js
// (exposed as window.twsGlossary) so this page never forks the definitions.
// Adds live search, deep-linkable per-term anchors (/glossary#x402), and a
// target flash when arriving via one of those anchors.

const grid = document.getElementById('glos-grid');
const input = document.getElementById('glos-q');
const countEl = document.getElementById('glos-count');
const emptyEl = document.getElementById('glos-empty');

function escapeHtml(s) {
	return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
		'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
	}[c]));
}

// glossary.js is injected sitewide by nav.js (async). Wait for it rather than
// duplicating the term data here. Resolves null if it never arrives so the page
// can still show a graceful message instead of a blank void.
function waitForGlossary() {
	if (window.twsGlossary && window.twsGlossary.terms) return Promise.resolve(window.twsGlossary);
	// Ensure the script is present even on a page that somehow lacks nav.js.
	if (!document.querySelector('script[src="/glossary.js"]')) {
		const s = document.createElement('script');
		s.src = '/glossary.js';
		document.head.appendChild(s);
	}
	return new Promise((resolve) => {
		let tries = 0;
		const iv = setInterval(() => {
			if (window.twsGlossary && window.twsGlossary.terms) {
				clearInterval(iv);
				resolve(window.twsGlossary);
			} else if (++tries > 120) {
				clearInterval(iv);
				resolve(null);
			}
		}, 50);
	});
}

function slugFor(g, key) {
	if (typeof g.slug === 'function') return g.slug(key);
	return String(key).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function render(g) {
	const terms = g.terms || {};
	const labels = g.labels || {};
	const keys = Object.keys(terms).sort((a, b) =>
		(labels[a] || a).localeCompare(labels[b] || b));

	grid.innerHTML = keys.map((key) => {
		const id = 'g-' + slugFor(g, key);
		const label = escapeHtml(labels[key] || key);
		const def = escapeHtml(terms[key]);
		return (
			`<article class="glos-card" id="${id}" tabindex="-1" ` +
				`data-term-key="${escapeHtml(key)}">` +
				`<h2 class="glos-card-term">${label}</h2>` +
				`<p class="glos-card-def">${def}</p>` +
			`</article>`
		);
	}).join('');

	countEl.textContent = `${keys.length} terms`;
	return keys.length;
}

function applyFilter() {
	const q = (input.value || '').trim().toLowerCase();
	const cards = grid.querySelectorAll('.glos-card');
	let shown = 0;
	cards.forEach((card) => {
		const hay = card.textContent.toLowerCase();
		const match = !q || hay.includes(q);
		card.hidden = !match;
		if (match) shown += 1;
	});

	if (q && shown === 0) {
		emptyEl.querySelector('span').textContent = input.value.trim();
		emptyEl.hidden = false;
		countEl.hidden = true;
	} else {
		emptyEl.hidden = true;
		countEl.hidden = false;
		countEl.textContent = q ? `${shown} of ${cards.length} terms` : `${cards.length} terms`;
	}
}

// Scroll to and flash the card named by the URL hash (/glossary#x402).
function highlightFromHash() {
	const id = decodeURIComponent((location.hash || '').replace(/^#/, ''));
	if (!id) return;
	const target = document.getElementById(id.startsWith('g-') ? id : 'g-' + id);
	if (!target) return;
	// Clearing any active filter guarantees the target is visible.
	if (input.value) { input.value = ''; applyFilter(); }
	target.scrollIntoView({ behavior: 'smooth', block: 'center' });
	target.focus({ preventScroll: true });
	grid.querySelectorAll('.glos-card.is-target').forEach((el) => el.classList.remove('is-target'));
	// Re-trigger the CSS animation on repeat visits to the same anchor.
	void target.offsetWidth;
	target.classList.add('is-target');
}

async function init() {
	const g = await waitForGlossary();
	if (!g) {
		grid.innerHTML = '';
		emptyEl.textContent = 'Glossary failed to load. Refresh to try again.';
		emptyEl.hidden = false;
		countEl.hidden = true;
		return;
	}

	render(g);

	let raf = 0;
	input.addEventListener('input', () => {
		cancelAnimationFrame(raf);
		raf = requestAnimationFrame(applyFilter);
	});

	window.addEventListener('hashchange', highlightFromHash);
	highlightFromHash();
}

init();
