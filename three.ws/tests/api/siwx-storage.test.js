// Round-trips siwx-storage.js against the real Neon database pointed at by
// $DATABASE_URL. With no DATABASE_URL the suite skips cleanly so CI can run
// without leaking secrets; locally, run after applying
// api/_lib/migrations/2026-05-21-siwx.sql.
//
// Every test scopes its rows to a per-run resource string and tears down at
// the end so concurrent runs (and prior crashes) don't poison each other.

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import crypto from 'node:crypto';

import { sql } from '../../api/_lib/db.js';
import {
	siwxStorage,
	normalizeAddress,
	pruneExpiredPayments,
	pruneOldNonces,
} from '../../api/_lib/siwx-storage.js';

const HAS_DB = !!process.env.DATABASE_URL;
const itDb = HAS_DB ? it : it.skip;

const RUN_TAG = `test-${crypto.randomUUID()}`;
const resourceFor = (suffix) => `test-resource-${RUN_TAG}-${suffix}`;

const EVM_NETWORK = 'eip155:8453';
const EVM_ADDR_CHECKSUM = '0xAbC0000000000000000000000000000000000001';
const EVM_ADDR_LOWER = EVM_ADDR_CHECKSUM.toLowerCase();

// A 44-char Base58 string — same length as a real Solana pubkey, but our
// adapter only stores/normalizes the string, it doesn't decode it.
const SOL_NETWORK = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const SOL_ADDR = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpLHpzMhsbAVQ2';

describe('normalizeAddress', () => {
	it('lowercases EVM addresses', () => {
		expect(normalizeAddress(EVM_NETWORK, EVM_ADDR_CHECKSUM)).toBe(EVM_ADDR_LOWER);
	});

	it('leaves Solana addresses untouched', () => {
		expect(normalizeAddress(SOL_NETWORK, SOL_ADDR)).toBe(SOL_ADDR);
	});

	it('rejects unsupported namespaces', () => {
		expect(() => normalizeAddress('cosmos:cosmoshub-4', 'cosmos1abc')).toThrow(/unsupported/);
	});

	it('rejects missing args', () => {
		expect(() => normalizeAddress('', '0xabc')).toThrow();
		expect(() => normalizeAddress(EVM_NETWORK, '')).toThrow();
	});
});

describe('siwxStorage against real Postgres', () => {
	beforeAll(() => {
		if (!HAS_DB) {
			console.log('[siwx-storage.test] DATABASE_URL unset — skipping DB-backed cases');
		}
	});

	afterAll(async () => {
		if (!HAS_DB) return;
		// Belt-and-suspenders cleanup keyed by RUN_TAG so a partial-failure run
		// can't leak rows into the dev DB.
		await sql`delete from siwx_payments where resource like ${'test-resource-' + RUN_TAG + '-%'}`;
		await sql`delete from siwx_nonces   where resource like ${'test-resource-' + RUN_TAG + '-%'}`;
	});

	itDb('hasPaid returns false for an unknown wallet', async () => {
		const r = resourceFor('unknown');
		expect(await siwxStorage.hasPaid(r, EVM_ADDR_CHECKSUM)).toBe(false);
	});

	itDb('EVM round-trip: checksum input → lowercase stored, hasPaid hits', async () => {
		const r = resourceFor('evm-roundtrip');
		await siwxStorage.recordPayment(r, EVM_ADDR_CHECKSUM, { network: EVM_NETWORK });

		expect(await siwxStorage.hasPaid(r, EVM_ADDR_CHECKSUM)).toBe(true);
		expect(await siwxStorage.hasPaid(r, EVM_ADDR_LOWER)).toBe(true);

		const [row] = await sql`
			select address, network, use_count, last_used_at
			  from siwx_payments
			 where resource = ${r}
		`;
		expect(row.address).toBe(EVM_ADDR_LOWER);
		expect(row.network).toBe(EVM_NETWORK);
		expect(row.use_count).toBeGreaterThanOrEqual(2);
		expect(row.last_used_at).toBeTruthy();
	});

	itDb('Solana round-trip: Base58 stored case-sensitive, hasPaid hits', async () => {
		const r = resourceFor('sol-roundtrip');
		await siwxStorage.recordPayment(r, SOL_ADDR, { network: SOL_NETWORK });

		expect(await siwxStorage.hasPaid(r, SOL_ADDR)).toBe(true);
		expect(await siwxStorage.hasPaid(r, SOL_ADDR.toLowerCase())).toBe(false);

		const [row] = await sql`select address from siwx_payments where resource = ${r}`;
		expect(row.address).toBe(SOL_ADDR);
	});

	itDb('ttlSeconds expires the grant', async () => {
		const r = resourceFor('ttl');
		await siwxStorage.recordPayment(r, EVM_ADDR_CHECKSUM, {
			network: EVM_NETWORK,
			ttlSeconds: 1,
		});
		expect(await siwxStorage.hasPaid(r, EVM_ADDR_CHECKSUM)).toBe(true);

		await new Promise((resolve) => setTimeout(resolve, 1500));
		expect(await siwxStorage.hasPaid(r, EVM_ADDR_CHECKSUM)).toBe(false);
	});

	itDb('recordNonce + hasUsedNonce round-trip and is idempotent', async () => {
		const r = resourceFor('nonce');
		const nonce = `nonce-${RUN_TAG}-${crypto.randomBytes(8).toString('hex')}`;

		expect(await siwxStorage.hasUsedNonce(nonce)).toBe(false);

		await siwxStorage.recordNonce(nonce, { resource: r, address: EVM_ADDR_LOWER });
		expect(await siwxStorage.hasUsedNonce(nonce)).toBe(true);

		// Second insert must not throw (ON CONFLICT DO NOTHING).
		await siwxStorage.recordNonce(nonce, { resource: r, address: EVM_ADDR_LOWER });
		expect(await siwxStorage.hasUsedNonce(nonce)).toBe(true);
	});

	itDb('pruneOldNonces(0) clears nonces inserted by this run', async () => {
		const r = resourceFor('gc');
		const nonce = `nonce-${RUN_TAG}-prune-${crypto.randomBytes(6).toString('hex')}`;
		await siwxStorage.recordNonce(nonce, { resource: r, address: EVM_ADDR_LOWER });
		expect(await siwxStorage.hasUsedNonce(nonce)).toBe(true);

		// Force the row to look old by backdating used_at.
		await sql`update siwx_nonces set used_at = now() - interval '1 hour' where nonce = ${nonce}`;

		const deleted = await pruneOldNonces(0);
		expect(deleted).toBeGreaterThanOrEqual(1);
		expect(await siwxStorage.hasUsedNonce(nonce)).toBe(false);
	});

	itDb('pruneExpiredPayments respects the grace window', async () => {
		const r = resourceFor('payment-prune');
		await siwxStorage.recordPayment(r, EVM_ADDR_CHECKSUM, {
			network: EVM_NETWORK,
			ttlSeconds: 1,
		});

		// Just-expired: still inside the default 7-day grace, so the default call
		// must NOT delete it. Backdate expires_at to confirm a 0-grace call does.
		await new Promise((resolve) => setTimeout(resolve, 1500));
		const deletedWithGrace = await pruneExpiredPayments();
		expect(deletedWithGrace).toBe(0);

		await sql`update siwx_payments set expires_at = now() - interval '8 days' where resource = ${r}`;
		const deletedNoGrace = await pruneExpiredPayments(0);
		expect(deletedNoGrace).toBeGreaterThanOrEqual(1);
	});
});
