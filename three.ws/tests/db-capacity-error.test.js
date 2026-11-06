/**
 * isDbCapacityError — classify the Neon storage-cap failure (SQLSTATE 53100).
 *
 * When a branch hits its project-size limit, Postgres raises 53100 ("could not
 * extend file because project size limit … exceeded"). It must be recognized so
 * write paths degrade gracefully instead of 500-storming — whether the driver
 * surfaces err.code (native) or only the wrapped message (minified prod bundle).
 */

import { describe, it, expect } from 'vitest';
import { isDbCapacityError, isDbUnavailableError } from '../api/_lib/db.js';

describe('isDbCapacityError', () => {
	it('matches on SQLSTATE code 53100', () => {
		const e = new Error('anything');
		e.code = '53100';
		expect(isDbCapacityError(e)).toBe(true);
	});

	it('matches on the Neon message text when the code is stripped (minified bundle)', () => {
		const e = new Error('could not extend file because project size limit (512 MB) has been exceeded');
		e.name = 'NeonDbError';
		expect(isDbCapacityError(e)).toBe(true);
	});

	it('matches the wrapped cause chain', () => {
		const e = new Error('Error connecting to database');
		e.cause = new Error('neon.max_cluster_size exceeded');
		expect(isDbCapacityError(e)).toBe(true);
	});

	it('does not misfire on unrelated errors', () => {
		expect(isDbCapacityError(new Error('syntax error at or near "$3"'))).toBe(false);
		expect(isDbCapacityError(new Error('password authentication failed'))).toBe(false);
		expect(isDbCapacityError(null)).toBe(false);
		expect(isDbCapacityError(undefined)).toBe(false);
	});

	it('is distinct from a connectivity outage (a full DB is reachable)', () => {
		const full = new Error('could not extend file because project size limit exceeded');
		full.code = '53100';
		expect(isDbCapacityError(full)).toBe(true);
		expect(isDbUnavailableError(full)).toBe(false);
	});
});
