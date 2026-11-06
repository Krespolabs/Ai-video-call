import { describe, it, expect } from 'vitest';

import {
	parseMetadataAccount,
	metaFromMintExtensions,
	deriveChecks,
	deriveRiskLevel,
	composeTokenSecurity,
	TOP1_FLAG_PCT,
	TOP10_FLAG_PCT,
	THIN_LIQUIDITY_USD,
} from '../api/_lib/crypto-token-security.js';

// Synthetic mints only — never a real third-party mint in fixtures (CLAUDE.md).
const THREE = 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump';
const AUTH = 'THREEsynthetic1111111111111111111111111111A';

// --- fixtures -----------------------------------------------------------

// getAccountInfo(jsonParsed) shapes, matching the live RPC envelope.
const mintAccount = ({ mintAuth = null, freezeAuth = null, supply = '1000000000000000' } = {}) => ({
	value: {
		data: {
			parsed: {
				type: 'mint',
				info: { mintAuthority: mintAuth, freezeAuthority: freezeAuth, supply, decimals: 6 },
			},
		},
	},
});

// getTokenLargestAccounts: top-N token accounts against a 1e15 raw supply.
const largestAccounts = (top1Amount) => ({
	value: [
		{ amount: String(top1Amount) },
		...Array.from({ length: 9 }, () => ({ amount: '1000000000000' })), // 0.1% each
	],
});

// Build a syntactically-valid Metaplex metadata buffer with a chosen is_mutable.
function metadataBuf({ isMutable = true, creators = 0 } = {}) {
	const head = Buffer.alloc(1 + 32 + 32);
	const str = (max) => {
		const b = Buffer.alloc(4 + max);
		b.writeUInt32LE(3, 0);
		b.write('abc', 4);
		return b;
	};
	const fee = Buffer.alloc(2);
	const creatorsOpt = creators
		? Buffer.concat([Buffer.from([1]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(creators, 0); return b; })(), Buffer.alloc(creators * 34)])
		: Buffer.from([0]);
	const tail = Buffer.from([0, isMutable ? 1 : 0]); // primary_sale_happened, is_mutable
	return Buffer.concat([head, str(32), str(10), str(200), fee, creatorsOpt, tail]);
}

const deps = (over = {}) => ({
	fetchMintAccount: async () => ({ result: mintAccount() }),
	fetchLargestAccounts: async () => ({ result: largestAccounts('1000000000000') }),
	fetchMetadataAccount: async () => ({ result: { value: { data: [metadataBuf({ isMutable: false }).toString('base64'), 'base64'] } } }),
	fetchMarket: async () => ({ liquidity_usd: 250_000, pair_label: 'X/SOL', pair_created_at: 1750000000000 }),
	fetchPump: async () => ({ kind: 'not_found' }),
	...over,
});

// --- parseMetadataAccount ------------------------------------------------

describe('parseMetadataAccount', () => {
	it('reads is_mutable with and without creators', () => {
		expect(parseMetadataAccount(metadataBuf({ isMutable: true })).isMutable).toBe(true);
		expect(parseMetadataAccount(metadataBuf({ isMutable: false })).isMutable).toBe(false);
		expect(parseMetadataAccount(metadataBuf({ isMutable: true, creators: 3 })).isMutable).toBe(true);
	});
	it('returns null on truncated/garbage buffers instead of guessing', () => {
		expect(parseMetadataAccount(Buffer.alloc(10))).toBeNull();
		expect(parseMetadataAccount(metadataBuf().subarray(0, 80))).toBeNull();
		expect(parseMetadataAccount(null)).toBeNull();
	});
});

// --- metaFromMintExtensions (Token-2022 embedded metadata) -----------------

describe('metaFromMintExtensions', () => {
	const t22 = (updateAuthority) => ({
		value: {
			data: {
				parsed: {
					type: 'mint',
					info: {
						mintAuthority: null, freezeAuthority: null, supply: '1', decimals: 6,
						extensions: [
							{ extension: 'metadataPointer', state: { authority: null, metadataAddress: THREE } },
							{ extension: 'tokenMetadata', state: { mint: THREE, name: 'x', symbol: 'X', updateAuthority, additionalMetadata: [] } },
						],
					},
				},
			},
		},
	});

	it('None update authority → immutable; set → mutable', () => {
		expect(metaFromMintExtensions(t22(null))).toEqual({ updateAuthority: null, isMutable: false });
		expect(metaFromMintExtensions(t22(AUTH))).toEqual({ updateAuthority: AUTH, isMutable: true });
	});

	it('classic SPL mint (no extensions) → null, deferring to the Metaplex PDA', () => {
		expect(metaFromMintExtensions(mintAccount())).toBeNull();
		expect(metaFromMintExtensions({ value: null })).toBeNull();
	});
});

// --- deriveChecks ---------------------------------------------------------

describe('deriveChecks', () => {
	it('revoked vs live authority parsing', () => {
		const revoked = deriveChecks({
			mint: { mint_authority: { revoked: true, address: null }, freeze_authority: { revoked: true, address: null } },
			holders: null, liquidity: null, meta: null, pump: null,
		});
		expect(revoked.mintAuthorityRevoked).toBe(true);
		expect(revoked.freezeAuthorityRevoked).toBe(true);

		const live = deriveChecks({
			mint: { mint_authority: { revoked: false, address: AUTH }, freeze_authority: { revoked: false, address: AUTH } },
			holders: null, liquidity: null, meta: null, pump: null,
		});
		expect(live.mintAuthorityRevoked).toBe(false);
		expect(live.freezeAuthorityRevoked).toBe(false);
	});

	it('unresolved sections yield null checks, never guesses', () => {
		const c = deriveChecks({ mint: null, holders: null, liquidity: null, meta: null, pump: null });
		expect(c).toEqual({
			mintAuthorityRevoked: null,
			freezeAuthorityRevoked: null,
			metadataMutable: null,
			lpBurnedOrLocked: null,
			liquidityUsd: null,
			topHolderPctFlag: null,
		});
	});

	it('flags concentration on top1 and top10 thresholds', () => {
		const flagged = deriveChecks({
			mint: null, liquidity: null, meta: null, pump: null,
			holders: { top1_pct: TOP1_FLAG_PCT + 1, top5_pct: null, top10_pct: 10, holders_sampled: 20 },
		});
		expect(flagged.topHolderPctFlag).toBe(true);
		const clean = deriveChecks({
			mint: null, liquidity: null, meta: null, pump: null,
			holders: { top1_pct: 5, top5_pct: 10, top10_pct: TOP10_FLAG_PCT - 1, holders_sampled: 20 },
		});
		expect(clean.topHolderPctFlag).toBe(false);
	});

	it('lpBurnedOrLocked is true only for pump.fun-native coins', () => {
		expect(deriveChecks({ mint: null, holders: null, liquidity: null, meta: null, pump: { isPump: true, graduated: true } }).lpBurnedOrLocked).toBe(true);
		expect(deriveChecks({ mint: null, holders: null, liquidity: null, meta: null, pump: null }).lpBurnedOrLocked).toBeNull();
	});
});

// --- deriveRiskLevel: the documented deterministic rule --------------------

describe('deriveRiskLevel — deterministic rule', () => {
	const base = {
		mintAuthorityRevoked: true,
		freezeAuthorityRevoked: true,
		metadataMutable: false,
		lpBurnedOrLocked: true,
		liquidityUsd: 100_000,
		topHolderPctFlag: false,
	};

	it('HIGH on any live authority', () => {
		expect(deriveRiskLevel({ ...base, mintAuthorityRevoked: false }).riskLevel).toBe('high');
		expect(deriveRiskLevel({ ...base, freezeAuthorityRevoked: false }).riskLevel).toBe('high');
	});

	it('HIGH on concentration + thin liquidity combined', () => {
		const r = deriveRiskLevel({ ...base, topHolderPctFlag: true, liquidityUsd: THIN_LIQUIDITY_USD - 1 });
		expect(r.riskLevel).toBe('high');
		expect(r.reasons.join(' ')).toMatch(/thin liquidity/);
	});

	it('MEDIUM on concentration alone, thin liquidity alone, or mutable metadata alone', () => {
		expect(deriveRiskLevel({ ...base, topHolderPctFlag: true }).riskLevel).toBe('medium');
		expect(deriveRiskLevel({ ...base, liquidityUsd: 5_000 }).riskLevel).toBe('medium');
		expect(deriveRiskLevel({ ...base, metadataMutable: true }).riskLevel).toBe('medium');
	});

	it('LOW only when authorities revoked, no concentration, liquidity known + healthy', () => {
		const r = deriveRiskLevel(base);
		expect(r.riskLevel).toBe('low');
		expect(r.reasons).toHaveLength(1);
	});

	it('UNKNOWN when the inputs needed for LOW are unresolved, with reasons naming them', () => {
		const r = deriveRiskLevel({ ...base, mintAuthorityRevoked: null, freezeAuthorityRevoked: null });
		expect(r.riskLevel).toBe('unknown');
		expect(r.reasons.join(' ')).toMatch(/authority status unknown/);
		const noLiq = deriveRiskLevel({ ...base, liquidityUsd: null });
		expect(noLiq.riskLevel).toBe('unknown');
		expect(noLiq.reasons.join(' ')).toMatch(/no liquidity data/);
	});

	it('never returns a level outside the contract', () => {
		for (const v of [true, false, null]) {
			const { riskLevel } = deriveRiskLevel({
				mintAuthorityRevoked: v, freezeAuthorityRevoked: v, metadataMutable: v,
				lpBurnedOrLocked: v, liquidityUsd: v === true ? 50_000 : null, topHolderPctFlag: v,
			});
			expect(['low', 'medium', 'high', 'unknown']).toContain(riskLevel);
		}
	});
});

// --- composeTokenSecurity: states -----------------------------------------

describe('composeTokenSecurity', () => {
	it('full keyless read → ok with all sources and a LOW verdict', async () => {
		const r = await composeTokenSecurity({ address: THREE }, deps());
		expect(r.status).toBe('ok');
		expect(r.sources).toEqual(['solana-rpc', 'dexscreener']);
		expect(r.checks.mintAuthorityRevoked).toBe(true);
		expect(r.checks.metadataMutable).toBe(false);
		expect(r.riskLevel).toBe('low');
	});

	it('live mint authority on a fresh pump coin → HIGH with lp fact from pump.fun', async () => {
		const r = await composeTokenSecurity({ address: THREE }, deps({
			fetchMintAccount: async () => ({ result: mintAccount({ mintAuth: AUTH }) }),
			fetchMarket: async () => null,
			fetchPump: async () => ({ kind: 'ok', coin: { mint: THREE, bonding_curve: 'x', complete: false } }),
		}));
		expect(r.status).toBe('ok');
		expect(r.riskLevel).toBe('high');
		expect(r.checks.lpBurnedOrLocked).toBe(true);
		expect(r.sources).toContain('pumpfun');
	});

	it('RPC down but market up → ok, authority checks null, riskLevel unknown', async () => {
		const r = await composeTokenSecurity({ address: THREE }, deps({
			fetchMintAccount: async () => { throw new Error('rpc down'); },
			fetchLargestAccounts: async () => { throw new Error('rpc down'); },
			fetchMetadataAccount: async () => { throw new Error('rpc down'); },
		}));
		expect(r.status).toBe('ok');
		expect(r.checks.mintAuthorityRevoked).toBeNull();
		expect(r.riskLevel).toBe('unknown');
		expect(r.sources).toEqual(['dexscreener']);
	});

	it('all sources answered, none know the token → not_found', async () => {
		const r = await composeTokenSecurity({ address: AUTH }, deps({
			fetchMintAccount: async () => ({ result: { value: null } }),
			fetchLargestAccounts: async () => ({ error: { message: 'not a Token mint' } }),
			fetchMetadataAccount: async () => ({ result: { value: null } }),
			fetchMarket: async () => null,
			fetchPump: async () => ({ kind: 'not_found' }),
		}));
		expect(r.status).toBe('not_found');
	});

	it('every source down → upstream_down, never a fabricated verdict', async () => {
		const boom = async () => { throw new Error('down'); };
		const r = await composeTokenSecurity({ address: AUTH }, deps({
			fetchMintAccount: boom, fetchLargestAccounts: boom, fetchMetadataAccount: boom,
			fetchMarket: boom, fetchPump: async () => ({ kind: 'upstream_down' }),
		}));
		expect(r.status).toBe('upstream_down');
	});
});
