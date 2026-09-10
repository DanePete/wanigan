import { db } from './db';
import { companionFacts, createCompanionService } from './companion';
import { companionPresence } from '../shared/companion-presence';
import type { Attention, Project, Session } from '../shared/types';

type Check = (ok:boolean,label:string,detail?:unknown)=>void;
/** No model calls: exercise the same main-owned validation, history and meter
 * with deterministic transport responses inside the isolated smoke database. */
export async function runCompanionSmoke(check:Check,say:(s:string)=>void) {
  say('── companion · explicit calls, evidence boundaries, cancellation and accounting');
  const project:Project={id:'companion-test-project',name:'Test space',path:'/PRIVATE-PATH-MARKER',branch:'main',addedAt:1};
  const session:Session={id:'companion-test-session',providerId:'opaque/provider',projectId:project.id,
    projectPath:project.path,projectName:project.name,title:'PRIVATE-AGENT-TEXT-MARKER',status:'running',pid:123,
    exitCode:null,createdAt:2,endedAt:null,unread:0};
  const attention:Attention={sessionId:session.id,kind:'permission',transitionId:'test',since:3,
    label:'PRIVATE-ATTENTION-MARKER',detail:'PRIVATE-TRANSCRIPT-MARKER',tool:null};
  const presence=(rows:Attention[])=>companionPresence([session],rows,'ready');
  check(presence([attention]).signal==='permission'&&presence([attention]).needs===1,
    'small companion follows a recorded permission request');
  const finish={...attention,kind:'finished' as const,transitionId:'turn-finished'};
  check(presence([finish]).signal==='finished'&&presence([finish]).label==='A turn finished',
    'a finished turn is shown without claiming approved or successful work');
  check(presence([{...attention,kind:'error'}]).signal==='error','a recorded session error changes the companion signal');
  check(presence([{...attention,kind:'working'}]).signal==='working'&&presence([]).signal==='quiet',
    'working requires an attention signal, never a running PID alone');
  check(companionPresence([{...session,status:'exited'}] as Session[],[],'ready').signal==='quiet',
    'a process exit without a finished signal does not invent a completion');
  check(companionPresence([{...session,status:'exited'}],[finish],'ready').label==='A session ended',
    'an exited process is not mislabeled as a completed turn');
  check(presence([{...attention,sessionId:'removed'}]).needs===0,'removed sessions cannot keep the companion in an attention state');
  check(presence([attention,attention]).needs===1,'duplicate attention rows do not inflate the companion count');
  check(companionPresence([session],[finish],'unavailable').signal==='unavailable'
    &&companionPresence([session],[],'loading').label==='Checking sessions',
    'failed and initial status reads remain distinct from a quiet fleet');
  const other={...session,id:'another-session'};
  const mixed=companionPresence([session,other],[{...finish,sessionId:other.id},attention],'ready');
  check(mixed.signal==='permission'&&mixed.needs===2,'permission takes priority over a finished turn while retaining both waiting sessions');
  check(presence([finish]).events[0]!==presence([{...finish,transitionId:'next-turn'}]).events[0],
    'a new finished-turn transition remains distinct from a repeated poll');
  const facts=(scope:string|null)=>companionFacts([project],[session],[attention],scope);
  const snapshot=facts(null),encoded=JSON.stringify(snapshot);
  check(snapshot.running===1&&snapshot.needsYou===1&&snapshot.projects[0].sessions[0].state==='permission',
    'briefing counts recorded operational status');
  check(!encoded.includes('PRIVATE-'),'briefing excludes paths, agent titles and attention content');
  let calls=0,available=true,halted=false;
  let respond: 'ok'|'invalid-source'|'unpriced'|'pending' = 'ok';
  let sent='';
  const service=createCompanionService({database:db,facts,available:()=>available,checkHalt:()=>{if(halted)throw new Error('halted');},
    complete:async(model,messages,signal)=>{
      calls++;sent=JSON.stringify(messages);
      if(respond==='pending')return await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true}));
      return {text:JSON.stringify({answer:'This session needs permission.',sourceIds:[respond==='invalid-source'?'session:invented':`session:${session.id}`]}),
        model:respond==='unpriced'?'unknown-model':model,input:100,output:25};
    }});
  const input={projectId:project.id,question:'What needs me?',model:snapshot.defaultModel};
  const reject=async(value:unknown)=>{try{await service.ask(value);return false;}catch{return true;}};
  const before=db().prepare('SELECT COUNT(*) AS n FROM companion_turns').get() as {n:number};
  service.snapshot(null);service.history(project.id);
  check(calls===0,'opening or refreshing the companion never makes a model call');
  check(await reject({...input,question:''})&&await reject({...input,question:'x'.repeat(4001)})
    &&await reject({...input,model:'invented'})&&await reject({...input,projectId:'missing'}),
    'invalid questions, models and project scopes are refused before transport');
  available=false;check(await reject(input),'missing credentials refuse a send');available=true;
  halted=true;check(await reject(input),'global halt refuses a send');halted=false;
  check(calls===0,'refused calls do not reach transport');
  const answer=await service.ask(input);
  check(answer.status==='answered'&&answer.sources[0]?.targetId===session.id&&Number(calls)===1,
    'one explicit send produces one persisted answer with a verified source');
  check(answer.inputTokens===100&&answer.outputTokens===25&&answer.costUsd!==null&&answer.costUsd>0,
    'reported tokens and a known rate are recorded');
  check(!sent.includes('PRIVATE-'),'transport receives only bounded operational metadata');
  check(service.history(null).length===0&&service.history(project.id).some(t=>t.id===answer.id),
    'project conversation history stays in its own scope');
  respond='invalid-source';const invalid=await service.ask(input);
  check(invalid.status==='failed'&&invalid.answer===null&&invalid.sources.length===0,
    'unknown evidence cannot become an answer or clickable source');
  check(invalid.inputTokens===100&&invalid.costUsd!==null,'a malformed answer still records reported usage');
  respond='unpriced';const unpriced=await service.ask(input);
  check(unpriced.status==='answered'&&unpriced.costUsd===null&&unpriced.inputTokens===100,
    'an unpriced response remains unpriced');
  respond='pending';const pending=service.ask(input);
  check(service.history(project.id).some(t=>t.status==='pending'),'an active request survives concurrent history refresh');
  check(await reject(input),'a second request cannot fan out while one is pending');
  check(service.cancel(),'cancel reaches the active request');
  const cancelled=await pending;
  check(cancelled.status==='cancelled'&&cancelled.costUsd===null,'cancelled requests do not invent token usage or cost');
  check(!service.cancel(),'cancel has no effect after the request ends');
  respond='ok';const recovered=await service.ask(input);
  check(recovered.status==='answered','a stopped request releases the next explicit send');
  const restarted=createCompanionService({database:db,facts,available:()=>false,checkHalt:()=>{},complete:async()=>{throw new Error('offline');}});
  db().prepare("UPDATE companion_turns SET status='pending' WHERE id=?").run(recovered.id);
  check(restarted.history(project.id).find(t=>t.id===recovered.id)?.status==='failed','interrupted requests are reconciled after restart without replay');
  db().prepare('DELETE FROM companion_turns WHERE scope_key=?').run(project.id);
  const after=db().prepare('SELECT COUNT(*) AS n FROM companion_turns').get() as {n:number};
  check(after.n===before.n,'companion fixtures leave other history intact');
}
