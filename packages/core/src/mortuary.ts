/** Owner-reviewed operational readiness. This is not regulatory certification. */
export const MORTUARY_CHECKS = [
 {id:'coverage',label:'Service coverage and qualified transport partners confirmed'},
 {id:'release',label:'Release authority and required documentation reviewed for the service area'},
 {id:'custody',label:'Identity, custody transfer and proof-of-delivery procedure documented'},
 {id:'staff',label:'Staff, vehicles, insurance and required credentials reviewed'},
 {id:'pricing',label:'Mileage, minimums, after-hours and partner rates approved'},
 {id:'privacy',label:'Restricted document storage, access and retention procedure approved'},
] as const;
export type MortuarySetup={dispatch_phone:string;coverage:string;procedure_reference:string;checks:string[];reviewed_at?:string;reviewed_by?:string};
export function mortuaryGaps(setup:Partial<MortuarySetup>|null|undefined):string[]{
 return [...(!setup?.dispatch_phone?.trim()?['Dispatch phone']:[]),...(!setup?.coverage?.trim()?['Coverage']:[]),...(!setup?.procedure_reference?.trim()?['Procedure reference']:[]),...MORTUARY_CHECKS.filter(c=>!setup?.checks?.includes(c.id)).map(c=>c.label)];
}
