# GLB Size Optimizer

## Agent Prompt

You are building a production feature for **three.ws** — a real, live x402 agent-to-agent payment platform built on Solana and Base. This is not a demo or simulation. Every call you implement makes a real on-chain payment using the platform's seed wallet.

## Objective

Implement the **GLB Size Optimizer** autonomous pipeline that calls `/api/mcp (optimize_model)` as part of the x402 autonomous spend loop.

## x402 Endpoint

- **Route:** `/api/mcp (optimize_model)`
- **Price:** `$0.001 USDC/call` per call
- **Category:** 3D Pipeline

## What to Build

Identifies GLBs > 5MB and calls optimize_model to apply Draco compression and texture downscaling. Stores original and optimized versions. Measures average load time improvement across the catalog.

## Implementation Requirements

1. **Wire into the autonomous loop** — add an entry for this use case in `api/_lib/x402/autonomous-registry.js` with: `id`, `name`, `endpoint`, `price_atomic`, `cooldown_seconds`, `pipeline` (e.g., `'self'`), `enabled` (boolean), and a `run()` function that executes the call.

2. **Make real x402 payments** — use the platform's `X402_AGENT_SOLANA_SECRET_BASE58` keypair for outbound payments. Never mock the payment. If the wallet is not configured, exit gracefully with a log entry.

3. **Record everything** — every call, success or failure, must be inserted into `x402_autonomous_log` with: `run_id`, `endpoint_type='self'`, `service_name`, `endpoint_url`, `network`, `amount_atomic`, `asset`, `tx_signature`, `response_data`, `duration_ms`, `success`, `error_msg`, `pipeline`, `value_extracted`.

4. **Extract and store value** — don't just call the endpoint; parse the response and store the useful data to the appropriate DB table. Document exactly which table and column receives the data.

5. **Respect cooldowns** — implement a cooldown check in the registry entry so this call doesn't run more than the appropriate frequency. Recommended cooldown for this use case: based on the described schedule.

6. **Handle errors gracefully** — network failures, 402 rejections, and DB errors must all be caught, logged, and not crash the loop.

## Integration Points

- **Autonomous loop:** `api/x402-autonomous.js` runs this on its cron schedule
- **Registry:** `api/_lib/x402/autonomous-registry.js` — add your entry here
- **Recording:** Insert to `x402_autonomous_log` table on every execution
- **Downstream consumer:** Document which other pipeline/feature consumes the data extracted by this call

## Definition of Done

- [ ] Registry entry added with correct cooldown and price
- [ ] Real x402 payment made (not mocked)
- [ ] Response data stored to appropriate DB column
- [ ] Row inserted to x402_autonomous_log on every run
- [ ] Error handling covers: wallet unconfigured, network timeout, 402 rejection, DB failure
- [ ] Passes manual test: call the run() function directly, verify log row created and data stored

## Related Use Cases

See other files in `agents/x402-buildout/self/` for related autonomous loop entries. Coordinate on shared DB schemas and avoid duplicate table creation.

## Implementation (shipped)

- **Module:** `api/_lib/x402/glb-size-optimizer.js` — exports `run(ctx)`, `projectOptimization()`, `pickTarget()`, `readCatalogOptimizationSummary()`, `ensureOptimizationSchema()`.
- **Registry entry:** `glb-size-optimizer` in `api/_lib/x402/autonomous-registry.js` — `POST /api/mcp`, `pipeline: 'self'`, `cooldown_s: 21_600` (6h), `priority: 37`, `run: runGlbSizeOptimizer`.
- **Selection:** `pickTarget()` queries `avatars` for the heaviest public, non-deleted GLB with `size_bytes > 5 MB` not analyzed within 14 days (`LEFT JOIN glb_optimizations`). One model per run — gradual catalog sweep, biggest/stalest first.
- **Payment:** real x402 USDC via the shared `payX402()` client (`api/_lib/x402/pay.js`) using the seed/agent keypair. `optimize_model` is `$0.05/call`; the amount is read from the live 402 challenge, not hardcoded. Wallet/RPC unconfigured → graceful logged skip, no throw.
- **Value extracted → stored to `glb_optimizations`:** one row per model with `original_bytes`, `estimated_optimized_bytes`, `estimated_savings_bytes`, `savings_pct`, `load_ms_before`/`load_ms_after`, `load_improvement_pct`, `suggestion_ids`, full `suggestions` + `info` JSON, `run_id`, `tx_signature`, `amount_atomic`. `optimize_model` returns measured stats + advice (not a re-encoded GLB), so `projectOptimization()` computes a grounded projection from the model's real vertex count and per-texture dimensions/bytes using the compression ratios the suggestions cite (Draco ~70% geometry, exact 4K→2K area downscale, KTX2 over PNG/JPEG).
- **Recording:** a detailed `x402_autonomous_log` row (`pipeline='3d'`, `value_extracted` = savings summary) is written on every call (success or failure); the loop additionally records its standard summary row from the returned outcome.
- **Downstream consumer:** `GET /api/x402/glb-optimization-report` (`api/x402/glb-optimization-report.js`) reads `glb_optimizations` via `readCatalogOptimizationSummary()` to report catalog-wide average size + load-time improvement, total bytes shed, and remaining heavy-GLB backlog. Per-model "save ~N%" hints feed the avatar gallery.
- **Tests:** `tests/x402-glb-size-optimizer.test.js` — projection math (heavy/already-compressed/empty/floor) + registry wiring.
