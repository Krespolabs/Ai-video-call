-- 20260917200000_x402_pending_settlements.sql
--
-- Non-binary x402 settlement: the durable record of a payment whose transaction
-- is broadcast but whose confirmation is not yet known.
--
-- Before this table a settle had exactly two outcomes. A confirmation wait that
-- ran out returned `not_confirmed:confirm_timeout`, which the resource server
-- mapped to a 502, so a transaction that landed a second after the wait gave up
-- was reported to the buyer as a failed payment while the chain said they had
-- paid. Solana's x402 rail now carries a third outcome, `settlement_pending`
-- (Coinbase facilitator, 2026-09-17): broadcast, outcome unknown, retry rather
-- than fail. Holding that state requires somewhere durable to hold it.
--
-- Two scopes share the table because both sides of our rail need the same record
-- for different reasons:
--
--   scope='facilitator': keyed by the payment payload, so a settle retry for the
--                         SAME payload reconciles against the signature already
--                         broadcast instead of verifying and broadcasting a second
--                         transaction. This is the x402 PendingSettlementStore
--                         contract (@x402/core/facilitator). Cloud Run runs several
--                         replicas with no session affinity, so the SDK's in-memory
--                         default store would miss every retry that lands on another
--                         instance; Postgres is the shared implementation the
--                         interface exists to allow.
--   scope='resource':    keyed by the settle idempotency key, so the reconcile cron
--                         (/api/cron/x402-settlement-reconcile) can finish the job
--                         after the response has already been sent: confirm the
--                         signature, claim the settle credit exactly once, and meter
--                         the SOL burn. Without this row a pending settle would be
--                         delivered and then forgotten, which is worse than the 502
--                         it replaces.
--
-- `state` is the reconciliation outcome, never a guess: 'pending' until the chain
-- answers, then 'confirmed' (signature landed, no error), 'failed' (landed with an
-- on-chain error), or 'abandoned' (never observable within the reconcile horizon,
-- i.e. the blockhash expired and the transaction was dropped without landing).

CREATE TABLE IF NOT EXISTS x402_pending_settlements (
	scope           text NOT NULL,                       -- 'facilitator' | 'resource'
	key             text NOT NULL,                       -- deterministic key derived from the payment payload
	tx_sig          text NOT NULL,                       -- the broadcast signature whose fate is unknown
	network         text,
	payer           text,
	pay_to          text,
	mint            text,
	amount_atomic   bigint,
	fee_lamports    bigint,                              -- estimated SOL burn, metered on confirmation
	fee_payer       text,                                -- wallet that pays the network fee (sponsor or self-pay buyer)
	resource_url    text,                                -- the paid resource, for the ops trail
	idempotency_key text,
	state           text NOT NULL DEFAULT 'pending',     -- 'pending' | 'confirmed' | 'failed' | 'abandoned'
	attempts        integer NOT NULL DEFAULT 0,          -- reconcile passes that have looked at this row
	last_error      text,
	created_at      timestamptz NOT NULL DEFAULT now(),
	updated_at      timestamptz NOT NULL DEFAULT now(),
	resolved_at     timestamptz,
	PRIMARY KEY (scope, key)
);

-- The reconcile cron's only query shape: oldest unresolved rows first.
CREATE INDEX IF NOT EXISTS x402_pending_settlements_open
	ON x402_pending_settlements (state, created_at)
	WHERE state = 'pending';

-- Signature lookups: "did this payment ever resolve?" from an ops dashboard or a
-- buyer support question.
CREATE INDEX IF NOT EXISTS x402_pending_settlements_sig
	ON x402_pending_settlements (tx_sig);
