
-- ONIXUS DRAYAGE OS - Unified Schema
-- Extensions go in their own schema (Supabase's convention), not in public,
-- which the database API exposes: PostGIS in public would publish its
-- spatial_ref_sys table without row-level security.
create schema if not exists extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists postgis with schema extensions;
set search_path = public, extensions;

-- ENUMS
create type customer_type as enum ('SHIPPER','MANUFACTURER','BROKER','FREIGHT_FORWARDER','STEAMSHIP_LINE','DEPOT','WAREHOUSE','PORT_TERMINAL','CHASSIS_POOL');
create type load_status as enum ('DRAFT','QUOTED','BOOKED','PLANNED','ASSIGNED','DISPATCHED','AT_PICKUP','PICKED_UP','IN_TRANSIT','AT_DELIVERY','DELIVERED','POD_RECEIVED','INVOICED','SETTLED','CLOSED','CANCELED','ON_HOLD');
create type compliance_status as enum ('PENDING','VERIFIED','WARNING','BLOCKED');

-- Organizations
create table organizations (id uuid primary key default uuid_generate_v4(), name text not null, created_at timestamptz default now());

-- Users
create table users (id uuid primary key default uuid_generate_v4(), org_id uuid references organizations(id), email text, role text, created_at timestamptz default now());

-- Customers CRM - includes all types
create table customers (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid references organizations(id),
  type customer_type not null,
  company_name text not null,
  dba_name text,
  mc_number text,
  dot_number text,
  scac_code text,
  credit_limit numeric default 0,
  payment_terms text default 'Net 30',
  compliance_status compliance_status default 'PENDING',
  fmcsa_last_checked timestamptz,
  brokerage_commission_pct numeric,
  volume_discount_tier jsonb,
  notes text,
  created_at timestamptz default now()
);
create table customer_contacts (id uuid primary key default uuid_generate_v4(), customer_id uuid references customers(id), name text, email text, phone text, is_primary bool default false);
create table customer_locations (id uuid primary key default uuid_generate_v4(), customer_id uuid references customers(id), label text, address text, city text, state text, zip text, geom geometry(Point,4326), free_time_days int default 2);

-- Fleet
create table drivers (id uuid primary key default uuid_generate_v4(), org_id uuid references organizations(id), name text, phone text, license_number text, license_expiry date, status text default 'AVAILABLE', last_location geometry(Point,4326));
create table trucks (id uuid primary key default uuid_generate_v4(), org_id uuid references organizations(id), truck_number text, vin text, status text default 'AVAILABLE');
create table trailers_chassis (id uuid primary key default uuid_generate_v4(), org_id uuid references organizations(id), chassis_number text, type text, size text, pool text, status text);

-- Loads - Drayage specific
create table loads (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid references organizations(id),
  customer_id uuid references customers(id),
  steamship_line_id uuid references customers(id),
  load_number text unique,
  status load_status default 'DRAFT',
  container_number text,
  booking_number text,
  bol_number text,
  seal_number text,
  container_size text, -- 20,40,45
  container_type text, -- GP, REEFER, HC, etc
  chassis_number text,
  is_street_turn bool default false,
  street_turn_pair_id uuid references loads(id),
  direction text, -- IMPORT, EXPORT
  last_free_day date,
  demurrage_per_day numeric default 275,
  per_diem_per_day numeric default 150,
  pickup_location_id uuid references customer_locations(id),
  delivery_location_id uuid references customer_locations(id),
  rate numeric,
  created_at timestamptz default now()
);
create table load_stops (id uuid primary key default uuid_generate_v4(), load_id uuid references loads(id), sequence int, type text, location_id uuid references customer_locations(id), scheduled_at timestamptz, actual_arrival timestamptz, actual_departure timestamptz, status text);
create table trips (id uuid primary key default uuid_generate_v4(), org_id uuid references organizations(id), driver_id uuid references drivers(id), truck_id uuid references trucks(id), status text, is_dual_transaction bool default false, load_ids uuid[] );
create table trip_events (id uuid primary key default uuid_generate_v4(), trip_id uuid references trips(id), event_type text, lat double precision, lng double precision, created_at timestamptz default now(), metadata jsonb);
create table tracking_points (time timestamptz not null, trip_id uuid, driver_id uuid, lat double precision, lng double precision, speed double precision);
create table rate_tariffs (id uuid primary key default uuid_generate_v4(), org_id uuid references organizations(id), customer_id uuid references customers(id), origin text, destination text, steamship_line text, base_rate numeric, fuel_surcharge numeric, accessorials jsonb, effective_from date, effective_to date);
create table fmcsa_snapshots (id uuid primary key default uuid_generate_v4(), customer_id uuid references customers(id), dot_number text, snapshot jsonb, operating_status text, safety_rating text, insurance_on_file bool, created_at timestamptz default now());
create table port_terminals (id uuid primary key default uuid_generate_v4(), name text, code text, location geometry(Point,4326), region text);
create table container_status (id uuid primary key default uuid_generate_v4(), container_number text, status text, availability bool, last_free_day date, holds jsonb, fees jsonb, terminal_id uuid references port_terminals(id), updated_at timestamptz default now());
create table invoices (id uuid primary key default uuid_generate_v4(), load_id uuid references loads(id), customer_id uuid references customers(id), amount numeric, accessorials jsonb, status text default 'DRAFT', stripe_link text);
create table mcp_sync_logs (id uuid primary key default uuid_generate_v4(), mcp_name text, tool_name text, status text, payload jsonb, created_at timestamptz default now());

-- RLS
alter table customers enable row level security;
create policy org_isolation on customers for all using (true); -- replace with org_id = auth.org_id in prod
