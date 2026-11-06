/**
 * SSR share page for trader track records
 * ----------------------------------------
 * GET /api/trader-share?agent_id=<uuid>       — three.ws agent
 * GET /api/trader-share?agent_id=<base58>     — claimed/external wallet
 *
 * Wired via vercel.json: /trader/<id>/share → /api/trader-share?agent_id=$1
 * (the rewrite passes either kind of id; base58 is treated as a wallet)
 *
 * Bakes Open Graph + Twitter Card + Farcaster Frame meta into <head> so social
 * crawlers render a rich preview with the trader's score, P&L, and win rate.
 * Real browsers are JS-redirected to /trader/<id> for the full profile.
 *
 * OG image: /api/trader-og?agent_id=<uuid> | /api/trader-og?wallet=<base58>
 */

import { sql } from './_lib/db.js';
import { cors, wrap } from './_lib/http.js';
import { env } from './_lib/env.js';
import { isUuid } from './_lib/validate.js';

const LAMPORTS  = 1e9;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default wrap(async (req, res) => {
	if (cors(req, res, { methods: 'GET,OPTIONS' })) return;

	const url     = new URL(req.url, 'http://x');
	const agentId = (url.searchParams.get('agent_id') || '').trim();
	const origin  = env.APP_ORIGIN || 'https://three.ws';

	if (!isUuid(agentId)) {
		if (BASE58_RE.test(agentId)) return shareWallet(res, agentId, origin);
		return redirect(res, `${origin}/leaderboard`);
	}

	let agent, stats;
	try {
		[agent] = await sql`
			select id, name, profile_image_url, avatar_url
			from agent_identities
			where id = ${agentId} and deleted_at is null
			limit 1
		`;
		if (!agent) return redirect(res, `${origin}/leaderboard`);

		// Aggregate all-time stats from closed positions
		[stats] = await sql`
			select
				count(*) filter (where status = 'closed')                     as total,
				count(*) filter (where status = 'closed' and realized_pnl_pct >= 0) as wins,
				sum(realized_pnl_lamports) filter (where status = 'closed')  as pnl_lam,
				max(realized_pnl_pct)                                         as best_pct,
				count(*) filter (where status = 'open')                       as open_pos
			from agent_sniper_positions
			where agent_id = ${agentId} and network = 'mainnet'
		`;
	} catch {
		return redirect(res, `${origin}/trader/${encodeURIComponent(agentId)}`);
	}

	const name      = agent.name || 'Agent';
	const total     = Number(stats?.total || 0);
	const wins      = Number(stats?.wins  || 0);
	const winRate   = total > 0 ? Math.round((wins / total) * 100) : null;
	const pnlSol    = stats?.pnl_lam != null ? Number(BigInt(stats.pnl_lam)) / LAMPORTS : null;
	const bestPct   = stats?.best_pct != null ? Number(stats.best_pct) : null;

	const pnlStr  = pnlSol != null ? (pnlSol >= 0 ? `+${pnlSol.toFixed(2)}` : pnlSol.toFixed(2)) + ' SOL' : null;
	const bestStr = bestPct != null ? `+${Math.round(bestPct)}%` : null;

	const title = `${name} · ${winRate != null ? `${winRate}% win rate` : 'Trader'} · three.ws Oracle`;
	const desc  = buildDesc({ name, total, winRate, pnlStr, bestStr });

	const pageUrl  = `${origin}/trader/${encodeURIComponent(agentId)}/share`;
	const deepUrl  = `${origin}/trader/${encodeURIComponent(agentId)}`;
	const ogImage  = `${origin}/api/trader-og?agent_id=${encodeURIComponent(agentId)}`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ title, desc, pageUrl, deepUrl, ogImage, name, winRate, pnlStr, origin }));
});

function redirect(res, to) {
	res.statusCode = 302;
	res.setHeader('location', to);
	res.setHeader('cache-control', 'no-cache');
	res.end();
}

/** wallet_reputation stores win_rate as a 0–1 fraction; normalize to 0–100. */
function pct(v) {
	if (v == null) return null;
	const n = Number(v);
	if (!Number.isFinite(n)) return null;
	return Math.round(n <= 1 ? n * 100 : n);
}

/**
 * Share page for a claimed/external wallet — reads the Oracle wallet-reputation
 * ledger. An unindexed wallet redirects to the plain profile rather than
 * shipping a preview full of em-dashes.
 */
async function shareWallet(res, wallet, origin) {
	const deepUrl = `${origin}/trader/${encodeURIComponent(wallet)}`;

	let rep;
	try {
		[rep] = await sql`
			select coins_traded, win_rate, smart_money_score, label
			from wallet_reputation
			where wallet = ${wallet} and network = 'mainnet'
			limit 1
		`;
	} catch {
		return redirect(res, deepUrl);
	}
	if (!rep) return redirect(res, deepUrl);

	const short   = `${wallet.slice(0, 4)}…${wallet.slice(-4)}`;
	const winRate = pct(rep.win_rate);
	const score   = rep.smart_money_score != null ? Math.round(Number(rep.smart_money_score)) : null;
	const coins   = Number(rep.coins_traded || 0);
	const label   = rep.label ? String(rep.label).replace(/_/g, ' ') : null;

	const title = `${short} · ${score != null ? `smart-money score ${score}` : 'Solana trader'} · three.ws Oracle`;
	const parts = [`${short}'s on-chain pump.fun track record on three.ws`];
	if (label)           parts.push(label);
	if (coins > 0)       parts.push(`${coins} coin${coins === 1 ? '' : 's'} traded`);
	if (winRate != null) parts.push(`${winRate}% win rate`);
	if (score != null)   parts.push(`smart-money score ${score}`);
	parts.push('proof.not.promises');
	const desc = parts.join(' · ');

	const pageUrl = `${origin}/trader/${encodeURIComponent(wallet)}/share`;
	const ogImage = `${origin}/api/trader-og?wallet=${encodeURIComponent(wallet)}`;

	res.statusCode = 200;
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.setHeader('cache-control', 'public, max-age=60, s-maxage=600, stale-while-revalidate=3600');
	res.end(renderHtml({ title, desc, pageUrl, deepUrl, ogImage, name: short, winRate, pnlStr: null, origin }));
}

function buildDesc({ name, total, winRate, pnlStr, bestStr }) {
	const parts = [`${name}'s provable pump.fun track record on three.ws`];
	if (total > 0)   parts.push(`${total} closed trade${total === 1 ? '' : 's'}`);
	if (winRate != null) parts.push(`${winRate}% win rate`);
	if (pnlStr)      parts.push(`${pnlStr} realized`);
	if (bestStr)     parts.push(`best trade ${bestStr}`);
	parts.push('proof.not.promises');
	return parts.join(' · ');
}

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
	);
}

function renderHtml({ title, desc, pageUrl, deepUrl, ogImage, name, winRate, pnlStr, origin }) {
	const t = esc(title);
	const d = esc(desc);
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta http-equiv="X-UA-Compatible" content="IE=edge">
	<title>${t}</title>
	<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
	<meta name="description" content="${d}">
	<meta name="theme-color" content="#0a0a0a">

	<meta property="og:type" content="profile">
	<meta property="og:site_name" content="three.ws Oracle">
	<meta property="og:title" content="${t}">
	<meta property="og:description" content="${d}">
	<meta property="og:url" content="${esc(pageUrl)}">
	<meta property="og:image" content="${esc(ogImage)}">
	<meta property="og:image:width" content="1200">
	<meta property="og:image:height" content="630">
	<meta property="og:image:alt" content="${esc(name)} trader track record on three.ws">

	<meta name="twitter:card" content="summary_large_image">
	<meta name="twitter:site" content="@trythreews">
	<meta name="twitter:title" content="${t}">
	<meta name="twitter:description" content="${d}">
	<meta name="twitter:image" content="${esc(ogImage)}">

	<meta property="fc:frame" content="vNext">
	<meta property="fc:frame:image" content="${esc(ogImage)}">
	<meta property="fc:frame:image:aspect_ratio" content="1.91:1">
	<meta property="fc:frame:button:1" content="View track record →">
	<meta property="fc:frame:button:1:action" content="link">
	<meta property="fc:frame:button:1:target" content="${esc(deepUrl)}">
	<meta property="fc:frame:button:2" content="Leaderboard">
	<meta property="fc:frame:button:2:action" content="link">
	<meta property="fc:frame:button:2:target" content="${esc(origin)}/leaderboard">

	<link rel="canonical" href="${esc(pageUrl)}">
	<link rel="shortcut icon" href="/favicon.ico">

	<style>
		html,body{margin:0;padding:0;background:#0a0a0a;color:#e5e7eb;font-family:Inter,system-ui,sans-serif;height:100%}
		.shell{display:grid;place-items:center;min-height:100vh;text-align:center;padding:2rem;gap:.75rem}
		.name{font-size:1.2rem;font-weight:700;color:#f9fafb}
		.wr{font-size:2.5rem;font-weight:800;line-height:1;color:#34d399}
		.pnl{font-size:1rem;color:#94a3b8}
		.spinner{width:24px;height:24px;border:2px solid rgba(255,255,255,.1);border-top-color:rgba(255,255,255,.5);border-radius:50%;animation:spin .9s linear infinite;margin:0 auto}
		@keyframes spin{to{transform:rotate(360deg)}}
		p{margin:0;color:rgba(255,255,255,.4);font-size:13px}
	</style>
</head>
<body>
	<noscript>
		<div class="shell">
			<div class="name">${esc(name)}</div>
			${winRate != null ? `<div class="wr">${winRate}% win rate</div>` : ''}
			${pnlStr ? `<div class="pnl">${esc(pnlStr)} realized</div>` : ''}
			<p>${d}</p>
			<p><a href="${esc(deepUrl)}" style="color:#34d399">View track record →</a></p>
		</div>
	</noscript>
	<div class="shell" aria-live="polite">
		<div class="spinner" aria-hidden="true"></div>
		<p>Loading trader profile…</p>
	</div>
	<script>(function(){window.location.replace(${JSON.stringify(deepUrl)});})()</script>
</body>
</html>`;
}
