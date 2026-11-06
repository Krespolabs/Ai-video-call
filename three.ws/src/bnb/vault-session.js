/**
 * Buyer session key for the `/vault` page (prompt 12/13).
 *
 * The vault's unlock-key delivery is ECIES over secp256k1 (`vault-crypto.js`)
 * — recovering a wrapped content key requires the recipient's raw private
 * key. A browser-extension wallet (MetaMask/WalletConnect) deliberately never
 * exposes that to a page, so it cannot serve as the vault "buyer" identity
 * directly (see `prompts/bnb-chain/PROGRESS.md`'s prompt-11 entry: "works for
 * an embedded/ephemeral wallet ... a hardware wallet or eth_sign-only signer
 * still works since that's exactly what's used here"). Mirrors the EXACT
 * pattern `src/agora/onchain-presence.js` already established for prompt 16's
 * on-chain presence toggle: a `viem` account generated once in the browser
 * and persisted to `localStorage`, reused as the on-chain signer for every
 * vault action (buy, the unlock-request signature, and the ECIES unwrap).
 *
 * This session key still needs real tBNB to pay `price + relayFee` on `buy()`
 * — MegaFuel's gasless sponsorship (00-CONTEXT) only ever covers the GAS fee,
 * never `msg.value` — so the UI offers a "fund from your wallet" step that
 * sends a plain native-token transfer from the visitor's own connected
 * MetaMask wallet to this session address.
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const STORAGE_KEY = 'three.ws:bnb-vault-buyer-key';

/** Load the persisted session key, or mint + persist a fresh one. Never throws (falls back to a tab-local key in private-browsing mode). */
function loadOrCreateKey() {
	try {
		const existing = localStorage.getItem(STORAGE_KEY);
		if (existing) return existing;
	} catch {
		/* private mode */
	}
	const key = generatePrivateKey();
	try {
		localStorage.setItem(STORAGE_KEY, key);
	} catch {
		/* private mode — key survives for this tab only */
	}
	return key;
}

let _account = null;

/** The buyer's session viem `Account` — created once per page load, persisted across visits. */
export function getVaultSessionAccount() {
	if (!_account) _account = privateKeyToAccount(loadOrCreateKey());
	return _account;
}

/** Raw 0x-hex private key for this session — needed for the client-side ECIES `unwrapKey` step (never leaves the browser). */
export function getVaultSessionPrivateKey() {
	try {
		return localStorage.getItem(STORAGE_KEY) || loadOrCreateKey();
	} catch {
		return loadOrCreateKey();
	}
}

/** Whether a session key already exists (vs. one about to be freshly minted) — used to decide whether to show a "new session" hint. */
export function hasVaultSession() {
	try {
		return !!localStorage.getItem(STORAGE_KEY);
	} catch {
		return false;
	}
}

/** Discard the session key (e.g. a "reset session" affordance) — a fresh visit mints a new one. */
export function resetVaultSession() {
	try {
		localStorage.removeItem(STORAGE_KEY);
	} catch {
		/* private mode */
	}
	_account = null;
}
