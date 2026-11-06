// Patronage — relationships derived from real on-chain support
// =============================================================
// The single source of truth for patron levels, perk entitlement, seasons, and
// the relationship-memory pipeline. Every number it returns is DERIVED LIVE from
// the real custody ledger (agent_custody_events) — there is no stored balance,
// level, or count anywhere. A patron's identity is their on-chain wallet: the
// verified `from` of their tips/streams (api/agents/solana-wallet.js records it
// only after independently re-verifying the transfer on-chain).
//
// Consumed by:
//   api/agents/patronage.js   — the Support surface, owner CRM, unlock gating
//   api/agents/solana-wallet.js — writes a relationship memory on a level-up
//   api/agents/talk.js        — greets recognized patrons; frees patron-perk skills

import { sql } from './db.js';
import { reverseLookupAddress } from '../../src/solana/sns.js';

// ── Levels (documented thresholds) ──────────────────────────────────────────────
// Cumulative lifetime support in USD, normalized at the moment of each transfer
// (SOL priced to USD, USDC 1:1). Thresholds are intentionally public and stable so
// the ladder a visitor sees is the ladder that gates real perks. `minUsd` is the
// INCLUSIVE floor; `supporter` is anyone who has given more than $0.
export const PATRON_LEVELS = Object.freeze([
	{ key: 'supporter', label: 'Supporter', minUsd: 0, glyph: '◔', accent: '#c4b5fd' },
	{ key: 'patron', label: 'Patron', minUsd: 10, glyph: '◑', accent: '#a78bfa' },
	{ key: 'champion', label: 'Champion', minUsd: 50, glyph: '◕', accent: '#8b5cf6' },
	{ key: 'benefactor', label: 'Benefactor', minUsd: 250, glyph: '●', accent: '#7c3aed' },
]);

/** The level for a cumulative USD figure, or null when there is no support yet. */
export function levelForUsd(usd) {
	const n = Number(usd) || 0;
	if (n <= 0) return null;
	let cur = PATRON_LEVELS[0];
	for (const lvl of PATRON_LEVELS) if (n >= lvl.minUsd) cur = lvl;
	return cur;
}

export function levelIndex(key) {
	return PATRON_LEVELS.findIndex((l) => l.key === key);
}

/**
 * The next level the viewer has NOT yet reached — their goal. A wallet with $0
 * support hasn't even reached Supporter (which needs any positive support), so its
 * goal is Supporter; once benefactor is reached this returns null.
 */
export function nextLevelForUsd(usd) {
	const n = Number(usd) || 0;
	for (const lvl of PATRON_LEVELS) {
		const reached = n > 0 && n >= lvl.minUsd;
		if (!reached) return lvl;
	}
	return null;
}

/** Progress toward the next level: { current, next, pct, remainingUsd }. */
export function progressForUsd(usd) {
	const n = Number(usd) || 0;
	const current = levelForUsd(n);
	const next = nextLevelForUsd(n);
	if (!next) return { current, next: null, pct: 1, remainingUsd: 0 };
	const floor = current ? current.minUsd : 0;
	const span = next.minUsd - floor || next.minUsd || 1;
	const pct = Math.max(0, Math.min(1, (n - floor) / span));
	return { current, next, pct, remainingUsd: Math.max(0, next.minUsd - n) };
}

// ── Seasons / epochs (monthly) ──────────────────────────────────────────────────
// A live competitive window computed purely from the calendar in UTC — no stored
// season rows, so rollover is automatic and historical aggregation just changes
// the `since` bound. There is always a season in flight to compete for.
export function currentSeason(now = new Date()) {
	const y = now.getUTCFullYear();
	const m = now.getUTCMonth();
	const startsAt = new Date(Date.UTC(y, m, 1));
	const endsAt = new Date(Date.UTC(y, m + 1, 1));
	const key = `${y}-${String(m + 1).padStart(2, '0')}`;
	const label = startsAt.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
	return { key, label, startsAt: startsAt.toISOString(), endsAt: endsAt.toISOString() };
}

// ── Patron ledger (derived from the real custody ledger) ─────────────────────────
// Group every verified inbound transfer to this agent by its on-chain payer and
// sum the normalized USD. Tips and stream settlements are the inbound events that
// carry a verified `from` (api/agents/solana-wallet.js). Unpriceable rows count as
// $0 toward the total but still as a support event, so the count never lies.

/**
 * Aggregate an agent's supporters from chain truth.
 * @param {string} agentId
 * @param {{ network?:string, since?:string|null, limit?:number|null, offset?:number }} [opts]
 * @returns {Promise<Array<{wallet:string, usd:number, supportCount:number, firstAt:string, lastAt:string}>>}
 */
export async function aggregatePatrons(agentId, opts = {}) {
	const { network = 'mainnet', since = null, limit = null, offset = 0 } = opts;
	const rows = await sql`
		SELECT meta->>'from'                       AS wallet,
		       COALESCE(SUM(usd), 0)::float8        AS usd,
		       COUNT(*)::int                        AS support_count,
		       MIN(created_at)                      AS first_at,
		       MAX(created_at)                      AS last_at
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type IN ('tip', 'stream')
		  AND meta->>'from' IS NOT NULL
		  AND meta->>'from' <> ''
		  AND (${since}::timestamptz IS NULL OR created_at >= ${since})
		GROUP BY meta->>'from'
		ORDER BY usd DESC, support_count DESC, MIN(created_at) ASC
		${limit != null ? sql`LIMIT ${Number(limit)} OFFSET ${Number(offset) || 0}` : sql``}
	`;
	return rows.map((r) => ({
		wallet: r.wallet,
		usd: Number(r.usd) || 0,
		supportCount: r.support_count,
		firstAt: r.first_at ? new Date(r.first_at).toISOString() : null,
		lastAt: r.last_at ? new Date(r.last_at).toISOString() : null,
	}));
}

/** Total distinct patrons + total normalized USD supported (lifetime or season). */
export async function patronTotals(agentId, { network = 'mainnet', since = null } = {}) {
	const [row] = await sql`
		SELECT COUNT(DISTINCT meta->>'from')::int  AS patrons,
		       COALESCE(SUM(usd), 0)::float8        AS usd,
		       COUNT(*)::int                        AS supports
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type IN ('tip', 'stream')
		  AND meta->>'from' IS NOT NULL
		  AND meta->>'from' <> ''
		  AND (${since}::timestamptz IS NULL OR created_at >= ${since})
	`;
	return { patrons: row?.patrons || 0, usd: Number(row?.usd) || 0, supports: row?.supports || 0 };
}

/** One wallet's standing on one agent, fully derived. usd=0 when not a patron. */
export async function patronStanding(agentId, wallet, { network = 'mainnet' } = {}) {
	if (!wallet) return { wallet: null, usd: 0, supportCount: 0, firstAt: null, lastAt: null, level: null, progress: progressForUsd(0) };
	const [row] = await sql`
		SELECT COALESCE(SUM(usd), 0)::float8 AS usd,
		       COUNT(*)::int                 AS support_count,
		       MIN(created_at)               AS first_at,
		       MAX(created_at)               AS last_at
		FROM agent_custody_events
		WHERE agent_id = ${agentId}
		  AND network = ${network}
		  AND event_type IN ('tip', 'stream')
		  AND meta->>'from' = ${wallet}
	`;
	const usd = Number(row?.usd) || 0;
	return {
		wallet,
		usd,
		supportCount: row?.support_count || 0,
		firstAt: row?.first_at ? new Date(row.first_at).toISOString() : null,
		lastAt: row?.last_at ? new Date(row.last_at).toISOString() : null,
		level: levelForUsd(usd),
		progress: progressForUsd(usd),
	};
}

// ── Perk ladder config ──────────────────────────────────────────────────────────

export const PERK_TYPES = Object.freeze(['greeting', 'lore', 'skill', 'launch_access', 'badge']);

export async function listPerks(agentId, { activeOnly = false } = {}) {
	const rows = await sql`
		SELECT id, perk_type, threshold_usd, title, description, payload, is_active, created_at, updated_at
		FROM agent_patron_perks
		WHERE agent_id = ${agentId}
		  ${activeOnly ? sql`AND is_active = true` : sql``}
		ORDER BY threshold_usd ASC, created_at ASC
	`;
	return rows.map((r) => ({
		id: r.id,
		perkType: r.perk_type,
		thresholdUsd: Number(r.threshold_usd) || 0,
		title: r.title,
		description: r.description || '',
		payload: r.payload || {},
		isActive: r.is_active,
	}));
}

/**
 * Perks a given USD level has earned. A perk is earned only by REAL support: a
 * wallet with $0 support is not a patron and unlocks nothing, even a $0-threshold
 * rung (which means "any supporter", not "everyone"). Used for display flags and
 * for the signature-gated unlock alike.
 */
export function entitledPerks(perks, usd) {
	const n = Number(usd) || 0;
	if (n <= 0) return [];
	return perks.filter((p) => p.isActive && n >= p.thresholdUsd);
}

// ── Display name (SNS reverse with a per-agent cache) ────────────────────────────
// reverseLookupAddress hits Bonfida; we cache the resolution on agent_patron_prefs
// so a busy wall doesn't re-resolve every wallet on every read.
export async function resolvePatronName(agentId, wallet) {
	if (!wallet) return null;
	try {
		const [pref] = await sql`
			SELECT display_name FROM agent_patron_prefs
			WHERE agent_id = ${agentId} AND patron_wallet = ${wallet}
		`;
		if (pref && pref.display_name) return pref.display_name;
	} catch { /* fall through to live lookup */ }
	let name = null;
	try { name = await reverseLookupAddress(wallet); } catch { name = null; }
	if (name) {
		await sql`
			INSERT INTO agent_patron_prefs (agent_id, patron_wallet, display_name, updated_at)
			VALUES (${agentId}, ${wallet}, ${name}, now())
			ON CONFLICT (agent_id, patron_wallet)
			DO UPDATE SET display_name = EXCLUDED.display_name, updated_at = now()
		`.catch(() => {});
	}
	return name;
}

/** The set of wallets that opted out of the public wall for this agent. */
export async function hiddenWallets(agentId) {
	const rows = await sql`
		SELECT patron_wallet FROM agent_patron_prefs
		WHERE agent_id = ${agentId} AND hidden = true
	`;
	return new Set(rows.map((r) => r.patron_wallet));
}

// ── Relationship memory on a level-up (the magic) ────────────────────────────────
// When a patron crosses into a NEW level, write a real agent memory through the
// same store the chat reads, so the agent naturally references the relationship.
// Idempotent per level via agent_patron_prefs.milestone_level — a re-tip at the
// same level writes nothing. Best-effort: a failure never blocks tip recording.

const SHORT = (w) => (w && w.length > 9 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w || 'someone');

/**
 * Recompute a patron's standing and, if they just reached a higher level than the
 * last one we recorded a memory for, write a relationship memory + update state.
 * @returns {Promise<{wrote:boolean, level:string|null}>}
 */
export async function maybeWritePatronMemory({ agentId, wallet, network = 'mainnet' }) {
	if (!agentId || !wallet) return { wrote: false, level: null };
	let standing;
	try {
		standing = await patronStanding(agentId, wallet, { network });
	} catch {
		return { wrote: false, level: null };
	}
	if (!standing.level) return { wrote: false, level: null };

	const [pref] = await sql`
		SELECT milestone_level FROM agent_patron_prefs
		WHERE agent_id = ${agentId} AND patron_wallet = ${wallet}
	`.catch(() => [null]);
	const prevIdx = pref?.milestone_level ? levelIndex(pref.milestone_level) : -1;
	const nowIdx = levelIndex(standing.level.key);
	if (nowIdx <= prevIdx) return { wrote: false, level: standing.level.key };

	const name = await resolvePatronName(agentId, wallet);
	const who = name ? `${name} (${SHORT(wallet)})` : SHORT(wallet);
	const usdStr = standing.usd >= 1 ? `$${standing.usd.toFixed(2)}` : `$${standing.usd.toFixed(4)}`;
	const content =
		`Patron ${who} has supported me with ${usdStr} in total across ${standing.supportCount} ` +
		`${standing.supportCount === 1 ? 'gift' : 'gifts'} and is now a ${standing.level.label}. ` +
		`When ${name || 'this supporter'} talks to me, greet them warmly by name and thank them ` +
		`sincerely for their support — they are one of my real patrons.`;

	try {
		await sql`
			INSERT INTO agent_memories (agent_id, type, content, tags, context, salience, tier, pinned, updated_at)
			VALUES (
				${agentId}, 'user', ${content},
				${['patron', 'relationship', standing.level.key]},
				${JSON.stringify({ kind: 'patron_milestone', patron_wallet: wallet, level: standing.level.key, usd: standing.usd, name: name || null })}::jsonb,
				0.85, 'working', false, now()
			)
		`;
		await sql`
			INSERT INTO agent_patron_prefs (agent_id, patron_wallet, milestone_level, display_name, updated_at)
			VALUES (${agentId}, ${wallet}, ${standing.level.key}, ${name || null}, now())
			ON CONFLICT (agent_id, patron_wallet)
			DO UPDATE SET milestone_level = EXCLUDED.milestone_level,
			              display_name = COALESCE(EXCLUDED.display_name, agent_patron_prefs.display_name),
			              updated_at = now()
		`;
		return { wrote: true, level: standing.level.key };
	} catch {
		return { wrote: false, level: standing.level.key };
	}
}

/**
 * The agent's patron-relationship context for the chat system prompt: the recent
 * milestone memories (so the agent can greet any recognized patron by name), plus
 * — when the caller's own wallet is known — an explicit "this user is patron X"
 * line. Pure read; safe for the public talk endpoint.
 */
export async function patronChatContext(agentId, callerWallet, { network = 'mainnet' } = {}) {
	let memories = [];
	try {
		memories = await sql`
			SELECT content, context FROM agent_memories
			WHERE agent_id = ${agentId}
			  AND tags @> ARRAY['patron']::text[]
			  AND (expires_at IS NULL OR expires_at > now())
			ORDER BY salience DESC, created_at DESC
			LIMIT 8
		`;
	} catch { memories = []; }

	let caller = null;
	if (callerWallet) {
		try {
			const standing = await patronStanding(agentId, callerWallet, { network });
			if (standing.level) {
				const name = await resolvePatronName(agentId, callerWallet).catch(() => null);
				caller = { ...standing, name };
			}
		} catch { caller = null; }
	}

	if (!memories.length && !caller) return null;

	const lines = ['## Your patrons (real on-chain supporters)'];
	if (memories.length) {
		lines.push('You remember these relationships — reference them naturally, never invent one:');
		for (const m of memories) lines.push(`- ${m.content}`);
	}
	if (caller) {
		const usdStr = caller.usd >= 1 ? `$${caller.usd.toFixed(2)}` : `$${caller.usd.toFixed(4)}`;
		const who = caller.name ? `${caller.name} (${SHORT(caller.wallet)})` : SHORT(caller.wallet);
		lines.push(
			`The user talking to you RIGHT NOW is ${who}, a ${caller.level.label} who has supported you with ` +
			`${usdStr}. Open by greeting them warmly by name and thanking them for their support.`,
		);
	}
	lines.push('Never fabricate a patron relationship that is not listed above.');
	return lines.join('\n');
}
