-- 005: Drayage moves. A load is now a chain of legs (packages/core/src/legs.ts):
-- terminal → customer, customer → empty return, terminal → yard (prepull),
-- empty pickup → shipper, shipper → terminal. Dispatch assigns legs to trips
-- and drivers work leg by leg; the load's status follows its legs.
-- Delivery orders read by AI carry vessel and release details onto the load.

set search_path = public, extensions;

-- Our own places: the yard (prepulls, drops) and empty-return depots.
alter table customer_locations add column kind text not null default 'CUSTOMER' check (kind in ('CUSTOMER','YARD','DEPOT'));

alter table loads add column move_type text check (move_type in ('IMPORT_LIVE','IMPORT_DROP','IMPORT_PREPULL','EXPORT_LIVE','EXPORT_DROP','ONE_WAY'));
alter table loads add column terminal_id uuid references port_terminals(id);
alter table loads add column yard_location_id uuid references customer_locations(id);
alter table loads add column return_terminal_id uuid references port_terminals(id);
alter table loads add column return_location_id uuid references customer_locations(id);
alter table loads add column empty_pickup_terminal_id uuid references port_terminals(id);
alter table loads add column empty_pickup_location_id uuid references customer_locations(id);
-- Export: when the loaded box in-gated at the terminal (per diem stops).
alter table loads add column ingated_at timestamptz;
-- From the delivery order.
alter table loads add column vessel text;
alter table loads add column voyage text;
alter table loads add column vessel_eta date;
alter table loads add column pickup_number text;
alter table loads add column customer_reference text;
alter table loads add column source text not null default 'MANUAL' check (source in ('MANUAL','DELIVERY_ORDER'));
alter table loads add column delivery_order_path text;
create index loads_terminal on loads (terminal_id) where terminal_id is not null;

create table load_legs (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  load_id uuid not null references loads(id) on delete cascade,
  seq int not null check (seq > 0),
  cargo text not null check (cargo in ('LOADED','EMPTY')),
  from_terminal_id uuid references port_terminals(id),
  from_location_id uuid references customer_locations(id),
  to_terminal_id uuid references port_terminals(id),
  to_location_id uuid references customer_locations(id),
  live bool not null default false,
  status text not null default 'PLANNED' check (status in ('PLANNED','ASSIGNED','DISPATCHED','AT_ORIGIN','IN_TRANSIT','AT_DESTINATION','DONE','CANCELED')),
  trip_id uuid references trips(id),
  appointment_at timestamptz,
  appointment_number text,
  started_at timestamptz,
  arrived_at timestamptz,
  done_at timestamptz,
  created_at timestamptz default now(),
  unique (load_id, seq),
  check ((from_terminal_id is null) <> (from_location_id is null)),
  check ((to_terminal_id is null) <> (to_location_id is null))
);
create index load_legs_org_status on load_legs (org_id, status);
create index load_legs_trip on load_legs (trip_id) where trip_id is not null;
alter table load_legs enable row level security;

alter table trips add column leg_ids uuid[];
