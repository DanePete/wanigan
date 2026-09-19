#!/usr/bin/env node
/** Synthetic renderer fixtures only. Main-process behavior is covered by smoke-relay-delivery.ts. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { openRenderer } from './renderer-harness.mjs';

const out = path.resolve(import.meta.dirname, '../docs/visuals/relay-delivery-2026-09-19/after');
mkdirSync(out, { recursive: true });
const checks = [], errors = [];
const instrument = `(() => {
  const base=window.wanigan, now=Date.now(), sha='a'.repeat(40);
  localStorage.setItem('wanigan.project','p1');
  const stage=kind=>({kind,status:'pending',detail:null,attempts:[],receipt:null});
  const delivery=()=>({commit:stage('commit'),deploy:stage('deploy'),config:{command:'',timeoutMs:600000,updatedAt:null}});
  const make=(id,enabled=true)=>{
    const kinds=['plan','estimate','implement','verify','review'];
    const nodes=kinds.map((kind,i)=>({id:id+'-'+kind,docketId:id,kind,title:kind,instructions:'Review the saved checkout evidence.',dependsOn:i?[id+'-'+kinds[i-1]]:[],claimPath:null,status:'completed',providerId:['estimate','verify'].includes(kind)?null:'claude',model:'claude-sonnet-5',effort:null,accountId:null,permissionMode:null,sessionId:null,worktree:null,startedAt:now-60000,endedAt:now-1000,detail:null,deferUntil:null,reopenedAt:null,gateRunningSince:null,gateReturns:0,queued:false}));
    const docket={id,projectId:'p1',projectName:'storefront',title:enabled?'Deliver the checkout retry':'An earlier review-only relay',objective:'Make checkout retries safe and release the reviewed change.',acceptance:['Retries do not duplicate a charge.'],risk:'elevated',budgetUsd:null,baseCommit:sha,status:'accepted',createdAt:now-600000,updatedAt:now,autopilot:{enabled:false,providerId:null,model:null,budgetUsd:null,spendUsd:0,spendStatus:'unpriced',haltedReason:null,haltedAt:null},gate:{},nodes,proofs:[{id:id+'-verification',docketId:id,nodeId:id+'-verify',kind:'test',status:'passed',summary:'The configured checkout check passed.',createdAt:now-600},{id:id+'-approval',docketId:id,nodeId:id+'-review',kind:'decision',status:'recorded',summary:'Human decision: approve.',createdAt:now-500}],claims:[],checkpoints:[],reviewCommands:1};
    return {docket,delivery:enabled?delivery():null,relay:true,nodes:nodes.map(n=>({nodeId:n.id,effort:null,handbacks:0,completed:0,completions:[],route:null})),pipeline:null,forecast:null,handbackLimit:3};
  };
  window.__deliveryRows=[make('delivery'),make('legacy',false),make('recovery')];window.__deliveryCalls=[];
  const row=id=>window.__deliveryRows.find(r=>r.docket.id===id);
  const record=(method,args)=>window.__deliveryCalls.push([method,...structuredClone(args)]);
  const receipt=(kind,status,command=null)=>({id:kind+'-'+Date.now(),kind,status,startedAt:Date.now(),endedAt:status==='running'?null:Date.now(),checkout:'/example/storefront/.worktrees/checkout-retry',head:sha,files:kind==='commit'?['src/checkout.ts','tests/checkout.test.ts']:[],trailers:[],command,commitHash:sha,message:kind==='commit'?'Fix checkout retries':null,exitCode:status==='failed'?7:status==='running'?null:0,output:status==='failed'?'Deployment command refused the target.':'Fixture command output.',error:status==='failed'?'Command exited 7.':null});
  const relay={
    list:async()=>window.__deliveryRows.map(r=>structuredClone(r.docket)),
    read:async id=>{if(window.__deliveryReadFailure)throw new Error('Fixture refresh failed');return structuredClone(row(id));},
    enableDelivery:async id=>{record('enableDelivery',[id]);row(id).delivery=delivery();return structuredClone(row(id).delivery);},
    reopenDeliveryReview:async id=>{record('reopenDeliveryReview',[id]);const value=row(id);value.docket.status='executing';for(const node of value.docket.nodes){if(node.kind==='verify'||node.kind==='review'){node.status=node.kind==='verify'?'ready':'blocked';node.endedAt=null;node.reopenedAt=Date.now();}}return structuredClone(value.delivery);},
    saveDeployConfig:async(id,config)=>{record('saveDeployConfig',[id,config]);for(const value of window.__deliveryRows)if(value.delivery)value.delivery.config={...config,updatedAt:Date.now()};return structuredClone(row(id).delivery);},
    previewDelivery:async(id,kind)=>{record('previewDelivery',[id,kind]);return {kind,token:'fixture-'+kind,expiresAt:Date.now()+300000,checkout:'/example/storefront/.worktrees/checkout-retry',head:sha,files:kind==='commit'?['src/checkout.ts','tests/checkout.test.ts']:[],message:'Fix checkout retries',trailers:[],command:kind==='deploy'?row(id).delivery.config.command:null,timeoutMs:row(id).delivery.config.timeoutMs,existingCommit:!!window.__existingCommit};},
    commitDelivery:async(id,input)=>{record('commitDelivery',[id,input]);const done=receipt('commit','completed');row(id).delivery.commit={kind:'commit',status:'completed',detail:'The commit is recorded.',attempts:[done],receipt:done};return structuredClone(row(id).delivery);},
    deployDelivery:async(id,input)=>{record('deployDelivery',[id,input]);const attempt=receipt('deploy','running',row(id).delivery.config.command);row(id).delivery.deploy={kind:'deploy',status:'running',detail:'The saved command is running.',attempts:[attempt],receipt:null};return structuredClone(row(id).delivery);},
    cancelDeploy:async id=>{record('cancelDeploy',[id]);const attempt=receipt('deploy','interrupted',row(id).delivery.config.command);attempt.error='Stopped by the operator.';row(id).delivery.deploy={kind:'deploy',status:'interrupted',detail:attempt.error,attempts:[attempt],receipt:null};return structuredClone(row(id).delivery);},
  };
  window.__failDeployment=()=>{const value=row('delivery').delivery;const attempt=receipt('deploy','failed',value.config.command);value.deploy={kind:'deploy',status:'failed',detail:attempt.error,attempts:[attempt],receipt:null};};
  window.__finishDeployment=()=>{const value=row('delivery').delivery;const attempt=receipt('deploy','completed',value.config.command);value.deploy={kind:'deploy',status:'completed',detail:'Command exited 0.',attempts:[attempt,...value.deploy.attempts],receipt:attempt};};
  window.wanigan=new Proxy(base,{get(api,service){if(service==='relay')return new Proxy(api.relay,{get(old,method){return relay[method]??old[method];}});if(service==='prefs')return new Proxy(api.prefs,{get(old,method){return method==='all'?async()=>({...await old.all(),fluid:'off'}):old[method];}});return api[service];}});
})();`;

const { page, close } = await openRenderer({ theme: 'dark', width: 1440, height: 1100, instrument, onError: error => { if (!/WebGPU/.test(error)) errors.push(error); } });
const capture = async name => {
  await page.evaluate(() => document.activeElement?.blur());
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => { document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme; }, theme);
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css' });
  }
};
const refresh = async () => { await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(300); };
const check = message => { checks.push(message); console.log(message); };
const choose = async id => { await page.getByRole('combobox', { name: 'Choose a relay' }).selectOption(id); await page.waitForTimeout(350); };
try {
  await page.locator('.app-header').waitFor(); await page.keyboard.press('Meta+Shift+R');
  await page.getByRole('heading', { name: 'Relay', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Preview commit', exact: true }).waitFor();
  assert.deepEqual(await page.locator('.rl-stage-name').allTextContents(), ['Plan','Estimate','Implement','Verify','Review','Commit','Deploy']);
  assert.deepEqual(await page.evaluate(() => window.__deliveryCalls), []);
  await capture('commit-ready');
  await page.setViewportSize({ width: 1440, height: 1350 });
  await capture('all-stages');
  await page.setViewportSize({ width: 1440, height: 1100 });
  check('Seven recorded stages render; opening an approved Relay makes no commit or deployment call.');

  await page.getByRole('button', { name: 'Configure deployment', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project deployment command' }).fill('npm run build &&\nnpm run deploy:staging');
  await page.getByRole('spinbutton', { name: 'Deployment timeout in seconds' }).fill('120');
  await capture('configure-before-commit');
  await page.getByRole('button', { name: 'Save deployment command', exact: true }).click();
  await page.getByRole('button', { name: 'Deployment settings', exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__deliveryCalls.filter(c => ['commitDelivery','deployDelivery'].includes(c[0])).length), 0);
  await page.getByRole('button', { name: 'Back to current stage', exact: true }).click();
  check('The project deployment command can be configured before committing; saving it performs neither delivery action.');

  await page.getByRole('button', { name: 'Preview commit', exact: true }).click();
  await page.getByRole('button', { name: 'Stage files and commit', exact: true }).waitFor();
  assert.match(await page.locator('.rl-next').innerText(), /src\/checkout.ts/);
  assert.match(await page.locator('.rl-next').innerText(), /does not push/);
  assert.equal(await page.evaluate(() => window.__deliveryCalls.filter(c => c[0]==='commitDelivery').length), 0);
  await capture('commit-preview');
  await page.getByRole('textbox', { name: 'Relay commit message' }).fill('Fix reviewed checkout retries');
  await page.getByRole('button', { name: 'Stage files and commit', exact: true }).click();
  await page.getByRole('heading', { name: 'Deploy the recorded commit.' }).waitFor();
  assert.equal(await page.evaluate(() => window.__deliveryCalls.find(c => c[0]==='commitDelivery')[2].message), 'Fix reviewed checkout retries');
  check('The commit preview shows checkout, changed files and message; a separate explicit action sends the preview token and edited message.');

  await page.getByRole('button', { name: 'Preview deployment', exact: true }).click();
  await page.getByRole('button', { name: 'Run deployment', exact: true }).waitFor();
  assert.match(await page.locator('.rl-next').innerText(), /npm run build &&\nnpm run deploy:staging/);
  assert.match(await page.locator('.rl-next').innerText(), /2m 00s/);
  assert.equal(await page.evaluate(() => window.__deliveryCalls.filter(c => c[0]==='deployDelivery').length), 0);
  await capture('deploy-preview');
  await page.getByRole('button', { name: 'Run deployment', exact: true }).click();
  await page.getByRole('button', { name: 'Stop deployment command', exact: true }).waitFor();
  assert(await page.getByRole('button', { name: 'Stop deployment command', exact: true }).isEnabled());
  await capture('deploy-running');
  await page.getByRole('button', { name: 'Stop deployment command', exact: true }).click();
  await page.getByRole('button', { name: 'Preview deployment retry', exact: true }).waitFor();
  check('Saving a project command does not run it; deployment shows the exact command and revision, starts explicitly, and remains cancellable.');

  await page.evaluate(() => window.__failDeployment()); await refresh();
  await page.getByRole('button', { name: 'Preview deployment retry', exact: true }).waitFor();
  await page.locator('.rl-detail .rl-evidence ol details summary').first().click();
  assert.match(await page.locator('.rl-detail').innerText(), /Command exited 7/);
  await capture('deploy-failed');
  await page.evaluate(() => window.__finishDeployment()); await refresh();
  await capture('deploy-complete');
  assert.match(await page.locator('.rl-view').innerText(), /7 of 7 stages complete/);
  check('Failure evidence and an explicit retry remain visible; completion is described as command execution with a recorded result.');

  await choose('legacy');
  assert.equal(await page.locator('.rl-stage-name').count(), 5);
  await capture('legacy');
  await page.getByRole('button', { name: /Add.*commit.*deploy/i }).click();
  await page.getByRole('button', { name: 'Preview commit', exact: true }).waitFor();
  assert.equal(await page.locator('.rl-stage-name').count(), 7);
  await page.evaluate(() => { window.__existingCommit=true; });
  await page.getByRole('button', { name: 'Preview commit', exact: true }).click();
  await page.getByRole('button', { name: 'Record existing commit', exact: true }).waitFor();
  await capture('existing-commit');
  check('Older relays keep five stages until explicitly extended, and a clean checkout offers a distinct existing-commit action.');

  await page.evaluate(() => { window.__deliveryReadFailure=true; }); await refresh();
  assert(await page.getByRole('button', { name: 'Record existing commit', exact: true }).isDisabled());
  await page.evaluate(() => { window.__deliveryReadFailure=false; }); await refresh();
  await page.setViewportSize({ width: 720, height: 1000 }); await page.waitForTimeout(300);
  const size=await page.locator('.rl-view').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth}));
  assert(size.scroll <= size.client+1, 'seven-stage Relay fits a narrow viewport');
  await capture('narrow');
  check('A failed refresh disables delivery mutations; seven stages and the commit preview fit a narrow viewport.');
  await page.setViewportSize({ width: 1440, height: 1100 });
  await choose('recovery');
  const beforeRecovery = await page.evaluate(() => window.__deliveryCalls.length);
  await page.getByRole('button', { name: 'Reopen verification and review', exact: true }).click();
  await page.getByRole('button', { name: 'Run verification', exact: true }).waitFor();
  assert.deepEqual(await page.evaluate(before => window.__deliveryCalls.slice(before), beforeRecovery), [['reopenDeliveryReview','recovery']]);
  assert.match(await page.locator('.rl-next').innerText(), /Check the implementation/);
  assert.equal(await page.locator('.rl-stage-button').filter({ has: page.getByText('Review', { exact: true }) }).getByText('blocked', { exact: true }).count(), 1);
  await capture('review-reopened');
  check('Commit recovery reopens verification and review through one explicit request, keeps earlier evidence, and launches no agent.');
  await page.getByRole('button', { name: 'New relay', exact: true }).click();
  await page.getByRole('textbox', { name: 'What should this relay accomplish', exact: true }).fill('Fix checkout retries and release the reviewed change.');
  assert(await page.getByRole('checkbox', { name: 'Include git commit and deploy stages' }).isChecked());
  await capture('create');
  await page.getByRole('checkbox', { name: 'Include git commit and deploy stages' }).uncheck();
  assert.match(await page.locator('.rl-composer').innerText(), /finish at the review decision/);
  check('New relays include explicit delivery stages by default; the composer can deliberately keep a review-only workflow.');
  assert.deepEqual(errors, []);
} finally {
  writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, checks, errors }, null, 2)+'\n');
  await close();
}
