// Unit tests for the Coin Wars clash engine (multiplayer/src/clash.js) and the war
// standings league math (multiplayer/src/war-standings.js). Both are pure modules
// over the dependency-free combat.js, so they run without the Colyseus schema/room
// (which can't be imported on the corrupted box) — the same isolation that lets
// combat.js be tested on its own.

import { describe, it, expect } from 'vitest';
import { ClashMatch, ClashPhase, CLASH_DEFAULTS } from '../multiplayer/src/clash.js';
import {
	computeStandings, applyBattle, rankStandings, expectedScore, BASE_RATING,
} from '../multiplayer/src/war-standings.js';

const COIN_A = { mint: 'AAA111', name: 'Alpha', symbol: 'ALPHA', image: '' };
const COIN_B = { mint: 'BBB222', name: 'Bravo', symbol: 'BRAVO', image: '' };
const SWORD = { kind: 'melee', dmg: 60, range: 2, arc: Math.PI };
const FIST = { kind: 'melee', dmg: 1, range: 2, arc: Math.PI };

// Deterministic rng so rollDamage is reproducible: 0.5 → mid-swing, no ±variance edge.
const mid = () => 0.5;

function match(config = {}) {
	return new ClashMatch({ factions: [COIN_A, COIN_B], config: { respawnMs: 1000, ...config } });
}

describe('ClashMatch — setup & roster', () => {
	it('requires exactly two distinct factions', () => {
		expect(() => new ClashMatch({ factions: [COIN_A] })).toThrow();
		expect(() => new ClashMatch({ factions: [COIN_A, COIN_A] })).toThrow();
		expect(() => new ClashMatch({ factions: [COIN_A, COIN_B] })).not.toThrow();
	});

	it('seats fighters on their faction and enforces the per-team cap', () => {
		const m = match({ maxPerTeam: 2 });
		expect(m.addFighter('a1', COIN_A.mint)).toBeTruthy();
		expect(m.addFighter('a2', COIN_A.mint)).toBeTruthy();
		expect(m.addFighter('a3', COIN_A.mint)).toBeNull(); // full
		expect(m.countFaction(COIN_A.mint)).toBe(2);
	});

	it('rejects fighters for a coin not in the match', () => {
		const m = match();
		expect(m.addFighter('x', 'CCC333')).toBeNull();
	});

	it('only starts once both communities are staffed', () => {
		const m = match({ minPerTeam: 1 });
		m.addFighter('a1', COIN_A.mint);
		expect(m.canStart()).toBe(false);
		m.addFighter('b1', COIN_B.mint);
		expect(m.canStart()).toBe(true);
	});
});

describe('ClashMatch — combat & scoring', () => {
	it('ignores attacks before the match is live', () => {
		const m = match();
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		expect(m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 0 })).toBeNull();
	});

	it('blocks friendly fire', () => {
		const m = match();
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('a2', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		expect(m.resolveAttack('a1', 'a2', SWORD, { rng: mid, now: 1 })).toBeNull();
	});

	it('damages an enemy and scores a kill for the attacker faction', () => {
		const m = match({ maxHp: 100 });
		m.addFighter('a1', COIN_A.mint, { combatLevel: 1 });
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		// 60 dmg per mid-swing → two hits drop a 100hp fighter.
		const h1 = m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 10 });
		expect(h1.killed).toBe(false);
		expect(h1.targetHp).toBeGreaterThan(0);
		const h2 = m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 20 });
		expect(h2.killed).toBe(true);
		expect(h2.scored).toBe(true);
		expect(m.factions.get(COIN_A.mint).score).toBe(1);
		expect(m.fighters.get('a1').kills).toBe(1);
		expect(m.fighters.get('b1').deaths).toBe(1);
	});

	it('cannot hit a downed fighter until they respawn', () => {
		const m = match({ respawnMs: 1000 });
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 10 });
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 20 }); // kill
		expect(m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 30 })).toBeNull(); // dead
		// Respawn at now>=respawnAt brings them back to full.
		const ev = m.tick(20 + 1000);
		expect(ev.respawns).toContain('b1');
		expect(m.fighters.get('b1').dead).toBe(false);
		expect(m.fighters.get('b1').hp).toBe(100);
	});

	it('ends the match when a faction reaches the score cap', () => {
		const m = match({ scoreCap: 2, respawnMs: 0 });
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		let t = 0;
		// One-shot weapon: each pair of calls is a fresh kill after an instant respawn.
		const kill = () => {
			m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: ++t });
			m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: ++t });
			m.tick(++t); // respawnMs:0 → revive immediately
		};
		kill();
		expect(m.phase).toBe(ClashPhase.LIVE);
		kill();
		expect(m.phase).toBe(ClashPhase.ENDED);
		const res = m.result();
		expect(res.winner).toBe(COIN_A.mint);
		expect(res.reason).toBe('score_cap');
	});
});

describe('ClashMatch — clock, sudden death & forfeit', () => {
	it('a level clock goes to sudden death, and first blood ends it', () => {
		const m = match({ durationMs: 1000, scoreCap: 99 });
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		const ev = m.tick(1000); // clock expires level (0-0)
		expect(ev.phase).toBe(ClashPhase.SUDDEN_DEATH);
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 1001 });
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 1002 }); // first blood
		expect(m.phase).toBe(ClashPhase.ENDED);
		expect(m.result().winner).toBe(COIN_A.mint);
		expect(m.result().reason).toBe('sudden_death');
	});

	it('the leader takes a timeout win', () => {
		const m = match({ durationMs: 1000, scoreCap: 99 });
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 10 });
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: 20 }); // A leads 1-0
		const ev = m.tick(1000);
		expect(ev.ended).toBe(true);
		expect(m.result().winner).toBe(COIN_A.mint);
		expect(m.result().reason).toBe('timeout');
	});

	it('forfeit hands the win to the other community', () => {
		const m = match();
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		m.forfeit(COIN_B.mint, 500);
		expect(m.result().winner).toBe(COIN_A.mint);
		expect(m.result().reason).toBe('forfeit');
	});

	it('result() is null until the match ends', () => {
		const m = match();
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		expect(m.result()).toBeNull();
	});

	it('crowns an MVP by kills then damage', () => {
		const m = match({ scoreCap: 99, respawnMs: 0 });
		m.addFighter('a1', COIN_A.mint);
		m.addFighter('a2', COIN_A.mint);
		m.addFighter('b1', COIN_B.mint);
		m.start(0);
		let t = 0;
		// a1 gets the kill; a2 only chips with a fist.
		m.resolveAttack('a2', 'b1', FIST, { rng: mid, now: ++t });
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: ++t });
		m.resolveAttack('a1', 'b1', SWORD, { rng: mid, now: ++t });
		m.forfeit(COIN_B.mint, ++t);
		expect(m.result().mvp.id).toBe('a1');
	});
});

describe('war standings — Elo league math', () => {
	function battle(winnerMint, aKills, bKills, endedAt) {
		return {
			winner: winnerMint,
			endedAt,
			factions: [
				{ mint: COIN_A.mint, name: 'Alpha', symbol: 'ALPHA', kills: aKills, deaths: bKills },
				{ mint: COIN_B.mint, name: 'Bravo', symbol: 'BRAVO', kills: bKills, deaths: aKills },
			],
		};
	}

	it('expectedScore is 0.5 for equal ratings and rises with a lead', () => {
		expect(expectedScore(1000, 1000)).toBeCloseTo(0.5);
		expect(expectedScore(1200, 1000)).toBeGreaterThan(0.5);
	});

	it('a win raises the winner above base and drops the loser below it', () => {
		const rows = computeStandings([battle(COIN_A.mint, 25, 18, 100)]);
		const a = rows.find((r) => r.mint === COIN_A.mint);
		const b = rows.find((r) => r.mint === COIN_B.mint);
		expect(a.rating).toBeGreaterThan(BASE_RATING);
		expect(b.rating).toBeLessThan(BASE_RATING);
		expect(a.wins).toBe(1);
		expect(b.losses).toBe(1);
		expect(a.rank).toBe(1);
	});

	it('tracks win/loss streaks and resets on a draw', () => {
		const rows = computeStandings([
			battle(COIN_A.mint, 25, 10, 100),
			battle(COIN_A.mint, 25, 12, 200),
			battle('draw', 20, 20, 300),
		]);
		const a = rows.find((r) => r.mint === COIN_A.mint);
		expect(a.wins).toBe(2);
		expect(a.draws).toBe(1);
		expect(a.streak).toBe(0); // draw reset the +2 run
	});

	it('aggregates K/D and computes win rate', () => {
		const rows = computeStandings([
			battle(COIN_A.mint, 25, 10, 100),
			battle(COIN_B.mint, 8, 25, 200),
		]);
		const a = rows.find((r) => r.mint === COIN_A.mint);
		expect(a.kills).toBe(33);
		expect(a.deaths).toBe(35);
		expect(a.kd).toBeCloseTo(33 / 35);
		expect(a.winRate).toBeCloseTo(0.5);
	});

	it('rating is path-consistent regardless of input order (folds chronologically)', () => {
		const b1 = battle(COIN_A.mint, 25, 10, 100);
		const b2 = battle(COIN_B.mint, 9, 25, 200);
		const forward = computeStandings([b1, b2]);
		const shuffled = computeStandings([b2, b1]);
		const fa = forward.find((r) => r.mint === COIN_A.mint).rating;
		const sa = shuffled.find((r) => r.mint === COIN_A.mint).rating;
		expect(fa).toBe(sa);
	});

	it('applyBattle + rankStandings compose into the same result as computeStandings', () => {
		const table = new Map();
		applyBattle(table, battle(COIN_A.mint, 25, 10, 100));
		const ranked = rankStandings(table);
		expect(ranked[0].mint).toBe(COIN_A.mint);
		expect(ranked[0].rank).toBe(1);
	});
});
