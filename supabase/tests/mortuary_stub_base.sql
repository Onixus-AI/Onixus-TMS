-- Minimal stand-ins for the Supabase objects and earlier tables that
-- 015_mortuary_cases.sql references, so the migration can be applied and
-- exercised on a plain, disposable PostgreSQL 16 database (no PostGIS needed).
-- NEVER run this against a real Supabase project.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create schema if not exists storage;
create table if not exists auth.users (id uuid primary key);
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table if not exists public.organizations (id uuid primary key, name text);
create table if not exists public.memberships (id uuid primary key, org_id uuid references public.organizations(id), role text);
create table if not exists public.drivers (id uuid primary key, org_id uuid references public.organizations(id), name text, status text default 'AVAILABLE');
create table if not exists public.trucks (id uuid primary key, org_id uuid references public.organizations(id), truck_number text, status text default 'AVAILABLE');
