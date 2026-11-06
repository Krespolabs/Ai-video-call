// Agora narration — the single human-readable story line every economic action
// carries. The activity feed, the economy ticker, and the 3D world narration all
// render this one string (docs/agora.md). An activity with no story isn't worth
// recording, so the projection's `narrative` column is NOT NULL — these builders
// guarantee a real sentence for every kind.
//
// Pure module — no SDK / DB / network imports.

/** Format an atomic reward + mint label into a human chip, e.g. "0.0050 SOL" or "25,000 $THREE". */
export function rewardLabel({ amountAtomic, mint, decimals = 9 }) {
	if (amountAtomic == null) return null;
	let whole;
	try {
		const atomic = BigInt(amountAtomic);
		const base = 10n ** BigInt(decimals);
		const intPart = atomic / base;
		const frac = atomic % base;
		if (mint === '$THREE') {
			// $THREE is rendered as a whole-token count with grouping (no long decimals).
			whole = Number(atomic) / Number(base);
			const rounded = Math.round(whole);
			return `${rounded.toLocaleString('en-US')} $THREE`;
		}
		// Native SOL — 4 decimal places is the conventional precision.
		const fracStr = frac.toString().padStart(decimals, '0').slice(0, 4);
		return `${intPart.toString()}.${fracStr} SOL`;
	} catch {
		return null;
	}
}

export function postedTaskNarrative({ poster, profession, reward, minReputation }) {
	const repClause = minReputation > 0 ? ` (needs reputation ${minReputation})` : '';
	const rewardClause = reward ? ` worth ${reward}` : '';
	return `${poster} posted a ${cap(profession)} bounty${rewardClause}${repClause}.`;
}

export function hiredNarrative({ poster, profession, reward, parentLabel }) {
	const forClause = parentLabel ? ` to help finish "${truncate(parentLabel, 48)}"` : '';
	const rewardClause = reward ? ` for ${reward}` : '';
	return `${poster} hired a ${cap(profession)}${forClause}${rewardClause}.`;
}

export function claimedNarrative({ worker, profession, poster }) {
	const fromClause = poster ? ` from ${poster}` : '';
	return `${worker} claimed a ${cap(profession)} job${fromClause} and got to work.`;
}

export function completedNarrative({ worker, profession, reward, repBefore, repAfter }) {
	const rewardClause = reward ? ` and earned ${reward}` : '';
	const repClause =
		repBefore != null && repAfter != null && repAfter !== repBefore
			? `; reputation ${repBefore} → ${repAfter}`
			: '';
	return `${worker} completed a ${cap(profession)} job${rewardClause}${repClause}.`;
}

export function earnedNarrative({ worker, reward }) {
	return `${worker} received ${reward || 'a reward'} from escrow.`;
}

// ── Arena (Competitive) + Guild (Collaborative) narration (Task 09) ────────────

/** A patron opened an Arena — N citizens race, the first valid proof wins it all. */
export function postedArenaNarrative({ poster, reward, maxWorkers, minReputation }) {
	const field = maxWorkers > 1 ? `${maxWorkers} racers compete` : 'racers compete';
	const rewardClause = reward ? ` for ${reward}` : '';
	const repClause = minReputation > 0 ? ` (needs reputation ${minReputation})` : '';
	return `${poster} opened an Arena — ${field}${rewardClause}, winner takes all${repClause}.`;
}

/** A patron opened a Guild — up to N contributors split the pool. */
export function postedGuildNarrative({ poster, reward, maxWorkers }) {
	const field = maxWorkers > 1 ? `up to ${maxWorkers} contributors` : 'contributors';
	const rewardClause = reward ? ` split ${reward}` : ' collaborate';
	return `${poster} opened a Guild — ${field}${rewardClause}.`;
}

/** A racer's proof landed first — the whole purse is theirs. */
export function arenaWonNarrative({ worker, reward, repBefore, repAfter }) {
	const rewardClause = reward ? ` and took the full ${reward}` : '';
	const repClause =
		repBefore != null && repAfter != null && repAfter !== repBefore ? `; reputation ${repBefore} → ${repAfter}` : '';
	return `${worker} won the Arena${rewardClause}${repClause}.`;
}

/** A racer finished the work but another's proof landed first — no purse. */
export function arenaLostNarrative({ worker, winner }) {
	const byClause = winner ? ` — ${winner}'s proof landed first` : ' — another proof landed first';
	return `${worker} raced the Arena${byClause} and stood down.`;
}

/** A guild contributor landed a real part and earned their split share. */
export function guildContributedNarrative({ worker, reward, repBefore, repAfter }) {
	const rewardClause = reward ? ` and earned their ${reward} share` : ' and earned a share';
	const repClause =
		repBefore != null && repAfter != null && repAfter !== repBefore ? `; reputation ${repBefore} → ${repAfter}` : '';
	return `${worker} contributed to the Guild${rewardClause}${repClause}.`;
}

/** The whole multi-worker task settled on-chain (reconcile / winner projection). */
export function settledNarrative({ poster, kind, winner, contributors }) {
	if (kind === 'arena') {
		return winner
			? `${poster}'s Arena settled — ${winner} took the purse.`
			: `${poster}'s Arena settled.`;
	}
	const n = Number(contributors || 0);
	return n > 0
		? `${poster}'s Guild settled — ${n} contributor${n === 1 ? '' : 's'} split the pool.`
		: `${poster}'s Guild settled.`;
}

export function registeredNarrative({ name, profession, cluster }) {
	return `${name} joined Agora as a ${cap(profession)} on ${cluster}.`;
}

export function reconcileNarrative({ poster, profession, verb }) {
	return `${poster}'s ${cap(profession)} bounty ${verb}.`;
}

function cap(s) {
	const t = String(s || 'worker');
	return t.charAt(0).toUpperCase() + t.slice(1);
}

function truncate(s, n) {
	const t = String(s || '');
	return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
