
// Cron: 2AM daily - checks all BROKER customers via FMCSA SAFER API
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
serve(async (req)=>{
  const FMCSA_KEY = Deno.env.get('FMCSA_API_KEY');
  // Loop customers where type='BROKER'
  // fetch https://mobile.fmcsa.dot.gov/qc/services/carriers/${dot}?webKey=${key}
  // Insert into fmcsa_snapshots, update customers.compliance_status
  return new Response(JSON.stringify({ok:true, checked: 0}), {headers: {"Content-Type":"application/json"}});
})
