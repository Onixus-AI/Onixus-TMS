import {createHmac,timingSafeEqual} from 'node:crypto';
import {fetchJson} from '../env.js';
import {ProviderError} from '../types.js';

export interface Payments {
 check():Promise<string>;
 checkout(p:{key:string;job:string;org:string;email:string;amount:number;title:string;returnUrl:string}):Promise<{id:string;url:string}>;
 verify(raw:Buffer,signature:string,now?:number):{id:string;type:string;livemode:boolean;data:{object:Record<string,unknown>}};
}
export function stripePayments(o:{key:string;webhookSecret:string;apiUrl?:string}):Payments {
 const call=<T>(path:string,init:RequestInit={})=>fetchJson<T>(`${o.apiUrl??'https://api.stripe.com/v1'}${path}`,{...init,headers:{Authorization:`Bearer ${o.key}`,...init.headers}},(s)=>new ProviderError('Stripe',s,'Payment provider request failed'));
 return {
  check:async()=>{const a=await call<{id:string}>('/account');return a.id;},
  async checkout(p){
   const form=new URLSearchParams({mode:'payment',customer_email:p.email,success_url:p.returnUrl,cancel_url:p.returnUrl,'metadata[job_id]':p.job,'metadata[org_id]':p.org,'payment_intent_data[metadata][job_id]':p.job,'payment_intent_data[metadata][org_id]':p.org,'line_items[0][price_data][currency]':'usd','line_items[0][price_data][unit_amount]':String(p.amount),'line_items[0][price_data][product_data][name]':p.title,'line_items[0][quantity]':'1'});
   return call('/checkout/sessions',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Idempotency-Key':p.key},body:form.toString()});
  },
  verify(raw,signature,now=Date.now()){
   const parts=signature.split(',').map(p=>p.split('='));const t=parts.find(p=>p[0]==='t')?.[1];
   if(!t||!/^\d+$/.test(t)||Math.abs(now/1000-Number(t))>300)throw new Error('Expired webhook signature.');
   const expected=createHmac('sha256',o.webhookSecret).update(t+'.').update(raw).digest();
   if(!parts.some(([k,v])=>k==='v1'&&/^[a-f0-9]{64}$/i.test(v??'')&&timingSafeEqual(Buffer.from(v!,'hex'),expected)))throw new Error('Invalid webhook signature.');
   const event=JSON.parse(raw.toString('utf8'));
   if(typeof event.id!=='string'||typeof event.type!=='string'||!event.data?.object||event.livemode!==o.key.startsWith('sk_live_'))throw new Error('Invalid webhook event or payment mode.');
   return event;
  }
 };
}
