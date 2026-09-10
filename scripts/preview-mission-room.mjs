#!/usr/bin/env node
/** Open a review window against a separate temporary profile. Never replaces or
 * quits the installed app. No session or model call is started by this script. */
import {createRequire} from 'node:module';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {launchWanigan} from './electron-harness.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const userData=mkdtempSync(path.join(tmpdir(),'wanigan-design-preview-'));
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const {app,page}=await launchWanigan(_electron,{root,userData,env});
try{
 await page.waitForSelector('.mission-room');
 await page.evaluate(async root=>{
  await window.wanigan.projects.add(root);
  await window.wanigan.prefs.setTheme('dark');
  await window.wanigan.prefs.set('motion','full');
 },root);
 await page.reload();await page.waitForSelector('.mission-room');
 await page.waitForFunction(()=>document.querySelector('.wanigan-orb')?.dataset.physics==='ready');
 await page.getByRole('button',{name:'Wanigan appearance and play',exact:true}).click();
 await page.getByRole('button',{name:'Ember & flame',exact:true}).click();
 await page.keyboard.press('Escape');
 await app.evaluate(({BrowserWindow})=>{
  const window=BrowserWindow.getAllWindows()[0];
  const title='Wanigan — Design preview (separate profile)';
  window.webContents.on('page-title-updated',event=>{event.preventDefault();window.setTitle(title);});
  window.setTitle(title);window.show();window.focus();
 });
 console.log('Preview ready. Try the composer, globe double-click, or appearance control below Wanigan.');
 console.log('Separate preview profile:',userData);
 await new Promise(resolve=>app.once('close',resolve));
}catch(error){await app.close();throw error;}
// Preserve this profile if the operator deliberately creates work in the preview.
