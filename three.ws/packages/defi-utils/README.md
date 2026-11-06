# @three-ws/defi-utils

Zero-dependency¹ single source of truth for chain and token constants across the
EVM chains three.ws touches **and** Solana. Chain IDs, native gas tokens, common
token addresses, minimal ERC-20 ABI fragments, and address/amount validation +
display formatting — one place, so handlers and packages stop duplicating these
ad hoc.

Ported from the owner's SperaxOS `defi-utils` (the EVM maps are kept verbatim,
including the Sperax integration tokens **SPA** and **USDs** on Arbitrum) and
extended with a Solana section SperaxOS lacks.

> ¹ One tiny runtime dependency: `bs58`, used only to validate that a Solana
> address decodes to 32 bytes. It is already a root dependency of this repo.

## Install / import

Internal workspace package (`"private": true`) — import it by name from anywhere
in the monorepo:

```js
import {
  getChainId,
  resolveTokenAddress,
  resolveSolanaMint,
  isEvmAddress,
  isSolanaAddress,
  fmtUsd,
} from '@three-ws/defi-utils';
```

Sub-path imports are available too: `@three-ws/defi-utils/chains`,
`/validation`, `/format`.

## Usage

```js
import {
  getChainId,
  getNativeToken,
  resolveTokenAddress,
  resolveSolanaMint,
  validateAddress,
  validateSolanaAddress,
  isEvmAddress,
  isSolanaAddress,
  fmtUsd,
  fmtPct,
  fmtAmount,
} from '@three-ws/defi-utils';

getChainId('arbitrum');                 // 42161  (unknown names default to Arbitrum)
getNativeToken(56);                     // 'BNB'
resolveTokenAddress('USDs', 42161);     // '0xD74f5255D557944cf7Dd0E45FF521520002D5748'
resolveTokenAddress('SPA', 42161);      // '0x5575552988A3A80504bBaeB1311674fCFd40aD4B'
resolveSolanaMint('THREE');             // 'FeMbDoX7R1Psc4GEcvJdsbNbZA3bfztcyDCatJVJpump'

validateAddress('0x123');               // 'Invalid wallet address. Expected format: …'  (null when valid)
validateSolanaAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // null (valid)
isEvmAddress('0xA0b8…eB48');            // true
isSolanaAddress('0xA0b8…eB48');         // false — discriminate EVM vs Solana

fmtUsd(1234.5);                          // '$1,234.50'
fmtPct(5.42);                            // '5.42%'
fmtAmount(0.00001);                      // '<0.0001'
```

## Exports

### Chains & tokens (`./chains`)

| Export | Description |
|--------|-------------|
| `CHAIN_IDS` | Chain name → EVM chain ID map. |
| `getChainId(chain)` | Resolve a chain name (case-insensitive); defaults to Arbitrum (42161). |
| `NATIVE_TOKENS` | Chain ID → native gas-token symbol map. |
| `getNativeToken(chainId)` | Native gas-token symbol; defaults to `'ETH'`. |
| `isNativeToken(symbol)` | True for native aliases (ETH/BNB/MATIC/AVAX/FTM/xDAI/S). |
| `TOKEN_ADDRESSES` | Chain ID → symbol → contract address (incl. SPA/USDs on Arbitrum). |
| `resolveTokenAddress(symbol, chainId)` | Symbol → address (case-insensitive); passes through a raw `0x…` address. |
| `SOLANA_MINTS` | Solana symbol → mint (SOL/USDC/THREE). |
| `resolveSolanaMint(symbol)` | Symbol → mint; passes through a raw base58 mint. |
| `ERC20_ABI` | The six ERC-20 fragments three.ws calls (symbol/decimals/balanceOf/transfer/approve/allowance). |

### Validation (`./validation`)

| Export | Description |
|--------|-------------|
| `validateAddress(addr)` | EVM address check → error string or `null`. |
| `validateAmount(amount)` | Positive-number / `"max"` check → error string or `null`. |
| `validateSolanaAddress(addr)` | base58, 32–44 chars, decodes to 32 bytes → error string or `null`. |
| `isEvmAddress(addr)` | Boolean EVM discriminator. |
| `isSolanaAddress(addr)` | Boolean Solana discriminator. |

### Formatting (`./format`)

| Export | Description |
|--------|-------------|
| `fmtUsd(value)` | `1234.5` → `'$1,234.50'`. |
| `fmtPct(value)` | `5.42` → `'5.42%'`. |
| `fmtAmount(value)` | Magnitude-scaled precision; `0.00001` → `'<0.0001'`. |

The Solana section (`SOLANA_MINTS`, `resolveSolanaMint`, `validateSolanaAddress`,
`isEvmAddress`/`isSolanaAddress`) is the three.ws extension over the SperaxOS
source. Formatter output strings are intentionally stable — downstream snapshots
depend on the exact format.

## Test

```bash
npx vitest run packages/defi-utils
```
