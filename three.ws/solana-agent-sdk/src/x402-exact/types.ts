/** Re-usable subset of x402 v2 types for the "exact" scheme. */

export interface ExactPaymentRequirements {
  scheme: "exact";
  network: string;
  /** SPL token mint address (base58) */
  asset: string;
  /** Amount in token base units (string) */
  amount: string;
  /** Recipient wallet address (base58) */
  payTo: string;
  /** Max seconds to wait for settlement */
  maxTimeoutSeconds: number;
  /** Resource the payment unlocks (request URL/path). Bound to the challenge. */
  resource?: string;
  /**
   * Scheme-specific extension fields. For the "exact" scheme this carries the
   * server-issued single-use challenge `nonce` the client must echo back inside
   * the paid transaction as a memo (see `x402NonceMemo`).
   */
  extra?: { nonce?: string } & Record<string, unknown>;
}

export interface ExactPaymentProof {
  /** Confirmed transaction signature (base58) */
  signature: string;
  /** CAIP-2 network identifier */
  network: string;
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction?: string;
  network?: string;
}

/** Well-known CAIP-2 identifiers */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/**
 * Full base58 genesis hashes per cluster. The CAIP-2 reference for Solana is
 * the first 32 characters of the genesis hash; `getGenesisHash()` returns the
 * full value, so we map full → CAIP-2 to validate the configured RPC cluster.
 */
export const SOLANA_MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp7zdFc5R8XYpN";
export const SOLANA_DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const SOLANA_TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
export const SOLANA_TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

/** Maps a full genesis hash (from `getGenesisHash()`) to its CAIP-2 id. */
export const CAIP2_BY_GENESIS_HASH: Record<string, string> = {
  [SOLANA_MAINNET_GENESIS]: SOLANA_MAINNET,
  [SOLANA_DEVNET_GENESIS]: SOLANA_DEVNET,
  [SOLANA_TESTNET_GENESIS]: SOLANA_TESTNET,
};

/**
 * Memo prefix the client prepends to the challenge nonce when paying. The
 * facilitator matches `${X402_NONCE_MEMO_PREFIX}${nonce}` against the tx memo.
 */
export const X402_NONCE_MEMO_PREFIX = "x402:";

/** Build the exact memo string a payer must include for a given challenge nonce. */
export function x402NonceMemo(nonce: string): string {
  return `${X402_NONCE_MEMO_PREFIX}${nonce}`;
}

/** USDC mint addresses */
export const USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
