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
const out = path.join(root, 'docs/visuals/workbench-2026-09-15/evidence', before ? 'before' : 'after');
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
  page = await app.firstWindow(); page.setDefaultTimeout(10000);
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(STUB + `
    (() => {
      localStorage.setItem('wanigan.code','1');localStorage.setItem('wanigan.project','p1');
      const api=window.wanigan,now=Date.now();
      const proxy=(base,overrides)=>new Proxy(base,{get:(t,p)=>p in overrides?overrides[p]:t[p]});
      window.__evidence={code:'hold',codeReads:0,hold:null,historyReads:0,historyFail:false,runs:[{id:'review-one',projectId:'p1',startedAt:now-4000,endedAt:null,status:'running',results:[{command:'npm test',exitCode:0,durationMs:850,output:'Synthetic test command passed'}]}]};
      const state=window.__evidence;
      const result=()=>({isRepo:true,branch:'main',headMoved:false,commits:0,files:state.code==='ready'||state.code==='unknown'?[{path:'src/checkout.ts',index:' ',work:'M',staged:false,untracked:false,...(state.code==='ready'?{preexisting:false}:{})}]:[],attributed:state.code==='ready',unreadable:state.code==='unreadable'?'Synthetic Git status unavailable':null});
      const code=proxy(api.code,{editors:async()=>[],changes:async()=>{state.codeReads++;if(state.code==='delayed'){const old={...result(),files:[{path:'obsolete-file.ts',index:' ',work:'M',staged:false,untracked:false,preexisting:false}],attributed:true};await new Promise(resolve=>state.hold=resolve);return old;}if(state.code==='hold'){await new Promise(resolve=>state.hold=resolve);}if(state.code==='reject')throw Error('Synthetic changes IPC failed');return result();},diff:async()=>'+ verified checkout change'});
      const sessions=proxy(api.sessions,{list:async()=>(await api.sessions.list()).map(s=>({...s,projectPath:s.projectId==='p1'?'/example/storefront':'/example/platform',displayTitle:s.id==='s1'?'Checkout review':null,harnessId:s.providerId==='claude'?'claude-code':'codex',capabilities:{hooks:false}})),baseline:async()=>({head:'abc123',dirty:[],at:now-90000}),buffer:async()=>''});
      const review=proxy(api.review,{recipe:async()=>({projectId:'p1',commands:['npm test','git diff --check'],updatedAt:now}),history:async()=>{state.historyReads++;if(state.historyFail)throw Error('Synthetic review history unavailable');return structuredClone(state.runs);}});
      const prefs=proxy(api.prefs,{all:async()=>({...await api.prefs.all(),motion:'off',navSidebar:'closed'})});
      window.wanigan=proxy(api,{code,sessions,review,prefs,worktrees:proxy(api.worktrees,{setup:async projectId=>({projectId,depsMode:'link',setup:[],teardown:[],updatedAt:null,include:{state:'absent'}}),commandRuns:async()=>[]}),handoff:proxy(api.handoff,{plan:async()=>({targets:[]})}),policy:proxy(api.policy,{trust:async()=>'project'})});
    })();
  `);
  await page.goto(rendererURL); await page.locator('.shell').waitFor();
  const go = async key => { await page.evaluate(() => document.activeElement?.blur()); await page.keyboard.press(key); };
  const shots = async name => {
    for (const theme of ['dark', 'light']) {
      await page.evaluate(theme => {
        document.documentElement.dataset.theme=theme;
        if (!document.getElementById('evidence-provenance')) { const label=document.createElement('div');label.id='evidence-provenance';label.textContent='SYNTHETIC EVIDENCE FIXTURES · NO REAL AGENTS';label.style.cssText='position:fixed;right:8px;bottom:3px;z-index:999999;background:#111;color:#fff;padding:3px 6px;font:10px monospace;pointer-events:none';document.body.append(label); }
      }, theme);
      await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css',animations:'disabled'});
    }
  };
  await go('Meta+1'); await page.locator('.code-panel').waitFor();
  await page.waitForFunction(() => typeof window.__evidence.hold==='function');
  await check('Changes starts in a reading state without claiming non-repository',async()=>{
    const text=await page.locator('.code-panel').innerText();assert.match(text,/Reading (workspace )?changes/);assert(!text.includes('Not a git repository.'));
  });
  await shots('changes-reading');
  await page.evaluate(()=>{window.__evidence.code='unreadable';window.__evidence.hold();});
  await page.waitForTimeout(120);
  await check('Unreadable Git response names the failure instead of no changes',async()=>{
    const text=await page.locator('.code-panel').innerText();assert.match(text,/Synthetic Git status unavailable/);assert(!text.includes('No changes yet.'));
  });
  await shots('changes-unavailable');
  if (!before) {
    await page.evaluate(()=>window.__evidence.code='ready');
    await page.getByRole('button',{name:'Retry changes',exact:true}).click();
    await page.locator('.code-panel').getByRole('button',{name:/src\/checkout.ts/}).waitFor();
    await page.evaluate(()=>{window.__evidence.code='reject';document.dispatchEvent(new Event('visibilitychange'));});
    await page.getByText('Synthetic changes IPC failed',{exact:false}).waitFor();
    await check('A failed refresh keeps last known files visibly stale',async()=>{
      const text=await page.locator('.code-panel').innerText();assert.match(text,/stale/i);assert.match(text,/src\/checkout.ts/);
    });
    await shots('changes-stale');
    await page.evaluate(()=>window.__evidence.code='unknown');
    await page.getByRole('button',{name:'Retry changes',exact:true}).click();
    await check('Missing baseline is labeled as workspace changes',async()=>{
      await page.getByText(/Workspace changes/).waitFor();assert.match(await page.locator('.code-panel').innerText(),/attribution|attribute|baseline/i);
    });
    await shots('changes-unknown-attribution');
    await page.evaluate(()=>{window.__evidence.code='delayed';window.__evidence.hold=null;document.dispatchEvent(new Event('visibilitychange'));});
    await page.waitForFunction(()=>typeof window.__evidence.hold==='function');
    const slowReads=await page.evaluate(()=>window.__evidence.codeReads);
    await page.waitForTimeout(4300);
    await check('A slow changes read is not superseded by overlapping poll requests',async()=>assert.equal(await page.evaluate(()=>window.__evidence.codeReads),slowReads));
    await go('Meta+2');await page.getByRole('heading',{name:'Fleet',exact:true}).waitFor();
    await page.evaluate(()=>window.__evidence.code='ready');
    await go('Meta+1');await page.locator('.code-panel').waitFor();
    await page.locator('.code-panel').getByRole('button',{name:/src\/checkout.ts/}).waitFor();
    await page.evaluate(()=>window.__evidence.hold());
    await page.waitForTimeout(100);
    await check('A delayed read from an unmounted panel cannot replace current evidence',async()=>{
      const text=await page.locator('.code-panel').innerText();assert.match(text,/src\/checkout.ts/);assert(!text.includes('obsolete-file.ts'));
    });
  }
  // A stored running run is re-read by a fresh component after a route detour.
  await go('Meta+9');await page.getByRole('heading',{name:'Changes',exact:true}).waitFor();
  await page.locator('.gt-review-controls > summary').filter({hasText:'Review gate'}).click();
  await page.locator('.review-result').waitFor();
  await go('Meta+2');await page.getByRole('heading',{name:'Fleet',exact:true}).waitFor();
  await go('Meta+9');await page.getByRole('heading',{name:'Changes',exact:true}).waitFor();
  await page.locator('.gt-review-controls > summary').filter({hasText:'Review gate'}).click();
  await page.locator('.review-result').waitFor();
  await page.getByRole('textbox',{name:'Review gate commands',exact:true}).fill('npm run my-unsaved-check');
  await page.locator('.review-result > summary').click();
  await shots('review-running');
  await page.evaluate(()=>{window.__evidence.runs[0].status='passed';window.__evidence.runs[0].endedAt=Date.now();window.__evidence.runs[0].results.push({command:'git diff --check',exitCode:0,durationMs:12,output:'Synthetic whitespace check passed'});});
  await check('Remounted review follows recorded running status to completion',async()=>{
    await page.waitForFunction(()=>document.querySelector('.review-result > summary')?.textContent?.includes('passed'),{},{timeout:7000});
    assert.match(await page.locator('.review-result').innerText(),/Synthetic whitespace check passed/);
  });
  await check('History refresh preserves the unsaved recipe',async()=>assert.equal(await page.getByRole('textbox',{name:'Review gate commands',exact:true}).inputValue(),'npm run my-unsaved-check'));
  await shots('review-completed');
  if (!before) {
    await page.evaluate(()=>window.__evidence.historyFail=true);
    await page.getByRole('button',{name:'Refresh results',exact:true}).click();
    await page.getByText(/Synthetic review history unavailable/).waitFor();
    await check('History errors retain evidence and recipe with a retry',async()=>{
      assert.match(await page.locator('.review-results').innerText(),/stale/i);assert.match(await page.locator('.review-result').innerText(),/passed/);
      assert.equal(await page.getByRole('textbox',{name:'Review gate commands',exact:true}).inputValue(),'npm run my-unsaved-check');
    });
    await shots('review-stale');
    await page.evaluate(()=>window.__evidence.historyFail=false);
    await page.getByRole('button',{name:'Retry results',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.review-results')?.textContent?.includes('Synthetic review history unavailable'));
  }
} catch(error) { if (page) console.error(await page.locator('body').textContent()); failures.push({name:'Probe orchestration',error:String(error.stack??error)}); if(page)await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{}); }
finally {
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Built renderer in isolated Electron; synthetic code/review bridge. No real main, PTY, Git command, or provider calls.',checks,failures,errors},null,2)+'\n');
  await app.close();
}
if(failures.length||errors.length)process.exitCode=1;
