-- Fee Bridge: pay a pump.fun coin's creator fees to an X account in USDC.
--
-- A coin routes 100% of its creator fees (a pump.fun fee-sharing config) to the
-- three.ws fee-bridge wallet and names an X handle. /api/cron/fee-bridge cranks
-- each registered coin's distribution into the bridge wallet, converts the SOL to
-- USDC on Jupiter, spends 20% of it buying $THREE for the treasury, and credits the
-- other 80% to the handle. The handle's owner signs in with X and withdraws to their
-- Solana wallet; once linked, balances past the auto-payout floor are sent without
-- them asking. Docs: docs/fee-bridge.md.
--
-- Every on-chain step persists its signature and blockhash BEFORE broadcasting, so
-- a tick that dies mid-flight is resumed from the chain's answer, never re-sent.

-- Coins whose creator fees route to the bridge, and the handle they pay.
create table if not exists fee_bridge_coins (
	mint           text primary key,
	handle         text        not null,
	handle_lc      text        not null,
	quote_mint     text        not null,
	registered_by  uuid        references users(id) on delete set null,
	agent_id       uuid,
	admin_wallet   text,
	status         text        not null default 'active' check (status in ('active', 'unrouted')),
	last_crank_at  timestamptz,
	last_error     text,
	created_at     timestamptz not null default now(),
	updated_at     timestamptz not null default now()
);
create index if not exists fee_bridge_coins_handle_idx on fee_bridge_coins (handle_lc);
create index if not exists fee_bridge_coins_crank_idx on fee_bridge_coins (status, last_crank_at nulls first);

-- One row per distribution crank the bridge sent. The row is written as 'sent'
-- before broadcast and settled from the landed transaction: amount_raw is in the
-- quote mint's base units (lamports for SOL, atomics for USDC) and gas_lamports is
-- what the bridge spent landing it, charged back to that coin before conversion.
create table if not exists fee_bridge_inflows (
	id            uuid primary key default gen_random_uuid(),
	mint          text        not null references fee_bridge_coins(mint) on delete cascade,
	quote_mint    text        not null,
	status        text        not null default 'sent' check (status in ('sent', 'landed', 'dropped')),
	amount_raw    numeric(40) not null default 0 check (amount_raw >= 0),
	gas_lamports  bigint      not null default 0,
	signature     text        not null unique,
	blockhash     text        not null,
	batch_id      uuid,
	created_at    timestamptz not null default now(),
	landed_at     timestamptz
);
create index if not exists fee_bridge_inflows_unbatched_idx on fee_bridge_inflows (created_at) where batch_id is null and status = 'landed';
create index if not exists fee_bridge_inflows_sent_idx on fee_bridge_inflows (created_at) where status = 'sent';
create index if not exists fee_bridge_inflows_mint_idx on fee_bridge_inflows (mint, created_at desc);

-- A conversion run. Stages advance claimed -> swapped -> bought -> swept -> credited.
create table if not exists fee_bridge_batches (
	id                      uuid primary key default gen_random_uuid(),
	stage                   text        not null default 'claimed'
		check (stage in ('claimed', 'swapped', 'bought', 'swept', 'credited', 'failed')),
	sol_net_lamports        numeric(40) not null default 0,
	usdc_in_atomics         numeric(40) not null default 0,
	usdc_from_sol_atomics   numeric(40) not null default 0,
	buyback_usdc_atomics    numeric(40) not null default 0,
	three_bought_atomics    numeric(40) not null default 0,
	recipient_usdc_atomics  numeric(40) not null default 0,
	swap_sig                text,
	swap_blockhash          text,
	buy_sig                 text,
	buy_blockhash           text,
	sweep_sig               text,
	sweep_blockhash         text,
	error                   text,
	created_at              timestamptz not null default now(),
	updated_at              timestamptz not null default now(),
	completed_at            timestamptz
);
-- At most one conversion in flight: the second tick's insert fails instead of racing.
create unique index if not exists fee_bridge_batches_one_open_idx
	on fee_bridge_batches ((true)) where stage in ('claimed', 'swapped', 'bought', 'swept');
create index if not exists fee_bridge_batches_created_idx on fee_bridge_batches (created_at desc);

-- USDC credited to a handle by a completed batch.
create table if not exists fee_bridge_credits (
	id            uuid primary key default gen_random_uuid(),
	batch_id      uuid        not null references fee_bridge_batches(id) on delete cascade,
	mint          text        not null,
	handle_lc     text        not null,
	usdc_atomics  numeric(40) not null check (usdc_atomics >= 0),
	created_at    timestamptz not null default now(),
	unique (batch_id, mint)
);
create index if not exists fee_bridge_credits_handle_idx on fee_bridge_credits (handle_lc, created_at desc);

-- The X account a handle is bound to, pinned on its first payout so a renamed
-- handle taken over by someone else can never withdraw the original owner's balance.
create table if not exists fee_bridge_recipients (
	handle_lc   text primary key,
	handle      text        not null,
	x_user_id   text        not null unique,
	user_id     uuid        references users(id) on delete set null,
	bound_at    timestamptz not null default now()
);

-- USDC sent to a recipient wallet.
create table if not exists fee_bridge_payouts (
	id            uuid primary key default gen_random_uuid(),
	handle_lc     text        not null,
	user_id       uuid        references users(id) on delete set null,
	wallet        text        not null,
	usdc_atomics  numeric(40) not null check (usdc_atomics > 0),
	trigger       text        not null check (trigger in ('auto', 'withdraw')),
	status        text        not null default 'pending' check (status in ('pending', 'confirmed', 'failed')),
	signature     text,
	blockhash     text,
	error         text,
	created_at    timestamptz not null default now(),
	confirmed_at  timestamptz
);
-- One payout in flight per handle, so two withdraw clicks can never both spend a balance.
create unique index if not exists fee_bridge_payouts_one_pending_idx
	on fee_bridge_payouts (handle_lc) where status = 'pending';
create index if not exists fee_bridge_payouts_created_idx on fee_bridge_payouts (created_at desc);
create index if not exists fee_bridge_payouts_handle_idx on fee_bridge_payouts (handle_lc, created_at desc);
