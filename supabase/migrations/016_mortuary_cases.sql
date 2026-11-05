-- 015: TMS–Mortuary. Operational cases, restricted decedent records, dispatch
-- legs, an append-only chain of custody, private case documents, quotes and
-- invoices, and international coordination. See docs/mortuary-api-contract.md.
--
-- Additive only: no existing table, column or row is changed. Freight loads,
-- legs, trips and the generic service_jobs flow are untouched. The fleet
-- (drivers, trucks) is referenced, not altered.
--
-- Like every TMS table, these are server-only: RLS on, no anon/authenticated
-- grants; the API uses the service role and scopes every query by org_id.
-- Child tables use composite foreign keys (org_id, case_id) so a row can never
-- point at another organization's case, even through a bug in the API.

-- ── Cases ──────────────────────────────────────────────────────────────────
create table public.mortuary_cases (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id),
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  case_number text not null check (case_number ~ '^[A-Za-z0-9-]{3,40}$'),
  service_type text not null check (service_type in ('FIRST_CALL_REMOVAL','DOMESTIC_TRANSFER','AIRPORT_TRANSFER','INTERNATIONAL_INBOUND','INTERNATIONAL_OUTBOUND')),
  requesting_organization jsonb not null,
  crm_system text check (crm_system in ('RELAY','HUBSPOT','OTHER')),
  crm_account_ref text check (char_length(crm_account_ref) <= 200),
  authorized_contacts jsonb not null default '[]' check (jsonb_typeof(authorized_contacts) = 'array' and jsonb_array_length(authorized_contacts) <= 10),
  origin jsonb not null,
  destination jsonb not null,
  coordinator_member_id uuid references public.memberships(id),
  required_document_categories text[] not null default '{}',
  mail_thread_refs text[] not null default '{}' check (cardinality(mail_thread_refs) <= 20),
  status text not null default 'INTAKE' check (status in ('INTAKE','AWAITING_RELEASE','READY_FOR_DISPATCH','IN_TRANSIT','ON_HOLD','DELIVERED','CLOSED','CANCELED')),
  held_from_status text check (held_from_status in ('INTAKE','AWAITING_RELEASE','READY_FOR_DISPATCH','IN_TRANSIT')),
  has_restricted_record boolean not null default false,
  last_transition_key uuid,
  version int not null default 1 check (version > 0),
  sort_key text not null,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, request_key),
  unique (org_id, case_number),
  unique (org_id, sort_key),
  check ((status = 'ON_HOLD') = (held_from_status is not null))
);
create index mortuary_cases_org_status on public.mortuary_cases (org_id, status, sort_key desc);

-- Detailed decedent information. Separate table so it is never selected by accident.
create table public.mortuary_case_restricted (
  id uuid primary key, -- equals the case id
  org_id uuid not null,
  decedent_full_name text not null check (char_length(decedent_full_name) between 1 and 200),
  date_of_birth date,
  date_of_death date check (date_of_birth is null or date_of_death is null or date_of_death >= date_of_birth),
  place_of_death text check (char_length(place_of_death) <= 300),
  id_tag_number text check (char_length(id_tag_number) <= 80),
  handling_notes text check (char_length(handling_notes) <= 2000),
  precautions text check (char_length(precautions) <= 1000),
  personal_effects text check (char_length(personal_effects) <= 2000),
  religious_or_cultural_considerations text check (char_length(religious_or_cultural_considerations) <= 1000),
  version int not null default 1 check (version > 0),
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, id) references public.mortuary_cases (org_id, id)
);

-- Members an owner allowed to see one case's restricted record and documents.
create table public.mortuary_case_access (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  member_id uuid not null references public.memberships(id),
  granted_by text,
  revoked_at timestamptz,
  revoked_by text,
  created_at timestamptz not null default now(),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);
create unique index mortuary_case_access_active on public.mortuary_case_access (case_id, member_id) where revoked_at is null;

-- Status history (append-only). request_key makes a retried transition a no-op.
create table public.mortuary_case_status_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  from_status text not null,
  to_status text not null,
  reason text check (char_length(reason) <= 500),
  actor jsonb not null,
  created_at timestamptz not null default now(),
  unique (org_id, request_key),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);
create index mortuary_case_status_events_case on public.mortuary_case_status_events (case_id, created_at);

-- ── Dispatch ───────────────────────────────────────────────────────────────
create table public.mortuary_transport_legs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  seq int not null check (seq > 0),
  mode text not null check (mode in ('GROUND','AIR','PARTNER')),
  from_place jsonb not null,
  to_place jsonb not null,
  scheduled_departure_at timestamptz not null,
  scheduled_arrival_at timestamptz not null,
  driver_id uuid references public.drivers(id),
  vehicle_id uuid references public.trucks(id),
  carrier jsonb,
  status text not null default 'PLANNED' check (status in ('PLANNED','ASSIGNED','EN_ROUTE','IN_CUSTODY','DELIVERED','CANCELED')),
  assigned_at timestamptz,
  actual_departure_at timestamptz,
  actual_pickup_at timestamptz,
  actual_delivery_at timestamptz,
  canceled_at timestamptz,
  cancel_reason text check (char_length(cancel_reason) <= 500),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, request_key),
  unique (case_id, seq),
  check (scheduled_arrival_at > scheduled_departure_at and scheduled_arrival_at <= scheduled_departure_at + interval '72 hours'),
  check (mode = 'GROUND' or (driver_id is null and vehicle_id is null)),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);
create index mortuary_legs_driver on public.mortuary_transport_legs (org_id, driver_id, scheduled_departure_at) where driver_id is not null;
create index mortuary_legs_vehicle on public.mortuary_transport_legs (org_id, vehicle_id, scheduled_departure_at) where vehicle_id is not null;
create index mortuary_legs_board on public.mortuary_transport_legs (org_id, status, scheduled_departure_at);

-- Two dispatchers can pass the API's checks at the same moment. This trigger
-- serialises assignments per driver and per vehicle and re-checks overlaps
-- inside the transaction, so only one of them can commit.
create function public.guard_mortuary_leg() returns trigger language plpgsql security invoker set search_path = '' as $$
declare k1 bigint; k2 bigint;
begin
  if new.status not in ('ASSIGNED','EN_ROUTE','IN_CUSTODY') or new.mode <> 'GROUND' then return new; end if;
  if new.driver_id is null or new.vehicle_id is null then
    raise exception 'A ground leg needs a driver and a vehicle to be assigned' using errcode = '23514';
  end if;
  if not exists (select 1 from public.drivers d where d.id = new.driver_id and d.org_id = new.org_id)
     or not exists (select 1 from public.trucks t where t.id = new.vehicle_id and t.org_id = new.org_id) then
    raise exception 'Driver or vehicle does not belong to this organization' using errcode = '23503';
  end if;
  k1 := pg_catalog.hashtextextended('mortuary-driver:' || new.driver_id::text, 0);
  k2 := pg_catalog.hashtextextended('mortuary-vehicle:' || new.vehicle_id::text, 0);
  -- Fixed order so two transactions locking the same pair cannot deadlock.
  perform pg_catalog.pg_advisory_xact_lock(least(k1, k2));
  perform pg_catalog.pg_advisory_xact_lock(greatest(k1, k2));
  if exists (select 1 from public.mortuary_transport_legs l where l.id <> new.id and l.driver_id = new.driver_id
             and l.status in ('ASSIGNED','EN_ROUTE','IN_CUSTODY')
             and l.scheduled_departure_at < new.scheduled_arrival_at and l.scheduled_arrival_at > new.scheduled_departure_at) then
    raise exception 'Driver is already assigned to an overlapping mortuary leg' using errcode = '23505';
  end if;
  if exists (select 1 from public.mortuary_transport_legs l where l.id <> new.id and l.vehicle_id = new.vehicle_id
             and l.status in ('ASSIGNED','EN_ROUTE','IN_CUSTODY')
             and l.scheduled_departure_at < new.scheduled_arrival_at and l.scheduled_arrival_at > new.scheduled_departure_at) then
    raise exception 'Vehicle is already assigned to an overlapping mortuary leg' using errcode = '23505';
  end if;
  return new;
end $$;
create trigger mortuary_leg_guard before insert or update on public.mortuary_transport_legs for each row execute function public.guard_mortuary_leg();

-- ── Chain of custody (append-only) ─────────────────────────────────────────
create table public.mortuary_custody_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  seq int not null check (seq > 0),
  kind text not null check (kind in ('IDENTITY_CHECK','TRANSFER','CHECKPOINT','INCIDENT','INCIDENT_RESOLVED','CORRECTION')),
  leg_id uuid,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  recorded_by jsonb not null,
  payload jsonb not null,
  prev_hash text check (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text not null check (hash ~ '^[0-9a-f]{64}$'),
  unique (org_id, request_key),
  unique (case_id, seq),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id),
  foreign key (org_id, leg_id) references public.mortuary_transport_legs (org_id, id)
);

-- Contiguous numbering and hash linkage, serialised per case. The API computes
-- each hash; this keeps the chain from forking or skipping.
create function public.guard_mortuary_custody() returns trigger language plpgsql security invoker set search_path = '' as $$
declare last record;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('mortuary-custody:' || new.case_id::text, 0));
  select e.seq, e.hash into last from public.mortuary_custody_events e where e.case_id = new.case_id order by e.seq desc limit 1;
  if new.seq <> coalesce(last.seq, 0) + 1 then
    raise exception 'Custody events must be numbered consecutively' using errcode = '23505';
  end if;
  if new.prev_hash is distinct from last.hash then
    raise exception 'Custody event does not link to the previous event' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger mortuary_custody_guard before insert on public.mortuary_custody_events for each row execute function public.guard_mortuary_custody();

-- ── Documents ──────────────────────────────────────────────────────────────
create table public.mortuary_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  category text not null check (category in ('RELEASE_AUTHORIZATION','DEATH_CERTIFICATE','TRANSIT_PERMIT','EMBALMING_CERTIFICATE','NON_CONTAGION_CERTIFICATE','CONSULAR_DOCUMENT','DECEDENT_PASSPORT','AIRWAY_BILL','CARRIER_BOOKING','CUSTODY_ACKNOWLEDGMENT','IDENTIFICATION_RECORD','INVOICE_SUPPORT','OTHER')),
  status text not null default 'UPLOAD_PENDING' check (status in ('UPLOAD_PENDING','RECEIVED','APPROVED','REJECTED')),
  path text not null unique check (path !~ '\.\.'),
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif')),
  size_bytes int not null check (size_bytes between 1 and 26214400),
  uploaded_by text,
  uploaded_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,
  review_note text check (char_length(review_note) <= 1000),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, request_key),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id),
  check (status <> 'REJECTED' or review_note is not null)
);
create index mortuary_documents_case on public.mortuary_documents (case_id, category);

-- A bucket of its own: private, documents and photos only, 25 MB.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('mortuary-documents', 'mortuary-documents', false, 26214400, array['application/pdf','image/jpeg','image/png','image/webp','image/heic','image/heif'])
on conflict (id) do nothing;

-- ── Quotes and invoices ────────────────────────────────────────────────────
create table public.mortuary_quotes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  number text not null,
  status text not null default 'DRAFT' check (status in ('DRAFT','ISSUED','ACCEPTED','SUPERSEDED','DECLINED')),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 50),
  subtotal_cents bigint not null check (subtotal_cents between 1 and 99999999),
  currency text not null default 'USD' check (currency = 'USD'),
  valid_until date not null,
  notes text check (char_length(notes) <= 1000),
  issued_at timestamptz,
  accepted_at timestamptz,
  acceptance_reference text check (char_length(acceptance_reference) <= 500),
  decline_reason text check (char_length(decline_reason) <= 500),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, request_key),
  unique (case_id, number),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);

-- Payment state is deliberately not a column a person can set: there is no
-- provider-verified mortuary payment path yet, and none is implied.
create table public.mortuary_invoices (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  quote_id uuid not null,
  invoice_number text not null,
  status text not null default 'ISSUED' check (status in ('ISSUED','VOID')),
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 70),
  subtotal_cents bigint not null check (subtotal_cents between 1 and 99999999),
  currency text not null default 'USD' check (currency = 'USD'),
  due_date date not null,
  issued_at timestamptz not null default now(),
  voided_at timestamptz,
  void_reason text check (char_length(void_reason) <= 500),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  unique (org_id, request_key),
  unique (org_id, invoice_number),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id),
  foreign key (org_id, quote_id) references public.mortuary_quotes (org_id, id),
  check ((status = 'VOID') = (voided_at is not null))
);
create unique index mortuary_invoices_one_per_quote on public.mortuary_invoices (quote_id) where status <> 'VOID';

-- ── International coordination ─────────────────────────────────────────────
create table public.mortuary_international (
  id uuid primary key, -- equals the case id
  org_id uuid not null,
  origin_country text not null check (origin_country ~ '^[A-Z]{2}$'),
  destination_country text not null check (destination_country ~ '^[A-Z]{2}$'),
  transit_countries text[] not null default '{}' check (cardinality(transit_countries) <= 5),
  receiving_party jsonb,
  carrier jsonb,
  release_status text not null default 'NOT_REQUESTED' check (release_status in ('NOT_REQUESTED','APPROVED','REVOKED')),
  release_approved_by text,
  release_approved_at timestamptz,
  release_note text check (char_length(release_note) <= 500),
  release_snapshot jsonb,
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (org_id, id) references public.mortuary_cases (org_id, id),
  check (origin_country <> destination_country),
  check (release_status <> 'APPROVED' or (release_approved_by is not null and release_approved_at is not null))
);

create table public.mortuary_requirements (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  country text not null check (country ~ '^[A-Z]{2}$'),
  jurisdiction_role text not null check (jurisdiction_role in ('ORIGIN','DESTINATION','TRANSIT','CARRIER')),
  authority text not null check (char_length(authority) between 1 and 200),
  description text not null check (char_length(description) between 1 and 1000),
  document_category text,
  source_type text not null check (source_type in ('OFFICIAL_PUBLICATION','CONSULATE_CORRESPONDENCE','CARRIER_POLICY','AGENT_ADVICE','INTERNAL_PROCEDURE')),
  -- Every requirement says where it came from and when someone last checked it.
  source_reference text not null check (char_length(source_reference) between 3 and 1000),
  reviewed_on date not null,
  reviewed_by text,
  status text not null default 'OPEN' check (status in ('OPEN','SATISFIED','NOT_APPLICABLE')),
  status_note text check (char_length(status_note) <= 1000),
  version int not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  unique (org_id, request_key),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id),
  check (status <> 'NOT_APPLICABLE' or status_note is not null)
);
create index mortuary_requirements_case on public.mortuary_requirements (case_id);

create table public.mortuary_milestones (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  request_key uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'), -- same key + different body is refused
  kind text not null check (kind in ('DOCUMENTS_SUBMITTED','CONSULAR_DOCUMENT_RECEIVED','CARRIER_BOOKED','TENDERED_TO_CARRIER','DEPARTED','TRANSIT_STOP','ARRIVED','CUSTOMS_PROCESSED','RELEASED_TO_RECEIVING_PARTY','OTHER')),
  occurred_at timestamptz not null,
  reference text check (char_length(reference) <= 200),
  location_country text check (location_country ~ '^[A-Z]{2}$'),
  note text check (char_length(note) <= 1000),
  supersedes_id uuid references public.mortuary_milestones(id),
  recorded_by jsonb not null,
  created_at timestamptz not null default now(),
  unique (org_id, request_key),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);
create index mortuary_milestones_case on public.mortuary_milestones (case_id, occurred_at);

-- ── Integration outbox ─────────────────────────────────────────────────────
-- Explicit, minimal events for CRM and Mail. No consumer exists yet. Signal is
-- not a valid target: private case information never flows to marketing.
create table public.mortuary_integration_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  target text not null check (target in ('CRM','MAIL')),
  kind text not null check (kind in ('case.opened','case.status_changed','invoice.issued')),
  payload jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','DELIVERED','FAILED')),
  delivered_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);
create index mortuary_integration_pending on public.mortuary_integration_events (org_id, created_at) where status = 'PENDING';

-- ── Access audit (append-only) ─────────────────────────────────────────────
create table public.mortuary_access_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  case_id uuid not null,
  actor jsonb not null,
  action text not null check (action in ('RESTRICTED_READ','RESTRICTED_WRITE','DOCUMENT_DOWNLOAD_URL','DOCUMENT_REVIEW','ACCESS_GRANTED','ACCESS_REVOKED','RELEASE_APPROVED','RELEASE_REVOKED')),
  target_id uuid,
  created_at timestamptz not null default now(),
  foreign key (org_id, case_id) references public.mortuary_cases (org_id, id)
);
create index mortuary_access_log_case on public.mortuary_access_log (case_id, created_at);

-- History is never rewritten: corrections are new, attributed rows.
create function public.mortuary_append_only() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end $$;
create trigger mortuary_custody_append_only before update or delete on public.mortuary_custody_events for each row execute function public.mortuary_append_only();
create trigger mortuary_status_append_only before update or delete on public.mortuary_case_status_events for each row execute function public.mortuary_append_only();
create trigger mortuary_milestones_append_only before update or delete on public.mortuary_milestones for each row execute function public.mortuary_append_only();
create trigger mortuary_access_log_append_only before update or delete on public.mortuary_access_log for each row execute function public.mortuary_append_only();
create trigger mortuary_custody_no_truncate before truncate on public.mortuary_custody_events for each statement execute function public.mortuary_append_only();
create trigger mortuary_status_no_truncate before truncate on public.mortuary_case_status_events for each statement execute function public.mortuary_append_only();
create trigger mortuary_milestones_no_truncate before truncate on public.mortuary_milestones for each statement execute function public.mortuary_append_only();
create trigger mortuary_access_log_no_truncate before truncate on public.mortuary_access_log for each statement execute function public.mortuary_append_only();

-- ── Lock down ──────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array[
    'mortuary_cases','mortuary_case_restricted','mortuary_case_access','mortuary_case_status_events','mortuary_transport_legs',
    'mortuary_custody_events','mortuary_documents','mortuary_quotes','mortuary_invoices','mortuary_international',
    'mortuary_requirements','mortuary_milestones','mortuary_integration_events','mortuary_access_log'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant all on public.%I to service_role', t);
  end loop;
end $$;
revoke all on function public.guard_mortuary_leg(), public.guard_mortuary_custody(), public.mortuary_append_only() from public, anon, authenticated;
grant execute on function public.guard_mortuary_leg(), public.guard_mortuary_custody(), public.mortuary_append_only() to service_role;
