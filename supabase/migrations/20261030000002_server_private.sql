-- Server-side state for the Tiger Ops web server: browser sessions and outgoing
-- email. Lives in a schema the Supabase Data API does not expose, and API roles
-- get no privileges on it; only the server's direct database connection reads it.

create schema if not exists server_private;
revoke all on schema server_private from public, anon, authenticated;

create table server_private.sessions (
  token_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  user_agent text
);

create index sessions_user_idx on server_private.sessions (user_id);
create index sessions_expiry_idx on server_private.sessions (expires_at);

create table server_private.outbox (
  id bigint generated always as identity primary key,
  to_email text not null,
  subject text not null,
  body text not null,
  link text,
  delivered_via text,
  created_at timestamptz not null default now()
);

alter table server_private.sessions enable row level security;
alter table server_private.outbox enable row level security;

-- Supabase grants API roles access to new objects in `public` by default. Tiger Ops
-- grants explicitly in each migration instead, so future tables start closed.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated, public;
