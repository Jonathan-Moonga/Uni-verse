-- Tiger Ops core schema for Supabase (Postgres 15+).
--
-- Authorization lives in the database: every table has row-level security, and
-- the policy helpers in the `app` schema mirror permissions.js. The browser and
-- the local server are never trusted to filter records.
--
-- Depends on Supabase's `auth` schema (auth.users, auth.uid()) and the
-- `anon` / `authenticated` roles. supabase/local/auth_shim.sql provides the same
-- surface for local development on PGlite.

create schema if not exists app;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.profile_status as enum ('pending_verification', 'active', 'suspended', 'expired');
create type public.invitation_status as enum ('pending', 'accepted', 'revoked', 'expired');
create type public.scope_mode as enum ('own', 'assigned', 'subtree');
create type public.work_order_status as enum ('triage', 'assigned', 'in_progress', 'waiting_parts', 'completed', 'cancelled');
create type public.work_order_priority as enum ('routine', 'urgent', 'emergency');

-- ---------------------------------------------------------------------------
-- Reference data (seeded from data.js by scripts/generate-seed.mjs)
-- ---------------------------------------------------------------------------

create table public.org_units (
  id text primary key,
  name text not null,
  parent_id text references public.org_units (id),
  kind text not null,
  source text not null default 'pilot' check (source in ('public', 'pilot')),
  -- Hierarchical access does not flow through a sensitive unit without an explicit grant.
  sensitive boolean not null default false
);

create table public.buildings (
  id text primary key,
  map_no integer unique,
  name text not null,
  type text not null,
  map_x integer,
  map_y integer,
  floors integer check (floors is null or floors between 1 and 40),
  capacity integer,
  layout text,
  hall_group text,
  gender text,
  owner_org_id text references public.org_units (id),
  offline boolean not null default false,
  capacity_note text
);

create table public.role_templates (
  key text primary key,
  label text not null,
  level text not null,
  permissions text[] not null default '{}',
  default_scope_org_id text references public.org_units (id),
  scope_mode public.scope_mode not null,
  aggregate_only boolean not null default false,
  read_only boolean not null default false,
  building_scoped boolean not null default false,
  sensitive_grants text[] not null default '{}',
  -- Role keys this role may invite and manage. Prevents privilege escalation.
  can_invite text[] not null default '{}',
  max_access_days integer check (max_access_days is null or max_access_days > 0),
  self_signup boolean not null default false,
  explanation text not null default ''
);

create table public.allowed_email_domains (
  domain text primary key check (domain = lower(domain)),
  kind text not null check (kind in ('student', 'staff')),
  -- Role granted on self-signup. Null means invitation required.
  default_role text references public.role_templates (key)
);

-- ---------------------------------------------------------------------------
-- People
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null unique check (email = lower(email)),
  full_name text not null check (char_length(full_name) between 1 and 120),
  role_key text not null references public.role_templates (key),
  org_unit_id text references public.org_units (id),
  scope_org_id text references public.org_units (id),
  building_ids text[] not null default '{}',
  home_building_id text references public.buildings (id),
  home_room text check (home_room is null or char_length(home_room) <= 16),
  permissions text[] not null,
  status public.profile_status not null default 'active',
  access_expires_at timestamptz,
  invited_by uuid references public.profiles (id) on delete set null,
  invitation_id uuid,
  last_sign_in_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index profiles_org_unit_idx on public.profiles (org_unit_id);
create index profiles_home_building_idx on public.profiles (home_building_id);

create table public.invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null check (email = lower(email)),
  full_name text,
  role_key text not null references public.role_templates (key),
  org_unit_id text not null references public.org_units (id),
  building_ids text[] not null default '{}',
  permissions text[] not null,
  -- Length of the access grant once accepted. Null means no expiry.
  access_days integer check (access_days is null or access_days between 1 and 1825),
  token_hash text not null unique,
  status public.invitation_status not null default 'pending',
  -- Null means a system invitation (bootstrapping the first administrators).
  invited_by uuid references public.profiles (id) on delete set null,
  note text check (note is null or char_length(note) <= 500),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now()
);

create unique index invitations_one_pending_per_email on public.invitations (email) where status = 'pending';

alter table public.profiles
  add constraint profiles_invitation_fk foreign key (invitation_id) references public.invitations (id) on delete set null;

-- ---------------------------------------------------------------------------
-- Work
-- ---------------------------------------------------------------------------

create sequence public.work_order_number_seq start 1100;

create table public.work_orders (
  id uuid primary key default gen_random_uuid(),
  number integer not null unique default nextval('public.work_order_number_seq'),
  title text not null check (char_length(title) between 3 and 120),
  description text not null check (char_length(description) between 1 and 2000),
  category text not null,
  priority public.work_order_priority not null default 'routine',
  status public.work_order_status not null default 'triage',
  org_id text not null references public.org_units (id),
  building_id text not null references public.buildings (id),
  room text not null default '' check (char_length(room) <= 40),
  requester_id uuid references public.profiles (id) on delete set null,
  assignee_id uuid references public.profiles (id) on delete set null,
  entry_allowed boolean not null default false,
  source text,
  due_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter sequence public.work_order_number_seq owned by public.work_orders.number;

create index work_orders_org_idx on public.work_orders (org_id);
create index work_orders_building_idx on public.work_orders (building_id, room);
create index work_orders_requester_idx on public.work_orders (requester_id);
create index work_orders_assignee_idx on public.work_orders (assignee_id);

-- Internal notes stay with staff; public notes are progress updates the requester sees.
create table public.work_order_notes (
  id uuid primary key default gen_random_uuid(),
  work_order_id uuid not null references public.work_orders (id) on delete cascade,
  author_id uuid references public.profiles (id) on delete set null,
  body text not null check (char_length(body) between 1 and 2000),
  visibility text not null default 'internal' check (visibility in ('internal', 'public')),
  created_at timestamptz not null default now()
);

create index work_order_notes_order_idx on public.work_order_notes (work_order_id, created_at);

create table public.audit_events (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor_id uuid references public.profiles (id) on delete set null,
  actor_label text not null,
  action text not null,
  target_type text not null,
  target_id text,
  target_label text,
  detail text,
  org_id text references public.org_units (id),
  metadata jsonb not null default '{}'
);

create index audit_events_at_idx on public.audit_events (at desc);

-- ---------------------------------------------------------------------------
-- Policy helpers (mirror permissions.js)
-- ---------------------------------------------------------------------------

create type app.actor_context as (
  id uuid,
  email text,
  full_name text,
  role_key text,
  permissions text[],
  org_unit_id text,
  scope_org_id text,
  building_ids text[],
  home_building_id text,
  scope_mode public.scope_mode,
  aggregate_only boolean,
  read_only boolean,
  building_scoped boolean,
  sensitive_grants text[],
  can_invite text[]
);

-- The signed-in, active, unexpired profile. All fields null otherwise.
create function app.actor() returns app.actor_context
language sql stable security definer set search_path = '' as $$
  select p.id, p.email, p.full_name, p.role_key, p.permissions, p.org_unit_id, p.scope_org_id,
         p.building_ids, p.home_building_id, r.scope_mode, r.aggregate_only, r.read_only,
         r.building_scoped, r.sensitive_grants, r.can_invite
  from public.profiles p
  join public.role_templates r on r.key = p.role_key
  where p.id = auth.uid()
    and p.status = 'active'
    and (p.access_expires_at is null or p.access_expires_at > now())
$$;

-- Security invoker on purpose: true only for database owners and the service role.
create function app.is_service() returns boolean
language sql stable set search_path = '' as $$
  select current_user in ('postgres', 'service_role', 'supabase_admin')
      or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role'
$$;

create function app.has_permission(p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_permission = any ((app.actor()).permissions), false)
$$;

-- Plain hierarchy containment, used for people management.
create function app.org_within(p_root text, p_target text) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select o.id, o.parent_id from public.org_units o where o.id = p_target
    union all
    select o.id, o.parent_id from public.org_units o join up on o.id = up.parent_id
  )
  select p_root is not null and exists (select 1 from up where up.id = p_root)
$$;

-- Containment that stops at sensitive units unless granted (records access).
create function app.org_in_scope(p_root text, p_target text, p_grants text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select o.id, o.parent_id, o.sensitive from public.org_units o where o.id = p_target
    union all
    select o.id, o.parent_id, o.sensitive from public.org_units o join up on o.id = up.parent_id
    where up.id <> p_root
  )
  select p_root is not null
     and exists (select 1 from up where up.id = p_root)
     and not exists (
       select 1 from up
       where up.id <> p_root and up.sensitive and not (up.id = any (coalesce(p_grants, '{}'::text[])))
     )
$$;

create function app.can_access_work_order(w public.work_orders, p_action text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  if a.id is null then
    return false;
  end if;

  if p_action = 'view' then
    if a.aggregate_only or not ('work_order:view' = any (a.permissions)) then
      return false;
    end if;
    -- Building-scoped contributors can always follow requests they filed.
    if a.scope_mode = 'subtree' and w.requester_id = a.id then
      return true;
    end if;
  elsif p_action = 'update' then
    if a.read_only or not ('work_order:update' = any (a.permissions)) then
      return false;
    end if;
  elsif p_action = 'assign' then
    if a.read_only or not ('work_order:assign' = any (a.permissions)) or a.scope_mode <> 'subtree' then
      return false;
    end if;
  else
    return false;
  end if;

  -- coalesce: a NULL here would read as "not denied" inside NOT/IF checks.
  return coalesce(case a.scope_mode
    when 'own' then w.requester_id = a.id
    when 'assigned' then w.assignee_id = a.id
    when 'subtree' then
      app.org_in_scope(a.scope_org_id, w.org_id, a.sensitive_grants)
      and (not a.building_scoped or w.building_id = any (a.building_ids))
    else false
  end, false);
end;
$$;

create function app.can_create_work_order(w public.work_orders) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  if a.id is null or a.read_only or not ('work_order:create' = any (a.permissions)) or w.requester_id is distinct from a.id then
    return false;
  end if;
  if a.scope_mode = 'own' and a.home_building_id is not null then
    return w.building_id = a.home_building_id;
  end if;
  if a.building_scoped then
    return w.building_id = any (a.building_ids);
  end if;
  return true;
end;
$$;

-- Routing: IT to the help desk, residence halls to nested Housing Maintenance,
-- a restricted unit's own building to its own queue, everything else to Facilities.
create function app.route_work_order(p_category text, p_building_id text, p_actor app.actor_context) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_category = 'IT support' then 'it-help-desk'
    when b.type = 'residence' then 'housing-maintenance'
    when o.sensitive and p_actor.scope_org_id = b.owner_org_id then b.owner_org_id
    else 'facilities-management'
  end
  from public.buildings b
  left join public.org_units o on o.id = b.owner_org_id
  where b.id = p_building_id
$$;

-- Assignees must be active operational staff inside the assigner's own scope.
create function app.is_assignable(p_profile_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  if a.id is null then
    return false;
  end if;
  return exists (
    select 1
    from public.profiles p
    join public.role_templates r on r.key = p.role_key
    where p.id = p_profile_id
      and p.status = 'active'
      and (p.access_expires_at is null or p.access_expires_at > now())
      and 'work_order:update' = any (p.permissions)
      and not r.read_only
      and p.org_unit_id is not null
      and app.org_in_scope(a.scope_org_id, p.org_unit_id, a.sensitive_grants)
  );
end;
$$;

create function app.can_see_profile(t public.profiles) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  if a.id is null then
    return false;
  end if;
  if t.id = a.id then
    return true;
  end if;
  if not ('people:view' = any (a.permissions)) then
    return false;
  end if;
  if t.org_unit_id is not null then
    return app.org_within(a.scope_org_id, t.org_unit_id)
       and (not a.building_scoped or t.building_ids && a.building_ids);
  end if;
  -- Students: only roles that may see resident identity, within their halls.
  return 'resident:view_identity' = any (a.permissions)
     and (not a.building_scoped or t.home_building_id = any (a.building_ids));
end;
$$;

create function app.can_manage_profile(t public.profiles) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  return a.id is not null
     and t.id <> a.id
     and 'people:manage' = any (a.permissions)
     and t.role_key = any (a.can_invite)
     and app.can_see_profile(t);
end;
$$;

-- Takes fields rather than the row: the row includes token_hash, which API roles cannot read.
create function app.can_see_invitation(p_invited_by uuid, p_org_unit_id text, p_building_ids text[]) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  if a.id is null then
    return false;
  end if;
  return coalesce(p_invited_by = a.id, false)
      or ('people:view' = any (a.permissions)
          and app.org_within(a.scope_org_id, p_org_unit_id)
          and (not a.building_scoped or p_building_ids && a.building_ids));
end;
$$;

create function app.can_see_audit(e public.audit_events) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
begin
  if a.id is null then
    return false;
  end if;
  if 'audit:view:institution' = any (a.permissions) then
    return true;
  end if;
  if 'audit:view:department' = any (a.permissions) then
    return e.org_id is not null and app.org_in_scope(a.scope_org_id, e.org_id, a.sensitive_grants);
  end if;
  return false;
end;
$$;

create function app.profile_label(p_profile_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select full_name from public.profiles where id = p_profile_id), 'System')
$$;

create function app.write_audit(
  p_action text, p_target_type text, p_target_id text, p_target_label text,
  p_detail text, p_org_id text, p_metadata jsonb default '{}'
) returns void
language sql security definer set search_path = '' as $$
  insert into public.audit_events (actor_id, actor_label, action, target_type, target_id, target_label, detail, org_id, metadata)
  values (auth.uid(), app.profile_label(auth.uid()), p_action, p_target_type, p_target_id, p_target_label, p_detail, p_org_id, p_metadata)
$$;

create function app.hash_token(p_token text) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
$$;

-- 256 bits from pg_strong_random via two v4 UUIDs (no pgcrypto dependency).
create function app.new_token() returns text
language sql volatile set search_path = '' as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

-- ---------------------------------------------------------------------------
-- Work order triggers
-- ---------------------------------------------------------------------------

create function app.before_work_order_insert() returns trigger
language plpgsql set search_path = '' as $$
declare
  a app.actor_context;
begin
  if app.is_service() then
    return new;
  end if;
  a := app.actor();
  if a.id is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  -- The server decides ownership, routing, and lifecycle fields; clients cannot.
  new.requester_id := a.id;
  new.org_id := app.route_work_order(new.category, new.building_id, a);
  if new.org_id is null then
    raise exception 'UNKNOWN_BUILDING' using errcode = '22023';
  end if;
  new.status := 'triage';
  new.assignee_id := null;
  new.created_at := now();
  new.updated_at := now();
  new.completed_at := null;
  new.due_at := now() + case new.priority when 'routine' then interval '48 hours' else interval '8 hours' end;
  new.source := coalesce(nullif(new.source, ''), 'Tiger Ops');
  return new;
end;
$$;

create function app.before_work_order_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if app.is_service() then
    new.updated_at := now();
    return new;
  end if;
  if (new.id, new.number, new.title, new.description, new.category, new.org_id, new.building_id,
      new.room, new.requester_id, new.entry_allowed, new.source, new.created_at)
     is distinct from
     (old.id, old.number, old.title, old.description, old.category, old.org_id, old.building_id,
      old.room, old.requester_id, old.entry_allowed, old.source, old.created_at) then
    raise exception 'WORK_ORDER_FIELDS_LOCKED' using errcode = '42501';
  end if;
  if new.assignee_id is distinct from old.assignee_id
     or new.priority is distinct from old.priority
     or new.due_at is distinct from old.due_at then
    if app.can_access_work_order(old, 'assign') is not true then
      raise exception 'ASSIGN_DENIED' using errcode = '42501';
    end if;
    if new.assignee_id is not null and app.is_assignable(new.assignee_id) is not true then
      raise exception 'ASSIGNEE_OUT_OF_SCOPE' using errcode = '42501';
    end if;
  end if;
  if new.status is distinct from old.status and app.can_access_work_order(old, 'update') is not true then
    raise exception 'UPDATE_DENIED' using errcode = '42501';
  end if;
  if new.assignee_id is not null and new.status = 'triage' then
    new.status := 'assigned';
  end if;
  if new.status = 'completed' and old.status <> 'completed' then
    new.completed_at := now();
  elsif new.status <> 'completed' then
    new.completed_at := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create function app.audit_work_order() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  changes text[] := '{}';
begin
  if tg_op = 'INSERT' then
    perform app.write_audit('Created request', 'work_order', new.id::text, 'WO-' || new.number, new.title, new.org_id);
    return new;
  end if;
  if new.status is distinct from old.status then
    changes := changes || format('%s → %s', initcap(replace(old.status::text, '_', ' ')), initcap(replace(new.status::text, '_', ' ')));
  end if;
  if new.assignee_id is distinct from old.assignee_id then
    changes := changes || format('%s → %s',
      coalesce((select full_name from public.profiles where id = old.assignee_id), 'Unassigned'),
      coalesce((select full_name from public.profiles where id = new.assignee_id), 'Unassigned'));
  end if;
  if new.priority is distinct from old.priority then
    changes := changes || format('Priority %s → %s', old.priority, new.priority);
  end if;
  if cardinality(changes) > 0 then
    perform app.write_audit('Updated work', 'work_order', new.id::text, 'WO-' || new.number, array_to_string(changes, '; '), new.org_id);
  end if;
  return new;
end;
$$;

create trigger work_orders_before_insert before insert on public.work_orders
  for each row execute function app.before_work_order_insert();
create trigger work_orders_before_update before update on public.work_orders
  for each row execute function app.before_work_order_update();
create trigger work_orders_audit after insert or update on public.work_orders
  for each row execute function app.audit_work_order();

create function app.before_note_insert() returns trigger
language plpgsql set search_path = '' as $$
begin
  if not app.is_service() then
    new.author_id := auth.uid();
    new.created_at := now();
  end if;
  return new;
end;
$$;

create trigger work_order_notes_before_insert before insert on public.work_order_notes
  for each row execute function app.before_note_insert();

create function app.can_add_note(p_work_order_id uuid, p_visibility text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  w public.work_orders;
  a app.actor_context := app.actor();
begin
  select * into w from public.work_orders where id = p_work_order_id;
  if not found or a.id is null or app.can_access_work_order(w, 'view') is not true then
    return false;
  end if;
  if p_visibility = 'public' then
    return w.requester_id = a.id or app.can_access_work_order(w, 'update') or app.can_access_work_order(w, 'assign');
  end if;
  return 'work_order:view_internal' = any (a.permissions)
     and (app.can_access_work_order(w, 'update') or app.can_access_work_order(w, 'assign'));
end;
$$;

create function app.can_view_note(n public.work_order_notes) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  w public.work_orders;
begin
  select * into w from public.work_orders where id = n.work_order_id;
  return found
     and app.can_access_work_order(w, 'view')
     and (n.visibility = 'public' or app.has_permission('work_order:view_internal'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Auth hooks: sign-up is invitation-only, except allow-listed student domains.
-- ---------------------------------------------------------------------------

create function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  token text := nullif(meta ->> 'invitation_token', '');
  inv public.invitations;
  tmpl public.role_templates;
  dom public.allowed_email_domains;
  home_building text;
begin
  if token is not null then
    select * into inv from public.invitations where token_hash = app.hash_token(token) for update;
    if not found or inv.status <> 'pending' or inv.expires_at < now() then
      raise exception 'INVITATION_INVALID' using errcode = 'P0001';
    end if;
    if inv.email <> lower(new.email) then
      raise exception 'INVITATION_EMAIL_MISMATCH' using errcode = 'P0001';
    end if;
    select * into tmpl from public.role_templates where key = inv.role_key;

    insert into public.profiles (
      id, email, full_name, role_key, org_unit_id, scope_org_id, building_ids,
      permissions, status, access_expires_at, invited_by, invitation_id
    ) values (
      new.id, lower(new.email),
      coalesce(nullif(trim(meta ->> 'full_name'), ''), inv.full_name, split_part(new.email, '@', 1)),
      inv.role_key, inv.org_unit_id,
      case tmpl.scope_mode when 'subtree' then tmpl.default_scope_org_id when 'assigned' then inv.org_unit_id else null end,
      inv.building_ids, inv.permissions, 'active',
      case when inv.access_days is null then null else now() + make_interval(days => inv.access_days) end,
      inv.invited_by, inv.id
    );

    update public.invitations set status = 'accepted', accepted_at = now(), accepted_by = new.id where id = inv.id;
    insert into public.audit_events (actor_id, actor_label, action, target_type, target_id, target_label, detail, org_id)
    values (new.id, coalesce(nullif(trim(meta ->> 'full_name'), ''), inv.full_name, new.email), 'Accepted invitation',
            'profile', new.id::text, lower(new.email), tmpl.label, inv.org_unit_id);
    return new;
  end if;

  select * into dom from public.allowed_email_domains where domain = lower(split_part(new.email, '@', 2));
  if not found or dom.default_role is null then
    raise exception 'SIGNUP_REQUIRES_INVITATION' using errcode = 'P0001';
  end if;
  select * into tmpl from public.role_templates where key = dom.default_role and self_signup;
  if not found then
    raise exception 'SIGNUP_REQUIRES_INVITATION' using errcode = 'P0001';
  end if;

  select b.id into home_building from public.buildings b
  where b.id = meta ->> 'home_building_id' and b.type = 'residence' and not b.offline;

  insert into public.profiles (
    id, email, full_name, role_key, permissions, status, home_building_id, home_room
  ) values (
    new.id, lower(new.email),
    coalesce(nullif(trim(meta ->> 'full_name'), ''), split_part(new.email, '@', 1)),
    tmpl.key, tmpl.permissions,
    case when new.email_confirmed_at is null then 'pending_verification'::public.profile_status else 'active' end,
    home_building,
    case when home_building is null then null else nullif(upper(left(trim(meta ->> 'home_room'), 16)), '') end
  );
  return new;
end;
$$;

create function app.handle_user_updated() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.email_confirmed_at is null and new.email_confirmed_at is not null then
    update public.profiles set status = 'active', updated_at = now()
    where id = new.id and status = 'pending_verification';
  end if;
  if new.last_sign_in_at is distinct from old.last_sign_in_at then
    update public.profiles set last_sign_in_at = new.last_sign_in_at where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();
create trigger on_auth_user_updated after update on auth.users
  for each row execute function app.handle_user_updated();

-- ---------------------------------------------------------------------------
-- RPCs (exposed to signed-in users; each re-checks authority)
-- ---------------------------------------------------------------------------

create function public.my_profile() returns table (
  id uuid, email text, full_name text, role_key text, role_label text, level text,
  org_unit_id text, scope_org_id text, building_ids text[], home_building_id text, home_room text,
  permissions text[], status public.profile_status, access_expires_at timestamptz,
  invited_by_name text, can_invite text[], created_at timestamptz
)
language sql stable security definer set search_path = '' as $$
  select p.id, p.email, p.full_name, p.role_key, r.label, r.level, p.org_unit_id, p.scope_org_id,
         p.building_ids, p.home_building_id, p.home_room, p.permissions, p.status, p.access_expires_at,
         (select i.full_name from public.profiles i where i.id = p.invited_by), r.can_invite, p.created_at
  from public.profiles p
  join public.role_templates r on r.key = p.role_key
  where p.id = auth.uid()
$$;

create function public.update_my_profile(p_full_name text, p_home_room text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  update public.profiles
  set full_name = coalesce(nullif(trim(p_full_name), ''), full_name),
      home_room = case when home_building_id is null then home_room else coalesce(nullif(upper(left(trim(p_home_room), 16)), ''), home_room) end,
      updated_at = now()
  where id = auth.uid();
end;
$$;

create function public.work_order_feed() returns table (
  id uuid, ref text, title text, description text, category text,
  priority public.work_order_priority, status public.work_order_status,
  org_id text, building_id text, room text,
  requester_id uuid, requester_name text, assignee_id uuid, assignee_name text,
  entry_allowed boolean, source text, created_at timestamptz, updated_at timestamptz,
  due_at timestamptz, latest_internal_note text, public_note_count integer
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  a app.actor_context := app.actor();
begin
  if a.id is null then
    return;
  end if;
  return query
  select w.id, 'WO-' || w.number, w.title, w.description, w.category, w.priority, w.status,
         w.org_id, w.building_id, w.room,
         w.requester_id,
         case
           when w.requester_id = a.id or 'resident:view_identity' = any (a.permissions) or rq.org_unit_id is not null then rq.full_name
           else 'Resident (identity minimized)'
         end,
         case when a.scope_mode = 'own' then null else w.assignee_id end,
         asg.full_name,
         w.entry_allowed, w.source, w.created_at, w.updated_at, w.due_at,
         case when 'work_order:view_internal' = any (a.permissions) then (
           select n.body from public.work_order_notes n
           where n.work_order_id = w.id and n.visibility = 'internal'
           order by n.created_at desc limit 1
         ) end,
         (select count(*)::integer from public.work_order_notes n where n.work_order_id = w.id and n.visibility = 'public')
  from public.work_orders w
  left join public.profiles rq on rq.id = w.requester_id
  left join public.profiles asg on asg.id = w.assignee_id
  where app.can_access_work_order(w, 'view')
  order by w.updated_at desc;
end;
$$;

-- Aggregate counts for executive roles. Restricted units collapse into one bucket.
create function public.work_order_summary() returns table (
  org_id text, org_name text, open_count integer, urgent_count integer, overdue_count integer, total_count integer
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  a app.actor_context := app.actor();
begin
  if a.id is null or a.scope_org_id is null or not ('work_order:view:summary' = any (a.permissions)) then
    return;
  end if;
  return query
  select case when o.sensitive then 'restricted' else w.org_id end,
         case when o.sensitive then 'Restricted units (combined)' else o.name end,
         count(*) filter (where w.status not in ('completed', 'cancelled'))::integer,
         count(*) filter (where w.status not in ('completed', 'cancelled') and w.priority <> 'routine')::integer,
         count(*) filter (where w.status not in ('completed', 'cancelled') and w.due_at < now())::integer,
         count(*)::integer
  from public.work_orders w
  join public.org_units o on o.id = w.org_id
  where app.org_within(a.scope_org_id, w.org_id)
  group by 1, 2
  order by 2;
end;
$$;

create function public.work_order_timeline(p_work_order_id uuid) returns table (
  id uuid, author_name text, body text, visibility text, created_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  return query
  select n.id, app.profile_label(n.author_id), n.body, n.visibility, n.created_at
  from public.work_order_notes n
  where n.work_order_id = p_work_order_id and app.can_view_note(n)
  order by n.created_at;
end;
$$;

create function public.assignable_profiles() returns table (
  id uuid, full_name text, role_label text, org_unit_id text, org_name text
)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  if app.has_permission('work_order:assign') is not true then
    return;
  end if;
  return query
  select p.id, p.full_name, r.label, p.org_unit_id, o.name
  from public.profiles p
  join public.role_templates r on r.key = p.role_key
  join public.org_units o on o.id = p.org_unit_id
  where app.is_assignable(p.id)
  order by o.name, p.full_name;
end;
$$;

create function public.create_invitation(
  p_email text,
  p_role_key text,
  p_org_unit_id text,
  p_building_ids text[] default '{}',
  p_permissions text[] default null,
  p_access_days integer default null,
  p_valid_hours integer default 72,
  p_full_name text default null,
  p_note text default null
) returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  a app.actor_context := app.actor();
  tmpl public.role_templates;
  v_email text := lower(trim(p_email));
  v_permissions text[];
  v_buildings text[] := coalesce(p_building_ids, '{}');
  v_days integer := p_access_days;
  v_token text := app.new_token();
  v_id uuid;
  v_expires timestamptz;
begin
  if a.id is null or not ('people:invite' = any (a.permissions)) then
    raise exception 'INVITE_NOT_PERMITTED' using errcode = '42501';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'INVALID_EMAIL' using errcode = '22023';
  end if;
  if not (p_role_key = any (a.can_invite)) then
    raise exception 'ROLE_NOT_INVITABLE' using errcode = '42501';
  end if;
  select * into tmpl from public.role_templates where key = p_role_key;
  if not found then
    raise exception 'UNKNOWN_ROLE' using errcode = '22023';
  end if;

  -- The invitee's home unit and reach must both sit inside the inviter's reach.
  if app.org_within(a.scope_org_id, p_org_unit_id) is not true then
    raise exception 'ORG_OUT_OF_SCOPE' using errcode = '42501';
  end if;
  if tmpl.scope_mode = 'subtree' then
    if app.org_within(tmpl.default_scope_org_id, p_org_unit_id) is not true
       or app.org_within(a.scope_org_id, tmpl.default_scope_org_id) is not true then
      raise exception 'ORG_OUT_OF_SCOPE' using errcode = '42501';
    end if;
  end if;

  if tmpl.building_scoped then
    if cardinality(v_buildings) = 0 then
      raise exception 'BUILDINGS_REQUIRED' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_buildings) b where not exists (select 1 from public.buildings x where x.id = b)) then
      raise exception 'UNKNOWN_BUILDING' using errcode = '22023';
    end if;
    if a.building_scoped and not (v_buildings <@ a.building_ids) then
      raise exception 'BUILDING_OUT_OF_SCOPE' using errcode = '42501';
    end if;
  else
    v_buildings := '{}';
  end if;

  -- Features can be switched off, never added beyond the role template.
  v_permissions := coalesce(p_permissions, tmpl.permissions);
  if cardinality(v_permissions) = 0 or not (v_permissions <@ tmpl.permissions) then
    raise exception 'FEATURES_OUT_OF_ROLE' using errcode = '42501';
  end if;

  if tmpl.max_access_days is not null then
    v_days := coalesce(v_days, tmpl.max_access_days);
    if v_days > tmpl.max_access_days then
      raise exception 'ACCESS_TOO_LONG' using errcode = '22023';
    end if;
  end if;
  if v_days is not null and (v_days < 1 or v_days > 1825) then
    raise exception 'ACCESS_TOO_LONG' using errcode = '22023';
  end if;
  if p_valid_hours < 1 or p_valid_hours > 336 then
    raise exception 'INVITE_WINDOW_INVALID' using errcode = '22023';
  end if;

  if exists (select 1 from public.profiles where email = v_email) then
    raise exception 'ALREADY_REGISTERED' using errcode = '23505';
  end if;
  update public.invitations x set status = 'expired' where x.email = v_email and x.status = 'pending' and x.expires_at < now();
  if exists (select 1 from public.invitations x where x.email = v_email and x.status = 'pending') then
    raise exception 'INVITE_PENDING' using errcode = '23505';
  end if;

  v_expires := now() + make_interval(hours => p_valid_hours);
  insert into public.invitations (email, full_name, role_key, org_unit_id, building_ids, permissions,
                                  access_days, token_hash, invited_by, note, expires_at)
  values (v_email, nullif(trim(p_full_name), ''), p_role_key, p_org_unit_id, v_buildings, v_permissions,
          v_days, app.hash_token(v_token), a.id, nullif(trim(p_note), ''), v_expires)
  returning id into v_id;

  perform app.write_audit('Sent invitation', 'invitation', v_id::text, v_email,
    format('%s · %s', tmpl.label, coalesce(v_days::text || ' days', 'no expiry')), p_org_unit_id);

  return query select v_id, v_token, v_expires;
end;
$$;

create function app.can_manage_invitation(p_invitation_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  a app.actor_context := app.actor();
  i public.invitations;
begin
  select * into i from public.invitations where id = p_invitation_id;
  return found
     and a.id is not null
     and 'people:invite' = any (a.permissions)
     and (coalesce(i.invited_by = a.id, false)
          or (i.role_key = any (a.can_invite) and app.can_see_invitation(i.invited_by, i.org_unit_id, i.building_ids)));
end;
$$;

create function public.revoke_invitation(p_invitation_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  i public.invitations;
begin
  select * into i from public.invitations where id = p_invitation_id for update;
  if not found or app.can_manage_invitation(i.id) is not true then
    raise exception 'INVITE_NOT_FOUND' using errcode = '42501';
  end if;
  if i.status <> 'pending' then
    raise exception 'INVITE_NOT_PENDING' using errcode = '22023';
  end if;
  update public.invitations set status = 'revoked' where id = i.id;
  perform app.write_audit('Revoked invitation', 'invitation', i.id::text, i.email, null, i.org_unit_id);
end;
$$;

-- Issues a fresh link (the old one stops working) and restarts the window.
create function public.resend_invitation(p_invitation_id uuid, p_valid_hours integer default 72)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_variable
declare
  i public.invitations;
  v_token text := app.new_token();
  v_expires timestamptz := now() + make_interval(hours => least(greatest(p_valid_hours, 1), 336));
begin
  select * into i from public.invitations where id = p_invitation_id for update;
  if not found or app.can_manage_invitation(i.id) is not true then
    raise exception 'INVITE_NOT_FOUND' using errcode = '42501';
  end if;
  if i.status not in ('pending', 'expired') then
    raise exception 'INVITE_NOT_PENDING' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where email = i.email) then
    raise exception 'ALREADY_REGISTERED' using errcode = '23505';
  end if;
  update public.invitations
  set token_hash = app.hash_token(v_token), expires_at = v_expires, status = 'pending'
  where id = i.id;
  perform app.write_audit('Resent invitation', 'invitation', i.id::text, i.email, null, i.org_unit_id);
  return query select i.id, v_token, v_expires;
end;
$$;

-- Safe to call without signing in: reveals only what the invite link holder needs.
create function public.invitation_preview(p_token text) returns table (
  email text, full_name text, role_label text, org_name text, inviter_name text,
  expires_at timestamptz, status public.invitation_status, access_days integer,
  building_names text[], features text[]
)
language sql stable security definer set search_path = '' as $$
  select i.email, i.full_name, r.label, o.name, coalesce(inviter.full_name, 'Tiger Ops administrator'), i.expires_at,
         case when i.status = 'pending' and i.expires_at < now() then 'expired'::public.invitation_status else i.status end,
         i.access_days,
         array(select b.name from public.buildings b where b.id = any (i.building_ids) order by b.name),
         i.permissions
  from public.invitations i
  join public.role_templates r on r.key = i.role_key
  join public.org_units o on o.id = i.org_unit_id
  left join public.profiles inviter on inviter.id = i.invited_by
  where i.token_hash = app.hash_token(p_token)
$$;

create function public.manage_profile(
  p_profile_id uuid, p_action text, p_days integer default null, p_permissions text[] default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  t public.profiles;
  tmpl public.role_templates;
  v_detail text;
  v_until timestamptz;
begin
  select * into t from public.profiles where id = p_profile_id for update;
  if not found or app.can_manage_profile(t) is not true then
    raise exception 'PROFILE_NOT_MANAGEABLE' using errcode = '42501';
  end if;
  select * into tmpl from public.role_templates where key = t.role_key;

  if p_action = 'suspend' then
    update public.profiles set status = 'suspended', updated_at = now() where id = t.id;
    v_detail := 'Suspended';
  elsif p_action = 'reactivate' then
    if t.access_expires_at is not null and t.access_expires_at < now() then
      raise exception 'ACCESS_EXPIRED_EXTEND_FIRST' using errcode = '22023';
    end if;
    update public.profiles set status = 'active', updated_at = now() where id = t.id;
    v_detail := 'Reactivated';
  elsif p_action = 'extend' then
    if p_days is null or p_days < 1 or p_days > coalesce(tmpl.max_access_days, 1825) then
      raise exception 'ACCESS_TOO_LONG' using errcode = '22023';
    end if;
    v_until := greatest(coalesce(t.access_expires_at, now()), now()) + make_interval(days => p_days);
    if tmpl.max_access_days is not null and v_until > now() + make_interval(days => tmpl.max_access_days) then
      v_until := now() + make_interval(days => tmpl.max_access_days);
    end if;
    update public.profiles
    set access_expires_at = v_until,
        status = case when status = 'expired' then 'active'::public.profile_status else status end,
        updated_at = now()
    where id = t.id;
    v_detail := format('Access until %s', to_char(v_until, 'YYYY-MM-DD'));
  elsif p_action = 'end_access' then
    update public.profiles set access_expires_at = now(), status = 'expired', updated_at = now() where id = t.id;
    v_detail := 'Access ended';
  elsif p_action = 'set_features' then
    if p_permissions is null or cardinality(p_permissions) = 0 or not (p_permissions <@ tmpl.permissions) then
      raise exception 'FEATURES_OUT_OF_ROLE' using errcode = '42501';
    end if;
    update public.profiles set permissions = p_permissions, updated_at = now() where id = t.id;
    v_detail := format('%s features enabled', cardinality(p_permissions));
  else
    raise exception 'UNKNOWN_ACTION' using errcode = '22023';
  end if;

  perform app.write_audit('Changed access', 'profile', t.id::text, t.email, v_detail, t.org_unit_id);
end;
$$;

-- Run on a schedule (pg_cron on Supabase; the local server runs it on an interval).
create function public.expire_lapsed_access() returns integer
language plpgsql security definer set search_path = '' as $$
declare
  n integer;
begin
  update public.profiles set status = 'expired', updated_at = now()
  where status = 'active' and access_expires_at is not null and access_expires_at < now();
  get diagnostics n = row_count;
  update public.invitations set status = 'expired' where status = 'pending' and expires_at < now();
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.org_units enable row level security;
alter table public.buildings enable row level security;
alter table public.role_templates enable row level security;
alter table public.allowed_email_domains enable row level security;
alter table public.profiles enable row level security;
alter table public.invitations enable row level security;
alter table public.work_orders enable row level security;
alter table public.work_order_notes enable row level security;
alter table public.audit_events enable row level security;

create policy org_units_read on public.org_units for select to anon, authenticated using (true);
create policy buildings_read on public.buildings for select to anon, authenticated using (true);
create policy role_templates_read on public.role_templates for select to authenticated using (true);
create policy email_domains_read on public.allowed_email_domains for select to anon, authenticated using (true);

create policy profiles_read on public.profiles for select to authenticated
  using (app.can_see_profile(profiles));

create policy invitations_read on public.invitations for select to authenticated
  using (app.can_see_invitation(invited_by, org_unit_id, building_ids));

create policy work_orders_read on public.work_orders for select to authenticated
  using (app.can_access_work_order(work_orders, 'view'));
create policy work_orders_create on public.work_orders for insert to authenticated
  with check (app.can_create_work_order(work_orders));
create policy work_orders_change on public.work_orders for update to authenticated
  using (app.can_access_work_order(work_orders, 'update') or app.can_access_work_order(work_orders, 'assign'));

create policy notes_read on public.work_order_notes for select to authenticated
  using (app.can_view_note(work_order_notes));
create policy notes_create on public.work_order_notes for insert to authenticated
  with check (author_id = auth.uid() and app.can_add_note(work_order_id, visibility));

create policy audit_read on public.audit_events for select to authenticated
  using (app.can_see_audit(audit_events));

-- ---------------------------------------------------------------------------
-- Privileges: start from nothing, grant only what the API needs.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
revoke all on all functions in schema app from public, anon, authenticated;

grant usage on schema public, app to anon, authenticated;

grant select on public.org_units, public.buildings, public.allowed_email_domains to anon, authenticated;
grant select on public.role_templates, public.profiles, public.work_orders, public.work_order_notes, public.audit_events to authenticated;
grant select (id, email, full_name, role_key, org_unit_id, building_ids, permissions, access_days, status,
              invited_by, note, expires_at, accepted_at, accepted_by, created_at)
  on public.invitations to authenticated;
grant insert (title, description, category, priority, building_id, room, entry_allowed, source)
  on public.work_orders to authenticated;
grant update (status, assignee_id, priority, due_at) on public.work_orders to authenticated;
grant insert (work_order_id, body, visibility) on public.work_order_notes to authenticated;
grant usage on sequence public.work_order_number_seq to authenticated;

-- Policy helpers run as the caller, so the caller needs EXECUTE on them.
grant execute on function
  app.actor(), app.is_service(), app.has_permission(text), app.org_within(text, text),
  app.org_in_scope(text, text, text[]), app.can_access_work_order(public.work_orders, text),
  app.can_create_work_order(public.work_orders), app.can_see_profile(public.profiles),
  app.can_see_invitation(uuid, text, text[]), app.can_manage_invitation(uuid),
  app.can_manage_profile(public.profiles), app.can_see_audit(public.audit_events),
  app.can_view_note(public.work_order_notes), app.can_add_note(uuid, text),
  app.is_assignable(uuid), app.route_work_order(text, text, app.actor_context),
  app.profile_label(uuid), app.hash_token(text)
  to authenticated;

grant execute on function
  public.my_profile(), public.update_my_profile(text, text), public.work_order_feed(),
  public.work_order_summary(), public.work_order_timeline(uuid), public.assignable_profiles(),
  public.create_invitation(text, text, text, text[], text[], integer, integer, text, text),
  public.revoke_invitation(uuid), public.resend_invitation(uuid, integer),
  public.manage_profile(uuid, text, integer, text[])
  to authenticated;

grant execute on function public.invitation_preview(text), app.hash_token(text) to anon, authenticated;
