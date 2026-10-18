/** Transport service areas are additive. Drayage keeps the existing freight rules. */
export const TRANSPORT_TYPES = ['DRAYAGE','TRUCKING','WAREHOUSING','COURIER','MEDICAL','MORTUARY','TOWING'] as const;
export type TransportType = typeof TRANSPORT_TYPES[number];
export const TRANSPORT_MODULES = [
 {id:'DRAYAGE',name:'Drayage',fields:['container','terminal','last free day','empty return'],ready:'Existing container and dispatch workflow'},
 {id:'TRUCKING',name:'Trucking',fields:['equipment','weight','pickup','delivery'],ready:'Existing freight and dispatch workflow'},
 {id:'WAREHOUSING',name:'Warehousing',fields:['pallets','storage duration','handling','location'],ready:'Service intake and quoted jobs'},
 {id:'COURIER',name:'Local delivery / courier',fields:['package count','pickup window','delivery window','proof of delivery'],ready:'Service intake; specialized dispatch requires setup'},
 {id:'MEDICAL',name:'Medical transport',fields:['mobility assistance','vehicle requirements','pickup window','destination'],ready:'Service intake; clinical data and eligibility workflows require setup'},
 {id:'MORTUARY',name:'Mortuary transport',fields:['case reference','authorizing contact','origin','destination','release documents'],ready:'Service intake; chain of custody and state-specific release workflows require setup'},
 {id:'TOWING',name:'Towing',fields:['vehicle class','pickup','destination','recovery equipment'],ready:'Service intake; specialized dispatch requires setup'},
] as const;

export function quoteTotal(lines: {quantity:number;unit_cents:number;periods:number}[]):number {
 if(!lines.length||lines.length>50)throw new Error('A quote needs 1–50 priced lines.');
 const total=lines.reduce((sum,l)=>{
  if(!Number.isFinite(l.quantity)||l.quantity<=0||!Number.isInteger(l.unit_cents)||l.unit_cents<=0||!Number.isInteger(l.periods)||l.periods<1)throw new Error('Every line needs a positive quantity, price in cents, and billing periods.');
  const amount=Math.round(l.quantity*l.unit_cents*l.periods);
  if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('Invalid line amount.');
  return sum+amount;
 },0);
 if(!Number.isSafeInteger(total)||total>99_999_999)throw new Error('Quote exceeds the supported payment limit.');
 return total;
}
