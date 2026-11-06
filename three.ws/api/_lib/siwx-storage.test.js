// Integration tests for the Postgres-backed SIWxStorage adapter.
//
// These run against the REAL Neon database pointed at by $DATABASE_URL (the
// same one prompt 01's migration provisioned). When DATABASE_URL is unset —
// CI without secrets, a fresh clone — every case is skipped via it.skipIf so
// the suite never silently passes on a mock. There is no in-memory fallback.
//
// This file lives next to the source rather than under /tests/* (the SIWX
// adapter is api/_lib-local). Vitest's include glob does not pick it up
// automatically; run it explicitly:
//   DATABASE_URL=$DATABASE_URL npx vitest run api/_lib/siwx-storage.test.js

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import { sql } from './db.js';
import {
	siwxStorage,
	normalizeAddress,
	pruneOldNonces,
} from './siwx-storage.js';

const HAS_DB = Boolean(process.env.DATABASE_URL);

// Every row this suite writes is keyed on a 'test-resource-…' resource so the
// final teardown can scope its DELETEs and concurrent runs never collide.
const resource = () => `test-resource-${randomUUID()}`;

describe('siwx-storage', () => {
	afterAll(async () => {
		if (!HAS_DB) return;
		await sql`DELETE FROM siwx_payments WHERE resource LIKE 'test-resource-%'`;
		await sql`DELETE FROM siwx_nonces WHERE resource LIKE 'test-resource-%'`;
	});

	it('normalizes addresses per CAIP-2 namespace', () => {
		expect(normalizeAddress('eip155:8453', '0xAbCdEf')).toBe('0xabcdef');
		expect(normalizeAddress('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'MiXeDcAsE'))
			.toBe('MiXeDcAsE');
		expect(() => normalizeAddress('', '0x1')).toThrow();
		expect(() => normalizeAddress('cosmos:1', 'addr')).toThrow();
	});

	it.skipIf(!HAS_DB)('hasPaid returns false for an unknown wallet', async () => {
		const res = resource();
		await expect(siwxStorage.hasPaid(res, '0x000000000000000000000000000000000000dead'))
			.resolves.toBe(false);
	});

	it.skipIf(!HAS_DB)('round-trips an EVM payment, matching case-insensitively', async () => {
		const res = resource();
		const checksummed = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa';
		await siwxStorage.recordPayment(res, checksummed, { network: 'eip155:8453' });

		// The contract passes the checksummed (recovered) address to hasPaid;
		// the lowercased row must still match.
		await expect(siwxStorage.hasPaid(res, checksummed)).resolves.toBe(true);
		await expect(siwxStorage.hasPaid(res, checksummed.toLowerCase())).resolves.toBe(true);

		// It was stored lowercased.
		const [row] = await sql`SELECT address FROM siwx_payments WHERE resource = ${res}`;
		expect(row.address).toBe(checksummed.toLowerCase());
	});

	it.skipIf(!HAS_DB)('round-trips a Solana payment, matching case-sensitively', async () => {
		const res = resource();
		const addr = 'So1anaTestKey11111111111111111111111111111';
		await siwxStorage.recordPayment(res, addr, {
			network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
		});

		await expect(siwxStorage.hasPaid(res, addr)).resolves.toBe(true);
		// A different-case spelling is a different Base58 key — no grant.
		await expect(siwxStorage.hasPaid(res, addr.toLowerCase())).resolves.toBe(false);
	});

	it.skipIf(!HAS_DB)('honours a ttlSeconds expiry window', async () => {
		const res = resource();
		const addr = '0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb';
		await siwxStorage.recordPayment(res, addr, { network: 'eip155:8453', ttlSeconds: 1 });

		await expect(siwxStorage.hasPaid(res, addr)).resolves.toBe(true);
		await new Promise((r) => setTimeout(r, 1500));
		await expect(siwxStorage.hasPaid(res, addr)).resolves.toBe(false);
	});

	it.skipIf(!HAS_DB)('round-trips a nonce idempotently', async () => {
		const res = resource();
		const nonce = `nonce-${randomUUID()}`;

		await expect(siwxStorage.hasUsedNonce(nonce)).resolves.toBe(false);

		// First claim wins; second is a no-op against the same nonce.
		await expect(siwxStorage.recordNonce(nonce, { resource: res, address: '0x1' }))
			.resolves.toBe(true);
		await expect(siwxStorage.recordNonce(nonce, { resource: res, address: '0x1' }))
			.resolves.toBe(false);

		await expect(siwxStorage.hasUsedNonce(nonce)).resolves.toBe(true);
	});

	it.skipIf(!HAS_DB)('pruneOldNonces(0) clears nonces past the replay window', async () => {
		const res = resource();
		const nonce = `nonce-${randomUUID()}`;
		await siwxStorage.recordNonce(nonce, { resource: res, address: '0x1' });

		const deleted = await pruneOldNonces(0);
		expect(deleted).toBeGreaterThanOrEqual(1);
		await expect(siwxStorage.hasUsedNonce(nonce)).resolves.toBe(false);
	});
});
