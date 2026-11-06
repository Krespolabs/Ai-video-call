// Runtime feature flags (api/_lib/flags.js) — DB-backed switches read live by
// crons and request paths. These tests pin the contract that makes the flag a
// safe replacement for a redeploy-gated env var:
//
//   • a missing row resolves to the caller's fallback (the env default),
//   • a present row is authoritative,
//   • reads are cached so a per-minute cron doesn't hammer the DB,
//   • setFlag() invalidates the cache so the writer sees its own change at once,
//   • any DB error fails soft to the fallback (a flags outage never breaks a cron).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const sqlCalls = [];
let sqlHandler = () => [];

vi.mock('../api/_lib/db.js', () => {
	const sql = vi.fn(async (strings, ...values) => {
		const query = Array.isArray(strings) ? strings.join('?') : String(strings);
		sqlCalls.push({ query, values });
		return sqlHandler(query, values) ?? [];
	});
	return { sql, isDbUnavailableError: () => false, isDbCapacityError: () => false };
});

const { getFlag, isFlagEnabled, setFlag, listFlags, __clearFlagCache } = await import('../api/_lib/flags.js');

beforeEach(() => {
	sqlCalls.length = 0;
	sqlHandler = () => [];
	__clearFlagCache();
});

describe('getFlag', () => {
	it('returns the fallback when no row exists', async () => {
		sqlHandler = () => []; // no row
		expect(await getFlag('avaturn_seed', { fallback: true })).toEqual({
			enabled: true,
			value: null,
			exists: false,
		});
		expect(await isFlagEnabled('avaturn_seed', { fallback: false })).toBe(false);
	});

	it('returns the row when it exists, ignoring the fallback', async () => {
		sqlHandler = (q) => (q.includes('select enabled') ? [{ enabled: true, value: null }] : []);
		__clearFlagCache();
		expect(await isFlagEnabled('avaturn_seed', { fallback: false })).toBe(true);

		sqlHandler = (q) => (q.includes('select enabled') ? [{ enabled: false, value: null }] : []);
		__clearFlagCache();
		expect(await isFlagEnabled('avaturn_seed', { fallback: true })).toBe(false);
	});

	it('surfaces a structured value payload', async () => {
		sqlHandler = () => [{ enabled: true, value: { cadence: 30 } }];
		const flag = await getFlag('avaturn_seed', { fallback: false });
		expect(flag).toEqual({ enabled: true, value: { cadence: 30 }, exists: true });
	});
});

describe('caching', () => {
	it('serves a fresh read from cache without a second DB query', async () => {
		sqlHandler = () => [{ enabled: true, value: null }];
		await getFlag('avaturn_seed');
		const after = sqlCalls.length;
		await getFlag('avaturn_seed');
		await getFlag('avaturn_seed');
		expect(sqlCalls.length).toBe(after); // no further DB hits
	});

	it('setFlag clears the cache so the next read hits the DB', async () => {
		sqlHandler = (q) =>
			q.includes('insert into app_flags')
				? [{ key: 'avaturn_seed', enabled: true, value: null, updated_at: 't' }]
				: [{ enabled: false, value: null }];

		await getFlag('avaturn_seed'); // populate cache (enabled=false)
		await setFlag('avaturn_seed', { enabled: true });
		const before = sqlCalls.length;
		sqlHandler = () => [{ enabled: true, value: null }];
		const flag = await getFlag('avaturn_seed');
		expect(sqlCalls.length).toBeGreaterThan(before); // cache was invalidated → DB read
		expect(flag.enabled).toBe(true);
	});
});

describe('fail-soft', () => {
	it('returns the fallback when the DB query throws', async () => {
		sqlHandler = () => {
			throw new Error('db down');
		};
		expect(await isFlagEnabled('avaturn_seed', { fallback: true })).toBe(true);
		expect(await isFlagEnabled('avaturn_seed', { fallback: false })).toBe(false);
	});
});

describe('listFlags', () => {
	it('includes known flags that have no row yet', async () => {
		sqlHandler = () => []; // no rows
		const flags = await listFlags();
		const avaturn = flags.find((f) => f.key === 'avaturn_seed');
		expect(avaturn).toMatchObject({
			key: 'avaturn_seed',
			enabled: false,
			exists: false,
			env: 'AVATURN_SEED_ENABLED',
		});
		expect(avaturn.description).toContain('Avaturn');
	});

	it('reflects a set row over the registry default', async () => {
		sqlHandler = () => [{ key: 'avaturn_seed', enabled: true, value: null, updated_at: 't' }];
		const flags = await listFlags();
		expect(flags.find((f) => f.key === 'avaturn_seed')).toMatchObject({ enabled: true, exists: true });
	});
});
