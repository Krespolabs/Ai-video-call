// War standings — the pure league math behind Coin Wars. A ClashMatch produces a
// result (which community won, the kills/deaths on each side); this module folds a
// stream of those results into a ranking of coin communities: rating, record,
// streak, and aggregate K/D. The /api/wars endpoint recomputes standings from the
// persisted battle ledger with these functions, and the live server can apply a
// single fresh result incrementally with the same rules — one source of truth for
// "who's winning the war."
//
// Pure and dependency-free (testable on the corrupted box like clash.js/combat.js).
// Rating is Elo: a community that beats a stronger one climbs more than one that
// beats a weaker one, so the ladder reflects quality of opposition, not just volume.

export const BASE_RATING = 1000; // every community's rating before its first battle
export const K_FACTOR = 32;      // Elo responsiveness — one upset moves you meaningfully

// Expected win probability for A against B given their ratings (standard Elo logistic).
export function expectedScore(ratingA, ratingB) {
	return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

// A fresh, zeroed standings record for a community. `meta` carries the display
// identity (name/symbol/image) so a ranking row can render without a second lookup.
export function emptyRecord(mint, meta = {}) {
	return {
		mint,
		name: meta.name || meta.symbol || 'Community',
		symbol: meta.symbol || '',
		image: meta.image || '',
		rating: BASE_RATING,
		battles: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		kills: 0,
		deaths: 0,
		streak: 0,        // current run: +n consecutive wins, -n consecutive losses, 0 after a draw
		lastBattleAt: 0,  // epoch ms of the most recent battle (recency sort / "active" badge)
	};
}

// Apply one battle result to a standings table (Map of mint → record), mutating and
// returning it. Updates both communities' rating, record, streak, and K/D in lockstep
// so the table is always internally consistent. A `result` is the shape ClashMatch
// .result() emits: { winner: mint|'draw', factions: [{mint,name,symbol,kills,deaths}, …], endedAt }.
export function applyBattle(table, result, metaByMint = {}) {
	if (!result || !Array.isArray(result.factions) || result.factions.length !== 2) return table;
	const [fa, fb] = result.factions;
	const a = ensure(table, fa.mint, metaByMint[fa.mint] || fa);
	const b = ensure(table, fb.mint, metaByMint[fb.mint] || fb);

	const draw = result.winner === 'draw' || result.winner == null;
	const aWon = !draw && result.winner === fa.mint;
	const bWon = !draw && result.winner === fb.mint;

	// Rating: settle both against each other on the same expected scores.
	const ea = expectedScore(a.rating, b.rating);
	const eb = 1 - ea;
	const sa = draw ? 0.5 : aWon ? 1 : 0;
	const sb = draw ? 0.5 : bWon ? 1 : 0;
	a.rating = Math.round(a.rating + K_FACTOR * (sa - ea));
	b.rating = Math.round(b.rating + K_FACTOR * (sb - eb));

	settle(a, { won: aWon, lost: bWon, draw, kills: fa.kills, deaths: fa.deaths, at: result.endedAt });
	settle(b, { won: bWon, lost: aWon, draw, kills: fb.kills, deaths: fb.deaths, at: result.endedAt });
	return table;
}

// Fold a full battle ledger into a ranked standings array. Battles MUST be applied in
// chronological order for Elo to be path-correct, so we sort by endedAt first. Pass
// `metaByMint` to override stale display identity from the freshest known names.
export function computeStandings(battles = [], metaByMint = {}) {
	const table = new Map();
	const ordered = [...battles].sort((x, y) => (x.endedAt || 0) - (y.endedAt || 0));
	for (const battle of ordered) applyBattle(table, battle, metaByMint);
	return rankStandings(table);
}

// Turn a standings table into the sorted, rank-stamped array the leaderboard renders.
// Order: rating desc, then wins, then aggregate kills — a higher-rated community that
// also wins more sits above one that merely farmed kills. Adds derived winRate + kd.
export function rankStandings(table) {
	const rows = [...table.values()].map(decorate);
	rows.sort((a, b) =>
		b.rating - a.rating || b.wins - a.wins || b.kills - a.kills || a.mint.localeCompare(b.mint));
	rows.forEach((row, i) => { row.rank = i + 1; });
	return rows;
}

// --- internals --------------------------------------------------------------

function ensure(table, mint, meta) {
	let rec = table.get(mint);
	if (!rec) { rec = emptyRecord(mint, meta); table.set(mint, rec); }
	// Keep identity fresh as later battles carry newer names/symbols.
	if (meta?.name) rec.name = meta.name;
	if (meta?.symbol) rec.symbol = meta.symbol;
	if (meta?.image) rec.image = meta.image;
	return rec;
}

function settle(rec, { won, lost, draw, kills = 0, deaths = 0, at = 0 }) {
	rec.battles += 1;
	rec.kills += kills | 0;
	rec.deaths += deaths | 0;
	if (draw) { rec.draws += 1; rec.streak = 0; }
	else if (won) { rec.wins += 1; rec.streak = rec.streak > 0 ? rec.streak + 1 : 1; }
	else if (lost) { rec.losses += 1; rec.streak = rec.streak < 0 ? rec.streak - 1 : -1; }
	if (at > rec.lastBattleAt) rec.lastBattleAt = at;
}

function decorate(rec) {
	const decided = rec.wins + rec.losses;
	return {
		...rec,
		winRate: decided > 0 ? rec.wins / decided : 0,
		kd: rec.deaths > 0 ? rec.kills / rec.deaths : rec.kills,
	};
}
