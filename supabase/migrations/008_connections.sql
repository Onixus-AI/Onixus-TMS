-- 008: Each company connects its own accounts: a mailbox (Gmail, Outlook),
-- a CRM (HubSpot), books (QuickBooks) and GPS (Samsara, Motive, Traccar).
-- One connection per category. Credentials are sealed with AES-256-GCM by
-- the API (CONNECTIONS_SECRET) before they reach this table.

create table if not exists connections (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  category text not null check (category in ('email','crm','finance','tracking')),
  provider text not null,
  account text,
  secret text not null,
  status text not null default 'CONNECTED' check (status in ('CONNECTED','ERROR')),
  last_error text,
  connected_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, category)
);
alter table connections enable row level security;

-- Where a customer and an invoice live in the connected CRM and books.
alter table customers add column if not exists crm_ref text;
alter table invoices add column if not exists finance_ref text;
alter table invoices add column if not exists finance_provider text;
