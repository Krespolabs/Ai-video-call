// dashboard-next — $THREE Holders page.
//
// Public-facing holder leaderboard + the signed-in user's standing + a
// holder-gated, shareable badge. Three real data sources, all server-side:
//   GET /api/three-token/leaderboard   — ranked holders (Helius-backed, cached)
//   the shared $THREE store             — the viewer's own position (price/%/USD)
// The badge gate keys off the store's position, which is computed server-side
// from /api/wallet/balances — never a client-asserted balance.

import { mountShell } from '../shell.js';
import { requireUser, get, esc, ApiError } from '../api.js';
import { createThreeTokenData } from '../../pump/three-token-data.js';
import { log } from '../../shared/log.js';
import { skeletonHTML, emptyStateHTML, errorStateHTML, ensureStateKitStyles } from '../../shared/state-kit.js';

const MONO = `'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace`;
const PAGE_SIZE = 25;

// ── formatters ──────────────────────────────────────────────────────────────

function fmtCompact(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
	if (v >= 1_000) return `${(v / 1_000).toFixed(2)}K`;
	return v.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
function fmtUsd(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: v < 1 ? 6 : 2 });
}
function fmtPct(n) {
	const v = Number(n);
	if (!Number.isFinite(v)) return '—';
	return `${v.toFixed(v < 0.01 ? 4 : 2)}%`;
}

// Holder tier from share of supply — drives the badge styling/label.
function tierFor(pctOfSupply) {
	const p = Number(pctOfSupply);
	if (Number.isFinite(p)) {
		if (p >= 0.01) return { key: 'whale', label: 'Whale', accent: '#7CC4FF' };
		if (p >= 0.001) return { key: 'major', label: 'Major Holder', accent: '#A6E3A1' };
	}
	return { key: 'holder', label: 'Holder', accent: '#F5C518' };
}

// ── boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
	try {
		const main = await mountShell();
		await requireUser();

		main.innerHTML = `
			<div style="margin-bottom:6px">
				<div style="display:flex;align-items:center;gap:12px;margin-bottom:4px">
					<div style="width:36px;height:36px;border-radius:10px;background:#111116;border:1px solid #232329;display:grid;place-items:center;flex-shrink:0;overflow:hidden"><img loading="lazy" decoding="async" src="/favicon.svg" alt="three.ws" width="26" height="26" style="display:block" /></div>
					<div>
						<h1 class="dn-h1" style="margin:0">$THREE Holders</h1>
						<p class="dn-h1-sub" style="margin:0">The on-chain holder leaderboard for the protocol token</p>
					</div>
				</div>
			</div>
			<div data-slot="content" style="display:flex;flex-direction:column;gap:20px">
				<div class="dn-skeleton" style="height:150px;border-radius:12px"></div>
				<div class="dn-skeleton" style="height:420px;border-radius:12px"></div>
			</div>
		`;

		const host = main.querySelector('[data-slot="content"]');

		// Shared store gives the viewer's own position (server-derived balance).
		const store = createThreeTokenData({ pollMs: 60_000, anchorEl: host });

		host.innerHTML = '';
		const standing = renderStanding(store);
		const badge = renderBadge(store);
		const board = renderLeaderboard(store);
		host.appendChild(standing);
		host.appendChild(badge);
		host.appendChild(board.el);

		// First board load.
		board.load(0);
	} catch (err) {
		if (err instanceof ApiError && err.status === 401) {
			location.href = `/login?return=${encodeURIComponent(location.pathname)}`;
		} else throw err;
	}
})();

// ── Your standing (from the shared store position) ──────────────────────────────

function renderStanding(store) {
	const section = document.createElement('div');
	section.className = 'dn-panel';
	section.setAttribute('aria-label', 'Your $THREE standing');
	section.innerHTML = `
		<div style="font-size:11.5px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:12px">Your Standing</div>
		<div data-slot="standing-body"></div>
	`;
	const body = section.querySelector('[data-slot="standing-body"]');

	const render = (state) => {
		const pos = state.position;
		const token = state.protocol.token || {};
		body.innerHTML = standingBody(pos, token);
	};
	const unsub = store.subscribe(render);

	// Delegated so the inline Retry (re-rendered on each state change) recovers
	// the position without a full page reload.
	section.addEventListener('click', (e) => {
		const btn = e.target.closest('[data-action="retry-standing"]');
		if (!btn) return;
		btn.disabled = true;
		Promise.resolve(store.refreshPosition()).finally(() => { btn.disabled = false; });
	});

	new MutationObserver((_m, obs) => {
		if (!section.isConnected) { unsub(); obs.disconnect(); }
	}).observe(document.body, { childList: true, subtree: true });

	return section;
}

function standingBody(pos, token) {
	switch (pos.status) {
		case 'idle':
		case 'loading':
			return `<div class="dn-skeleton" style="height:60px;border-radius:10px" aria-busy="true"></div>`;
		case 'unauthenticated':
			return emptyRow('Sign in to see your standing.', 'Sign in', `/login?return=${encodeURIComponent(location.pathname)}`);
		case 'no_wallet':
			return emptyRow('Link a Solana wallet to appear on the leaderboard.', 'Link wallet', '/dashboard/account');
		case 'zero':
			return emptyRow('You don’t hold $THREE yet — acquire some to climb the board.', 'Get $THREE', `https://pump.fun/coin/${esc(token.mint || '')}`, true);
		case 'error':
			return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
					<span style="color:var(--nxt-ink-fade);font-size:13.5px">Couldn’t load your standing right now.</span>
					<button type="button" data-action="retry-standing" class="dn-btn" style="font-size:12px;padding:4px 10px">Retry</button>
				</div>`;
		case 'ok': {
			const tier = tierFor(pos.pctOfSupply);
			const cells = [
				{ label: 'Holding', value: `${fmtCompact(pos.amount)} <span style="font-size:12px;color:var(--nxt-ink-fade)">$THREE</span>` },
				{ label: 'Value', value: pos.usd != null ? fmtUsd(pos.usd) : '—' },
				{ label: 'Share of supply', value: pos.pctOfSupply != null ? fmtPct(pos.pctOfSupply * 100) : '—' },
				{ label: 'Tier', value: `<span style="color:${tier.accent};font-weight:700">${tier.label}</span>` },
			];
			return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px">
				${cells.map((c) => `<div>
					<div style="font-size:11px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:4px">${esc(c.label)}</div>
					<div style="font-size:19px;font-weight:700;font-family:${MONO}">${c.value}</div>
				</div>`).join('')}
			</div>`;
		}
		default:
			return '';
	}
}

// ── Holder badge (gated, shareable) ─────────────────────────────────────────────

function renderBadge(store) {
	const section = document.createElement('div');
	section.className = 'dn-panel';
	section.setAttribute('aria-label', 'Your holder badge');
	section.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.06em">Holder Badge</div>
			<button data-action="download-badge" class="dn-btn" disabled aria-label="Download your holder badge as a PNG image" style="font-size:12px;padding:4px 10px">Download PNG</button>
		</div>
		<div data-slot="badge-body"></div>
	`;
	const body = section.querySelector('[data-slot="badge-body"]');
	const dlBtn = section.querySelector('[data-action="download-badge"]');

	let current = null; // last { pos, token } when eligible, for export

	const render = (state) => {
		const pos = state.position;
		const token = state.protocol.token || {};
		if (pos.status === 'ok' && Number(pos.amount) > 0) {
			current = { pos, token };
			body.innerHTML = badgeSvg(pos, token);
			dlBtn.disabled = false;
		} else {
			current = null;
			dlBtn.disabled = true;
			body.innerHTML = badgeLocked(pos, token);
		}
	};
	const unsub = store.subscribe(render);

	dlBtn.addEventListener('click', () => {
		if (!current) return;
		dlBtn.disabled = true;
		downloadBadgePng(body.querySelector('svg'))
			.catch((e) => log.error('[holders] badge export failed', e))
			.finally(() => { dlBtn.disabled = false; });
	});

	new MutationObserver((_m, obs) => {
		if (!section.isConnected) { unsub(); obs.disconnect(); }
	}).observe(document.body, { childList: true, subtree: true });

	return section;
}

function badgeLocked(pos, token) {
	const msg = pos.status === 'unauthenticated'
		? 'Sign in and hold $THREE to unlock your shareable holder badge.'
		: pos.status === 'no_wallet'
			? 'Link a Solana wallet that holds $THREE to unlock your badge.'
			: 'Hold any amount of $THREE to unlock your shareable holder badge.';
	return `<div style="display:flex;align-items:center;gap:16px;flex-wrap:wrap">
		<div aria-hidden="true" style="width:120px;height:68px;border-radius:10px;border:1px dashed var(--nxt-line);display:grid;place-items:center;color:var(--nxt-ink-fade);font-size:22px">🔒</div>
		<div style="flex:1;min-width:200px">
			<div style="font-size:13.5px;color:var(--nxt-ink-fade);margin-bottom:8px">${esc(msg)}</div>
			<a class="dn-btn" href="https://pump.fun/coin/${esc(token.mint || '')}" target="_blank" rel="noopener" style="font-size:12.5px">Get $THREE</a>
		</div>
	</div>`;
}

// A self-contained SVG badge — no external images, so it exports to PNG cleanly.
function badgeSvg(pos, token) {
	const tier = tierFor(pos.pctOfSupply);
	const amount = fmtCompact(pos.amount);
	const pct = pos.pctOfSupply != null ? fmtPct(pos.pctOfSupply * 100) : '—';
	const wallet = pos.wallet ? `${pos.wallet.slice(0, 4)}…${pos.wallet.slice(-4)}` : '';
	return `
	<svg viewBox="0 0 600 320" width="100%" style="max-width:480px;border-radius:14px;display:block" role="img" aria-label="$THREE ${esc(tier.label)} badge" xmlns="http://www.w3.org/2000/svg">
		<defs>
			<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
				<stop offset="0" stop-color="#0b0b0f"/><stop offset="1" stop-color="#15151c"/>
			</linearGradient>
			<radialGradient id="glow" cx="0.8" cy="0.15" r="0.8">
				<stop offset="0" stop-color="${tier.accent}" stop-opacity="0.18"/><stop offset="1" stop-color="${tier.accent}" stop-opacity="0"/>
			</radialGradient>
		</defs>
		<rect width="600" height="320" rx="16" fill="url(#bg)"/>
		<rect width="600" height="320" rx="16" fill="url(#glow)"/>
		<rect x="1" y="1" width="598" height="318" rx="15" fill="none" stroke="${tier.accent}" stroke-opacity="0.35"/>
		<g font-family="${MONO}">
			<text x="36" y="58" fill="#ffffff" font-size="13" letter-spacing="3" opacity="0.7">THREE.WS · PROTOCOL TOKEN</text>
			<text x="36" y="120" fill="#ffffff" font-size="40" font-weight="800">$THREE ${esc(tier.label)}</text>
			<text x="36" y="186" fill="${tier.accent}" font-size="52" font-weight="800">${esc(amount)}</text>
			<text x="36" y="214" fill="#ffffff" font-size="15" opacity="0.7">$THREE held · ${esc(pct)} of supply</text>
			<text x="36" y="276" fill="#ffffff" font-size="14" opacity="0.55">${esc(wallet)}</text>
			<text x="430" y="276" fill="#ffffff" font-size="14" opacity="0.55">three.ws/holders</text>
			<circle cx="540" cy="64" r="26" fill="none" stroke="${tier.accent}" stroke-opacity="0.6"/>
			<text x="540" y="71" fill="#ffffff" font-size="22" font-weight="800" text-anchor="middle">3</text>
		</g>
	</svg>`;
}

async function downloadBadgePng(svgEl) {
	if (!svgEl) return;
	const xml = new XMLSerializer().serializeToString(svgEl);
	const svg64 = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(xml)))}`;
	const img = new Image();
	img.crossOrigin = 'anonymous';
	await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = svg64; });
	const scale = 2; // retina
	const canvas = document.createElement('canvas');
	canvas.width = 600 * scale;
	canvas.height = 320 * scale;
	const ctx = canvas.getContext('2d');
	ctx.scale(scale, scale);
	ctx.drawImage(img, 0, 0, 600, 320);
	const url = canvas.toDataURL('image/png');
	const a = document.createElement('a');
	a.href = url;
	a.download = 'three-holder-badge.png';
	document.body.appendChild(a);
	a.click();
	a.remove();
}

// ── Leaderboard ─────────────────────────────────────────────────────────────────

function renderLeaderboard(store) {
	const section = document.createElement('div');
	section.className = 'dn-panel';
	section.setAttribute('aria-label', '$THREE holder leaderboard');
	section.innerHTML = `
		<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
			<div style="font-size:11.5px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.06em">Leaderboard</div>
			<div data-slot="lb-meta" style="font-size:12px;color:var(--nxt-ink-fade)"></div>
		</div>
		<div data-slot="lb-body"></div>
		<div data-slot="lb-pager" style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:14px"></div>
	`;
	const body = section.querySelector('[data-slot="lb-body"]');
	const meta = section.querySelector('[data-slot="lb-meta"]');
	const pager = section.querySelector('[data-slot="lb-pager"]');

	let offset = 0;
	let total = 0;
	let loading = false;

	// Resolve the viewer's wallet from the store so we can highlight their row.
	const myWallet = () => store.getState().position.wallet || null;

	async function load(nextOffset) {
		if (loading) return;
		loading = true;
		offset = Math.max(0, nextOffset);
		body.innerHTML = `<div style="display:flex;flex-direction:column;gap:2px" aria-busy="true" aria-label="Loading leaderboard">${skeletonHTML(8, 'row')}</div>`;
		pager.innerHTML = '';
		try {
			const data = await get(`/api/three-token/leaderboard?limit=${PAGE_SIZE}&offset=${offset}`);
			total = Number(data?.total) || 0;
			const rows = Array.isArray(data?.holders) ? data.holders : [];
			if (!rows.length) {
				body.innerHTML = emptyBoard(offset);
				meta.textContent = total ? `${total.toLocaleString()} holders` : '';
			} else {
				body.innerHTML = boardTable(rows, myWallet());
				meta.textContent = `${total.toLocaleString()} holders`;
			}
			renderPager();
		} catch (err) {
			log.error('[holders] leaderboard load failed', err);
			ensureStateKitStyles();
			body.innerHTML = errorStateHTML({
				title: "Couldn't load the leaderboard",
				body: 'The on-chain holder index was unreachable. Check your connection and try again.',
			});
			body.querySelector('[data-sk-retry]')?.addEventListener('click', () => load(offset));
		} finally {
			loading = false;
		}
	}

	function renderPager() {
		const page = Math.floor(offset / PAGE_SIZE) + 1;
		const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
		const hasPrev = offset > 0;
		const hasNext = offset + PAGE_SIZE < total;
		pager.innerHTML = `
			<button data-action="prev" class="dn-btn" ${hasPrev ? '' : 'disabled'} style="font-size:12px;padding:5px 12px">‹ Prev</button>
			<span style="font-size:12px;color:var(--nxt-ink-fade)">Page ${page} of ${pages}</span>
			<button data-action="next" class="dn-btn" ${hasNext ? '' : 'disabled'} style="font-size:12px;padding:5px 12px">Next ›</button>
		`;
		pager.querySelector('[data-action="prev"]').addEventListener('click', () => hasPrev && load(offset - PAGE_SIZE));
		pager.querySelector('[data-action="next"]').addEventListener('click', () => hasNext && load(offset + PAGE_SIZE));
	}

	// Re-highlight the viewer's row once their wallet resolves from the store.
	const unsub = store.subscribe(() => {
		const w = myWallet();
		if (!w) return;
		const rows = section.querySelectorAll('[data-wallet]');
		rows.forEach((r) => {
			const mine = r.getAttribute('data-wallet') === w;
			r.style.background = mine ? 'rgba(245,197,24,0.10)' : '';
		});
	});
	new MutationObserver((_m, obs) => {
		if (!section.isConnected) { unsub(); obs.disconnect(); }
	}).observe(document.body, { childList: true, subtree: true });

	return { el: section, load };
}

function boardTable(rows, myWallet) {
	const head = `
		<div role="row" style="display:grid;grid-template-columns:56px 1fr 120px 110px;gap:8px;padding:0 10px 8px;font-size:11px;color:var(--nxt-ink-fade);text-transform:uppercase;letter-spacing:0.05em">
			<div role="columnheader">Rank</div><div role="columnheader">Holder</div><div role="columnheader" style="text-align:right">$THREE</div><div role="columnheader" style="text-align:right">% Supply</div>
		</div>`;
	const body = rows.map((h) => {
		const mine = myWallet && h.wallet === myWallet;
		const medal = h.rank === 1 ? '🥇' : h.rank === 2 ? '🥈' : h.rank === 3 ? '🥉' : `#${h.rank}`;
		const shortWallet = h.wallet_short || h.wallet || '';
		const pctText = h.pct_of_supply != null ? fmtPct(h.pct_of_supply * 100) : '—';
		const rowLabel = `Rank ${h.rank}${mine ? ' (you)' : ''}: ${shortWallet}, ${fmtCompact(h.amount)} $THREE, ${pctText} of supply`;
		return `
		<div role="row" data-wallet="${esc(h.wallet)}" aria-label="${esc(rowLabel)}" style="display:grid;grid-template-columns:56px 1fr 120px 110px;gap:8px;align-items:center;padding:9px 10px;border-radius:8px;${mine ? 'background:rgba(245,197,24,0.10);' : ''}font-size:13.5px;transition:background .12s">
			<div role="cell" style="font-weight:700;font-family:${MONO}"><span aria-hidden="true">${medal}</span></div>
			<div role="cell" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
				<a href="https://solscan.io/account/${esc(h.wallet)}" target="_blank" rel="noopener" style="font-family:${MONO};color:inherit;text-decoration:none" title="View ${esc(h.wallet)} on Solscan">${esc(shortWallet)}</a>
				${mine ? '<span style="margin-left:8px;font-size:10.5px;color:#F5C518;font-weight:700">YOU</span>' : ''}
			</div>
			<div role="cell" style="text-align:right;font-family:${MONO}">${fmtCompact(h.amount)}</div>
			<div role="cell" style="text-align:right;font-family:${MONO};color:var(--nxt-ink-fade)">${pctText}</div>
		</div>`;
	}).join('');
	return `<div style="overflow-x:auto"><div role="table" aria-label="$THREE holder leaderboard" style="min-width:440px">${head}<div style="display:flex;flex-direction:column;gap:2px">${body}</div></div></div>`;
}

function emptyBoard(offset) {
	ensureStateKitStyles();
	if (offset > 0) {
		return emptyStateHTML({
			icon: '',
			title: 'No more holders',
			body: "You've reached the end of the leaderboard. Go back a page to see the top holders.",
			compact: true,
		});
	}
	return emptyStateHTML({
		icon: '🏆',
		title: 'No holders to show yet',
		body: 'The leaderboard fills as wallets acquire $THREE. Be one of the first to claim a spot.',
		actions: [
			{ label: 'View $THREE', href: '/dashboard/three-token', primary: true },
		],
	});
}

function emptyRow(message, ctaLabel, href, external = false) {
	return `<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
		<span style="color:var(--nxt-ink-fade);font-size:13.5px">${esc(message)}</span>
		<a class="dn-btn" href="${esc(href)}" ${external ? 'target="_blank" rel="noopener"' : ''} style="font-size:12.5px;white-space:nowrap">${esc(ctaLabel)}</a>
	</div>`;
}
