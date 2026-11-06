# Fee Bridge

> **Status: held, not public.** The code is in the repo but the feature is unreleased: `/fee-bridge` has no route or build input, it is not listed in `data/pages.json` or the changelog, and the studio option stays hidden until `FEE_BRIDGE_ENABLED` is on. Launching means restoring the route (`vercel.json`), the build input (`vite.config.js`), the `data/pages.json` entries and a changelog entry, then setting the env vars below.

The Fee Bridge pays a pump.fun coin's creator fees to an **X account**, in **USDC on Solana**. The person behind that handle doesn't need a wallet or a three.ws account when the coin launches. They sign in with X whenever they like and withdraw what has built up.

- Page: [three.ws/fee-bridge](https://three.ws/fee-bridge)
- API: `/api/fee-bridge/*` ([api/fee-bridge/[action].js](../api/fee-bridge/%5Baction%5D.js))
- Engine: [api/_lib/fee-bridge/](../api/_lib/fee-bridge/engine.js), run every 10 minutes by [api/cron/fee-bridge.js](../api/cron/fee-bridge.js)
- Schema: [20260917150000_fee_bridge.sql](../api/_lib/migrations/20260917150000_fee_bridge.sql)

## Who it is for

- **Creators** who want a coin's fees to go to a developer, artist, cause or community member, identified by X handle rather than by a wallet address.
- **Recipients** who would rather receive dollars than hold whatever a coin trades against.

## How the money moves

1. **Route.** The coin's pump.fun fee-sharing config lists one shareholder, the bridge wallet, at 100%. The coin is then registered to an X handle.
2. **Crank.** Every 10 minutes the bridge runs pump.fun's distribution for each registered coin that has passed the protocol minimum. Accrued fees land in the bridge wallet, and the bridge records how much came from which coin.
3. **Convert.** Once pending fees are worth at least `FEE_BRIDGE_MIN_BATCH_USD` ($5 by default), one batch runs:
   - The SOL is swapped to USDC on Jupiter. Fees from USDC-quoted coins are already USDC and skip this step.
   - Each coin is credited its pro-rata share of the USDC that actually arrived, after the gas the bridge spent landing that coin's distributions.
   - **80%** of each coin's USDC is credited to its handle. **20%** buys $THREE on Jupiter, and that $THREE goes to the treasury. Nothing is burned: the platform never destroys supply (see [api/_lib/token/config.js](../api/_lib/token/config.js)).
4. **Claim.** The recipient signs in on three.ws, connects X (read-only), links a Solana wallet and withdraws. After a wallet is linked, balances of `FEE_BRIDGE_AUTO_PAYOUT_USD` ($5) or more are sent automatically on the next pass.

A balance never expires. It stays in the bridge wallet as USDC until its owner claims it.

### Who can claim a handle

The first payout binds the handle to the numeric id of the X account that withdrew it. After that, only that X account can withdraw, even if it later changes its handle. If someone else picks up the old handle, they cannot claim the original owner's balance.

## Routing a coin

### Launched on three.ws

Open the coin's **Fees & rewards** panel (tokens dashboard, agent page, or Studio). Choose **Pay an X account in USDC**, enter the handle and confirm. The panel writes the fee split with whichever wallet controls the coin (the agent's wallet signs server-side, or your connected creator wallet signs), then registers the handle. If the split is already routed but the handle was never registered, the panel offers to finish registration.

### Any other pump.fun coin

1. With the creator wallet, set the coin's fee-sharing config to one shareholder: the bridge wallet (shown on [/fee-bridge](https://three.ws/fee-bridge) and returned by `GET /api/fee-bridge/config`) at 10000 bps.
2. Link that creator wallet to your three.ws account.
3. Register the coin on [/fee-bridge](https://three.ws/fee-bridge#route), or call the API.

Registration checks the chain rather than trusting the request. The coin must exist, be quoted in SOL or USDC, and route 100% of its fees to the bridge. The caller must also control the coin: either they launched it through three.ws, or its fee-sharing admin wallet is linked to their account. **A coin's handle cannot be changed once registered.** On most coins, a pump.fun fee-sharing update also locks the split permanently.

## API

All amounts are strings in USDC atomics (6 decimals). Errors use the standard `{ "error": code, "error_description": message }` envelope.

| Method | Path | Auth | Returns |
| --- | --- | --- | --- |
| GET | `/api/fee-bridge/config` | none | Bridge wallet, split, payout floors, whether the bridge is enabled |
| GET | `/api/fee-bridge/stats` | none | Totals plus the 20 newest confirmed payouts |
| GET | `/api/fee-bridge/coins?handle=&limit=` | none | Registered coins and what each has credited its handle |
| GET | `/api/fee-bridge/coin?mint=` | none | One coin's registration and whether it routes to the bridge on chain right now |
| GET | `/api/fee-bridge/recipient?handle=` | none | A handle's credited, paid and unpaid USDC, and the coins paying it |
| GET | `/api/fee-bridge/me` | session | Your handle (from your X connection), balance, linked wallets, coins, payouts |
| POST | `/api/fee-bridge/register` | session | Registers `{ mint, handle }` |
| POST | `/api/fee-bridge/withdraw` | session | Pays your unpaid balance to `{ wallet? }` (defaults to your primary Solana wallet) |

Look up what a handle has earned:

```bash
curl -s "https://three.ws/api/fee-bridge/recipient?handle=three_ws"
```

```json
{
  "handle": "three_ws",
  "claimed": false,
  "credited_usdc_atomics": "0",
  "paid_usdc_atomics": "0",
  "unpaid_usdc_atomics": "0",
  "coins": []
}
```

Withdraw from a signed-in browser session:

```js
const res = await fetch('/api/fee-bridge/withdraw', {
	method: 'POST',
	credentials: 'include',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({}),
});
const payout = await res.json();
// 200 { status: 'confirmed', signature, wallet, usdc_atomics }
// 202 { status: 'pending', ... } while the transfer is still confirming
```

Withdrawal errors you can act on: `x_not_connected` (connect X first), `no_wallet` (link a Solana wallet), `below_floor` (under the $1 minimum), `payout_in_flight` (one is already on its way), `fee_bridge_paused`.

## Safety model

- **Exactly-once sending.** Every crank, swap, buyback, sweep and payout saves its signature and blockhash before it is broadcast. If a pass dies partway, the next pass checks the chain for that signature. A transaction that landed is recorded. One whose blockhash expired without landing is safely retried. Nothing is ever sent twice.
- **No double spend.** A payout's balance check and its insert run as one statement, and a partial unique index allows only one pending payout per handle.
- **Balances are derived, not stored.** Unpaid is always credits minus pending and confirmed payouts, so no running total can drift from the rows behind it.
- **The bridge wallet is exempt from the economy sweeps.** Its signer is registered with `holdsUserFunds` in [api/_lib/solana-signers.js](../api/_lib/solana-signers.js), so neither the treasury sweep nor the idle-SOL reclaim can move recipients' money.
- **Conversion waits for gas.** A batch only starts when the bridge holds the batch's SOL plus a gas reserve (`FEE_BRIDGE_GAS_RESERVE_SOL`).

## Operating it

| Env var | Default | Purpose |
| --- | --- | --- |
| `FEE_BRIDGE_ENABLED` | off | Master switch for cranks, conversion, auto payouts and withdrawals |
| `FEE_BRIDGE_SECRET_KEY_B64` | none | The bridge wallet keypair. Any encoding `solana-signers.js` accepts |
| `FEE_BRIDGE_RECIPIENT_BPS` | 8000 | Recipient share (5000 to 10000); the rest buys $THREE |
| `FEE_BRIDGE_AUTO_PAYOUT_USD` | 5 | Auto payout floor for linked recipients |
| `FEE_BRIDGE_WITHDRAW_MIN_USD` | 1 | Smallest manual withdrawal |
| `FEE_BRIDGE_MIN_BATCH_USD` | 5 | Pending value needed before a conversion runs |
| `FEE_BRIDGE_SLIPPAGE_BPS` | 100 | Jupiter slippage for both swaps |
| `FEE_BRIDGE_GAS_RESERVE_SOL` | 0.03 | SOL kept back for gas and rent |
| `FEE_BRIDGE_CRANK_INTERVAL_MIN` | 30 | Minutes between cranks of one coin |
| `FEE_BRIDGE_CRANK_PER_TICK` / `FEE_BRIDGE_PAYOUTS_PER_TICK` | 10 / 10 | Per-pass work caps |

Preview a pass without signing anything (this works even while the bridge is disabled):

```bash
curl -s -H "authorization: Bearer $CRON_SECRET" "https://three.ws/api/cron/fee-bridge?dry=1"
```

The response lists each due coin's distributable fees, whether a conversion would run and at what quoted value, and which recipients would be paid.

## Related

- [Launchpad](./launchpad.md): launching a pump.fun coin on three.ws
- [STRUCTURE.md](../STRUCTURE.md): where every surface lives
