// Guards the Solana address surface the platform actually runs on:
//   1. The $THREE mint (the one and only coin, CLAUDE.md) hardcoded across ~25
//      source files must never drift from the canonical CA, and no OTHER
//      pump.fun mint may be baked into first-party source.
//   2. Pump program IDs and well-known Solana programs/mints (canonical home:
//      api/_lib/solana/programs.js) must agree wherever they are re-declared.
//
// The same checks gate the Vercel build (scripts/build-vercel.mjs phase 1,
// `verify:solana`); running them here means `npm test` catches a drift or a
// leaked second coin before a push. The live on-chain probe is exercised by the
// CLI, not here — unit tests stay offline and deterministic.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCanonical, scanForDrift, THREE_MINT } from '../scripts/verify-solana-parity.mjs';

let registry;
beforeAll(async () => {
	// Throws if api/_lib/env.js or api/_lib/solana/programs.js drift from the
	// constants baked into the guard — a source-of-truth disagreement.
	registry = await loadCanonical();
});

describe('solana parity (real repo)', () => {
	it('canonical source-of-truth files agree (loadCanonical resolves)', () => {
		expect(registry.find((e) => e.address === THREE_MINT)).toBeTruthy();
	});

	it('has no address drift or non-$THREE coin across first-party source', async () => {
		expect(await scanForDrift(registry)).toEqual([]);
	});
});

describe('drift detection logic', () => {
	const withTempFile = async (contents, fn) => {
		const dir = mkdtempSync(join(tmpdir(), 'sol-parity-'));
		try {
			writeFileSync(join(dir, 'subject.js'), contents);
			return await fn(dir);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};

	it('flags a drifted program ID and a non-$THREE pump mint', async () => {
		const problems = await withTempFile(
			`const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6X';\n` +
				`const OTHER_COIN = 'ABCdefGHJKLMNPQRstuvwxyz123456789abcdefgpump';\n`,
			(dir) => scanForDrift(registry, { root: dir, files: ['subject.js'] }),
		);
		expect(problems.map((p) => p.type).sort()).toEqual(['const-drift', 'rogue-coin']);
		expect(problems.every((p) => p.line > 0 && p.detail)).toBe(true);
	});

	it('does not flag correct canonical values or devnet variants', async () => {
		const problems = await withTempFile(
			`const PUMP_PROGRAM_ID = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';\n` +
				`const THREE_MINT = '${THREE_MINT}';\n` +
				`const USDC_MINT_DEVNET = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';\n`,
			(dir) => scanForDrift(registry, { root: dir, files: ['subject.js'] }),
		);
		expect(problems).toEqual([]);
	});
});
