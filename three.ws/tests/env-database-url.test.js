/**
 * env.js Postgres connection-string resolution — unit test.
 *
 * The Vercel Postgres / Neon Marketplace integration injects the live
 * connection string under names OTHER than the bare DATABASE_URL the code reads
 * (POSTGRES_URL, DATABASE_URL_UNPOOLED, POSTGRES_URL_NON_POOLING,
 * NEON_DATABASE_URL, POSTGRES_PRISMA_URL). When the integration is attached but
 * DATABASE_URL was never mirrored by hand, every DB-backed read threw
 * "Missing required env var: DATABASE_URL" and the whole data plane degraded to
 * empty (the June 2026 incident). env.DATABASE_URL now resolves from any of
 * those aliases — in priority order, trimming dashboard paste artifacts and
 * requiring a postgres(ql):// scheme — and databaseConfigured() mirrors it for
 * the store-module gates. This pins that contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { env, databaseConfigured } from '../api/_lib/env.js';

const KEYS = [
	'DATABASE_URL',
	'POSTGRES_URL',
	'DATABASE_URL_UNPOOLED',
	'POSTGRES_URL_NON_POOLING',
	'NEON_DATABASE_URL',
	'POSTGRES_PRISMA_URL',
];
let saved;

beforeEach(() => {
	saved = {};
	for (const k of KEYS) {
		saved[k] = process.env[k];
		delete process.env[k];
	}
});

afterEach(() => {
	for (const k of KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
});

describe('env.DATABASE_URL connection-string resolution', () => {
	it('uses the bare DATABASE_URL when set', () => {
		process.env.DATABASE_URL = 'postgresql://u:p@db.neon.tech/main';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
		expect(databaseConfigured()).toBe(true);
	});

	it('resolves from POSTGRES_URL when DATABASE_URL is absent (Vercel Postgres integration)', () => {
		process.env.POSTGRES_URL = 'postgres://u:p@pooler.neon.tech/main';
		expect(env.DATABASE_URL).toBe('postgres://u:p@pooler.neon.tech/main');
		expect(databaseConfigured()).toBe(true);
	});

	it('resolves from DATABASE_URL_UNPOOLED / NEON_DATABASE_URL aliases', () => {
		process.env.NEON_DATABASE_URL = 'postgresql://u:p@db.neon.tech/main';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	it('prefers the canonical name over a lower-priority alias', () => {
		process.env.DATABASE_URL = 'postgresql://primary@db/main';
		process.env.POSTGRES_URL = 'postgresql://alias@db/main';
		expect(env.DATABASE_URL).toBe('postgresql://primary@db/main');
	});

	it('trims a dashboard-pasted trailing newline (would otherwise break neon())', () => {
		process.env.DATABASE_URL = 'postgresql://u:p@db.neon.tech/main\n';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	// A connection string pasted WITH its surrounding quotes survives cred()'s
	// whitespace trim but fails the postgres:// scheme guard (it starts with `"`),
	// so the alias was silently skipped and resolution reported MISSING even though
	// a valid URL was present — neon() also throws "is not a valid URL" on the raw
	// quoted value. Both quote styles must be unwrapped.
	it('strips surrounding double quotes (dashboard paste)', () => {
		process.env.DATABASE_URL = '"postgresql://u:p@db.neon.tech/main"';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
		expect(databaseConfigured()).toBe(true);
	});

	it('strips surrounding single quotes', () => {
		process.env.DATABASE_URL = "'postgresql://u:p@db.neon.tech/main'";
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	it('strips quotes plus surrounding whitespace together', () => {
		process.env.DATABASE_URL = '  "postgresql://u:p@db.neon.tech/main"  ';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	// A value copied straight from a `psql …` connect command keeps the command
	// prefix; strip it (and an optional `-d`), including when the URL is quoted.
	it('strips an accidental "psql " shell-copy prefix', () => {
		process.env.DATABASE_URL = 'psql postgresql://u:p@db.neon.tech/main';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	it('strips a "psql -d \'<url>\'" prefix with quotes', () => {
		process.env.DATABASE_URL = `psql -d 'postgresql://u:p@db.neon.tech/main'`;
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	it('a quoted alias is recovered when the canonical name is absent', () => {
		process.env.POSTGRES_URL = '"postgres://u:p@pooler.neon.tech/main"';
		expect(env.DATABASE_URL).toBe('postgres://u:p@pooler.neon.tech/main');
	});

	it('ignores a non-postgres value on a higher-priority name and falls through', () => {
		// A stray/garbage value on DATABASE_URL must not shadow a real URL on an alias.
		process.env.DATABASE_URL = 'not-a-connection-string';
		process.env.POSTGRES_URL = 'postgresql://u:p@db.neon.tech/main';
		expect(env.DATABASE_URL).toBe('postgresql://u:p@db.neon.tech/main');
	});

	it('throws the unchanged "Missing required env var" message when no source is set', () => {
		expect(() => env.DATABASE_URL).toThrow('Missing required env var: DATABASE_URL');
		expect(databaseConfigured()).toBe(false);
	});
});
