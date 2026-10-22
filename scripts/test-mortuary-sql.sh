#!/usr/bin/env bash
# Exercise supabase/migrations/015_mortuary_cases.sql on a DISPOSABLE PostgreSQL 16
# database: apply a stub of the objects it depends on, the migration itself, the
# assertions in supabase/tests/mortuary_015_test.sql, and two real concurrency
# races (overlapping assignment, custody sequence) across separate sessions.
#
#   MORTUARY_TEST_DATABASE_URL=postgres://postgres@localhost:5432/mortuary_scratch ./scripts/test-mortuary-sql.sh
#
# The database must be empty and throwaway. The script refuses Supabase hosts.
set -euo pipefail
url="${MORTUARY_TEST_DATABASE_URL:?Set MORTUARY_TEST_DATABASE_URL to an empty, disposable database}"
case "$url" in *supabase.co*|*supabase.com*|*pooler*) echo "Refusing to run against a Supabase host" >&2; exit 2 ;; esac
root="$(cd "$(dirname "$0")/.." && pwd)"
psql_q() { psql "$url" -v ON_ERROR_STOP=1 -q -X "$@"; }

if [ "$(psql_q -tAc "select count(*) from pg_tables where schemaname='public'")" != "0" ]; then
  echo "The database is not empty; point MORTUARY_TEST_DATABASE_URL at a fresh one" >&2; exit 2
fi

psql_q -f "$root/supabase/tests/mortuary_stub_base.sql"
psql_q -f "$root/supabase/migrations/015_mortuary_cases.sql"
psql_q -f "$root/supabase/tests/mortuary_015_test.sql"

# ── Race 1: two sessions assign the same driver to overlapping legs ──────────
psql_q <<'SQL'
insert into public.mortuary_transport_legs (id, org_id, case_id, request_key, request_hash, seq, mode, from_place, to_place, scheduled_departure_at, scheduled_arrival_at) values
  ('30000000-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a1', gen_random_uuid(), repeat('0',64), 5, 'GROUND', '{}', '{}', '2026-11-01T13:00Z', '2026-11-01T15:00Z'),
  ('30000000-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-0000000000a2', gen_random_uuid(), repeat('0',64), 5, 'GROUND', '{}', '{}', '2026-11-01T14:00Z', '2026-11-01T16:00Z');
SQL
out1="$(mktemp)"; out2="$(mktemp)"
psql "$url" -X -v ON_ERROR_STOP=1 -c "begin; update public.mortuary_transport_legs set status='ASSIGNED', driver_id='00000000-0000-4000-8000-000000000012', vehicle_id='00000000-0000-4000-8000-000000000021' where id='30000000-0000-4000-8000-000000000001'; select pg_sleep(2); commit;" >"$out1" 2>&1 &
p1=$!
sleep 0.5
psql "$url" -X -v ON_ERROR_STOP=1 -c "update public.mortuary_transport_legs set status='ASSIGNED', driver_id='00000000-0000-4000-8000-000000000012', vehicle_id='00000000-0000-4000-8000-000000000022' where id='30000000-0000-4000-8000-000000000002';" >"$out2" 2>&1 && s2=0 || s2=$?
wait "$p1"
grep -q COMMIT "$out1" || { echo "race 1: first session did not commit"; cat "$out1"; exit 1; }
[ "$s2" != 0 ] && grep -q "Driver is already assigned to an overlapping mortuary leg" "$out2" || { echo "race 1: second session should have been refused"; cat "$out2"; exit 1; }
echo "race 1 ok: concurrent overlapping assignment refused after waiting on the lock"

# ── Race 2: two sessions append custody seq 3 at the same moment ─────────────
psql "$url" -X -v ON_ERROR_STOP=1 -c "begin; insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash) values ('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-0000000000a1',gen_random_uuid(),repeat('0',64),3,'CHECKPOINT',now(),'{}','{}',repeat('b',64),repeat('c',64)); select pg_sleep(2); commit;" >"$out1" 2>&1 &
p1=$!
sleep 0.5
psql "$url" -X -v ON_ERROR_STOP=1 -c "insert into public.mortuary_custody_events (org_id, case_id, request_key, request_hash, seq, kind, occurred_at, recorded_by, payload, prev_hash, hash) values ('aaaaaaaa-0000-4000-8000-000000000001','c0000000-0000-4000-8000-0000000000a1',gen_random_uuid(),repeat('0',64),3,'CHECKPOINT',now(),'{}','{}',repeat('b',64),repeat('d',64));" >"$out2" 2>&1 && s2=0 || s2=$?
wait "$p1"
grep -q COMMIT "$out1" || { echo "race 2: first session did not commit"; cat "$out1"; exit 1; }
[ "$s2" != 0 ] && grep -q -E "numbered consecutively|duplicate key" "$out2" || { echo "race 2: second session should have been refused"; cat "$out2"; exit 1; }
[ "$(psql_q -tAc "select count(*) from public.mortuary_custody_events where case_id='c0000000-0000-4000-8000-0000000000a1'")" = "3" ] || { echo "race 2: expected exactly 3 events"; exit 1; }
echo "race 2 ok: concurrent custody append at the same seq refused; no fork"
rm -f "$out1" "$out2"
echo "All mortuary SQL checks passed"
