
// EModal / Advent webhook -> update container_status + loads LFD
import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
serve(async (req)=>{
  const payload = await req.json();
  // payload: container_number, availability, last_free_day, holds
  // update container_status table, recalc demurrage risk
  return new Response(JSON.stringify({ok:true}), {headers: {"Content-Type":"application/json"}});
})
