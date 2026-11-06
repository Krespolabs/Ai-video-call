// Pump Launcher (/api/x402/pump-launch) — listing quality + input validation.
//
// This endpoint deploys a real pump.fun token for real SOL, so these tests
// deliberately NEVER invoke the paid handler or broadcast anything. They lock
// down the things that make the listing sellable and safe to call blind:
//   1. the discovery listing sells the use-case and links the free funnel,
//   2. the advertised price matches the handler's default ($5.00),
//   3. input validation rejects the bad shapes (missing name/symbol, and a body
//      with neither metadataUri nor imageUrl) BEFORE any launch could happen,
//   4. the documented input example satisfies the published INPUT_SCHEMA — i.e.
//      the schema is complete enough for an agent to call blind.
//
// The bazaar.info ⇄ bazaar.schema self-validation (CDP-acceptance) is covered
// end-to-end by `npm run verify:x402` against the discovery doc, so it is not
// re-checked here.
//
// The handler transitively imports the Neon client, the Solana launcher, and the
// CDP x402 SDK — none of which this test needs. We mock those heavy leaf modules
// so the test exercises only the pure listing metadata + the zod body schema.

import { describe, it, expect, vi } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

vi.mock('../api/_lib/db.js', () => ({
	sql: vi.fn(),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
	isStoragePressured: () => false,
}));
vi.mock('../api/_lib/http.js', () => ({ readJson: vi.fn() }));
vi.mock('../api/_lib/pump-launch.js', () => ({
	loadLauncherKeypair: vi.fn(),
	uploadPumpMetadata: vi.fn(),
	launchPumpToken: vi.fn(),
}));
vi.mock('../api/_lib/x402-paid-endpoint.js', () => ({ paidEndpoint: (cfg) => cfg }));
vi.mock('../api/_lib/x402-spec.js', () => ({ buildBazaarSchema: () => ({}) }));
vi.mock('../api/_lib/x402/access-control.js', () => ({ installAccessControl: () => ({}) }));
vi.mock('../api/_lib/x402/bazaar-helpers.js', () => ({ withService: (x) => x }));

const { DESCRIPTION, PRICE_ATOMICS, INPUT_SCHEMA, OUTPUT_SCHEMA, BAZAAR, bodySchema } = await import(
	'../api/x402/pump-launch.js'
);

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

describe('pump-launch listing — description sells the use-case + funnel', () => {
	it('leads with the no-SOL / no-account use-case', () => {
		expect(DESCRIPTION).toMatch(/pump\.fun/i);
		expect(DESCRIPTION).toMatch(/no SOL/i);
		expect(DESCRIPTION).toMatch(/no (wallet|account)/i);
		expect(DESCRIPTION).toMatch(/USDC/);
	});

	it('names every input and the output shape', () => {
		for (const field of ['name', 'symbol', 'metadataUri', 'imageUrl', 'creator', 'holderReward', 'vanity']) {
			expect(DESCRIPTION).toMatch(new RegExp(field, 'i'));
		}
		expect(DESCRIPTION).toMatch(/mint/i);
		expect(DESCRIPTION).toMatch(/signature/i);
	});

	it('wires the free → paid funnel to /api/crypto/symbol and /api/crypto/launches', () => {
		expect(DESCRIPTION).toContain('/api/crypto/symbol');
		expect(DESCRIPTION).toContain('/api/crypto/launches');
	});
});

describe('pump-launch listing — price parity', () => {
	it('advertises the $5.00 default (5000000 USDC atomics)', () => {
		// Matches the mirror in api/wk.js (acceptsForPrice('5000000', …)) so the
		// live 402 and the discovery doc never drift.
		expect(PRICE_ATOMICS).toBe('5000000');
	});
});

describe('pump-launch listing — schema completeness (call it blind)', () => {
	it('requires name + symbol and exactly one of metadataUri / imageUrl', () => {
		expect(INPUT_SCHEMA.required).toEqual(expect.arrayContaining(['name', 'symbol']));
		expect(INPUT_SCHEMA.oneOf).toEqual([
			{ required: ['metadataUri'] },
			{ required: ['imageUrl'] },
		]);
	});

	it('guarantees the load-bearing outputs', () => {
		expect(OUTPUT_SCHEMA.required).toEqual(
			expect.arrayContaining(['mint', 'signature', 'metadataUri', 'pumpfun_url']),
		);
	});

	it('the published input example satisfies INPUT_SCHEMA', () => {
		const validate = ajv.compile(INPUT_SCHEMA);
		const example = BAZAAR.info.input.body;
		const ok = validate(example);
		expect(validate.errors, JSON.stringify(validate.errors)).toBeNull();
		expect(ok).toBe(true);
	});
});

describe('pump-launch listing — input validation rejects bad shapes before launch', () => {
	const valid = {
		name: 'Helios',
		symbol: 'HELIO',
		imageUrl: 'https://example.com/helios.png',
	};

	it('accepts a minimal valid body (name + symbol + imageUrl)', () => {
		expect(bodySchema.safeParse(valid).success).toBe(true);
	});

	it('accepts a valid body with metadataUri instead of imageUrl', () => {
		const { imageUrl, ...rest } = valid;
		expect(
			bodySchema.safeParse({ ...rest, metadataUri: 'https://ipfs.io/ipfs/QmExample' }).success,
		).toBe(true);
	});

	it('accepts a holder-reward launch', () => {
		const parsed = bodySchema.safeParse({ ...valid, holderReward: true });
		expect(parsed.success).toBe(true);
		expect(parsed.data.holderReward).toBe(true);
		expect(INPUT_SCHEMA.properties.holderReward.type).toBe('boolean');
	});

	it('rejects a missing name', () => {
		const { name, ...rest } = valid;
		expect(bodySchema.safeParse(rest).success).toBe(false);
	});

	it('rejects a missing symbol', () => {
		const { symbol, ...rest } = valid;
		expect(bodySchema.safeParse(rest).success).toBe(false);
	});

	it('rejects a body with neither metadataUri nor imageUrl', () => {
		const r = bodySchema.safeParse({ name: 'Helios', symbol: 'HELIO' });
		expect(r.success).toBe(false);
		expect(JSON.stringify(r.error.issues)).toMatch(/metadataUri or imageUrl/);
	});

	it('rejects a non-base58 vanity prefix', () => {
		expect(bodySchema.safeParse({ ...valid, vanityPrefix: '0OIl' }).success).toBe(false);
	});
});
