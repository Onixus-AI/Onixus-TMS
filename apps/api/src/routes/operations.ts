import {Router,type Request,type Response} from 'express';
import {z} from 'zod';
import {TRANSPORT_MODULES,TRANSPORT_TYPES,quoteTotal} from '@onixus/core';
import {scopedStore,seal,stripePayments,unseal,type Payments} from '@onixus/providers';
import {roles} from '../auth.js';
import {HttpError,mustGet,uuid,type Ctx} from '../http.js';
import {connected} from './connections.js';

export const profileInput=z.object({modules:z.array(z.enum(TRANSPORT_TYPES)).min(1).max(7).transform(v=>[...new Set(v)]),service_area:z.string().trim().max(1000),timezone:z.string().refine(v=>{try{new Intl.DateTimeFormat('en',{timeZone:v});return true;}catch{return false;}},'Choose a valid timezone.')});
const jobInput=z.object({request_key:uuid,title:z.string().trim().min(1).max(200),transport_type:z.enum(TRANSPORT_TYPES),customer_email:z.string().trim().toLowerCase().email(),crm_customer_id:uuid.nullish(),source_thread:z.string().max(500).nullish(),load_id:uuid.nullish(),origin:z.string().trim().min(1).max(300),destination:z.string().trim().min(1).max(300),reference:z.string().trim().max(200).default('')}).strict();
const line=z.object({description:z.string().trim().min(1).max(200),quantity:z.number().positive().max(1000000),unit_cents:z.number().int().positive().max(99999999),periods:z.number().int().min(1).max(3650).default(1)}).strict();
const orgId=(ctx:Ctx)=>{const c=ctx.caller();const id=c?.kind==='system'?c.orgId:c?.member?.org_id;if(!id)throw new HttpError(403,'Choose a company.');return id;};
type Job=Record<string,unknown>&{id:string;org_id:string;status:string;payment_status:string;amount_cents:number;customer_email:string;title:string;expires_at:string;checkout_id:string|null;checkout_url:string|null;checkout_started_at:string|null};

/** Signed Stripe events are handled before user auth, scoped by the stored connection id. */
export function stripeWebhook(ctx:Ctx){return async(req:Request,res:Response)=>{
 const id=uuid.parse(req.params.connection);const row=await ctx.db().get('connections',id);
 if(!row||row.provider!=='stripe'||row.category!=='payments')throw new HttpError(404,'Payment endpoint not found.');
 const creds=unseal(ctx.env.CONNECTIONS_SECRET??'',String(row.secret));
 const provider=stripePayments({key:creds.api_key!,webhookSecret:creds.webhook_secret!});
 let event;try{event=provider.verify((req as Request&{rawBody?:Buffer}).rawBody??Buffer.alloc(0),req.header('stripe-signature')??'');}catch{throw new HttpError(400,'Payment signature verification failed.');}
 const o=event.data.object as Record<string,any>;
 if(event.type==='charge.refunded'){
  const store=scopedStore(ctx.db(),String(row.org_id));
  if(typeof o.payment_intent!=='string')throw new HttpError(409,'Refund requires reconciliation.');
  const [job]=await store.list<Job>('service_jobs',{payment_intent:o.payment_intent},{limit:1});
  if(!job||o.currency!=='usd'||Number(o.amount)!==Number(job.amount_cents)||!Number.isInteger(o.amount_refunded)||o.amount_refunded<1||o.amount_refunded>Number(job.amount_cents))throw new HttpError(409,'Refund requires reconciliation.');
  const [seen]=await store.list('payment_events',{provider_event:event.id},{limit:1});if(seen)return void res.json({received:true,duplicate:true});
  await store.update('service_jobs',job.id,{payment_status:o.amount_refunded===Number(job.amount_cents)?'REFUNDED':'REVIEW',updated_at:ctx.now().toISOString()},{payment_status:['PAID','REVIEW']});
  try{await store.insert('payment_events',{provider_event:event.id,job_id:job.id});}catch(e){const [duplicate]=await store.list('payment_events',{provider_event:event.id},{limit:1});if(!duplicate)throw e;}
  return void res.json({received:true,booking_review:'Review the appointment separately.'});
 }
 if(!['checkout.session.completed','checkout.session.async_payment_succeeded','checkout.session.async_payment_failed'].includes(event.type))return void res.json({received:true,ignored:true});
 if(o.metadata?.org_id!==row.org_id||!uuid.safeParse(o.metadata?.job_id).success)throw new HttpError(400,'Payment metadata does not match this company.');
 const store=scopedStore(ctx.db(),String(row.org_id));const job=await store.get<Job>('service_jobs',o.metadata.job_id);
 if(!job||job.checkout_id!==o.id||o.currency!=='usd'||Number(o.amount_total)!==Number(job.amount_cents))throw new HttpError(409,'Payment requires reconciliation.');
 const [seen]=await store.list('payment_events',{provider_event:event.id},{limit:1});if(seen)return void res.json({received:true,duplicate:true});
 // Applying twice is harmless; receipt is inserted AFTER state, so a crash does not lose the payment.
 if(o.payment_status==='paid')await store.update('service_jobs',job.id,{payment_status:'PAID',payment_intent:typeof o.payment_intent==='string'?o.payment_intent:null,paid_at:ctx.now().toISOString(),updated_at:ctx.now().toISOString()},{payment_status:['UNPAID','PENDING']});
 else if(event.type==='checkout.session.async_payment_failed')await store.update('service_jobs',job.id,{payment_status:'REVIEW'},{payment_status:['UNPAID','PENDING']});
 try{await store.insert('payment_events',{provider_event:event.id,job_id:job.id});}catch(e){const [duplicate]=await store.list('payment_events',{provider_event:event.id},{limit:1});if(!duplicate)throw e;}
 res.json({received:true});
};}

export function operationsRoutes(ctx:Ctx){const r=Router();
 r.get('/operations',async(_req,res)=>{
  const store=ctx.store();const id=orgId(ctx);const [profile,jobs,bookings,connections,events]=await Promise.all([store.get('transport_profiles',id),store.list('service_jobs',{}, {order:'created_at',limit:200}),store.list('service_bookings',{}, {order:'starts_at',limit:200}),store.list('connections'),store.list('service_events',{}, {order:'created_at',limit:200})]);
  const stripe=connections.find(c=>c.provider==='stripe');
  res.json({modules:TRANSPORT_MODULES,profile,jobs,bookings,events,connections:{calendar:connections.some(c=>c.category==='calendar'&&c.status==='CONNECTED'),stripe:!!stripe,mail:connections.some(c=>c.category==='inbox'&&c.status==='CONNECTED')},stripe_webhook:stripe?`${ctx.env.API_PUBLIC_URL?.replace(/\/$/,'')??''}/webhooks/stripe/${stripe.id}`:null,scope:'Latest 200 jobs, bookings and events'});
 });
 r.put('/transport/profile',roles('OWNER'),async(req,res)=>{
  const body=profileInput.parse(req.body);const id=orgId(ctx),store=ctx.store();const prior=await store.get('transport_profiles',id);
  res.json({profile:prior?await store.update('transport_profiles',id,{...body,updated_at:ctx.now().toISOString()}):await store.insert('transport_profiles',{id,...body})});
 });
 r.post('/operations/jobs',async(req,res)=>{
  const body=jobInput.parse(req.body),store=ctx.store();const profile=await store.get('transport_profiles',orgId(ctx));
  if(!(profile?.modules as string[]|undefined)?.includes(body.transport_type))throw new HttpError(409,'Enable this transport service in Business setup first.');
  if(body.load_id)await mustGet(ctx,'loads',body.load_id,'Load');
  const [prior]=await store.list('service_jobs',{request_key:body.request_key},{limit:1});
  if(prior){if(Object.entries(body).some(([k,v])=>v!=null&&prior[k]!==v))throw new HttpError(409,'This request key was used for a different job.');return void res.json({job:prior});}
  res.status(201).json({job:await store.insert('service_jobs',{...body,status:'REQUESTED',payment_status:'UNPAID',checkout_id:null,checkout_url:null,checkout_started_at:null})});
 });
 r.post('/operations/jobs/:id/quote',roles('OWNER'),async(req,res)=>{
  const body=z.object({lines:z.array(line).min(1).max(50),expires_at:z.string().datetime()}).strict().parse(req.body);
  if(new Date(body.expires_at)<=ctx.now())throw new HttpError(400,'Quote expiry must be in the future.');
  const job=await mustGet<Job>(ctx,'service_jobs',String(req.params.id),'Job');if(!['REQUESTED','QUOTED'].includes(job.status))throw new HttpError(409,'An accepted quote cannot be repriced.');
  const changed=await ctx.store().update('service_jobs',job.id,{...body,amount_cents:quoteTotal(body.lines),status:'QUOTED',updated_at:ctx.now().toISOString()},{status:job.status});
  if(!changed)throw new HttpError(409,'Job changed; reload before quoting.');res.json({job:changed});
 });
 r.post('/operations/jobs/:id/accept',roles('OWNER'),async(req,res)=>{
  const b=z.object({acceptance_reference:z.string().trim().min(3).max(500)}).strict().parse(req.body);const job=await mustGet<Job>(ctx,'service_jobs',String(req.params.id),'Job');
  if(job.status!=='QUOTED'||!job.expires_at||new Date(job.expires_at)<=ctx.now())throw new HttpError(409,'A current quote is required.');
  const changed=await ctx.store().update('service_jobs',job.id,{...b,status:'ACCEPTED',updated_at:ctx.now().toISOString()},{status:'QUOTED'});if(!changed)throw new HttpError(409,'Job changed; reload.');res.json({job:changed});
 });
 r.post('/operations/jobs/:id/payment',roles('OWNER'),async(req,res)=>{
  const store=ctx.store(),job=await mustGet<Job>(ctx,'service_jobs',String(req.params.id),'Job');
  if(job.status!=='ACCEPTED'||job.payment_status==='PAID')throw new HttpError(409,'Payment requires an accepted, unpaid quote.');
  if(job.checkout_url)return void res.json({id:job.checkout_id,url:job.checkout_url});
  const provider=await connected(ctx,'payments');if(!provider)throw new HttpError(409,'Connect this business’s Stripe account first.');
  // Stripe retains idempotency keys for at least 24h. Older unknown results require review.
  if(job.checkout_started_at&&ctx.now().getTime()-new Date(job.checkout_started_at).getTime()>23*3600000)throw new HttpError(409,'Check the existing payment in Stripe before retrying.');
  const account=await provider.check();if(job.checkout_started_at&&job.payment_account_id!==account)throw new HttpError(409,'This quote has a payment attempt on another Stripe account. Reconcile it before collecting payment.');
  const start=job.checkout_started_at??ctx.now().toISOString();
  if(!job.checkout_started_at&&!await store.update('service_jobs',job.id,{checkout_started_at:start,payment_status:'PENDING',payment_account_id:account},{checkout_started_at:null}))throw new HttpError(409,'Another request is preparing this payment.');
  const returnUrl=(ctx.env.WEB_ORIGIN??'').split(',')[0]!.trim();if(!/^https:\/\//.test(returnUrl))throw new HttpError(503,'A secure business return URL is required.');
  const p=await provider.checkout({key:`tms:${job.id}`,job:job.id,org:orgId(ctx),email:job.customer_email,amount:Number(job.amount_cents),title:job.title,returnUrl});
  if(!p.id||!p.url||new URL(p.url).hostname!=='checkout.stripe.com')throw new HttpError(502,'Stripe did not return a valid checkout.');
  await store.update('service_jobs',job.id,{checkout_id:p.id,checkout_url:p.url},{checkout_id:null});res.json(p);
 });
 r.post('/operations/jobs/:id/book',async(req,res)=>{
  const body=z.object({start:z.string().datetime(),minutes:z.number().int().min(15).max(1440)}).strict().parse(req.body),store=ctx.store();
  const job=await mustGet<Job>(ctx,'service_jobs',String(req.params.id),'Job');if(job.status!=='ACCEPTED'||job.payment_status!=='PAID')throw new HttpError(409,'An accepted quote and verified full payment are required.');
  if(new Date(body.start)<=ctx.now())throw new HttpError(400,'Choose a future appointment.');
  const end=new Date(new Date(body.start).getTime()+body.minutes*60000).toISOString();
  const [prior]=await store.list('service_bookings',{job_id:job.id},{limit:1});if(prior&&prior.status!=='CANCELED'){if(prior.status==='CONFIRMED'&&new Date(String(prior.starts_at)).getTime()===new Date(body.start).getTime()&&new Date(String(prior.ends_at)).getTime()===new Date(end).getTime())return void res.json({booking:prior});throw new HttpError(409,'Cancel the current appointment before rescheduling, or reconcile an uncertain reservation.');}
  const calendar=await connected(ctx,'calendar');if(!calendar)throw new HttpError(409,'Connect Google Calendar first.');
  const [calendarRow]=await store.list('connections',{category:'calendar'},{limit:1});if(!calendarRow)throw new HttpError(409,'Calendar connection changed; reconnect first.');
  const values={calendar_connection_id:calendarRow.id,calendar_version:calendarRow.updated_at,job_id:job.id,resource:'primary',starts_at:body.start,ends_at:end,status:'RESERVING',last_error:null};
  const booking=prior?await store.update('service_bookings',prior.id,values,{status:'CANCELED'}):await store.insert('service_bookings',values);if(!booking)throw new HttpError(409,'Reservation changed; reload.');
  try{
   if(!await calendar.available(body.start,end)){await store.update('service_bookings',booking.id,{status:'CANCELED',last_error:'Google Calendar reports a conflict.'});throw new HttpError(409,'That time is unavailable.');}
   await calendar.upsert(`service:${job.id}`,{title:job.title,description:`Onixus service reference ${job.id}. View operational details in TMS.`,start:body.start,minutes:body.minutes});
   const confirmed=await store.update('service_bookings',booking.id,{status:'CONFIRMED',updated_at:ctx.now().toISOString()});res.json({booking:confirmed});
  }catch(e){if(!(e instanceof HttpError))await store.update('service_bookings',booking.id,{status:'REVIEW',last_error:'Check Google Calendar before retrying this reservation.'});throw e;}
 });
 r.post('/operations/jobs/:id/cancel-booking',roles('OWNER'),async(req,res)=>{
  const job=await mustGet<Job>(ctx,'service_jobs',String(req.params.id),'Job'),store=ctx.store();
  const [booking]=await store.list('service_bookings',{job_id:job.id},{limit:1});if(!booking)throw new HttpError(404,'No reservation exists.');
  if(booking.status==='CANCELED')return void res.json({booking,refund:'No refund was initiated.'});
  const [calendarRow]=await store.list('connections',{category:'calendar'},{limit:1});if(!calendarRow||calendarRow.id!==booking.calendar_connection_id||new Date(String(calendarRow.updated_at)).getTime()!==new Date(String(booking.calendar_version)).getTime())throw new HttpError(409,'The booking belongs to the original calendar connection. Reconcile that calendar before cancellation.');
  const calendar=await connected(ctx,'calendar');if(!calendar)throw new HttpError(409,'Reconnect the calendar before canceling.');
  await store.update('service_bookings',booking.id,{status:'REVIEW',last_error:'Cancellation pending; verify Google Calendar if interrupted.'});
  await calendar.remove(`service:${job.id}`);
  res.json({booking:await store.update('service_bookings',booking.id,{status:'CANCELED',last_error:null,updated_at:ctx.now().toISOString()}),refund:'No refund was initiated. Review the business cancellation terms in Stripe.'});
 });
 r.post('/operations/jobs/:id/complete',async(req,res)=>{
  const b=z.object({proof_reference:z.string().trim().min(3).max(500)}).strict().parse(req.body),store=ctx.store();const job=await mustGet<Job>(ctx,'service_jobs',String(req.params.id),'Job');
  if(job.status!=='ACCEPTED'||job.payment_status!=='PAID')throw new HttpError(409,'Completion requires accepted work with verified payment.');
  const [booking]=await store.list('service_bookings',{job_id:job.id,status:'CONFIRMED'},{limit:1});if(!booking||new Date(String(booking.starts_at))>ctx.now())throw new HttpError(409,'A confirmed appointment that has started is required.');
  await store.insert('service_events',{job_id:job.id,kind:'service.proof_recorded',payload:b});res.json({job:await store.update('service_jobs',job.id,{status:'COMPLETED',updated_at:ctx.now().toISOString()},{status:'ACCEPTED'})});
 });
 return r;
}
