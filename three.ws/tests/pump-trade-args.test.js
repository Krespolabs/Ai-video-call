// Unit tests for api/_lib/pump-trade-args.js plus offline conformance checks
// of the @pump-fun/pump-sdk v2 builders (as called by our buy/sell handlers)
// against the vendored IDL in docs/pumpfun-program/idl/pump.json.
//
// Everything here runs offline — no RPC, no mocks of the SDK itself.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import BN from 'bn.js';
import { PublicKey, Keypair } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { PumpSdk } from '@pump-fun/pump-sdk';

import {
	slippagePercentFromBps,
	resolveTokenProgramForMintOwner,
	resolveCustodialQuote,
	usdcMintForNetwork,
	WSOL_MINT,
	SPL_TOKEN_PROGRAM_ID,
	TOKEN_2022_PROGRAM_ID as T22_FROM_LIB,
} from '../api/_lib/pump-trade-args.js';

const idl = JSON.parse(
	readFileSync(
		fileURLToPath(new URL('../docs/pumpfun-program/idl/pump.json', import.meta.url)),
		'utf8',
	),
);

// ── slippagePercentFromBps ──────────────────────────────────────────────────

describe('slippagePercentFromBps', () => {
	it('converts basis points to the SDK percent unit (100 bps -> 1)', () => {
		expect(slippagePercentFromBps(100)).toBe(1);
		expect(slippagePercentFromBps(500)).toBe(5);
		expect(slippagePercentFromBps(50)).toBe(0.5);
		expect(slippagePercentFromBps(0)).toBe(0);
	});

	it('falls back to the default for non-finite input', () => {
		expect(slippagePercentFromBps(undefined)).toBe(1);
		expect(slippagePercentFromBps(NaN)).toBe(1);
		expect(slippagePercentFromBps('nope', { defaultBps: 500 })).toBe(5);
	});

	it('clamps to [0, 100] percent', () => {
		expect(slippagePercentFromBps(-5)).toBe(0);
		expect(slippagePercentFromBps(50_000)).toBe(100);
	});

	it('reproduces the user bps exactly through the pump-sdk pad formula', () => {
		// pump-sdk pads max cost via amount * floor(slippage * 10) / 1000.
		// With percent units, floor(pct * 10) / 1000 === bps / 10_000 for any
		// whole multiple of 10 bps — the property the trade handlers rely on.
		for (const bps of [10, 100, 250, 500, 1000, 5000]) {
			const pct = slippagePercentFromBps(bps);
			expect(Math.floor(pct * 10) / 1000).toBeCloseTo(bps / 10_000, 12);
		}
	});

	it('reproduces the user bps through the pump-swap-sdk factor formula', () => {
		// pump-swap-sdk computes maxQuote = quote * (1 + slippage / 100).
		for (const bps of [10, 100, 250, 500, 1000]) {
			const pct = slippagePercentFromBps(bps);
			expect(1 + pct / 100).toBeCloseTo(1 + bps / 10_000, 12);
		}
	});
});

// ── resolveTokenProgramForMintOwner ────────────────────────────────────────

describe('resolveTokenProgramForMintOwner', () => {
	it('maps the SPL Token owner to the SPL program id', () => {
		const p = resolveTokenProgramForMintOwner(SPL_TOKEN_PROGRAM_ID);
		expect(p.equals(TOKEN_PROGRAM_ID)).toBe(true);
	});

	it('maps the Token-2022 owner to the Token-2022 program id', () => {
		const p = resolveTokenProgramForMintOwner(T22_FROM_LIB);
		expect(p.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
	});

	it('accepts base58 strings', () => {
		const p = resolveTokenProgramForMintOwner('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
		expect(p.equals(TOKEN_2022_PROGRAM_ID)).toBe(true);
	});

	it('throws a typed 422 for unknown owners (e.g. System Program)', () => {
		let err = null;
		try {
			resolveTokenProgramForMintOwner(PublicKey.default);
		} catch (e) {
			err = e;
		}
		expect(err).not.toBeNull();
		expect(err.status).toBe(422);
		expect(err.code).toBe('unsupported_token_program');
	});
});

// ── resolveCustodialQuote ──────────────────────────────────────────────────
//
// The custodial (server-signed) buy/sell/swap paths read the coin's quote asset
// from its on-chain bonding curve and feed it to the v2 builder. This resolver
// is the pure core of that decision: SOL-paired vs USDC-paired vs other SPL.

describe('resolveCustodialQuote', () => {
	const USDC = usdcMintForNetwork('mainnet');
	const USDC_DEVNET = usdcMintForNetwork('devnet');

	it('treats null/undefined (no quote on the curve) as SOL-paired', () => {
		for (const v of [null, undefined, '']) {
			const q = resolveCustodialQuote(v);
			expect(q).toEqual({ isSol: true, isUsdc: false, quoteSymbol: 'SOL', quoteMint: WSOL_MINT });
		}
	});

	it('treats the system-default pubkey (SOL curve sentinel) as SOL-paired', () => {
		const q = resolveCustodialQuote(PublicKey.default);
		expect(q.isSol).toBe(true);
		expect(q.isUsdc).toBe(false);
		expect(q.quoteMint).toBe(WSOL_MINT);
	});

	it('treats the explicit wrapped-SOL mint as SOL-paired (string and PublicKey)', () => {
		expect(resolveCustodialQuote(WSOL_MINT).isSol).toBe(true);
		expect(resolveCustodialQuote(NATIVE_MINT).isSol).toBe(true);
		expect(resolveCustodialQuote(new PublicKey(WSOL_MINT)).quoteSymbol).toBe('SOL');
	});

	it('classifies the network USDC mint as USDC-paired', () => {
		const q = resolveCustodialQuote(USDC, 'mainnet');
		expect(q).toEqual({ isSol: false, isUsdc: true, quoteSymbol: 'USDC', quoteMint: USDC });
		expect(resolveCustodialQuote(new PublicKey(USDC)).isUsdc).toBe(true);
	});

	it('is network-aware: devnet USDC is USDC on devnet but OTHER on mainnet', () => {
		expect(resolveCustodialQuote(USDC_DEVNET, 'devnet').quoteSymbol).toBe('USDC');
		const onMainnet = resolveCustodialQuote(USDC_DEVNET, 'mainnet');
		expect(onMainnet.isUsdc).toBe(false);
		expect(onMainnet.quoteSymbol).toBe('OTHER');
		expect(onMainnet.quoteMint).toBe(USDC_DEVNET);
	});

	it('classifies an arbitrary SPL quote mint as OTHER (non-SOL, non-USDC)', () => {
		const other = Keypair.generate().publicKey;
		const q = resolveCustodialQuote(other, 'mainnet');
		expect(q.isSol).toBe(false);
		expect(q.isUsdc).toBe(false);
		expect(q.quoteSymbol).toBe('OTHER');
		expect(q.quoteMint).toBe(other.toBase58());
	});
});

// ── v2 builder conformance vs the vendored IDL ─────────────────────────────
//
// Our handlers call buyV2Instructions / sellV2Instructions, which bottom out
// in getBuyV2InstructionRaw / getSellV2InstructionRaw. Build both offline with
// synthetic keys and assert account count, order flags (writable/signer), the
// fixed program addresses, and the discriminator all match the vendored IDL.

const sdk = new PumpSdk();
const MINT = Keypair.generate().publicKey;
const USER = Keypair.generate().publicKey;
const CREATOR = Keypair.generate().publicKey;
const FEE_RECIPIENT = Keypair.generate().publicKey;
const BUYBACK_RECIPIENT = Keypair.generate().publicKey;

function idlIx(name) {
	const ix = idl.instructions.find((i) => i.name === name);
	expect(ix, `IDL instruction ${name}`).toBeTruthy();
	return ix;
}

function expectFlagsMatchIdl(built, idlDef) {
	expect(built.keys.length).toBe(idlDef.accounts.length);
	idlDef.accounts.forEach((acc, i) => {
		expect(built.keys[i].isWritable, `${idlDef.name} account[${i}] ${acc.name} writable`).toBe(
			!!acc.writable,
		);
		expect(built.keys[i].isSigner, `${idlDef.name} account[${i}] ${acc.name} signer`).toBe(
			!!acc.signer,
		);
		if (acc.address) {
			expect(
				built.keys[i].pubkey.toBase58(),
				`${idlDef.name} account[${i}] ${acc.name}`,
			).toBe(acc.address);
		}
	});
}

describe('buy_v2 instruction (SDK getBuyV2InstructionRaw, as used by buy handlers)', () => {
	it('matches the vendored IDL account list, flags, and discriminator', async () => {
		const ix = await sdk.getBuyV2InstructionRaw({
			user: USER,
			mint: MINT,
			creator: CREATOR,
			amount: new BN(123_456),
			quoteAmount: new BN(1_000_000),
			feeRecipient: FEE_RECIPIENT,
			buybackFeeRecipient: BUYBACK_RECIPIENT,
			tokenProgram: TOKEN_2022_PROGRAM_ID,
			quoteMint: NATIVE_MINT,
			quoteTokenProgram: TOKEN_PROGRAM_ID,
		});
		const def = idlIx('buy_v2');
		expectFlagsMatchIdl(ix, def);
		expect([...ix.data.subarray(0, 8)]).toEqual(def.discriminator);
		// args: amount u64 LE, max_sol_cost u64 LE
		expect(new BN(ix.data.subarray(8, 16), 'le').toString()).toBe('123456');
		expect(new BN(ix.data.subarray(16, 24), 'le').toString()).toBe('1000000');
		// identity spot checks per BUY.md
		expect(ix.keys[1].pubkey.equals(MINT)).toBe(true); // base_mint
		expect(ix.keys[2].pubkey.equals(NATIVE_MINT)).toBe(true); // quote_mint
		expect(ix.keys[3].pubkey.equals(TOKEN_2022_PROGRAM_ID)).toBe(true); // base_token_program
		expect(ix.keys[4].pubkey.equals(TOKEN_PROGRAM_ID)).toBe(true); // quote_token_program
		expect(ix.keys[13].pubkey.equals(USER)).toBe(true); // user (sole signer)
		const signers = ix.keys.map((k, i) => (k.isSigner ? i : -1)).filter((i) => i >= 0);
		expect(signers).toEqual([13]);
	});
});

describe('sell_v2 instruction (SDK getSellV2InstructionRaw, as used by sell handlers)', () => {
	it('matches the vendored IDL account list, flags, and discriminator', async () => {
		const ix = await sdk.getSellV2InstructionRaw({
			user: USER,
			mint: MINT,
			creator: CREATOR,
			amount: new BN(42),
			quoteAmount: new BN(7),
			feeRecipient: FEE_RECIPIENT,
			buybackFeeRecipient: BUYBACK_RECIPIENT,
			tokenProgram: TOKEN_2022_PROGRAM_ID,
			quoteMint: NATIVE_MINT,
			quoteTokenProgram: TOKEN_PROGRAM_ID,
		});
		const def = idlIx('sell_v2');
		expectFlagsMatchIdl(ix, def);
		expect([...ix.data.subarray(0, 8)]).toEqual(def.discriminator);
		expect(new BN(ix.data.subarray(8, 16), 'le').toString()).toBe('42');
		expect(new BN(ix.data.subarray(16, 24), 'le').toString()).toBe('7');
		expect(ix.keys[1].pubkey.equals(MINT)).toBe(true);
		expect(ix.keys[2].pubkey.equals(NATIVE_MINT)).toBe(true);
		const signers = ix.keys.map((k, i) => (k.isSigner ? i : -1)).filter((i) => i >= 0);
		expect(signers).toEqual([13]);
	});
});
