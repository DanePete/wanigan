#!/usr/bin/env node
/** Relay DOM checks with deliberately synthetic records. No provider is called,
 * no session is launched, and these fixtures establish no main-process claim.
 * npm run build && node scripts/probe-relay-workspace.mjs [--before] [--electron]
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { openRenderer } from './renderer-harness.mjs';
import { launchWanigan } from './electron-harness.mjs';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/relay-workspace-2026-09-19', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const results = [], errors = [];
const record = text => { results.push(text); console.log(text); };
const fixture = (empty = false) => `
(() => {
 const base=window.wanigan,now=Date.now();
 localStorage.setItem('wanigan.project','p1');
 const mkNode=(id,docketId,kind,status,deps=[])=>({id,docketId,kind,title:kind[0].toUpperCase()+kind.slice(1)+' the checkout retry',instructions:'Keep successful checkout unchanged. Cover duplicate callbacks and the timeout path.',dependsOn:deps,claimPath:null,status,providerId:kind==='estimate'||kind==='verify'?null:'claude',model:kind==='estimate'||kind==='verify'?null:'claude-sonnet-5',effort:'high',accountId:'acct_work',permissionMode:null,sessionId:status==='running'?'s1':null,worktree:null,startedAt:status==='completed'?now-1800000:status==='running'?now-300000:null,endedAt:status==='completed'?now-600000:null,detail:null,deferUntil:null,reopenedAt:null,gateRunningSince:null,queued:false});
 const mkRead=(id,title,kinds,statuses)=>{
  const nodes=kinds.map((kind,i)=>mkNode(id+'-'+kind,id,kind,statuses[i],i?[id+'-'+kinds[i-1]]:[]));
  const docket={id,projectId:'p1',projectName:'storefront',title,objective:'Make checkout retries safe even when a successful payment response never reaches the customer.',acceptance:['Duplicate callbacks never create a second charge.','The timeout can be retried without losing the original order.'],risk:'elevated',budgetUsd:20,baseCommit:'a18f50cc937',status:'executing',createdAt:now-3600000,updatedAt:now-300000,autopilot:{enabled:false,providerId:null,model:null,budgetUsd:20,spendUsd:1.84,spendStatus:'partial',haltedReason:null,haltedAt:null},gate:{},nodes,proofs:nodes.filter(n=>n.kind==='verify'&&n.status==='completed').map(n=>({id:'proof-'+n.id,docketId:id,nodeId:n.id,kind:'test',status:'passed',summary:'Two configured review checks passed.',createdAt:now-2000})),claims:[],checkpoints:[],reviewCommands:2};
  const recorded=nodes.map(n=>({nodeId:n.id,effort:n.effort,handbacks:0,completed:n.providerId?(n.status==='completed'?18:n.status==='running'?7:0):0,completions:n.providerId&&n.status==='running'?[now-24000,now-18000,now-12000,now-6000]:[],route:n.providerId?{proofId:'route-'+n.id,createdAt:now-3600000,providerId:n.providerId,route:{model:n.model,effort:'high',source:'profile-default',confidence:null,reason:'The saved profile default runs this phase; no routing suggestion was requested.'}}:null}));
  const forecast=kinds.includes('estimate')?{perPhase:nodes.filter(n=>n.kind!=='estimate').map(n=>({nodeId:n.id,kind:n.kind,route:{providerId:n.providerId,model:n.model,effort:n.effort},n:6,nPriced:n.kind==='verify'?0:4,basis:'model',medianMs:360000,medianUsd:n.kind==='verify'?null:0.76})),totalMs:1440000,totalUsd:null,n:6,priced:3,phases:4,evidenceLevel:'estimate',computedAt:now-600000}:null;
  return {docket,relay:true,nodes:recorded,pipeline:kinds.length===3?{pipeline:'direct',phases:kinds,confidence:0.94,reason:'The saved routing decision omitted planning and estimating.'}:null,forecast,handbackLimit:3};
 };
 const rows=[mkRead('standard','A checkout you can trust',['plan','estimate','implement','verify','review'],['completed','completed','ready','blocked','blocked']),mkRead('direct','A faster receipt',['implement','verify','review'],['ready','blocked','blocked']),mkRead('working','Guard the payment boundary',['plan','estimate','implement','verify','review'],['completed','completed','running','blocked','blocked']),mkRead('review','Review the retry evidence',['plan','estimate','implement','verify','review'],['completed','completed','completed','completed','running'])];
 window.__relayRows=${empty ? '[]' : 'rows'};window.__relayCalls=[];window.__relayReads=[];
 const accounts=[{id:'acct_work',harness:'claude-code',label:'Work',configDir:'/example/work',adopted:true,isDefault:true,present:true},{id:'acct_personal',harness:'claude-code',label:'Personal',configDir:'/example/personal',adopted:false,isDefault:false,present:true}];
 const relay={list:async projectId=>{window.__relayLists=(window.__relayLists??[]).concat(projectId);const rows=structuredClone(window.__relayRows.filter(r=>r.docket.projectId===projectId).map(r=>r.docket));if(window.__relayListFailure)throw new Error('Fixture relay list failed');if(window.__relayListHold===projectId)return new Promise(resolve=>window.__relayListRelease=()=>resolve(rows));return rows;},read:async id=>{window.__relayReads.push(id);const row=structuredClone(window.__relayRows.find(r=>r.docket.id===id));if(window.__relayReadFailure===id)throw new Error('Fixture relay read failed');if(window.__relayHold===id)return new Promise(resolve=>window.__relayRelease=()=>resolve(row));return row;},preview:async input=>{window.__relayCalls.push(['preview',structuredClone(input)]);const value={asked:true,phases:['implement','verify','review'],pipeline:{pipeline:'direct',confidence:0.94},routes:{implement:{route:{model:'claude-sonnet-5',effort:'high',source:'suggested',confidence:0.91,reason:'A synthetic fixture suggestion cleared the saved confidence threshold.'},suggested:{model:'claude-sonnet-5',effort:'high',confidence:0.91},deliberation:null}},estimatedUsd:0.0000378};if(window.__relayPreviewHold)await new Promise(resolve=>window.__relayPreviewRelease=resolve);return value;},create:async input=>{window.__relayCalls.push(['create',structuredClone(input)]);if(window.__relayCreateHold)await new Promise(resolve=>window.__relayCreateRelease=resolve);const row=mkRead('created',input.intent.split('\\n')[0],['plan','estimate','implement','verify','review'],['ready','blocked','blocked','blocked','blocked']);window.__relayRows.unshift(row);return row;},estimate:async id=>{window.__relayCalls.push(['estimate',id]);return structuredClone(window.__relayRows.find(r=>r.docket.id===id));}};
 window.wanigan=new Proxy(base,{get(api,service){if(service==='relay')return new Proxy(api.relay,{get(old,method){return method in relay?relay[method]:old[method];}});if(service==='accounts')return new Proxy(api.accounts,{get(old,method){return method==='listForProvider'?async()=>{if(window.__relayAccountsFailure)throw new Error('Fixture account read failed');return accounts;}:old[method];}});if(service==='prefs')return new Proxy(api.prefs,{get(old,method){return method==='all'?async()=>({...await old.all(),fluid:'off',motion:'auto'}):old[method];}});if(service==='control')return new Proxy(api.control,{get(old,method){if(['start','complete','runProof','retry'].includes(method))return async(...args)=>{window.__relayCalls.push([method,...args]);if(window.__relayActionHold===method)await new Promise(resolve=>window.__relayActionRelease=resolve);if(method==='runProof')return {status:'passed',summary:'Fixture review checks passed.'};if(method==='complete')window.__relayRows.flatMap(r=>r.docket.nodes).find(n=>n.id===args[0]).status='completed';if(method==='start'){const n=window.__relayRows.flatMap(r=>r.docket.nodes).find(n=>n.id===args[0]);n.status='running';n.sessionId='s1';}return {};};return old[method];}});return api[service];}});
})();`;
async function setTheme(page, theme) {
 await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.dataset.themePreference=t;document.documentElement.style.colorScheme=t;window.dispatchEvent(new CustomEvent('wanigan:theme-changed',{detail:{preference:t,resolved:t}}));},theme);
 await page.waitForTimeout(180);
}
async function capture(page, name) {
 await page.evaluate(()=>document.activeElement?.blur());
 for(const theme of ['dark','light']) {await setTheme(page,theme);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css'});}
}
async function toRelay(page) {
 await page.locator('.app-header').waitFor();
 await page.evaluate(()=>document.activeElement?.blur());
 await page.keyboard.press('Meta+Shift+R');
 await page.getByRole('heading',{name:'Relay',exact:true}).waitFor();
 await page.waitForTimeout(600);
}
if(process.argv.includes('--electron')) {
 const userData=mkdtempSync(path.join(tmpdir(),'wanigan-relay-real-'));
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
 let app, realPage, captureError;
 try {const launched=await launchWanigan(require('playwright-core')._electron,{root,userData,env});app=launched.app;realPage=launched.page;await toRelay(realPage);await capture(launched.page,'real-empty');record('Real Electron Relay empty view captured from an isolated profile. No session or provider action was requested.');}
 catch(error){captureError=error;record('Real Electron capture blocked: '+error.message.split('\n').slice(0,4).join(' '));if(realPage){await realPage.screenshot({path:path.join(out,'real-capture-blocked.png'),scale:'css'}).catch(()=>{});writeFileSync(path.join(out,'real-capture-blocked.txt'),await realPage.locator('body').innerText().catch(()=>''));}}
 finally {if(app)await app.close();rmSync(userData,{recursive:true,force:true});}
 writeFileSync(path.join(out,'real-electron.json'),JSON.stringify({passed:!captureError,results},null,2)+'\n');
 if(captureError)throw captureError;
 if(process.argv.includes('--electron-only'))process.exit(0);
}
for(const empty of [false,true]) {
 const {page,close}=await openRenderer({theme:'dark',width:1440,height:1000,instrument:fixture(empty),onError:m=>{if(!/WebGPU/.test(m))errors.push(m);}});
 try {
  await toRelay(page);
  const choose=async id=>{
   if(before)await page.getByRole('button',{name:({standard:'A checkout you can trust',direct:'A faster receipt',working:'Guard the payment boundary',review:'Review the retry evidence'})[id],exact:true}).click();
   else {await page.getByRole('combobox',{name:'Choose a relay'}).selectOption(id);await page.waitForFunction(id=>document.querySelector('.rl-summary h2')?.textContent===window.__relayRows.find(row=>row.docket.id===id)?.docket.title,id);}
   await page.waitForTimeout(250);
  };
  await capture(page,empty?'empty':'standard');
  if(!empty) {
   if(!before) {
    assert.equal(await page.locator('.rl-stage-button').count(),5);
    assert.equal(await page.locator('.rl-composer').isVisible(),false);
    assert.match(await page.locator('.rl-next').innerText(),/Cost is unpriced/);
    assert.doesNotMatch(await page.locator('.rl-view').innerText(),/\$0\.00/);
    const primary=await page.getByRole('button',{name:'Start implementation',exact:true}).boundingBox();
    assert(primary.y+primary.height<=1000,'the current action is visible in the first screen');
    assert.deepEqual(await page.evaluate(()=>window.__relayCalls),[]);
    await page.locator('.rl-stage-button').first().focus();await page.keyboard.press('Enter');
    assert.equal(await page.locator('.rl-stage-button').first().getAttribute('aria-pressed'),'true');
    assert.match(await page.locator('.rl-detail').getAttribute('aria-label'),/^Plan /);
    await page.locator('.rl-stage-button').filter({has:page.getByText('Verify',{exact:true})}).click();await capture(page,'verify-details');
    await page.getByRole('button',{name:'Back to current stage',exact:true}).click();
    assert.match(await page.locator('.rl-detail').getAttribute('aria-label'),/^Implement /);
    record('The current action fits the first screen, initial navigation makes no mutation, unknown cost stays unpriced, and keyboard stage inspection returns to the current stage.');
   }
   await choose('direct');await capture(page,'direct');
   if(!before) {
    assert.deepEqual(await page.locator('.rl-stage-name').allTextContents(),['Implement','Verify','Review']);
    assert.equal(await page.locator('.rl-rig svg > g').count(),3);
    assert(await page.getByRole('button',{name:'Start implementation',exact:true}).isVisible());
    record('A direct relay contains exactly three matching labels and vessels and has an actionable implementation stage.');
   }
   await choose('working');await capture(page,'working');
   await page.emulateMedia({reducedMotion:'reduce'});await page.waitForTimeout(200);await capture(page,'reduced-motion');
   assert.equal(await page.locator('.rl-rig').getAttribute('data-rl-tier'),'still');
   if(!before)assert.equal(await page.locator('.rl-next-content').evaluate(el=>getComputedStyle(el).animationDuration),'0s');
   await page.emulateMedia({reducedMotion:'no-preference'});
   for(const width of before?[900]:[900,720]) {
    await page.setViewportSize({width,height:900});await page.waitForTimeout(250);
    if(!before){const shown=await page.locator('.rl-stage-list').evaluate(el=>{const button=el.querySelector('[aria-pressed=true]').getBoundingClientRect(),list=el.getBoundingClientRect();return button.left>=list.left-1&&button.right<=list.right+1;});assert(shown,'the current selected stage is fully visible after narrowing');}
    await capture(page,width===900?'narrow':'narrow-720');
    if(!before){const size=await page.locator('.rl-view').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));assert(size.scroll<=size.client+1,'Relay must fit its narrow viewport');
     if(width===720){await page.locator('.rl-stage-button').first().focus();await page.keyboard.press('End');assert.equal(await page.locator('.rl-stage-button').last().getAttribute('aria-pressed'),'true');
      const visible=await page.locator('.rl-stage-list').evaluate(el=>{const row=el.lastElementChild.getBoundingClientRect(),list=el.getBoundingClientRect();return row.left>=list.left-1&&row.right<=list.right+1;});assert(visible,'keyboard stage selection scrolls within its own horizontal rail');
      await page.keyboard.press('Home');assert.equal(await page.locator('.rl-stage-button').first().getAttribute('aria-pressed'),'true');
     }
    }
   }
   await page.setViewportSize({width:1440,height:1000});
   if(!before) {
    await choose('standard');
    await page.evaluate(()=>{const row=window.__relayRows.find(row=>row.docket.id==='working');window.__relaySavedWorking=structuredClone(row);row.nodes.find(n=>n.nodeId==='working-implement').completed=50;});
    await choose('working');
    const grains=()=>page.locator('.rl-silt').nth(2).locator('.rl-grain');
    assert.equal(await grains().count(),24);assert.equal(await page.locator('.rl-silt').nth(2).locator('[data-rl-arrived=now]').count(),0);
    const setCount=async(count,newSession=false)=>{await page.evaluate(({count,newSession})=>{const row=window.__relayRows.find(row=>row.docket.id==='working');if(newSession)row.docket.nodes.find(n=>n.id==='working-implement').sessionId='s-new';row.nodes.find(n=>n.nodeId==='working-implement').completed=count;window.dispatchEvent(new Event('visibilitychange'));document.dispatchEvent(new Event('visibilitychange'));},{count,newSession});await page.waitForFunction(count=>document.querySelector('.rl-stage-button[aria-current=step] .rl-stage-evidence')?.textContent?.startsWith(count+' tool'),count);};
    await setCount(0,true);assert.equal(await grains().count(),0);await setCount(1);assert.equal(await grains().first().getAttribute('data-rl-arrived'),'now');
    await setCount(2);await setCount(1);await setCount(2);assert.equal(await grains().nth(1).getAttribute('data-rl-arrived'),'before');
    await page.evaluate(()=>{window.__relayRows=window.__relayRows.map(row=>row.docket.id==='working'?window.__relaySavedWorking:row);});
    record('A new session establishes its own grain baseline, new recorded activity settles once, and a falling/rising count does not replay old grains.');
    await page.evaluate(()=>window.__relayHold='direct');
    await page.getByRole('combobox',{name:'Choose a relay'}).selectOption('direct');
    await page.waitForFunction(()=>typeof window.__relayRelease==='function');
    assert.equal(await page.locator('.rl-summary').count(),0);
    assert.equal(await page.getByRole('button',{name:'Start implementation',exact:true}).count(),0);
    await choose('working');
    await page.evaluate(()=>{window.__relayHold=null;window.__relayRelease();});
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.rl-summary h2').innerText(),'Guard the payment boundary');
    await page.evaluate(()=>window.__relayReadFailure='direct');
    await page.getByRole('combobox',{name:'Choose a relay'}).selectOption('direct');
    await page.getByText('Fixture relay read failed',{exact:true}).waitFor();
    assert.equal(await page.locator('.rl-summary').count(),0);
    await page.evaluate(()=>window.__relayReadFailure=null);
    await page.getByRole('button',{name:'Retry refresh',exact:true}).click();
    await page.locator('.rl-summary h2').filter({hasText:'A faster receipt'}).waitFor();
    record('An unresolved or failed selection exposes no previous relay actions; late reads cannot replace the newer selected relay, and a failed read can be retried.');
    const switchProject=async name=>{await page.getByRole('button',{name:/^Switch project space:/}).click();await page.getByRole('option').filter({has:page.locator('strong',{hasText:name})}).click();};
    await page.evaluate(()=>window.__relayListHold='p2');await switchProject('platform');
    await page.waitForFunction(()=>typeof window.__relayListRelease==='function');
    await switchProject('storefront');await page.locator('.rl-summary h2').filter({hasText:'A checkout you can trust'}).waitFor();
    await page.evaluate(()=>{window.__relayListHold=null;window.__relayListRelease();});await page.waitForTimeout(100);
    assert.equal(await page.locator('.rl-summary h2').innerText(),'A checkout you can trust');
    assert.equal(await page.getByRole('combobox',{name:'Choose a relay'}).locator('option').count(),4);
    record('A delayed list from another project cannot replace the current project’s relay selection.');
    await choose('review');await capture(page,'review');
    assert(await page.getByRole('button',{name:'Approve',exact:true}).isVisible());
    assert(await page.getByRole('button',{name:'Request changes',exact:true}).isVisible());
    assert.match(await page.locator('.rl-decision').innerText(),/may launch another implementation turn/);
    await page.evaluate(()=>{const row=window.__relayRows.find(row=>row.docket.id==='review');row.docket.status='rejected';row.docket.nodes.find(n=>n.kind==='review').status='failed';row.docket.proofs.push({id:'rejected-proof',docketId:'review',nodeId:'review-review',kind:'decision',status:'failed',summary:'Human decision: reject.',createdAt:Date.now()});});
    await choose('standard');await choose('review');
    await page.getByRole('heading',{name:/work was rejected/i}).waitFor();assert.equal(await page.getByRole('button',{name:'Reopen stage',exact:true}).count(),0);await capture(page,'rejected');
    record('A recorded rejection has its own final outcome and does not offer a generic reopen action.');
    await page.getByRole('button',{name:'New relay',exact:true}).click();
    const intent=page.getByRole('textbox',{name:'What should this relay accomplish',exact:true});
    await intent.fill('Keep checkout retries safe.');await capture(page,'create');
    await page.getByRole('button',{name:'Back to relay',exact:true}).click();
    await page.waitForFunction(()=>document.activeElement?.textContent==='New relay');
    await page.getByRole('button',{name:'New relay',exact:true}).click();
    assert.equal(await intent.inputValue(),'Keep checkout retries safe.');
    await page.getByRole('combobox',{name:'Account every phase of this relay launches as'}).selectOption('acct_personal');
    await page.getByRole('button',{name:/Show: Choose the model for a stage yourself/}).click();
    await page.getByRole('combobox',{name:'Implement account override'}).selectOption('acct_work');
    await page.getByRole('combobox',{name:'Review account override'}).selectOption({index:1});
    await page.evaluate(()=>window.__relayPreviewHold=true);
    await page.getByRole('button',{name:'Suggest routes',exact:true}).click();await page.waitForFunction(()=>typeof window.__relayPreviewRelease==='function');
    assert(await page.getByRole('combobox',{name:'Choose a relay'}).isDisabled());
    assert(await page.getByRole('button',{name:'Back to relay',exact:true}).isDisabled());
    await page.evaluate(()=>{window.__relayPreviewHold=false;window.__relayPreviewRelease();});await page.locator('.rl-guess').waitFor();
    await page.getByRole('textbox',{name:'Implement model override'}).fill('claude-sonnet-5');
    assert.equal(await page.locator('.rl-guess').count(),0);
    await page.setViewportSize({width:1440,height:1200});await capture(page,'create-overrides');await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>window.__relayCreateHold=true);
    await page.getByRole('button',{name:'Create relay',exact:true}).click();await page.waitForFunction(()=>typeof window.__relayCreateRelease==='function');
    assert(await page.getByRole('combobox',{name:'Choose a relay'}).isDisabled());
    await page.evaluate(()=>{window.__relayCreateHold=false;window.__relayCreateRelease();});
    await page.locator('.rl-summary h2').filter({hasText:'Keep checkout retries safe.'}).waitFor();
    const calls=await page.evaluate(()=>window.__relayCalls),created=calls.find(call=>call[0]==='create')?.[1];
    assert.equal(created.accountId,'acct_personal');assert.equal(created.routes.implement.accountId,'acct_work');assert.equal(created.routes.review.accountId,null);
    assert.equal(created.routes.plan,undefined);assert.equal(created.routes.verify,undefined);
    assert.equal(calls.filter(call=>call[0]==='start').length,0);
    assert(await page.getByRole('button',{name:'Start planning',exact:true}).isVisible());
    record('The composer restores its canceled draft and focus, invalidates a routing preview when overrides change, preserves account inheritance, and creates stages without starting a session.');
   }
   record('Captured standard, direct, working, reduced motion, and narrow layouts in both themes.');
  } else {
   if(!before){
    await page.getByRole('textbox',{name:'What should this relay accomplish',exact:true}).fill('Check account recovery.');
    await page.evaluate(()=>window.__relayAccountsFailure=true);await page.getByRole('combobox',{name:'Profile for this relay'}).selectOption('codex');
    await page.getByText('Fixture account read failed',{exact:false}).waitFor();assert(await page.getByRole('button',{name:'Create relay',exact:true}).isDisabled());
    await page.evaluate(()=>window.__relayAccountsFailure=false);await page.getByRole('button',{name:'Retry accounts',exact:true}).click();
    await page.getByRole('combobox',{name:'Account every phase of this relay launches as'}).waitFor();assert(await page.getByRole('button',{name:'Create relay',exact:true}).isEnabled());
    record('Account read failures keep creation disabled until an explicit successful retry.');
   }
   record('Captured the empty Relay composer in both themes.');
  }
 } catch(error) {
  await page.screenshot({path:path.join(out,'failure.png'),scale:'css'}).catch(()=>{});
  throw error;
 } finally {await close();}
}
record('Renderer errors: '+errors.length);if(errors.length)console.log(errors);
writeFileSync(path.join(out,'verification.json'),JSON.stringify({mode:before?'before':'after',scope:'Synthetic renderer fixtures; no provider calls, sessions, main-process behavior, or persistence validated.',results,errors},null,2)+'\n');
assert.deepEqual(errors,[]);
rmSync(path.join(out,'failure.png'),{force:true});
