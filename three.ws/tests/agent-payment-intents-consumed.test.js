// consumeIntent() against the REAL agent_payment_intents check constraint.
//
// The legacy per-skill x402 invoke consumes a paid intent (paid -> consumed)
// as its single-use lock. The table's original check constraint only allowed
// pending / paid / expired / failed, so that UPDATE raised a check violation
// after the buyer had already paid on chain. Mocked-SQL tests could never see
// it, so this suite runs the helper against an in-process Postgres (PGlite)
// built from the actual migration files: the original CREATE TABLE, then the
// widening migration.

import { readFileSync } from 'node:fs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

const dbState = { pg: null };

vi.mock('../api/_lib/db.js', () => {
	const sql = async (strings, ...values) => {
		const text = strings.reduce((acc, part, i) => acc + part + (i < values.length ? `$${i + 1}` : ''), '');
		const out = await dbState.pg.query(text, values);
		return out.rows;
	};
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

const { consumeIntent, releaseIntent } = await import('../api/_lib/x402.js');

const MIG_DIR = new URL('../api/_lib/migrations/', import.meta.url);

// The original CREATE TABLE, lifted verbatim from the migration that shipped
// it. The two foreign keys point at users / agent_identities, which this
// isolated database does not have, so only those clauses are dropped; every
// column, default and CHECK is kept exactly as production got it.
function originalIntentsDdl() {
	const src = readFileSync(new URL('2026-04-29-agent-payments.sql', MIG_DIR), 'utf8');
	const start = src.indexOf('create table if not exists agent_payment_intents');
	const end = src.indexOf(');', start) + 2;
	expect(start).toBeGreaterThan(-1);
	return src
		.slice(start, end)
		.replace(/--[^\n]*/g, '')
		.replace(/\s+references\s+\w+\(id\)\s+on delete cascade/g, '');
}

const WIDEN = readFileSync(
	new URL('20260930140000_agent_payment_intents_consumed_status.sql', MIG_DIR),
	'utf8',
);

async function seedPaidIntent(id) {
	await dbState.pg.query(
		`insert into agent_payment_intents
			(id, payer_user_id, agent_id, currency_mint, amount, memo, start_time, end_time,
			 status, cluster, payload, expires_at)
		 values ($1, gen_random_uuid(), gen_random_uuid(), 'mint', '1000000', '1',
			now(), now() + interval '1 day', 'paid', 'mainnet', '{}'::jsonb, now() + interval '1 day')`,
		[id],
	);
}

async function statusOf(id) {
	const { rows } = await dbState.pg.query('select status from agent_payment_intents where id = $1', [id]);
	return rows[0]?.status;
}

beforeEach(async () => {
	dbState.pg = new PGlite();
	await dbState.pg.exec(originalIntentsDdl());
});

describe('agent_payment_intents status constraint', () => {
	it('rejects consumeIntent under the original constraint (the production failure)', async () => {
		await seedPaidIntent('intent-old');
		await expect(consumeIntent('intent-old')).rejects.toThrow(/agent_payment_intents_status_check/);
		expect(await statusOf('intent-old')).toBe('paid');
	});

	it('consumeIntent succeeds once the widening migration is applied', async () => {
		await dbState.pg.exec(WIDEN);
		await seedPaidIntent('intent-new');
		expect(await consumeIntent('intent-new')).toBe(true);
		expect(await statusOf('intent-new')).toBe('consumed');
		// Single use: the second claim loses.
		expect(await consumeIntent('intent-new')).toBe(false);
	});

	it('releaseIntent restores a consumed intent to paid so the buyer can retry', async () => {
		await dbState.pg.exec(WIDEN);
		await seedPaidIntent('intent-release');
		await consumeIntent('intent-release');
		expect(await releaseIntent('intent-release')).toBe(true);
		expect(await statusOf('intent-release')).toBe('paid');
	});

	it('the migration is idempotent', async () => {
		await dbState.pg.exec(WIDEN);
		await dbState.pg.exec(WIDEN);
		await seedPaidIntent('intent-twice');
		expect(await consumeIntent('intent-twice')).toBe(true);
	});
});
