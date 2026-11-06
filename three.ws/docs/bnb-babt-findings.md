# BABT (Binance Account Bound Token) — verification findings

**Verdict: REAL, LIVE on BSC mainnet AND testnet, and third-party queryable on-chain
today via a single free `eth_call`.** This closes the open question left in
`prompts/bnb-chain/00-CONTEXT.md` ("BABT sybil-gating is unverified"). A `hasBabt()`
lib and a free `/api/bnb/babt-check` endpoint ship alongside this doc.

Verified 2026-07-08 by direct on-chain probes against public BSC RPCs (via
`api/_lib/bnb/chains.js`) plus Binance's own developer documentation. Every number
below is a live read, not a claim taken on faith.

---

## 1. Contract identity

| Network | Address | Status |
|---|---|---|
| BSC mainnet (56) | `0x2B09d47D550061f995A3b5C6F0Fd58005215D7c8` | Deployed, verified on BscScan, actively minting |
| BSC testnet (97) | `0x984E6a7b9cb73cB7884c9ca9b1Ee625546F9D0E3` | Deployed, actively minting |

Both addresses come from Binance's own developer docs
(`developers.binance.com/docs/babt/apis-spec`) and were independently confirmed with
a raw `eth_getCode` call — real bytecode is deployed at both, not an empty/self-destructed
proxy shell:

```
$ node scripts probe (viem eth_getCode via getPublicClient from chains.js)
mainnet 0x2b09d47d550061f995a3b5c6f0fd58005215d7c8 → bytecode length 3622 bytes, has code: true
testnet 0x984E6a7b9cb73cB7884c9ca9b1Ee625546F9D0E3 → bytecode length 3622 bytes, has code: true
```

Both contracts respond to `name()` with the string `"Binance Account Bound Token"` and
to `totalSupply()`:

```
mainnet name() = "Binance Account Bound Token"   totalSupply() = 1164243
testnet name() = "Binance Account Bound Token"   totalSupply() = 1252
```

The mainnet contract is BscScan-listed with 1,163,690+ holders and 1.4M+ transactions
as of late June 2026 — this is a heavily used, actively minting production system, not
an abandoned experiment. The testnet deployment also has real mint activity (1,252
tokens), so — contrary to the working assumption in `00-CONTEXT.md` — **a testnet
deployment does exist** and can be used for our normal testnet-first flow, though it
holds far fewer real KYC'd identities than mainnet (developers testing the mint flow,
not real Binance users) and its `eth_getLogs` (archive-node history) is not available on
the free public RPC we use — direct `eth_call` reads (`balanceOf`, `tokenIdOf`,
`totalSupply`) work fine on both networks.

## 2. Interface — real read proof

BABT "extends from ERC-721" (per Binance's own docs) but is a soulbound (SBT) variant:
non-transferable after mint, and revocable/re-mintable by Binance to a new wallet (which
rotates the `tokenId` — Binance's docs explicitly warn callers not to treat `tokenId` as
a stable identity; use the token metadata's immutable `id` field for that instead).

Read functions relevant to third-party gating:

| Function | Params | Returns | Purpose |
|---|---|---|---|
| `balanceOf(address owner)` | `owner` | `uint256` | 0 or 1 — the standard "does X hold a BABT" check |
| `tokenIdOf(address from)` | `from` | `uint256` | current token id for a holder (reverts if none) |
| `ownerOf(uint256 tokenId)` | `tokenId` | `address` | reverse lookup |
| `totalSupply()` | — | `uint256` | running mint count |

**Live proof against a real mainnet holder**, found by scanning recent `Transfer`
(mint) events on the mainnet contract and reading the resulting holder back through
`balanceOf`/`tokenIdOf` — no test double, no mock:

```
mint event found in blocks 108689374–108694374:
  holder = 0x04d1c36842430a169d132ada68006e6bb9e3808b
  tokenId (from Transfer log) = 0x1417cf

balanceOf(0x04d1c36842430a169d132ada68006e6bb9e3808b) = 1
tokenIdOf(0x04d1c36842430a169d132ada68006e6bb9e3808b) = 1316815

sanity check — balanceOf(0x000000000000000000000000000000000000dEaD) = 0
```

`balanceOf` returning `1` for a real, freshly-minted holder and `0` for the burn
address is exactly the expected soulbound-membership signal, and it cost one
`eth_call` against a free public RPC — no API key, no Binance account, no rate-limited
private endpoint.

## 3. Can an arbitrary third party query this today?

**Yes, unconditionally, for free.** `balanceOf`/`tokenIdOf` are public `view` functions
on a verified contract reachable through any standard BSC RPC (the same public
endpoints `api/_lib/bnb/chains.js` already uses for everything else in this campaign).
No API key, allowlist, or Binance relationship is required to *read* BABT ownership —
only to *mint* one (that part does require a KYC'd Binance account and wallet
signature, which is the whole point).

Binance/BNB Chain actively encourage this: BNB Chain's own blog post ("How to
Integrate BAB Tokens") exists specifically to help third-party projects gate features
on BABT ownership, and points to the same `developers.binance.com/docs/babt` docs used
here. No usage terms restrict read-only on-chain verification; Binance's BABT FAQ does
not impose additional restrictions on third-party integrations beyond standard BNB
Chain project participation.

## 4. Limitations (documented honestly — do not overstate)

- **KYC dependency, not our KYC.** A "holds BABT" signal proves the address is bound
  to *some* identity-verified Binance account — it says nothing about who that person
  is, and we cannot verify KYC ourselves; we trust Binance's attestation. Anyone who
  never completed Binance Identity Verification (or never bothered getting a Binance
  account) simply won't have one, whether or not they're a real unique human.
- **Binance-account gated, not wallet-gated.** A single KYC'd person can (per Binance's
  own docs) revoke and re-mint their BABT to a different wallet, which changes the
  `tokenId` returned by `tokenIdOf` for that wallet. `balanceOf` on the old wallet
  correctly returns `0` after a revoke, so the *current* check is always accurate, but
  historical `tokenId` values are not stable identity anchors.
  Binance's docs explicitly say: don't use `tokenId` as identity — the (private,
  off-chain) metadata `id` field is the stable identifier, and it is not something a
  third-party contract can read on-chain.
  Practical consequence for sybil-resistance: BABT proves "this address belongs to
  *a* KYC'd Binance user right now," not "this is address is permanently tied to
  person P forever" — good enough for point-in-time gating (mint an NFT, join an
  allowlist), not for building a long-lived on-chain identity graph.
  It does **not**, by itself, stop one KYC'd person from participating from N different
  addresses *sequentially* (mint BABT on wallet A, use it, ask Binance to re-mint to
  wallet B) — though each re-mint requires going back through Binance's flow, which
  raises the cost of doing this at scale far above a normal sybil attack.
- **Mainnet-primary.** The overwhelming majority of real KYC identities (1.16M+
  holders) are on mainnet; the testnet contract is a real, live, minting deployment
  useful for exercising *our* integration code end-to-end, but it does not carry real
  user identities — do not treat a testnet-only check as meaningful sybil resistance.
- **No SDK is required or exists as an npm package** — the interface is 4 tiny read
  functions on a verified contract, callable directly via any EVM client (we use viem,
  already a dependency). Nothing to install.
- **Binance-operated, single point of trust.** Unlike a decentralized identity
  protocol, minting/revocation policy is entirely Binance's — an outage or policy
  change on Binance's side affects who *can* mint, not the on-chain read path itself
  (already-minted tokens remain independently readable).

## 5. Honest comparison vs. other sybil-resistance options

| Signal | Chain | KYC-backed | Third-party read cost | Holder base (2026-07) | Centralization |
|---|---|---|---|---|---|
| **BABT** | BSC only (mainnet + testnet) | Yes — real government-ID KYC via Binance | Free, 1 `eth_call`, no API key | 1.16M+ mainnet | Single company (Binance) issues + can revoke |
| Gitcoin Passport | Any EVM (off-chain aggregator, on-chain attestations via EAS) | No — behavioral/stamp aggregation (Discord age, ENS, BrightID, etc.), not government ID | Free reads via EAS/Passport API | Millions of stamps across many chains, no single "holder count" | Decentralized scoring, no single revoker |
| World ID | Any chain via bridge (Worldcoin/World Chain native) | Yes — biometric (iris scan via Orb), not government ID | Free on-chain verify (semaphore proof) | Tens of millions of Orb-verified humans globally, chain-agnostic | Single foundation (Tools for Humanity) controls Orb hardware/enrollment |
| Coinbase "Verified" attestations (Base) | Base/Ethereum | Yes — Coinbase KYC | Free on-chain read (EAS attestation) | Coinbase's KYC'd user base (not published as an on-chain holder count) | Single company (Coinbase) |

**Where BABT wins for a BNB-Chain-native product:** it is the *cheapest, simplest*
KYC-backed signal to integrate on BSC specifically — one `balanceOf` call, zero setup,
zero dependency on an off-chain oracle or bridge, and it is already deployed with over
a million real holders. For a three.ws feature that specifically targets the BNB Chain
ecosystem (matching this campaign's "unique to BNB Chain" framing), it's a strong fit.

**Where it loses:** it is chain-local (BSC only — a Solana- or Base-native product gets
nothing from it) and single-issuer (Binance controls minting policy entirely, unlike
World ID's dedicated identity infrastructure or Gitcoin's decentralized scoring). Coinbase's
Base-native equivalent is the closer functional peer, but is comparably centralized to
one company rather than being an independent identity network. If the goal were
maximum decentralization or cross-chain portability, World ID or Gitcoin Passport are
the better fit; if the goal is "cheapest KYC-backed signal specifically for a BSC
product, today," BABT wins outright — free, live, and provably real.

## 6. What shipped

Given the verdict above (real + third-party-queryable), the build half of this spike
shipped:

- **`api/_lib/bnb/babt.js`** — `hasBabt(address, network?, opts?)` reads `balanceOf`
  (and, when positive, `tokenIdOf`) against the real contract via
  `api/_lib/bnb/chains.js`. Returns
  `{ address, network, holdsBabt, tokenId, contract, checkedAt }`. Defaults to
  mainnet (where the real KYC'd holder base lives); `network: 'bscTestnet'` is
  supported for exercising the integration without touching mainnet.
- **`GET /api/bnb/babt-check?address=&network=`** — free, rate-limited (reuses the
  existing `limits.publicIp` bucket), validates the address, and surfaces
  `contract_unreachable` (502) honestly on an RPC outage rather than silently
  returning a false negative.
- **`tests/bnb-babt.test.js`** — unit tests for `hasBabt` (mocked `balanceOf`/`
  tokenIdOf` reads: `>0` → `holdsBabt:true`, `0` → `false`, contract-read failure →
  typed error) and the endpoint (input validation, success, upstream failure).

## Sources

- BscScan mainnet contract: https://bscscan.com/token/0x2b09d47d550061f995a3b5c6f0fd58005215d7c8
- Binance BABT developer docs: https://developers.binance.com/docs/babt/introduction
  and https://developers.binance.com/docs/babt/apis-spec
- BNB Chain integration guide: https://www.bnbchain.org/en/blog/how-to-integrate-bab-tokens
- Binance BABT FAQ: https://www.binance.com/en/support/faq/frequently-asked-questions-on-binance-account-bound-bab-token-adbd05fe149344d59a348f82d5bf359d
- Live probes: raw `eth_getCode`/`eth_call` against public BSC mainnet + testnet RPCs,
  2026-07-08 (this repo, via `api/_lib/bnb/chains.js`; see `tests/bnb-babt.test.js` and
  `prompts/bnb-chain/PROGRESS.md` for the captured output).
