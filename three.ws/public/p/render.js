// Public Launchpad renderer — hydrates a /p/<slug> page from
// /api/launchpad/get and wires the CTA to the configured monetization flow.
//
// Self-contained: only depends on the global <agent-3d> custom element
// (registered via /embed.js / agent-3d UMD on the published page) and
// fetch + DOM. No build step needed for this file — Vite copies it to dist
// alongside the HTML.

const AGENT_3D_HOST = 'https://three.ws';

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function short(addr) {
	if (!addr) return '';
	const s = String(addr);
	return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}
function priceLabel(m) {
	if (!m || !m.price) return '';
	const n = Number(m.price);
	return isFinite(n) && n > 0 ? `${n} ${m.currency || ''}`.trim() : '';
}

function slugFromPath() {
	const m = location.pathname.match(/^\/p\/([a-z0-9-]+)\/?$/i);
	return m ? m[1].toLowerCase() : '';
}

async function loadConfig(slug) {
	const r = await fetch(`/api/launchpad/get?slug=${encodeURIComponent(slug)}`);
	if (r.status === 404) return { notFound: true };
	if (!r.ok) throw new Error(`Failed to load launchpad (${r.status})`);
	return r.json();
}

function renderError(root, headline, body) {
	root.innerHTML = `
		<div class="error-page">
			<h1>${esc(headline)}</h1>
			<p>${esc(body)}</p>
			<a href="/launchpad">Build your own launchpad →</a>
		</div>
	`;
}

function renderPage(root, payload) {
	const { config, template, slug } = payload;
	const brand = config?.identity?.brand || '#ffffff';
	const theme = config?.identity?.theme === 'dark' ? 'dark' : 'light';
	const headline = config?.copy?.headline || 'three.ws launchpad';
	const tagline = config?.copy?.tagline || '';
	const website = config?.identity?.website || '';
	const wallet = config?.identity?.wallet || '';
	const avatarSrc = config?.avatar?.src || `${AGENT_3D_HOST}/avatars/default.glb`;
	const monetize = config?.monetize || {};

	// A token-launchpad page has two lives: before the coin is minted the CTA
	// launches it; once a mint is set it flips to a trade action. Honor the
	// creator's custom CTA label, but default the post-launch label to "Trade".
	let cta = config?.copy?.cta || 'Get started';
	if (template === 'token-launchpad' && config?.token?.mint) {
		const tk = config.token.ticker ? `$${config.token.ticker}` : 'the coin';
		cta = `Trade ${tk}`;
	}

	document.title = `${headline} — three.ws`;
	document.documentElement.style.setProperty('--brand', brand);

	root.innerHTML = `
		<div class="page ${theme}" style="--brand: ${esc(brand)}">
			<header class="page-header">
				<div class="brand">
					<span class="swatch"></span>
					<span>${esc(headline)}</span>
				</div>
				<nav class="links">
					${website ? `<a href="${esc(website)}" target="_blank" rel="noopener">Website</a>` : ''}
					<a href="${AGENT_3D_HOST}/launchpad?template=${esc(template)}" target="_blank" rel="noopener">Build yours</a>
				</nav>
			</header>
			<div class="hero">
				<div class="hero-copy">
					<h1>${esc(tagline || headline)}</h1>
					<p class="tagline">${esc(extraCopy(payload))}</p>
					<div class="cta-row">
						<button class="cta" type="button" data-cta>${esc(cta)}</button>
						${priceLabel(monetize) ? `<span class="price-chip">${esc(priceLabel(monetize))} per call</span>` : ''}
					</div>
					<div class="status-msg" data-status></div>
				</div>
				<div class="avatar-stage">
					<agent-3d
						src="${esc(avatarSrc)}"
						viewer
						background="transparent"
						camera-controls="auto"
						auto-rotate
					></agent-3d>
				</div>
			</div>
			<footer class="page-footer">
				Hosted on <a href="${AGENT_3D_HOST}" target="_blank" rel="noopener">three.ws</a> ·
				wallet ${esc(short(wallet) || 'not set')} ·
				<a href="${AGENT_3D_HOST}/launchpad?template=${esc(template)}" target="_blank" rel="noopener">build your own</a>
			</footer>
		</div>
	`;

	// Lazy-load agent-3d so we don't block paint.
	if (!customElements.get('agent-3d')) {
		const s = document.createElement('script');
		s.type = 'module';
		s.src = `${AGENT_3D_HOST}/embed.js`;
		document.head.appendChild(s);
	}

	const ctaBtn = root.querySelector('[data-cta]');
	const statusEl = root.querySelector('[data-status]');
	ctaBtn.addEventListener('click', () => onCtaClick(payload, ctaBtn, statusEl));
}

function extraCopy(payload) {
	const { template, config } = payload;
	const m = config?.monetize || {};
	if (template === 'token-launchpad') {
		const t = config?.token || {};
		const name = t.name || 'this coin';
		const ticker = t.ticker ? ` ($${t.ticker})` : '';
		if (t.mint) {
			return `${name}${ticker} is live on Pump.fun — trade it in one click, hosted by a 3D agent on three.ws.`;
		}
		return `Launch ${name}${ticker} on Pump.fun in one guided flow. Creator fees route to ${short(config?.identity?.wallet) || 'the creator wallet'}.`;
	}
	if (template === 'paid-concierge') {
		return `Ask anything. Each call costs ${priceLabel(m) || 'a small USDC fee'} and settles instantly to ${short(config?.identity?.wallet)}.`;
	}
	if (template === 'gated-showroom') {
		return `Unlock a private 3D scene with a one-time ${priceLabel(m) || 'USDC pass'}.`;
	}
	return '';
}

// CTA handler — each template hands off to its real flow.
function onCtaClick(payload, btn, statusEl) {
	const { template, config } = payload;
	if (template === 'token-launchpad') {
		const t = config?.token || {};
		// Already minted → send the visitor to the live coin to trade it.
		if (t.mint) {
			window.open(`${AGENT_3D_HOST}/launches/${encodeURIComponent(t.mint)}`, '_blank', 'noopener');
			statusEl.textContent = 'Opened the live coin — trade it on the next page.';
			statusEl.className = 'status-msg ok';
			return;
		}
		// Not minted yet → hand off to the real /launch flow with every field the
		// creator configured here pre-filled, so the coin launches as designed
		// rather than dropping the user onto a blank form.
		const params = new URLSearchParams();
		if (t.name) params.set('name', t.name);
		if (t.ticker) params.set('symbol', t.ticker);
		if (t.description) params.set('description', t.description);
		if (t.imageUrl) params.set('image', t.imageUrl);
		const initialBuy = Number(config?.monetize?.price);
		if (isFinite(initialBuy) && initialBuy > 0) params.set('initialBuy', String(initialBuy));
		const qs = params.toString();
		window.open(`${AGENT_3D_HOST}/launch${qs ? `?${qs}` : ''}`, '_blank', 'noopener');
		statusEl.textContent = 'Opened the launch flow with your coin details pre-filled.';
		statusEl.className = 'status-msg ok';
		return;
	}
	if (template === 'paid-concierge') {
		openPaidModal(payload, statusEl, 'concierge');
		return;
	}
	if (template === 'gated-showroom') {
		openPaidModal(payload, statusEl, 'unlock');
		return;
	}
	statusEl.textContent = 'No action wired for this template yet.';
	statusEl.className = 'status-msg err';
}

// Format the live x402 402 challenge for a human. The published page is not a
// wallet — an x402-capable wallet or agent settles the payment and retries —
// so we surface the real amount, recipient, and network from the challenge.
function challengeSummary(challenge) {
	const a = Array.isArray(challenge?.accepts) ? challenge.accepts[0] : null;
	if (!a) return 'Payment required — settle the x402 invoice in your wallet, then retry.';
	const usdc = a.amount ? (Number(a.amount) / 1e6).toLocaleString(undefined, { maximumFractionDigits: 6 }) : '';
	const net = String(a.network || '').startsWith('solana') ? 'Solana' : 'Base';
	return `Pay ${usdc} USDC to ${short(a.payTo)} on ${net} with your x402 wallet, then retry.`;
}

// Shared modal for both paid templates. `mode` is 'concierge' (asks a question)
// or 'unlock' (reveals a gated scene). Keyboard-operable: Escape closes, focus
// is trapped, and the first control is focused on open.
function openPaidModal(payload, statusEl, mode) {
	const { slug, config } = payload;
	const m = config?.monetize || {};
	const isAsk = mode === 'concierge';
	const backdrop = document.createElement('div');
	backdrop.className = 'modal-backdrop';
	backdrop.innerHTML = `
		<div class="modal" role="dialog" aria-modal="true" aria-labelledby="lp-modal-title">
			<h2 id="lp-modal-title">${isAsk ? 'Ask the concierge' : 'Unlock the room'}</h2>
			<p>${isAsk
				? `Costs ${esc(priceLabel(m) || 'a small USDC fee')}. Settles to ${esc(short(config?.identity?.wallet))} on ${esc(m.chain || 'base')}.`
				: `One-time ${esc(priceLabel(m) || 'USDC pass')} grants 24 h access. Settles to ${esc(short(config?.identity?.wallet))}.`}</p>
			${isAsk ? `
				<div class="field">
					<label for="lp-modal-q">Your question</label>
					<input id="lp-modal-q" type="text" data-q placeholder="What's the best way to..." />
				</div>` : ''}
			<div class="status-msg" data-modal-status role="status" aria-live="polite"></div>
			<div class="modal-actions">
				<button class="secondary" type="button" data-cancel>Cancel</button>
				<button class="primary" type="button" data-pay>${isAsk ? `Pay ${esc(priceLabel(m) || '')}`.trim() : 'Pay & enter'}</button>
			</div>
		</div>
	`;
	document.body.appendChild(backdrop);

	const lastFocused = document.activeElement;
	const close = () => {
		backdrop.remove();
		document.removeEventListener('keydown', onKey, true);
		if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
	};
	const focusables = () =>
		[...backdrop.querySelectorAll('input,button,[href],[tabindex]:not([tabindex="-1"])')].filter(
			(n) => !n.disabled && n.offsetParent !== null,
		);
	function onKey(e) {
		if (e.key === 'Escape') { e.preventDefault(); close(); return; }
		if (e.key === 'Tab') {
			const f = focusables();
			if (!f.length) return;
			const first = f[0], last = f[f.length - 1];
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
	}
	document.addEventListener('keydown', onKey, true);
	backdrop.querySelector('[data-cancel]').addEventListener('click', close);
	backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
	(backdrop.querySelector('[data-q]') || backdrop.querySelector('[data-pay]')).focus();

	backdrop.querySelector('[data-pay]').addEventListener('click', async () => {
		const ms = backdrop.querySelector('[data-modal-status]');
		const qEl = backdrop.querySelector('[data-q]');
		const question = qEl ? qEl.value.trim() : '';
		if (isAsk && !question) { ms.textContent = 'Type a question first.'; ms.className = 'status-msg err'; return; }
		ms.textContent = isAsk ? 'Requesting an answer…' : 'Requesting unlock…';
		ms.className = 'status-msg';
		try {
			const r = await fetch(`/api/launchpad/invoke?slug=${encodeURIComponent(slug)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(isAsk ? { question } : {}),
			});
			if (r.status === 402) {
				ms.textContent = challengeSummary(await r.json().catch(() => null));
				ms.className = 'status-msg';
				return;
			}
			if (!r.ok) {
				const e = await r.json().catch(() => null);
				throw new Error(e?.message || `Service error (${r.status})`);
			}
			const data = await r.json();
			if (isAsk) {
				ms.textContent = data?.answer || 'Reply received.';
				ms.className = 'status-msg ok';
				statusEl.textContent = 'Concierge replied — see the panel.';
				statusEl.className = 'status-msg ok';
			} else if (data?.unlockUrl) {
				window.open(data.unlockUrl, '_blank', 'noopener');
				close();
				statusEl.textContent = 'Room unlocked — opened in a new tab.';
				statusEl.className = 'status-msg ok';
			} else {
				ms.textContent = 'Unlocked, but no scene URL was returned.';
				ms.className = 'status-msg err';
			}
		} catch (err) {
			ms.textContent = err.message || 'Something went wrong.';
			ms.className = 'status-msg err';
		}
	});
}

// ─────── Boot ───────
const slug = slugFromPath();
const root = document.getElementById('root');

if (!slug) {
	renderError(root, 'No launchpad slug', 'Try /p/<your-slug> or build a new one.');
} else {
	loadConfig(slug)
		.then((payload) => {
			if (payload.notFound) {
				renderError(root, '404 — not found', `No launchpad published at /p/${slug}.`);
				return;
			}
			renderPage(root, payload);
		})
		.catch((err) => {
			renderError(root, 'Could not load launchpad', err.message || String(err));
		});
}
