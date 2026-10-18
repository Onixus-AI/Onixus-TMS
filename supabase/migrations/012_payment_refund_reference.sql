alter table public.service_jobs add column payment_intent text;
create index service_jobs_payment_intent on public.service_jobs(org_id,payment_intent) where payment_intent is not null;
