#!/usr/bin/env node
// Real Electron renderer with isolated, deterministic operational fixtures.
// No live PTY, repository mutation, provider request, or installed-app access.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url);
const { _electron } = require('playwright-core');
const root = path.resolve(import.meta.dirname, '..');
const before = process.argv.includes('--before');
const out = path.join(root, 'docs/visuals/desktop-workspaces', before ? 'before' : 'after');
mkdirSync(out, { recursive: true });
const dir = mkdtempSync(path.join(tmpdir(), 'wanigan-workspaces-'));
writeFileSync(path.join(dir, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadURL('about:blank');});`);
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
for (const key of Object.keys(env)) if (key.startsWith('VSCODE_')) delete env[key];
const app = await _electron.launch({ executablePath: path.join(root, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'), args: [path.join(dir, 'main.cjs'), `--user-data-dir=${dir}/profile`], env });
const errors = [], checks = [], dimensions = {};
try {
  const page = await app.firstWindow();
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(STUB);
  await page.addInitScript(() => {
    localStorage.setItem('wanigan.code', '0');
    const original = window.wanigan;
    window.__workspaceCalls = [];
    window.__workspaceGitFailure = false;
    const file = { path:'src/Checkout.tsx', index:' ', work:'M', staged:false, untracked:false, conflicted:false };
    const patch = 'diff --git a/src/Checkout.tsx b/src/Checkout.tsx\n--- a/src/Checkout.tsx\n+++ b/src/Checkout.tsx\n@@ -12,5 +12,7 @@\n export function Checkout() {\n-  return <button>Pay</button>;\n+  return (\n+    <button aria-label="Complete checkout">Pay now</button>\n+  );\n }';
    const commit = { hash:'abc123456789', short:'abc1234', parents:[], author:'Example Author', at:Date.now()-240000, subject:'Improve checkout labels', body:'', refs:['HEAD -> feature/checkout'], head:true, lane:0, color:0 };
    const overrides = {
      git: {
        status: async root => { if(window.__workspaceGitFailure) throw new Error('Fixture repository unavailable'); return {isRepo:true,root,repoRoot:root,subpath:null,branch:'feature/checkout',detached:false,upstream:'origin/feature/checkout',ahead:1,behind:0,staged:[],unstaged:[file],untracked:[],conflicted:[],clean:false,operation:null}; },
        log: async()=>[commit], branches:async()=>[{name:'feature/checkout',current:true,remote:false,upstream:null,ahead:0,behind:0,at:Date.now(),subject:commit.subject}], stashes:async()=>[],
        fileDiff:async()=>patch, commitDiff:async()=>({patch,truncated:false}),
        push:async(...args)=>{window.__workspaceCalls.push(['push',...args]);return 'Fixture only';},
      },
      sessions: {
        list:async()=> (await original.sessions.list()).map(s=>({...s, projectPath:'/example/'+s.projectName, displayTitle:s.id==='s2'?'Workspace redesign':s.label, label:s.id==='s2'?'Workspace redesign':s.label, worktree:s.id==='s2'?'/example/platform-worktree':s.worktree, harnessId:s.providerId==='codex'?'codex':'claude-code',trust:s.id==='s2'?'trusted':'project'})),
        write:async(...args)=>{window.__workspaceCalls.push(['write',...args]);},
      },
      review:{recipe:async()=>({commands:['npm test']}),history:async()=>[]},
      worktrees:{list:async()=>[],status:async()=>({branch:'feature/workspace',base:'main',dirty:2,ahead:1,behind:0,exists:true,path:'/example/platform-worktree'})},
      attachments:{list:async()=>[],sent:async()=>0},
    };
    window.wanigan = new Proxy(original, {get(target,key){ if(!(key in overrides)) return target[key]; return new Proxy(target[key],{get(service,method){return overrides[key][method] ?? service[method];}}); }});
  });
  await page.goto(rendererURL);
  await page.waitForSelector('.mission-room');
  await page.evaluate(()=>document.documentElement.dataset.motion='off');
  const go = async key => { await page.locator('.space-dock button').first().focus(); await page.keyboard.press(key); };
  for (const theme of ['dark','light']) {
    await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
    await go('Meta+1'); await page.waitForSelector('.sessions-view');
    await page.locator('.session-item').filter({hasText:'Workspace redesign'}).click();
    await page.waitForSelector('.terminal-host:visible');
    await page.waitForTimeout(300);
    dimensions[theme] = await page.locator('.terminal-host').filter({visible:true}).first().boundingBox();
    await page.screenshot({path:path.join(out,`sessions-${theme}.png`),scale:'css'});
    await go('Meta+9'); await page.waitForSelector('.gt-file');
    await page.locator('.gt-file').filter({hasText:'src/Checkout.tsx'}).first().click();
    await page.waitForSelector('.gt-diff');
    await page.screenshot({path:path.join(out,`changes-${theme}.png`),scale:'css'});
  }
  if (!before) {
    await page.getByRole('textbox',{name:'Commit message',exact:true}).fill('Keep this draft while reviewing');
    await page.getByRole('group',{name:'Repository views'}).getByRole('button',{name:'History',exact:true}).click();
    await page.locator('.gt-row').first().click();
    assert.match(await page.locator('.gt-reader').innerText(),/Improve checkout labels/);
    const graph = await page.locator('.gt-row').first().evaluate(row=>({row:row.getBoundingClientRect().height,graph:row.querySelector('svg').getBoundingClientRect().height}));
    assert(Math.abs(graph.row-graph.graph)<2,'history graph must span its full row so parent edges connect');
    await page.getByRole('group',{name:'Repository views'}).getByRole('button',{name:/^Changes/}).click();
    assert.equal(await page.getByRole('textbox',{name:'Commit message',exact:true}).inputValue(),'Keep this draft while reviewing');
    checks.push('history and file selection use the full reader; commit draft survives pane changes');
    await go('Meta+1');
    const hosts = await page.locator('.terminal-host').count();
    await page.evaluate(()=>{ window.__terminalNodes=[...document.querySelectorAll('.terminal-host')]; });
    assert(await page.getByRole('status').filter({hasText:'above your default'}).isVisible());
    const controls = page.locator('.session-controls');
    await controls.locator('summary').click();
    await page.getByRole('button',{name:'Plan next task',exact:true}).click();
    assert.deepEqual(await page.evaluate(()=>window.__workspaceCalls.filter(c=>c[0]==='write')),[['write','s2','/plan\r']]);
    await controls.locator('summary').click();
    assert.equal(await page.locator('.terminal-host').count(),hosts);
    assert(await page.evaluate(()=>window.__terminalNodes.every(n=>n.isConnected)));
    checks.push('session controls preserve terminal nodes and send only the chosen command to the selected session');
    await page.locator('.session-item').filter({hasText:'exited 0'}).click();
    assert(await page.getByRole('button',{name:'Close exited session for platform',exact:true}).isVisible());
    assert(await page.evaluate(()=>window.__terminalNodes.every(n=>n.isConnected)));
    checks.push('switching sessions preserves all terminal hosts');
    await go('Meta+9');
    assert.equal(await page.getByRole('textbox',{name:'Commit message',exact:true}).inputValue(),'Keep this draft while reviewing');
    const gate=page.locator('.gt-review-controls');
    await gate.locator('summary').click();
    await page.getByRole('textbox',{name:'Review gate commands',exact:true}).fill('npm test\ngit diff --check');
    await gate.locator('summary').click(); await gate.locator('summary').click();
    assert.equal(await page.getByRole('textbox',{name:'Review gate commands',exact:true}).inputValue(),'npm test\ngit diff --check');
    await gate.locator('summary').click();
    await page.getByRole('button',{name:'Push 1',exact:true}).click();
    assert.equal((await page.evaluate(()=>window.__workspaceCalls.filter(c=>c[0]==='push'))).length,0);
    assert(await page.getByRole('button',{name:'Push to origin/feature/checkout',exact:true}).isVisible());
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    checks.push('gate drafts persist across disclosure; push still requires explicit confirmation');
    await page.evaluate(()=>window.__workspaceGitFailure=true);
    const repositoryPicker = page.getByRole('combobox',{name:'Repository',exact:true});
    await repositoryPicker.selectOption((await repositoryPicker.inputValue()) === 'p2' ? 'p1' : 'p2');
    await page.getByText('Fixture repository unavailable',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:'Push 1',exact:true}).count(),0);
    assert.equal(await page.getByRole('textbox',{name:'Commit message',exact:true}).count(),0);
    checks.push('failed project switch cannot act on the previous repository');
    await page.evaluate(()=>window.__workspaceGitFailure=false);
    await repositoryPicker.selectOption((await repositoryPicker.inputValue()) === 'p2' ? 'p1' : 'p2');
    await page.locator('.gt-file').first().waitFor();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,960));
    await page.waitForFunction(()=>window.innerWidth===820);
    await page.locator('.gt-file').filter({hasText:'src/Checkout.tsx'}).first().click();
    assert(await page.locator('.gt-reader').isVisible());
    await page.screenshot({path:path.join(out,'changes-narrow.png'),scale:'css'});
    await go('Meta+1');
    await page.locator('.sessions--compact-picker').waitFor();
    await page.locator('.session-picker-trigger').click();
    assert.equal(await page.locator('#wanigan-session-picker').getAttribute('aria-hidden'),null);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#wanigan-session-picker').getAttribute('aria-hidden'),'true');
    const horizontal = await page.locator('.sessions-view').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
    assert(horizontal.scroll<=horizontal.width+1,'narrow Sessions must not overflow');
    await page.screenshot({path:path.join(out,'sessions-narrow.png'),scale:'css'});
    checks.push('narrow desktop keeps the reader visible and the keyboard session switcher closes correctly');
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({kind:'Electron renderer; synthetic fixtures; no real agent or repository operations',at:new Date().toISOString(),dimensions,checks,errors},null,2)+'\n');
  console.log(JSON.stringify({before,dimensions,checks,errors},null,2));
} finally { await app.close(); rmSync(dir,{recursive:true,force:true}); }
