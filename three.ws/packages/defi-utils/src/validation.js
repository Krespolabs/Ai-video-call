/**
 * DeFi input validation — EVM address + amount checks ported verbatim from the
 * SperaxOS `defi-utils`, extended with Solana base58 address validation and
 * EVM/Solana discriminators. `validateAddress`/`validateAmount` return a
 * human-readable error string or `null` (null = valid) so callers can surface
 * the message straight to a user; the `is*` helpers return booleans.
 */

import bs58 from 'bs58';

/**
 * Validate an Ethereum address format. Returns an error message, or `null` when
 * the address is well-formed (`0x` + 40 hex chars, any case).
 * @param {string} address
 * @returns {string | null}
 */
export function validateAddress(address) {
	if (!address || !/^0x[\da-f]{40}$/i.test(address)) {
		return 'Invalid wallet address. Expected format: 0x followed by 40 hex characters.';
	}
	return null;
}

/**
 * Validate a positive amount string. Accepts the literal `"max"`
 * (case-insensitive). Returns an error message, or `null` when valid.
 * @param {string} amount
 * @returns {string | null}
 */
export function validateAmount(amount) {
	if (!amount || amount.trim() === '') {
		return 'Amount is required.';
	}
	if (amount.toLowerCase() === 'max') return null;
	const num = Number(amount);
	if (Number.isNaN(num) || num <= 0) {
		return `Invalid amount: "${amount}". Must be a positive number or "max".`;
	}
	return null;
}

/**
 * Validate a Solana address: base58, 32–44 chars, decoding to exactly 32 bytes.
 * Returns an error message, or `null` when valid.
 * @param {string} address
 * @returns {string | null}
 */
export function validateSolanaAddress(address) {
	if (!address || typeof address !== 'string') {
		return 'Invalid Solana address. Expected a base58 string.';
	}
	if (address.length < 32 || address.length > 44) {
		return 'Invalid Solana address. Expected 32–44 base58 characters.';
	}
	let decoded;
	try {
		decoded = bs58.decode(address);
	} catch {
		return 'Invalid Solana address. Contains non-base58 characters.';
	}
	if (decoded.length !== 32) {
		return 'Invalid Solana address. Must decode to 32 bytes.';
	}
	return null;
}

/**
 * True when the input is a well-formed EVM address (`0x` + 40 hex chars).
 * @param {string} address
 * @returns {boolean}
 */
export const isEvmAddress = (address) => validateAddress(address) === null;

/**
 * True when the input is a well-formed Solana address (base58, 32 bytes).
 * @param {string} address
 * @returns {boolean}
 */
export const isSolanaAddress = (address) => validateSolanaAddress(address) === null;
