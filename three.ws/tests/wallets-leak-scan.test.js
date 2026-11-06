import { describe, it, expect } from 'vitest';
import { isScannableSpec, dedupeWallets } from '../api/cron/wallets-leak-scan.js';

// The general leak scanner watches every mainnet controlled wallet. These pin
// the wallet-selection rules: mainnet-only, and one scan per pubkey even when
// two registry specs (fallback envs) resolve to the same wallet.

describe('isScannableSpec', () => {
	it('scans mainnet + unspecified-network signers', () => {
		expect(isScannableSpec({ name: 'a', network: 'mainnet' })).toBe(true);
		expect(isScannableSpec({ name: 'b' })).toBe(true); // network defaults to mainnet elsewhere
	});
	it('skips devnet signers (no real funds)', () => {
		expect(isScannableSpec({ name: 'c', network: 'devnet' })).toBe(false);
	});
	it('is safe on nullish', () => {
		expect(isScannableSpec(null)).toBe(false);
		expect(isScannableSpec(undefined)).toBe(false);
	});
});

describe('dedupeWallets', () => {
	it('collapses two specs pointing at the same wallet', () => {
		const out = dedupeWallets([
			{ pubkey: 'W1', name: 'ring-payer' },
			{ pubkey: 'W1', name: 'agent-fallback' }, // same wallet via fallback env
			{ pubkey: 'W2', name: 'sponsor' },
		]);
		expect(out).toEqual([
			{ pubkey: 'W1', name: 'ring-payer' }, // first name wins
			{ pubkey: 'W2', name: 'sponsor' },
		]);
	});
	it('drops entries without a pubkey and handles empty input', () => {
		expect(dedupeWallets([{ name: 'x' }, null, { pubkey: '', name: 'y' }])).toEqual([]);
		expect(dedupeWallets([])).toEqual([]);
		expect(dedupeWallets(undefined)).toEqual([]);
	});
});
