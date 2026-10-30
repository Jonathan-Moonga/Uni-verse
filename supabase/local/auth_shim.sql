-- LOCAL DEVELOPMENT ONLY. Do not run against Supabase.
--
-- Recreates the small slice of Supabase's platform that the Tiger Ops migration
-- depends on (API roles, auth.users, auth.uid()) so the same migration can run
-- unchanged on PGlite. Email tokens stand in for GoTrue's confirmation and
-- recovery links while developing locally.

create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;

create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  -- scrypt here; Supabase uses bcrypt. Local passwords do not migrate.
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}',
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now()
);

create function auth.uid() returns uuid
language sql stable as $$
  select nullif(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub', '')::uuid
$$;

grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema local;

create table local.email_tokens (
  token_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  purpose text not null check (purpose in ('verify_email', 'reset_password')),
  expires_at timestamptz not null,
  used_at timestamptz
);

create table local.migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);
