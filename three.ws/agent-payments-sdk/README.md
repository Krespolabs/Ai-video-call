<p align="center">
  <a href="https://three.ws"><img src="https://three.ws/three-ws-mcp-icon.svg" width="72" height="72" alt="three.ws" /></a>
</p>

<h1 align="center">@three-ws/agent-payments</h1>

<p align="center"><strong>Agent payments across Solana and EVM — agent-token invoices, USDC/token-2022 settlement, bonding-curve trades, x402 and a2a.</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@three-ws/agent-payments"><img alt="npm" src="https://img.shields.io/npm/v/@three-ws/agent-payments?logo=npm&color=cb3837"></a>
  <a href="https://www.npmjs.com/package/@three-ws/agent-payments"><img alt="downloads" src="https://img.shields.io/npm/dm/@three-ws/agent-payments?color=cb3837"></a>
  <img alt="license" src="https://img.shields.io/npm/l/@three-ws/agent-payments?color=3b82f6">
  <img alt="node" src="https://img.shields.io/node/v/@three-ws/agent-payments?color=339933&logo=node.js">
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#entry-points">Entry points</a> ·
  <a href="#solana-api">Solana</a> ·
  <a href="#evm-api">EVM</a> ·
  <a href="#x402--a2a">x402 / a2a</a> ·
  <a href="https://three.ws">three.ws</a>
</p>

---

> The on-chain payments engine behind three.ws **agent tokens**: a user launches a
> token for their agent and then charges the people who pay that agent in its
> token, with buyback and shareholder distribution. This package binds the
> Solana agent-payments program (`AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7`),
> adds EVM agent payments, bonding-curve trading, and the x402 / a2a settlement
> layers — all fully typed, dual ESM/CJS.

### A value-added fork

This is a deliberate, value-added three.ws fork of **`@pump-fun/agent-payments-sdk@3.0.3`**
(the upstream Solana agent-payments program bindings). It keeps the core
binary-compatible with the deployed program — the same program ids and the same
`PumpAgent(mint, environment?, connection?)` constructor — and extends it with:

- **USDC + token-2022 quote assets** (upstream is SOL-only): `USDC_MINT`,
  `decodeBondingCurveQuoteMint`, `resolveTokenProgramForMint`.
- **A v2 bonding-curve trade client** — `PumpTradeClient` (`buy_v2`/`sell_v2`,
  exact-quote-in buys).
- **EVM agent payments** (`./evm`), **x402 on EVM** (`./x402`), **a2a payment
  helpers** (`./a2a`), the **legacy program** bindings, and a `solana-agent-kit`
  plugin.

When pump.fun ships program changes we port them *into* this fork rather than
replacing it. See [FORK_NOTES.md](./FORK_NOTES.md) for the full upstream
comparison and sync procedure.

## Install

```bash
npm install @three-ws/agent-payments
```

Solana (`@solana/web3.js`, `@solana/spl-token`, `@coral-xyz/anchor`), EVM
(`ethers`, `viem`), and the pump SDKs ship as direct dependencies. `zod` is an
optional peer dependency.

## Quick start

```ts
import { PumpAgent, PumpAgentOffline, USDC_MINT } from '@three-ws/agent-payments';
import { Connection, PublicKey } from '@solana/web3.js';

const mint = new PublicKey('<your agent token mint>');

// Offline — build instructions without an RPC connection.
const offline = new PumpAgentOffline(mint);

// Online — RPC-backed balance queries and invoice validation.
const connection = new Connection('https://api.mainnet-beta.solana.com');
const agent = new PumpAgent(mint, 'mainnet', connection);

// Did this user pay the invoice (e.g. 1 USDC) within the window?
const paid = await agent.validateInvoicePayment({
  user: new PublicKey('<payer>'),
  currencyMint: USDC_MINT,
  amount: 1_000_000,                              // 1 USDC, 6 decimals
  memo: 12345,
  startTime: Math.floor(Date.now() / 1000),
  endTime: Math.floor(Date.now() / 1000) + 300,
});
```

## Entry points

Each subpath is dual ESM/CJS with type declarations. The root `.` re-exports the
full Solana and EVM surfaces, plus namespaced `solana`, `evm`, `x402Evm`, and
`a2a` objects.

| Import | What it provides |
| --- | --- |
| `@three-ws/agent-payments` | everything below, flat + namespaced (`solana`, `evm`, `x402Evm`, `a2a`) |
| `@three-ws/agent-payments/solana` | `PumpAgent`, `PumpAgentOffline`, `PumpTradeClient`, PDAs, decoders, events |
| `@three-ws/agent-payments/evm` | `EvmAgent`, `EvmAgentOffline`, ABIs, chain registry, invoice utils |
| `@three-ws/agent-payments/x402` | EVM x402 client + facilitator helpers |
| `@three-ws/agent-payments/a2a` | a2a payment helpers (`payA2A`, signers, EVM exact payloads) |
| `@three-ws/agent-payments/solana/legacy-agent-payments` | bindings for the legacy 1.0.7 program |
| `@three-ws/agent-payments/solana/solana-agent-kit` | `PumpAgentPaymentsPlugin` for solana-agent-kit |

## Solana API

### Classes

- **`PumpAgent(mint, environment?, connection?)`** — RPC-backed agent. Methods
  include `getBalances`, `getAllCurrencyBalances`, `getCoinQuoteMint`,
  `getCoinPaymentSummary`, `updateBuybackBps`, `getAgentConfig`, `getGlobalConfig`,
  `getPaymentStats`, `getSupportedCurrencies`, `isInitialized`,
  `getPaymentHistory`, `getEventHistory`, `validateInvoicePayment`.
- **`PumpAgentOffline(mint)`** — pure instruction builder, no RPC required.
- **`PumpTradeClient(connection)`** — v2 bonding-curve trades:
  `resolveQuoteMint`, `quoteForBuy`, `quoteForSell`, `buildBuyInstructions`,
  `buildSellInstructions`. Throws `CoinGraduatedError`, `CoinNotFoundError`,
  `InsufficientLiquidityError`, `UnsupportedQuoteMintError`.

### Constants & helpers

- **Program ids:** `PROGRAM_ID`, `PUMP_PROGRAM_ID`, `PUMP_AGENT_PAYMENTS_PROGRAM_ID`,
  `PUMP_FEES_PROGRAM_ID`. **`USDC_MINT`** for USDC-quoted payments.
- **PDAs:** `getGlobalConfigPDA`, `getTokenAgentPaymentsPDA`,
  `getPaymentInCurrencyPDA`, `getInvoiceIdPDA`, `getBuybackAuthorityPDA`,
  `getWithdrawAuthorityPDA`, `getBondingCurvePDA`, `getSharingConfigPDA`.
- **Decoders:** `decodeGlobalConfig`, `decodeTokenAgentPayments`,
  `decodeTokenAgentPaymentInCurrency`, `decodeBondingCurveQuoteMint`,
  `resolveTokenProgramForMint`.
- **Program:** `getProgram`, `getPumpProgram`, `getPumpProgramWithFallback`,
  `getOfflineProgram`, `OFFLINE_PUMP_PROGRAM`.
- **Errors:** `CurrencyNotSupportedError`, `JupiterUnavailableError`.

### Events

```ts
import { parseAgentEvents, subscribeToAgentEvents } from '@three-ws/agent-payments';

const events = parseAgentEvents(tx.meta.logMessages);
for (const e of events) {
  if (e.name === 'agentAcceptPaymentEvent') console.log('paid:', e.data.amount.toString());
}

const sub = subscribeToAgentEvents(connection, (event, slot) => {
  console.log(`[slot ${slot}] ${event.name}`, event.data);
}, { eventNames: ['agentAcceptPaymentEvent'] });
// sub.unsubscribe();
```

`createEventParser` and all event type interfaces are exported too. The pump
bonding-curve program (`6EF8rrec...`) has its own parser under the namespaced
`pumpEvents` export.

## EVM API

```ts
import { EvmAgent, EVM_CHAINS, getInvoiceId } from '@three-ws/agent-payments/evm';

const agent = new EvmAgent(/* config */);
const config   = await agent.getAgentConfig();
const balances = await agent.getBalances(currencyToken);
const paid     = await agent.isInvoicePaid(invoiceId);
```

- **`EvmAgent`** — read agent config, balances, payment stats/history, and verify
  invoices (`getAgentConfig`, `getBalances`, `getPaymentStats`, `isInvoicePaid`,
  `validateInvoicePayment`, `getPaymentHistory`).
- **`EvmAgentOffline`** — instruction/calldata builder without a provider.
- **Chains:** `EVM_CHAINS`, `SUPPORTED_CHAIN_IDS`, `getEvmChain`,
  `isEvmChainSupported` (Ethereum, Base, Arbitrum, Polygon, BNB, Avalanche, …),
  plus `NATIVE_TOKEN_ADDRESS`.
- **ABIs & invoices:** `AGENT_PAYMENTS_ABI`, `ERC20_ABI`, `getInvoiceId`,
  `buildInvoiceWindow`, `generateMemo`, `parseEvmAgentEvents`.

## x402 / a2a

EVM x402 pay-gating:

```ts
import { createEvmX402Fetch } from '@three-ws/agent-payments/x402';

const x402fetch = createEvmX402Fetch({ /* wallet client + options */ });
const res = await x402fetch('https://api.agent.example/inference');
```

Also exported from `./x402`: `decodePaymentHeader`, `buildPaymentRequiredHeader`,
and the `EvmReplayStore` / verification types for the facilitator side.

Agent-to-agent payments:

```ts
import { payA2A, createPrivateKeySigner } from '@three-ws/agent-payments/a2a';

const signer = await createPrivateKeySigner(process.env.A2A_PRIVATE_KEY);
const result = await payA2A({ /* endpoint, signer, … */ });
```

`./a2a` also exports `requestA2AQuote`, `submitA2APayment`, `buildEvmExactPayload`,
the A2A extension URI/header constants, and the A2A request/response types.

## Requirements

- **Node** `>= 18`.
- **Solana:** `@solana/web3.js@^1.98`, `@solana/spl-token`, `@coral-xyz/anchor` (bundled deps).
- **EVM:** `ethers@^6`, `viem@^2` (bundled deps).
- `zod` is an optional peer dependency.

## Links

- Homepage: https://three.ws
- Changelog: https://three.ws/changelog
- Sibling SDK: [`@three-ws/solana-agent`](https://www.npmjs.com/package/@three-ws/solana-agent)
- Issues: https://github.com/nirholas/three.ws/issues
- Fork notes: [FORK_NOTES.md](./FORK_NOTES.md)
- License: ISC

---

<p align="center">
  <sub>
    Part of the <a href="https://three.ws">three.ws</a> SDK suite — 3D AI agents, on-chain identity, and agent payments.<br/>
    <a href="https://three.ws">Website</a> · <a href="https://three.ws/changelog">Changelog</a> · <a href="https://github.com/nirholas/three.ws">GitHub</a>
  </sub>
</p>
