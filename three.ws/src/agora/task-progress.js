// Agora — the pure mapping from a worker's live task state to its visible progress
// (Task 09). Both the Arena race (a runner's position along the track) and the Guild
// fill (how much of the shared structure a contributor raised) read their geometry
// from these functions, so the animation always reflects REAL work state — a claimed
// racer is partway down the track, a proven one is at the finish, a stood-down one is
// frozen where it stopped. No time-based fake progress: state → position, nothing else.

// A worker's fraction along the track / up the structure, by state. `working` is a
// claimed-but-not-yet-proven racer mid-course; `won`/`contributed`/`completed` are at
// the finish; a `lost` racer froze partway (it did the work but another proof landed
// first — it never crosses the line).
export const STATE_PROGRESS = {
	engaged: 0.06,
	working: 0.5,
	lost: 0.5,
	completed: 1,
	contributed: 1,
	won: 1,
};

/** Fraction 0..1 of a worker's progress for its live state. */
export function stateProgress(state) {
	const p = STATE_PROGRESS[state];
	return typeof p === 'number' ? p : 0;
}

/** A short, human status label for a worker's live state, given the task kind. */
export function stateLabel(state, { arena = false } = {}) {
	switch (state) {
		case 'won':
			return 'Won';
		case 'lost':
			return 'Stood down';
		case 'contributed':
			return 'Contributed';
		case 'completed':
			return arena ? 'Proof in' : 'Done';
		case 'working':
			return arena ? 'Racing' : 'Working';
		default:
			return 'Entered';
	}
}

// Leaderboard rank by state: winners/contributors on top, then those still working,
// and a stood-down racer sinks to the bottom (it's out of the race even though its
// frozen track position sits mid-course). This is the same order the API's roster
// uses, re-derivable client-side so the HUD can re-rank live without a round-trip.
const STATE_RANK = { won: 6, contributed: 5, completed: 5, working: 3, engaged: 2, lost: 1 };

export function rankRoster(roster) {
	return [...(roster || [])].sort((a, b) => {
		const ra = STATE_RANK[a.state] ?? 0;
		const rb = STATE_RANK[b.state] ?? 0;
		if (rb !== ra) return rb - ra;
		// Won always outranks a same-rank non-winner.
		if (a.won !== b.won) return a.won ? -1 : 1;
		// Ties broken by claim time — the earlier claim has been in it longer.
		return String(a.claimedAt || '').localeCompare(String(b.claimedAt || ''));
	});
}

/** The Guild's overall fill 0..1: contributions landed vs slots (never > 1). */
export function guildFill({ contributorCount = 0, workersMax = 1 } = {}) {
	const max = Math.max(1, Number(workersMax) || 1);
	return Math.max(0, Math.min(1, Number(contributorCount) / max));
}

/** Is the whole task decided? (a winner emerged, or it settled on-chain). */
export function isDecided(view) {
	if (!view) return false;
	if (view.settlement?.settled) return true;
	if (view.settlement?.type === 'arena') return !!view.settlement.winner;
	return false;
}
