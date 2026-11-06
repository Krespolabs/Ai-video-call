import { describe, it, expect, afterEach } from 'vitest';

// The launcher engine pulls in db.js (and transitively env.js) at import time, so
// stub the DB the same lightweight way the engine test does — we only exercise the
// pure env-parsing helper here, never a query.
import { vi } from 'vitest';
vi.mock('../api/_lib/db.js', () => ({ sql: () => Promise.resolve([]), isDbUnavailableError: () => false, isDbCapacityError: () => false }));
vi.mock('../api/_lib/launcher-funding.js', () => ({
	masterBalanceSol: vi.fn(), dailySpentSol: vi.fn(), fundAgentForLaunch: vi.fn(),
}));
vi.mock('../api/_lib/launcher-sources.js', () => ({ pickSource: vi.fn() }));
vi.mock('../api/_lib/auth.js', () => ({ createSession: vi.fn() }));
vi.mock('../api/_lib/agent-pumpfun.js', () => ({ solanaConnection: vi.fn() }));

import { ownerAllowlist } from '../api/_lib/launcher-engine.js';

const A = '11111111-2222-4333-8444-555555555555';
const B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

afterEach(() => { delete process.env.LAUNCHER_OWNER_USER_IDS; });

describe('ownerAllowlist — house-ownership guarantee parsing', () => {
	it('is empty when unset (falls back to the circulation pool)', () => {
		delete process.env.LAUNCHER_OWNER_USER_IDS;
		expect(ownerAllowlist()).toEqual([]);
	});

	it('parses a single uuid', () => {
		process.env.LAUNCHER_OWNER_USER_IDS = A;
		expect(ownerAllowlist()).toEqual([A]);
	});

	it('parses a comma-separated list, trimming whitespace', () => {
		process.env.LAUNCHER_OWNER_USER_IDS = ` ${A} , ${B} `;
		expect(ownerAllowlist()).toEqual([A, B]);
	});

	it('drops malformed entries so the ::uuid[] cast can never throw', () => {
		process.env.LAUNCHER_OWNER_USER_IDS = `${A},not-a-uuid,,123,${B}`;
		expect(ownerAllowlist()).toEqual([A, B]);
	});

	it('is empty when every entry is malformed', () => {
		process.env.LAUNCHER_OWNER_USER_IDS = 'nope, also-nope';
		expect(ownerAllowlist()).toEqual([]);
	});
});
