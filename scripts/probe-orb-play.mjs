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
const thermalModule=await import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(readFileSync(path.join(root,'src/renderer/src/orb/thermal.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64'));
const expressionCode=ts.transpileModule(readFileSync(path.join(root,'src/renderer/src/orb/expression.ts'),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const output=path.resolve(root,process.argv[2]??'docs/visuals/orb-play/physics');mkdirSync(output,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-fluid-proof-'));
const assets=path.join(root,'out/renderer/assets');
const chunk=readdirSync(assets).find(n=>n.startsWith('runtime-')&&n.endsWith('.js'));
assert(chunk,'Build the renderer first');
copyFileSync(path.join(assets,chunk),path.join(dir,'runtime.js'));
for(const name of readdirSync(assets).filter(n=>n.endsWith('.js')||n.endsWith('.hdr')||n.startsWith('mission-studio-')))copyFileSync(path.join(assets,name),path.join(dir,name));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({width:850,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});w.loadFile(${JSON.stringify(path.join(dir,'index.html'))});});`);
writeFileSync(path.join(dir,'index.html'),'<html><head><style>body{margin:0;background:#192128;display:grid;place-items:center;height:100vh}canvas{width:560px;height:560px}</style></head><body><canvas></canvas></body></html>');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;for(const k of Object.keys(env))if(k.startsWith('VSCODE_'))delete env[k];
const binary=process.platform==='darwin'?'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron':'node_modules/electron/dist/electron';
const app=await _electron.launch({executablePath:path.join(root,binary),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
try{
 const page=await app.firstWindow();
 await page.evaluate(async()=>{
  const {OrbRuntime}=await import('./runtime.js');window.orb=await OrbRuntime.create(document.querySelector('canvas'));window.errors=[];
  window.orb.device.addEventListener('uncapturederror',e=>window.errors.push(e.error.message));
 });
 await page.evaluate(async code=>{window.OrbExpression=(await import('data:text/javascript;base64,'+btoa(code))).OrbExpression;},expressionCode);

 const frames=async (count,extra={})=>page.evaluate(async ({count,extra})=>{
  window.t??=0;
  for(let i=0;i<count;i++){
   window.t+=1/30;
   const at=performance.now();await window.orb.render({dt:1/30,time:window.t,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,...extra});(window.timings??=[]).push(performance.now()-at);
  }
 },{count,extra});
 const record=async(name,count,extra={})=>{
  const result=await page.evaluate(async({count,extra})=>{
   const canvas=document.querySelector('canvas'),stream=canvas.captureStream(30),chunks=[];
   const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4_000_000});
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
   try{for(let i=0;i<count;i++){
    const at=performance.now();window.t+=1/30;
    await window.orb.render({dt:1/30,time:window.t,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,...extra});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000/30-(performance.now()-at))));
   }}finally{recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());}
   const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';
   for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
  },{count,extra});
  writeFileSync(path.join(output,name+'.webm'),Buffer.from(result,'base64'));
 };
 await frames(120,{bubbleInterest:1});
 const baseline=await page.evaluate(()=>window.orb.inspectPlay());
 console.log('Baseline',JSON.stringify({gaze:baseline.gaze,wake:baseline.wakeTotal}));
 assert(baseline.gaze[2]>.9,'idle eyes acquire a visible simulated bubble');
 const watched=baseline.bubbles.slice(Math.round(baseline.gaze[3])*4,Math.round(baseline.gaze[3])*4+4);
 assert(watched[3]>0&&watched[2]>-.1,'the fixation is on a live, front-facing bubble');
 assert(Math.abs(baseline.gaze[0]-Math.max(-.85,Math.min(.85,watched[0]*1.5)))<.12,'eye target tracks the actual particle position');
 await frames(8,{bubbleInterest:0});assert((await page.evaluate(()=>window.orb.inspectPlay())).gaze[2]<.01,'explicit attention releases the bubble');
 await page.screenshot({path:path.join(output,'water-dark.png')});
 await page.evaluate(()=>window.orb.play('splash'));await frames(20);
 const stirred=await page.evaluate(()=>window.orb.inspectPlay());
 console.log('Wake after splash',stirred.wakeTotal,stirred.wakeMax);
 await page.screenshot({path:path.join(output,'wake-dark.png')});
 await frames(200);const settled=await page.evaluate(()=>window.orb.inspectPlay());
 assert(stirred.wakeTotal>baseline.wakeTotal+10,'stirring emits light');
 assert(settled.wakeTotal<stirred.wakeTotal*.12,'wake dissipates after the impulse ends');
 await page.evaluate(()=>window.orb.play('burst'));await frames(1);
 const burst=await page.evaluate(()=>window.orb.inspectPlay());
 assert(burst.bubbles.filter((v,i)=>i%4===3&&v>0).length===64,'one burst activates the extra bubble population');
 await frames(30);await page.screenshot({path:path.join(output,'burst-dark.png')});
 await frames(150);
 const surfaceSpeed=()=>page.evaluate(async()=>{
  const p=await window.orb.inspectParticles(),v=await window.orb.inspectParticles('velocity');let energy=0,count=0;
  const heights=[];for(let i=0;i<p.length;i+=4)heights.push(p[i+1]);heights.sort((a,b)=>a-b);const cutoff=heights[Math.floor(heights.length*.8)];
  for(let i=0;i<p.length;i+=4)if(p[i+1]>=cutoff){energy+=v[i+1]*v[i+1];count++;}
  return Math.sqrt(energy/Math.max(1,count));
 });
 const quietSpeed=await surfaceSpeed();
 await page.evaluate(()=>window.orb.play('rain'));await frames(130);
 const rain=await page.evaluate(()=>window.orb.inspectPlay());
 const rainySpeed=await surfaceSpeed();
 const splashCount=rain.drops.slice(48*4,144*4).filter((v,i)=>i%4===3&&v>0).length;
 console.log('Rain',{rainySpeed,quietSpeed,splashCount,ripples:rain.ripples});
 assert(splashCount>0,'rain impacts eject secondary droplets');
 assert(rain.impacts.some((v,i)=>i%4===3&&v>0),'rain transfers impact momentum');
 // Compare the exact force pass from identical velocities, with and without
 // droplet coupling. This separates impacts from the solver's resting jitter.
 const transfer=await page.evaluate(async()=>{
  const orb=window.orb,source=orb.liquid.buf['vel'+(orb.liquid.parity===0?'A':'B')];
  const original=await orb.inspectParticles('velocity');
  orb.shell.step(1/30,0,0,0,0,0,0);const control=await orb.inspectParticles('velocity');
  orb.device.queue.writeBuffer(source,0,original);
  orb.shell.step(1/30,0,0,0,0,0,1);const impact=await orb.inspectParticles('velocity');
  orb.device.queue.writeBuffer(source,0,original);
  let changed=0,downward=0,maxDelta=0;
  for(let i=0;i<control.length;i+=4){const dy=impact[i+1]-control[i+1];if(Math.abs(dy)>.001)changed++;downward+=dy;maxDelta=Math.max(maxDelta,Math.abs(dy));}
  return {changed,downward,maxDelta};
 });
 console.log('Controlled rain transfer',transfer);
 assert(transfer.changed>100&&transfer.downward<-.1&&transfer.maxDelta>.01,'impact pass transfers directed momentum into real water');
 assert(rain.ripples.min<-.002&&rain.ripples.max>.002,'impacts form craters and raised wavefronts');
 assert.equal(rain.ripples.invalid,0);
 assert(rain.drops.some((v,i)=>i%4===3&&v>0),'rain produces physical droplets');
 assert(rain.drops.some((v,i)=>i%4===3&&v<0),'humidity produces shell droplets');
 await page.screenshot({path:path.join(output,'rain-dark.png')});
 await page.evaluate(async()=>{document.body.style.background='#f4f6f8';await window.orb.render({dt:0,time:window.t,light:true,gazeX:0,gazeY:0,blink:1,thinking:false});});
 await page.screenshot({path:path.join(output,'rain-light.png')});
 await record('rain-and-ripples',240);
 await frames(480);const clear=await page.evaluate(()=>window.orb.inspectPlay());
 assert(clear.drops.every((v,i)=>i%4!==3||v===0),'the shower and condensation clear completely');
 assert(clear.ripples.energy<rain.ripples.energy*.03,'surface waves settle after the rain stops');
 await page.evaluate(()=>{document.body.style.background='#192128';});
 await frames(300,{lava:1});
 const wax=await page.evaluate(()=>window.orb.inspectPlay());
 console.log('Wax',JSON.stringify(wax.wax.slice(0,32)));
 assert(wax.wax.every(Number.isFinite));
 let moved=0,hot=0,cold=1,maxR=0;
 for(let i=0;i<wax.wax.length;i+=8){moved+=Math.abs(wax.wax[i+1]-baseline.wax[i+1]);hot=Math.max(hot,wax.wax[i+3]);cold=Math.min(cold,wax.wax[i+3]);maxR=Math.max(maxR,Math.hypot(...wax.wax.slice(i,i+3)));}
 console.log('Wax range',{moved,hot,cold,maxR});
 await page.screenshot({path:path.join(output,'lava-dark.png')});
 assert(moved>1,'wax moves under heating and buoyancy');assert(hot-cold>.04,'wax retains a spatial temperature range');assert(maxR<=.801);
 await page.screenshot({path:path.join(output,'lava-dark.png')});
 await page.evaluate(async()=>{document.body.style.background='#f4f6f8';await window.orb.render({dt:0,time:window.t,light:true,gazeX:0,gazeY:0,blink:1,thinking:false,lava:1});});
 await page.screenshot({path:path.join(output,'lava-light.png')});
 await record('lava-lamp',300,{lava:1});
 const frozen=await page.evaluate(()=>window.orb.inspectPlay());await frames(5,{dt:0,lava:1});
 assert.deepEqual(await page.evaluate(()=>window.orb.inspectPlay()),frozen,'motion off freezes every new field');
 const angular=()=>page.evaluate(async()=>{
  const p=await window.orb.inspectParticles(),v=await window.orb.inspectParticles('velocity');let sum=0;
  for(let i=0;i<p.length;i+=4)sum+=(p[i+2]-1.2)*v[i]-(p[i]-1.2)*v[i+2];return sum/window.orb.liquid.n;
 });
 const beforeVortex=await angular();await frames(120,{vortex:.65});const afterVortex=await angular();
 assert(afterVortex>beforeVortex+.02,'thinking transfers angular momentum into real water');
 const positions=await page.evaluate(()=>window.orb.inspectParticles().then(p=>[...p]));let maxWaterRadius=0;
 for(let i=0;i<positions.length;i+=4){assert(positions.slice(i,i+4).every(Number.isFinite));maxWaterRadius=Math.max(maxWaterRadius,Math.hypot(positions[i]-1.2,positions[i+1]-1.2,positions[i+2]-1.2));}
 assert(maxWaterRadius<=.973,'water remains contained under play forces');
 assert.deepEqual(await page.evaluate(()=>window.errors),[]);
 writeFileSync(path.join(output,'verification.json'),JSON.stringify({recordedAt:new Date().toISOString(),rendererSha256:createHash('sha256').update(readFileSync(path.join(assets,chunk))).digest('hex'),wake:{before:baseline.wakeTotal,stirred:stirred.wakeTotal,settled:settled.wakeTotal},wax:{moved,hot,cold,maxR},rain:{quietSpeed,rainySpeed,transfer,splashCount,ripples:rain.ripples,settled:clear.ripples},vortex:{beforeVortex,afterVortex,maxWaterRadius},performance:await page.evaluate(()=>{const t=window.timings.sort((a,b)=>a-b);return {medianMs:t[Math.floor(t.length*.5)],p95Ms:t[Math.floor(t.length*.95)]};}),errors:await page.evaluate(()=>window.errors),scope:'Isolated Electron real GPU; explicit test inputs, no agents or models'},null,2)+'\n');
 console.log('Orb play checks passed');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
