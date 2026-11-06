// Launch Director — unit tests for the pure command parser, validation, the
// stage→narration mapping, and the formatting helpers. No DOM, no network:
// renderLaunchHud needs a canvas and is exercised in the browser, but every bit
// of logic the launch depends on lives in pure functions covered here.

import { describe, it, expect } from 'vitest';
import {
	parseLaunchCommand,
	validateLaunchParams,
	narrate,
	LAUNCH_STAGES,
	LAUNCH_LIMITS,
	stageIndex,
	truncMid,
	formatSol,
} from '../src/launch-director.js';

describe('parseLaunchCommand', () => {
	it('returns null for non-launch text', () => {
		expect(parseLaunchCommand('research the latest in AI')).toBe(null);
		expect(parseLaunchCommand('')).toBe(null);
		expect(parseLaunchCommand(null)).toBe(null);
		// "launch" without any coin signal stays a normal task
		expect(parseLaunchCommand('launch the research report')).toBe(null);
	});

	it('never hijacks "launchpad …"', () => {
		expect(parseLaunchCommand('launchpad studio open the gallery')).toBe(null);
	});

	it('parses a full command with keyword name, ticker, uri', () => {
		const p = parseLaunchCommand(
			'launch a coin named Doge Killer ticker DKILL uri https://meta.example/d.json',
		);
		expect(p).toMatchObject({
			name: 'Doge Killer',
			symbol: 'DKILL',
			uri: 'https://meta.example/d.json',
			network: 'mainnet',
			buyback_bps: 0,
			sol_buy_in: 0,
		});
	});

	it('parses a quoted name, devnet, and percent buyback', () => {
		const p = parseLaunchCommand(
			'launch coin "My Cool Coin" ticker MCC uri https://x.io/m.json on devnet buyback 4.2%',
		);
		expect(p.name).toBe('My Cool Coin');
		expect(p.symbol).toBe('MCC');
		expect(p.network).toBe('devnet');
		expect(p.buyback_bps).toBe(420);
	});

	it('accepts buyback expressed in bps', () => {
		const p = parseLaunchCommand('launch token named A ticker A uri https://x.io/m.json buyback 250 bps');
		expect(p.buyback_bps).toBe(250);
	});

	it('reads a $TICKER fallback and stops the name before it', () => {
		const p = parseLaunchCommand('launch a coin named Foo $FOO uri https://x.io/m.json');
		expect(p.symbol).toBe('FOO');
		expect(p.name).toBe('Foo');
	});

	it('parses an optional SOL dev buy', () => {
		const p = parseLaunchCommand('launch a coin named A ticker A uri https://x.io/m.json with 0.5 sol');
		expect(p.sol_buy_in).toBe(0.5);
		const p2 = parseLaunchCommand('launch a coin named A ticker A uri https://x.io/m.json dev buy 1.25 sol');
		expect(p2.sol_buy_in).toBe(1.25);
	});

	it('trims trailing punctuation off the URI and keeps the network out of it', () => {
		const p = parseLaunchCommand('launch a coin named A ticker A uri https://x.io/m.json on devnet.');
		expect(p.uri).toBe('https://x.io/m.json');
		expect(p.network).toBe('devnet');
	});

	it('clamps buyback to the 0–10000 bps range', () => {
		const p = parseLaunchCommand('launch a coin named A ticker A uri https://x.io/m.json buyback 50000 bps');
		expect(p.buyback_bps).toBe(10_000);
	});

	it('returns incomplete params (validation handles the gaps)', () => {
		const p = parseLaunchCommand('launch a coin uri https://x.io/m.json');
		expect(p.name).toBe(null);
		expect(p.symbol).toBe(null);
		expect(p.uri).toBe('https://x.io/m.json');
	});
});

describe('validateLaunchParams', () => {
	const good = { name: 'Good Coin', symbol: 'GOOD', uri: 'https://x.io/m.json', network: 'mainnet' };

	it('passes a complete, in-bounds command', () => {
		expect(validateLaunchParams(good)).toEqual({ ok: true, errors: [] });
	});

	it('flags a missing name, ticker, and uri', () => {
		const r = validateLaunchParams({ name: null, symbol: null, uri: null });
		expect(r.ok).toBe(false);
		expect(r.errors).toHaveLength(3);
	});

	it('enforces the endpoint length limits', () => {
		const longName = validateLaunchParams({ ...good, name: 'x'.repeat(LAUNCH_LIMITS.name + 1) });
		expect(longName.ok).toBe(false);
		const longSym = validateLaunchParams({ ...good, symbol: 'x'.repeat(LAUNCH_LIMITS.symbol + 1) });
		expect(longSym.ok).toBe(false);
		const longUri = validateLaunchParams({ ...good, uri: `https://x.io/${'a'.repeat(LAUNCH_LIMITS.uri)}` });
		expect(longUri.ok).toBe(false);
	});

	it('rejects a non-http URI and an unknown network', () => {
		expect(validateLaunchParams({ ...good, uri: 'ipfs://abc' }).ok).toBe(false);
		expect(validateLaunchParams({ ...good, network: 'testnet' }).ok).toBe(false);
	});
});

describe('narrate', () => {
	it('maps every stage to a non-empty, value-bearing line', () => {
		const ctx = { name: 'Good Coin', symbol: 'GOOD', network: 'devnet' };
		for (const s of LAUNCH_STAGES) {
			expect(narrate(s.key, ctx).length).toBeGreaterThan(0);
		}
		expect(narrate('prepare', ctx)).toContain('$GOOD');
		expect(narrate('prepare', ctx)).toContain('devnet');
		expect(narrate('broadcast', ctx)).toContain('devnet');
	});

	it('only claims success once a real signature is present', () => {
		expect(narrate('confirm', {})).toBe('Confirming on-chain…');
		const live = narrate('confirm', { mint: 'Mint1111111111', signature: 'Sig22222222222' });
		expect(live).toContain('Live!');
	});

	it('shows the spend ceiling once known', () => {
		expect(narrate('policy', {})).toBe('Checking spend policy…');
		expect(narrate('policy', { ceilingSol: 1, solBuyIn: 0.25 })).toContain('ceiling 1 SOL/tx');
	});

	it('confirms the feed only when the coin actually surfaced', () => {
		expect(narrate('feed', { symbol: 'GOOD', onFeed: false })).toContain('Surfacing');
		expect(narrate('feed', { symbol: 'GOOD', onFeed: true })).toContain('launches feed');
	});
});

describe('helpers', () => {
	it('stageIndex finds the ordered position', () => {
		expect(stageIndex('prepare')).toBe(0);
		expect(stageIndex('feed')).toBe(LAUNCH_STAGES.length - 1);
		expect(stageIndex('nope')).toBe(-1);
	});

	it('truncMid middle-truncates long strings only', () => {
		expect(truncMid('short')).toBe('short');
		expect(truncMid('ABCDEFGHIJKLMNOP', 4, 4)).toBe('ABCD…MNOP');
	});

	it('formatSol renders small and zero amounts cleanly', () => {
		expect(formatSol(0)).toBe('0');
		expect(formatSol(0.5)).toBe('0.5');
		expect(formatSol(1)).toBe('1');
	});
});
