-- Durable Privy identity link.
--
-- Until now the Privy login flow (api/auth/privy/verify.js) located returning
-- users by a synthetic email of the shape `privy-<did>@privy.local`. That made
-- the DID a string baked into an email column — impossible to query directly,
-- and brittle once a user also has a real email on the row.
--
-- privy_did stores the Privy DID (`did:privy:…`) as a first-class, unique key so
-- a returning user is resolved by exact DID match regardless of their email, and
-- an existing email/password user can link their Privy account without spawning
-- a duplicate row. Partial unique index allows many NULLs (non-Privy users).
alter table users add column if not exists privy_did text;
create unique index if not exists users_privy_did_unique
	on users(privy_did) where privy_did is not null;
