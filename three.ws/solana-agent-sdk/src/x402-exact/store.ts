/**
 * Durable storage abstractions for the x402 "exact" facilitator.
 *
 * Two concerns:
 *   1. ChallengeStore — server-issued, single-use payment challenges (nonce +
 *      resource binding + expiry) that the client must echo back inside the
 *      paid transaction (as a memo). Binds a proof to one specific request.
 *   2. ConsumedSignatureStore — a durable record of transaction signatures that
 *      have already settled a request, so the same on-chain payment can never
 *      settle a second request (replay protection).
 *
 * The in-memory implementations below are correct for a single process. In a
 * multi-instance / serverless deployment, pass a Redis- or database-backed
 * implementation of the same interfaces to ExactFacilitator so the guarantees
 * hold across instances and restarts.
 */

/** A server-issued, single-use payment challenge bound to one resource. */
export interface PaymentChallenge {
  /** Opaque high-entropy nonce the client must carry in the tx memo. */
  nonce: string;
  /** Resource the payment unlocks (e.g. the request URL/path). */
  resource: string;
  /** Token mint (base58) the payment must use. */
  asset: string;
  /** Amount in base units the payment must transfer. */
  amount: string;
  /** Recipient wallet (base58) the payment must credit. */
  payTo: string;
  /** Unix ms after which the challenge is no longer valid. */
  expiresAt: number;
}

/** Stores issued challenges, keyed by nonce, with single-use consumption. */
export interface ChallengeStore {
  put(challenge: PaymentChallenge): Promise<void>;
  get(nonce: string): Promise<PaymentChallenge | null>;
  /** Atomically mark a challenge consumed. Returns false if already consumed/absent. */
  consume(nonce: string): Promise<boolean>;
}

/** Records consumed transaction signatures to reject any replay. */
export interface ConsumedSignatureStore {
  /**
   * Atomically claim a signature for a resource. Returns true on first claim,
   * false if the signature was already consumed (replay).
   */
  claim(signature: string, resource: string): Promise<boolean>;
  has(signature: string): Promise<boolean>;
}

interface ExpiringChallenge extends PaymentChallenge {
  consumed: boolean;
}

/** Default in-memory ChallengeStore. Single-process only. */
export class InMemoryChallengeStore implements ChallengeStore {
  private readonly map = new Map<string, ExpiringChallenge>();

  async put(challenge: PaymentChallenge): Promise<void> {
    this.prune();
    this.map.set(challenge.nonce, { ...challenge, consumed: false });
  }

  async get(nonce: string): Promise<PaymentChallenge | null> {
    const entry = this.map.get(nonce);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.map.delete(nonce);
      return null;
    }
    const { consumed: _consumed, ...challenge } = entry;
    return challenge;
  }

  async consume(nonce: string): Promise<boolean> {
    const entry = this.map.get(nonce);
    if (!entry || entry.consumed || entry.expiresAt < Date.now()) return false;
    entry.consumed = true;
    return true;
  }

  private prune(): void {
    if (this.map.size < 10_000) return;
    const now = Date.now();
    for (const [nonce, entry] of this.map) {
      if (entry.expiresAt < now) this.map.delete(nonce);
    }
  }
}

/** Default in-memory ConsumedSignatureStore. Single-process only. */
export class InMemoryConsumedSignatureStore implements ConsumedSignatureStore {
  private readonly seen = new Set<string>();

  async claim(signature: string): Promise<boolean> {
    if (this.seen.has(signature)) return false;
    this.seen.add(signature);
    return true;
  }

  async has(signature: string): Promise<boolean> {
    return this.seen.has(signature);
  }
}
