/**
 * @three-ws/defi-utils — shared DeFi constants & helpers
 *
 * Single source of truth for chain IDs, native tokens, token addresses, ERC-20
 * ABI fragments, and address/amount validation + formatting across EVM chains
 * and Solana. Import from here instead of duplicating chain/token constants in
 * individual packages and API handlers.
 *
 * @example
 * import { getChainId, resolveTokenAddress, isSolanaAddress, fmtUsd } from '@three-ws/defi-utils';
 * getChainId('arbitrum');                       // 42161
 * resolveTokenAddress('USDs', 42161);           // '0xD74f5255…'
 * isSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // true
 * fmtUsd(1234.5);                                // '$1,234.50'
 */

export {
	CHAIN_IDS,
	ERC20_ABI,
	NATIVE_TOKENS,
	SOLANA_MINTS,
	TOKEN_ADDRESSES,
	getChainId,
	getNativeToken,
	isNativeToken,
	resolveSolanaMint,
	resolveTokenAddress,
} from './chains.js';

export {
	isEvmAddress,
	isSolanaAddress,
	validateAddress,
	validateAmount,
	validateSolanaAddress,
} from './validation.js';

export { fmtAmount, fmtPct, fmtUsd } from './format.js';
