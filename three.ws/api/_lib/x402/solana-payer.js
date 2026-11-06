// api/_lib/x402/solana-payer.js
//
// Compatibility alias for the canonical Solana x402 payment helpers in pay.js.
// Some autonomous-loop pipelines import the payment primitives
// (loadSeedKeypair, payX402, buildPaymentTx, …) under this module name; pay.js
// is the single source of truth for the implementation. Re-exporting here keeps
// both import paths valid without duplicating the signing/settlement logic.
export * from './pay.js';
