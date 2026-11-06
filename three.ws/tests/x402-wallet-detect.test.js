// @vitest-environment jsdom
// public/x402.js reads location.origin at import time, so this suite runs under
// a DOM environment.
import { describe, it, expect, afterEach } from 'vitest';

import { detectSolanaProvider, solanaWalletLabel } from '../public/x402.js';

// Regression guard: the x402 drop-in modal must recognize the SAME Solana
// wallets the rest of three.ws does (src/onchain/adapters/solana.js). The
// platform's own embedded wallet (Solana Mobile / Seeker MWA bridge) injects at
// window.threeWsWallet — and mirrors onto window.solana — with isThreeWs=true
// and isPhantom=false. An isPhantom-only detector left those users with a
// disabled "Phantom (not detected)" button: the tip modal opened but there was
// no way to pay a club dancer.

const WALLET_KEYS = ['threeWsWallet', 'solana', 'phantom', 'backpack', 'solflare'];

function clearWallets() {
	for (const k of WALLET_KEYS) delete window[k];
}

afterEach(clearWallets);

describe('detectSolanaProvider — wallet recognition', () => {
	it('returns null when no Solana wallet is injected', () => {
		clearWallets();
		expect(detectSolanaProvider()).toBeNull();
	});

	it('recognizes the three.ws embedded wallet on window.threeWsWallet', () => {
		clearWallets();
		const wallet = { isThreeWs: true, isPhantom: false };
		window.threeWsWallet = wallet;
		expect(detectSolanaProvider()).toBe(wallet);
	});

	it('recognizes the three.ws wallet when only mirrored onto window.solana', () => {
		clearWallets();
		const wallet = { isThreeWs: true, isPhantom: false };
		window.solana = wallet;
		expect(detectSolanaProvider()).toBe(wallet);
	});

	it('prefers the three.ws wallet over a co-present Phantom', () => {
		clearWallets();
		const three = { isThreeWs: true };
		const phantom = { isPhantom: true };
		window.threeWsWallet = three;
		window.solana = phantom;
		expect(detectSolanaProvider()).toBe(three);
	});

	it('still recognizes Phantom when it is the only wallet', () => {
		clearWallets();
		const phantom = { isPhantom: true };
		window.solana = phantom;
		expect(detectSolanaProvider()).toBe(phantom);
	});

	it('recognizes Backpack and Solflare', () => {
		clearWallets();
		const backpack = { solana: { isBackpack: true } };
		window.backpack = backpack;
		expect(detectSolanaProvider()).toBe(backpack.solana);

		clearWallets();
		const solflare = { isSolflare: true };
		window.solflare = solflare;
		expect(detectSolanaProvider()).toBe(solflare);
	});
});

describe('solanaWalletLabel — human-readable wallet name', () => {
	it('names each known wallet', () => {
		expect(solanaWalletLabel({ isThreeWs: true })).toBe('three.ws Wallet');
		expect(solanaWalletLabel({ isPhantom: true })).toBe('Phantom');
		expect(solanaWalletLabel({ isBackpack: true })).toBe('Backpack');
		expect(solanaWalletLabel({ isSolflare: true })).toBe('Solflare');
	});

	it('falls back to a generic label for an unknown or missing provider', () => {
		expect(solanaWalletLabel({})).toBe('Solana wallet');
		expect(solanaWalletLabel(null)).toBe('Solana wallet');
	});
});
