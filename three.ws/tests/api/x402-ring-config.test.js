// Unit tests for the ring routing + config-truth helpers in
// api/_lib/x402/ring-config.js (task 02). Pure logic — no network, no DB, no
// @solana/web3.js. Covers:
//
//   - resolveSolanaFacilitator: explicit-URL-wins > flag-on-self > external default.
//   - validateRingConfig: the six-finding matrix (facilitator off, URL external,
//     missing treasury secret, missing fee-payer pubkey, price>cap, self-pay off).
//   - warnIfRingRoutesExternal: one warning per boot; null when routing is self.
//
// ring-config.js imports only env.js + x402-prices.js, both of which read
// process.env through getters, so env mutations here take effect immediately
// without a module reset.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
	resolveSolanaFacilitator,
	validateRingConfig,
	warnIfRingRoutesExternal,
	isSelfFacilitatorUrl,
	selfFacilitatorUrl,
	_resetRingConfigWarningsForTest,
} from '../../api/_lib/x402/ring-config.js';

const SELF_URL = 'https://three.ws/api/x402-facilitator';
const PAYAI = 'https://facilitator.payai.network';

// The full env envelope of a correctly-configured ring — start from this and
// remove/override a single var per test to isolate each finding.
function healthyRingEnv() {
	process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
	delete process.env.X402_FACILITATOR_URL_SOLANA;
	delete process.env.X402_FACILITATOR_URL;
	process.env.X402_FEE_PAYER_SOLANA = 'PayeRNCipcerPHCsYMTrX9pAYDm1LnPGzgb66NUDG5a';
	process.env.X402_FEE_PAYER_SECRET_BASE58 = 'z'.repeat(88);
	process.env.X402_TREASURY_SECRET_BASE58 = 'z'.repeat(64);
	process.env.X402_RING_SELF_PAY = 'true';
	process.env.X402_PRICE_RING_SETTLE = '1000000';
	process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC = '2000000';
	delete process.env.PUBLIC_APP_ORIGIN;
}

const RING_VARS = [
	'X402_SELF_FACILITATOR_ENABLED',
	'X402_FACILITATOR_URL_SOLANA',
	'X402_FACILITATOR_URL',
	'X402_FEE_PAYER_SOLANA',
	'X402_FEE_PAYER_SECRET_BASE58',
	'X402_TREASURY_SECRET_BASE58',
	'X402_RING_SELF_PAY',
	'X402_PRICE_RING_SETTLE',
	'X402_VOLUME_PER_RUN_CAP_ATOMIC',
	'PUBLIC_APP_ORIGIN',
];

const ORIG = {};

beforeEach(() => {
	for (const k of RING_VARS) ORIG[k] = process.env[k];
	_resetRingConfigWarningsForTest();
});

afterEach(() => {
	for (const k of RING_VARS) {
		if (ORIG[k] === undefined) delete process.env[k];
		else process.env[k] = ORIG[k];
	}
	vi.restoreAllMocks();
});

const codes = (findings) => findings.map((f) => f.code);

describe('resolveSolanaFacilitator', () => {
	it('flag off, no URL → external default, self:false', () => {
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		delete process.env.X402_FACILITATOR_URL;
		const r = resolveSolanaFacilitator();
		expect(r).toEqual({ url: PAYAI, self: false });
	});

	it('flag on, no URL → self facilitator, self:true', () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		delete process.env.X402_FACILITATOR_URL;
		const r = resolveSolanaFacilitator();
		expect(r).toEqual({ url: SELF_URL, self: true });
	});

	it('explicit external URL always wins over the flag', () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://ext.example.test';
		const r = resolveSolanaFacilitator();
		expect(r).toEqual({ url: 'https://ext.example.test', self: false });
	});

	it('a blank explicit URL is treated as unset', () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		process.env.X402_FACILITATOR_URL_SOLANA = '   ';
		const r = resolveSolanaFacilitator();
		expect(r).toEqual({ url: SELF_URL, self: true });
	});

	it('a trailing slash is trimmed', () => {
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://ext.example.test/';
		expect(resolveSolanaFacilitator().url).toBe('https://ext.example.test');
	});
});

describe('isSelfFacilitatorUrl', () => {
	it('matches the facilitator route on any host', () => {
		expect(isSelfFacilitatorUrl(SELF_URL)).toBe(true);
		expect(isSelfFacilitatorUrl('https://preview.three.ws/api/x402-facilitator/')).toBe(true);
	});
	it('rejects external and malformed URLs', () => {
		expect(isSelfFacilitatorUrl(PAYAI)).toBe(false);
		expect(isSelfFacilitatorUrl('not a url')).toBe(false);
		expect(isSelfFacilitatorUrl('')).toBe(false);
	});
});

describe('validateRingConfig finding matrix', () => {
	it('a fully-healthy ring produces no findings', () => {
		healthyRingEnv();
		expect(validateRingConfig()).toEqual([]);
	});

	it('flags self_facilitator_disabled AND facilitator_url_external when the flag is off', () => {
		healthyRingEnv();
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		const c = codes(validateRingConfig());
		expect(c).toContain('self_facilitator_disabled');
		expect(c).toContain('facilitator_url_external');
	});

	it('flags facilitator_url_external when the flag is on but an external URL wins', () => {
		healthyRingEnv();
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://ext.example.test';
		const c = codes(validateRingConfig());
		expect(c).toContain('facilitator_url_external');
		expect(c).not.toContain('self_facilitator_disabled');
	});

	it('flags treasury_secret_missing (warn severity)', () => {
		healthyRingEnv();
		delete process.env.X402_TREASURY_SECRET_BASE58;
		const f = validateRingConfig().find((x) => x.code === 'treasury_secret_missing');
		expect(f).toBeTruthy();
		expect(f.severity).toBe('warn');
	});

	it('flags fee_payer_pubkey_missing (error severity)', () => {
		healthyRingEnv();
		delete process.env.X402_FEE_PAYER_SOLANA;
		const f = validateRingConfig().find((x) => x.code === 'fee_payer_pubkey_missing');
		expect(f).toBeTruthy();
		expect(f.severity).toBe('error');
	});

	it('flags fee_payer_secret_missing (error) when self-routing in SPONSOR mode without the co-signing secret', () => {
		healthyRingEnv();
		process.env.X402_RING_SELF_PAY = 'false'; // sponsor mode co-signs → needs the secret
		delete process.env.X402_FEE_PAYER_SECRET_BASE58;
		const f = validateRingConfig().find((x) => x.code === 'fee_payer_secret_missing');
		expect(f).toBeTruthy();
		expect(f.severity).toBe('error');
	});

	it('does NOT flag fee_payer_secret_missing in SELF-PAY mode (buyer pays its own 1-sig fee)', () => {
		healthyRingEnv(); // self-pay is on
		delete process.env.X402_FEE_PAYER_SECRET_BASE58;
		expect(codes(validateRingConfig())).not.toContain('fee_payer_secret_missing');
	});

	it('does NOT flag fee_payer_secret_missing when settlement routes externally', () => {
		healthyRingEnv();
		delete process.env.X402_FEE_PAYER_SECRET_BASE58;
		// An explicit external facilitator wins → route.self is false → the external
		// facilitator co-signs with its own key, so our secret is irrelevant.
		process.env.X402_FACILITATOR_URL_SOLANA = 'https://ext.example.test';
		expect(codes(validateRingConfig())).not.toContain('fee_payer_secret_missing');
	});

	it('flags ring_price_exceeds_run_cap when the per-call price exceeds the per-run cap', () => {
		healthyRingEnv();
		process.env.X402_PRICE_RING_SETTLE = '5000000'; // $5.00
		process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC = '1000000'; // $1.00 cap
		expect(codes(validateRingConfig())).toContain('ring_price_exceeds_run_cap');
	});

	it('does NOT flag price>cap when the cap is 0 (uncapped)', () => {
		healthyRingEnv();
		process.env.X402_PRICE_RING_SETTLE = '5000000';
		process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC = '0';
		expect(codes(validateRingConfig())).not.toContain('ring_price_exceeds_run_cap');
	});

	it('flags ring_self_pay_off (warn) when self-pay is not enabled', () => {
		healthyRingEnv();
		delete process.env.X402_RING_SELF_PAY;
		const f = validateRingConfig().find((x) => x.code === 'ring_self_pay_off');
		expect(f).toBeTruthy();
		expect(f.severity).toBe('warn');
	});

	it('catches all six misconfigurations at once', () => {
		// Bare env: flag off, no URL (external), no treasury secret, no fee payer,
		// price above cap, self-pay off.
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		delete process.env.X402_FACILITATOR_URL;
		delete process.env.X402_FEE_PAYER_SOLANA;
		delete process.env.X402_TREASURY_SECRET_BASE58;
		delete process.env.X402_RING_SELF_PAY;
		process.env.X402_PRICE_RING_SETTLE = '5000000';
		process.env.X402_VOLUME_PER_RUN_CAP_ATOMIC = '1000000';
		const c = codes(validateRingConfig());
		expect(c).toEqual(
			expect.arrayContaining([
				'self_facilitator_disabled',
				'facilitator_url_external',
				'treasury_secret_missing',
				'fee_payer_pubkey_missing',
				'ring_price_exceeds_run_cap',
				'ring_self_pay_off',
			]),
		);
	});

	it('every finding carries code, severity, message, and fix', () => {
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		for (const f of validateRingConfig()) {
			expect(typeof f.code).toBe('string');
			expect(['error', 'warn']).toContain(f.severity);
			expect(f.message.length).toBeGreaterThan(0);
			expect(f.fix.length).toBeGreaterThan(0);
		}
	});
});

describe('warnIfRingRoutesExternal', () => {
	it('returns a structured warning and logs once when routing is external', () => {
		delete process.env.X402_SELF_FACILITATOR_ENABLED;
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const w1 = warnIfRingRoutesExternal('test');
		const w2 = warnIfRingRoutesExternal('test');
		expect(w1).toBeTruthy();
		expect(w1.code).toBe('ring_external_facilitator');
		expect(w1.facilitator_url).toBe(PAYAI);
		// Both calls return the warning, but it is logged only once per boot.
		expect(w2).toBeTruthy();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it('returns null (no warning) when routing is self-hosted', () => {
		process.env.X402_SELF_FACILITATOR_ENABLED = 'true';
		delete process.env.X402_FACILITATOR_URL_SOLANA;
		const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(warnIfRingRoutesExternal('test')).toBeNull();
		expect(spy).not.toHaveBeenCalled();
	});
});

describe('selfFacilitatorUrl', () => {
	it('anchors on APP_ORIGIN', () => {
		process.env.PUBLIC_APP_ORIGIN = 'https://preview.three.ws';
		expect(selfFacilitatorUrl()).toBe('https://preview.three.ws/api/x402-facilitator');
	});
});
