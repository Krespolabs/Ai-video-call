// Wire schema for the Coin Wars clash arena (ClashRoom). Kept separate from the
// shared WalkState in schemas.js: that schema is append-only and frozen by every
// deployed walk/play client, whereas the clash arena is its own room with its own
// clients, so it gets its own clean, minimal schema. Only what peers must SEE rides
// here — a fighter's exact HP stays private on the engine (see clash.js), exactly as
// WalkRoom keeps vitals off the wire.

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

// One fighter in the arena. Mirrors the relevant slice of the walk Player (so the
// same avatar/animation client renders them) plus the two clash-only states peers
// must see: which community they fight for, whether they're downed, and their score.
export class ClashFighter extends Schema {
	constructor() {
		super();
		this.id = '';
		this.name = 'guest';
		this.color = 0xffffff;
		this.x = 0;
		this.y = 0;
		this.z = 0;
		this.yaw = 0;
		this.motion = 'idle'; // 'idle' | 'walk' | 'run'
		this.emote = '';
		this.emoteTs = 0;
		this.avatar = '';      // GLB/VRM URL so peers render the real avatar
		this.agent = '';       // optional three.ws agent id (cross-links)
		this.account = '';     // verified wallet bound in onAuth
		this.faction = '';     // coin mint this fighter battles for (which team)
		this.dead = false;     // downed → peers render the ragdoll + skip as a target
		this.kills = 0;        // this fighter's confirmed kills (scoreboard)
		this.deaths = 0;
		this.cosmetics = '';   // equipped loadout wire string (same format as walk)
		this.tsServer = 0;     // last authoritative update (epoch ms) for interpolation
	}
}
defineTypes(ClashFighter, {
	id: 'string',
	name: 'string',
	color: 'uint32',
	x: 'float32',
	y: 'float32',
	z: 'float32',
	yaw: 'float32',
	motion: 'string',
	emote: 'string',
	emoteTs: 'float64',
	avatar: 'string',
	agent: 'string',
	account: 'string',
	faction: 'string',
	dead: 'boolean',
	kills: 'uint16',
	deaths: 'uint16',
	cosmetics: 'string',
	tsServer: 'float64',
});

// The arena state every client renders. The two factions are flat fields (always
// exactly two communities) rather than a collection, so the HUD reads scoreA/scoreB
// directly. `phase` and the clock mirror the authoritative ClashMatch engine.
export class ClashState extends Schema {
	constructor() {
		super();
		this.fighters = new MapSchema();
		// Match identity + lifecycle (mirrored from the ClashMatch engine each tick).
		this.phase = 'lobby';     // lobby | countdown | live | sudden_death | ended
		this.scoreCap = 0;
		this.startedAt = 0;       // epoch ms LIVE began
		this.endsAt = 0;          // epoch ms round clock expires
		this.countdownEndsAt = 0; // epoch ms countdown flips to live
		this.winner = '';         // mint of the winning community, or 'draw' (set at end)
		this.mvpId = '';          // session id of the match MVP (set at end)
		// Faction A.
		this.aMint = '';
		this.aName = '';
		this.aSymbol = '';
		this.aImage = '';
		this.aScore = 0;
		// Faction B.
		this.bMint = '';
		this.bName = '';
		this.bSymbol = '';
		this.bImage = '';
		this.bScore = 0;
	}
}
defineTypes(ClashState, {
	fighters: { map: ClashFighter },
	phase: 'string',
	scoreCap: 'uint16',
	startedAt: 'float64',
	endsAt: 'float64',
	countdownEndsAt: 'float64',
	winner: 'string',
	mvpId: 'string',
	aMint: 'string',
	aName: 'string',
	aSymbol: 'string',
	aImage: 'string',
	aScore: 'uint16',
	bMint: 'string',
	bName: 'string',
	bSymbol: 'string',
	bImage: 'string',
	bScore: 'uint16',
});
