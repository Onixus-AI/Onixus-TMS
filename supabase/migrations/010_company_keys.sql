-- 010: Company keys, so an Onixus product (Veltra) can act inside one company
-- without the platform key. Only a SHA-256 hash of each key is stored; the key
-- itself is handed to the product once. A key never reaches platform routes
-- and can't change connections.
-- Also two more connection categories: inbox (Veltra) and social (LinkedIn).

create table if not exists api_keys (
  id uuid primary key default uuid_generate_v4(),
  org_id uuid not null references organizations(id) on delete cascade,
  label text not null,
  hash text not null unique,
  created_by text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists api_keys_org on api_keys (org_id);
alter table api_keys enable row level security;

alter table connections drop constraint if exists connections_category_check;
alter table connections add constraint connections_category_check
  check (category in ('email','inbox','crm','finance','tracking','ai','automation','chat','calendar','documents','reports','social'));
