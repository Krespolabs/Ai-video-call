// @ts-check
// Back-an-Agent Vaults — real Jupiter swaps + mark-to-market.
//
// A USDC-denominated vault deploys capital by swapping USDC → token and harvests
// it back token → USDC. Both legs are REAL Jupiter v1 swaps (the same lite-api
// endpoint and signing path api/_lib/wallet-intents.js uses for the autopilot's
// buys) — no synthetic prices, no fake fills. NAV marks open positions to market
// with a live token → USDC quote, so the share price a backer sees is what the
// holdings are actually worth right now.

import { PublicKey } from '@solana/web3.js';

const JUPITER_BASE = 'https://lite-api.jup.ag/swap/v1';

export const USDC_MINT_BY_NETWORK = {
	mainnet: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
	devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
};
export const USDC_DECIMALS = 6;

function usdcMint(network) {
	return network === 'devnet' ? USDC_MINT_BY_NETWORK.devnet : USDC_MINT_BY_NETWORK.mainnet;
}

async function fetchWithTimeout(url, opts = {}, ms = 15_000) {
	const ctrl = new AbortController();
	const t = setTimeout(() => ctrl.abort(), ms);
	try {
		return await fetch(url, { ...opts, signal: ctrl.signal });
	} finally {
		clearTimeout(t);
	}
}

/**
 * A Jupiter ExactIn quote. Returns the parsed quote object (with `outAmount`,
 * `priceImpactPct`, route plan) or throws a structured error so the trade path can
 * surface a clean 4xx/502.
 * @param {object} a
 * @param {string} a.inputMint
 * @param {string} a.outputMint
 * @param {bigint} a.amountRaw  input amount in the input mint's base units
 * @param {number} a.slippageBps
 */
export async function jupQuote({ inputMint, outputMint, amountRaw, slippageBps }) {
	const amount = BigInt(amountRaw);
	if (amount <= 0n) throw Object.assign(new Error('amount rounds to zero'), { code: 'zero_amount' });
	const url = `${JUPITER_BASE}/quote?inputMint=${inputMint}&outputMint=${outputMint}`
		+ `&amount=${amount.toString()}&slippageBps=${Math.max(0, Math.round(slippageBps))}&swapMode=ExactIn`;
	const res = await fetchWithTimeout(url, {}, 15_000);
	if (!res.ok) throw Object.assign(new Error(`no swap route (${res.status})`), { code: 'no_route' });
	const quote = await res.json();
	if (!quote?.outAmount) throw Object.assign(new Error('no swap route for this pair'), { code: 'no_route' });
	return quote;
}

/**
 * Build a signed-ready Jupiter swap VersionedTransaction for `quote`, owned by
 * `userPublicKey`. The caller signs + submits it (vault-trade.js), so this never
 * touches a key.
 */
export async function buildSwapTx({ quote, userPublicKey }) {
	const { VersionedTransaction } = await import('@solana/web3.js');
	const res = await fetchWithTimeout(`${JUPITER_BASE}/swap`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			quoteResponse: quote,
			userPublicKey: typeof userPublicKey === 'string' ? userPublicKey : userPublicKey.toBase58(),
			wrapAndUnwrapSol: true,
			dynamicComputeUnitLimit: true,
			prioritizationFeeLamports: 'auto',
		}),
	}, 20_000);
	if (!res.ok) throw Object.assign(new Error(`swap build failed (${res.status})`), { code: 'swap_failed' });
	const { swapTransaction } = await res.json();
	if (!swapTransaction) throw Object.assign(new Error('swap build returned no transaction'), { code: 'swap_failed' });
	return VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
}

/**
 * Quote a buy: how many token base units `usdcAtomics` of USDC buys, plus impact.
 * @returns {Promise<{ quote:object, expectedOutRaw:bigint, priceImpactPct:number, inputMint:string, outputMint:string }>}
 */
export async function quoteBuy({ network, mint, usdcAtomics, slippageBps }) {
	const inputMint = usdcMint(network);
	const quote = await jupQuote({ inputMint, outputMint: mint, amountRaw: usdcAtomics, slippageBps });
	return {
		quote,
		expectedOutRaw: BigInt(quote.outAmount),
		priceImpactPct: Number(quote.priceImpactPct ?? 0),
		inputMint, outputMint: mint,
	};
}

/**
 * Quote a sell: how much USDC `amountRaw` token base units fetches, plus impact.
 * @returns {Promise<{ quote:object, expectedOutAtomics:bigint, priceImpactPct:number, inputMint:string, outputMint:string }>}
 */
export async function quoteSell({ network, mint, amountRaw, slippageBps }) {
	const outputMint = usdcMint(network);
	const quote = await jupQuote({ inputMint: mint, outputMint, amountRaw, slippageBps });
	return {
		quote,
		expectedOutAtomics: BigInt(quote.outAmount),
		priceImpactPct: Number(quote.priceImpactPct ?? 0),
		inputMint: mint, outputMint,
	};
}

/**
 * Mark a holding to market: the USDC atomics `amountRaw` base units of `mint` would
 * fetch right now (zero-slippage reference quote). Returns null if it can't be
 * priced — callers treat that as "exclude from NAV this tick", never as zero, so a
 * transient Jupiter hiccup never fabricates a loss that could trip the breaker.
 */
export async function markToUsdc({ network, mint, amountRaw }) {
	const amount = BigInt(amountRaw || 0n);
	if (amount <= 0n) return 0n;
	try {
		const quote = await jupQuote({ inputMint: mint, outputMint: usdcMint(network), amountRaw: amount, slippageBps: 0 });
		return BigInt(quote.outAmount);
	} catch {
		return null;
	}
}

/** Validate a mint is a syntactically valid Solana address; returns the base58 or null. */
export function validateMint(mint) {
	try {
		return new PublicKey(String(mint)).toBase58();
	} catch {
		return null;
	}
}
