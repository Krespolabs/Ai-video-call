/**
 * The three.ws on-chain brand mark — single source of truth.
 *
 * Owns the mint-mark string, the grind config that produces it, and the
 * functions that test/assert an address carries it. Every other module
 * imports from here; no other file hardcodes the mark or re-implements the
 * check. Pure address plumbing — references no coin, by construction.
 */

/** The three.ws on-chain mint mark. Every branded launch's mint address starts with this. */
export const THREE_WS_MARK = '3ws';

/**
 * Grind config for the brand mark. Spread into grindVanity / grindVanityNode.
 * Prefix (leads the truncated address) + case-insensitive (keeps the grind sub-second).
 * @type {Readonly<{ prefix: string, suffix: string, ignoreCase: boolean }>}
 */
export const THREE_WS_VANITY = Object.freeze({
	prefix: THREE_WS_MARK,
	suffix: '',
	ignoreCase: true,
});

/**
 * True when a Base58 mint address carries the three.ws mark (case-insensitive prefix).
 * Isomorphic — safe in both Node API handlers and browser bundles.
 * @param {unknown} address
 * @returns {boolean}
 */
export function hasThreeWsMark(address) {
	if (typeof address !== 'string' || address.length < THREE_WS_MARK.length) return false;
	return address.slice(0, THREE_WS_MARK.length).toLowerCase() === THREE_WS_MARK.toLowerCase();
}

/**
 * Throw a typed error if `address` lacks the mark. Use at trust boundaries
 * (API handlers) to fail-closed on an unbranded supplied mint.
 * @param {unknown} address
 * @throws {UnbrandedMintError}
 */
export function assertThreeWsMark(address) {
	if (!hasThreeWsMark(address)) throw new UnbrandedMintError(address);
}

/** Thrown when a mint address does not carry the three.ws mark. */
export class UnbrandedMintError extends Error {
	constructor(address) {
		super(`mint ${String(address).slice(0, 12)}… does not carry the three.ws "${THREE_WS_MARK}" mark`);
		this.name = 'UnbrandedMintError';
		this.code = 'unbranded_mint';
		this.address = address;
	}
}
