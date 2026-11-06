// resolveRecipient — turns a public identifier (username / wallet / user id) a
// gifter typed into a real account, and ONLY a public profile. Each branch is
// identifier-shaped, so this pins which query runs for which input and that a
// miss returns null (never throws).

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Content-addressed db mock: `hit` is the row each branch returns (null = miss).
const state = { hit: { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null } };
let calls = [];

vi.mock('../../api/_lib/db.js', () => ({
	sql: vi.fn(async (strings, ...values) => {
		const q = strings.join(' ? ');
		calls.push({ q, values });
		return state.hit ? [state.hit] : [];
	}),
	isDbUnavailableError: () => false,
	isDbCapacityError: () => false,
}));

const { resolveRecipient } = await import('../../api/_lib/resolve-recipient.js');

const lastQuery = () => calls[calls.length - 1]?.q || '';
const lastValues = () => calls[calls.length - 1]?.values || [];

beforeEach(() => {
	calls = [];
	state.hit = { id: 'u1', username: 'alice', display_name: 'Alice', avatar_url: null };
});

describe('resolveRecipient', () => {
	it('returns null for empty / non-string input without touching the db', async () => {
		expect(await resolveRecipient('')).toBeNull();
		expect(await resolveRecipient('   ')).toBeNull();
		expect(await resolveRecipient(null)).toBeNull();
		expect(await resolveRecipient(undefined)).toBeNull();
		expect(calls).toHaveLength(0);
	});

	it('resolves a raw user id via the users.id lookup', async () => {
		const out = await resolveRecipient('123e4567-e89b-42d3-a456-426614174000');
		expect(out).toEqual(state.hit);
		expect(lastQuery()).toMatch(/WHERE id =/i);
	});

	it('resolves an EVM wallet case-insensitively across login + linked wallets', async () => {
		await resolveRecipient('0xAbCdef0123456789012345678901234567890ABC');
		expect(lastQuery()).toMatch(/lower\(u\.wallet_address\)/i);
		// the address is lowercased before matching
		expect(lastValues()[0]).toBe('0xabcdef0123456789012345678901234567890abc');
	});

	it('resolves a Solana wallet against linked solana wallets (case-sensitive)', async () => {
		const addr = '7EYnhQoR9YM3N7UoaKRoA44Uy8JeaZV3qyouov87awMs';
		await resolveRecipient(addr);
		expect(lastQuery()).toMatch(/chain_type = 'solana'/i);
		expect(lastValues()[0]).toBe(addr); // verbatim, not lowercased
	});

	it('resolves a username case-insensitively and strips a leading @', async () => {
		await resolveRecipient('@Alice');
		expect(lastQuery()).toMatch(/lower\(username\) = lower/i);
		expect(lastValues()[0]).toBe('Alice');
	});

	it('returns null when nothing matches', async () => {
		state.hit = null;
		expect(await resolveRecipient('nobody')).toBeNull();
	});
});
