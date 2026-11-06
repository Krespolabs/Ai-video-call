import { describe, it, expect } from 'vitest';
import { classifyLaunchQuote, usdcMintFor, WSOL_MINT } from '../api/_lib/pump-quote.js';
import { SOLANA_USDC_MINT, SOLANA_USDC_MINT_DEVNET } from '../api/payments/_config.js';

const SYSTEM_DEFAULT = '11111111111111111111111111111111';
// A non-USDC, non-SOL stable/other quote mint — clearly-synthetic placeholder.
const OTHER_MINT = 'THREEsynthetic1111111111111111111111111111';

describe('usdcMintFor', () => {
	it('returns the mainnet USDC mint by default', () => {
		expect(usdcMintFor('mainnet')).toBe(SOLANA_USDC_MINT);
		expect(usdcMintFor()).toBe(SOLANA_USDC_MINT);
	});
	it('returns the devnet USDC mint on devnet', () => {
		expect(usdcMintFor('devnet')).toBe(SOLANA_USDC_MINT_DEVNET);
	});
});

describe('classifyLaunchQuote', () => {
	it('treats null/undefined/empty as SOL-paired', () => {
		for (const q of [null, undefined, '', '   ']) {
			expect(classifyLaunchQuote({ quoteMint: q })).toEqual({
				isUsdc: false,
				quoteMint: null,
				label: 'SOL',
			});
		}
	});

	it('treats wSOL and the system default pubkey as SOL-paired (canonicalized to null)', () => {
		expect(classifyLaunchQuote({ quoteMint: WSOL_MINT })).toEqual({
			isUsdc: false,
			quoteMint: null,
			label: 'SOL',
		});
		expect(classifyLaunchQuote({ quoteMint: SYSTEM_DEFAULT })).toEqual({
			isUsdc: false,
			quoteMint: null,
			label: 'SOL',
		});
	});

	it('classifies the network USDC mint as USDC-paired', () => {
		expect(classifyLaunchQuote({ quoteMint: SOLANA_USDC_MINT, network: 'mainnet' })).toEqual({
			isUsdc: true,
			quoteMint: SOLANA_USDC_MINT,
			label: 'USDC',
		});
		expect(classifyLaunchQuote({ quoteMint: SOLANA_USDC_MINT_DEVNET, network: 'devnet' })).toEqual({
			isUsdc: true,
			quoteMint: SOLANA_USDC_MINT_DEVNET,
			label: 'USDC',
		});
	});

	it('labels a non-SOL, non-USDC quote as a generic TOKEN pair but still isUsdc/stable', () => {
		const r = classifyLaunchQuote({ quoteMint: OTHER_MINT, network: 'mainnet' });
		expect(r.isUsdc).toBe(true);
		expect(r.quoteMint).toBe(OTHER_MINT);
		expect(r.label).toBe('TOKEN');
	});

	it('trims surrounding whitespace before classifying', () => {
		expect(classifyLaunchQuote({ quoteMint: `  ${SOLANA_USDC_MINT}  ` }).quoteMint).toBe(
			SOLANA_USDC_MINT,
		);
	});

	it('does not treat the mainnet USDC mint as USDC when network is devnet (mint mismatch → TOKEN)', () => {
		// Guards against cross-network mislabeling: the mainnet USDC mint on a
		// devnet launch is a non-canonical stable, so it labels as TOKEN.
		const r = classifyLaunchQuote({ quoteMint: SOLANA_USDC_MINT, network: 'devnet' });
		expect(r.isUsdc).toBe(true);
		expect(r.label).toBe('TOKEN');
	});
});
