/**
 * Trade room client model: pure helpers shared by the page controller, the 3D
 * scene, and the tests. No DOM, no fetch, no three.js.
 */

const SOL = '◎';

/** Newest-first merge of one event into a list, de-duplicated by id and capped. */
export function mergeTrade(list, event, max = 40) {
	if (!event?.id) return list.slice(0, max);
	const out = list.filter((t) => t.id !== event.id);
	out.push(event);
	out.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime() || (a.kind === 'sell' ? -1 : 1));
	return out.slice(0, max);
}

/** "$PLUR", or the coin name, or "a coin" when the ledger has neither. */
export function coinLabel(t) {
	if (t?.symbol) return `$${String(t.symbol).toUpperCase()}`;
	if (t?.name) return String(t.name);
	return 'a coin';
}

/** SOL amount with enough precision for pump.fun-sized fills: 0.00138 → "0.00138 ◎". */
export function solAmount(v) {
	const n = Number(v);
	if (!Number.isFinite(n)) return `? ${SOL}`;
	const abs = Math.abs(n);
	const dp = abs >= 1 ? 2 : abs >= 0.1 ? 3 : abs >= 0.01 ? 4 : 5;
	return `${Number(n.toFixed(dp))} ${SOL}`;
}

/** Signed percent with a real minus sign: -31.01 → "−31.0%". */
export function signedPct(v) {
	if (v == null || !Number.isFinite(Number(v))) return '';
	const n = Number(v);
	const s = n > 0 ? '+' : n < 0 ? '−' : '';
	return `${s}${Math.abs(n).toFixed(Math.abs(n) >= 100 ? 0 : 1)}%`;
}

/** How a sell landed: win, loss, or flat (inside half a percent). */
export function toneOf(t) {
	if (t?.kind !== 'sell') return 'buy';
	const p = Number(t.pnl_pct);
	if (!Number.isFinite(p) || Math.abs(p) < 0.5) return 'flat';
	return p > 0 ? 'win' : 'loss';
}

/**
 * One plain sentence for a trade: the screen-reader announcement, the ticker
 * tape, and the headline on the room's board all read the same words.
 */
export function tradeLine(t, leaderName = '') {
	const who = leaderName ? `${leaderName} ` : '';
	const coin = coinLabel(t);
	if (t?.kind === 'buy') {
		return `${who}${t.paper ? 'paper-bought' : 'bought'} ${coin} for ${solAmount(t.size_sol)}`.replace(/^./, (c) => c.toUpperCase());
	}
	const pct = signedPct(t?.pnl_pct);
	const why = t?.exit_label ? ` on ${String(t.exit_label).toLowerCase()}` : '';
	const verb = t?.paper ? 'paper-sold' : 'sold';
	return `${who}${verb} ${coin} for ${solAmount(t?.size_sol)}${pct ? `, ${pct}` : ''}${why}`.replace(/^./, (c) => c.toUpperCase());
}

/**
 * The emote the leader's avatar plays when a trade lands. Every name exists in
 * /animations/manifest.json; the scene falls back to idle if one cannot load.
 */
export function reactionFor(t) {
	const tone = toneOf(t);
	if (tone === 'buy') return 'point';
	if (tone === 'flat') return 'nod';
	const p = Number(t.pnl_pct);
	if (tone === 'win') return p >= 50 ? 'av-cheering' : 'celebrate';
	return p <= -20 ? 'defeated' : 'shrug';
}

/** A room is "live" while a position is open or the last fill is this fresh. */
export const LIVE_WINDOW_MS = 15 * 60_000;
/** A room is "warm" when the leader traded inside this window. */
export const WARM_WINDOW_MS = 24 * 3_600_000;

/**
 * The room's liveliness, computed identically by the API (api/_lib/trade-room.js)
 * and the page (so a live room cools to warm on screen without a refetch).
 *   live  : a position is open, or the last fill landed inside LIVE_WINDOW_MS
 *   warm  : the leader traded inside WARM_WINDOW_MS
 *   quiet : anything older, or never
 * @param {{lastTradeAt?: string|null, openCount?: number, now?: number}} input
 * @returns {'live'|'warm'|'quiet'}
 */
export function roomState({ lastTradeAt = null, openCount = 0, now = Date.now() } = {}) {
	if (openCount > 0) return 'live';
	const last = lastTradeAt ? new Date(lastTradeAt).getTime() : NaN;
	if (!Number.isFinite(last)) return 'quiet';
	const age = now - last;
	if (age <= LIVE_WINDOW_MS) return 'live';
	if (age <= WARM_WINDOW_MS) return 'warm';
	return 'quiet';
}

/** Room state copy, shared by the lobby card and the room HUD. */
export const STATE_LABEL = { live: 'Live now', warm: 'Traded today', quiet: 'Quiet' };

/** Relative time from an ISO instant: "just now", "4m ago", "3h ago", "12d ago". */
export function ago(iso, now = Date.now()) {
	const t = new Date(iso).getTime();
	if (!Number.isFinite(t)) return '';
	const s = Math.max(0, (now - t) / 1000);
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)}m ago`;
	if (s < 86400) return `${Math.round(s / 3600)}h ago`;
	return `${Math.round(s / 86400)}d ago`;
}

/** "Last traded 3h ago", or the honest "No trades yet" for a fresh leader. */
export function lastTradedText(iso, now = Date.now()) {
	return iso ? `Last traded ${ago(iso, now)}` : 'No trades yet';
}

/** The looping tape text: the newest trades, separated by a bullet. */
export function tickerText(trades, limit = 12) {
	const items = (trades || []).slice(0, limit).map((t) => tradeLine(t));
	return items.length ? items.join('   •   ') : 'Waiting for the first trade';
}

/**
 * Seat positions for n spectators: two arcs flanking the pedestal, filled
 * alternately left and right so a small crowd still frames the leader.
 * @returns {{x:number, z:number, ry:number}[]}
 */
export function spectatorSeats(n, radius = 2.35) {
	const seats = [];
	for (let i = 0; i < n; i++) {
		const side = i % 2 === 0 ? 1 : -1;
		const row = Math.floor(i / 2);
		const ring = radius + Math.floor(row / 6) * 0.75;
		const step = row % 6;
		// Angle from the +z axis (camera side): 84° to 149°, so the crowd stands
		// in the round at the sides and back of the pedestal, never between the
		// camera and the leader.
		const deg = 84 + step * 13 + (Math.floor(row / 6) % 2) * 8;
		const a = (deg * Math.PI) / 180 * side;
		const x = Math.sin(a) * ring;
		const z = Math.cos(a) * ring;
		seats.push({ x, z, ry: Math.atan2(-x, -z) });
	}
	return seats;
}

/** A random, URL-safe tab id the stream uses to count this viewer. */
export function newSessionId(rand = globalThis.crypto) {
	if (rand?.randomUUID) return rand.randomUUID().replace(/-/g, '').slice(0, 24);
	let s = '';
	for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 36).toString(36);
	return s;
}

/**
 * Which room the URL asks for. /trade-rooms is the lobby ({id:'', invalid:false});
 * /trade-rooms/<uuid> (or ?agent=<uuid>) is a room; anything else is a room id
 * that cannot exist ({invalid:true}), which the page answers with a designed
 * not-found state rather than silently showing the lobby.
 */
export function roomIdFromLocation(pathname, search = '') {
	const m = String(pathname || '').replace(/\/+$/, '').match(/^\/trade-rooms\/([^/]+)$/);
	let raw = '';
	try {
		raw = m ? decodeURIComponent(m[1]) : new URLSearchParams(search).get('agent') || '';
	} catch {
		return { id: '', invalid: true };
	}
	if (!raw) return { id: '', invalid: false };
	const ok = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw);
	return ok ? { id: raw.toLowerCase(), invalid: false } : { id: '', invalid: true };
}

/** Reconnect delay for the stream: 1s, 2s, 4s ... capped at 30s. */
export function backoffMs(attempt) {
	return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}
