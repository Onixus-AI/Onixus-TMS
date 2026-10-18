alter table public.service_jobs add column payment_account_id text;
alter table public.service_bookings add column calendar_connection_id uuid references public.connections(id);
alter table public.service_bookings add column calendar_version timestamptz;
