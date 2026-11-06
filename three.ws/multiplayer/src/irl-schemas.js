// Schema definitions for the IRL realtime world (irl_world room), shared between
// the IrlRoom (server) and src/irl-net.js (client, bundled by Vite the same way
// it bundles walk's schemas.js).
//
// @colyseus/schema uses delta encoding: only fields that changed since the last
// patch ride the wire, and a late joiner receives the full current set on join.
// This room delta-syncs PRESENCE (the `viewers` map) and broadcasts ambient
// REACTIONS — it does NOT sync pins. Placed agents are private by location and are
// discovered ONLY through the per-viewer /api/irl/pins proximity read (REST), never
// broadcast here as a roster (see IrlRoom.js, which never writes IrlState.pins).
//
// The IrlPin schema + IrlState.pins map below are therefore DORMANT: declared but
// never populated by the server and never read by the client (src/irl-net.js
// consumes viewers + reactions only). They are retained — not deleted — because
// @colyseus/schema's binary protocol is POSITIONAL for IrlState's own fields:
// removing the `pins` field would shift `geocell`/`viewers` down an index and break
// any client still connected to an older deployed server mid-deploy. An EMPTY pins
// map costs nothing on the wire, so the field stays; the room-frame anchoring lives
// entirely in the REST `/api/irl/pins` projection (src/irl/room-anchor.js), never
// here. There is deliberately no live pin/room stream over this socket.
//
// IMPORTANT: append-only. Field indices are positional in @colyseus/schema's
// binary protocol — inserting in the middle shifts every later index and breaks
// clients still connected to an older deployed server. Always add at the end.

import { Schema, MapSchema, defineTypes } from '@colyseus/schema';

// DORMANT (see header): a placed 3D agent's wire shape. Never populated by the
// server — pins ride the REST proximity read, not this socket — and never read by
// the client. Kept solely so IrlState.pins has a member type and IrlState's field
// order stays stable across deploys. No room-frame fields live here: room anchoring
// is REST-only (a calibrated room reaches other viewers on their next ~10 s poll),
// so adding them implied a live room stream that does not exist — they were removed.
// Because no IrlPin is ever serialized (the pins map is always empty), its own field
// set never hits the wire and can change freely; only IrlState's layout is load-
// bearing. lat/lng are float64 to carry an honest coordinate had this ever synced.
export class IrlPin extends Schema {
	constructor() {
		super();
		this.id = '';
		this.lat = 0;
		this.lng = 0;
		this.heading = 0;        // compass bearing 0–359° the agent faces
		this.avatarUrl = '';     // GLB the viewer loads (validated server-side before the row existed)
		this.avatarName = '';
		this.caption = '';
		this.x402Endpoint = '';  // optional paid endpoint the IRL Pay button calls
		this.agentId = '';       // three.ws agent id this pin embodies (cross-links)
		this.placedAt = 0;       // epoch ms, for age / ordering on the client
	}
}
defineTypes(IrlPin, {
	id: 'string',
	lat: 'float64',
	lng: 'float64',
	heading: 'float32',
	avatarUrl: 'string',
	avatarName: 'string',
	caption: 'string',
	x402Endpoint: 'string',
	agentId: 'string',
	placedAt: 'float64',
});

// A live viewer present in this geocell — live presence (D2). D1 declared this
// schema and left the map empty; D2 POPULATES it (IrlRoom.onJoin / heartbeat /
// reaper) so the count and ghost markers are pure MapSchema deltas — no new
// transport. lat/lng are ALWAYS the viewer's geocell centre + bounded jitter,
// never their precise GPS: the only location a viewer reveals is "somewhere in
// this ~1 km cell." The new D2 fields are appended (heading/avatar/ghost/
// tsServer) so an older still-connected client isn't shifted off the wire format.
export class IrlViewer extends Schema {
	constructor() {
		super();
		this.id = '';            // ephemeral session id (NOT the device token)
		this.lat = 0;            // cell-centre + bounded jitter (privacy — never precise GPS)
		this.lng = 0;
		this.agentId = '';       // the agent this viewer is embodying, if any
		// — D2 (append-only) —
		this.heading = 0;        // optional compass facing 0–359°, for ghost orientation
		this.avatar = '';        // GLB url — '' unless the viewer opted to share a ghost
		this.ghost = false;      // false = counted only; true = render a marker for this viewer
		this.tsServer = 0;       // server epoch ms of the last heartbeat (drives the reaper)
	}
}
defineTypes(IrlViewer, {
	id: 'string',
	lat: 'float64',
	lng: 'float64',
	agentId: 'string',
	// Append-only (D2): keep new fields at the end so a still-connected older
	// client isn't shifted off the positional binary format mid-deploy.
	heading: 'float32',
	avatar: 'string',
	ghost: 'boolean',
	tsServer: 'float64',
});

export class IrlState extends Schema {
	constructor() {
		super();
		// DORMANT (see header): retained for binary-layout stability only. The server
		// never writes to this map and the client never reads it — pins are private by
		// location and ride the per-viewer /api/irl/pins proximity read, not this socket.
		this.pins = new MapSchema();
		// The centre geocell this room instance serves (filterBy key). Seeded by the
		// first client to land here; identical for every viewer in the instance.
		this.geocell = '';
		// Live viewers present in this cell (D2), keyed by session id. Populated by
		// IrlRoom on join/heartbeat and pruned by its reaper — see IrlViewer above.
		this.viewers = new MapSchema();
	}
}
defineTypes(IrlState, {
	pins: { map: IrlPin },
	geocell: 'string',
	viewers: { map: IrlViewer },
});
