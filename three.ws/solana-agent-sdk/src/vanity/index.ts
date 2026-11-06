// Provably-fair vanity grinding — verifier, sealed-envelope opener, one-call client.
export {
  verifyVanityReceipt,
  verifyReceiptSignature,
  commitToSeed,
  deriveMasterSeed,
  candidateSeed,
  candidateAddress,
  addressMatchesPattern,
  expectedAttempts,
  fetchServiceKey,
  VANITY_PROTOCOL_VERSION,
  THREE_VANITY_SERVICE_KEY,
  THREE_VANITY_WELL_KNOWN,
  THREE_VANITY_ENDPOINT,
} from "./verify.js";
export type {
  VanityReceipt,
  VanityPattern,
  VerifyCheck,
  VerifyResult,
  VerifyOptions,
} from "./verify.js";

export { openSealed, openSealedJson, generateRecipientKeypair, SEALED_ENVELOPE_SCHEME } from "./sealed.js";
export type { SealedEnvelope } from "./sealed.js";

export { grindVerifiedVanity } from "./client.js";
export type { GrindVerifiedResult, GrindVerifiedOptions, SealedBundle } from "./client.js";
