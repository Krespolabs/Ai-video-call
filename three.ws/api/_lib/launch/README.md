# Launch use-case engine

The shared, tested core behind every coin-launch recipe on three.ws. A **use
case** is a declarative object — a live data **source**, a **naming** strategy
that turns one candidate into a coin identity, and a **rewards** rule that routes
that coin's creator fees. The engine fetches real candidates, applies the
strategy, resolves rewards, and returns a concrete **launch plan** that the
[Launch Studio](../../../pages/launch-studio.html) previews live and the existing
`/launch` wizard mints.

Nothing here is a mock: candidates come from the GitHub Search API
([`github-trending.js`](../github-trending.js)) and the narrative engine
([`launcher-trends.js`](../launcher-trends.js)); rewards resolve through
[`github-reward.js`](../github-reward.js).

## Files

| File | Role |
|---|---|
| `usecase-engine.js` | Types, `validateUseCase`, identity helpers, `resolveReward`, `planLaunch`, `summarizeUseCase`. |
| `candidate-sources.js` | Adapters: turn live providers into uniform launch candidates. |
| `registry.js` | Merges every category module, validates each at load, enforces unique ids. |
| `usecases/*.js` | The catalog — one file per category (`github`, `onchain`, `news`, `culture`, `events`, `community`). |

## The two modes

- **`attribution`** — the coin is *for* a real subject (a GitHub repo or creator)
  and its fees route to that subject via the pump.fun social-fee "reward coin"
  mechanism. Coin-agnostic: the subject is live data resolved at runtime.
- **`narrative`** — the coin rides a cultural/sector theme and the identity is
  *invented*. Held to the $THREE rule via `launcher-trends` hygiene: themes only,
  brand-safe, no external ticker minted verbatim.

## A use case

```js
{
  id: 'github-trending-repos',          // kebab-case, unique, /^[a-z0-9][a-z0-9-]{2,48}$/
  title: 'Trending GitHub repos → reward coins',
  description: '...',                    // holder-readable
  category: 'github',                   // github|onchain|news|culture|events|community
  mode: 'attribution',                  // attribution | narrative
  tags: ['github', 'rewards'],
  reward_label: 'Creator fees → the repo owner',
  source: { kind: 'github-repos', params: { window: 'new', sinceDays: 30, minStars: 100 } },
  defaults: { devBuySol: 0, network: 'mainnet' },
  naming: (candidate) => ({ name, symbol, description, image }),
  rewards: (candidate) => ({ kind: 'github-owner', github_username, github_user_id }),
}
```

### Source kinds

| `source.kind` | Candidate | Key params |
|---|---|---|
| `github-repos` | one repo (`attribution`, owner) | `window` `new\|active`, `sinceDays`, `minStars`, `language`, `limit` |
| `github-creators` | one creator (`attribution`, creator) | same as above |
| `narratives` | one theme (`narrative`) | `sources[]` from `coin_intel,trending,knowyourmeme,googletrends,hackernews,reddit,wikipedia,x`, `limit` |

### Reward specs (returned by `rewards(candidate)`)

- `{ kind: 'creator' }` — fees stay with the launching agent wallet.
- `{ kind: 'github-owner', github_username, github_user_id? }` — 100% to that GitHub account.
- `{ kind: 'split', shareholders: [{ github_username|address, share_bps }] }` — basis-point split (sum 10000).
- `{ kind: 'address', address, share_bps? }` — a fixed Solana address.

`resolveReward(spec, { network, resolve })` resolves these. `resolve:false` (the
default, used by the **public** preview) returns intent only and never touches
the DB or reveals whether a GitHub user has a linked wallet; `resolve:true` (the
authed launch path) resolves to a concrete address.

## Adding a use case

1. Add an entry to the relevant `usecases/<category>.js` array (or a new category
   file imported in `registry.js`).
2. `validateUseCase` runs at registry load — a malformed recipe fails the import,
   never a launch.
3. Verify:
   ```bash
   node --input-type=module -e "import {USE_CASE_COUNT} from './api/_lib/launch/registry.js'; console.log(USE_CASE_COUNT)"
   ```

## Surfaces

- API: [`/api/pump/launch-studio`](../../pump/launch-studio.js) — `?action=list`, `?action=preview&id=`.
- UI: [Launch Studio](../../../public/launch-studio/launch-studio.js) at `/launch-studio`.
- Docs: [`docs/launch-usecases.md`](../../../docs/launch-usecases.md).
- Tests: `tests/launch-usecases.test.js`, `tests/github-trending.test.js`.
