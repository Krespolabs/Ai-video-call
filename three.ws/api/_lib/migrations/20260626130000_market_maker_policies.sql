-- Launch Copilot — autonomous fair-launch market-maker.
--
-- A coin launched via three.ws can attach a rules-based, NON-MANIPULATIVE
-- market-maker that runs from the launching agent's own audited wallet. The
-- policy is the published rulebook: a defended floor band, measured profit
-- recycling into strength, an inventory ceiling, a graduation action, hard
-- anti-manipulation caps (min interval between actions, max % of live volume),
-- and budgets. The engine (workers/agent-mm) only decides WHEN/HOW MUCH within
-- these limits, then routes every fill through the SAME firewall + spend-guard +
-- custody-audited path (executeAgentTrade) a manual trade uses — it adds no new
-- way to move funds. One policy per (mint, network).

begin;

create table if not exists market_maker_policies (
	id                          uuid primary key default gen_random_uuid(),
	mint                        text not null,
	network                     text not null default 'mainnet' check (network in ('mainnet','devnet')),
	agent_id                    uuid not null references agent_identities(id) on delete cascade,
	user_id                     uuid not null references users(id) on delete cascade,
	enabled                     boolean not null default false,
	-- A policy runs LIVE only when both the worker AND this flag are live; otherwise
	-- the full decision logic runs against real quotes but never signs/spends.
	mode                        text not null default 'simulate' check (mode in ('simulate','live')),
	preset                      text not null default 'custom' check (preset in ('gentle','balanced','aggressive','custom')),

	-- ── floor defense ─────────────────────────────────────────────────────────
	-- floor_price_sol is SOL per WHOLE token. Defend when the live price falls
	-- through floor_price_sol * (1 - floor_band_pct/100), buying a bounded slice.
	floor_price_sol             numeric(40, 18) not null check (floor_price_sol >= 0),
	floor_band_pct              numeric(6, 3)   not null default 5  check (floor_band_pct  >= 0 and floor_band_pct  <= 90),
	dip_buy_budget_lamports     numeric(40, 0)  not null default 0  check (dip_buy_budget_lamports >= 0),

	-- ── profit recycling ──────────────────────────────────────────────────────
	-- Sell recycle_pct of managed inventory into a spike above
	-- floor_price_sol * (1 + take_profit_band_pct/100), locking realized SOL.
	take_profit_band_pct        numeric(7, 3)   not null default 25 check (take_profit_band_pct >= 0),
	recycle_pct                 numeric(6, 3)   not null default 20 check (recycle_pct > 0 and recycle_pct <= 90),
	-- Token inventory ceiling (whole tokens). 0 = no cap. Above it the engine trims.
	max_inventory_tokens        numeric(40, 6)  not null default 0  check (max_inventory_tokens >= 0),

	-- ── seed (one-time initial buy from the agent wallet) ─────────────────────
	seed_lamports               numeric(40, 0)  not null default 0  check (seed_lamports >= 0),
	seed_done_at                timestamptz,

	-- ── graduation transition (curve → AMM) ──────────────────────────────────
	graduation_action           text not null default 'hold' check (graduation_action in ('provide_lp','hold','distribute')),
	graduation_done_at          timestamptz,
	graduation_status           text,            -- pending | done | failed:<reason>
	graduation_signature        text,

	-- ── budgets + execution ──────────────────────────────────────────────────
	daily_budget_lamports       numeric(40, 0)  not null default 0  check (daily_budget_lamports >= 0),
	slippage_bps                int             not null default 500 check (slippage_bps between 0 and 5000),
	max_price_impact_pct        numeric(6, 3)   not null default 8  check (max_price_impact_pct >= 0),

	-- ── anti-manipulation hard caps (codified + publicly disclosed) ───────────
	-- min_action_interval_seconds: the engine cannot act twice (and CANNOT cross
	-- sides) inside this window — the core anti-wash-trade gate. max_volume_pct:
	-- a single action is capped to this share of live market volume, so the MM can
	-- never dominate / paint the tape. Bounds are enforced again in code; a policy
	-- that requests values outside them is refused at create time.
	min_action_interval_seconds int             not null default 60 check (min_action_interval_seconds >= 30),
	max_volume_pct              numeric(6, 3)   not null default 15 check (max_volume_pct > 0 and max_volume_pct <= 33),
	kill_switch                 boolean         not null default false,

	-- ── engine-maintained runtime state ──────────────────────────────────────
	status                      text not null default 'idle'
		check (status in ('idle','active','paused','killed','graduated','error')),
	realized_pnl_lamports       numeric(40, 0) not null default 0,
	sol_deployed_lamports       numeric(40, 0) not null default 0,  -- gross SOL spent (seed + defense)
	sol_recovered_lamports      numeric(40, 0) not null default 0,  -- gross SOL recovered (recycle + distribute)
	inventory_tokens            numeric(40, 6),                     -- last observed managed inventory (whole tokens)
	inventory_value_lamports    numeric(40, 0),                     -- last observed inventory SOL value
	last_price_sol              numeric(40, 18),
	last_action_at              timestamptz,
	last_action_side            text check (last_action_side in ('buy','sell')),
	last_eval_at                timestamptz,
	last_error                  text,
	created_at                  timestamptz not null default now(),
	updated_at                  timestamptz not null default now(),

	unique (mint, network)
);

-- The worker's active work set: enabled policies on a network, not killed.
create index if not exists mm_policies_active_idx
	on market_maker_policies (network, status)
	where enabled = true and kill_switch = false;
create index if not exists mm_policies_owner_idx  on market_maker_policies (user_id, created_at desc);
create index if not exists mm_policies_agent_idx  on market_maker_policies (agent_id);

-- Transparent, append-only action log — every decision the engine took (or
-- skipped, and why). Drives the live action feed in the Launch Copilot UI and is
-- the honest record that the MM defended/recycled within its disclosed policy.
create table if not exists market_maker_actions (
	id               bigserial primary key,
	policy_id        uuid not null references market_maker_policies(id) on delete cascade,
	mint             text not null,
	network          text not null default 'mainnet',
	-- seed | defend_buy | recycle_sell | rebalance_trim
	-- | graduation_lp | graduation_distribute | graduation_hold | skip
	kind             text not null,
	side             text check (side in ('buy','sell')),
	trigger_reason   text,
	price_sol        numeric(40, 18),
	sol_lamports     numeric(40, 0),
	token_amount     numeric(40, 6),
	price_impact_pct numeric(7, 3),
	venue            text,           -- bonding_curve | amm | lp
	signature        text,
	custody_event_id bigint,
	status           text not null default 'executed'
		check (status in ('executed','simulated','skipped','failed','blocked')),
	detail           text,
	meta             jsonb not null default '{}'::jsonb,
	created_at       timestamptz not null default now()
);

create index if not exists mm_actions_policy_time_idx on market_maker_actions (policy_id, created_at desc);
create index if not exists mm_actions_mint_time_idx   on market_maker_actions (mint, network, created_at desc);
-- Material (non-skip) actions only — the audit/realized view skips the noisy
-- "held, nothing to do" rows the live feed shows.
create index if not exists mm_actions_material_idx
	on market_maker_actions (policy_id, created_at desc)
	where kind <> 'skip';

commit;
