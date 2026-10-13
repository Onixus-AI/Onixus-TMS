-- 006: Each company's prices for drayage extras (chassis days, prepull, yard
-- storage, waiting time, overweight, hazmat). Missing keys fall back to the
-- defaults in packages/core/src/accessorials.ts, so an empty card works.

alter table organizations add column if not exists rate_card jsonb not null default '{}'::jsonb;
