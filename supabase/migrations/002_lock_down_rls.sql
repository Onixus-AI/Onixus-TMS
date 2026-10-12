-- Lock every table down. 001 enabled row-level security only on `customers`,
-- with a `using (true)` policy that let anyone holding the public anon key read
-- and rewrite every customer; every other table had no RLS at all.
--
-- With RLS on and no policies, the anon and authenticated roles see nothing.
-- The API server uses the service-role key, which bypasses RLS. Add per-org
-- policies (org_id matching the signed-in user's organization) when the web
-- app starts querying Supabase directly.
drop policy if exists org_isolation on customers;

do $$
declare t text;
begin
  foreach t in array array[
    'organizations','users','customers','customer_contacts','customer_locations',
    'drivers','trucks','trailers_chassis','loads','load_stops','trips','trip_events',
    'tracking_points','rate_tariffs','fmcsa_snapshots','port_terminals',
    'container_status','invoices','mcp_sync_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
