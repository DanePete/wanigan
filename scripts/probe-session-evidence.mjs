#!/usr/bin/env node
// Isolated built renderer + synthetic bridge. Never starts a real Wanigan main or agent.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { createReadStream, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
const root = path.resolve(import.meta.dirname, '..');
const { _electron } = createRequire(import.meta.url)('playwright-core');
const before = process.argv.includes('--before');
const output = path.join(root, 'docs/visuals/session-evidence-2026-09-15', before ? 'before' : 'after');
mkdirSync(output, { recursive: true });
const dir = mkdtempSync('/private/tmp/wanigan-session-evidence-');
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:960,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks = [], errors = [];
let server;
try {
  const page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', e => errors.push(e.message));
  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.addInitScript(STUB + `
    (()=>{
      const api=window.wanigan,proxy=(base,over)=>new Proxy(base,{get:(t,p)=>p in over?over[p]:t[p]});
      localStorage.setItem('wanigan.project','p1');localStorage.setItem('wanigan.code','0');
      window.__sessionEvidence={mode:'fallback',calls:[]};const state=window.__sessionEvidence;
      window.wanigan=proxy(api,{
        prefs:proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})}),
        sessions:proxy(api.sessions,{list:async()=>(await api.sessions.list()).filter(s=>s.id!=='s3').map(s=>({...s,projectId:'p1',projectName:'storefront',projectPath:'/example/storefront',worktree:null,harnessId:s.providerId==='codex'?'codex':'claude-code',accountId:s.providerId==='codex'?'account-work':'account-claude',accountLabel:'Work',displayTitle:s.providerId==='codex'?'Codex account scope':'Claude transcript provenance'})),scrollback:async()=> 'Synthetic terminal evidence fixture. No real agent is running.\\r\\n'}),
        transcripts:proxy(api.transcripts,{context:async(id)=>id==='s1'?({kind:'ok',tokens:190000,window:200000,percent:95,model:'claude-sonnet-4-5',at:Date.now(),conversationMatch:state.mode==='fallback'?'lifetime-fallback':'exact',windowSource:state.mode==='reported'?'cli-reported':'assumed-200k',windowNote:null}):({kind:'unsupported'})}),
        codex:proxy(api.codex,{status:async(...args)=>{state.calls.push(args);return {fetchedAt:Date.now(),plan:'pro',primary:{usedPercent:72,remainingPercent:28,resetsAt:null,windowMinutes:300},secondary:null,spendControlReached:false};}})
      });
    })();
  `);
  let url = rendererURL;
  if (before) {
    const saved = '/private/tmp/wanigan-session-evidence-before-20260915';
    server=http.createServer((req,res)=>{const file=path.join(saved,(req.url??'/').split('?')[0]);res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');createReadStream(file).on('error',()=>res.end()).pipe(res);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));server.unref();url='http://127.0.0.1:'+server.address().port+'/index.html';
  }
  await page.goto(url);await page.locator('.shell').waitFor();
  await page.evaluate(()=>document.activeElement?.blur());await page.keyboard.press('Meta+1');
  await page.locator('.session-item').filter({hasText:'Claude transcript provenance'}).click();
  const badge=page.locator('.nav-usage-status');await badge.waitFor({state:'attached'});
  const shots=async name=>{
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>{
        document.documentElement.dataset.theme=theme;
        window.dispatchEvent(new CustomEvent('wanigan:theme-changed'));
        if(!document.getElementById('evidence-fixture-label')){const label=document.createElement('div');label.id='evidence-fixture-label';label.textContent='SYNTHETIC FIXTURE · NO REAL AGENTS';label.style.cssText='position:fixed;right:8px;bottom:2px;z-index:99999;background:#111;color:white;font:10px monospace;padding:3px 6px';document.body.append(label);}
      },theme);
      await page.screenshot({path:path.join(output,name+'-'+theme+'.png'),animations:'disabled'});
    }
  };
  await shots('sessions-normal-surface');
  // Existing mission-shell CSS hides this mounted component. Expose it only
  // in this labeled fixture; production layout is intentionally unchanged.
  await page.addStyleTag({content:'.mission-shell .nav-usage-status {display:block !important}'});
  await page.locator('#evidence-fixture-label').evaluate(el=>{el.textContent='SYNTHETIC COMPONENT FIXTURE · USAGE BADGE EXPOSED FOR QA · NO REAL AGENTS';});
  if(!before){
    await page.getByText(/ctx unconfirmed/).waitFor();assert.equal(await badge.evaluate(el=>el.classList.contains('low')),false);assert.match(await badge.getAttribute('title'),/fallback transcript.*not attributed/);checks.push('Fallback has no selected-session pressure and discloses identity.');
  }else await page.getByText(/ctx 95%/).waitFor();
  await shots('context-fallback');
  await page.evaluate(()=>{window.__sessionEvidence.mode='reported';});await badge.click();
  await page.getByText(/ctx 95%/).waitFor();
  if(!before){assert.match(await badge.getAttribute('title'),/CLI-reported, not measured/);assert.doesNotMatch(await badge.getAttribute('title'),/assumed/);assert.equal(await badge.evaluate(el=>el.classList.contains('low')),true);checks.push('Exact current context identifies a reported window and can carry pressure.');}
  await shots('context-reported');
  await page.locator('.session-item').filter({hasText:'Codex account scope'}).click();
  await page.getByText(/Now 28% left/).waitFor();
  await page.locator('.handover-bubble').waitFor({state:'hidden'});
  if(!before){const calls=await page.evaluate(()=>window.__sessionEvidence.calls);assert(calls.length>0&&calls.every(args=>args[0]==='s2'));checks.push('Codex quota requests retain the selected session identity.');}
  await shots('codex-account');
  assert.deepEqual(errors,[]);
}finally{
  writeFileSync(path.join(output,'verification.json'),JSON.stringify({before,checks,errors,provenance:'Built renderer with synthetic bridge, isolated Electron profile; no providers or user data.'},null,2)+'\n');
  await app.close();server?.close();
}
