#!/usr/bin/env node
/** Real Electron/WebGPU verification. No Wanigan main process, sessions, model
 * calls or user profile. Run after npm run build. Requires a supported GPU.
 * Fixtures/screenshots are explicit test artifacts, not observed agent work. */
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readdirSync,copyFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const ts=require('typescript');
const expressionCode=ts.transpileModule(readFileSync(path.join(root,'src/renderer/src/orb/expression.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const output=path.resolve(root,process.argv[2]??'docs/visuals/orb-personality/physics');mkdirSync(output,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-fluid-proof-'));
const assets=path.join(root,'out/renderer/assets');
const chunk=readdirSync(assets).find(n=>n.startsWith('runtime-')&&n.endsWith('.js'));
assert(chunk,'Build the renderer first');
copyFileSync(path.join(assets,chunk),path.join(dir,'runtime.js'));
for(const name of readdirSync(assets).filter(n=>n.endsWith('.hdr')||n.startsWith('mission-studio-')))copyFileSync(path.join(assets,name),path.join(dir,name));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:850,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(dir,'index.html'))});});`);
writeFileSync(path.join(dir,'index.html'),'<html><head><style>body{margin:0;background:#192128;display:grid;place-items:center;height:100vh}canvas{width:560px;height:560px}</style></head><body><canvas></canvas></body></html>');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const k of Object.keys(env))if(k.startsWith('VSCODE_'))delete env[k];
const binary=process.platform==='darwin'?'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron':'node_modules/electron/dist/electron';
const app=await _electron.launch({executablePath:path.join(root,binary),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
try{
 const page=await app.firstWindow();
 await page.evaluate(async()=>{
  const {OrbRuntime}=await import('./runtime.js');window.OrbRuntime=OrbRuntime;window.orb=await OrbRuntime.create(document.querySelector('canvas'));window.errors=[];
  window.orb.device.addEventListener('uncapturederror',e=>window.errors.push(e.error.message));
 });
 await page.evaluate(async code=>{window.OrbExpression=(await import('data:text/javascript;base64,'+btoa(code))).OrbExpression;},expressionCode);
 const comparison=await page.evaluate(async()=>{
  const base={focused:false,thinking:false,answerEvent:0,attentionEvent:0,temperament:'water'};
  const runs=[];
  for(const expressive of [false,true]){
   if(expressive){window.orb.destroy();window.orb=await window.OrbRuntime.create(document.querySelector('canvas'));window.orb.device.addEventListener('uncapturederror',e=>window.errors.push(e.error.message));}
   const expression=new window.OrbExpression(base),trace=[];let maxRadius=0,invalid=0;
   for(let i=0;i<180;i++){
    if(i===90)expression.nudge();
    const pose=expression.step(1/30);
    await window.orb.render({...pose,dt:1/30,time:i/30,light:false,thinking:false,
     accelX:expressive?pose.accelX:0,accelY:expressive?pose.accelY:0});
    if(i>=90&&i%10===0){
     const p=await window.orb.inspectParticles();let x=0;
     for(let j=0;j<p.length;j+=4){const xyz=[p[j]-1.2,p[j+1]-1.2,p[j+2]-1.2];x+=xyz[0];if(!xyz.every(Number.isFinite))invalid++;maxRadius=Math.max(maxRadius,Math.hypot(...xyz));}
     trace.push(x/window.orb.liquid.n);
    }
   }
   runs.push({expressive,trace,maxRadius,invalid,particles:window.orb.liquid.n});
  }
  return {runs,maxMeanDisplacement:Math.max(...runs[0].trace.map((x,i)=>Math.abs(x-runs[1].trace[i]))),errors:window.errors};
 });
 assert.deepEqual(comparison.errors,[]);assert(comparison.maxMeanDisplacement>.001,'vessel gestures displace actual water compared with the same gesture rendered without its force');
 for(const run of comparison.runs){assert.equal(run.invalid,0);assert(run.maxRadius<=.973);assert(run.particles>1000);}
 console.log('Gesture force comparison:',JSON.stringify(comparison));
 const recording=await page.evaluate(async()=>{
  const canvas=document.querySelector('canvas'),stream=canvas.captureStream(30),chunks=[];
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4_000_000});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(resolve=>recorder.onstop=resolve);
  const base={focused:false,thinking:false,answerEvent:0,attentionEvent:0,completionEvent:0,temperament:'water',composer:{x:.65,y:-.15},overview:{x:-.8,y:.2}};
  const expression=new window.OrbExpression(base);recorder.start();
  for(let i=0;i<390;i++){
   const at=performance.now();
   if(i===30)expression.nudge();
   if(i===100)expression.setContext({...base,focused:true});
   if(i===160)expression.setContext({...base,attentionEvent:1});
   if(i===240)expression.setContext({...base,attentionEvent:1,completionEvent:1});
   if(i===310)expression.spin();
   await window.orb.render({...expression.step(1/30),dt:1/30,time:6+i/30,light:false,thinking:false});
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000/30-(performance.now()-at))));
  }
  recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
  const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
 });
 writeFileSync(path.join(output,'wanigan-personality.webm'),Buffer.from(recording,'base64'));
 const final=await page.evaluate(async()=>{
  const p=await window.orb.inspectParticles();let maxRadius=0,invalid=0;
  for(let i=0;i<p.length;i+=4){const xyz=[p[i]-1.2,p[i+1]-1.2,p[i+2]-1.2];if(!xyz.every(Number.isFinite))invalid++;maxRadius=Math.max(maxRadius,Math.hypot(...xyz));}
  return {maxRadius,invalid,errors:window.errors};
 });
 assert.equal(final.invalid,0);assert(final.maxRadius<=.973);assert.deepEqual(final.errors,[]);
 const report={...comparison,final,recordedAt:new Date().toISOString(),runtimeSha256:createHash('sha256').update(readFileSync(path.join(assets,chunk))).digest('hex'),scope:'Isolated Electron/WebGPU. Controlled synthetic gestures, no agent or model calls.'};
 writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log('Personality GPU checks passed; live clip recorded.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
