-- Setup (2026-11): OTR carriers list the equipment they run (drayage containers are their own service),
-- and the app opens on setup until the owner finishes it.
alter table public.transport_profiles
  add column if not exists equipment text[] not null default '{}'
    check (equipment <@ array['DRY_VAN','REEFER','FLATBED','STEP_DECK','POWER_ONLY','BOX_TRUCK','HOTSHOT','CARGO_VAN','CAR_HAULER','TANKER']::text[]),
  add column if not exists setup_completed_at timestamptz;
