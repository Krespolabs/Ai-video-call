# Agent Wallet Balance Monitor

## Agent Prompt

You are building a production feature for **three.ws** — a real, live x402 agent-to-agent payment platform built on Solana and Base. This is not a demo or simulation. Every call you implement makes a real on-chain payment using the platform's seed wallet.

## Objective

Implement the **Agent Wallet Balance Monitor** autonomous pipeline that calls `/api/x402-pay?balance=1` as part of the x402 autonomous spend loop.

## x402 Endpoint

- **Route:** `/api/x402-pay?balance=1`
- **Price:** `free (GET)` per call
- **Category:** Trading

## What to Build

Polls the seed wallet balance every 10 minutes. Alerts when USDC drops below $5. Records balance time-series so operators can see spend rate and top up before autonomous calls fail.

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
