-- Real-funds agreement signatures: the evidentiary record that a person signed
-- the Terms of Service, the Risk Disclosure, and the Agent Wallet Agreement
-- before any real-funds action. Written by POST /api/legal/risk-ack and read by
-- requireRealFundsAgreement() (api/_lib/real-funds-agreement.js), which refuses
-- money-moving API calls from an account with no current signature on file.
--
-- Append-only by design: a newer signature is a new row, nothing is updated or
-- deleted. user_id deliberately has no foreign key, so a signature survives the
-- deletion of the account that made it (the Agent Wallet Agreement promises the
-- record is kept as long as the law requires). Anonymous signatures (a visitor
-- funding someone else's agent before signing in) carry a null user_id.
--
-- documents holds, per document, the version signed and the sha256 of that
-- document's text as served when it was signed:
--   {"tos":{"version":3,"sha256":"…"},"risk":{…},"agentWallet":{…}}
create table if not exists legal_signatures (
	id              uuid        primary key default gen_random_uuid(),
	user_id         uuid,
	bundle_version  int         not null,
	documents       jsonb       not null,
	signature_name  text        not null,
	attestations    jsonb       not null,
	context         text,
	path            text,
	ip              text,
	user_agent      text,
	created_at      timestamptz not null default now()
);

create index if not exists legal_signatures_user_idx
	on legal_signatures (user_id, bundle_version desc, created_at desc)
	where user_id is not null;
