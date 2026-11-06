# Deploy: agent-sniper worker → Cloud Run

The [`agent-sniper`](../../workers/agent-sniper) worker is a **long-lived
background process** that holds the live PumpPortal new-mint feed open, scores
launches against every armed agent strategy, and — in `live` mode — snipes from
each agent's **own** encrypted Solana wallet, then manages each position to its
exit. It holds a websocket open and runs timer loops with no inbound request to
"wake" it, so it **cannot run on Vercel** (an hourly cron can't snipe a launch)
and **must** run with always-on CPU and one always-warm instance.

This directory is the repeatable Cloud Run deploy, following the same house
pattern as [`deploy/world`](../world).

## TL;DR

```bash
# One-time: create the secrets (below), then:
node scripts/deploy-sniper.mjs          # build → push → deploy in SIMULATE mode
curl -s https://three.ws/api/sniper/status   # confirm it's live
```

`SNIPER_MODE` defaults to **`simulate`** — real on-chain quotes, **no broadcast,
zero spend**. Going `live` is a deliberate, separate cutover (see below); the
deploy script will never flip a service to live for you.

## Single instance is load-bearing

The worker's budget / concurrency guardrails are made race-free by an
**in-process per-agent lock** (`workers/agent-sniper/executor.js`). Two instances
would each independently pass the daily-budget check and **double-spend**.
`cloudrun.yaml` therefore pins `minScale = maxScale = 1`. This is a correctness
constraint, not a cost choice — do not scale it out without first replacing the
in-process lock with an atomic DB spend reservation.

## Required GCP setup (one time)

Project `aerial-vehicle-466722-p5`, region `us-central1` (override with
`GCP_PROJECT` / `GCP_REGION`). The deploy script enables the APIs, creates the
runtime service account `agent-sniper-sa@…`, and creates the `workers` Artifact
Registry repo if missing — all idempotent.

### Secrets — NEVER commit these; they live only in Secret Manager

| Secret | Required | Holds |
|--------|----------|-------|
| `sniper-database-url` | ✅ always | `DATABASE_URL` — Neon Postgres (strategies, position ledger, heartbeat). |
| `sniper-jwt-secret` | ✅ always | `JWT_SECRET` — decrypts each agent's Solana secret to sign. Loaded per-trade at runtime; **never baked into the image**. |
| `sniper-solana-rpc-url` | ✅ for **live** | `SOLANA_RPC_URL` — a real RPC (Helius/Triton). A public RPC 429s under the firehose; `loadConfig()` **refuses to start live without it**. |
| `telegram-bot-token` | optional | `TELEGRAM_BOT_TOKEN` — enables ops alerting. |
| `telegram-alerts-chat-id` | optional | `TELEGRAM_ALERTS_CHAT_ID` — the private ops channel (same one `api/_lib/alerts.js` uses). Absent → alerting is a silent no-op; the worker still runs. |

```bash
PROJECT=aerial-vehicle-466722-p5
SA=agent-sniper-sa@${PROJECT}.iam.gserviceaccount.com

printf '%s' "$DATABASE_URL"   | gcloud secrets create sniper-database-url   --data-file=- --project=$PROJECT
printf '%s' "$JWT_SECRET"     | gcloud secrets create sniper-jwt-secret     --data-file=- --project=$PROJECT
printf '%s' "$SOLANA_RPC_URL" | gcloud secrets create sniper-solana-rpc-url --data-file=- --project=$PROJECT
printf '%s' "$TELEGRAM_BOT_TOKEN"      | gcloud secrets create telegram-bot-token      --data-file=- --project=$PROJECT
printf '%s' "$TELEGRAM_ALERTS_CHAT_ID" | gcloud secrets create telegram-alerts-chat-id --data-file=- --project=$PROJECT

for s in sniper-database-url sniper-jwt-secret sniper-solana-rpc-url telegram-bot-token telegram-alerts-chat-id; do
  gcloud secrets add-iam-policy-binding "$s" --project=$PROJECT \
    --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
```

(The `telegram-bot-token` / `telegram-alerts-chat-id` secrets are the platform's
shared ops-alert credentials and may already exist for other workers — reuse them.)

## Runtime config (set in `cloudrun.yaml`, not secrets)

| Var | Default | Meaning |
|-----|---------|---------|
| `SNIPER_MODE` | `simulate` | `simulate` = real quotes, no broadcast, no spend. `live` = real trades. |
| `SNIPER_NETWORK` | `mainnet` | `mainnet` \| `devnet`. |
| `SNIPER_GLOBAL_KILL` | `0` | `1` halts all **new** buys; open positions still manage/exit. |
| `SNIPER_HEARTBEAT_MS` | `30000` | Liveness heartbeat cadence → `bot_heartbeat` → `/api/sniper/status`. |
| `SNIPER_HEARTBEAT_SELF_HEAL_MS` | `900000` | Dead-man switch: heartbeat writes failing continuously this long → `exit(1)` so Cloud Run restarts the worker with fresh connections/secrets (kills the up-but-zombie failure mode). `0` disables. |
| `SNIPER_FEED_WATCHDOG_MS` | `180000` | Re-subscribe + alert if the feed is silent this long. |
| `SNIPER_ERROR_ALERT_THRESHOLD` / `_WINDOW_MS` | `5` / `600000` | Executor/RPC errors in the window that trip an ops alert. |
| `SNIPER_ANNOUNCE` | `1` | Announce boot/shutdown to the ops channel. |
| `SNIPER_AUTO_FUND` | `1` | Keep each armed agent's own wallet topped from the launcher master so a live sniper never silently runs dry. Only moves SOL in **live** mode and when the master wallet is configured. |
| `SNIPER_AUTO_FUND_MIN_SOL` / `_TARGET_SOL` | `0.02` / `0.05` | Refill when an agent's balance drops under MIN, back up to TARGET. |
| `SNIPER_AUTO_FUND_PER_TX_SOL` / `_DAILY_SOL` | `0.1` / `1.0` | Hard caps: per single top-up, and total per UTC day across all agents (summed from the on-chain funding ledger, so a restart can't bypass it). |
| `SNIPER_EXIT_ON_BEARISH` | `0` | Arm the sentiment-flip exit: cut an **underwater** position early when its x402-bought sentiment flips confidently bearish, ahead of the hard stop-loss. Never overrides stop-loss / take-profit / a winner. |
| `SNIPER_EXIT_BEARISH_MIN_CONFIDENCE` | `0.7` | Confidence floor (0..1) a bearish read must clear before it can exit. |

The treasury → agent funding flow is visible on `GET /api/sniper/status` under
`funding` (SOL fueled today + all-time, last fund time), so you can confirm the
auto-funder is actually moving money without reading logs.

Full per-trade knobs (budget caps, throttles, intel/first-claim) are documented
in [`workers/agent-sniper/README.md`](../../workers/agent-sniper/README.md). The
trade-shaping caps (`daily_budget_lamports`, `per_trade_lamports`,
`max_concurrent_positions`, `max_price_impact_pct`, `stop_loss_pct`) are
**per-strategy DB columns**, set by the owner when arming — not env.

## Fail-closed

`loadConfig()` throws (and the process exits non-zero, so Cloud Run shows a crash
loop instead of silently mis-trading) when:

- `DATABASE_URL` or `JWT_SECRET` is missing,
- `SNIPER_MODE` / `SNIPER_NETWORK` is not one of the allowed values,
- `SNIPER_MODE=live` with neither `SOLANA_RPC_URL` nor `HELIUS_API_KEY`.

This is unit-verified in `tests/agent-sniper-ops.test.js`.

## Deploy (simulate)

```bash
node scripts/deploy-sniper.mjs            # build + push + deploy + verify heartbeat
node scripts/deploy-sniper.mjs --skip-build   # redeploy the current image (config-only change)
node scripts/deploy-sniper.mjs --dry-run      # print the gcloud commands, run nothing
```

Or by hand:

```bash
gcloud builds submit --config deploy/sniper/cloudbuild.yaml .          # build from REPO ROOT
gcloud run services replace deploy/sniper/cloudrun.yaml --region=us-central1
```

The cloudbuild context is the **repo root** (not this dir) — the sniper image
copies `api/`, the `agent-payments-sdk/` workspace, and `workers/agent-sniper/`.

### Verify simulate works against the real feed

```bash
# Heartbeat / feed-live signal (public, machine-readable):
curl -s https://three.ws/api/sniper/status | jq
#   → { "state": "live", "mode": "simulate", "feedLive": true, "strategies": N, ... }

# Logs: real new-mint scoring + simulated buys, zero broadcast (sig = "SIMULATED"):
gcloud run services logs read agent-sniper --region=us-central1 --project=aerial-vehicle-466722-p5
#   look for: "feed connected", "candidate", and trade lines with mode=simulate / sig=SIMULATED
```

`state: "live"` here means the **worker** is live and its feed is connected (not
that it's trading with real money). In simulate it scores and records simulated
positions with `buy_sig='SIMULATED'` and never broadcasts.

## Cutover to live (gated, deliberate)

Live mode signs and broadcasts real transactions from agent wallets. Do **not**
flip it until all of the following are true:

1. `sniper-solana-rpc-url` secret is set to a real RPC (Helius/Triton). Live
   refuses a public RPC.
2. At least one agent has an **armed strategy with conservative caps** (small
   `daily_budget_lamports` + `per_trade_lamports`, a mandatory `stop_loss_pct`,
   `max_concurrent_positions: 1`) and a **funded** wallet. Arm via the
   owner-only `POST /api/sniper/strategy`.
3. You have watched `simulate` score + simulate-buy real launches for long enough
   to trust the scoring.

Then edit `cloudrun.yaml` (`SNIPER_MODE: live`) and redeploy:

```bash
# set SNIPER_MODE to "live" in deploy/sniper/cloudrun.yaml, then:
node scripts/deploy-sniper.mjs --skip-build
```

The deployed worker enforces the **same guardrails as code** — no env weakens
them: global + per-agent kill switch, daily budget cap, max concurrent
positions, mandatory stop-loss (DB `CHECK`), price-impact circuit breaker, and a
one-shot idempotency lock per (agent, mint). Confirm they're active by arming a
strategy that should be skipped (e.g. price-impact above its breaker) and seeing
the `skip`/`failed` reason in the logs.

### Emergency stop

```bash
# Halt all NEW buys immediately (open positions still manage/exit):
#   set SNIPER_GLOBAL_KILL: "1" in cloudrun.yaml, then:
node scripts/deploy-sniper.mjs --skip-build
# Per-agent: set agent_sniper_strategies.kill_switch = true (any open position exits at market).
```

## Watchdog, alerting, and health

- **Feed watchdog + auto-reconnect.** The PumpPortal client reconnects with
  backoff internally; on top of that the worker watches for *silence* — if no
  event arrives within `SNIPER_FEED_WATCHDOG_MS` it tears down and re-subscribes,
  marks `feedConnected=false` in the heartbeat, and fires an ops alert. A silent
  dead feed is the worst failure mode, so it self-heals **and** pages.
- **Ops alerts** (Telegram, via `api/_lib/alerts.js`'s dedup/throttle) fire on:
  feed silence/re-subscribe, an executor/RPC error spike, and worker
  boot/shutdown. These go to the **ops** channel (`TELEGRAM_ALERTS_CHAT_ID`) and
  are distinct from the per-strategy trade notifications
  (`TELEGRAM_SNIPER_CHAT_ID`, `api/_lib/sniper/notify.js`).
- **Heartbeat → `/api/sniper/status`.** The worker upserts a `bot_heartbeat` row
  (`worker='agent-sniper'`) every `SNIPER_HEARTBEAT_MS` carrying mode, network,
  `feedConnected`, last-event age, active strategy count, reconnect/error
  counters, and uptime. `GET /api/sniper/status` reads it and reports
  `live` / `degraded` (alive but feed silent) / `down` / `unknown` — answerable
  without SSHing into the instance, and consumable by the platform status page.
