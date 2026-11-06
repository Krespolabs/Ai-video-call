// Unit tests for api/_lib/agent-recovery.js — the pure decision logic behind
// social recovery & inheritance: config normalization, the approval/time-lock
// state machine, the effective threshold, and the dead-man inactivity math.
//
// The DB + audit + notify + custody deps are mocked so these stay deterministic
// and fast; we only exercise the pure exports here (the DB-touching flows are
// integration-tested against a live DB elsewhere).

import { describe, it, expect, vi } from 'vitest';

vi.mock('../api/_lib/db.js', () => ({ sql: vi.fn(async () => []), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../api/_lib/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../api/_lib/notify.js', () => ({ insertNotification: vi.fn() }));
vi.mock('../api/_lib/agent-trade-guards.js', () => ({ recordCustodyEvent: vi.fn(async () => 1) }));

const rec = await import('../api/_lib/agent-recovery.js');
const {
	getRecoveryConfig, effectiveThreshold, computeRequestPhase, deadManStatus,
	thresholdTimelockTransition, RECOVERY_TIMELOCK_MS, RECOVERY_REQUEST_TTL_MS, isUuid,
} = rec;

const DAY = 24 * 60 * 60 * 1000;

describe('getRecoveryConfig', () => {
	it('returns safe defaults for empty meta', () => {
		const c = getRecoveryConfig(null);
		expect(c.threshold).toBe(null);
		expect(c.dead_man.enabled).toBe(false);
		expect(c.dead_man.inactivity_days).toBe(90);
		expect(c.dead_man.grace_days).toBe(14);
	});

	it('clamps out-of-range inactivity/grace to bounds', () => {
		const c = getRecoveryConfig({ recovery: { dead_man: { enabled: true, inactivity_days: 9999, grace_days: 0 } } });
		expect(c.dead_man.inactivity_days).toBe(365); // max
		expect(c.dead_man.grace_days).toBe(1); // min
		expect(c.dead_man.enabled).toBe(true);
	});

	it('only treats enabled === true as on', () => {
		expect(getRecoveryConfig({ recovery: { dead_man: { enabled: 'yes' } } }).dead_man.enabled).toBe(false);
	});
});

describe('effectiveThreshold', () => {
	it('is 0 with no guardians', () => {
		expect(effectiveThreshold({ threshold: null }, 0)).toBe(0);
	});
	it('defaults to 2-of-N once 2+ guardians exist', () => {
		expect(effectiveThreshold({ threshold: null }, 3)).toBe(2);
		expect(effectiveThreshold({ threshold: null }, 1)).toBe(1);
	});
	it('honors an explicit threshold but clamps to guardian count', () => {
		expect(effectiveThreshold({ threshold: 3 }, 5)).toBe(3);
		expect(effectiveThreshold({ threshold: 9 }, 4)).toBe(4);
		expect(effectiveThreshold({ threshold: 0 }, 4)).toBe(1);
	});
});

describe('computeRequestPhase', () => {
	const now = 1_700_000_000_000;
	const createdAt = new Date(now - DAY).toISOString();

	it('stays pending while approvals are below threshold', () => {
		const p = computeRequestPhase({ status: 'pending_approvals', approvalsRequired: 2, approvalsCount: 1, timelockUntil: null, createdAt, now });
		expect(p.phase).toBe('pending_approvals');
		expect(p.approved).toBe(false);
	});

	it('expires a never-approved request past its TTL', () => {
		const oldCreated = new Date(now - RECOVERY_REQUEST_TTL_MS - DAY).toISOString();
		const p = computeRequestPhase({ status: 'pending_approvals', approvalsRequired: 2, approvalsCount: 0, timelockUntil: null, createdAt: oldCreated, now });
		expect(p.phase).toBe('expired');
	});

	it('is time_locked once approved but the window has not elapsed', () => {
		const until = new Date(now + RECOVERY_TIMELOCK_MS / 2).toISOString();
		const p = computeRequestPhase({ status: 'time_locked', approvalsRequired: 2, approvalsCount: 2, timelockUntil: until, createdAt, now });
		expect(p.phase).toBe('time_locked');
		expect(p.msUntilUnlock).toBeGreaterThan(0);
	});

	it('becomes ready once approved and the time-lock has elapsed', () => {
		const until = new Date(now - 1000).toISOString();
		const p = computeRequestPhase({ status: 'time_locked', approvalsRequired: 2, approvalsCount: 2, timelockUntil: until, createdAt, now });
		expect(p.phase).toBe('ready');
		expect(p.msUntilUnlock).toBe(0);
	});

	it('drops back below readiness if approvals fall under threshold (guardian removed)', () => {
		const until = new Date(now - 1000).toISOString();
		const p = computeRequestPhase({ status: 'time_locked', approvalsRequired: 2, approvalsCount: 1, timelockUntil: until, createdAt, now });
		expect(p.phase).toBe('pending_approvals');
		expect(p.approved).toBe(false);
	});

	it('keeps terminal states terminal', () => {
		for (const s of ['completed', 'cancelled', 'rejected', 'expired']) {
			expect(computeRequestPhase({ status: s, approvalsRequired: 2, approvalsCount: 2, timelockUntil: null, createdAt, now }).phase).toBe(s);
		}
	});
});

describe('deadManStatus', () => {
	const now = 1_700_000_000_000;
	const cfg = { dead_man: { enabled: true, inactivity_days: 90, grace_days: 14 } };

	it('is not eligible while the owner is recently active', () => {
		const lastActive = new Date(now - 10 * DAY);
		const dm = deadManStatus(cfg, lastActive, now);
		expect(dm.eligible_to_arm).toBe(false);
		expect(dm.inactive_days).toBe(10);
		expect(dm.ms_until_arm).toBeGreaterThan(0);
	});

	it('becomes eligible once inactivity crosses the threshold', () => {
		const lastActive = new Date(now - 100 * DAY);
		const dm = deadManStatus(cfg, lastActive, now);
		expect(dm.eligible_to_arm).toBe(true);
		expect(dm.ms_until_arm).toBeLessThanOrEqual(0);
	});

	it('never eligible when disabled', () => {
		const dm = deadManStatus({ dead_man: { enabled: false, inactivity_days: 90, grace_days: 14 } }, new Date(now - 200 * DAY), now);
		expect(dm.eligible_to_arm).toBe(false);
	});
});

describe('thresholdTimelockTransition', () => {
	const now = 1_700_000_000_000;

	it('does nothing while approvals are below threshold', () => {
		const row = { status: 'pending_approvals', approvals_required: 2, timelock_until: null };
		expect(thresholdTimelockTransition(row, 1, now)).toBe(null);
	});

	it('opens a fresh 48h window for a recovery (no prior time-lock) and announces it', () => {
		const row = { status: 'pending_approvals', approvals_required: 2, timelock_until: null };
		const t = thresholdTimelockTransition(row, 2, now);
		expect(t).not.toBe(null);
		expect(t.announce).toBe(true);
		expect(new Date(t.until).getTime()).toBe(now + RECOVERY_TIMELOCK_MS);
	});

	it('preserves a guardian-gated inheritance grace deadline and does not re-announce', () => {
		// The dead-man's switch sets timelock_until (the grace deadline) at arm time.
		// Reaching the guardian threshold must still leave pending_approvals (so the
		// cron can complete it) WITHOUT extending or re-announcing the window.
		const graceUntil = new Date(now + 14 * DAY).toISOString();
		const row = { status: 'pending_approvals', approvals_required: 2, timelock_until: graceUntil };
		const t = thresholdTimelockTransition(row, 2, now);
		expect(t).not.toBe(null);
		expect(t.announce).toBe(false);
		expect(new Date(t.until).getTime()).toBe(new Date(graceUntil).getTime());
	});

	it('does nothing for a request no longer collecting approvals', () => {
		for (const status of ['time_locked', 'ready', 'completed', 'cancelled']) {
			expect(thresholdTimelockTransition({ status, approvals_required: 1, timelock_until: null }, 5, now)).toBe(null);
		}
	});
});

describe('isUuid', () => {
	it('accepts a v4 uuid and rejects junk', () => {
		expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
		expect(isUuid('not-a-uuid')).toBe(false);
		expect(isUuid(null)).toBe(false);
	});
});

describe('time-lock constant', () => {
	it('is 48h', () => {
		expect(RECOVERY_TIMELOCK_MS).toBe(48 * 60 * 60 * 1000);
	});
});
