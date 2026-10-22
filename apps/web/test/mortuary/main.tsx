import {createRoot} from 'react-dom/client';
import {useState} from 'react';
import {MortuaryOffice,type MortuaryTab} from '../../src/mortuary/office';
import {MockMortuaryClient} from '../../src/mortuary/mock';
import type {QueueId} from '../../src/mortuary/types';
import '../../src/styles.css';
const client=new MockMortuaryClient();
function Review(){
 const [tab,setTab]=useState<MortuaryTab>('operations'); const [caseId,setCase]=useState<string|null>(null);const [queue,setQueue]=useState<QueueId|null>(null);
 return <main style={{padding:24,maxWidth:1280,margin:'auto'}}><header><h1>Onixus TMS · Mortuary</h1><p>UI rehearsal with fictional cases. No customer data, payments or messages.</p></header><nav className="actions">{(['operations','cases','dispatch','international'] as const).map(t=><button key={t} onClick={()=>{setTab(t);setCase(null);}}>{t}</button>)}</nav><MortuaryOffice role="OWNER" client={client} tab={tab} caseId={caseId} queue={queue} onTab={setTab} onOpenCase={id=>{setCase(id);setTab('cases');}} onQueue={setQueue}/></main>;
}
createRoot(document.getElementById('root')!).render(<Review/>);
