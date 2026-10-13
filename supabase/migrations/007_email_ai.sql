-- 007: Email from the app. Each customer gets an address for load updates
-- and invoices; every email sent is logged against its load or invoice.

alter table customers add column if not exists email text;

create table if not exists email_log (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  load_id uuid references loads(id) on delete set null,
  invoice_id uuid references invoices(id) on delete set null,
  to_address text not null,
  subject text not null,
  body text not null,
  sent_by text,
  provider text,
  provider_id text,
  created_at timestamptz not null default now()
);
create index if not exists email_log_org_load on email_log (org_id, load_id);
alter table email_log enable row level security;
