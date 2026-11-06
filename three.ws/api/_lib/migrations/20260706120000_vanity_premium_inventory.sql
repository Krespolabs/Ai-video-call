begin;

-- Premium vanity-address inventory — grind-ahead, sell-from-stock
-- ==============================================================================
-- The live `vanity_grinder` MCP tool / /api/x402/vanity endpoint grind a fresh
-- keypair per request, in-process, capped at a 3-char pattern (~$0.05). Long
-- (4–5+ char) brandable prefixes are unreachable that way. This table is the
-- durable, sellable back-catalogue: keypairs ground AHEAD OF TIME on cheap batch
-- CPU (workers/vanity-grinder, GCP spot) and sold from stock instantly.
--
-- SECURITY — this table stores REAL Solana private keys. Two hard rules the
-- schema itself enforces as far as SQL can:
--   1. The secret is ONLY ever present as `secret_ciphertext`: AES-256-GCM (or a
--      GCP-KMS envelope) sealed by workers/vanity-grinder BEFORE the first write.
--      Plaintext never touches this table — see api/_lib/vanity-vault.js.
--   2. Single-use delivery is a state machine on `status`; the ciphertext is
--      nulled at (or after) reveal per `retention_days`. Once `revealed`, the
--      row is never served again (enforced server-side by an atomic UPDATE …
--      WHERE status guard in api/_lib/vanity-inventory-store.js).
--
-- Custody honesty: the platform generated these keys, so every delivery and the
-- listing UI tell the buyer plainly to treat a bought address as a token MINT or
-- to sweep assets to a self-generated wallet, never as a high-value treasury.

-- ── Grind batches — provenance + throughput for each spot run ─────────────────
-- One row per batch job (a Cloud Run Job execution / spot instance run). Lets the
-- inventory trace back to the run that produced it and records the economics
-- (throughput, vCPU-seconds, credit cost) documented in docs/gcp-credits.md.
create table if not exists vanity_grind_batches (
	id                 uuid primary key default gen_random_uuid(),
	label              text not null,
	-- Where it ran: 'local' (dev CPU), 'cloud-run-job', 'gce-spot-mig'.
	runner             text not null default 'cloud-run-job',
	instance_id        text,                       -- GCE/CloudRun execution id, if any
	vcpus              int,                         -- vCPUs the run used
	keys_per_sec       numeric(14,2),               -- measured throughput (whole run)
	total_attempts     numeric(40,0) not null default 0,
	found_count        int not null default 0,
	usd_cost_estimate  numeric(12,4),               -- credit $ this run consumed (may be 0 on preempt)
	preempted          boolean not null default false,
	started_at         timestamptz not null default now(),
	finished_at        timestamptz
);

-- ── Inventory — one row per pre-ground address ────────────────────────────────
create table if not exists vanity_inventory (
	id                 uuid primary key default gen_random_uuid(),
	-- Public Base58 address. UNIQUE so the same address is never double-listed and
	-- so an insert from a re-run batch is a safe idempotent no-op (ON CONFLICT).
	address            text not null unique,
	-- The pattern this address satisfies + how it was matched.
	prefix             text,
	suffix             text,
	ignore_case        boolean not null default false,
	pattern_label      text not null,              -- human label, e.g. "PUMP…", "…AGNT"
	format             text not null default 'keypair'
		check (format in ('keypair', 'mnemonic')),

	-- Difficulty / rarity (from src/solana/vanity/rarity.js at grind time). Drives
	-- the price curve. `difficulty_attempts` is the naive expected-attempt count.
	difficulty_attempts numeric(40,0) not null default 0,
	rarity_bits        numeric(10,2) not null default 0,
	rarity_tier        text not null default 'common',
	rarity_score       int not null default 0,

	-- SEALED secret. `secret_scheme` records the envelope so decryption picks the
	-- right opener: 'aes-256-gcm' (secret-box) or 'gcp-kms+aes-256-gcm' (envelope).
	-- NULL once destroyed. The 64-byte keypair (or mnemonic) is inside — never here
	-- in plaintext.
	secret_ciphertext  text,
	secret_scheme      text not null default 'aes-256-gcm',

	-- Delivery state machine. available → reserved → revealed (→ ciphertext
	-- destroyed). 'sold' is a terminal alias used if a purchase settled but the
	-- one-shot reveal was never fetched (buyer can still be re-served the SAME
	-- ciphertext until they reveal, then it's gone). 'destroyed' = ciphertext gone.
	status             text not null default 'available'
		check (status in ('available', 'reserved', 'sold', 'revealed', 'destroyed')),

	-- Difficulty-scaled list price (USDC, whole-dollar-ish; 6-dp for x402 atomics).
	price_usd          numeric(12,6) not null default 1,

	-- Purchase / delivery bookkeeping.
	purchaser          text,                        -- buyer identity (wallet / payment payer)
	payment_id         text,                        -- x402 payment id that bought it (replay key)
	batch_id           uuid references vanity_grind_batches(id) on delete set null,
	-- Days to keep the ciphertext AFTER reveal. 0 = destroy immediately at reveal
	-- (the default — delete-after-reveal). >0 keeps it that many days for the buyer
	-- to re-pull, then a sweep (scripts/vanity-inventory-load.mjs --sweep) nulls it.
	retention_days     int not null default 0 check (retention_days >= 0),

	reserved_at        timestamptz,
	sold_at            timestamptz,
	revealed_at        timestamptz,
	destroyed_at       timestamptz,
	created_at         timestamptz not null default now(),
	updated_at         timestamptz not null default now()
);

-- Fast "browse available, cheapest/rarest first" and pattern filtering.
create index if not exists vanity_inventory_status_idx    on vanity_inventory (status);
create index if not exists vanity_inventory_available_idx  on vanity_inventory (status, rarity_score desc) where status = 'available';
create index if not exists vanity_inventory_prefix_idx     on vanity_inventory (prefix) where prefix is not null;
create index if not exists vanity_inventory_payment_idx    on vanity_inventory (payment_id) where payment_id is not null;

commit;
