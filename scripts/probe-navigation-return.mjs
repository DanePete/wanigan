#!/usr/bin/env node
/** Fictional renderer bridge only: verifies navigation visibility, never reads user records or launches agents. */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { openRenderer } from './renderer-harness.mjs';
import { TAB_SHORTCUTS } from '../src/shared/routes.ts';

const before = process.argv.includes('--before');
const outAt = process.argv.indexOf('--out');
if (outAt >= 0 && (!process.argv[outAt + 1] || process.argv[outAt + 1].startsWith('--'))) throw new Error('--out requires a directory.');
const out = outAt < 0 ? path.resolve(import.meta.dirname, '../docs/visuals/navigation-return-2026-09-19', before ? 'before' : 'after') : path.resolve(process.argv[outAt + 1]);
mkdirSync(out, { recursive: true });
const errors = [], checks = [];
const instrument = `(() => {
 const base=window.wanigan;
 window.__navWrites=JSON.parse(localStorage.getItem('__navWrites')||'[]');
 window.__navState=localStorage.getItem('__navState')||'closed';
 window.wanigan=new Proxy(base,{get(api,key){if(key==='prefs')return new Proxy(api.prefs,{get(old,method){
  if(method==='all')return async()=>({...await old.all(),navSidebar:window.__navState,motion:'off'});
  if(method==='set')return async(name,value)=>{window.__navWrites.push([name,value]);localStorage.setItem('__navWrites',JSON.stringify(window.__navWrites));if(name==='nav_sidebar'){window.__navState=value;localStorage.setItem('__navState',value);}return {...await old.all(),navSidebar:window.__navState,motion:'off'};};
  return old[method];}});return api[key];}});
})();`;
const { page, close } = await openRenderer({ width: 1440, height: 1000, instrument, onError: message => { if (!/WebGPU/.test(message)) errors.push(message); } });
const capture = async name => {
 for (const theme of ['dark', 'light']) {
  await page.evaluate(theme => { document.documentElement.dataset.theme=theme; document.documentElement.style.colorScheme=theme; }, theme);
  await page.screenshot({ path: path.join(out, `${name}-${theme}.png`), scale: 'css', animations: 'disabled' });
 }
};
const check = message => { checks.push(message); console.log(message); };
const waitPref = async value => { await page.waitForFunction(value => window.__navState===value, value); };
try {
 await page.locator('.app-header').waitFor();
 await page.evaluate(() => document.activeElement?.blur());
 await page.keyboard.press(TAB_SHORTCUTS.sessions.aria.split(' ')[0]);
 await page.locator('.sessions-view').waitFor();
 await page.waitForTimeout(250);
 assert.equal(await page.locator('#wanigan-sidebar').count(), 0);
 const toggle=page.locator('.hdr-toggle');
 assert.equal((await toggle.innerText()).trim(), before ? '' : 'Sidebar');
 assert.match(await toggle.getAttribute('aria-label'), before ? /^Show navigation/ : /^Show sidebar/);
 await capture('hidden-desktop');
 await toggle.click(); await page.locator('#wanigan-sidebar').waitFor(); await waitPref('open'); await capture('open-desktop');
 await page.reload(); await page.locator('#wanigan-sidebar').waitFor();
 assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
 await page.getByRole('button', { name: 'Hide navigation', exact: true }).click(); await waitPref('closed');
 assert.equal(await page.locator('#wanigan-sidebar').count(), 0);
 assert(await toggle.evaluate(button => document.activeElement===button));
 await page.reload(); await page.locator('.app-header').waitFor();
 assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
 check('The persistent header Sidebar button restores desktop navigation; hiding returns focus to it, and open/closed choices survive reload.');

 await page.evaluate(() => document.activeElement?.blur());
 await page.keyboard.press('Alt+Meta+s'); await page.locator('#wanigan-sidebar').waitFor(); await waitPref('open');
 await page.keyboard.press('Alt+Meta+s'); await waitPref('closed');
 assert.equal(await page.locator('#wanigan-sidebar').count(), 0);
 check('The existing Option–Command–S shortcut still shows and hides navigation.');

 await page.setViewportSize({ width: 720, height: 1000 }); await page.waitForTimeout(200);
 assert.equal((await toggle.innerText()).trim(), '');
 assert.match(await toggle.getAttribute('aria-label'), before ? /^Show navigation/ : /^Show sidebar/);
 const returnButton=await toggle.boundingBox();
 assert(returnButton && returnButton.x>=0 && returnButton.x+returnButton.width<=720 && returnButton.y+returnButton.height<=1000, 'the named navigation return button stays in the compact viewport');
 const header=await page.locator('.app-header').evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
 assert(header.scroll<=header.width+1, 'the restore button and header fit the compact viewport');
 await capture('hidden-compact');
 const writesBefore=await page.evaluate(() => window.__navWrites.length);
 await toggle.click(); await page.getByRole('dialog', { name: 'Workspace navigation', exact: true }).waitFor(); await capture('open-compact');
 await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
 assert.equal(await page.locator('#wanigan-sidebar').count(), 0);
 assert.equal(await page.evaluate(() => window.__navWrites.length), writesBefore);
 assert(await toggle.evaluate(button => document.activeElement===button));
 check('Compact navigation remains a temporary drawer with its return button visible, keyboard focus restored, and no desktop preference writes.');
 assert.deepEqual(errors, []);
} finally {
 writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, before, checks, errors }, null, 2)+'\n');
 await close();
}
