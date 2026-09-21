#!/usr/bin/env node
// Verify the terminal keeps usable space while the unsent composer remains open.
// Uses fictional renderer records; no provider requests, PTYs or agent writes.
import { openRenderer } from './renderer-harness.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const phase = process.argv.includes('--before') ? 'before' : 'after';
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && (!process.argv[outAt + 1] || process.argv[outAt + 1].startsWith('--'))) throw new Error('--out requires a directory.');
const out = outAt >= 0 ? path.resolve(process.argv[outAt + 1]) : path.resolve('docs/visuals/dock-ui-audit-2026-09-19/session-space', phase);
mkdirSync(out, { recursive: true });
const errors = [], measurements = [], checks = [];
const { page, close } = await openRenderer({ width: 960, height: 800,
  onError: message => { if (!/WebGPU/.test(message)) errors.push(message); },
  instrument: `(() => {
    localStorage.setItem('wanigan.composer', '1');
    localStorage.setItem('wanigan.code', '0');
    window.__sessionSpaceWrites = [];
    const base = window.wanigan;
    const wrap = (target, changes) => new Proxy(target, { get(t, p) { return p in changes ? changes[p] : t[p]; } });
    window.wanigan = wrap(base, {
      sessions: wrap(base.sessions, {
        list: async () => (await base.sessions.list()).map(session => ({...session, projectPath: session.projectId === 'p1' ? '/example/storefront' : '/example/platform', harnessId: session.providerId === 'claude' ? 'claude-code' : 'codex', capabilities: { hooks: false } })),
        buffer: async () => '', scrollback: async () => 'Fictional terminal fixture. No agent process.\\r\\n',
        write: async (...args) => window.__sessionSpaceWrites.push(args),
      }),
      worktrees: wrap(base.worktrees, { setup: async projectId => ({projectId,depsMode:'skip',setup:[],teardown:[],updatedAt:null,include:{state:'absent'}}) }),
      prefs: wrap(base.prefs, { all: async () => ({...(await base.prefs.all()), motion:'off', navSidebar:'closed'}) }),
    });
  })();` });
const measure = async label => {
  const result = await page.evaluate(() => {
    const box = selector => {
      const element = [...document.querySelectorAll(selector)].find(element => element.getBoundingClientRect().width > 0);
      const r = element?.getBoundingClientRect();
      return r ? { x: r.x, y: r.y, width: r.width, height: r.height, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight } : null;
    };
    return {
      width: innerWidth, height: innerHeight,
      docOverflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth,
      pane: box('.sessions-view'), attention: box('.atq'), toolbar: box('.session-toolbar'), config: box('.session-config'),
      terminal: box('.terminal-host:not([hidden])'), dock: box('.session-dock'), dockBody: box('.session-dock-body'),
      area: box('.composer-area'), actions: box('.composer-actions'), foot: box('.space-foot'),
      dockButton: box('.space-dock button'), status: box('.statusbar'),
    };
  });
  measurements.push({ label, ...result });
  return result;
};
const capture = async name => {
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, theme);
    await page.screenshot({ path: `${out}/${name}-${theme}.png`, scale: 'css', animations: 'disabled' });
  }
};
try {
  await page.locator('.app-header').waitFor();
  await page.evaluate(()=>document.activeElement?.blur());
  await page.keyboard.press('Meta+1');
  await page.locator('.session-item').filter({hasText:'pid 4088'}).click();
  await page.getByRole('textbox',{name:'Message the agent',exact:true}).waitFor();
  for(const [width,height] of [[1440,960],[960,800],[900,560]]) {
    await page.setViewportSize({width,height});
    await page.waitForFunction(width=>innerWidth===width,width);
    await page.waitForTimeout(100);
    const geometry=await measure(`empty-${width}x${height}`);
    await capture(`sessions-${width}x${height}`);
    if (phase === 'after') {
      assert.equal(geometry.docOverflow, false);
      assert.ok(geometry.terminal.height >= 90, JSON.stringify(geometry));
      assert.ok(geometry.foot.height <= (height <= 650 ? 56 : 64), JSON.stringify(geometry));
      assert.ok(geometry.actions.y + geometry.actions.height <= geometry.dockBody.y + geometry.dockBody.height + 1, JSON.stringify(geometry));
    }
  }
  if(phase==='after') {
    const area=page.getByRole('textbox',{name:'Message the agent',exact:true});
    await page.setViewportSize({width:960,height:800});
    await area.fill('An unsent draft to resize.');
    const initialArea=await area.boundingBox();
    await page.mouse.move(initialArea.x+initialArea.width-3,initialArea.y+initialArea.height-3);
    await page.mouse.down();
    await page.mouse.move(initialArea.x+initialArea.width-3,initialArea.y+initialArea.height+55);
    await page.mouse.up();
    const resizedArea=await area.boundingBox();
    assert.ok(resizedArea.height>initialArea.height+20,JSON.stringify({initialArea,resizedArea}));
    const draft=Array.from({length:25},(_,index)=>`Draft line ${index+1}: preserve this unsent review context.`).join('\n');
    await area.fill(draft);
    const terminal=await page.locator('.terminal-host:visible .xterm').elementHandle();
    await page.setViewportSize({width:900,height:560});
    const geometry=await measure('long-draft-resized-900x560');
    assert.ok(geometry.terminal.height>=90,JSON.stringify(geometry));
    assert.ok(geometry.actions.y + geometry.actions.height <= geometry.dockBody.y + geometry.dockBody.height + 1,JSON.stringify(geometry));
    assert.equal(await area.inputValue(),draft);
    assert.equal(await page.locator('.session-dock-toggle').getAttribute('aria-expanded'),'true');
    assert.ok(geometry.area.y + geometry.area.height <= geometry.actions.y + 1, JSON.stringify(geometry));
    // Real cursor navigation must expose the final line inside the textarea,
    // rather than scrolling the surrounding app or hiding it beneath Send.
    await area.press('ArrowLeft');
    await area.press('ArrowRight');
    assert.equal(await area.evaluate(element => element.scrollTop + element.clientHeight >= element.scrollHeight - 1), true);
    await capture('long-draft-900x560');
    await page.setViewportSize({ width: 960, height: 800 });
    assert.ok((await area.boundingBox()).height > initialArea.height + 20, 'Roomy-window native resize returns after leaving the short layout');
    await page.setViewportSize({ width: 900, height: 560 });
    await page.locator('.session-side-panel-toggle').click();
    await page.getByRole('button',{name:'Back to terminal',exact:true}).click();
    assert.equal(await area.inputValue(),draft);
    assert.equal(await terminal.evaluate(element=>element.isConnected),true);
    await page.locator('.session-dock-toggle').click();
    await page.locator('.session-dock-toggle').click();
    assert.equal(await area.inputValue(),draft);
    await page.setViewportSize({width:960,height:800});
    await page.locator('.session-dock-body').evaluate(element=>{element.scrollTop=element.scrollHeight;});
    await page.getByRole('button',{name:'Saved prompts',exact:true}).click();
    await page.getByRole('searchbox',{name:'Search saved prompts',exact:true}).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await area.inputValue(),draft);
    assert.equal(await page.evaluate(()=>scrollY),0);
    assert.deepEqual(await page.evaluate(()=>window.__sessionSpaceWrites),[]);
    checks.push('Long draft survives resize, details/terminal switch, manual composer close/reopen, and Saved prompts; pooled terminal stays mounted; no agent writes.');
    assert.equal(await page.locator('.session-toolbar .tab-new-session').count(),0);
    assert.equal(await page.locator('.session-toolbar .session-resume-button').count(),0);
    assert.equal(await page.locator('.nav-new-session').count(),1);
    assert.equal(await page.locator('.nav-resume-session').count(),1);
    checks.push('New/Resume occur once in adminbar; per-project actions and Review/Details remain.');
  }
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({phase,measurements,checks,errors},null,2));
} finally {
  writeFileSync(`${out}/verification.json`, JSON.stringify({ phase, fixture: true, measurements, checks, errors }, null, 2));
  await close();
}
