# Vault Manifest Spec v1 — Encrypted-GLB Envelope

The BNB vault track (prompts 08–11) stores 3D models (GLB) so that even
though the encrypted bytes live on a public-ish Storage Provider (Greenfield
or any object store — see the portability note below), only a paying,
authorized buyer can ever recover the plaintext. This document is the wire
contract other code depends on:

- **08** (this prompt) implements the crypto primitives — `api/_lib/bnb/vault-crypto.js`.
- **09** (upload) produces the manifest below and uploads the ciphertext.
- **10** (contract) is the on-chain source of truth for `sellerAddress` / `priceAtomic` / access grants.
- **11** (unlock) consumes the manifest to deliver a wrapped key to a verified buyer and drive `unwrapKey` + `decryptGlb`.

Implementation: `api/_lib/bnb/vault-crypto.js` (`encryptGlb`, `decryptGlb`,
`wrapKey`, `unwrapKey`, `generateVaultKeypair`, `VAULT_CRYPTO_PARAMS`).

## Design goals

1. **Backend-agnostic.** The envelope and manifest never assume a specific
   storage backend. `glbObjectRef` is a `{bucket, object}` pointer — today
   that resolves against Greenfield buckets/objects, but the same manifest
   shape works unchanged against S3, R2, or any object store, hedging the
   Greenfield platform-risk noted in `00-CONTEXT.md` (contracts repo
   deprioritized, absent from the 2026 roadmap).
2. **Bytes-at-rest are always ciphertext.** The Storage Provider, any relay,
   and any observer of the manifest itself never sees plaintext GLB bytes or
   the raw content key.
3. **Per-object content key, per-buyer key delivery.** Every vault object
   gets its own random AES-256-GCM content key (`encryptGlb`). That content
   key is delivered to an authorized buyer only via `wrapKey`/`unwrapKey`
   (ECIES to the buyer's own secp256k1 public key — the same curve as their
   BSC/EVM address), never embedded in the manifest or transmitted in the
   clear.
4. **Fail loud, never silent garbage.** Tampered ciphertext, a tampered auth
   tag, or the wrong unwrap key must throw a typed error
   (`VaultCryptoError`), not return corrupted bytes.

## Cryptographic parameters (fixed for v1)

| Parameter | Value |
|---|---|
| Content cipher | AES-256-GCM (Node `crypto`, OpenSSL-backed) |
| Content key length | 32 bytes (256-bit), random per object |
| GCM IV (nonce) length | 12 bytes (96-bit, NIST SP 800-38D recommended size), random per encryption |
| GCM auth tag length | 16 bytes (128-bit) |
| Key-wrap scheme | ECIES over secp256k1 (ephemeral ECDH → HKDF-SHA256 → AES-256-GCM) |
| Key-wrap KDF | HKDF-SHA256, `info = "three.ws/bnb-vault/ecies/v1"`, no salt (HKDF default: zero-filled `hashLen` salt per RFC 5869) |
| Key-wrap ephemeral public key | secp256k1, compressed, 33 bytes |
| Recipient key | The buyer's own secp256k1 keypair (same curve as their EVM/BSC address — a buyer can, in principle, prove control of the wrap-recipient key the same way they prove control of their BSC address, though the vault track may use a dedicated vault keypair rather than the chain signing key directly; prompt 11 decides which) |
| Hash for content integrity | SHA-256 of the plaintext GLB bytes |

These are exposed programmatically from `VAULT_CRYPTO_PARAMS` in
`vault-crypto.js` so callers never hardcode a second copy that could drift
from the implementation.

## Byte layout of the envelope

The **encrypted object** uploaded to the Storage Provider is the raw GCM
ciphertext bytes only (`encryptGlb(...).ciphertext`) — no header, no
manifest fields inline. `iv`, `authTag`, and everything needed to interpret
the ciphertext live in the **manifest**, stored as a separate JSON object
alongside it (e.g. `<object>.manifest.json` next to `<object>.glb.enc`, or a
manifest-hub record referencing the object key — prompt 09 picks the exact
naming/pairing convention on top of this spec).

```
Storage Provider bucket/
├── <object>.glb.enc         # raw AES-256-GCM ciphertext bytes (opaque)
└── <object>.manifest.json   # the manifest below
```

Rationale: keeping ciphertext bytes header-free means the encrypted object
is a plain binary blob any object store can serve as-is (correct
`Content-Length`, resumable range requests, CDN-cacheable) — no custom
parser needed on the read path before the manifest is fetched.

## Manifest JSON schema

```json
{
  "version": 1,
  "glbObjectRef": {
    "bucket": "three-ws-vault-testnet",
    "object": "vaults/0xSellerAddr.../a1b2c3d4.glb.enc"
  },
  "encryption": {
    "alg": "AES-256-GCM",
    "iv": "9f1c...  (24 hex chars = 12 bytes)",
    "authTag": "7e3a... (32 hex chars = 16 bytes)"
  },
  "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "priceAtomic": "100000",
  "sellerAddress": "0x0000000000000000000000000000000000dEaD",
  "contract": {
    "address": "0x0000000000000000000000000000000000dEaD",
    "chainId": 97
  },
  "createdAt": "2026-07-08T00:00:00.000Z"
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `version` | integer | Manifest schema version. `1` for this spec. A future breaking change increments this; readers MUST reject an unknown version rather than guess. |
| `glbObjectRef.bucket` | string | Storage Provider bucket name (Greenfield bucket or equivalent). |
| `glbObjectRef.object` | string | Object key within the bucket. Points at the raw ciphertext blob described above. |
| `encryption.alg` | string | Always `"AES-256-GCM"` for v1 — matches `VAULT_CRYPTO_PARAMS.alg`. |
| `encryption.iv` | hex string | 12-byte GCM nonce, lowercase hex, no `0x` prefix. From `encryptGlb().iv`. |
| `encryption.authTag` | hex string | 16-byte GCM auth tag, lowercase hex, no `0x` prefix. From `encryptGlb().authTag`. |
| `sha256` | hex string | SHA-256 of the **plaintext** GLB bytes (`encryptGlb().sha256OfPlaintext`). The buyer's client MUST verify this after `decryptGlb` — pass it as `decryptGlb(envelope, { expectedSha256 })` to fail loudly on any silent corruption. |
| `priceAtomic` | decimal string | Price in the payment token's smallest unit (atomic), as a string to avoid float precision loss — same convention as `priceFor`/x402 elsewhere in this repo. Default `"100000"` (= $0.10 at 6 decimals) per 00-CONTEXT's "unsure of a price" default, env-overridable by prompt 09/10. |
| `sellerAddress` | `0x`-checksummed EVM address | The seller's BSC address. Validate with `assertBscAddress` from `api/_lib/bnb/chains.js`. |
| `contract.address` | `0x`-checksummed EVM address | The on-chain vault/marketplace contract that gates purchase + access (prompt 10). |
| `contract.chainId` | integer | `56` (BSC mainnet) or `97` (BSC testnet) — see `BNB_CHAINS` in `api/_lib/bnb/chains.js`. |
| `createdAt` | ISO 8601 string | Manifest creation timestamp (UTC). |

The manifest never contains the content key (raw or wrapped) — key delivery
is a separate, buyer-specific, access-gated flow (below), not a static field
anyone with the manifest URL can read.

## Key-delivery flow

The manifest is assumed to be publicly readable (it contains no secrets).
The **content key** is the secret, and it is delivered only after prompt
10's contract confirms the requester is an authorized buyer:

1. **Seller uploads (prompt 09).** Seller calls `encryptGlb(glbBytes)`,
   uploads `ciphertext` to the Storage Provider, and publishes the manifest
   (`iv`, `authTag`, `sha256`, `glbObjectRef`, etc.) alongside it. The
   seller retains `contentKey` only long enough to wrap it per-buyer (or
   re-derives/re-wraps on each sale) — it is never written to the manifest
   or any public location.
2. **Buyer purchases (prompt 10).** Buyer pays `priceAtomic` to `contract`
   on `contract.chainId`. The contract is the source of truth for "is this
   address an authorized buyer of this object" — `vault-crypto.js` has no
   opinion on payment; it only wraps/unwraps keys once authorization is
   established.
3. **Key unlock (prompt 11).** After the contract confirms payment, the
   unlock service calls `wrapKey(contentKey, buyerPubKey)` — a fresh ECIES
   wrap addressed to that specific buyer's public key — and returns the
   wrapped-key bundle (`ephemeralPublicKey`, `iv`, `authTag`, `ciphertext`)
   to the buyer over an authenticated channel. Only that buyer's matching
   private key can `unwrapKey` it; anyone else's key derives a different
   AES key and the GCM auth check fails closed (`VaultCryptoError` with
   `code: 'auth_failed'`).
4. **Buyer decrypts.** Buyer calls `unwrapKey(wrapped, theirPrivKey)` to
   recover the content key, then
   `decryptGlb({ciphertext, contentKey, iv, authTag}, {expectedSha256: manifest.sha256})`
   to recover and verify the original GLB bytes.

Each sale to a new buyer re-runs step 3 with that buyer's own public key —
`wrapKey` is deterministic in output *shape* but random in ephemeral key per
call (see `VAULT_CRYPTO_PARAMS`/tests: two wraps of the same content key to
the same recipient never produce identical ciphertext), so there is no
shared "master wrapped key" to leak across buyers.

## Error surface (typed, from `vault-crypto.js`)

`VaultCryptoError extends Error`, `name: 'VaultCryptoError'`, distinguishing
`code`:

| `code` | Thrown when |
|---|---|
| `bad_input` | Empty plaintext, or a value that isn't a Buffer/Uint8Array/hex string where one is required. |
| `bad_length` | A key/IV/tag is the wrong byte length (e.g. a 16-byte value where a 32-byte AES key is required) — rejected *before* touching the cipher. |
| `bad_public_key` | `recipientPubKey` doesn't decode to a valid secp256k1 curve point. |
| `bad_ecdh_input` | ECDH itself fails on the given private/public key pair. |
| `auth_failed` | GCM auth-tag verification failed — tampered ciphertext/tag, or (for `unwrapKey`) the wrong recipient private key. Never returns partial/garbage plaintext. |
| `sha256_mismatch` | `decryptGlb(..., {expectedSha256})` succeeded at the GCM layer but the plaintext hash doesn't match — signals silent corruption upstream of encryption, or a manifest/ciphertext pairing mistake. |

Prompts 09/11's HTTP layers should map `auth_failed` → 401/403 (wrong
key/tampered data), `bad_*` → 400 (malformed input), never a raw 500.

## Portability note (Greenfield platform-risk hedge)

Nothing in `vault-crypto.js` or this manifest imports a Greenfield SDK,
references a Greenfield-specific address type, or assumes Greenfield's
async cross-chain settlement model. `glbObjectRef.bucket`/`object` are
backend-neutral strings. If Greenfield's 2026 roadmap deprioritization (see
`00-CONTEXT.md`) makes it unsuitable later, prompt 09's upload path is the
only place that needs to change — swap the Storage-Provider client, keep
this manifest shape and every crypto primitive as-is.

## Versioning

This is `version: 1`. Any change to the algorithm, key lengths, HKDF info
string, or manifest field set is a breaking change and MUST bump `version`.
Readers MUST reject a manifest whose `version` they don't recognize rather
than attempt best-effort decryption.
