#!/usr/bin/env node
// Real built renderer; synthetic bridge data. No main process, PTY or Git work.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/workbench-2026-09-15/history', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-evidence-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:940,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const checks = [], failures = [], errors = [];
let page;
const check = async (name, run) => {
  try { await run(); checks.push(name); console.log('PASS ' + name); }
  catch (error) { failures.push({ name, error: String(error) }); console.log('FAIL ' + name + ': ' + String(error)); }
};
try {
  page = await app.firstWindow(); page.setDefaultTimeout(7000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (()=>{
      localStorage.setItem('wanigan.project','p1');
      const api=window.wanigan, now=Date.now(), proxy=(base,overrides)=>new Proxy(base,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
      const recent={id:'past-checkout',conversationId:'exact-checkout-handle',providerId:'claude',projectId:'p1',projectPath:'/example/storefront',projectName:'storefront',worktree:null,model:'opus',effort:'high',permissionMode:'default',startedAt:now-80000,endedAt:now-5000,exitCode:0,continuationCount:2,live:true,pinnedAt:null,settledAt:null,title:'Repair checkout validation',titleSource:'named'};
      window.__history={creates:[],reads:[],pastScopes:[],fail:false}; const state=window.__history;
      const sessions=proxy(api.sessions,{past:async scope=>{state.pastScopes.push(scope);return [recent];},list:async()=>(await api.sessions.list()).map(s=>({...s,projectPath:s.projectId==='p1'?'/example/storefront':'/example/platform',worktree:s.id==='s1'?'/example/storefront-isolated':null,displayTitle:s.id==='s1'?'Checkout review':null})),create:async opts=>{state.creates.push(opts);return {...(await api.sessions.list())[0],id:'resumed-checkout'};},baseline:async()=>null});
      const transcripts=proxy(api.transcripts,{list:async()=>[{sessionId:recent.id,bytes:1234,turns:205,archivedAt:now-5000},{sessionId:'older-record',bytes:200,turns:2,archivedAt:now-600000}],get:async id=>{state.reads.push(id);if(state.fail)throw Error('Synthetic archive unavailable');return {bytes:1234,note:null,turns:id===recent.id?Array.from({length:205},(_,i)=>({at:now-(205-i)*1000,role:i%2?'assistant':'user',text:i===204?'Latest checkout outcome is preserved':'Synthetic recorded turn '+i})):[{at:now-600000,role:'assistant',text:'Older archive: nebula-keyword recovered'}]};},search:async()=>[{sessionId:'older-record',projectName:'platform',projectPath:'/example/platform',providerId:'codex',startedAt:now-600000,snippet:'Older nebula-keyword recovered',role:'assistant',at:now-600000}]});
      const code=proxy(api.code,{editors:async()=>[],changes:async()=>({isRepo:true,branch:'main',headMoved:false,commits:0,files:[],attributed:false,unreadable:null})});
      const review=proxy(api.review,{recipe:async()=>({projectId:'p1',commands:['npm test'],updatedAt:now}),history:async()=>[]});
      window.wanigan=proxy(api,{sessions,transcripts,code,review,prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})}),handoff:proxy(api.handoff,{plan:async()=>({targets:[]})}),policy:proxy(api.policy,{trust:async()=>'project'})});
    })();
  `);
  let url=rendererURL;
  if(before){
    const {default:http}=await import('node:http');const {default:fs}=await import('node:fs');
    const fixtureRoot='/private/tmp/wanigan-workflow-before-renderer';
    const server=http.createServer((req,res)=>{const file=path.join(fixtureRoot,(req.url??'/').split('?')[0]);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');fs.createReadStream(file).on('error',()=>res.end()).pipe(res);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();url='http://127.0.0.1:'+server.address().port+'/index.html';
  }
  await page.goto(url);await page.locator('.shell').waitFor();
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Meta+1');
  await page.getByRole('button',{name:/^Switch project space:/}).click();
  await page.getByRole('option').filter({hasText:'storefront'}).click();
  await page.locator('.past-main').first().waitFor();
  const shots=async name=>{for(const theme of ['dark','light']){await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;if(!document.getElementById('fixture-provenance')){const label=document.createElement('div');label.id='fixture-provenance';label.textContent='SYNTHETIC FIXTURES · NO REAL AGENTS';label.style.cssText='position:fixed;bottom:2px;right:8px;z-index:999999;background:#111;color:white;font:10px monospace;padding:3px 6px';document.body.append(label);}},theme);await page.screenshot({path:path.join(out,name+'-'+theme+'.png'),animations:'disabled'});}};
  await shots('sessions');
  await page.locator('.past-main').first().click();
  await check('Opening Recent reads without launching an agent',async()=>{await page.getByRole('dialog',{name:'Conversation history'}).waitFor();assert.equal(await page.evaluate(()=>window.__history.creates.length),0);});
  if(before){await shots('recent-open');await check('Ordinary sessions have a review work action',async()=>assert.equal(await page.getByRole('button',{name:'Review work',exact:true}).count(),1));}
  else {
    await check('Reader opens latest available turns including outcome beyond turn 200',async()=>{await page.getByText('Latest checkout outcome is preserved',{exact:true}).waitFor();assert.match(await page.locator('.transcript-reader').innerText(),/166–205/);});
    await shots('conversation-reader');
    await page.getByRole('button',{name:'Show 80 earlier turns',exact:true}).click();
    await check('Earlier turns expand without replacing the latest outcome',async()=>{assert.match(await page.locator('.transcript-reader').innerText(),/86–205/);assert.equal(await page.getByText('Latest checkout outcome is preserved',{exact:true}).count(),1);});
    await page.getByRole('searchbox',{name:'Search all local archives'}).fill('nebula-keyword');
    await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('button',{name:/platform.*Older nebula-keyword/}).click();
    await check('Older archived content is searchable and readable outside Recent',async()=>{await page.getByText('Older archive: nebula-keyword recovered',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.__history.creates.length),0);});
    await shots('older-archive-search');
    await page.getByRole('button',{name:'Back to session',exact:true}).click();
    await page.locator('.past-main').first().click();await page.getByText('Latest checkout outcome is preserved',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Resume exact conversation',exact:true}).click();
    await check('Explicit resume preserves the exact durable handle',async()=>{await page.waitForFunction(()=>window.__history.creates.length===1);const value=await page.evaluate(()=>window.__history.creates[0]);assert.deepEqual(value.resumeFrom,{sessionId:'past-checkout',conversationId:'exact-checkout-handle'});assert.equal(value.projectId,'p1');assert.equal(value.permissionMode,'default');});
    await page.getByRole('button',{name:'Review work',exact:true}).click();
    await check('Ordinary review shows changes plus honest project checkout checks',async()=>{await page.getByRole('dialog',{name:'Review session work'}).waitFor();assert.match(await page.locator('.session-review').innerText(),/not this session’s isolated worktree/);assert.equal(await page.locator('.session-review .code-panel').count(),1);assert.equal(await page.getByRole('textbox',{name:'Review gate commands'}).count(),1);});
    await shots('ordinary-session-review');
    await page.getByRole('button',{name:'Back to session',exact:true}).click();
    await check('Recent is read with project scope',async()=>assert((await page.evaluate(()=>window.__history.pastScopes)).includes('p1')));
    await page.setViewportSize({width:960,height:560});
    const composer=page.getByRole('textbox',{name:'Message the agent',exact:true});
    await composer.fill('An unsent compact-window draft');
    await shots('sessions-960x560');
    await check('A short window retains a useful terminal with its draft open',async()=>{const rect=await page.locator('.terminal-host:visible').boundingBox();assert(rect.height>=100,'Terminal height '+rect.height);});
    await page.getByRole('button',{name:'History',exact:true}).click();await shots('history-960x560');
    await page.keyboard.press('Escape');
    await check('Closing history restores session draft and focus',async()=>{assert.equal(await composer.inputValue(),'An unsent compact-window draft');assert.equal(await page.getByRole('button',{name:'History',exact:true}).evaluate(element=>element===document.activeElement),true);});
  }
} catch(error){failures.push({name:'Probe orchestration',error:String(error.stack??error)});if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});}
finally{writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Isolated Electron renderer and synthetic bridge. No real main, providers, PTY, or archive writes.',checks,failures,errors},null,2)+'\n');await app.close();}
if(failures.length||errors.length)process.exitCode=1;
