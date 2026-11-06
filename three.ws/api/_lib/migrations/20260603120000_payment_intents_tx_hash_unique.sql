-- Harden plan_payment_intents against payment replay.
--
-- Before this, the EVM confirm path accepted any USDC transfer to the shared
-- treasury of >= the plan price, with no uniqueness on tx_hash. An attacker
-- could observe any public transfer to the treasury and confirm it against
-- their own intent (free upgrade), and the same tx could be replayed across
-- many intents. This index makes a single on-chain tx confirmable at most once.
--
-- Idempotent.

BEGIN;

-- A confirmed tx_hash may back at most one intent. Pending rows have
-- tx_hash = NULL and are unaffected (NULLs are distinct in a unique index).
CREATE UNIQUE INDEX IF NOT EXISTS payment_intents_tx_hash_unique
    ON plan_payment_intents (chain_type, tx_hash)
    WHERE tx_hash IS NOT NULL;

COMMIT;
