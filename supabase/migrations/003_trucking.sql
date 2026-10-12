-- 003: Trucking. Drayage (containers) stays the main path; flatbed, dry van,
-- box truck and cargo van loads run through the same loads and dispatch flow.
-- Nothing that works for containers changes: every new column is nullable or
-- defaults to the container case. The rules that pair freight with trucks
-- live in packages/core (equipment.ts) so the API and web app share them.

-- PostGIS lives in the extensions schema (see 001).
set search_path = public, extensions;

create type equipment_type as enum ('CONTAINER','FLATBED','DRY_VAN','BOX_TRUCK','CARGO_VAN');
create type truck_kind as enum ('TRACTOR','BOX_TRUCK','CARGO_VAN');
create type trailer_kind as enum ('CHASSIS','FLATBED','DRY_VAN');

-- ── Trailers: container chassis, plus dry van and flatbed trailers ─────────
alter table trailers_chassis rename to equipment;
alter table equipment rename column chassis_number to unit_number;
alter table equipment add column kind trailer_kind not null default 'CHASSIS';
alter table equipment add column max_payload_lbs int check (max_payload_lbs > 0);
alter table equipment add column plate text;
alter table equipment alter column status set default 'AVAILABLE';
comment on column equipment.size is 'Chassis: 20, 40, 45, 20/40 or 40/45. Trailers: length in feet (48, 53).';
comment on column equipment.type is 'Sub-type: tri-axle or extendable chassis; step deck or conestoga flatbed.';
comment on column equipment.pool is 'Chassis pool (DCLI, TRAC, Flexi-Van) when not company-owned.';

-- ── Power units ────────────────────────────────────────────────────────────
alter table trucks add column kind truck_kind not null default 'TRACTOR';
alter table trucks add column plate text;
alter table trucks add column gvwr_lbs int check (gvwr_lbs > 0);
alter table trucks add column max_payload_lbs int check (max_payload_lbs > 0);
-- The GPS tracker's unique id (Traccar uniqueId, or the ELD's vehicle id).
alter table trucks add column tracking_device_id text unique;

-- ── Drivers: what they are licensed to drive ───────────────────────────────
alter table drivers add column email text;
alter table drivers add column cdl_class text check (cdl_class in ('A','B','C'));
alter table drivers add column medical_card_expiry date;
alter table drivers add column hazmat_endorsement bool not null default false;
-- Port terminals admit only drivers holding a valid TWIC card.
alter table drivers add column twic_expiry date;

-- ── Locations: plain lat/lng the API can read and write; geom follows ──────
alter table customer_locations add column lat double precision check (lat between -90 and 90);
alter table customer_locations add column lng double precision check (lng between -180 and 180);
update customer_locations set lat = ST_Y(geom), lng = ST_X(geom) where geom is not null;
alter table customer_locations drop column geom;
alter table customer_locations add column geom geometry(Point,4326)
  generated always as (case when lat is not null and lng is not null then ST_SetSRID(ST_MakePoint(lng, lat), 4326) end) stored;

alter table port_terminals add column lat double precision check (lat between -90 and 90);
alter table port_terminals add column lng double precision check (lng between -180 and 180);
update port_terminals set lat = ST_Y(location), lng = ST_X(location) where location is not null;
alter table port_terminals drop column location;
alter table port_terminals add column location geometry(Point,4326)
  generated always as (case when lat is not null and lng is not null then ST_SetSRID(ST_MakePoint(lng, lat), 4326) end) stored;
create unique index port_terminals_code on port_terminals (code) where code is not null;

-- ── Loads ──────────────────────────────────────────────────────────────────
create sequence load_number_seq;
alter table loads alter column load_number set default 'L' || lpad(nextval('load_number_seq')::text, 6, '0');
alter table loads add column equipment_type equipment_type not null default 'CONTAINER';
-- Freight details for flatbed, dry van, box truck and cargo van loads.
alter table loads add column commodity text;
alter table loads add column weight_lbs int check (weight_lbs > 0);
alter table loads add column pallet_count int check (pallet_count >= 0);
alter table loads add column length_in numeric check (length_in > 0);
alter table loads add column width_in numeric check (width_in > 0);
alter table loads add column height_in numeric check (height_in > 0);
alter table loads add column hazmat bool not null default false;
alter table loads add column securement text;       -- flatbed: tarps, straps, chains
alter table loads add column oversize_permit text;  -- flatbed: permit number when over-dimensional
alter table loads add column notes text;
-- Container clocks: out-gate starts per diem, the empty return stops it.
alter table loads add column outgated_at timestamptz;
alter table loads add column empty_returned_at timestamptz;
alter table loads add column per_diem_free_days int not null default 4 check (per_diem_free_days >= 0);
alter table loads add column cutoff_at timestamptz;  -- export vessel cutoff
alter table loads add column street_turn_status text check (street_turn_status in ('PROPOSED','APPROVED'));
alter table loads add column updated_at timestamptz default now();

-- NOT VALID: enforced for every new or changed row without failing on old ones.
alter table loads add constraint loads_container_fields check (
  equipment_type = 'CONTAINER' or (
    container_number is null and container_size is null and container_type is null and chassis_number is null
    and direction is null and last_free_day is null and cutoff_at is null and not is_street_turn
  )
) not valid;
alter table loads add constraint loads_container_number check (container_number ~ '^[A-Z]{3}[UJZ][0-9]{7}$') not valid;
alter table loads add constraint loads_container_size check (container_size in ('20','40','45')) not valid;
alter table loads add constraint loads_direction check (direction in ('IMPORT','EXPORT')) not valid;

create index loads_status on loads (status);
create index loads_equipment_type on loads (equipment_type);
create index loads_container_number on loads (container_number) where container_number is not null;

-- Every status change, who asked for it and why.
create table load_events (
  id uuid primary key default uuid_generate_v4(),
  load_id uuid not null references loads(id) on delete cascade,
  from_status load_status,
  to_status load_status not null,
  note text,
  created_at timestamptz default now()
);
create index load_events_load on load_events (load_id, created_at);
alter table load_events enable row level security;

-- ── Trips ──────────────────────────────────────────────────────────────────
alter table trips add column trailer_id uuid references equipment(id);
alter table trips add column created_at timestamptz default now();
alter table trips add column dispatched_at timestamptz;
alter table trips add column completed_at timestamptz;
create index trip_events_trip on trip_events (trip_id, created_at);
create index tracking_points_trip on tracking_points (trip_id, time);

-- ── Ports, rates, billing ──────────────────────────────────────────────────
create unique index container_status_number on container_status (container_number);
alter table rate_tariffs add column equipment_type equipment_type not null default 'CONTAINER';
alter table rate_tariffs add column container_size text check (container_size in ('20','40','45'));
create sequence invoice_number_seq;
alter table invoices add column invoice_number text unique default 'INV-' || lpad(nextval('invoice_number_seq')::text, 6, '0');
alter table invoices add column created_at timestamptz default now();
