/**
 * BrowserWalletProvider — server-side half of the browser wallet bridge.
 *
 * The agent calls signAndSendTransaction() as normal. Internally this creates a
 * pending request that the browser can pick up, sign with Phantom/Solflare, and
 * submit back. The Promise resolves once the browser returns the signed tx.
 *
 * Call setNextMeta() before any action to attach a human-readable description
 * to the pending tx — the browser can show a confirmation card before the
 * wallet prompt appears.
 *
 * Mount createHandler() on any HTTP path (e.g. GET/POST /api/wallet/...).
 * Point BrowserWalletClient (browser-client.ts) at the same base URL.
 */
import { EventEmitter } from "events";
import { createPublicKey, verify as cryptoVerify } from "crypto";
import {
  PublicKey,
  Transaction,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import type { MetaAwareWallet, TxMetadata } from "./types.js";
import { TransactionRejectedError } from "../errors.js";

export interface PendingTx {
  id: string;
  transaction: string;
  versioned: boolean;
  createdAt: number;
  meta?: TxMetadata;
}

/** Internal record: the public PendingTx plus the original message bytes we issued. */
interface PendingEntry extends PendingTx {
  /** Compiled message bytes of the requested tx, for tamper detection. */
  messageBytes: Uint8Array;
}

export interface BrowserWalletOptions {
  publicKey: PublicKey | string;
  sessionId?: string;
  timeoutMs?: number;
}

export class BrowserWalletProvider implements MetaAwareWallet {
  readonly publicKey: PublicKey;
  readonly sessionId: string;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingEntry>();
  private readonly emitter = new EventEmitter();
  private nextMeta: TxMetadata | null = null;

  constructor(opts: BrowserWalletOptions) {
    this.publicKey =
      typeof opts.publicKey === "string"
        ? new PublicKey(opts.publicKey)
        : opts.publicKey;
    this.sessionId = opts.sessionId ?? crypto.randomUUID();
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  /**
   * Attach metadata to the next transaction this provider signs.
   * Consumed once — subsequent calls without setting it again won't carry metadata.
   *
   * Call this immediately before the action that triggers a transaction:
   *   walletProvider.setNextMeta({ label: "Swap SOL → USDC", kind: "swap", ... });
   *   await agent.swap(...);
   */
  setNextMeta(meta: TxMetadata): void {
    this.nextMeta = meta;
  }

  private async _sign<T extends Transaction | VersionedTransaction>(tx: T, id: string): Promise<T> {
    const versioned = !(tx instanceof Transaction);
    const messageBytes = compiledMessageBytes(tx);
    const serialized = Buffer.from(
      tx instanceof Transaction
        ? tx.serialize({ requireAllSignatures: false })
        : tx.serialize(),
    ).toString("base64");

    const meta = this.nextMeta ?? undefined;
    this.nextMeta = null;

    this.pending.set(id, {
      id,
      transaction: serialized,
      versioned,
      createdAt: Date.now(),
      meta,
      messageBytes,
    });
    this.emitter.emit("pending", toPublic(this.pending.get(id)!));

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new TransactionRejectedError("Timed out waiting for user approval"));
      }, this.timeoutMs);

      this.emitter.once(`signed:${id}`, (signedBase64: string) => {
        clearTimeout(timer);
        this.pending.delete(id);

        let signed: Transaction | VersionedTransaction;
        try {
          const buf = Buffer.from(signedBase64, "base64");
          signed = versioned
            ? VersionedTransaction.deserialize(buf)
            : Transaction.from(buf);
        } catch {
          reject(new TransactionRejectedError("Returned transaction could not be decoded"));
          return;
        }

        // The browser must return a signature over the EXACT transaction we
        // asked it to sign — not a substituted one. Compare compiled message
        // bytes and verify the expected signer's signature over them.
        const returnedBytes = compiledMessageBytes(signed);
        if (!buffersEqual(returnedBytes, messageBytes)) {
          reject(new TransactionRejectedError("Returned transaction does not match the requested transaction"));
          return;
        }
        if (!this.verifyOwnerSignature(signed, returnedBytes)) {
          reject(new TransactionRejectedError("Returned transaction is not validly signed by the wallet"));
          return;
        }

        resolve(signed as T);
      });

      this.emitter.once(`rejected:${id}`, () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new TransactionRejectedError("User rejected"));
      });
    });
  }

  /** Verify the expected wallet pubkey has a valid ed25519 signature over the message. */
  private verifyOwnerSignature(
    tx: Transaction | VersionedTransaction,
    messageBytes: Uint8Array,
  ): boolean {
    const expected = this.publicKey.toBase58();
    let signature: Uint8Array | null = null;

    if (tx instanceof Transaction) {
      const sig = tx.signatures.find((s) => s.publicKey.toBase58() === expected);
      signature = sig?.signature ?? null;
    } else {
      const idx = tx.message.staticAccountKeys.findIndex((k) => k.toBase58() === expected);
      const raw = idx >= 0 ? tx.signatures[idx] : undefined;
      // An all-zero signature slot means "not signed".
      if (raw && raw.some((b) => b !== 0)) signature = raw;
    }

    if (!signature || signature.length !== 64) return false;

    try {
      const keyDer = Buffer.concat([ED25519_SPKI_PREFIX, this.publicKey.toBuffer()]);
      const keyObject = createPublicKey({ key: keyDer, format: "der", type: "spki" });
      return cryptoVerify(null, Buffer.from(messageBytes), keyObject, Buffer.from(signature));
    } catch {
      return false;
    }
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    return this._sign(tx, crypto.randomUUID());
  }

  async signAndSendTransaction(tx: Transaction | VersionedTransaction, connection: Connection): Promise<string> {
    const id = crypto.randomUUID();
    const signed = await this._sign(tx, id);
    const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    await connection.confirmTransaction(sig, "confirmed");
    this.emitter.emit(`confirmed:${id}`, sig);
    return sig;
  }

  getPending(): PendingTx[] {
    return Array.from(this.pending.values(), toPublic);
  }

  submitSigned(txId: string, signedBase64: string): void {
    this.emitter.emit(`signed:${txId}`, signedBase64);
  }

  submitRejected(txId: string): void {
    this.emitter.emit(`rejected:${txId}`);
  }

  /**
   * Subscribe to new pending tx events (for SSE streaming).
   * Returns an unsubscribe function.
   */
  onPending(listener: (tx: PendingTx) => void): () => void {
    this.emitter.on("pending", listener);
    return () => this.emitter.off("pending", listener);
  }

  /**
   * Validate that a request carries this provider's session id. The session id
   * is the shared secret that binds these endpoints to the legitimate wallet
   * owner — without it, anyone who learns a (guessable) tx id could sign/reject.
   * The id is read from the `x-wallet-session` header or, for EventSource which
   * cannot set headers, the `session` query parameter.
   */
  private isAuthorized(req: Request, url: URL): boolean {
    const provided =
      req.headers.get("x-wallet-session") ?? url.searchParams.get("session") ?? "";
    return constantTimeEquals(provided, this.sessionId);
  }

  /**
   * Returns a fetch-API Request handler. Mount it in your server:
   *
   *   GET  {base}/pending          → list all current pending txs
   *   GET  {base}/stream           → SSE stream of new pending txs
   *   POST {base}/sign/:id         → body: { signedTransaction: base64 }
   *   POST {base}/reject/:id       → user rejected
   *
   * Every request must carry the provider's `sessionId` (header
   * `x-wallet-session`, or `?session=` for the SSE stream). Requests without it
   * are rejected with 401 so only the legitimate wallet owner can drive signing.
   */
  createHandler(base = ""): (req: Request) => Promise<Response> {
    return async (req: Request) => {
      const url = new URL(req.url);
      const path = url.pathname.replace(base, "").replace(/^\//, "");
      const [action, id] = path.split("/");

      if (!this.isAuthorized(req, url)) {
        return new Response("Unauthorized", { status: 401 });
      }

      // GET /pending — snapshot of current queue
      if (req.method === "GET" && !action) {
        return Response.json({ pending: this.getPending() });
      }

      // GET /stream — SSE push stream
      if (req.method === "GET" && action === "stream") {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        const encode = (tx: PendingTx) =>
          encoder.encode(`data: ${JSON.stringify(tx)}\n\n`);

        // Flush current pending on connect
        for (const tx of this.getPending()) {
          await writer.write(encode(tx));
        }

        const unsub = this.onPending(async (tx) => {
          try {
            await writer.write(encode(tx));
          } catch {
            unsub();
          }
        });

        req.signal?.addEventListener("abort", () => {
          unsub();
          writer.close().catch(() => undefined);
        });

        return new Response(readable as unknown as BodyInit, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      }

      // POST /sign/:id
      if (req.method === "POST" && action === "sign" && id) {
        if (!this.pending.has(id)) {
          return new Response("Unknown transaction", { status: 404 });
        }
        const body = (await req.json()) as { signedTransaction: string };
        const sigPromise = new Promise<string | null>((resolve) => {
          const t = setTimeout(() => resolve(null), 60_000);
          this.emitter.once(`confirmed:${id}`, (sig: string) => {
            clearTimeout(t);
            resolve(sig);
          });
        });
        this.submitSigned(id, body.signedTransaction);
        const signature = await sigPromise;
        return Response.json(signature ? { ok: true, signature } : { ok: false });
      }

      // POST /reject/:id
      if (req.method === "POST" && action === "reject" && id) {
        if (!this.pending.has(id)) {
          return new Response("Unknown transaction", { status: 404 });
        }
        this.submitRejected(id);
        return Response.json({ ok: true });
      }

      return new Response("Not found", { status: 404 });
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** DER SPKI prefix for an Ed25519 public key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Compiled message bytes used to detect tampering between request and response. */
function compiledMessageBytes(tx: Transaction | VersionedTransaction): Uint8Array {
  return tx instanceof Transaction
    ? Uint8Array.from(tx.serializeMessage())
    : tx.message.serialize();
}

function buffersEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Constant-time string comparison for session-id checks. */
function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Strip internal fields, returning the public PendingTx shape. */
function toPublic(entry: PendingEntry): PendingTx {
  const { messageBytes: _messageBytes, ...rest } = entry;
  return rest;
}
