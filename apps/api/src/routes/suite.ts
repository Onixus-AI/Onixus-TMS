import {randomBytes} from 'node:crypto';
import {Router} from 'express';
import {seal,unseal,scopedStore,type Store} from '@onixus/providers';
import {roles,COMPANY_KEY_PREFIX,keyHash} from '../auth.js';
import {HttpError,type Ctx} from '../http.js';

/** A per-company connector key, never the platform's cross-company key. */
export function suiteRoutes(ctx:Ctx){const r=Router();
 r.get('/suite/identity',async(_req,res)=>{const c=ctx.caller();const org=c?.kind==='system'?c.orgId:c?.member?.org_id;if(!org)throw new HttpError(403,'Choose a company.');const company=await ctx.db().get('organizations',org);const members=await ctx.store().list('memberships',{role:'OWNER',disabled_at:null});res.json({org_id:org,name:company?.name,owners:members.map(m=>m.email)});});
 r.post('/suite/key',roles('OWNER'),async(_req,res)=>{
  const c=ctx.caller();if(c?.kind!=='user'||!c.member)throw new HttpError(403,'Sign in as the business owner.');
  if((ctx.env.CONNECTIONS_SECRET??'').length<32)throw new HttpError(503,'Configure connection encryption first.');
  const [prior]=await ctx.store().list('connections',{category:'inbox'},{limit:1});
  if(prior)throw new HttpError(409,'An inbox connector already exists. Disconnect it before issuing a replacement key.');
  const key=COMPANY_KEY_PREFIX+randomBytes(32).toString('base64url');
  const row=await ctx.store().insert('api_keys',{label:'Veltra suite',hash:keyHash(key),created_by:c.user.email});
  try{await ctx.store().insert('connections',{category:'inbox',provider:'veltra',account:c.user.email,secret:seal(ctx.env.CONNECTIONS_SECRET!,{key_id:row.id,api_key:key}),status:'ERROR',last_error:'Finish the connection in Veltra Chat.',connected_by:c.user.email,updated_at:ctx.now().toISOString()});}
  catch(e){await ctx.store().remove('api_keys',row.id);throw e;}
  res.setHeader('Cache-Control','no-store');res.json({key:Buffer.from(JSON.stringify({api_key:key,org_id:c.member.org_id})).toString('base64url'),org_id:c.member.org_id,api_url:ctx.env.API_PUBLIC_URL,setup:'Paste this company key in Veltra’s Onixus TMS connection. Mailbox access is verified there.'});
 });
 r.post('/suite/sync',roles('OWNER'),async(_req,res)=>{
  res.json(await syncSuite(ctx,ctx.store()));
 });return r;}

export async function syncSuite(ctx:Ctx,store:Store){
  const [row]=await store.list('connections',{category:'inbox',provider:'veltra'},{limit:1});if(!row)throw new HttpError(409,'Prepare the Mail connector first.');
  const creds=unseal(ctx.env.CONNECTIONS_SECRET??'',String(row.secret));if(!creds.api_key)throw new HttpError(409,'Reconnect using the Veltra suite company key.');
  const base=ctx.env.VELTRA_URL?.replace(/\/$/,'');if(!base||new URL(base).origin!=='https://veltra-production-5b9c.up.railway.app')throw new HttpError(503,'Configure the current Veltra Mail service URL.');
  const events=await store.list('service_events',{synced_at:null},{order:'created_at',ascending:true,limit:30});let synced=0;
  for(const event of events){try{
   const job=await store.get('service_jobs',String(event.job_id));if(!job)throw new Error('Job unavailable.');
   const response=await fetch(base+'/integrations/tms/events',{method:'POST',headers:{Authorization:`Bearer ${creds.api_key}`,'Content-Type':'application/json'},body:JSON.stringify({org_id:row.org_id,event_id:event.id,job_id:job.id,email:job.customer_email,kind:event.kind,title:job.title,payload:event.payload}),signal:AbortSignal.timeout(15000),redirect:'error'});
   if(!response.ok)throw new Error(`Mail handoff unavailable (${response.status}).`);
   await store.update('service_events',event.id,{synced_at:ctx.now().toISOString(),last_error:null});synced++;
  }catch{await store.update('service_events',event.id,{last_error:'Mail/CRM handoff needs attention. Connect the same business in Veltra.'});break;}}
  const response=await fetch(base+'/integrations/tms/status',{method:'POST',headers:{Authorization:`Bearer ${creds.api_key}`,'Content-Type':'application/json'},body:JSON.stringify({org_id:row.org_id}),signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw new HttpError(409,'Connect this company key to the Onixus Mail account in Veltra first.');
  await store.update('connections',row.id,{status:'CONNECTED',last_error:null});return {synced,mail:await response.json()};
}

export function startSuiteWorker(ctx:Ctx){
 if(ctx.env.SUITE_SYNC_ENABLED!=='true')return;
 let busy=false;
 const timer=setInterval(async()=>{if(busy)return;busy=true;try{
  const rows=await ctx.db().list('connections',{category:'inbox',provider:'veltra'},{limit:100});
  for(const row of rows){const store=scopedStore(ctx.db(),String(row.org_id));try{await syncSuite(ctx,store);}catch{await store.update('connections',row.id,{status:'ERROR',last_error:'Finish the same-business Mail / CRM connection in Veltra.'}).catch(()=>{});}}
 }catch{console.error('[suite] event handoff needs attention');}finally{busy=false;}},60000);timer.unref();
}
