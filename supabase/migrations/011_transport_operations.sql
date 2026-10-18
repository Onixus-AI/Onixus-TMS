-- All operational data is server-only; API scopes each operation to its caller.
alter table public.connections drop constraint if exists connections_category_check;
alter table public.connections add constraint connections_category_check check(category in ('payments','email','inbox','crm','finance','tracking','ai','automation','chat','calendar','documents','reports','social'));
create table public.transport_profiles(
 id uuid primary key references public.organizations(id), org_id uuid not null unique references public.organizations(id),
 modules text[] not null check(cardinality(modules)>0 and modules <@ array['DRAYAGE','TRUCKING','WAREHOUSING','COURIER','MEDICAL','MORTUARY','TOWING']::text[]),
 service_area text not null default '', timezone text not null default 'America/New_York', updated_at timestamptz not null default now()
);
create table public.service_jobs(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),
 request_key uuid not null,title text not null,transport_type text not null check(transport_type in ('DRAYAGE','TRUCKING','WAREHOUSING','COURIER','MEDICAL','MORTUARY','TOWING')),
 customer_email text not null,crm_customer_id uuid,source_thread text,load_id uuid references public.loads(id),
 origin text not null,destination text not null,reference text not null default '',
 status text not null default 'REQUESTED' check(status in ('REQUESTED','QUOTED','ACCEPTED','COMPLETED','CANCELED')),
 lines jsonb not null default '[]',amount_cents bigint,expires_at timestamptz,acceptance_reference text,
 checkout_id text,checkout_url text,checkout_started_at timestamptz,payment_status text not null default 'UNPAID' check(payment_status in ('UNPAID','PENDING','PAID','REFUNDED','REVIEW')),
 paid_at timestamptz,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(org_id,request_key),check(amount_cents is null or amount_cents between 1 and 99999999)
);
create table public.service_bookings(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),
 job_id uuid not null unique references public.service_jobs(id),resource text not null default 'primary',
 starts_at timestamptz not null,ends_at timestamptz not null,
 status text not null default 'RESERVING' check(status in ('RESERVING','CONFIRMED','REVIEW','CANCELED')),
 last_error text,updated_at timestamptz not null default now(),check(ends_at>starts_at)
);
create index service_bookings_resource on public.service_bookings(org_id,resource,starts_at);
create index service_jobs_org_status on public.service_jobs(org_id,status,created_at);
create table public.service_events(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),job_id uuid not null references public.service_jobs(id),
 kind text not null,payload jsonb not null,created_at timestamptz not null default now(),synced_at timestamptz,last_error text
);
create index service_events_pending on public.service_events(org_id,created_at) where synced_at is null;
create table public.payment_events(
 id uuid primary key default gen_random_uuid(),org_id uuid not null references public.organizations(id),provider_event text not null,job_id uuid not null references public.service_jobs(id),created_at timestamptz not null default now(),unique(org_id,provider_event)
);

-- Protect local simultaneous reservations; Google is rechecked immediately before writing.
create function public.guard_service_booking() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(new.org_id::text||':'||new.resource,0));
 if not exists(select 1 from public.service_jobs j where j.id=new.job_id and j.org_id=new.org_id) then raise exception 'Job does not belong to this organization'; end if;
 if new.status<>'CANCELED' and exists(select 1 from public.service_bookings b where b.org_id=new.org_id and b.resource=new.resource and b.id<>new.id and b.status<>'CANCELED' and b.starts_at<new.ends_at and b.ends_at>new.starts_at) then
 raise exception 'This resource already has a reservation' using errcode='23505'; end if;
 return new;
end $$;
create trigger service_booking_guard before insert or update on public.service_bookings for each row execute function public.guard_service_booking();

-- Transactional event outbox: status updates and event creation succeed together.
create function public.log_service_job() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='INSERT' or new.status is distinct from old.status or new.payment_status is distinct from old.payment_status then
 insert into public.service_events(org_id,job_id,kind,payload) values(new.org_id,new.id,'service.'||lower(new.status),pg_catalog.jsonb_build_object('status',new.status,'payment_status',new.payment_status,'amount_cents',new.amount_cents)); end if;
 return new;
end $$;
create trigger service_job_event after insert or update on public.service_jobs for each row execute function public.log_service_job();

alter table public.transport_profiles enable row level security;
alter table public.service_jobs enable row level security;
alter table public.service_bookings enable row level security;
alter table public.service_events enable row level security;
alter table public.payment_events enable row level security;
revoke all on public.transport_profiles,public.service_jobs,public.service_bookings,public.service_events,public.payment_events from public,anon,authenticated;
grant all on public.transport_profiles,public.service_jobs,public.service_bookings,public.service_events,public.payment_events to service_role;
revoke all on function public.guard_service_booking(),public.log_service_job() from public,anon,authenticated;
grant execute on function public.guard_service_booking(),public.log_service_job() to service_role;
