// /gas — live Ethereum gas tracker, adopted from the cryptocurrency.cv gas
// surface: three speed tiers in gwei with USD cost estimates for common
// actions. Data is real on-chain fee history via /api/coin/gas (public RPC +
// live ETH price) — auto-refreshing, never mocked.

import { escapeHtml as esc } from './shared/coin-format.js';

const $ = (id) => document.getElementById(id);
const REFRESH_MS = 15_000;

async function getJson(url) {
	const res = await fetch(url, { headers: { accept: 'application/json' } });
	if (!res.ok) {
		const err = new Error(`fetch ${url} → ${res.status}`);
		err.status = res.status;
		throw err;
	}
	return res.json();
}

const TIER_META = {
	slow: { name: 'Slow', sub: 'Lowest fee · may wait', cls: 'slow' },
	standard: { name: 'Standard', sub: 'Confirms in a few blocks', cls: 'standard' },
	fast: { name: 'Fast', sub: 'Front of the queue', cls: 'fast' },
};

function gwei(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	return n >= 100 ? n.toFixed(0) : n.toFixed(n >= 10 ? 1 : 2);
}

function usd(n) {
	if (n == null || !Number.isFinite(n)) return '—';
	if (n < 0.01) return '<$0.01';
	if (n < 1) return `$${n.toFixed(3)}`;
	if (n < 100) return `$${n.toFixed(2)}`;
	return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function renderTiers(data) {
	const byKey = Object.fromEntries(data.tiers.map((t) => [t.key, t]));
	const order = ['slow', 'standard', 'fast'];
	$('gas-tiers').innerHTML = `
		<div class="gas-tiers">
			${order
				.map((key) => {
					const t = byKey[key];
					const m = TIER_META[key];
					// Headline cost = a plain ETH transfer at this tier.
					const transfer = t?.actions?.find((a) => a.key === 'transfer');
					return `
					<div class="gas-tier ${m.cls}">
						<p class="tier-name ${m.cls}">${esc(m.name)}</p>
						<p class="gwei">${esc(gwei(t?.gas_price_gwei))}<span class="unit"> gwei</span></p>
						<p class="tier-sub">${esc(m.sub)}</p>
						<p class="tier-cost">${transfer && transfer.usd != null ? esc(usd(transfer.usd)) + ' · transfer' : `+${esc(gwei(t?.priority_fee_gwei))} tip`}</p>
					</div>`;
				})
				.join('')}
		</div>`;
}

function renderActions(data) {
	const order = ['slow', 'standard', 'fast'];
	const byKey = Object.fromEntries(data.tiers.map((t) => [t.key, t]));
	const hasUsd = data.eth_price_usd != null;
	const rows = data.actions
		.map((a) => {
			const cells = order
				.map((key) => {
					const act = byKey[key]?.actions?.find((x) => x.key === a.key);
					return `<td>${act && act.usd != null ? esc(usd(act.usd)) : '—'}</td>`;
				})
				.join('');
			return `<tr><td>${esc(a.label)} <span style="color:var(--cv-text-3)">· ${a.gas.toLocaleString('en-US')} gas</span></td>${cells}</tr>`;
		})
		.join('');
	$('gas-actions').innerHTML = `
		<div class="cv-card gas-actions-card">
			<h2 class="cv-h2" style="margin-top:0">Estimated cost by action</h2>
			<div style="overflow-x:auto">
				<table class="gas-actions-table">
					<thead><tr><th>Action</th><th>Slow</th><th>Standard</th><th>Fast</th></tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
			${hasUsd ? '' : '<p class="cv-updated" style="margin-top:0.75rem">USD estimates paused — ETH price unavailable. Gwei figures are live.</p>'}
		</div>`;
}

function renderBase(data) {
	const eth =
		data.eth_price_usd != null
			? `$${data.eth_price_usd.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
			: '—';
	$('gas-base').innerHTML = `
		<div><span class="k">Base fee</span> <span class="v">${esc(gwei(data.base_fee_gwei))} gwei</span></div>
		<div><span class="k">ETH price</span> <span class="v">${esc(eth)}</span></div>
		<div><span class="k">Network</span> <span class="v">Ethereum mainnet</span></div>`;
}

function renderSkeleton() {
	$('gas-base').innerHTML =
		'<div class="cv-skel" style="height:1.25rem;width:24rem;max-width:100%"></div>';
	$('gas-tiers').innerHTML =
		'<div class="gas-tiers">' +
		Array.from({ length: 3 }, () => '<div class="cv-skel" style="height:9rem"></div>').join(
			'',
		) +
		'</div>';
	$('gas-actions').innerHTML = '<div class="cv-skel" style="height:12rem"></div>';
}

function renderError() {
	$('gas-base').innerHTML = '';
	$('gas-tiers').innerHTML =
		'<div class="cv-empty">Live gas data is unavailable right now. It refreshes automatically — please try again shortly.</div>';
	$('gas-actions').innerHTML = '';
}

let timer = null;
async function refresh(initial = false) {
	if (initial) renderSkeleton();
	try {
		const data = await getJson('/api/coin/gas');
		renderBase(data);
		renderTiers(data);
		renderActions(data);
		$('gas-updated').textContent =
			`Updated ${new Date(data.updated_at || Date.now()).toLocaleTimeString('en-US')} · auto-refreshing · source: public Ethereum RPC`;
	} catch {
		if (initial) renderError();
		// On a mid-session failure, keep the last-good values on screen.
	}
}

refresh(true);
// Pause polling when the tab is hidden; resume + refresh when it returns.
function schedule() {
	clearInterval(timer);
	timer = setInterval(() => {
		if (!document.hidden) refresh(false);
	}, REFRESH_MS);
}
schedule();
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) refresh(false);
});
