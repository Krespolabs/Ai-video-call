// Shared rendering for /duels, /duels/:id and the duels widget on /trader/:id.
// Every number comes from the API; nothing here computes a result.

import { esc, fmtSol, tone } from './syndicate-shared.js';

export const FREE_LINE = 'Free to play. Points have no cash value and cannot be bought, sold, transferred or redeemed.';

const DATE_FMT = { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' };
const TIME_FMT = { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' };

export const fmtDay = (iso) => new Date(iso).toLocaleDateString('en-US', DATE_FMT);
export const fmtUtc = (iso) => `${new Date(iso).toLocaleString('en-US', TIME_FMT)} UTC`;

export function pts(v, { sign = false } = {}) {
	const n = Math.round(Number(v) || 0);
	const s = `${Math.abs(n).toLocaleString('en-US')} ${Math.abs(n) === 1 ? 'point' : 'points'}`;
	if (!sign || n === 0) return n < 0 ? `-${s}` : s;
	return `${n > 0 ? '+' : '−'}${s}`;
}

/** "5h 20m", "2d 4h", "12m", from now until an ISO time. */
export function until(iso, now = Date.now()) {
	const ms = new Date(iso).getTime() - now;
	if (ms <= 0) return 'now';
	const m = Math.floor(ms / 60_000);
	const d = Math.floor(m / 1440);
	const h = Math.floor((m % 1440) / 60);
	if (d > 0) return `${d}d ${h}h`;
	if (h > 0) return `${h}h ${String(m % 60).padStart(2, '0')}m`;
	return `${Math.max(1, m)}m`;
}

export function windowLabel(d) {
	if (d.window_kind === 'week') return `Week duel · ${fmtDay(d.window_start)} to ${fmtDay(d.window_end)}`;
	return `24h duel · ${fmtDay(d.window_start)}`;
}

export const VOID_TEXT = {
	tie: 'Both traders booked exactly the same realized P&L, so the duel was a tie. Every call was refunded.',
	no_trades: 'Neither trader closed a trade during the window, so there was nothing to compare. Every call was refunded.',
	trader_unavailable: 'One of the traders went private or was removed before the duel resolved. Every call was refunded.',
};

export function phaseChip(d, now = Date.now()) {
	switch (d.phase) {
		case 'open': return `<span class="dx-phase open">Open · locks in ${esc(until(d.window_start, now))}</span>`;
		case 'live': return `<span class="dx-phase live"><span class="dx-live-dot" aria-hidden="true"></span>Live · ends in ${esc(until(d.window_end, now))}</span>`;
		case 'resolving': return `<span class="dx-phase resolving">Resolving</span>`;
		case 'resolved': return `<span class="dx-phase resolved">Resolved</span>`;
		default: return `<span class="dx-phase void">Void · refunded</span>`;
	}
}

/** Round avatar with an initial fallback (hydrate with hydrateAvatars from syndicate-shared). */
export function ava(name, image, cls = 'dx-ava') {
	const initial = esc((String(name || '?').trim()[0] || '?').toUpperCase());
	if (image) return `<img class="${cls}" src="${esc(image)}" alt="" loading="lazy" decoding="async" data-initial="${initial}" />`;
	return `<span class="${cls}" aria-hidden="true">${initial}</span>`;
}

export function crowdBar(d) {
	const a = d.crowd.a.points;
	const b = d.crowd.b.points;
	const total = a + b;
	const calls = d.crowd.a.calls + d.crowd.b.calls;
	const pa = total ? Math.round((a / total) * 100) : 50;
	const label = total
		? `Crowd: ${d.crowd.a.calls} ${d.crowd.a.calls === 1 ? 'call' : 'calls'} on ${d.a.name} (${pa}% of points), ${d.crowd.b.calls} on ${d.b.name} (${100 - pa}%)`
		: 'No calls yet';
	return {
		html: `<div class="dx-crowd${total ? '' : ' empty'}" role="img" aria-label="${esc(label)}"><i class="a" style="width:${pa}%"></i><i class="b" style="width:${100 - pa}%"></i></div>`,
		text: total ? `${calls} ${calls === 1 ? 'call' : 'calls'} · ${pa}% on ${d.a.name}` : 'No calls yet. Be first.',
	};
}

export function myCallChip(d) {
	const c = d.my_call;
	if (!c) return '';
	const who = c.side === 'a' ? d.a.name : d.b.name;
	if (c.status === 'won') return `<span class="dx-mine won">You called ${esc(who)} · ${esc(pts(c.payout - c.stake, { sign: true }))}</span>`;
	if (c.status === 'lost') return `<span class="dx-mine lost">You called ${esc(who)} · ${esc(pts(-c.stake, { sign: true }))}</span>`;
	if (c.status === 'refunded') return `<span class="dx-mine">You called ${esc(who)} · refunded</span>`;
	return `<span class="dx-mine">Your call: ${esc(who)} · ${esc(pts(c.stake))}</span>`;
}

function sideLine(d, key) {
	const s = d[key];
	const r = d.result?.[key];
	if ((d.phase === 'resolved' || d.phase === 'void') && r) {
		return `<span class="${tone(r.pnl_sol)}">${esc(fmtSol(r.pnl_sol))}</span> · ${esc(r.closed)} closed`;
	}
	const parts = [];
	if (s.board.rank != null) parts.push(`#${esc(s.board.rank)}`);
	if (s.board.realized_pnl_sol != null) parts.push(`<span class="${tone(s.board.realized_pnl_sol)}">${esc(fmtSol(s.board.realized_pnl_sol))}</span> 30d`);
	return parts.join(' · ') || '30-day record on profile';
}

/** One duel on the board. */
export function duelCard(d, now = Date.now()) {
	const crowd = crowdBar(d);
	const win = (k) => (d.phase === 'resolved' && d.winner === k ? ' win' : '');
	const cta = d.phase === 'open' ? (d.my_call ? 'View duel' : 'Make your call') : d.phase === 'live' ? 'Watch the race' : 'See the result';
	return `
		<li>
			<a class="dx-card" href="${esc(d.url)}" aria-label="${esc(`${d.a.name} versus ${d.b.name}, ${windowLabel(d)}`)}">
				<div class="dx-card-top">${phaseChip(d, now)}<span>${esc(windowLabel(d))}</span></div>
				<div class="dx-vs">
					<div class="dx-side a${win('a')}">${ava(d.a.name, d.a.image)}<div><b>${esc(d.a.name)}</b><small>${sideLine(d, 'a')}</small></div></div>
					<span class="dx-vs-mark" aria-hidden="true">vs</span>
					<div class="dx-side b${win('b')}">${ava(d.b.name, d.b.image)}<div><b>${esc(d.b.name)}</b><small>${sideLine(d, 'b')}</small></div></div>
				</div>
				${crowd.html}
				<div class="dx-card-foot"><span>${d.my_call ? myCallChip(d) : esc(crowd.text)}</span><span class="dx-cta">${esc(cta)} →</span></div>
			</a>
		</li>`;
}
