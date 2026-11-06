-- 20260703000000_x402_fee_audit.sql
--
-- Fee audit rollup for the closed-loop x402 ring economy.
--
-- The ring's operating rule is "the lowest fees ALWAYS". The Fee Audit + ATA
-- Rent Reclaim pipeline (api/_lib/x402/autonomous-registry.js → fee-audit,
-- implemented in api/_lib/x402/pipelines/fee-audit.js) runs nightly, sums the
-- REAL chain-read settlement fees for the day from x402_self_facilitator_log
-- (fee_lamports comes from getParsedTransaction().meta.fee, not an estimate)
-- plus the settlement + volume counts from x402_autonomous_log, and upserts one
-- row per day here. It also reclaims ATA rent by closing zero-balance non-role
-- ATAs, accumulating the reclaimed lamports + close count onto the same row.
--
-- Two efficiency numbers are the point of this table:
--   lamports_per_settlement — real SOL fee burned per settled payment. At the
--                             1-signature self-pay floor this is ~5,000; the
--                             pipeline alerts above 1.5× (7,500).
--   sol_per_100_usd         — SOL burned per $100 of gross ring volume, the
--                             headline "cost of moving a dollar" number.
--
-- The pipeline also creates this lazily (ensureSchema), so this migration is
-- belt-and-suspenders for environments that run db:migrate.
--
-- Downstream consumer: GET /api/x402-ring exposes the two efficiency metrics
-- (computed live from the same logs); this table is the durable daily history a
-- dashboard charts and the acceptance run reads.

CREATE TABLE IF NOT EXISTS x402_fee_audit (
	day                         date PRIMARY KEY,
	settlements                 bigint NOT NULL DEFAULT 0,
	gross_volume_atomic         numeric NOT NULL DEFAULT 0,
	fees_lamports               numeric NOT NULL DEFAULT 0,
	lamports_per_settlement     numeric,
	sol_per_100_usd             numeric,
	budget_lamports             numeric,
	above_floor                 boolean NOT NULL DEFAULT false,
	over_budget                 boolean NOT NULL DEFAULT false,
	ata_closed_count            int NOT NULL DEFAULT 0,
	ata_rent_reclaimed_lamports numeric NOT NULL DEFAULT 0,
	run_id                      uuid,
	updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS x402_fee_audit_day_desc ON x402_fee_audit (day DESC);
