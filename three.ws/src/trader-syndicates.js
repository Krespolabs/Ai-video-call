// Syndicates on a trader profile: the teams that follow this trader, and the
// one-tap way to start one. Reads GET /api/syndicates?leader=<agent id>.
// Mounted by src/trader.js under the copy panel.

import { esc, fmtSol } from './syndicate-shared.js';

// The trader page does not load the syndicates stylesheet, so the flag and the
// P&L tone are drawn inline here.
const flagChip = (name, color) => `<span aria-hidden="true" style="width:32px;height:32px;border-radius:9px;flex:none;display:grid;place-items:center;font-weight:900;color:#0a0a0b;background:${esc(color)}">${esc((String(name || '?').trim()[0] || '?').toUpperCase())}</span>`;
const toneColor = (v) => (Number(v) > 0 ? '#34d399' : Number(v) < 0 ? '#fb7185' : 'inherit');

export async function mountTraderSyndicates(el, { agentId, name, network = 'mainnet' }) {
	if (!el || !agentId) return;
	const startHref = `/syndicates?start=1&leader=${encodeURIComponent(agentId)}`;
	el.innerHTML = `<h2>Syndicates</h2><p class="tp-sk" style="width:60%;height:14px;display:block"></p>`;
	let body;
	try {
		const r = await fetch(`/api/syndicates?leader=${encodeURIComponent(agentId)}&network=${encodeURIComponent(network)}&limit=6`, { headers: { accept: 'application/json' } });
		if (!r.ok) throw new Error(String(r.status));
		body = await r.json();
	} catch {
		el.innerHTML = `
			<h2>Syndicates</h2>
			<p>Couldn't load the teams following ${esc(name || 'this trader')}. <a href="/syndicates">Browse every syndicate</a>.</p>`;
		return;
	}
	const list = body.syndicates || [];
	if (!list.length) {
		el.innerHTML = `
			<h2>Copy ${esc(name || 'this trader')} as a team</h2>
			<p>No syndicate follows ${esc(name || 'this trader')} yet. Start one: name it, pick a flag, and every member copies from their own wallet under their own caps while the team climbs the board together.</p>
			<div class="cp-actions"><a class="lb-btn lb-btn-primary" href="${esc(startHref)}">Start a syndicate</a><a class="lb-btn" href="/syndicates">See the board</a></div>`;
		return;
	}
	el.innerHTML = `
		<h2>Syndicates following ${esc(name || 'this trader')}</h2>
		<ul style="list-style:none;margin:0 0 12px;padding:0;display:grid;gap:8px">
			${list.map((s) => `
				<li><a href="${esc(s.url)}" style="display:flex;align-items:center;gap:12px;text-decoration:none;color:inherit;padding:10px 12px;border:1px solid var(--stroke, #26262b);border-left:3px solid ${esc(s.color)};border-radius:12px">
					${flagChip(s.name, s.color)}
					<span style="min-width:0;flex:1"><b style="display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name)}</b><small style="opacity:.7">#${esc(s.rank)} on the board · ${esc(s.members)} ${s.members === 1 ? 'member' : 'members'}</small></span>
					<b style="color:${toneColor(s.performance.realized_profit_sol)}">${esc(fmtSol(s.performance.realized_profit_sol))}</b>
				</a></li>`).join('')}
		</ul>
		<div class="cp-actions"><a class="lb-btn" href="${esc(startHref)}">Start another</a><a class="lb-btn" href="/syndicates">See the board</a></div>`;
}
