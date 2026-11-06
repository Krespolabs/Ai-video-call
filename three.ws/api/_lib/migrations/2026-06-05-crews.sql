-- Migration: crews (clans) — persistent, account-keyed player groups for the
-- /play world (W09). A crew is a named group with a short tag shown over members'
-- avatars and on their profiles. Membership is keyed to accounts (users.id), not
-- ephemeral session ids, so a crew and its roster survive reconnects, realm
-- changes, and server restarts — exactly like the friends graph it sits beside.
--
-- Presence (which member is online / where) is volatile and already lives in
-- Redis (api/_lib/presence-store.js); only the durable crew identity, roster, and
-- pending invites live here.

begin;

-- A crew. `tag` is the short badge ("3WS", "NOVA") rendered in-world and on
-- profiles; it is unique case-insensitively so "nova" and "NOVA" can't collide.
-- `owner_id` is the founder; ownership can pass to another member on leave (see
-- crews-store.leaveCrew) so a crew is never orphaned while it still has members.
create table if not exists crews (
  id          uuid primary key default gen_random_uuid(),
  tag         text not null,
  name        text not null,
  owner_id    uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  constraint crews_tag_len  check (char_length(tag) between 2 and 6),
  constraint crews_name_len check (char_length(name) between 2 and 32)
);
-- Case-insensitive uniqueness on the tag without depending on the citext
-- extension — a plain functional unique index over lower(tag).
create unique index if not exists crews_tag_lower_uniq on crews (lower(tag));

-- Crew membership. One row per (crew, account). An account belongs to at most one
-- crew at a time — enforced by a unique index on account_id (a member can't sit
-- in two crews). `role` is 'owner' | 'member'; the owner row mirrors crews.owner_id.
create table if not exists crew_members (
  crew_id     uuid not null references crews(id) on delete cascade,
  account_id  uuid not null references users(id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'member')),
  joined_at   timestamptz not null default now(),
  primary key (crew_id, account_id)
);
-- "what crew is this account in" (one) + the in-world tag lookup at ticket-sign
-- time both key off account_id, and the unique-ness enforces one-crew-per-account.
create unique index if not exists crew_members_account_uniq on crew_members (account_id);

-- A pending invite from a crew (sent by `inviter_id`, an existing member) to
-- `invitee_id`. Accepting inserts a crew_members row and deletes the invite;
-- declining just deletes it. Unique per (crew, invitee) so an invite can't stack.
create table if not exists crew_invites (
  crew_id     uuid not null references crews(id) on delete cascade,
  inviter_id  uuid not null references users(id) on delete cascade,
  invitee_id  uuid not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (crew_id, invitee_id)
);
-- "my pending crew invites" keys off the invitee.
create index if not exists crew_invites_invitee_idx on crew_invites (invitee_id);

commit;
