// Agora — task-type vocabulary for the Commons UI (Task 09). One pure source of
// truth for how the board, the Arena view and the Guild view badge and colour the
// two multi-worker social structures. Mirrors the labour engine's task-type helpers
// (workers/agora-citizens/policy.js) so the front and back read the same words.

export const TASK_TYPE = { EXCLUSIVE: 'Exclusive', COMPETITIVE: 'Competitive', COLLABORATIVE: 'Collaborative' };

/** Normalize a free-form / lower-case task type to its canonical AgenC name. */
export function normalizeTaskType(t) {
	const s = String(t || '').trim().toLowerCase();
	if (s === 'competitive') return TASK_TYPE.COMPETITIVE;
	if (s === 'collaborative') return TASK_TYPE.COLLABORATIVE;
	return TASK_TYPE.EXCLUSIVE;
}

/** The Arena — a Competitive race where the first valid proof wins the whole escrow. */
export function isArena(t) {
	return normalizeTaskType(t) === TASK_TYPE.COMPETITIVE;
}

/** The Guild — a Collaborative task whose reward splits across contributors. */
export function isGuild(t) {
	return normalizeTaskType(t) === TASK_TYPE.COLLABORATIVE;
}

/** A multi-worker task (Arena or Guild) — several citizens engage the same PDA. */
export function isMultiWorker(t) {
	return isArena(t) || isGuild(t);
}

// Accent colours for the two structures — used by the board badges, the marker
// tint and the live views so an Arena always reads red-hot and a Guild always
// reads collaborative-green, everywhere.
export const ARENA_COLOR = '#ff6b57'; // race red
export const GUILD_COLOR = '#38d39f'; // guild green

/**
 * The badge descriptor for a task's type: a short label, a class-friendly kind, an
 * icon glyph and its accent colour. Exclusive tasks return null (no badge — they're
 * the everyday board).
 */
export function taskTypeBadge(taskType) {
	if (isArena(taskType)) return { kind: 'arena', label: 'Arena', icon: '⚔', color: ARENA_COLOR, title: 'Competitive race — first valid proof wins the whole prize' };
	if (isGuild(taskType)) return { kind: 'guild', label: 'Guild', icon: '⛬', color: GUILD_COLOR, title: 'Collaborative — contributors split the reward' };
	return null;
}

/** Short human label for a task type ("Arena" / "Guild" / "Bounty"). */
export function taskTypeLabel(taskType) {
	if (isArena(taskType)) return 'Arena';
	if (isGuild(taskType)) return 'Guild';
	return 'Bounty';
}
