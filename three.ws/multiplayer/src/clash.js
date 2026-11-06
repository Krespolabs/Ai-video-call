// Clash — the pure, server-authoritative core of Coin Wars (community-vs-community
// battles). Where combat.js owns a single swing's geometry and damage, clash.js
// owns the *match*: two coin communities as opposing factions, the kill score that
// decides which community wins, respawns, the round clock, sudden death, and the
// final result a war league is built from.
//
// Like combat.js this file touches NOTHING external — no network, no @colyseus
// schema, no world geometry. The ClashRoom feeds it validated hits (it already
// holds authoritative positions, so it runs combat.selectTarget itself) and ticks
// it with a clock; clash.js resolves damage through combat.js, keeps score, and
// reports phase transitions. Keeping it dependency-light (only combat.js, which is
// itself dependency-free) is deliberate: the whole match lifecycle is unit-testable
// in isolation, and the box's corrupted @colyseus/schema never enters the picture.
//
// A match is always exactly TWO factions, each a coin community keyed by its mint.
// Players fight FOR the coin they joined under; same-faction hits never land
// (friendly fire is off — you don't grief your own community). First faction to the
// score cap wins; if the clock runs out level, the match goes to sudden death where
// the next kill takes it.

import { rollDamage, applyDamage } from './combat.js';

// Match phases. A match walks lobby → countdown → live → (sudden_death) → ended.
// 'lobby' waits for both communities to field at least MIN_PER_TEAM fighters;
// 'countdown' is the brief lock-in before the gates open; 'live' is the fight;
// 'sudden_death' is overtime on a level clock; 'ended' is terminal.
export const ClashPhase = Object.freeze({
	LOBBY: 'lobby',
	COUNTDOWN: 'countdown',
	LIVE: 'live',
	SUDDEN_DEATH: 'sudden_death',
	ENDED: 'ended',
});

// Tunables. These are the defaults a ClashRoom seeds a match with; every one can be
// overridden per match (e.g. a quick 1-min skirmish vs a 5-min war) via the config.
export const CLASH_DEFAULTS = Object.freeze({
	scoreCap: 25,          // kills for a community to win outright
	durationMs: 5 * 60_000, // round clock; level score at expiry → sudden death
	countdownMs: 5_000,    // lock-in before the gates open
	respawnMs: 6_000,      // downed fighter returns after this long
	minPerTeam: 1,         // fighters each side needs before a match can start
	maxPerTeam: 16,        // roster cap per community (mirrors the room client cap)
	maxHp: 100,            // every fighter spawns at this
	startArmor: 0,         // armor is earned from loadout/cosmetics, not granted
});

// A single fighter in the match. Vitals live HERE (not on the wire-visible schema)
// for the same reason combat.js keeps them private: peers see `dead` and the
// scoreboard, never your exact HP. `combatLevel` gently scales the damage you deal
// (see combat.rollDamage). Plain mutable object — the engine owns it.
function makeFighter(id, faction, combatLevel, maxHp, startArmor) {
	return {
		id,
		faction,                 // coin mint this fighter battles for
		combatLevel: Math.max(1, combatLevel | 0),
		hp: maxHp,
		maxHp,
		armor: Math.max(0, startArmor | 0),
		dead: false,
		respawnAt: 0,            // epoch ms the engine will revive them (0 = alive)
		kills: 0,
		deaths: 0,
		damage: 0,               // total damage dealt to enemy fighters (MVP tiebreak)
		joinedAt: 0,
	};
}

export class ClashMatch {
	// `config` overrides any CLASH_DEFAULTS. `factions` is the two competing coins:
	// [{ mint, name, symbol, image }, { mint, ... }]. Both are required up front so
	// the match always knows the two sides it is scoring, even before either fields
	// a fighter (the lobby renders the matchup card from these).
	constructor({ factions, config = {} } = {}) {
		if (!Array.isArray(factions) || factions.length !== 2) {
			throw new Error('ClashMatch requires exactly two factions');
		}
		const [a, b] = factions;
		if (!a?.mint || !b?.mint || a.mint === b.mint) {
			throw new Error('ClashMatch factions must be two distinct coin mints');
		}
		this.cfg = { ...CLASH_DEFAULTS, ...config };
		// Faction state keyed by mint: identity (for the scoreboard/result) + live score.
		this.factions = new Map();
		for (const f of factions) {
			this.factions.set(f.mint, {
				mint: f.mint,
				name: f.name || f.symbol || 'Community',
				symbol: f.symbol || '',
				image: f.image || '',
				score: 0,
			});
		}
		this.fighters = new Map();   // id → fighter
		this.phase = ClashPhase.LOBBY;
		this.startedAt = 0;          // epoch ms the LIVE phase began (0 until started)
		this.endsAt = 0;             // epoch ms the round clock expires (0 until live)
		this.countdownEndsAt = 0;    // epoch ms COUNTDOWN flips to LIVE
		this.endedAt = 0;            // epoch ms the match ended
		this.winner = null;          // mint of the winning faction, or 'draw'
		this.endReason = null;       // 'score_cap' | 'timeout' | 'sudden_death' | 'forfeit'
	}

	// --- roster -------------------------------------------------------------

	// Seat a fighter on a faction. Rejected (returns null) if the mint isn't one of
	// the two competitors, the side is full, or they're already seated. The room
	// gates *eligibility* (you hold the coin) before calling this; the engine only
	// owns capacity + identity so the rules stay testable.
	addFighter(id, factionMint, { combatLevel = 1, now = 0 } = {}) {
		if (!id || !this.factions.has(factionMint)) return null;
		if (this.fighters.has(id)) return this.fighters.get(id);
		const onTeam = this.countFaction(factionMint);
		if (onTeam >= this.cfg.maxPerTeam) return null;
		const f = makeFighter(id, factionMint, combatLevel, this.cfg.maxHp, this.cfg.startArmor);
		f.joinedAt = now;
		this.fighters.set(id, f);
		return f;
	}

	removeFighter(id) {
		return this.fighters.delete(id);
	}

	countFaction(mint) {
		let n = 0;
		for (const f of this.fighters.values()) if (f.faction === mint) n++;
		return n;
	}

	// Both communities have fielded enough fighters to start a fair match.
	canStart() {
		for (const mint of this.factions.keys()) {
			if (this.countFaction(mint) < this.cfg.minPerTeam) return false;
		}
		return true;
	}

	// --- lifecycle ----------------------------------------------------------

	// Begin the lock-in countdown. Idempotent and only valid from the lobby once
	// both sides are staffed; returns true if it actually armed the countdown.
	beginCountdown(now) {
		if (this.phase !== ClashPhase.LOBBY || !this.canStart()) return false;
		this.phase = ClashPhase.COUNTDOWN;
		this.countdownEndsAt = now + this.cfg.countdownMs;
		return true;
	}

	// Open the gates: COUNTDOWN → LIVE. Resets every fighter to full and starts the
	// round clock. Callable directly (skipping countdown) for tests/instant matches.
	start(now) {
		if (this.phase === ClashPhase.LIVE) return false;
		this.phase = ClashPhase.LIVE;
		this.startedAt = now;
		this.endsAt = now + this.cfg.durationMs;
		for (const f of this.fighters.values()) this._revive(f);
		return true;
	}

	// Resolve one attack the room has already targeted (it owns positions, so it runs
	// combat.selectTarget and hands us the chosen victim). We enforce the match rules
	// the geometry can't know: no hits before LIVE, none on the dead, and never on a
	// teammate. On a kill we move the score, the meter the whole league is built on.
	//
	// Returns a result the room broadcasts as hit feedback, or null when the attack
	// is a no-op (wrong phase, dead actor, friendly, self).
	resolveAttack(attackerId, targetId, weapon, { rng = Math.random, now = 0 } = {}) {
		if (this.phase !== ClashPhase.LIVE && this.phase !== ClashPhase.SUDDEN_DEATH) return null;
		if (!attackerId || !targetId || attackerId === targetId) return null;
		const attacker = this.fighters.get(attackerId);
		const target = this.fighters.get(targetId);
		if (!attacker || !target) return null;
		if (attacker.dead || target.dead) return null;
		if (attacker.faction === target.faction) return null; // friendly fire off

		const dmg = rollDamage(weapon, attacker.combatLevel, rng);
		const res = applyDamage(target, dmg);
		attacker.damage += res.hpLost + res.armorAbsorbed;

		let scored = false;
		if (res.killed) {
			target.dead = true;
			target.respawnAt = now + this.cfg.respawnMs;
			target.deaths += 1;
			attacker.kills += 1;
			const fac = this.factions.get(attacker.faction);
			fac.score += 1;
			scored = true;
			// Sudden death: the first blood in overtime ends it immediately.
			if (this.phase === ClashPhase.SUDDEN_DEATH) {
				this._end(attacker.faction, 'sudden_death', now);
			} else if (fac.score >= this.cfg.scoreCap) {
				this._end(attacker.faction, 'score_cap', now);
			}
		}

		return {
			attacker: attackerId,
			target: targetId,
			faction: attacker.faction,
			dealt: res.dealt,
			armorAbsorbed: res.armorAbsorbed,
			hpLost: res.hpLost,
			targetHp: target.hp,
			killed: res.killed,
			scored,
			scoreA: this._scoreOf(0),
			scoreB: this._scoreOf(1),
		};
	}

	// Advance time: revive anyone whose respawn has come due, run the countdown→live
	// flip, and check the round clock. Returns the frame's events so the room can
	// broadcast respawns and the phase change without re-reading internal state.
	tick(now) {
		const events = { phase: this.phase, respawns: [], ended: false, winner: null, started: false };

		if (this.phase === ClashPhase.COUNTDOWN && now >= this.countdownEndsAt) {
			this.start(now);
			events.started = true;
			events.phase = this.phase;
		}

		if (this.phase === ClashPhase.LIVE || this.phase === ClashPhase.SUDDEN_DEATH) {
			for (const f of this.fighters.values()) {
				if (f.dead && f.respawnAt && now >= f.respawnAt) {
					this._revive(f);
					events.respawns.push(f.id);
				}
			}
		}

		// Round clock. On expiry, the leader wins; a level score goes to sudden death
		// (and only flips to a draw if a sudden-death round itself somehow expires,
		// which a real match avoids by ending on first blood — see resolveAttack).
		if (this.phase === ClashPhase.LIVE && now >= this.endsAt) {
			const [fa, fb] = this._orderedFactions();
			if (fa.score === fb.score) {
				this.phase = ClashPhase.SUDDEN_DEATH;
			} else {
				this._end(fa.score > fb.score ? fa.mint : fb.mint, 'timeout', now);
			}
		}

		if (this.phase === ClashPhase.ENDED) {
			events.ended = true;
			events.winner = this.winner;
		}
		events.phase = this.phase;
		return events;
	}

	// Concede on behalf of a community — used when a side empties out mid-match (every
	// fighter disconnected). The other community takes the win; if both are empty the
	// match is a draw. Terminal.
	forfeit(losingMint, now) {
		if (this.phase === ClashPhase.ENDED) return;
		const other = [...this.factions.keys()].find((m) => m !== losingMint);
		this._end(other || 'draw', 'forfeit', now);
	}

	// --- snapshots ----------------------------------------------------------

	// Live scoreboard for the HUD: each side's score + identity, the clock, and the
	// per-fighter kill/death/damage lines. Cheap to call every tick.
	scoreboard(now = 0) {
		const [fa, fb] = this._orderedFactions();
		const remainingMs = this.phase === ClashPhase.LIVE
			? Math.max(0, this.endsAt - now)
			: (this.phase === ClashPhase.SUDDEN_DEATH ? 0 : this.cfg.durationMs);
		return {
			phase: this.phase,
			remainingMs,
			factions: [this._facLine(fa), this._facLine(fb)],
			fighters: [...this.fighters.values()].map((f) => ({
				id: f.id, faction: f.faction, kills: f.kills, deaths: f.deaths,
				damage: Math.round(f.damage), dead: f.dead,
			})),
		};
	}

	// The terminal result a war-standings ledger is built from. Only meaningful once
	// `phase === ENDED`; returns null before then so callers can't persist a half-match.
	result(now = 0) {
		if (this.phase !== ClashPhase.ENDED) return null;
		const [fa, fb] = this._orderedFactions();
		return {
			winner: this.winner,                       // mint | 'draw'
			reason: this.endReason,
			durationMs: Math.max(0, this.endedAt - this.startedAt),
			endedAt: this.endedAt || now,
			factions: [this._facResult(fa), this._facResult(fb)],
			mvp: this._mvp(),
		};
	}

	// --- internals ----------------------------------------------------------

	_revive(f) {
		f.hp = f.maxHp;
		f.armor = Math.max(0, this.cfg.startArmor | 0);
		f.dead = false;
		f.respawnAt = 0;
	}

	_end(winnerMint, reason, now) {
		if (this.phase === ClashPhase.ENDED) return;
		this.phase = ClashPhase.ENDED;
		this.winner = winnerMint;
		this.endReason = reason;
		this.endedAt = now;
	}

	// Stable ordering of the two factions by insertion order (faction A, faction B) so
	// scoreA/scoreB and the scoreboard columns never swap between calls.
	_orderedFactions() {
		return [...this.factions.values()];
	}

	_scoreOf(index) {
		return this._orderedFactions()[index]?.score ?? 0;
	}

	_facLine(fac) {
		return {
			mint: fac.mint, name: fac.name, symbol: fac.symbol, image: fac.image,
			score: fac.score, alive: this._aliveCount(fac.mint), roster: this.countFaction(fac.mint),
		};
	}

	_facResult(fac) {
		const roster = [...this.fighters.values()].filter((f) => f.faction === fac.mint);
		return {
			mint: fac.mint, name: fac.name, symbol: fac.symbol,
			score: fac.score,
			kills: roster.reduce((s, f) => s + f.kills, 0),
			deaths: roster.reduce((s, f) => s + f.deaths, 0),
			fighters: roster.length,
		};
	}

	_aliveCount(mint) {
		let n = 0;
		for (const f of this.fighters.values()) if (f.faction === mint && !f.dead) n++;
		return n;
	}

	// Match MVP: most kills, then most damage, then fewest deaths. Null in an empty
	// match. The winning community usually but not always houses the MVP.
	_mvp() {
		let best = null;
		for (const f of this.fighters.values()) {
			if (f.kills === 0 && f.damage === 0) continue;
			if (!best
				|| f.kills > best.kills
				|| (f.kills === best.kills && f.damage > best.damage)
				|| (f.kills === best.kills && f.damage === best.damage && f.deaths < best.deaths)) {
				best = f;
			}
		}
		return best ? { id: best.id, faction: best.faction, kills: best.kills, deaths: best.deaths, damage: Math.round(best.damage) } : null;
	}
}
