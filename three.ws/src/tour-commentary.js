// tour-commentary.js — the pure brain of the Coin World Tour.
//
// A guide agent walks the $THREE 3D world (src/play/arena-world.js) and narrates
// what's climbing three.ws's OWN launch feed as it moves between stops. This module
// owns the two pure transforms that drive that narration, with ZERO DOM/Three.js/IO
// so it runs identically in the browser bundle, the Playwright caster, and the unit
// test (tests/tour-commentary.test.js):
//
//   • normalizeLaunches() — turn the /api/pump/launches feed (coins launched
//     THROUGH three.ws, from the platform's own pump_agent_mints records) into
//     compact, location-agnostic { symbol, rank } items (top-N, cleaned).
//   • tourCommentary()    — given the current waypoint + those items, produce the
//     spoken line + a badge label + the structured sidecar the overlay renders.
//
// Coin rule: $THREE is the only coin the tour PROMOTES. The data source here is
// deliberately the platform's OWN launch directory (the blessed launch-records
// exception — same source as the /launches feed and agent-profile launch history),
// NOT a global third-party market/trending feed. Coins are described factually
// (symbol + feed position) — never named as a buy, never recommended, never a
// hardcoded non-$THREE mint.

// Prefix stamped onto every tour SCREENSHOT frame's activity string. The render
// surfaces (src/agent-screen.js, src/agents-live.js) detect a live tour by this
// prefix and reveal the TOUR badge + waypoint label. The caster builds it from
// `badge` below, so this is the single source of truth for both sides.
export const TOUR_PREFIX = 'Tour · ';

// The fixed walking loop. `name` is the deterministic key the 3D scene + caster
// drive (window.__tour.goTo(name)); `label` is the human waypoint title shown on
// the badge; `where` buckets the stop into a commentary register (the open lobby
// vs. deep in the arena) so the narration reads differently as the guide moves in.
export const TOUR_WAYPOINTS = [
	{ name: 'lobby',    label: 'Entering the lobby',     where: 'lobby' },
	{ name: 'approach', label: 'Crossing the floor',     where: 'lobby' },
	{ name: 'arena',    label: 'Into the arena',         where: 'arena' },
	{ name: 'leader',   label: 'At the leader’s pad',    where: 'arena' },
	{ name: 'eastwing', label: 'Along the east ring',    where: 'arena' },
];

// Longest symbol we'll speak before truncating — keeps the overlay + log tidy and
// stops a pathological 40-char "symbol" from blowing out a commentary line.
const SYMBOL_MAX = 12;
// How many trending coins a single commentary line mentions. The feed can return
// hundreds; a guide names the top few, never a wall of tickers.
const DEFAULT_LIMIT = 3;

export function waypointByName(name) {
	return TOUR_WAYPOINTS.find((w) => w.name === name) || null;
}

// Normalize one ticker into a single leading-`$`, length-bounded symbol. Accepts
// feeds that already include `$` and ones that don't, and survives junk/empties.
function cleanSymbol(raw) {
	let s = String(raw == null ? '' : raw).trim();
	s = s.replace(/^\$+/, '');                 // collapse any existing $ prefixes
	s = s.replace(/\s+/g, '');                 // tickers never carry spaces
	if (!s) return '';
	if (s.length > SYMBOL_MAX) s = s.slice(0, SYMBOL_MAX - 1) + '…';
	return `$${s}`;
}

// Raw /api/pump/trending feed → compact, ordered commentary items. Each item is
// just { symbol, rank } — the minimum the narration needs, never a mint (coin
// addresses are deliberately not spoken or rendered). Missing ranks fall back to
// feed position so the order is always meaningful.
export function normalizeLaunches(launches, { limit = DEFAULT_LIMIT } = {}) {
	if (!Array.isArray(launches)) return [];
	const out = [];
	for (let i = 0; i < launches.length; i++) {
		const t = launches[i] || {};
		const symbol = cleanSymbol(t.symbol);
		if (!symbol || symbol === '$') continue;
		const rank = Number.isFinite(t.rank) && t.rank > 0 ? Math.floor(t.rank) : out.length + 1;
		out.push({ symbol, rank });
		if (out.length >= limit) break;
	}
	return out;
}

// "$ABC (#1), $DEF (#2) and $GHI (#3)" — a readable, factual enumeration.
function listPhrase(items) {
	const parts = items.map((it) => `${it.symbol} (#${it.rank})`);
	if (parts.length === 1) return parts[0];
	return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

// The heart of the tour. Given the waypoint the guide just reached and the live
// trending feed, return everything the surfaces need:
//   { name, where, label, badge, line, items }
// `line` is the spoken/logged commentary (type:'analysis'); `badge` is the
// screenshot frame's activity stamp; `items` backs the overlay's trending list.
export function tourCommentary(waypointName, launches, { limit = DEFAULT_LIMIT } = {}) {
	const wp = waypointByName(waypointName) || TOUR_WAYPOINTS[0];
	const items = normalizeLaunches(launches, { limit });
	const label = wp.label;
	const badge = `${TOUR_PREFIX}${label}`;

	let line;
	if (!items.length) {
		// Feed empty or down — the tour never goes silent; it narrates the world.
		line = wp.where === 'arena'
			? `${label}. The feed’s quiet right now — just the arena and the lights.`
			: `${label}. Nothing climbing the launch feed yet — come walk the world.`;
	} else if (wp.where === 'arena') {
		line = `${label}. Climbing the launch feed right now: ${listPhrase(items)}.`;
	} else {
		line = `${label}. Trending as we walk in: ${listPhrase(items)}.`;
	}

	return { name: wp.name, where: wp.where, label, badge, line, items };
}
