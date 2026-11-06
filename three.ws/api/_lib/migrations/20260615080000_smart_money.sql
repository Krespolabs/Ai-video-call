-- Migration: Smart Money Radar — a first-party pump.fun wallet reputation graph.
-- Apply: psql "$DATABASE_URL" -f api/_lib/migrations/20260615080000_smart_money.sql
--        (or `npm run db:migrate`). Idempotent.
--
-- The edge: judge a coin by WHO is buying it. We already observe every coin's
-- per-wallet footprint (pump_coin_wallets) and we know which coins actually won
-- (pumpfun_graduations = the coin reached Raydium). Cross those over time and
-- each wallet earns a track record: how often it's an early buyer of eventual
-- graduates, vs how often it sprays into duds or dumps on the people following
-- it. That reputation, applied live to a fresh launch, is the highest-signal
-- "should I buy this" the platform can produce — and only we can compute it in
-- real time because we have full-coverage trade data.
--
-- Read-only on the engine's tables; everything below is this system's own.
-- Mainnet-only (that is where pump.fun lives). Lamports in numeric(40,0).

begin;

-- One row per wallet: its accumulated, idempotently-folded track record.
create table if not exists wallet_reputation (
    wallet                text not null,
    network               text not null default 'mainnet' check (network in ('mainnet','devnet')),

    coins_traded          int not null default 0,   -- coins (judged) this wallet bought
    early_entries         int not null default 0,   -- of those, bought within the early window
    wins                  int not null default 0,   -- bought a coin that later graduated
    early_wins            int not null default 0,   -- early AND graduated
    duds                  int not null default 0,   -- bought a coin judged dead (never graduated)
    dumps                 int not null default 0,   -- sold ≥ half its buy inside the window
    creator_count         int not null default 0,   -- coins this wallet created
    creator_wins          int not null default 0,   -- of those, graduated
    buy_volume_lamports   numeric(40,0) not null default 0,

    win_rate              numeric not null default 0,  -- wins / (wins+duds) %
    early_win_rate        numeric not null default 0,  -- early_wins / early_entries %
    dump_rate             numeric not null default 0,  -- dumps / (wins+duds) %
    smart_money_score     numeric not null default 0,  -- 0..100 composite
    label                 text not null default 'unproven',
                            -- smart_money | sniper | dumper | rugger | fresh | neutral | unproven

    first_seen_at         timestamptz not null default now(),
    last_active_at        timestamptz,
    updated_at            timestamptz not null default now(),
    primary key (wallet, network)
);

create index if not exists wallet_reputation_score
    on wallet_reputation (network, smart_money_score desc);
create index if not exists wallet_reputation_label
    on wallet_reputation (network, label, smart_money_score desc);

-- One row per recent/live coin: how much proven money is in it right now.
create table if not exists coin_smart_money (
    mint                  text not null,
    network               text not null default 'mainnet' check (network in ('mainnet','devnet')),
    symbol                text,
    name                  text,
    image_uri             text,
    category              text,

    smart_money_score     numeric not null default 0,  -- 0..100, pedigree-weighted
    smart_wallet_count    int not null default 0,       -- # proven (≥70) wallets buying
    proven_buy_lamports   numeric(40,0) not null default 0,
    total_buy_lamports    numeric(40,0) not null default 0,
    notable               jsonb not null default '[]'::jsonb,  -- [{wallet,label,score,buy_sol}]

    coin_first_seen_at    timestamptz,
    graduated             boolean not null default false,
    scored_at             timestamptz not null default now(),
    primary key (mint, network)
);

create index if not exists coin_smart_money_feed
    on coin_smart_money (network, graduated, smart_money_score desc, scored_at desc);

-- Idempotency cursor: a coin's wallets are folded into reputation exactly once.
create table if not exists smart_money_scored (
    mint                  text not null,
    network               text not null default 'mainnet',
    outcome               text not null check (outcome in ('graduated','dud')),
    scored_at             timestamptz not null default now(),
    primary key (mint, network)
);

commit;
