// Self-contained wallet affordance for <three-ws-viewer>.
//
// The minimal mesh viewer has no agent runtime, so when an embedder opts in with
// `wallet agent-id="<uuid>"` we render the agent's wallet identity here without
// pulling the heavy <agent-3d> runtime, a wallet SDK, or any dependency. It reads
// ONLY public data from three.ws's CORS:* embed endpoint
// (GET /api/agents/wallet-embed) — address, live USD value, lifetime tips — and
// is the visitor view by construction: copy the address, tip from a phone wallet
// via a Solana Pay deep link, or open the full wallet on three.ws. It never
// exposes a secret or an owner control; ownership is decided only by a real
// three.ws session, never asserted by the embedding host.
//
// Kept dependency-free on purpose: the published @three-ws/avatar package must
// not depend on the main app's internal modules. The richer in-app/off-site
// wallet (connected-wallet signing, QR) lives on <agent-3d wallet>.

const ORIGIN_DEFAULT = 'https://three.ws';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esc(s) {
	return String(s == null ? '' : s).replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
	);
}

function fmtUsd(n) {
	if (n == null || !Number.isFinite(n)) return null;
	if (n <= 0) return '$0';
	if (n < 0.01) return '<$0.01';
	if (n < 10) return `$${n.toFixed(2)}`;
	if (n < 1000) return `$${Math.round(n)}`;
	if (n < 1e6) return `$${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K`;
	if (n < 1e9) return `$${(n / 1e6).toFixed(1)}M`;
	return `$${(n / 1e9).toFixed(1)}B`;
}

function shortAddr(address, vanity) {
	const a = String(address || '');
	if (!a) return '';
	const pre = vanity?.prefix && a.startsWith(vanity.prefix) ? vanity.prefix : a.slice(0, 4);
	const suf = vanity?.suffix && a.endsWith(vanity.suffix) ? vanity.suffix : a.slice(-4);
	return `${esc(pre)}…${esc(suf)}`;
}

// Solana Pay URI — opens Phantom/Solflare on a phone for a real, one-tap tip.
function solanaPayUri(address, { label } = {}) {
	const params = new URLSearchParams();
	if (label) params.set('label', label);
	const q = params.toString();
	return `solana:${address}${q ? `?${q}` : ''}`;
}

const STYLE = `
.tws-w{position:absolute;left:10px;bottom:10px;z-index:6;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;}
.tws-w *{box-sizing:border-box;}
.tws-w-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;cursor:pointer;appearance:none;
	font:600 11px/1 inherit;color:#c4b5fd;background:rgba(139,92,246,.14);border:1px solid rgba(139,92,246,.34);
	white-space:nowrap;transition:background .18s,border-color .18s;backdrop-filter:blur(8px);}
.tws-w-chip:hover{background:rgba(139,92,246,.22);border-color:rgba(139,92,246,.55);}
.tws-w-ico{width:12px;height:12px;flex:none;opacity:.85;}
.tws-w-addr{font-family:ui-monospace,"JetBrains Mono",Menlo,monospace;letter-spacing:.01em;}
.tws-w-val{font-family:ui-monospace,Menlo,monospace;font-weight:700;color:#fff;border-left:1px solid rgba(139,92,246,.34);padding-left:6px;}
.tws-w-pop{margin-bottom:7px;width:248px;max-width:60vw;background:rgba(16,16,20,.97);border:1px solid rgba(139,92,246,.5);
	border-radius:13px;padding:12px;box-shadow:0 18px 46px rgba(0,0,0,.55);backdrop-filter:blur(12px);color:#e8e8ea;
	font-size:12px;line-height:1.45;}
.tws-w-pop[hidden]{display:none;}
.tws-w-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.tws-w-av{width:28px;height:28px;border-radius:7px;object-fit:cover;background:rgba(255,255,255,.08);flex:none;}
.tws-w-name{font-weight:700;color:#fff;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.tws-w-sub{font-size:10px;color:#9a9aa2;}
.tws-w-total{display:flex;align-items:flex-end;justify-content:space-between;gap:8px;margin-bottom:9px;}
.tws-w-usd{font:800 21px/1 "Space Grotesk",ui-sans-serif,system-ui;color:#fff;}
.tws-w-usdl{font-size:9px;color:#9a9aa2;text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px;}
.tws-w-tips{text-align:right;font-size:10px;color:#9a9aa2;}
.tws-w-tips b{display:block;color:#c4b5fd;font:700 13px/1 ui-monospace,Menlo,monospace;}
.tws-w-addrline{display:flex;align-items:center;gap:6px;font-family:ui-monospace,Menlo,monospace;font-size:10.5px;
	background:rgba(255,255,255,.04);border-radius:8px;padding:6px 8px;margin-bottom:9px;}
.tws-w-mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#9a9aa2;}
.tws-w-cp{appearance:none;background:none;border:none;padding:2px;cursor:pointer;color:#c4b5fd;opacity:.75;display:inline-flex;}
.tws-w-cp:hover{opacity:1;}
.tws-w-cp svg{width:13px;height:13px;}
.tws-w-acts{display:flex;gap:6px;}
.tws-w-btn{flex:1 1 auto;appearance:none;cursor:pointer;text-decoration:none;text-align:center;font:700 11px/1 inherit;
	border-radius:999px;padding:8px 10px;border:1px solid rgba(139,92,246,.5);background:rgba(139,92,246,.12);color:#c4b5fd;
	display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:background .15s,color .15s;}
.tws-w-btn:hover{background:rgba(139,92,246,.22);color:#fff;}
.tws-w-btn-primary{background:linear-gradient(135deg,#c4b5fd,#a78bfa);color:#0a0a0a;border-color:transparent;}
.tws-w-pending{display:inline-flex;align-items:center;gap:6px;padding:4px 9px;border-radius:999px;font:600 11px/1 inherit;
	color:#9a9aa2;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.12);backdrop-filter:blur(8px);}
@media (prefers-reduced-motion: reduce){.tws-w-chip,.tws-w-btn{transition:none;}}
`;

const WALLET_SVG =
	'<svg class="tws-w-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/></svg>';
const COPY_SVG =
	'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

/**
 * Mount a self-contained wallet affordance into a host (Element or ShadowRoot).
 *
 * @param {Element|ShadowRoot} host
 * @param {object} opts
 * @param {string} opts.agentId            Agent UUID.
 * @param {string} [opts.apiBase]          three.ws origin (default https://three.ws).
 * @param {'mainnet'|'devnet'} [opts.network]
 * @returns {{ destroy: () => void }}
 */
export function mountSdkWallet(host, opts = {}) {
	const { agentId, apiBase = ORIGIN_DEFAULT, network = 'mainnet' } = opts;
	const origin = String(apiBase || ORIGIN_DEFAULT).replace(/\/$/, '');

	const style = document.createElement('style');
	style.textContent = STYLE;
	const root = document.createElement('div');
	root.className = 'tws-w';
	host.appendChild(style);
	host.appendChild(root);

	let card = null;
	let open = false;
	let destroyed = false;

	if (!agentId || !UUID_RE.test(String(agentId))) {
		root.remove();
		style.remove();
		return { destroy() {} };
	}

	function render() {
		if (destroyed) return;
		if (!card) {
			root.innerHTML = `<span class="tws-w-pending">${WALLET_SVG}<span>Wallet…</span></span>`;
			return;
		}
		if (!card.address || !BASE58_RE.test(String(card.address))) {
			root.innerHTML =
				`<a class="tws-w-pending" href="${esc(card.openUrl || origin)}" target="_blank" rel="noopener" style="text-decoration:none">${WALLET_SVG}<span>Wallet pending</span></a>`;
			return;
		}
		const usd = fmtUsd(card.balanceUsd);
		const tips = card.tips?.count || 0;
		const tipsUsd = fmtUsd(card.tips?.usd);
		const pay = solanaPayUri(card.address, { label: card.name || 'three.ws agent' });
		root.innerHTML =
			`<div class="tws-w-pop" role="dialog" aria-label="${esc(card.name || 'Agent')} wallet" ${open ? '' : 'hidden'}>` +
			`<div class="tws-w-head">` +
			(card.avatar ? `<img class="tws-w-av" src="${esc(card.avatar)}" alt="" loading="lazy">` : `<span class="tws-w-av"></span>`) +
			`<div style="min-width:0"><div class="tws-w-name">${esc(card.name || 'Agent')}</div><div class="tws-w-sub">Agent wallet · Solana</div></div></div>` +
			`<div class="tws-w-total"><div><div class="tws-w-usdl">Wallet value</div><div class="tws-w-usd">${esc(usd || '$0')}</div></div>` +
			(tips > 0 ? `<div class="tws-w-tips"><b>${tips}</b>tip${tips === 1 ? '' : 's'}${tipsUsd ? ` · ${esc(tipsUsd)}` : ''}</div>` : '') +
			`</div>` +
			`<div class="tws-w-addrline"><span class="tws-w-mono">${esc(card.address)}</span>` +
			`<button type="button" class="tws-w-cp" data-copy title="Copy address" aria-label="Copy wallet address">${COPY_SVG}</button></div>` +
			`<div class="tws-w-acts">` +
			`<a class="tws-w-btn tws-w-btn-primary" href="${esc(pay)}">◎ Tip</a>` +
			`<a class="tws-w-btn" href="${esc(card.walletUrl || card.openUrl)}" target="_blank" rel="noopener">Open ↗</a>` +
			`</div></div>` +
			`<button type="button" class="tws-w-chip" data-toggle aria-haspopup="dialog" aria-expanded="${open ? 'true' : 'false'}">` +
			WALLET_SVG +
			`<span class="tws-w-addr">${shortAddr(card.address, card.vanity)}</span>` +
			(usd != null ? `<span class="tws-w-val">${esc(usd)}</span>` : '') +
			`</button>`;
		wire();
	}

	function wire() {
		const toggle = root.querySelector('[data-toggle]');
		const pop = root.querySelector('.tws-w-pop');
		toggle?.addEventListener('click', () => {
			open = !open;
			toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
			if (pop) pop.hidden = !open;
		});
		root.querySelector('[data-copy]')?.addEventListener('click', async (e) => {
			const btn = e.currentTarget;
			try {
				await navigator.clipboard.writeText(card.address);
				btn.style.color = '#4ade80';
				setTimeout(() => { btn.style.color = ''; }, 1200);
			} catch { /* clipboard denied — address is still visible */ }
		});
	}

	render();
	fetch(`${origin}/api/agents/wallet-embed?id=${encodeURIComponent(agentId)}&network=${encodeURIComponent(network)}`, {
		headers: { accept: 'application/json' },
	})
		.then((r) => (r.ok ? r.json() : null))
		.then((j) => {
			if (destroyed) return;
			card = j?.data || { agentId, address: null, openUrl: `${origin}/agent/${agentId}` };
			render();
		})
		.catch(() => {
			if (destroyed) return;
			card = { agentId, address: null, openUrl: `${origin}/agent/${agentId}` };
			render();
		});

	return {
		destroy() {
			destroyed = true;
			root.remove();
			style.remove();
		},
	};
}
