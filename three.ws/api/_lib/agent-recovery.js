// Social recovery & inheritance for custodial agent wallets.
//
// Agent wallets are custodial and funded — so "I lost access" or "the owner is
// gone" must not mean the funds die with the key. This module implements a real,
// auditable, threshold-approved, time-locked process that transfers WHO OWNS an
// agent (agent_identities.user_id) to a new account. The AES-GCM-encrypted secret
// is NEVER exported, copied, or decrypted here: only the owner row changes, and
// the same server-held key keeps signing for the new owner.
//
// Safe by construction:
//   - Only the current owner configures guardians/beneficiary/threshold/dead-man.
//   - A recovery needs `threshold` approvals from CURRENT active guardians AND a
//     time-lock window to elapse — a single impostor or compromised guardian
//     cannot take over, and the owner can cancel the whole thing instantly by
//     being active.
//   - At most one active process per agent (DB partial-unique index): contested /
//     duplicate requests are serialized, not raced.
//   - The wallet is frozen for autonomous spend during a contested process, so a
//     wallet with funds is never drained mid-recovery; the owner's own withdraw
//     stays open (the freeze never traps the owner).
//   - Every step is written to the custody trail (agent_custody_events) and the
//     platform audit log.
//   - Ownership transfer is atomic and idempotent: the agent_identities.user_id
//     update is guarded by the previous owner id, so it applies exactly once and a
//     re-run is a safe no-op.

import { sql } from './db.js';
import { logAudit } from './audit.js';
import { insertNotification } from './notify.js';
import { recordCustodyEvent } from './agent-trade-guards.js';

// ── tunables ────────────────────────────────────────────────────────────────
// A recovery's anti-takeover time-lock: even after enough guardians approve, the
// transfer waits this long so a present owner always has a window to cancel.
export const RECOVERY_TIMELOCK_MS = 48 * 60 * 60 * 1000; // 48h
// A recovery request that never reaches its approval threshold expires (so a
// stale impostor attempt doesn't keep the wallet frozen forever).
export const RECOVERY_REQUEST_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

export const DEAD_MAN_MIN_DAYS = 7;
export const DEAD_MAN_MAX_DAYS = 365;
export const DEAD_MAN_GRACE_MIN_DAYS = 1;
export const DEAD_MAN_GRACE_MAX_DAYS = 90;
export const DEAD_MAN_DEFAULT_INACTIVITY_DAYS = 90;
export const DEAD_MAN_DEFAULT_GRACE_DAYS = 14;

export const MAX_GUARDIANS = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);

// ── config (meta.recovery) ────────────────────────────────────────────────────

function clampInt(v, lo, hi, def) {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return def;
	return Math.min(hi, Math.max(lo, n));
}

/**
 * Read + normalize the recovery config off an agent's meta blob. The guardian /
 * beneficiary roster itself lives in agent_recovery_guardians — meta only holds
 * the threshold + dead-man settings + bookkeeping.
 */
export function getRecoveryConfig(meta) {
	const r = meta?.recovery && typeof meta.recovery === 'object' ? meta.recovery : {};
	const dm = r.dead_man && typeof r.dead_man === 'object' ? r.dead_man : {};
	return {
		threshold: r.threshold == null ? null : clampInt(r.threshold, 1, MAX_GUARDIANS, null),
		dead_man: {
			enabled: dm.enabled === true,
			inactivity_days: clampInt(dm.inactivity_days, DEAD_MAN_MIN_DAYS, DEAD_MAN_MAX_DAYS, DEAD_MAN_DEFAULT_INACTIVITY_DAYS),
			grace_days: clampInt(dm.grace_days, DEAD_MAN_GRACE_MIN_DAYS, DEAD_MAN_GRACE_MAX_DAYS, DEAD_MAN_DEFAULT_GRACE_DAYS),
			last_check_in: typeof dm.last_check_in === 'string' ? dm.last_check_in : null,
		},
		// reqId that froz-the wallet during a process, so we only auto-unfreeze a
		// freeze WE applied (never override an owner's own pre-existing freeze).
		frozen_by_request: typeof r.frozen_by_request === 'string' ? r.frozen_by_request : null,
		updated_at: typeof r.updated_at === 'string' ? r.updated_at : null,
	};
}

/**
 * Effective approval threshold for a roster. Defaults to a sensible 2-of-N
 * (or all guardians when fewer than 2 exist) until the owner sets an explicit
 * value, and is always clamped to [1, guardianCount].
 */
export function effectiveThreshold(config, guardianCount) {
	if (guardianCount <= 0) return 0;
	const want = config?.threshold ?? Math.min(2, guardianCount);
	return Math.min(guardianCount, Math.max(1, want));
}

// ── pure state machine ──────────────────────────────────────────────────────

/**
 * Compute a request's live phase from its stored fields + the freshly-counted
 * current-guardian approvals. Pure: the caller fetches the numbers, this decides.
 *
 * Returns { phase, approved, approvalsCount, approvalsRequired, timelockUntil,
 *   msUntilUnlock, msUntilExpiry }.
 */
export function computeRequestPhase({ status, approvalsRequired, approvalsCount, timelockUntil, createdAt, now = Date.now() }) {
	const terminal = ['completed', 'cancelled', 'rejected', 'expired'];
	if (terminal.includes(status)) {
		return { phase: status, approved: status === 'completed', approvalsCount, approvalsRequired, timelockUntil, msUntilUnlock: 0, msUntilExpiry: 0 };
	}
	const approved = approvalsCount >= approvalsRequired;
	const createdMs = createdAt ? new Date(createdAt).getTime() : now;
	const expiryMs = createdMs + RECOVERY_REQUEST_TTL_MS;
	const msUntilExpiry = expiryMs - now;

	if (!approved) {
		// Not yet enough approvals. Expire if the window has fully elapsed.
		if (msUntilExpiry <= 0) {
			return { phase: 'expired', approved: false, approvalsCount, approvalsRequired, timelockUntil, msUntilUnlock: 0, msUntilExpiry: 0 };
		}
		return { phase: 'pending_approvals', approved: false, approvalsCount, approvalsRequired, timelockUntil, msUntilUnlock: 0, msUntilExpiry };
	}

	// Approved — the time-lock governs from here.
	const unlockMs = timelockUntil ? new Date(timelockUntil).getTime() : now;
	const msUntilUnlock = unlockMs - now;
	if (msUntilUnlock > 0) {
		return { phase: 'time_locked', approved: true, approvalsCount, approvalsRequired, timelockUntil, msUntilUnlock, msUntilExpiry };
	}
	return { phase: 'ready', approved: true, approvalsCount, approvalsRequired, timelockUntil, msUntilUnlock: 0, msUntilExpiry };
}

/**
 * Decide what happens to the time-lock when a fresh approval count is in. Pure:
 * the caller hands in the stored request row + the freshly-counted approvals.
 *
 * Returns null when nothing changes (still below threshold, or not in the
 * approval-collecting phase), otherwise `{ until, announce }` — the time-lock
 * deadline to write and whether this is a newly-opened window worth announcing.
 *
 * A RECOVERY request carries no `timelock_until` until the threshold is first met,
 * so we open a fresh RECOVERY_TIMELOCK_MS safety window here and announce it. An
 * INHERITANCE request already carries its grace deadline (set when the dead-man's
 * switch armed), so we PRESERVE that deadline and don't re-announce — without this,
 * a guardian-gated inheritance would meet threshold but never leave
 * 'pending_approvals', so the cron (which completes only 'time_locked'/'ready'
 * rows) could never finish the hand-off.
 */
export function thresholdTimelockTransition(row, approvalsCount, now = Date.now()) {
	if (!row || row.status !== 'pending_approvals') return null;
	if (Number(approvalsCount) < Number(row.approvals_required)) return null;
	const until = row.timelock_until
		? new Date(row.timelock_until).toISOString()
		: new Date(now + RECOVERY_TIMELOCK_MS).toISOString();
	return { until, announce: !row.timelock_until };
}

// ── user resolution ───────────────────────────────────────────────────────────

/** Resolve a guardian handle (username, @username, email, or uuid) → a user row. */
export async function resolveUserHandle(handle) {
	const raw = typeof handle === 'string' ? handle.trim() : '';
	if (!raw) return null;
	if (isUuid(raw)) {
		const [u] = await sql`SELECT id, username, display_name, email FROM users WHERE id = ${raw} AND deleted_at IS NULL LIMIT 1`;
		return u || null;
	}
	const handleNorm = raw.replace(/^@/, '').toLowerCase();
	const isEmail = raw.includes('@') && !raw.startsWith('@');
	if (isEmail) {
		const [u] = await sql`SELECT id, username, display_name, email FROM users WHERE lower(email) = ${raw.toLowerCase()} AND deleted_at IS NULL LIMIT 1`;
		return u || null;
	}
	const [u] = await sql`SELECT id, username, display_name, email FROM users WHERE lower(username) = ${handleNorm} AND deleted_at IS NULL LIMIT 1`;
	return u || null;
}

/** Public-safe label for a user (never leaks email unless it's the only id). */
export function userLabel(u) {
	if (!u) return 'Unknown';
	return u.display_name || (u.username ? `@${u.username}` : null) || u.email_masked || 'a three.ws account';
}

function maskEmail(email) {
	if (!email || typeof email !== 'string' || !email.includes('@')) return null;
	const [name, domain] = email.split('@');
	const head = name.slice(0, 2);
	return `${head}${'•'.repeat(Math.max(1, name.length - 2))}@${domain}`;
}

// ── guardian roster ─────────────────────────────────────────────────────────

/** All active guardians/beneficiaries of an agent, decorated with account labels. */
export async function listGuardians(agentId) {
	const rows = await sql`
		SELECT g.id, g.guardian_user_id, g.role, g.status, g.created_at,
		       u.username, u.display_name, u.email, u.avatar_url
		FROM agent_recovery_guardians g
		JOIN users u ON u.id = g.guardian_user_id AND u.deleted_at IS NULL
		WHERE g.agent_id = ${agentId} AND g.status = 'active'
		ORDER BY g.role, g.created_at ASC
	`;
	return rows.map((r) => ({
		id: String(r.id),
		user_id: r.guardian_user_id,
		role: r.role,
		username: r.username || null,
		display_name: r.display_name || null,
		email_masked: maskEmail(r.email),
		avatar_url: r.avatar_url || null,
		label: r.display_name || (r.username ? `@${r.username}` : maskEmail(r.email)) || 'a three.ws account',
		since: r.created_at,
	}));
}

/**
 * Replace an agent's guardian/beneficiary roster + threshold + dead-man config in
 * one owner-authorized, audited operation. `guardians` and `beneficiary` are
 * already-resolved user ids (resolution + validation happen in the route so a bad
 * handle returns a clean 400). Idempotent: re-adding flips 'removed' → 'active',
 * dropping flips 'active' → 'removed'.
 *
 * @returns {Promise<{ guardians: object[], config: object }>}
 */
export async function setGuardiansAndConfig({ agentId, ownerId, guardianIds, beneficiaryId, threshold, deadMan, meta, req = null }) {
	const desired = new Map(); // user_id -> Set(roles)
	for (const gid of guardianIds || []) {
		if (!desired.has(gid)) desired.set(gid, new Set());
		desired.get(gid).add('guardian');
	}
	if (beneficiaryId) {
		if (!desired.has(beneficiaryId)) desired.set(beneficiaryId, new Set());
		desired.get(beneficiaryId).add('beneficiary');
	}

	const existing = await sql`
		SELECT guardian_user_id, role, status FROM agent_recovery_guardians WHERE agent_id = ${agentId}
	`;
	const existingKey = new Set(existing.filter((e) => e.status === 'active').map((e) => `${e.guardian_user_id}:${e.role}`));
	const desiredKey = new Set();
	for (const [uid, roles] of desired) for (const role of roles) desiredKey.add(`${uid}:${role}`);

	const added = [];
	// Upsert every desired (user, role) to active.
	for (const [uid, roles] of desired) {
		for (const role of roles) {
			await sql`
				INSERT INTO agent_recovery_guardians (agent_id, guardian_user_id, role, status, added_by)
				VALUES (${agentId}, ${uid}, ${role}, 'active', ${ownerId})
				ON CONFLICT (agent_id, guardian_user_id, role)
				DO UPDATE SET status = 'active', added_by = ${ownerId}, updated_at = now()
			`;
			if (!existingKey.has(`${uid}:${role}`)) added.push({ uid, role });
		}
	}
	// Soft-remove anything previously active that's no longer desired.
	const removed = [];
	for (const key of existingKey) {
		if (!desiredKey.has(key)) {
			const [uid, role] = key.split(':');
			await sql`
				UPDATE agent_recovery_guardians SET status = 'removed', updated_at = now()
				WHERE agent_id = ${agentId} AND guardian_user_id = ${uid} AND role = ${role}
			`;
			removed.push({ uid, role });
		}
	}

	// Persist threshold + dead-man config into meta.recovery.
	const prev = getRecoveryConfig(meta);
	const guardianCount = [...desired].filter(([, roles]) => roles.has('guardian')).length;
	const nextConfig = {
		threshold: threshold == null ? prev.threshold : clampInt(threshold, 1, Math.max(1, guardianCount || 1), null),
		dead_man: deadMan
			? {
					enabled: deadMan.enabled === true,
					inactivity_days: clampInt(deadMan.inactivity_days, DEAD_MAN_MIN_DAYS, DEAD_MAN_MAX_DAYS, prev.dead_man.inactivity_days),
					grace_days: clampInt(deadMan.grace_days, DEAD_MAN_GRACE_MIN_DAYS, DEAD_MAN_GRACE_MAX_DAYS, prev.dead_man.grace_days),
					last_check_in: prev.dead_man.last_check_in,
				}
			: prev.dead_man,
		frozen_by_request: prev.frozen_by_request,
		updated_at: new Date().toISOString(),
	};
	const nextMeta = { ...(meta || {}), recovery: nextConfig };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(nextMeta)}::jsonb WHERE id = ${agentId}`;

	await recordCustodyEvent({
		agentId, userId: ownerId, eventType: 'guardian_change', reason: 'recovery_config_updated',
		meta: { added: added.length, removed: removed.length, guardian_count: guardianCount, threshold: nextConfig.threshold, dead_man: nextConfig.dead_man },
	}).catch(() => {});
	logAudit({ userId: ownerId, action: 'recovery.config_change', resourceId: agentId, meta: { added, removed, threshold: nextConfig.threshold, dead_man_enabled: nextConfig.dead_man.enabled }, req });

	// Notify the newly designated guardians/beneficiaries.
	for (const { uid, role } of added) {
		insertNotification(uid, role === 'beneficiary' ? 'recovery_beneficiary_added' : 'recovery_guardian_added', {
			agent_id: agentId, role, by_user_id: ownerId,
		});
	}

	return { guardians: await listGuardians(agentId), config: nextConfig };
}

// ── owner-activity / dead-man ──────────────────────────────────────────────────

/**
 * The most recent moment the owner was demonstrably "alive" for this agent —
 * the dead-man's switch measures inactivity against this. We take the latest of
 * several REAL signals so a quiet-but-active owner is never falsely declared gone:
 *   - any of the owner's browser sessions seen recently,
 *   - any custody event on this agent (a withdraw, trade, limit change…),
 *   - any usage/telemetry event attributed to this agent,
 *   - the agent row's own updated_at,
 *   - an explicit "I'm here" check-in (meta.recovery.dead_man.last_check_in).
 *
 * @returns {Promise<{ lastActiveAt: Date, signals: object }>}
 */
export async function getOwnerActivity(agentId, ownerId, meta) {
	const cfg = getRecoveryConfig(meta);
	const [sessionRow] = await sql`SELECT max(last_seen_at) AS t FROM sessions WHERE user_id = ${ownerId}`;
	const [custodyRow] = await sql`SELECT max(created_at) AS t FROM agent_custody_events WHERE agent_id = ${agentId}`;
	const [usageRow] = await sql`SELECT max(created_at) AS t FROM usage_events WHERE agent_id = ${agentId}`;
	const [agentRow] = await sql`SELECT updated_at FROM agent_identities WHERE id = ${agentId}`;

	const signals = {
		session: sessionRow?.t || null,
		custody: custodyRow?.t || null,
		usage: usageRow?.t || null,
		agent_updated: agentRow?.updated_at || null,
		check_in: cfg.dead_man.last_check_in || null,
	};
	let lastActiveMs = 0;
	for (const v of Object.values(signals)) {
		if (v) lastActiveMs = Math.max(lastActiveMs, new Date(v).getTime());
	}
	if (!lastActiveMs) lastActiveMs = Date.now();
	return { lastActiveAt: new Date(lastActiveMs), signals };
}

/**
 * Dead-man status for display + cron evaluation. Returns inactivity days, whether
 * the inactivity threshold is crossed (eligible to arm), and the next check-in
 * deadline. Pure once you've fetched lastActiveAt.
 */
export function deadManStatus(config, lastActiveAt, now = Date.now()) {
	const dm = config.dead_man;
	const lastMs = lastActiveAt instanceof Date ? lastActiveAt.getTime() : new Date(lastActiveAt).getTime();
	const inactiveMs = Math.max(0, now - lastMs);
	const inactiveDays = inactiveMs / DAY_MS;
	const armAtMs = lastMs + dm.inactivity_days * DAY_MS;
	return {
		enabled: dm.enabled,
		inactivity_days: dm.inactivity_days,
		grace_days: dm.grace_days,
		inactive_days: Math.floor(inactiveDays),
		last_active_at: new Date(lastMs).toISOString(),
		arm_at: new Date(armAtMs).toISOString(),
		ms_until_arm: armAtMs - now,
		eligible_to_arm: dm.enabled && now >= armAtMs,
	};
}

// ── request reads ──────────────────────────────────────────────────────────────

/** Count current-guardian approve/decline votes for a request (stale votes from
 *  removed/deleted guardians excluded by the JOIN). */
export async function countApprovals(requestId, agentId) {
	const [row] = await sql`
		SELECT
			count(*) FILTER (WHERE a.decision = 'approve')::int AS approvals,
			count(*) FILTER (WHERE a.decision = 'decline')::int AS declines
		FROM agent_recovery_approvals a
		JOIN agent_recovery_guardians g
		  ON g.agent_id = ${agentId} AND g.guardian_user_id = a.guardian_user_id
		 AND g.role = 'guardian' AND g.status = 'active'
		WHERE a.request_id = ${requestId}
	`;
	return { approvals: row?.approvals || 0, declines: row?.declines || 0 };
}

/** The single active request for an agent (or null). */
export async function getActiveRequest(agentId) {
	const [row] = await sql`
		SELECT * FROM agent_recovery_requests
		WHERE agent_id = ${agentId} AND status IN ('pending_approvals', 'time_locked', 'ready')
		ORDER BY created_at DESC LIMIT 1
	`;
	return row || null;
}

/** Decorate a request row with its live phase + voter detail for the UI. */
export async function decorateRequest(row, agentId) {
	if (!row) return null;
	const { approvals, declines } = await countApprovals(row.id, agentId);
	const phase = computeRequestPhase({
		status: row.status,
		approvalsRequired: row.approvals_required,
		approvalsCount: approvals,
		timelockUntil: row.timelock_until,
		createdAt: row.created_at,
	});
	const votes = await sql`
		SELECT a.guardian_user_id, a.decision, a.updated_at,
		       u.username, u.display_name
		FROM agent_recovery_approvals a
		JOIN users u ON u.id = a.guardian_user_id
		WHERE a.request_id = ${row.id}
		ORDER BY a.updated_at DESC
	`;
	// No-guardian inheritance can't be "ready" until the beneficiary confirms.
	const needsBeneficiary = row.kind === 'inheritance' && row.approvals_required === 0 && row.meta?.beneficiary_confirmed !== true;
	let displayStatus = phase.phase;
	if (needsBeneficiary && displayStatus === 'ready') displayStatus = 'time_locked';
	return {
		id: row.id,
		agent_id: row.agent_id,
		kind: row.kind,
		status: displayStatus,
		needs_beneficiary_confirmation: needsBeneficiary,
		stored_status: row.status,
		requester_id: row.requester_id,
		prev_owner_id: row.prev_owner_id,
		new_owner_id: row.new_owner_id,
		approvals: phase.approvalsCount,
		approvals_required: phase.approvalsRequired,
		declines,
		approved: phase.approved,
		timelock_until: row.timelock_until,
		ms_until_unlock: phase.msUntilUnlock,
		ms_until_expiry: phase.msUntilExpiry,
		reason: row.reason,
		created_at: row.created_at,
		completed_at: row.completed_at,
		votes: votes.map((v) => ({
			user_id: v.guardian_user_id,
			decision: v.decision,
			at: v.updated_at,
			label: v.display_name || (v.username ? `@${v.username}` : 'guardian'),
		})),
	};
}

/** Recent request history for an agent (for the owner's audit view). */
export async function listRequests(agentId, { limit = 20 } = {}) {
	const lim = Math.min(50, Math.max(1, Number(limit) || 20));
	const rows = await sql`
		SELECT * FROM agent_recovery_requests
		WHERE agent_id = ${agentId}
		ORDER BY created_at DESC LIMIT ${lim}
	`;
	return Promise.all(rows.map((r) => decorateRequest(r, agentId)));
}

// ── freeze helpers ─────────────────────────────────────────────────────────────
// Freeze autonomous spend for the duration of a contested process so a funded
// wallet can't be drained out from under a recovery. We only auto-unfreeze a
// freeze WE applied (tracked by request id), never an owner's own freeze.

async function freezeForRequest(agentId, requestId, ownerId) {
	const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`;
	const meta = { ...(row?.meta || {}) };
	const spend = { ...(meta.spend_limits || {}) };
	const alreadyFrozen = spend.frozen === true;
	spend.frozen = true;
	spend.updated_at = new Date().toISOString();
	const recovery = { ...getRecoveryConfig(meta), frozen_by_request: alreadyFrozen ? (meta.recovery?.frozen_by_request || null) : requestId };
	meta.spend_limits = spend;
	meta.recovery = recovery;
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agentId}`;
	await recordCustodyEvent({ agentId, userId: ownerId, eventType: 'limit_change', reason: 'recovery_freeze', meta: { request_id: requestId, auto: true } }).catch(() => {});
}

async function unfreezeForRequest(agentId, requestId, actorId) {
	const [row] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`;
	const meta = { ...(row?.meta || {}) };
	const frozenBy = meta.recovery?.frozen_by_request || null;
	if (frozenBy !== requestId) return; // we didn't freeze it (or owner's own freeze) — leave it
	const spend = { ...(meta.spend_limits || {}) };
	spend.frozen = false;
	spend.updated_at = new Date().toISOString();
	meta.spend_limits = spend;
	meta.recovery = { ...meta.recovery, frozen_by_request: null };
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agentId}`;
	await recordCustodyEvent({ agentId, userId: actorId ?? null, eventType: 'limit_change', reason: 'recovery_unfreeze', meta: { request_id: requestId, auto: true } }).catch(() => {});
}

// ── notifications fan-out ──────────────────────────────────────────────────────

async function notifyParties(agentId, type, payload, { includeOwner = true } = {}) {
	const [agent] = await sql`SELECT user_id FROM agent_identities WHERE id = ${agentId}`;
	const roster = await sql`SELECT DISTINCT guardian_user_id FROM agent_recovery_guardians WHERE agent_id = ${agentId} AND status = 'active'`;
	const recipients = new Set();
	if (includeOwner && agent?.user_id) recipients.add(agent.user_id);
	for (const r of roster) recipients.add(r.guardian_user_id);
	for (const uid of recipients) insertNotification(uid, type, { agent_id: agentId, ...payload });
}

// ── recovery request lifecycle ─────────────────────────────────────────────────

/**
 * Open a recovery request. The requester must be a current active guardian or the
 * beneficiary; they nominate a new owner (themselves, or — if a beneficiary is
 * set — the beneficiary). Freezes the wallet, notifies every party, and starts
 * the approval clock. Throws { status, code, message } on any guard failure.
 */
export async function createRecoveryRequest({ agentId, requesterId, reason, req = null }) {
	const [agent] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!agent) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });
	if (agent.user_id === requesterId) {
		throw Object.assign(new Error('you already own this agent'), { status: 409, code: 'already_owner' });
	}

	// The requester must hold a real role in this agent's recovery graph.
	const roles = await sql`
		SELECT role FROM agent_recovery_guardians
		WHERE agent_id = ${agentId} AND guardian_user_id = ${requesterId} AND status = 'active'
	`;
	const roleSet = new Set(roles.map((r) => r.role));
	if (roleSet.size === 0) {
		throw Object.assign(new Error('you are not a guardian or beneficiary of this agent'), { status: 403, code: 'not_a_guardian' });
	}

	// Nominee: the beneficiary if one is set, else the requesting guardian.
	const [beneficiary] = await sql`
		SELECT guardian_user_id FROM agent_recovery_guardians
		WHERE agent_id = ${agentId} AND role = 'beneficiary' AND status = 'active' LIMIT 1
	`;
	const newOwnerId = beneficiary?.guardian_user_id || requesterId;

	const guardians = await sql`SELECT count(*)::int AS n FROM agent_recovery_guardians WHERE agent_id = ${agentId} AND role = 'guardian' AND status = 'active'`;
	const guardianCount = guardians[0]?.n || 0;
	const config = getRecoveryConfig(agent.meta);
	// Threshold counts OTHER guardians' approvals — the requester can never approve
	// their own takeover. A manual recovery therefore needs at least one guardian
	// other than the requester; a beneficiary-only setup recovers via the dead-man
	// inheritance path instead, not this one.
	const otherGuardians = guardianCount - (roleSet.has('guardian') ? 1 : 0);
	if (otherGuardians < 1) {
		throw Object.assign(new Error('recovery needs at least one guardian (other than you) to approve — ask the owner to add guardians, or use the inheritance path'), { status: 422, code: 'not_enough_guardians' });
	}
	const required = Math.max(1, Math.min(effectiveThreshold(config, guardianCount), otherGuardians));

	let row;
	try {
		[row] = await sql`
			INSERT INTO agent_recovery_requests
				(agent_id, kind, status, requester_id, prev_owner_id, new_owner_id, approvals_required, reason)
			VALUES (${agentId}, 'recovery', 'pending_approvals', ${requesterId}, ${agent.user_id}, ${newOwnerId}, ${required}, ${reason ? String(reason).slice(0, 500) : null})
			RETURNING *
		`;
	} catch (e) {
		// Hit the one-active-request-per-agent partial unique index.
		if (String(e?.message || '').includes('agent_recovery_requests_one_active') || e?.code === '23505') {
			throw Object.assign(new Error('a recovery or inheritance process is already in progress for this agent'), { status: 409, code: 'process_in_progress' });
		}
		throw e;
	}

	await freezeForRequest(agentId, row.id, agent.user_id);
	await recordCustodyEvent({
		agentId, userId: requesterId, eventType: 'recovery_request', reason: 'recovery_opened',
		meta: { request_id: row.id, new_owner_id: newOwnerId, approvals_required: required, kind: 'recovery' },
	}).catch(() => {});
	logAudit({ userId: requesterId, action: 'recovery.request', resourceId: agentId, meta: { request_id: row.id, new_owner_id: newOwnerId }, req });

	// Notify the owner (their agent is under recovery — they can cancel) and all
	// guardians (their approval is needed).
	await notifyParties(agentId, 'recovery_requested', { request_id: row.id, requester_id: requesterId, agent_name: agent.name });

	return decorateRequest(row, agentId);
}

/**
 * Record a guardian's vote (approve/decline) on the active request. When the
 * approval threshold is first reached, arm the time-lock. Returns the live
 * decorated request.
 */
export async function recordVote({ agentId, requestId, guardianId, decision, req = null }) {
	if (decision !== 'approve' && decision !== 'decline') {
		throw Object.assign(new Error('decision must be approve or decline'), { status: 400, code: 'bad_decision' });
	}
	const [row] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId} AND agent_id = ${agentId}`;
	if (!row) throw Object.assign(new Error('recovery request not found'), { status: 404, code: 'not_found' });
	if (!['pending_approvals', 'time_locked', 'ready'].includes(row.status)) {
		throw Object.assign(new Error('this request is no longer open'), { status: 409, code: 'not_open' });
	}
	// Voter must be a current active GUARDIAN (beneficiary doesn't vote).
	const [g] = await sql`
		SELECT 1 FROM agent_recovery_guardians
		WHERE agent_id = ${agentId} AND guardian_user_id = ${guardianId} AND role = 'guardian' AND status = 'active'
	`;
	if (!g) throw Object.assign(new Error('only an active guardian can vote'), { status: 403, code: 'not_a_guardian' });
	if (guardianId === row.requester_id) {
		throw Object.assign(new Error('the requester cannot approve their own recovery'), { status: 403, code: 'no_self_approve' });
	}

	await sql`
		INSERT INTO agent_recovery_approvals (request_id, guardian_user_id, decision)
		VALUES (${requestId}, ${guardianId}, ${decision})
		ON CONFLICT (request_id, guardian_user_id)
		DO UPDATE SET decision = ${decision}, updated_at = now()
	`;
	await recordCustodyEvent({ agentId, userId: guardianId, eventType: 'recovery_approval', reason: decision, meta: { request_id: requestId } }).catch(() => {});
	logAudit({ userId: guardianId, action: `recovery.${decision}`, resourceId: agentId, meta: { request_id: requestId }, req });

	// Re-evaluate: arm/confirm the time-lock the moment the threshold is first
	// reached. Recovery opens a fresh 48h window; a guardian-gated inheritance keeps
	// its already-set grace deadline but still transitions out of pending_approvals
	// so the cron can complete it.
	const { approvals } = await countApprovals(requestId, agentId);
	const transition = thresholdTimelockTransition(row, approvals);
	if (transition) {
		await sql`UPDATE agent_recovery_requests SET status = 'time_locked', timelock_until = ${transition.until}, updated_at = now() WHERE id = ${requestId} AND status = 'pending_approvals'`;
		if (transition.announce) {
			await notifyParties(agentId, 'recovery_timelock_started', { request_id: requestId, unlock_at: transition.until });
		}
	} else if (decision === 'approve') {
		insertNotification(row.requester_id, 'recovery_approval_received', { agent_id: agentId, request_id: requestId, by_user_id: guardianId });
	}

	const [fresh] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId}`;
	return decorateRequest(fresh, agentId);
}

/**
 * Cancel an active request. Allowed for the current owner (the canonical abort:
 * "I'm here") or the original requester (withdrawing their attempt). Unfreezes the
 * wallet if we froze it.
 */
export async function cancelRequest({ agentId, requestId, actorId, byOwner, reason, req = null }) {
	const [row] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId} AND agent_id = ${agentId}`;
	if (!row) throw Object.assign(new Error('recovery request not found'), { status: 404, code: 'not_found' });
	if (!['pending_approvals', 'time_locked', 'ready'].includes(row.status)) {
		throw Object.assign(new Error('this request is no longer open'), { status: 409, code: 'not_open' });
	}
	const status = byOwner ? 'rejected' : 'cancelled';
	await sql`UPDATE agent_recovery_requests SET status = ${status}, updated_at = now(), completed_at = now(), meta = meta || ${JSON.stringify({ cancelled_by: actorId, reason: reason ? String(reason).slice(0, 300) : null })}::jsonb WHERE id = ${requestId}`;
	await unfreezeForRequest(agentId, requestId, actorId);
	await recordCustodyEvent({ agentId, userId: actorId, eventType: 'recovery_cancel', reason: byOwner ? 'owner_rejected' : 'requester_withdrew', meta: { request_id: requestId } }).catch(() => {});
	logAudit({ userId: actorId, action: 'recovery.cancel', resourceId: agentId, meta: { request_id: requestId, by_owner: !!byOwner }, req });
	await notifyParties(agentId, byOwner ? 'recovery_rejected_by_owner' : 'recovery_withdrawn', { request_id: requestId });
	const [fresh] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId}`;
	return decorateRequest(fresh, agentId);
}

/**
 * Atomic, idempotent ownership transfer. Changes ONLY agent_identities.user_id
 * (guarded by the previous owner id) and the linked avatar's owner_id — the
 * encrypted secret is untouched and never exported. Re-running after a partial
 * crash is a safe no-op. Records an ownership_transfer custody event and lifts the
 * recovery freeze.
 */
export async function transferAgentOwnership({ agentId, requestId, prevOwnerId, newOwnerId, kind, actorId = null, req = null }) {
	const [agent] = await sql`SELECT id, user_id, avatar_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!agent) throw Object.assign(new Error('agent not found'), { status: 404, code: 'not_found' });

	// Idempotent: already transferred to the nominee.
	if (agent.user_id === newOwnerId) {
		await sql`UPDATE agent_recovery_requests SET status = 'completed', completed_at = coalesce(completed_at, now()), updated_at = now() WHERE id = ${requestId} AND status NOT IN ('completed')`;
		return { transferred: false, alreadyOwned: true };
	}
	// The owner changed out from under us (e.g. owner returned and took action) —
	// refuse: never transfer away from an owner who is no longer `prevOwnerId`.
	if (agent.user_id !== prevOwnerId) {
		await sql`UPDATE agent_recovery_requests SET status = 'rejected', completed_at = now(), updated_at = now(), meta = meta || ${JSON.stringify({ aborted: 'owner_changed' })}::jsonb WHERE id = ${requestId}`;
		await unfreezeForRequest(agentId, requestId, actorId);
		throw Object.assign(new Error('ownership changed during recovery — transfer aborted'), { status: 409, code: 'owner_changed' });
	}

	// Guarded transfer: applies exactly once.
	const moved = await sql`
		UPDATE agent_identities SET user_id = ${newOwnerId}, updated_at = now()
		WHERE id = ${agentId} AND user_id = ${prevOwnerId}
		RETURNING id
	`;
	if (!moved.length) {
		throw Object.assign(new Error('ownership transfer did not apply — retry'), { status: 409, code: 'transfer_noop' });
	}
	// Move the linked avatar too, if this agent owns one and it's still the prev
	// owner's (best-effort: the wallet authority is the agent row above).
	if (agent.avatar_id) {
		await sql`UPDATE avatars SET owner_id = ${newOwnerId} WHERE id = ${agent.avatar_id} AND owner_id = ${prevOwnerId}`.catch(() => {});
	}

	await sql`UPDATE agent_recovery_requests SET status = 'completed', completed_at = now(), updated_at = now() WHERE id = ${requestId}`;
	await unfreezeForRequest(agentId, requestId, newOwnerId);

	await recordCustodyEvent({
		agentId, userId: newOwnerId, eventType: 'ownership_transfer', reason: kind === 'inheritance' ? 'inheritance_completed' : 'recovery_completed',
		meta: { request_id: requestId, prev_owner_id: prevOwnerId, new_owner_id: newOwnerId, kind },
	}).catch(() => {});
	logAudit({ userId: actorId ?? newOwnerId, action: 'recovery.ownership_transfer', resourceId: agentId, meta: { request_id: requestId, prev_owner_id: prevOwnerId, new_owner_id: newOwnerId, kind }, req });

	// Notify everyone: the former owner (their agent moved), the new owner (they
	// now control it), and the guardians.
	insertNotification(prevOwnerId, 'agent_ownership_transferred_out', { agent_id: agentId, agent_name: agent.name, new_owner_id: newOwnerId, kind });
	insertNotification(newOwnerId, 'agent_ownership_transferred_in', { agent_id: agentId, agent_name: agent.name, prev_owner_id: prevOwnerId, kind });
	await notifyParties(agentId, 'recovery_completed', { request_id: requestId, kind, new_owner_id: newOwnerId }, { includeOwner: false });

	return { transferred: true };
}

/**
 * Complete a request whose time-lock has elapsed and approvals still hold. Used by
 * the explicit "complete" route (recovery) and by the cron (inheritance). Re-runs
 * the live phase so we never transfer a request that isn't truly ready.
 */
export async function completeIfReady({ agentId, requestId, actorId = null, req = null }) {
	const [row] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId} AND agent_id = ${agentId}`;
	if (!row) throw Object.assign(new Error('recovery request not found'), { status: 404, code: 'not_found' });
	if (row.status === 'completed') return { transferred: false, alreadyOwned: true };
	if (!['time_locked', 'ready'].includes(row.status)) {
		throw Object.assign(new Error('this request is not ready to complete'), { status: 409, code: 'not_ready' });
	}
	const { approvals } = await countApprovals(requestId, agentId);
	const phase = computeRequestPhase({
		status: row.status, approvalsRequired: row.approvals_required, approvalsCount: approvals,
		timelockUntil: row.timelock_until, createdAt: row.created_at,
	});
	if (phase.phase !== 'ready') {
		throw Object.assign(new Error('the safety window has not elapsed or approvals fell below threshold'), { status: 409, code: 'not_ready', detail: { phase: phase.phase, ms_until_unlock: phase.msUntilUnlock, approvals, required: row.approvals_required } });
	}
	// Inheritance with no guardians: the beneficiary's explicit confirmation is the
	// required human gate (never transfer purely on a timer).
	if (row.kind === 'inheritance' && row.approvals_required === 0 && row.meta?.beneficiary_confirmed !== true) {
		throw Object.assign(new Error('awaiting the beneficiary’s confirmation before control can pass'), { status: 409, code: 'awaiting_beneficiary', detail: { phase: 'awaiting_beneficiary' } });
	}
	if (row.status !== 'ready') {
		await sql`UPDATE agent_recovery_requests SET status = 'ready', updated_at = now() WHERE id = ${requestId}`;
	}
	return transferAgentOwnership({ agentId, requestId, prevOwnerId: row.prev_owner_id, newOwnerId: row.new_owner_id, kind: row.kind, actorId, req });
}

// ── check-in (cancel a looming dead-man) ───────────────────────────────────────

/**
 * The owner stamps "I'm here". Records the check-in (resetting the dead-man clock)
 * and aborts any in-flight INHERITANCE process — the dead-man's switch must always
 * be defeatable by the owner simply being present.
 */
export async function ownerCheckIn({ agentId, ownerId, req = null }) {
	const [agent] = await sql`SELECT meta FROM agent_identities WHERE id = ${agentId}`;
	const meta = { ...(agent?.meta || {}) };
	const cfg = getRecoveryConfig(meta);
	cfg.dead_man.last_check_in = new Date().toISOString();
	cfg.updated_at = new Date().toISOString();
	meta.recovery = cfg;
	await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb, updated_at = now() WHERE id = ${agentId}`;

	// Abort any active inheritance (recovery requests are NOT auto-cancelled by a
	// check-in — those are explicit owner-driven flows; only the dead-man path is).
	const active = await getActiveRequest(agentId);
	let cancelled = null;
	if (active && active.kind === 'inheritance') {
		cancelled = await cancelRequest({ agentId, requestId: active.id, actorId: ownerId, byOwner: true, reason: 'owner_checked_in', req });
	}
	await recordCustodyEvent({ agentId, userId: ownerId, eventType: 'dead_man_checkin', reason: 'owner_present', meta: { aborted_inheritance: cancelled?.id || null } }).catch(() => {});
	logAudit({ userId: ownerId, action: 'recovery.checkin', resourceId: agentId, meta: { aborted_inheritance: cancelled?.id || null }, req });
	return { checked_in_at: cfg.dead_man.last_check_in, aborted_inheritance: cancelled };
}

/**
 * Arm the dead-man's switch: open an INHERITANCE request to the beneficiary after
 * the owner's inactivity has crossed the configured threshold. Never auto-completes
 * — it needs guardian/beneficiary confirmation AND the grace window, and the owner
 * can cancel it just by being active. Used by the cron and the beneficiary's
 * manual "arm" action. Returns null if not eligible / already armed.
 */
export async function armInheritance({ agentId, actorId = null, req = null }) {
	const [agent] = await sql`SELECT id, user_id, name, meta FROM agent_identities WHERE id = ${agentId} AND deleted_at IS NULL`;
	if (!agent) return null;
	const cfg = getRecoveryConfig(agent.meta);
	if (!cfg.dead_man.enabled) return null;

	// Must have a beneficiary to inherit to.
	const [beneficiary] = await sql`SELECT guardian_user_id FROM agent_recovery_guardians WHERE agent_id = ${agentId} AND role = 'beneficiary' AND status = 'active' LIMIT 1`;
	if (!beneficiary) return null;

	// Already an active process? Don't double-arm.
	if (await getActiveRequest(agentId)) return null;

	// Eligibility: inactivity threshold crossed.
	const { lastActiveAt } = await getOwnerActivity(agentId, agent.user_id, agent.meta);
	const dm = deadManStatus(cfg, lastActiveAt);
	if (!dm.eligible_to_arm) return null;

	// Confirmation threshold: at least one guardian (if any exist) must confirm,
	// otherwise the beneficiary's own confirmation suffices.
	const guardians = await sql`SELECT count(*)::int AS n FROM agent_recovery_guardians WHERE agent_id = ${agentId} AND role = 'guardian' AND status = 'active'`;
	const guardianCount = guardians[0]?.n || 0;
	// With guardians, inheritance still needs threshold guardian confirmations.
	// With no guardians, the beneficiary's own confirmation is the only human gate
	// (required = 0 guardian votes) — readiness then also checks beneficiary_confirmed.
	const required = guardianCount > 0 ? Math.min(effectiveThreshold(cfg, guardianCount), guardianCount) : 0;

	// Grace window doubles as the time-lock: control passes only after grace_days
	// of continued inactivity AND confirmation.
	const until = new Date(Date.now() + cfg.dead_man.grace_days * DAY_MS).toISOString();

	let row;
	try {
		[row] = await sql`
			INSERT INTO agent_recovery_requests
				(agent_id, kind, status, requester_id, prev_owner_id, new_owner_id, approvals_required, timelock_until, reason, meta)
			VALUES (${agentId}, 'inheritance', 'pending_approvals', ${actorId}, ${agent.user_id}, ${beneficiary.guardian_user_id},
				${required}, ${until}, 'dead_man_switch', ${JSON.stringify({ grace_days: cfg.dead_man.grace_days, inactivity_days: cfg.dead_man.inactivity_days, last_active_at: dm.last_active_at })}::jsonb)
			RETURNING *
		`;
	} catch (e) {
		if (e?.code === '23505') return null; // lost the race to another armer
		throw e;
	}

	// If no guardians exist, the beneficiary's confirmation is the only gate — but
	// we still require the grace window. Pre-seed nothing; the beneficiary confirms.
	await freezeForRequest(agentId, row.id, agent.user_id);
	await recordCustodyEvent({ agentId, userId: actorId ?? null, eventType: 'dead_man_arm', reason: 'inactivity_threshold_crossed', meta: { request_id: row.id, beneficiary_id: beneficiary.guardian_user_id, grace_until: until, last_active_at: dm.last_active_at } }).catch(() => {});
	logAudit({ userId: actorId ?? null, action: 'recovery.inheritance_armed', resourceId: agentId, meta: { request_id: row.id, beneficiary_id: beneficiary.guardian_user_id }, req });

	// Loud, early notification — the owner gets a prominent "we think you're gone,
	// tap I'm here to cancel" and the grace window starts.
	insertNotification(agent.user_id, 'dead_man_armed_owner', { agent_id: agentId, agent_name: agent.name, request_id: row.id, grace_until: until });
	await notifyParties(agentId, 'inheritance_armed', { request_id: row.id, agent_name: agent.name, beneficiary_id: beneficiary.guardian_user_id, grace_until: until }, { includeOwner: false });

	return decorateRequest(row, agentId);
}

/**
 * Confirm an inheritance (guardian or beneficiary). For inheritance, a beneficiary
 * confirmation also counts toward the threshold when there are no guardians.
 * Delegates to recordVote for guardians; beneficiary-only confirmation arms the
 * time-lock directly.
 */
export async function confirmInheritance({ agentId, requestId, actorId, req = null }) {
	const [row] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId} AND agent_id = ${agentId} AND kind = 'inheritance'`;
	if (!row) throw Object.assign(new Error('inheritance request not found'), { status: 404, code: 'not_found' });
	if (!['pending_approvals', 'time_locked', 'ready'].includes(row.status)) {
		throw Object.assign(new Error('this request is no longer open'), { status: 409, code: 'not_open' });
	}
	const roles = await sql`SELECT role FROM agent_recovery_guardians WHERE agent_id = ${agentId} AND guardian_user_id = ${actorId} AND status = 'active'`;
	const roleSet = new Set(roles.map((r) => r.role));
	if (roleSet.size === 0) throw Object.assign(new Error('only a guardian or the beneficiary can confirm'), { status: 403, code: 'not_a_party' });

	// A guardian votes through the normal path.
	if (roleSet.has('guardian')) {
		return recordVote({ agentId, requestId, guardianId: actorId, decision: 'approve', req });
	}
	// Beneficiary-only (no guardian role): their confirmation satisfies the gate
	// when there are no guardians. Arm the time-lock if not already.
	await recordCustodyEvent({ agentId, userId: actorId, eventType: 'recovery_approval', reason: 'beneficiary_confirm', meta: { request_id: requestId } }).catch(() => {});
	if (row.status === 'pending_approvals') {
		const until = row.timelock_until || new Date(Date.now() + 0).toISOString(); // grace already set at arm time
		await sql`UPDATE agent_recovery_requests SET status = 'time_locked', timelock_until = coalesce(timelock_until, ${until}), meta = meta || ${JSON.stringify({ beneficiary_confirmed: true })}::jsonb, updated_at = now() WHERE id = ${requestId}`;
	} else {
		await sql`UPDATE agent_recovery_requests SET meta = meta || ${JSON.stringify({ beneficiary_confirmed: true })}::jsonb, updated_at = now() WHERE id = ${requestId}`;
	}
	const [fresh] = await sql`SELECT * FROM agent_recovery_requests WHERE id = ${requestId}`;
	return decorateRequest(fresh, agentId);
}

// ── cron sweep: dead-man evaluation + completion + expiry ───────────────────────

const DEAD_MAN_REMINDER_WINDOW_MS = 7 * DAY_MS; // warn 7 days before the switch arms

/**
 * Mark any request that never reached its approval threshold within the TTL as
 * expired, and lift the freeze we applied. Keeps a stalled impostor attempt from
 * freezing a wallet forever.
 */
export async function expireStaleRequests() {
	const cutoff = new Date(Date.now() - RECOVERY_REQUEST_TTL_MS).toISOString();
	const stale = await sql`
		SELECT id, agent_id FROM agent_recovery_requests
		WHERE status = 'pending_approvals' AND created_at < ${cutoff}
	`;
	for (const r of stale) {
		await sql`UPDATE agent_recovery_requests SET status = 'expired', updated_at = now(), completed_at = now() WHERE id = ${r.id} AND status = 'pending_approvals'`;
		await unfreezeForRequest(r.agent_id, r.id, null);
		await recordCustodyEvent({ agentId: r.agent_id, userId: null, eventType: 'recovery_cancel', reason: 'expired', meta: { request_id: r.id } }).catch(() => {});
		await notifyParties(r.agent_id, 'recovery_expired', { request_id: r.id }).catch(() => {});
	}
	return stale.length;
}

/**
 * One full dead-man's-switch sweep, safe to run on a cron:
 *   1. expire stalled requests,
 *   2. arm inheritance for agents whose owner crossed the inactivity threshold,
 *   3. send an early "tap I'm here" reminder to owners approaching the threshold,
 *   4. complete inheritance requests whose grace window elapsed with confirmation.
 * Returns a summary of what it did. Each agent is isolated — one failure never
 * stops the sweep.
 */
export async function runDeadManSweep({ now = Date.now() } = {}) {
	const summary = { expired: 0, armed: 0, reminded: 0, completed: 0, errors: 0 };

	summary.expired = await expireStaleRequests().catch(() => 0);

	// Agents with the switch enabled.
	const agents = await sql`
		SELECT id, user_id, name, meta FROM agent_identities
		WHERE deleted_at IS NULL AND (meta->'recovery'->'dead_man'->>'enabled') = 'true'
	`;
	for (const agent of agents) {
		try {
			const cfg = getRecoveryConfig(agent.meta);
			if (!cfg.dead_man.enabled) continue;
			const active = await getActiveRequest(agent.id);
			const { lastActiveAt } = await getOwnerActivity(agent.id, agent.user_id, agent.meta);
			const dm = deadManStatus(cfg, lastActiveAt, now);

			if (dm.eligible_to_arm && !active) {
				const armed = await armInheritance({ agentId: agent.id, actorId: null });
				if (armed) summary.armed++;
			} else if (!active && dm.ms_until_arm > 0 && dm.ms_until_arm <= DEAD_MAN_REMINDER_WINDOW_MS) {
				// Approaching — remind the owner at most once per window.
				const lastReminder = agent.meta?.recovery?.dead_man?.last_reminder_at;
				const remindedRecently = lastReminder && now - new Date(lastReminder).getTime() < DEAD_MAN_REMINDER_WINDOW_MS;
				if (!remindedRecently) {
					insertNotification(agent.user_id, 'dead_man_reminder', { agent_id: agent.id, agent_name: agent.name, arm_at: dm.arm_at, days_left: Math.ceil(dm.ms_until_arm / DAY_MS) });
					const meta = { ...(agent.meta || {}) };
					const baseCfg = getRecoveryConfig(meta);
					meta.recovery = { ...baseCfg, dead_man: { ...baseCfg.dead_man, last_reminder_at: new Date(now).toISOString() } };
					await sql`UPDATE agent_identities SET meta = ${JSON.stringify(meta)}::jsonb WHERE id = ${agent.id}`.catch(() => {});
					summary.reminded++;
				}
			}
		} catch (e) {
			summary.errors++;
			console.error('[dead-man] sweep failed for agent', agent.id, e?.message);
		}
	}

	// Complete inheritance requests whose grace elapsed with confirmation.
	const ready = await sql`
		SELECT id, agent_id FROM agent_recovery_requests
		WHERE kind = 'inheritance' AND status IN ('time_locked', 'ready')
	`;
	for (const r of ready) {
		try {
			const out = await completeIfReady({ agentId: r.agent_id, requestId: r.id, actorId: null });
			if (out?.transferred) summary.completed++;
		} catch {
			// not_ready / awaiting_beneficiary — expected for requests still in grace.
		}
	}

	return summary;
}
