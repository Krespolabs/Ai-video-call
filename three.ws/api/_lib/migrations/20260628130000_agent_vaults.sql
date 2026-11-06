begin;

-- Back-an-Agent Vaults — copy-trade a 3D agent with a verifiable reputation
-- ==========================================================================
-- A reputation-verified agent's owner opens a vault; backers deposit USDC; the
-- agent trades the POOLED capital within hard, owner-and-protocol-enforced spend
-- limits; P&L is shared pro-rata via real share accounting; the owner earns a
-- transparent, disclosed performance fee charged only on a backer's realized
-- gain. Custody is real and segregated: each vault has its OWN custodial Solana
-- wallet (never co-mingled with the agent's personal wallet or another vault).
--
-- All money is stored as exact USDC atomic units (6 decimals) in numeric(40,0) —
-- never a float. Shares are unitless BigInt; the first deposit mints shares 1:1
-- with USDC atomics (initial share price = 1.000000 USDC), and every later
-- deposit/redemption is priced against live NAV. See api/_lib/vault-accounting.js
-- for the canonical (pure, unit-tested) math.

-- ── Vaults ──────────────────────────────────────────────────────────────────
-- One open vault per agent (a fork is a different agent_id → its own empty vault,
-- never co-mingled). `encrypted_secret` is the AES-256-GCM-encrypted secret key
-- of the vault's dedicated custodial wallet (api/_lib/secret-box.js), decrypted
-- only at signing time. `status` is the kill switch: only 'open' vaults accept
-- deposits or trade; 'paused' halts autonomous trading (owner pause OR an
-- automatic drawdown-breaker trip) while still allowing redemptions.
create table if not exists agent_vaults (
	id                       uuid primary key default gen_random_uuid(),
	agent_id                 uuid not null references agent_identities(id) on delete cascade,
	owner_user_id            uuid not null,
	network                  text not null default 'mainnet',
	vault_address            text not null,
	encrypted_secret         text not null,
	status                   text not null default 'open'
		check (status in ('open', 'paused', 'closing', 'closed')),
	-- Disclosed terms (set at open, editable by the owner while no capital is at risk
	-- of being mis-priced; the UI discloses every one of these at the moment of backing).
	performance_fee_bps      int  not null default 1000 check (performance_fee_bps between 0 and 5000),
	per_backer_cap_atomics   numeric(40,0)                 check (per_backer_cap_atomics is null or per_backer_cap_atomics > 0),
	max_drawdown_bps         int  not null default 2500 check (max_drawdown_bps between 100 and 9000),
	max_per_trade_atomics    numeric(40,0) not null         check (max_per_trade_atomics > 0),
	daily_budget_atomics     numeric(40,0) not null         check (daily_budget_atomics > 0),
	-- Live accounting state (re-derived from chain before every settlement, never trusted blindly).
	total_shares             numeric(40,0) not null default 0 check (total_shares >= 0),
	-- High-water mark for the DRAWDOWN circuit breaker, tracked as peak SHARE PRICE
	-- (NAV per share, scaled 1e6), NOT raw NAV: deposits/redemptions move NAV but
	-- not share price, so measuring drawdown on the share price isolates real
	-- trading losses and a big redemption can never falsely trip the breaker.
	peak_share_price_e6      numeric(40,0) not null default 0 check (peak_share_price_e6 >= 0),
	accrued_fee_atomics      numeric(40,0) not null default 0 check (accrued_fee_atomics >= 0),
	halt_reason              text,
	paused_at                timestamptz,
	created_at               timestamptz not null default now(),
	updated_at               timestamptz not null default now()
);

-- At most one non-closed vault per agent. A closed vault can be superseded by a
-- new one; an open/paused/closing one cannot be duplicated.
create unique index if not exists agent_vaults_one_active
	on agent_vaults (agent_id)
	where status <> 'closed';

create index if not exists agent_vaults_owner_idx on agent_vaults (owner_user_id, created_at desc);
create index if not exists agent_vaults_status_idx on agent_vaults (status, updated_at desc);

-- ── Backer positions ──────────────────────────────────────────────────────────
-- One row per (vault, backer). `shares` is the backer's current share balance;
-- `cost_basis_atomics` is their net principal still at risk (deposits minus the
-- cost basis already returned on redemptions) — the performance fee is charged
-- ONLY on realized gain above this basis, never on principal or on a loss.
-- `backer_agent_id` is the agent wallet the backer funds from / is paid back to
-- (a backer backs WITH one of their own agents' custodial USDC wallets).
create table if not exists vault_backers (
	id                    bigserial primary key,
	vault_id              uuid not null references agent_vaults(id) on delete cascade,
	user_id               uuid not null,
	backer_agent_id       uuid not null references agent_identities(id) on delete restrict,
	shares                numeric(40,0) not null default 0 check (shares >= 0),
	cost_basis_atomics    numeric(40,0) not null default 0 check (cost_basis_atomics >= 0),
	deposited_atomics     numeric(40,0) not null default 0 check (deposited_atomics >= 0),
	redeemed_atomics      numeric(40,0) not null default 0 check (redeemed_atomics >= 0),
	realized_gain_atomics numeric(40,0) not null default 0,
	fees_paid_atomics     numeric(40,0) not null default 0 check (fees_paid_atomics >= 0),
	created_at            timestamptz not null default now(),
	updated_at            timestamptz not null default now()
);

create unique index if not exists vault_backers_one_per_user
	on vault_backers (vault_id, user_id);
create index if not exists vault_backers_user_idx on vault_backers (user_id, updated_at desc);

-- ── Open token positions held by the vault ──────────────────────────────────────
-- Capital the vault has deployed out of USDC into a token. Marked to market via
-- real Jupiter quotes when computing NAV; closed (status='closed') on full exit.
create table if not exists vault_positions (
	id                    bigserial primary key,
	vault_id              uuid not null references agent_vaults(id) on delete cascade,
	mint                  text not null,
	token_decimals        int  not null default 0,
	amount_raw            numeric(40,0) not null default 0 check (amount_raw >= 0),
	cost_atomics          numeric(40,0) not null default 0 check (cost_atomics >= 0),
	realized_pnl_atomics  numeric(40,0) not null default 0,
	last_mark_atomics     numeric(40,0),
	status                text not null default 'open' check (status in ('open', 'closed')),
	opened_at             timestamptz not null default now(),
	closed_at             timestamptz,
	updated_at            timestamptz not null default now()
);

-- One open position per (vault, mint); a re-buy of the same mint adds to it.
create unique index if not exists vault_positions_open_mint
	on vault_positions (vault_id, mint)
	where status = 'open';
create index if not exists vault_positions_vault_idx on vault_positions (vault_id, status);

-- ── Vault event ledger (the full, immutable audit trail) ─────────────────────────
-- Every vault action — open, deposit, redeem, trade, fee accrual/claim, drawdown
-- halt, pause/resume, terms change, close — lands here with the on-chain signature
-- where one exists. This is what the owner-and-backer-facing audit feed renders and
-- what proves the vault never exceeded its mandate.
create table if not exists vault_events (
	id              bigserial primary key,
	vault_id        uuid not null references agent_vaults(id) on delete cascade,
	type            text not null check (type in (
		'open', 'deposit', 'redeem', 'trade', 'fee', 'fee_claim',
		'drawdown_halt', 'pause', 'resume', 'terms', 'close', 'nav'
	)),
	user_id         uuid,
	backer_agent_id uuid,
	shares_delta    numeric(40,0),
	atomics_delta   numeric(40,0),
	nav_atomics     numeric(40,0),
	share_price_e6  numeric(40,0),
	signature       text,
	status          text not null default 'ok' check (status in ('ok', 'pending', 'failed')),
	reason          text,
	idempotency_key text,
	meta            jsonb not null default '{}',
	created_at      timestamptz not null default now()
);

-- Idempotency: a deposit/redeem/trade keyed by an on-chain signature or client key
-- is recorded exactly once (a retry/replay is a silent no-op via ON CONFLICT).
create unique index if not exists vault_events_idem
	on vault_events (vault_id, idempotency_key)
	where idempotency_key is not null;

create index if not exists vault_events_feed_idx on vault_events (vault_id, id desc);
create index if not exists vault_events_type_idx on vault_events (vault_id, type, id desc);

commit;
