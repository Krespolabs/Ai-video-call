// Cosmetics purchase rail (R22) — turn a "Buy" into a REAL USDC payment.
//
// The shop (R21) handles browsing + live preview; this module handles money.
// purchaseCosmetic() runs the x402 flow against /api/x402/cosmetic-purchase:
// window.X402.pay opens the wallet, settles the USDC on Base or Solana, and the
// endpoint records ownership of the cosmetic to the player's account in the
// durable ledger (api/_lib/cosmetics-ownership.js). It resolves only after the
// server confirms ownership — there is no optimistic unlock — and rejects with a
// wallet-accurate Error (including insufficient funds) on failure. The rail is
// idempotent (single-use on-chain proof + idempotent ownership grant), so a
// retried buy never double-charges.
//
// Ownership is keyed on the player's stable account id: their verified wallet
// when signed in, otherwise the same persisted guest id the /play economy uses
// (`cc-pid`), so a guest purchase survives a refresh on this device.
//
// $THREE is the coin the shop quotes value in; USDC is only the settlement asset
// the rail charges — never surfaced as a coin to hold.

import { loadStoredPass } from './play-auth.js';
import { ensureX402 } from '../shared/x402-loader.js';

const PURCHASE_ENDPOINT = '/api/x402/cosmetic-purchase';
const OWNED_ENDPOINT = '/api/cosmetics/owned';

// Resolve the account a purchase is attached to. Prefers an explicit verified
// wallet (the id the room already carries), then a cached play pass, then the
// persisted guest id. Returns '' only if storage is entirely unavailable.
export function resolveShopAccount(explicitWallet) {
	if (explicitWallet) return explicitWallet;
	try {
		const pass = loadStoredPass();
		if (pass?.wallet) return pass.wallet;
	} catch { /* fall through to guest id */ }
	try {
		let id = localStorage.getItem('cc-pid');
		if (!id) { id = 'guest-' + Math.random().toString(36).slice(2, 12); localStorage.setItem('cc-pid', id); }
		return id;
	} catch {
		return '';
	}
}

// The coin world the player is currently in, from the /play deep link
// (?coin=<mint> survives navigation). '' outside a coin world.
function currentWorldMint() {
	try {
		return new URLSearchParams(window.location.search).get('coin') || '';
	} catch {
		return '';
	}
}

// Run the x402 USDC payment for one cosmetic. Resolves with the settled ticket
// ({ ok, owned, newlyOwned, payer, network, … }); rejects with an Error on
// failure or { code:'cancelled' } when the buyer dismisses the wallet.
export async function purchaseCosmetic(item, { account, coin } = {}) {
	if (!item?.id) throw new Error('Pick a cosmetic to buy.');
	const acct = account || resolveShopAccount();
	if (!acct) throw new Error('No account to attach this purchase to.');

	// First-timers get the wallet/USDC explainer before the payment modal; returning
	// buyers pass straight through. Lazy-loaded so the shop only pays for it on the
	// first buy. A cancel here aborts the purchase; a load failure is non-fatal.
	try {
		const { ensureOnchainPrimer } = await import('../shared/onchain-primer.js');
		if (!(await ensureOnchainPrimer({ action: 'buy' }))) {
			const err = new Error('cancelled'); err.code = 'cancelled'; throw err;
		}
	} catch (err) {
		if (err?.code === 'cancelled') throw err;
		// primer unavailable — proceed to the payment modal anyway.
	}

	// When bought inside a coin's /play world, tie the sale to that coin (R25) so a
	// configurable share of the settled USDC pays out to the coin's creator. The
	// server resolves the creator + share from the mint — the client only declares
	// which world the purchase happened in; it never sets where the money goes.
	// Falls back to the world in the URL (the /play deep link keeps ?coin=<mint>),
	// so the tie holds even when the caller doesn't pass an explicit mint.
	const coinMint = coin || currentWorldMint();
	const coinParam = coinMint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(coinMint)
		? `&coin=${encodeURIComponent(coinMint)}` : '';
	const url = `${PURCHASE_ENDPOINT}?id=${encodeURIComponent(item.id)}&account=${encodeURIComponent(acct)}${coinParam}`;
	// The /play world page doesn't ship the payment widget in its HTML — load it
	// on demand here (cached after the first buy), same as every other in-world
	// paid surface (NPC services, intel kiosk).
	const X402 = await ensureX402();
	const out = await X402.pay({
		endpoint: url,
		method: 'GET',
		merchant: 'three.ws Avatar Shop',
		action: `Unlock ${item.name} — $${item.priceUsdc} USDC`,
	});

	// SIWX re-access (a wallet that already paid) returns the settled body too;
	// either way the server is the source of truth for `owned`.
	const ticket = out?.result;
	if (!ticket?.ok || !ticket?.owned) {
		throw new Error(ticket?.error || 'purchase did not settle');
	}
	return ticket;
}

// The premium cosmetic ids an account owns, from the ledger. Degrades to [] on
// any error so a caller (shop owned-state, R23 inventory) still renders.
export async function fetchOwnedCosmetics(account) {
	const acct = account || resolveShopAccount();
	if (!acct) return [];
	try {
		const res = await fetch(`${OWNED_ENDPOINT}?account=${encodeURIComponent(acct)}`, {
			headers: { accept: 'application/json' },
		});
		if (!res.ok) return [];
		const body = await res.json();
		return Array.isArray(body?.ownedIds) ? body.ownedIds : [];
	} catch {
		return [];
	}
}
