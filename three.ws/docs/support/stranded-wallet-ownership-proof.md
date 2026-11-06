# Wallet recovery: ownership-proof request

A support template for verifying that a claimant controls a wallet-auth account
before any balance is credited. Ownership is proven by signature, never by
narrative, and the payout only ever goes to a wallet the claimant signs from, so
there is no address for a bad actor to redirect funds to.

## How to use

1. Generate a fresh nonce per claim (do not reuse the one below):
   `node -e 'console.log(require("crypto").randomBytes(9).toString("base64url"))'`
2. Fill the wallet addresses and the agent id for the specific case.
3. Send the message. Require signatures from BOTH the login wallet and the
   original funding wallet.
4. Verify both signatures before approving any transfer (see
   `scripts/verify-wallet-ownership.mjs` when built, or verify with
   `nacl.sign.detached.verify`). A failed or missing signature ends the claim.

The concrete case below is agent `5e05f68f-eead-4ef9-b6b4-fc85ea73bbe9`:
- Login wallet: `7jWU2UBX7nKEFSXndbjR3NoSmgeqhL6Fh9fA1Vd7GaRe`
- Original funding wallet: `58uQ7w8qPvDcD4WsUqtZqCkiMyJrz1fEeMZmuRPaPbZv`

---

## Message to the customer

Subject: Verifying your three.ws wallet before we release your balance

Hi,

We can help with your withdrawal. Because this balance is tied to a self-custody
wallet, we verify ownership cryptographically before releasing anything. This
protects you: it guarantees the funds can only ever go back to a wallet you
control, and no one else can claim them.

Please do the following. It takes about a minute and costs nothing (no gas, no
transaction, just a message signature).

**Sign this exact text, once from each of the two wallets below:**

```
three.ws wallet recovery
agent: 5e05f68f-eead-4ef9-b6b4-fc85ea73bbe9
nonce: EAVO7fkpv49J
issued: 2026-09-18T00:56:07Z
```

1. **Your login wallet** `7jWU2UBX7nKEFSXndbjR3NoSmgeqhL6Fh9fA1Vd7GaRe`
   (the wallet you use to sign in to three.ws).
2. **The wallet that originally funded the balance**
   `58uQ7w8qPvDcD4WsUqtZqCkiMyJrz1fEeMZmuRPaPbZv`.

How to sign in Phantom: open the wallet, go to Settings, choose "Sign Message"
(or use any wallet tool that signs an arbitrary message), paste the text above
exactly, and sign. Do not send any transaction. Then send us back, for each
wallet: the wallet address and the resulting signature string.

Once both signatures check out, we will send your balance to your login wallet
`7jWU2UBX7nKEFSXndbjR3NoSmgeqhL6Fh9fA1Vd7GaRe`. We can only pay out to a wallet
you have proven you control, so please make sure you can sign from it.

If you are unable to sign from either wallet, we unfortunately cannot verify the
claim and cannot release the balance.

Thanks,
three.ws support

---

## Notes for the operator (do not send)

- The signature is over the literal text block, newlines included. Verify with
  the same bytes you gave the claimant.
- Both signatures are required. The login wallet proves account control; the
  funding wallet proves they are the party who deposited the money. A genuine
  owner controls both; an opportunist controls neither.
- The nonce and timestamp make each request single-use, so an old or screenshotted
  signature cannot be replayed.
- Payout destination is fixed to the proven login wallet. Never send to an address
  the claimant simply types into a message.
- The custody trail agrees with this: every withdrawal this account attempted named
  the login wallet or the funding wallet, never the look-alike poisoning address
  `58uQT1Y1...`.
