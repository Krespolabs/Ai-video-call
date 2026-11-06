// Tests for the ring spend invariants + controlled-wallet allowlist
// (api/_lib/x402/ring-allowlist.js).
//
// The invariants keep the loop CLOSED: a spend path only runs when external
// spending is off, the charity split is zero, and settlement routes to our own
// facilitator. checkRingInvariants() is pure; assertRingSpendInvariants() adds
// the throttled CRITICAL alert + fail-closed return. ringAllowedAddresses()
// builds the controlled-wallet set the leak scanner classifies against.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../api/_lib/alerts.js', () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const {
	checkRingInvariants,
	assertRingSpendInvariants,
	facilitatorResolvesToSelf,
	ringAllowedAddresses,
} = await import('../api/_lib/x402/ring-allowlist.js');
const { sendOpsAlert } = await import('../api/_lib/alerts.js');

const RING_VARS = [
	'X402_EXTERNAL_ENABLED', 'X402_CHARITY_AUDIT_BPS', 'X402_SELF_FACILITATOR_ENABLED',
	'X402_FACILITATOR_URL_SOLANA', 'X402_FACILITATOR_URL', 'PUBLIC_APP_ORIGIN',
	'X402_SEED_SOLANA_SECRET_BASE58', 'X402_AGENT_SOLANA_SECRET_BASE58',
	'X402_PAY_TO_SOLANA', 'X402_FEE_PAYER_SOLANA', 'X402_SELF_FACILITATOR_PAYTO_ALLOWLIST',
];

function healthyEnv() {
	process.env.X402_EXTERNAL_ENABLED = 'false';
	process.env.X402_CHARITY_AUDIT_BPS = '0';
	process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
	delete process.env.X402_FACILITATOR_URL_SOLANA;
	delete process.env.X402_FACILITATOR_URL;
	delete process.env.PUBLIC_APP_ORIGIN;
}

beforeEach(() => {
	for (const v of RING_VARS) delete process.env[v];
	sendOpsAlert.mockClear();
});
afterEach(() => { for (const v of RING_VARS) delete process.env[v]; });

describe('checkRingInvariants', () => {
	it('passes when all three guards hold', () => {
		healthyEnv();
		const r = checkRingInvariants();
		expect(r.ok).toBe(true);
		expect(r.violations).toHaveLength(0);
	});

	it('flags X402_EXTERNAL_ENABLED when it is not exactly "false"', () => {
		healthyEnv();
		process.env.X402_EXTERNAL_ENABLED = 'true';
		const r = checkRingInvariants();
		expect(r.ok).toBe(false);
		expect(r.violations.map((v) => v.flag)).toContain('X402_EXTERNAL_ENABLED');
	});

	it('flags an unset X402_EXTERNAL_ENABLED (fails CLOSED, not open)', () => {
		healthyEnv();
		delete process.env.X402_EXTERNAL_ENABLED;
		const r = checkRingInvariants();
		expect(r.ok).toBe(false);
		expect(r.violations.map((v) => v.flag)).toContain('X402_EXTERNAL_ENABLED');
	});

	it('flags a non-zero or unset X402_CHARITY_AUDIT_BPS', () => {
		healthyEnv();
		process.env.X402_CHARITY_AUDIT_BPS = '500';
		expect(checkRingInvariants().violations.map((v) => v.flag)).toContain('X402_CHARITY_AUDIT_BPS');
		delete process.env.X402_CHARITY_AUDIT_BPS;
		expect(checkRingInvariants().violations.map((v) => v.flag)).toContain('X402_CHARITY_AUDIT_BPS');
	});

	it('flags settlement routing to an external facilitator', () => {
		healthyEnv();
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://facilitator.payai.network';
		const r = checkRingInvariants();
		expect(r.ok).toBe(false);
		expect(r.violations.some((v) => v.flag.includes('FACILITATOR'))).toBe(true);
	});

	it('flags a disabled self-facilitator', () => {
		healthyEnv();
		process.env.X402_SELF_FACILITATOR_ENABLED = 'false';
		expect(checkRingInvariants().ok).toBe(false);
	});
});

describe('facilitatorResolvesToSelf', () => {
	it('is true for the self-hosted facilitator, false for external', () => {
		healthyEnv();
		expect(facilitatorResolvesToSelf()).toBe(true);
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://facilitator.payai.network';
		expect(facilitatorResolvesToSelf()).toBe(false);
	});
});

describe('assertRingSpendInvariants — fail closed + one throttled alert', () => {
	it('returns ok and fires no alert when guards hold', async () => {
		healthyEnv();
		const r = await assertRingSpendInvariants({ context: 'test' });
		expect(r.ok).toBe(true);
		expect(sendOpsAlert).not.toHaveBeenCalled();
	});

	it('returns ok:false and fires ONE CRITICAL alert naming the flipped flag', async () => {
		healthyEnv();
		process.env.X402_EXTERNAL_ENABLED = 'true';
		const r = await assertRingSpendInvariants({ context: 'x402-ring-tick' });
		expect(r.ok).toBe(false);
		expect(sendOpsAlert).toHaveBeenCalledTimes(1);
		const [title, body, opts] = sendOpsAlert.mock.calls[0];
		expect(title).toMatch(/invariant/i);
		expect(body).toMatch(/X402_EXTERNAL_ENABLED/);
		// dedup signature keys on the sorted flag set so repeated ticks don't flood.
		expect(opts.signature).toContain('ring-invariant:');
	});
});

describe('ringAllowedAddresses', () => {
	it('includes the ring role wallets + explicit extras, degrading without a DB', async () => {
		healthyEnv();
		process.env.X402_PAY_TO_SOLANA = 'RingTreasury11111111111111111111111111111111';
		process.env.X402_FEE_PAYER_SOLANA = 'RingSponsor11111111111111111111111111111111';
		process.env.X402_SELF_FACILITATOR_PAYTO_ALLOWLIST = 'ExtraControlled1111111111111111111111111111';
		// Inject a throwing sql so the DB branch degrades (shrinks, never widens).
		const sql = async () => { throw new Error('no db'); };
		const set = await ringAllowedAddresses({ sql });
		expect(set.has('RingTreasury11111111111111111111111111111111')).toBe(true);
		expect(set.has('RingSponsor11111111111111111111111111111111')).toBe(true);
		expect(set.has('ExtraControlled1111111111111111111111111111')).toBe(true);
	});
});
