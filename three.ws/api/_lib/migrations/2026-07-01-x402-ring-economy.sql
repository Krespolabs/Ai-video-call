-- 2026-07-01-x402-ring-economy.sql
--
-- Closed-loop agent-to-agent x402 economy — schema.
--
-- three.ws runs a self-contained x402 economy: platform-controlled agent wallets
-- pay platform-controlled paid endpoints in real USDC, settled by the platform's
-- OWN facilitator (api/x402-facilitator) — no external facilitator, no user funds,
-- no wallet outside three.ws. These tables are the durable audit trail. Every row
-- is a real on-chain settlement or transfer; there are no synthetic rows.
--
-- Tables:
--   x402_self_facilitator_log  — every /verify and /settle the self-hosted
--                                facilitator processes, with the exact SOL fee
--                                the sponsor paid and the reject reason on refusal.
--                                This is the "log everything" settlement trail and
--                                the source of the cumulative SOL-burn meter.
--   x402_ring_ledger           — the economic flow: one row per settled payment
--                                (kind='settle') and per treasury→payer rebalance
--                                (kind='sweep'/'fund'). Drives the net-position
--                                report (gross volume, tx count, SOL burned).
--   x402_ring_wallets          — the registry of platform-controlled wallets in
--                                the ring (role: payer | treasury | sponsor). Only
--                                pubkeys live here; secrets stay in env/Vercel.

CREATE TABLE IF NOT EXISTS x402_self_facilitator_log (
	id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	ts              timestamptz NOT NULL DEFAULT now(),
	action          text NOT NULL,                       -- 'verify' | 'settle'
	network         text,
	payer           text,                                -- buyer pubkey
	pay_to          text,                                -- recipient pubkey (must be allowlisted)
	mint            text,
	amount_atomic   bigint,
	tx_sig          text,                                -- settlement signature (settle only)
	fee_lamports    bigint,                              -- SOL the sponsor burned on this settle
	ok              boolean NOT NULL DEFAULT false,
	reject_reason   text,                                -- why a verify/settle was refused
	idempotency_key text,
	run_id          uuid
);

CREATE INDEX IF NOT EXISTS x402_self_facilitator_log_ts ON x402_self_facilitator_log (ts DESC);
CREATE INDEX IF NOT EXISTS x402_self_facilitator_log_sig ON x402_self_facilitator_log (tx_sig);
CREATE INDEX IF NOT EXISTS x402_self_facilitator_log_action_ok ON x402_self_facilitator_log (action, ok, ts DESC);

CREATE TABLE IF NOT EXISTS x402_ring_ledger (
	id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	ts             timestamptz NOT NULL DEFAULT now(),
	kind           text NOT NULL,                        -- 'settle' | 'sweep' | 'fund'
	from_wallet    text,
	to_wallet      text,
	endpoint       text,                                 -- route paid (settle) or null (sweep)
	mint           text,
	amount_atomic  bigint NOT NULL DEFAULT 0,
	tx_sig         text,
	fee_lamports   bigint NOT NULL DEFAULT 0,
	run_id         uuid
);

CREATE INDEX IF NOT EXISTS x402_ring_ledger_ts ON x402_ring_ledger (ts DESC);
CREATE INDEX IF NOT EXISTS x402_ring_ledger_kind_ts ON x402_ring_ledger (kind, ts DESC);
CREATE INDEX IF NOT EXISTS x402_ring_ledger_sig ON x402_ring_ledger (tx_sig);

CREATE TABLE IF NOT EXISTS x402_ring_wallets (
	pubkey      text PRIMARY KEY,
	label       text,
	role        text NOT NULL DEFAULT 'payer',           -- 'payer' | 'treasury' | 'sponsor'
	enabled     boolean NOT NULL DEFAULT true,
	note        text,
	created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS x402_ring_wallets_role ON x402_ring_wallets (role, enabled);
