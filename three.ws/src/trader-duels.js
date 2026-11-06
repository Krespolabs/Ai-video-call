// Trader duels on a trader profile: the open and live duels featuring this
// trader, with a link to call them. Reads GET /api/duels?agent=<agent id>.
// Mounted by src/trader.js under the syndicates panel. Points only; free to play.

import { esc } from './syndicate-shared.js';
import { until } from './duels-shared.js';

export async function mountTraderDuels(el, { agentId, name, network = 'mainnet' }) {
	if (!el || !agentId) return;
	const who = esc(name || 'this trader');
	el.innerHTML = `<h2>Trader duels</h2><p class="tp-sk" style="width:60%;height:14px;display:block"></p>`;
	let body;
	try {
		const q = new URLSearchParams({ agent: agentId, network, phase: 'all', limit: '6' });
		const r = await fetch(`/api/duels?${q}`, { credentials: 'include', headers: { accept: 'application/json' } });
		if (!r.ok) throw new Error(String(r.status));
		body = await r.json();
	} catch {
		el.innerHTML = `<h2>Trader duels</h2><p>Couldn't load the duels featuring ${who}. <a href="/duels">See every duel</a>.</p>`;
		return;
	}
	const active = (body.duels || []).filter((d) => d.phase === 'open' || d.phase === 'live');
	if (!active.length) {
		el.innerHTML = `
			<h2>Trader duels</h2>
			<p>${who} is not in a duel right now. Duels pair traders who sit next to each other on the 30-day board, and new ones open every UTC day. Free to play; points have no cash value.</p>
			<div class="cp-actions"><a class="lb-btn" href="/duels">See every duel</a></div>`;
		return;
	}
	el.innerHTML = `
		<h2>Call ${who}'s next duel</h2>
		<ul style="list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px">
			${active.map((d) => {
				const me = d.a.agent_id === agentId ? d.a : d.b;
				const rival = me === d.a ? d.b : d.a;
				const when = d.phase === 'open' ? `Open · locks in ${until(d.window_start)}` : `Live · ends in ${until(d.window_end)}`;
				return `
					<li><a href="${esc(d.url)}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;text-decoration:none;color:inherit;padding:10px 12px;border:1px solid var(--stroke, #26262b);border-radius:12px">
						<span style="min-width:0"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">vs ${esc(rival.name)}</b><small style="opacity:.7">${esc(d.window_kind === 'week' ? 'Week duel' : '24h duel')} · ${esc(when)}</small></span>
						<b style="white-space:nowrap">${d.phase === 'open' ? 'Make your call →' : 'Watch →'}</b>
					</a></li>`;
			}).join('')}
		</ul>
		<div class="cp-actions"><a class="lb-btn" href="/duels?agent=${esc(agentId)}">All duels with ${who}</a></div>`;
}
