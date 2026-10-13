-- 004: Accounts. Every trucking business, from an owner-operator with one
-- cargo van to a drayage fleet, is an organization. People sign in with
-- Supabase Auth and belong to one organization with a role:
--   OWNER       runs the company, invites people, and sees everything
--   DISPATCHER  runs loads, dispatch, containers, fleet and customers
--   DRIVER      sees and works only the trips assigned to them
-- An owner-operator is an organization of one: an OWNER linked to a driver.
--
-- Every tenant table carries org_id. The API scopes each query to the
-- caller's organization (packages/providers/src/db/store.ts), so one
-- company never sees another's data. Container status and port terminals
-- are shared reference data and stay global.

set search_path = public, extensions;

create type member_role as enum ('OWNER','DISPATCHER','DRIVER');

alter table organizations add column kind text not null default 'COMPANY' check (kind in ('COMPANY','OWNER_OPERATOR'));
alter table organizations add column dot_number text;
alter table organizations add column mc_number text;
alter table organizations add column created_by uuid references auth.users(id);

create table memberships (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  email text not null,
  role member_role not null,
  -- The driver record this person drives as (drivers, and owner-operators).
  driver_id uuid unique references drivers(id),
  disabled_at timestamptz,
  created_at timestamptz default now()
);
create index memberships_org on memberships (org_id);

create table invitations (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  email text not null,
  role member_role not null,
  driver_id uuid references drivers(id),
  invited_by uuid references auth.users(id),
  accepted_at timestamptz,
  created_at timestamptz default now()
);
create unique index invitations_pending_email on invitations (lower(email)) where accepted_at is null;

-- Tables that reached their organization only through a parent now carry it.
alter table customer_contacts add column org_id uuid references organizations(id);
alter table customer_locations add column org_id uuid references organizations(id);
alter table load_events add column org_id uuid references organizations(id);
alter table load_stops add column org_id uuid references organizations(id);
alter table trip_events add column org_id uuid references organizations(id);
alter table tracking_points add column org_id uuid references organizations(id);
alter table fmcsa_snapshots add column org_id uuid references organizations(id);
alter table invoices add column org_id uuid references organizations(id);
alter table mcp_sync_logs add column org_id uuid references organizations(id);

create index customers_org on customers (org_id);
create index customer_locations_org on customer_locations (org_id);
create index drivers_org on drivers (org_id);
create index trucks_org on trucks (org_id);
create index equipment_org on equipment (org_id);
create index loads_org on loads (org_id, created_at);
create index trips_org on trips (org_id, created_at);
create index trips_driver on trips (driver_id, status);
create index invoices_org on invoices (org_id);
create index rate_tariffs_org on rate_tariffs (org_id);

-- Proof of delivery, bills of lading, rate confirmations, photos.
create table load_documents (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  load_id uuid not null references loads(id) on delete cascade,
  kind text not null check (kind in ('POD','BOL','RATE_CONFIRMATION','PHOTO','OTHER')),
  path text not null unique,
  file_name text,
  content_type text,
  uploaded_by uuid references auth.users(id),
  created_at timestamptz default now()
);
create index load_documents_load on load_documents (load_id);

alter table memberships enable row level security;
alter table invitations enable row level security;
alter table load_documents enable row level security;

-- Private bucket: files are reached only through short-lived signed URLs the API issues.
insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 26214400)
on conflict (id) do nothing;
