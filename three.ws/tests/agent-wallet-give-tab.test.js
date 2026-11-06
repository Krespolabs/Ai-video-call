// Agent Wallet hub — Give tab (charity + round-up).
//
// The tab's money movement is the real, server-signed withdraw endpoint (covered
// by tests/agent-wallet-withdraw.test.js). What's worth pinning here is the pure,
// DOM-free logic the tab leans on: the cause-address validator, amount
// formatting, the localStorage pref round-trip, and the "spare change" rounding
// that turns a fractional balance into a donation amount.

import { describe, it, expect, beforeEach } from 'vitest';

// jsdom isn't on for this suite (env: node) — give a minimal localStorage so the
// pref helpers exercise their real read/write path.
beforeEach(() => {
	const store = new Map();
	globalThis.localStorage = {
		getItem: (k) => (store.has(k) ? store.get(k) : null),
		setItem: (k, v) => store.set(k, String(v)),
		removeItem: (k) => store.delete(k),
		clear: () => store.clear(),
	};
});

const { __test } = await import('../src/agent-wallet-hub/tabs/give.js');
const { SOL_ADDR_RE, fmtAmount, loadPref, savePref, clearPref, PREF_KEY } = __test;

const VALID_SOL = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';

describe('cause address validation', () => {
	it('accepts a base58 Solana address', () => {
		expect(SOL_ADDR_RE.test(VALID_SOL)).toBe(true);
	});
	it('rejects an EVM 0x address, a .sol name, and junk', () => {
		expect(SOL_ADDR_RE.test('0x1234567890123456789012345678901234567890')).toBe(false);
		expect(SOL_ADDR_RE.test('ocean.sol')).toBe(false);
		expect(SOL_ADDR_RE.test('not an address')).toBe(false);
		expect(SOL_ADDR_RE.test('0OIl')).toBe(false); // ambiguous base58 chars excluded
	});
});

describe('fmtAmount', () => {
	it('caps fractional digits without scientific notation', () => {
		expect(fmtAmount(1.23456789)).toBe('1.234568');
		expect(fmtAmount(0)).toBe('0');
		expect(fmtAmount(12)).toBe('12');
	});
	it('is resilient to non-numbers', () => {
		expect(fmtAmount(null)).toBe('0');
		expect(fmtAmount('abc')).toBe('abc');
	});
});

describe('giving pref round-trip (localStorage)', () => {
	const agentId = 'agent-xyz';

	it('returns null when nothing is saved', () => {
		expect(loadPref(agentId)).toBe(null);
	});

	it('saves and loads a valid cause', () => {
		savePref(agentId, { address: VALID_SOL, name: 'ocean.sol', label: 'Ocean Cleanup' });
		const got = loadPref(agentId);
		expect(got).toMatchObject({ address: VALID_SOL, name: 'ocean.sol', label: 'Ocean Cleanup' });
	});

	it('rejects a stored pref whose address is not a valid Solana address', () => {
		localStorage.setItem(PREF_KEY(agentId), JSON.stringify({ address: '0xdeadbeef', label: 'bad' }));
		expect(loadPref(agentId)).toBe(null);
	});

	it('namespaces prefs per agent and clears cleanly', () => {
		savePref('a', { address: VALID_SOL });
		savePref('b', { address: VALID_SOL, label: 'B cause' });
		expect(loadPref('a')?.label ?? null).toBe(null);
		expect(loadPref('b')?.label).toBe('B cause');
		clearPref('b');
		expect(loadPref('b')).toBe(null);
		expect(loadPref('a')).not.toBe(null);
	});
});

describe('spare-change rounding (the round-up donation amount)', () => {
	// Mirrors the tab's spareChange(): spare = balance - floor(balance), fixed to
	// the asset's decimals, donated only when > 0.
	const spareOf = (max, decimals) => +(max - Math.floor(max)).toFixed(Math.min(decimals, 9));

	it('gives the fractional remainder of a USDC balance', () => {
		expect(spareOf(12.37, 6)).toBe(0.37);
	});
	it('keeps whole balances at zero (nothing to round up)', () => {
		expect(spareOf(20, 6)).toBe(0);
	});
	it('handles SOL precision without float drift', () => {
		expect(spareOf(1.5, 9)).toBe(0.5);
		expect(spareOf(0.123456789, 9)).toBe(0.123456789);
	});
});
