# 056: Skill Marketplace: Price Distribution

## Objective
Build a real, wired x402 use case that calls the `/api/x402/skill-marketplace` endpoint on three.ws, pays with the autonomous loop seed wallet, records the result to `x402_autonomous_log`, and extracts actionable signal data.

## x402 Endpoint
- **Path:** `/api/x402/skill-marketplace`
- **Method:** POST
- **Body:** `{"mode":"price_distribution"}`

## What to Build
Pay to fetch skill marketplace price distribution data. Extract { min_price, max_price, median_price, skill_count }. Monitor for price floor erosion — if median_price drops >20% week-over-week, signal marketplace health issue.

## Implementation Requirements

1. **Add to registry** — Add an entry in `api/_lib/x402/autonomous-registry.js` under `SELF_ENDPOINTS` with:
   - `id`: unique kebab-case string
   - `path`: `/api/x402/skill-marketplace`
   - `body`: `{"mode":"price_distribution"}`
   - `cooldown_s`: appropriate cooldown (300–3600 depending on signal volatility)
   - `priority`: 50–99 (oracle pipeline ≥ 85, health 40–60, volume 65–75)
   - `pipeline`: one of `'oracle' | 'health' | 'volume' | 'sniper'`
   - `extractSignal`: function that parses the response body and returns a plain object with the key fields described above

2. **Make real payments** — The autonomous loop (`api/cron/x402-autonomous-loop.js`) uses the seed keypair (`X402_SEED_SOLANA_SECRET_BASE58`) to pay real USDC. No mocks. If the endpoint does not exist yet, build it first.

3. **Record to log** — Every call is recorded to `x402_autonomous_log` with `pipeline`, `signal_data` (from `extractSignal`), and `success` fields. Verify the insert in the DB after first run.

4. **Extract value** — The extracted signal must be actionable. If this is an oracle pipeline entry, upsert the signal into `oracle_intel_signals` with an appropriate `topic` so the sniper gate can consume it.

5. **Respect cooldowns** — Set a cooldown that matches the signal's update frequency. Price data: 300s. Macro intel: 900s. Health checks: 300–600s. Audit-style calls: 1800–3600s.

6. **Handle errors** — Probe the endpoint before paying. If the endpoint returns a non-402 error, log it and skip payment. Never throw on a failed call — return `{ success: false, error_msg }` and continue.

## Definition of Done
- [ ] Entry added to `SELF_ENDPOINTS` in `autonomous-registry.js`
- [ ] `extractSignal` function tested with a real response payload
- [ ] Autonomous loop cron triggered manually and the entry appears in `x402_autonomous_log`
- [ ] If oracle pipeline: row visible in `oracle_intel_signals` with correct `topic` and `signal`
- [ ] No console errors from this entry in the cron logs
- [ ] `git diff` reviewed — no unrelated changes committed
