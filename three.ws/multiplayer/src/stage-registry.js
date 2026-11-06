// Stage registry — the in-process lookup that lets the internal /internal/stage
// webhook (called by the Vercel API after it verifies a real $THREE tip
// settlement) reach the live StageRoom for a given stageId and inject the tip so
// the host reacts within ~1s.
//
// stage_world rooms are matched with filterBy(['stageId']), so there is exactly
// one room instance per stageId in a single-process deploy — a plain Map keyed by
// stageId is the right shape. Under horizontal scaling (Redis driver) a tip could
// arrive on an instance that doesn't host the room; the webhook then reports
// `not_found` and the tip still settles + records via the API (the room reaction
// is the only thing lost), so this degrades safely rather than dropping money.

const _rooms = new Map(); // stageId → StageRoom

export function registerStage(stageId, room) {
	if (!stageId || !room) return;
	_rooms.set(String(stageId), room);
}

export function unregisterStage(stageId, room) {
	const key = String(stageId);
	// Only clear if the registered room is the one leaving — a fast dispose/recreate
	// race must never unregister the freshly-created room.
	if (_rooms.get(key) === room) _rooms.delete(key);
}

export function getStageRoom(stageId) {
	return _rooms.get(String(stageId)) || null;
}
