import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {createApp} from './app.js';
import {memoryStore,stripePayments,eventId,seal} from '@onixus/providers';
import {quoteTotal,TRANSPORT_TYPES} from '@onixus/core';
const KEY='test-key-0123456789abcdefghij',A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
test('transport areas combine drayage and warehousing; amounts use quantity and periods',()=>{
 assert.ok(TRANSPORT_TYPES.includes('MORTUARY'));assert.ok(TRANSPORT_TYPES.includes('MEDICAL'));
 assert.equal(quoteTotal([{quantity:2,unit_cents:10000,periods:1},{quantity:10,unit_cents:4500,periods:2}]),110000);
 assert.throws(()=>quoteTotal([{quantity:1,unit_cents:0,periods:1}]));assert.throws(()=>quoteTotal([{quantity:Infinity,unit_cents:1,periods:1}]));assert.match(eventId('service:test'),/^[0-9a-v]{5,1024}$/);
});
test('only a signed exact-amount checkout for this company records payment, once',async()=>{
 const secret='fixture-encryption-secret-1234567890123456',job='44444444-4444-4444-8444-444444444444',connection='55555555-5555-4555-8555-555555555555';
 const db=memoryStore({service_jobs:[{id:job,org_id:A,status:'ACCEPTED',payment_status:'PENDING',checkout_id:'cs_fixture',amount_cents:12000}],connections:[{id:connection,org_id:A,provider:'stripe',category:'payments',secret:seal(secret,{api_key:'sk_test_fixture',webhook_secret:'whsec_fixture'})}]});
 const server=createApp({TMS_API_KEY:KEY,CONNECTIONS_SECRET:secret},{store:()=>db}).listen(0);const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/webhooks/stripe/${connection}`;
 const send=async(overrides:object={},signed=true)=>{const raw=JSON.stringify({id:'evt_fixture',type:'checkout.session.completed',livemode:false,data:{object:{id:'cs_fixture',payment_intent:'pi_fixture',currency:'usd',amount_total:12000,payment_status:'paid',metadata:{org_id:A,job_id:job},...overrides}}});const t=String(Math.floor(Date.now()/1000)),sig=createHmac('sha256','whsec_fixture').update(t+'.'+raw).digest('hex');return fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${t},v1=${signed?sig:'0'.repeat(64)}`},body:raw});};
 try{
  assert.equal((await send({},false)).status,400);assert.equal((await send({amount_total:1})).status,409);assert.equal((await send({metadata:{org_id:B,job_id:job}})).status,400);assert.equal((await db.get('service_jobs',job))?.payment_status,'PENDING');
  assert.equal((await send()).status,200);assert.equal((await db.get('service_jobs',job))?.payment_status,'PAID');assert.equal((await send()).status,200);assert.equal((await db.list('payment_events')).length,1);
  const refund=async(amount:number,original=12000)=>{const raw=JSON.stringify({id:'evt_refund_'+amount,type:'charge.refunded',livemode:false,data:{object:{payment_intent:'pi_fixture',currency:'usd',amount:original,amount_refunded:amount}}});const t=String(Math.floor(Date.now()/1000));return fetch(base,{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':`t=${t},v1=${createHmac('sha256','whsec_fixture').update(t+'.'+raw).digest('hex')}`},body:raw});};
  assert.equal((await refund(6000,12001)).status,409);assert.equal((await db.get('service_jobs',job))?.payment_status,'PAID');
  assert.equal((await refund(6000)).status,200);assert.equal((await db.get('service_jobs',job))?.payment_status,'REVIEW');
  assert.equal((await refund(12000)).status,200);assert.equal((await db.get('service_jobs',job))?.payment_status,'REFUNDED');
  assert.equal((await send()).status,200);assert.equal((await db.get('service_jobs',job))?.payment_status,'REFUNDED');

 }finally{server.close();}
});
test('Stripe rejects forged, expired and wrong-mode events',()=>{
 const provider=stripePayments({key:'sk_test_fixture',webhookSecret:'whsec_fixture'}),now=1800000000000,t=String(now/1000);
 const raw=Buffer.from(JSON.stringify({id:'evt_fixture',type:'checkout.session.completed',livemode:false,data:{object:{}}}));
 const sign=(b:Buffer)=>`t=${t},v1=${createHmac('sha256','whsec_fixture').update(t+'.').update(b).digest('hex')}`;
 assert.equal(provider.verify(raw,sign(raw),now).id,'evt_fixture');assert.throws(()=>provider.verify(Buffer.concat([raw,Buffer.from(' ')]),sign(raw),now));assert.throws(()=>provider.verify(raw,sign(raw),now+301000));
 const live=Buffer.from(JSON.stringify({id:'evt_live',type:'checkout.session.completed',livemode:true,data:{object:{}}}));assert.throws(()=>provider.verify(live,sign(live),now));
});
test('operations are company scoped, quotes freeze on acceptance, and unverified payments cannot book',async()=>{
 const db=memoryStore({organizations:[{id:A,name:'A'},{id:B,name:'B'}]});const app=createApp({TMS_API_KEY:KEY},{store:()=>db,now:()=>new Date('2026-10-18T12:00:00Z')});const server=app.listen(0);const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const call=async(method:string,path:string,body?:unknown,org=A)=>{const r=await fetch(url+path,{method,headers:{Authorization:`Bearer ${KEY}`,'X-Org-Id':org,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,body:await r.json()};};
 try{
  assert.equal((await call('PUT','/transport/profile',{modules:['DRAYAGE','WAREHOUSING'],service_area:'Ports',timezone:'America/New_York'})).status,200);
  assert.equal((await call('PUT','/transport/profile',{modules:[],service_area:'',timezone:'invalid'})).status,400);
  const request={request_key:'33333333-3333-4333-8333-333333333333',title:'Fixture storage',transport_type:'WAREHOUSING',customer_email:'fixture@example.test',origin:'Terminal',destination:'Warehouse',reference:'test'};
  const made=await call('POST','/operations/jobs',request);assert.equal(made.status,201);const id=made.body.job.id;
  assert.equal((await call('POST','/operations/jobs',request)).body.job.id,id);assert.equal((await call('POST','/operations/jobs',{...request,title:'Changed'})).status,409);
  assert.equal((await call('GET','/operations',undefined,B)).body.jobs.length,0);
  assert.equal((await call('POST',`/operations/jobs/${id}/quote`,{lines:[{description:'Storage',quantity:10,unit_cents:4500,periods:2}],expires_at:'2026-10-20T12:00:00Z'},B)).status,404);
  assert.equal((await call('POST',`/operations/jobs/${id}/quote`,{lines:[{description:'Storage',quantity:10,unit_cents:4500,periods:2}],expires_at:'2026-10-20T12:00:00Z'})).body.job.amount_cents,90000);
  assert.equal((await call('POST',`/operations/jobs/${id}/accept`,{acceptance_reference:'Customer email thread fixture'})).status,200);
  assert.equal((await call('POST',`/operations/jobs/${id}/quote`,{lines:[{description:'Changed',quantity:1,unit_cents:1,periods:1}],expires_at:'2026-10-20T12:00:00Z'})).status,409);
  assert.equal((await call('POST',`/operations/jobs/${id}/book`,{start:'2026-10-20T12:00:00Z',minutes:60})).status,409);
  assert.equal((await call('POST',`/operations/jobs/${id}/payment`,{})).status,409);
 }finally{server.close();}
});
