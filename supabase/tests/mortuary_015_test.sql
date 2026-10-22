-- Assertions for 015_mortuary_cases.sql on a disposable PostgreSQL 16 database
-- (after mortuary_stub_base.sql and the migration). Every check raises on
-- failure; the run ends with "mortuary 015 SQL checks passed".
-- Run with scripts/test-mortuary-sql.sh. NEVER run against a real project.
\set ON_ERROR_STOP on
set client_min_messages = warning;

-- expect(sqlstate, statement): the statement must fail with exactly that SQLSTATE.
create function pg_temp.expect(want text, stmt text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate = want then return; end if;
    raise exception 'expected SQLSTATE % but got % (%) for: %', want, sqlstate, sqlerrm, stmt;
  end;
  raise exception 'expected SQLSTATE % but the statement succeeded: %', want, stmt;
end $$;
create function pg_temp.ok(cond boolean, what text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'check failed: %', what; end if; end $$;

-- Fixture tenants, fleet and cases (fictional).
insert into public.organizations values ('aaaaaaaa-0000-4000-8000-000000000001', 'Fixture A'), ('bbbbbbbb-0000-4000-8000-000000000002', 'Fixture B');
insert into public.drivers (id, org_id, name) values
  ('00000000-0000-4000-8000-000000000011', 'aaaaaaaa-0000-4000-8000-000000000001', 'Driver 1'),
  ('00000000-0000-4000-8000-000000000012', 'aaaaaaaa-0000-4000-8000-000000000001', 'Driver 2'),
  ('00000000-0000-4000-8000-000000000013', 'bbbbbbbb-0000-4000-8000-000000000002', 'Driver B');
insert into public.trucks (id, org_id, truck_number) values
  ('00000000-0000-4000-8000-000000000021', 'aaaaaaaa-0000-4000-8000-000000000001', 'V1'),
  ('00000000-0000-4000-8000-000000000022', 'aaaaaaaa-0000-4000-8000-000000000001', 'V2');
insert into public.mortuary_cases (id, org_id, request_key, request_hash, case_number, service_type, requesting_organization, origin, destination, sort_key) values
  ('c0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), repeat('0', 64), 'MC-A1', 'DOMESTIC_TRANSFER', '{"name":"FH"}', '{"name":"O"}', '{"name":"D"}', 'a1'),
  ('c0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), repeat('0', 64), 'MC-A2', 'DOMESTIC_TRANSFER', '{"name":"FH"}', '{"name":"O"}', '{"name":"D"}', 'a2'),
  ('c0000000-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000002', gen_random_uuid(), repeat('0', 64), 'MC-B1', 'DOMESTIC_TRANSFER', '{"name":"FH"}', '{"name":"O"}', '{"name":"D"}', 'b1');

-- ── Tenant integrity: a child row can never point at another company's case ──
select pg_temp.expect('23503', $q$insert into public.mortuary_transport_legs (org_id, case_id, request_key, request_hash, seq, mode, from_place, to_place, scheduled_departure_at, scheduled_arrival_at)
  values ('bbbbbbbb-0000-4000-8000-000000000002', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 1, 'GROUND', '{}', '{}', '2026-10-22T13:00Z', '2026-10-22T15:00Z')$q$);
select pg_temp.expect('23503', $q$insert into public.mortuary_case_restricted (id, org_id, decedent_full_name) values ('c0000000-0000-4000-8000-0000000000a1', 'bbbbbbbb-0000-4000-8000-000000000002', 'Fixture')$q$);
select pg_temp.expect('23505', $q$insert into public.mortuary_cases (org_id, request_key, request_hash, case_number, service_type, requesting_organization, origin, destination, sort_key)
  values ('aaaaaaaa-0000-4000-8000-000000000001', gen_random_uuid(), repeat('0',64), 'MC-A1', 'DOMESTIC_TRANSFER', '{}', '{}', '{}', 'a3')$q$);
select pg_temp.expect('23514', $q$update public.mortuary_cases set status = 'ON_HOLD' where id = 'c0000000-0000-4000-8000-0000000000a2'$q$);

-- ── Dispatch: overlapping driver / vehicle assignments are refused ─────────
insert into public.mortuary_transport_legs (id, org_id, case_id, request_key, request_hash, seq, mode, from_place, to_place, scheduled_departure_at, scheduled_arrival_at) values
  ('10000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 1, 'GROUND', '{}', '{}', '2026-10-22T13:00Z', '2026-10-22T15:00Z'),
  ('10000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a2', gen_random_uuid(), repeat('0',64), 1, 'GROUND', '{}', '{}', '2026-10-22T14:00Z', '2026-10-22T16:00Z'),
  ('10000000-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a2', gen_random_uuid(), repeat('0',64), 2, 'GROUND', '{}', '{}', '2026-10-22T15:00Z', '2026-10-22T16:00Z');
update public.mortuary_transport_legs set status = 'ASSIGNED', driver_id = '00000000-0000-4000-8000-000000000011', vehicle_id = '00000000-0000-4000-8000-000000000021' where id = '10000000-0000-4000-8000-000000000001';
select pg_temp.expect('23505', $q$update public.mortuary_transport_legs set status = 'ASSIGNED', driver_id = '00000000-0000-4000-8000-000000000011', vehicle_id = '00000000-0000-4000-8000-000000000022' where id = '10000000-0000-4000-8000-000000000002'$q$);
select pg_temp.expect('23505', $q$update public.mortuary_transport_legs set status = 'ASSIGNED', driver_id = '00000000-0000-4000-8000-000000000012', vehicle_id = '00000000-0000-4000-8000-000000000021' where id = '10000000-0000-4000-8000-000000000002'$q$);
select pg_temp.expect('23503', $q$update public.mortuary_transport_legs set status = 'ASSIGNED', driver_id = '00000000-0000-4000-8000-000000000013', vehicle_id = '00000000-0000-4000-8000-000000000022' where id = '10000000-0000-4000-8000-000000000002'$q$);
select pg_temp.expect('23514', $q$update public.mortuary_transport_legs set status = 'ASSIGNED' where id = '10000000-0000-4000-8000-000000000002'$q$);
-- Back-to-back is not an overlap; a canceled leg frees the driver.
update public.mortuary_transport_legs set status = 'ASSIGNED', driver_id = '00000000-0000-4000-8000-000000000011', vehicle_id = '00000000-0000-4000-8000-000000000021' where id = '10000000-0000-4000-8000-000000000003';
update public.mortuary_transport_legs set status = 'CANCELED' where id = '10000000-0000-4000-8000-000000000001';
-- 13:00–14:30 overlaps only the canceled leg, so driver 1 and vehicle 1 are free for it.
insert into public.mortuary_transport_legs (org_id, case_id, request_key, request_hash, seq, mode, from_place, to_place, scheduled_departure_at, scheduled_arrival_at, status, driver_id, vehicle_id)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a2', gen_random_uuid(), repeat('0',64), 3, 'GROUND', '{}', '{}', '2026-10-22T13:00Z', '2026-10-22T14:30Z',
          'ASSIGNED', '00000000-0000-4000-8000-000000000011', '00000000-0000-4000-8000-000000000021');
-- Leg 3 (15:00–16:00) still holds driver 1, so leg 2 (14:00–16:00) cannot have them.
select pg_temp.expect('23505', $q$update public.mortuary_transport_legs set status = 'ASSIGNED', driver_id = '00000000-0000-4000-8000-000000000011', vehicle_id = '00000000-0000-4000-8000-000000000022' where id = '10000000-0000-4000-8000-000000000002'$q$);
select pg_temp.expect('23514', $q$insert into public.mortuary_transport_legs (org_id, case_id, request_key, request_hash, seq, mode, from_place, to_place, scheduled_departure_at, scheduled_arrival_at)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 9, 'GROUND', '{}', '{}', '2026-10-22T13:00Z', '2026-10-26T13:00Z')$q$);
select pg_temp.expect('23514', $q$insert into public.mortuary_transport_legs (org_id, case_id, request_key, request_hash, seq, mode, from_place, to_place, scheduled_departure_at, scheduled_arrival_at, driver_id)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 9, 'AIR', '{}', '{}', '2026-10-22T13:00Z', '2026-10-22T18:00Z', '00000000-0000-4000-8000-000000000012')$q$);

-- ── Custody: contiguous, hash-linked, append-only ──────────────────────────
insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 1, 'CHECKPOINT', now(), '{}', '{}', null, repeat('a', 64));
select pg_temp.expect('23505', $q$insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 3, 'CHECKPOINT', now(), '{}', '{}', repeat('a',64), repeat('b',64))$q$);
select pg_temp.expect('23514', $q$insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 2, 'CHECKPOINT', now(), '{}', '{}', repeat('f',64), repeat('b',64))$q$);
select pg_temp.expect('23514', $q$insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 2, 'CHECKPOINT', now(), '{}', '{}', null, repeat('b',64))$q$);
insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 2, 'CHECKPOINT', now(), '{}', '{}', repeat('a',64), repeat('b',64));
select pg_temp.expect('42501', $q$update public.mortuary_custody_events set payload = '{"edited":true}' where seq = 1$q$);
select pg_temp.expect('42501', $q$delete from public.mortuary_custody_events where seq = 2$q$);
select pg_temp.expect('42501', $q$truncate public.mortuary_custody_events$q$);

insert into public.mortuary_case_status_events (org_id, case_id, request_key, request_hash, from_status, to_status, actor)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 'INTAKE', 'AWAITING_RELEASE', '{}');
select pg_temp.expect('42501', $q$update public.mortuary_case_status_events set to_status = 'CLOSED'$q$);
select pg_temp.expect('42501', $q$delete from public.mortuary_case_status_events$q$);
insert into public.mortuary_access_log (org_id, case_id, actor, action) values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', '{}', 'RESTRICTED_READ');
select pg_temp.expect('42501', $q$delete from public.mortuary_access_log$q$);
select pg_temp.expect('42501', $q$truncate public.mortuary_access_log$q$);
select pg_temp.expect('42501', $q$truncate public.mortuary_milestones$q$);

-- ── Outbox: CRM and Mail only; Signal is rejected by the database ──────────
select pg_temp.expect('23514', $q$insert into public.mortuary_integration_events (org_id, case_id, target, kind, payload) values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', 'SIGNAL', 'case.opened', '{}')$q$);
insert into public.mortuary_integration_events (org_id, case_id, target, kind, payload) values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', 'CRM', 'case.opened', '{}');

-- ── Billing: one open invoice per quote; no payment column anyone could set ─
insert into public.mortuary_quotes (id, org_id, case_id, request_key, request_hash, number, status, lines, subtotal_cents, valid_until)
  values ('20000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 'Q1', 'ACCEPTED', '[{}]', 100, '2026-11-01');
insert into public.mortuary_invoices (org_id, case_id, request_key, request_hash, quote_id, invoice_number, lines, subtotal_cents, due_date)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), '20000000-0000-4000-8000-000000000001', 'MI-1', '[{}]', 100, '2026-11-15');
select pg_temp.expect('23505', $q$insert into public.mortuary_invoices (org_id, case_id, request_key, request_hash, quote_id, invoice_number, lines, subtotal_cents, due_date)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), '20000000-0000-4000-8000-000000000001', 'MI-2', '[{}]', 100, '2026-11-15')$q$);
select pg_temp.expect('23514', $q$insert into public.mortuary_quotes (org_id, case_id, request_key, request_hash, number, lines, subtotal_cents, valid_until, currency)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 'Q2', '[{}]', 100, '2026-11-01', 'EUR')$q$);
select pg_temp.ok(not exists (select 1 from information_schema.columns where table_name like 'mortuary_%' and column_name like '%payment%'), 'no payment column on mortuary tables');

-- ── Requirements carry a source and review date ─────────────────────────────
insert into public.mortuary_international (id, org_id, origin_country, destination_country) values ('c0000000-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-000000000001', 'US', 'JM');
select pg_temp.expect('23502', $q$insert into public.mortuary_requirements (org_id, case_id, request_key, request_hash, country, jurisdiction_role, authority, description, source_type, reviewed_on)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 'JM', 'DESTINATION', 'x', 'y', 'AGENT_ADVICE', '2026-10-01')$q$);
select pg_temp.expect('23502', $q$insert into public.mortuary_requirements (org_id, case_id, request_key, request_hash, country, jurisdiction_role, authority, description, source_type, source_reference)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 'JM', 'DESTINATION', 'x', 'y', 'AGENT_ADVICE', 'ref')$q$);
select pg_temp.expect('23514', $q$update public.mortuary_international set release_status = 'APPROVED' where id = 'c0000000-0000-4000-8000-0000000000a1'$q$);
select pg_temp.expect('23514', $q$insert into public.mortuary_international (id, org_id, origin_country, destination_country) values ('c0000000-0000-4000-8000-0000000000a2', 'aaaaaaaa-0000-4000-8000-000000000001', 'US', 'US')$q$);

-- ── Lock-down: RLS on, nothing for anon/authenticated, private bucket ──────
select pg_temp.ok((select bool_and(relrowsecurity) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'mortuary_%'), 'RLS enabled on every mortuary table');
select pg_temp.ok((select count(*) from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'mortuary_%') = 14, '14 mortuary tables');
select pg_temp.ok(not exists (select 1 from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname like 'mortuary_%' and c.relkind = 'r'
  and (has_table_privilege('anon', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'select') or has_table_privilege('authenticated', c.oid, 'insert'))), 'no anon/authenticated privileges');
select pg_temp.ok((select not public from storage.buckets where id = 'mortuary-documents'), 'mortuary bucket is private');
select pg_temp.expect('23514', $q$insert into public.mortuary_documents (org_id, case_id, request_key, request_hash, category, path, file_name, content_type, size_bytes)
  values ('aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 'OTHER', 'a/../b.pdf', 'x.pdf', 'application/pdf', 10)$q$);

select 'mortuary 015 SQL checks passed' as result;
