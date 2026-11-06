// Schema definitions for the live-performance world (stage_world room), shared
// between StageRoom (server) and src/stage-net.js (client, bundled by Vite the
// same way it bundles walk's schemas.js).
//
// @colyseus/schema uses delta encoding: only fields that changed since the last
// patch ride the wire, and a late joiner receives the full current set on join.
// This room delta-syncs the AUDIENCE (the `audience` map — privacy-clean, like
// IrlRoom: a session id + chosen display name + avatar + a coarse seat position,
// never a wallet), the HOST's live performance state (current utterance id, beat
// kind, animation cue, caption text), and the live TIP TICKER + leaderboard
// totals. The actual audio is NOT synced state — it rides a timed `utterance`
// broadcast each client renders locally (spatial voice + lip-sync + captions),
// so a viewer with no WebGL still gets captions + the tip economy.
//
// IMPORTANT: append-only. Field indices are positional in @colyseus/schema's
// binary protocol — inserting in the middle shifts every later index and breaks
// clients still connected to an older deployed server. Always add at the end.

import { Schema, MapSchema, ArraySchema, defineTypes } from '@colyseus/schema';

// One audience member present in the venue. Privacy-clean by construction: a
// session id (NOT an account/wallet), an opt-in display name + avatar, and a
// seat position the server assigns on a ring around the stage — never a precise
// client-reported coordinate, so the crowd renders without leaking identity.
export class StageAudience extends Schema {
	constructor() {
		super();
		this.id = '';
		this.name = '';
		this.avatar = '';
		this.x = 0; // assigned seat position (ring around the stage)
		this.z = 0;
		this.vip = false; // tip-gated front-row attention (the host sees these first)
		this.reaction = ''; // last emoji this member fired (transient; cleared after a beat)
		this.reactionTs = 0;
		this.tsServer = 0; // last heartbeat (drives the reaper)
	}
}
defineTypes(StageAudience, {
	id: 'string',
	name: 'string',
	avatar: 'string',
	x: 'float32',
	z: 'float32',
	vip: 'boolean',
	reaction: 'string',
	reactionTs: 'float64',
	tsServer: 'float64',
});

// A live tipper standing on the leaderboard. Synced so every client renders the
// same "biggest tippers" board the host reacts to. `total` is atomic units.
export class StageTipper extends Schema {
	constructor() {
		super();
		this.id = '';
		this.label = '';
		this.total = 0;
		this.count = 0;
	}
}
defineTypes(StageTipper, {
	id: 'string',
	label: 'string',
	total: 'float64', // atomic units; float64 carries the full safe-integer range
	count: 'uint32',
});

// The host's current performance frame. Updated once per beat: every client
// reads `utteranceId`/`caption`/`beat`/`cue` to keep the captions + animation in
// sync with the timed audio broadcast (a late joiner sees the current caption).
export class StageHost extends Schema {
	constructor() {
		super();
		this.agentId = '';
		this.name = '';
		this.avatar = '';
		this.voice = 'nova';
		this.utteranceId = 0; // monotonic; bumps each beat so clients dedupe
		this.beat = ''; // beat kind (opener|tip_shoutout|answer|banter|game)
		this.caption = ''; // the host's current words, as live text (a11y + fallback)
		this.cue = 'idle'; // animation cue (idle|talk|cheer|point|dj)
		this.speaking = false;
		this.startedAtMs = 0;
	}
}
defineTypes(StageHost, {
	agentId: 'string',
	name: 'string',
	avatar: 'string',
	voice: 'string',
	utteranceId: 'uint32',
	beat: 'string',
	caption: 'string',
	cue: 'string',
	speaking: 'boolean',
	startedAtMs: 'float64',
});

export class StageState extends Schema {
	constructor() {
		super();
		this.stageId = '';
		this.title = '';
		this.format = '';
		this.phase = 'preshow'; // preshow | live | between | ended
		this.host = new StageHost();
		this.audience = new MapSchema(); // sessionId → StageAudience
		this.leaderboard = new ArraySchema(); // StageTipper[], highest first
		this.totalTipsAtomic = 0; // running show total (atomic units)
		this.tipCount = 0;
		this.nextShowAt = 0; // epoch ms of the next scheduled show (between/preshow states)
	}
}
defineTypes(StageState, {
	stageId: 'string',
	title: 'string',
	format: 'string',
	phase: 'string',
	host: StageHost,
	audience: { map: StageAudience },
	leaderboard: [StageTipper],
	totalTipsAtomic: 'float64',
	tipCount: 'uint32',
	nextShowAt: 'float64',
});
