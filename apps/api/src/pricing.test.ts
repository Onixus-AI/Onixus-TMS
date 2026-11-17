import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from './app.js';
import { memoryStore } from '@onixus/providers';
import { TRANSPORT_TYPES } from '@onixus/core';

const KEY='test-key-0123456789abcdefghij';
const A='11111111-1111-4111-8111-111111111111';
const B='22222222-2222-4222-8222-222222222222';
const CUSTOMER='33333333-3333-4333-8333-333333333333';

test('mode and customer rates stay inside their company, with exact line totals', async()=>{
 const db=memoryStore({organizations:[{id:A,name:'A'},{id:B,name:'B'}],customers:[{id:CUSTOMER,org_id:A,company_name:'Fixture shipper'}]});
 const server=createApp({TMS_API_KEY:KEY},{store:()=>db,now:()=>new Date('2026-11-17T12:00:00Z')}).listen(0);
 const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
 const call=async(org:string,method:string,path:string,body?:unknown)=>{const r=await fetch(base+path,{method,headers:{Authorization:`Bearer ${KEY}`,'X-Org-Id':org,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
 try{
  for(const mode of TRANSPORT_TYPES){
   const saved=await call(A,'POST','/operations/rates',{transport_type:mode,description:'Base service',unit:'load',unit_cents:50000,effective_from:'2026-11-01'});
   assert.equal(saved.status,201,mode);
   const estimate=await call(A,'POST','/operations/rates/estimate',{transport_type:mode,quantities:{[saved.body.rule.id]:2}});
   assert.equal(estimate.status,200,mode);
   assert.equal(estimate.body.total_cents,100000,mode);
   assert.equal((await call(B,'GET','/operations/rates')).body.rules.length,0);
   assert.equal((await call(B,'POST','/operations/rates/estimate',{transport_type:mode})).status,404);
  }
  assert.equal((await call(B,'POST','/operations/rates',{transport_type:'TRUCKING',customer_id:CUSTOMER,description:'Wrong company',unit:'mile',unit_cents:100,effective_from:'2026-11-01'})).status,404);
  const custom=await call(A,'POST','/operations/rates',{transport_type:'TRUCKING',customer_id:CUSTOMER,description:'Customer lane',unit:'mile',unit_cents:225,effective_from:'2026-11-01'});
  assert.equal(custom.status,201);
  const estimate=await call(A,'POST','/operations/rates/estimate',{transport_type:'TRUCKING',customer_id:CUSTOMER,quantities:{[custom.body.rule.id]:100}});
  assert.deepEqual([estimate.body.method,estimate.body.total_cents,estimate.body.lines.length],['customer',22500,1]);
  assert.equal((await call(B,'POST','/operations/rates/estimate',{transport_type:'TRUCKING',customer_id:CUSTOMER})).status,404);
 }finally{server.close();}
});

