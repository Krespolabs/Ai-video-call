/**
 * Chain & token constants — single source of truth for chain IDs, native
 * tokens, common token addresses, and ERC-20 ABI fragments across the EVM
 * chains three.ws touches, plus a Solana section (mints + native pseudo-mint).
 *
 * Ported from the SperaxOS `defi-utils` library and extended with Solana, which
 * SperaxOS lacks and three.ws needs. EVM maps are kept verbatim; the Sperax
 * tokens (SPA, USDs on Arbitrum) are the integration constants that motivated
 * the port. Zero runtime dependencies here — the base58 work lives in
 * `validation.js`.
 */

// ============================================================================
// Chain IDs
// ============================================================================

/**
 * Canonical chain name → EVM chain ID.
 * @type {Record<string, number>}
 */
export const CHAIN_IDS = {
	arbitrum: 42_161,
	avalanche: 43_114,
	base: 8453,
	bsc: 56,
	ethereum: 1,
	gnosis: 100,
	optimism: 10,
	polygon: 137,
	sonic: 146,
};

/**
 * Resolve a chain name (case-insensitive) to its EVM chain ID. Defaults to
 * Arbitrum (42161) for unknown names — matching the SperaxOS source.
 * @param {string} chain
 * @returns {number}
 */
export const getChainId = (chain) => CHAIN_IDS[chain.toLowerCase()] ?? 42_161;

// ============================================================================
// Native gas token symbols per chain
// ============================================================================

/**
 * EVM chain ID → native gas-token symbol.
 * @type {Record<number, string>}
 */
export const NATIVE_TOKENS = {
	1: 'ETH',
	10: 'ETH',
	56: 'BNB',
	100: 'xDAI',
	137: 'MATIC',
	146: 'S',
	8453: 'ETH',
	42_161: 'ETH',
	43_114: 'AVAX',
};

/**
 * Native gas-token symbol for a chain. Defaults to 'ETH'.
 * @param {number} chainId
 * @returns {string}
 */
export const getNativeToken = (chainId) => NATIVE_TOKENS[chainId] ?? 'ETH';

// ============================================================================
// Native token aliases
// ============================================================================

const NATIVE_ALIASES = new Set(['ETH', 'BNB', 'MATIC', 'AVAX', 'FTM', 'xDAI', 'S']);

/**
 * True when a symbol represents a native (non-ERC-20) gas token. Checks both an
 * upper-cased form and the raw symbol so mixed-case aliases like `xDAI` match.
 * @param {string} symbol
 * @returns {boolean}
 */
export const isNativeToken = (symbol) =>
	NATIVE_ALIASES.has(symbol.toUpperCase()) || NATIVE_ALIASES.has(symbol);

// ============================================================================
// Common token addresses per chain (EVM)
// ============================================================================

/**
 * EVM chain ID → token symbol (upper-case) → contract address.
 * @type {Record<number, Record<string, string>>}
 */
export const TOKEN_ADDRESSES = {
	// Ethereum Mainnet
	1: {
		DAI: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
		LINK: '0x514910771AF9Ca656af840dff83E8264EcF986CA',
		UNI: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984',
		USDC: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
		USDT: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
		WBTC: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599',
		WETH: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
	},
	// Optimism
	10: {
		DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
		OP: '0x4200000000000000000000000000000000000042',
		USDC: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
		USDT: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
		WETH: '0x4200000000000000000000000000000000000006',
	},
	// BNB Chain
	56: {
		BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',
		CAKE: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
		USDC: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
		USDT: '0x55d398326f99059fF775485246999027B3197955',
		WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
	},
	// Polygon
	137: {
		DAI: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
		USDC: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
		USDT: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
		WETH: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
		WMATIC: '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
	},
	// Base
	8453: {
		DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
		USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
		WETH: '0x4200000000000000000000000000000000000006',
	},
	// Arbitrum — carries the Sperax integration tokens (SPA, USDs).
	42_161: {
		ARB: '0x912CE59144191C1204E64559FE8253a0e49E6548',
		DAI: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
		GMX: '0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a',
		SPA: '0x5575552988A3A80504bBaeB1311674fCFd40aD4B',
		USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
		'USDC.e': '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
		USDT: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
		USDs: '0xD74f5255D557944cf7Dd0E45FF521520002D5748',
		WBTC: '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f',
		WETH: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
	},
	// Avalanche
	43_114: {
		DAI: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
		USDC: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
		USDT: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
		WAVAX: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
		WETH: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
	},
};

/**
 * Resolve a token symbol to its contract address on a given EVM chain. If the
 * input already looks like an address (`0x` + 40 hex chars) it is returned
 * as-is. Symbol lookup is case-insensitive — some map keys are intentionally
 * mixed-case for display (`USDs`, `USDC.e`), so this matches on the
 * upper-cased form of both sides rather than assuming keys are pre-uppercased.
 * Returns `undefined` when unknown.
 * @param {string} symbol
 * @param {number} chainId
 * @returns {string | undefined}
 */
export const resolveTokenAddress = (symbol, chainId) => {
	if (symbol.startsWith('0x') && symbol.length === 42) return symbol;
	const tokens = TOKEN_ADDRESSES[chainId];
	if (!tokens) return undefined;
	const upper = symbol.toUpperCase();
	const key = Object.keys(tokens).find((candidate) => candidate.toUpperCase() === upper);
	return key ? tokens[key] : undefined;
};

// ============================================================================
// Solana section (three.ws extension — not in the SperaxOS source)
// ============================================================================

/**
 * Solana mint addresses. `SOL` is the wrapped-SOL native pseudo-mint used by
 * SPL tooling; `THREE` is the platform's promoted coin.
 * @type {Record<string, string>}
 */
export const SOLANA_MINTS = {
	SOL: 'So11111111111111111111111111111111111111112',
	USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	THREE: 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump',
};

/**
 * Resolve a Solana token symbol (case-insensitive) to its mint. If the input
 * already looks like a base58 mint (32–44 chars, no `0x`) it is returned as-is.
 * Returns `undefined` for unknown symbols.
 * @param {string} symbol
 * @returns {string | undefined}
 */
export const resolveSolanaMint = (symbol) => {
	if (!symbol) return undefined;
	if (!symbol.startsWith('0x') && symbol.length >= 32 && symbol.length <= 44) return symbol;
	return SOLANA_MINTS[symbol.toUpperCase()];
};

// ============================================================================
// Minimal ERC-20 ABI fragments
// ============================================================================

/**
 * The read/write ERC-20 fragments three.ws actually calls: `symbol`,
 * `decimals`, `balanceOf`, `transfer`, `approve`, `allowance`.
 */
export const ERC20_ABI = [
	{
		inputs: [],
		name: 'symbol',
		outputs: [{ internalType: 'string', name: '', type: 'string' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [],
		name: 'decimals',
		outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
		name: 'balanceOf',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'address', name: 'to', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'transfer',
		outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'address', name: 'spender', type: 'address' },
			{ internalType: 'uint256', name: 'amount', type: 'uint256' },
		],
		name: 'approve',
		outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
		stateMutability: 'nonpayable',
		type: 'function',
	},
	{
		inputs: [
			{ internalType: 'address', name: 'owner', type: 'address' },
			{ internalType: 'address', name: 'spender', type: 'address' },
		],
		name: 'allowance',
		outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
		stateMutability: 'view',
		type: 'function',
	},
];
