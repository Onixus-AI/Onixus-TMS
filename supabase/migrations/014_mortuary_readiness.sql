-- Operational references only. Client identity and sensitive documents stay in restricted storage.
alter table public.transport_profiles add column if not exists mortuary_setup jsonb;
