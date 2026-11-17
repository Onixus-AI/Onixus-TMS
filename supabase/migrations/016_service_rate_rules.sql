-- Company-specific rate lines for all seven transport modules. A saved rule
-- supplies a quote starting point; an owner still reviews quantities and
-- accepts the final quote before it becomes operational work.
alter table public.service_jobs
  add column if not exists customer_id uuid references public.customers(id);
create table if not exists public.service_rate_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  customer_id uuid references public.customers(id),
  transport_type text not null check (transport_type in ('DRAYAGE','TRUCKING','WAREHOUSING','COURIER','MEDICAL','MORTUARY','TOWING')),
  description text not null check (length(trim(description)) between 1 and 200),
  unit text not null check (unit in ('job','load','mile','hour','day','pallet','stop','vehicle','item')),
  unit_cents bigint not null check (unit_cents between 1 and 99999999),
  effective_from date not null,
  effective_to date,
  created_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from)
);
create index if not exists service_rate_rules_lookup
  on public.service_rate_rules(org_id, transport_type, customer_id, effective_from);
alter table public.service_rate_rules enable row level security;
revoke all on public.service_rate_rules from public, anon, authenticated;
grant all on public.service_rate_rules to service_role;
