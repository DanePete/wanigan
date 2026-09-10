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
const output=path.resolve(root,process.argv[2]??'docs/visuals/mission-room/physics');mkdirSync(output,{recursive:true});
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
  const {OrbRuntime}=await import('./runtime.js');window.orb=await OrbRuntime.create(document.querySelector('canvas'));window.errors=[];
  window.orb.device.addEventListener('uncapturederror',e=>window.errors.push(e.error.message));
 });
 await page.evaluate(async code=>{window.OrbExpression=(await import('data:text/javascript;base64,'+btoa(code))).OrbExpression;},expressionCode);
 // Exercise the exact production WGSL reaction with controlled inputs on GPU.
 const reaction=await page.evaluate(async code=>{
  const device=window.orb.device;
  const pipeline=device.createComputePipeline({layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:code+`
   @group(0) @binding(0) var<storage,read_write> result:array<vec4f>;
   @compute @workgroup_size(1) fn main(@builtin(global_invocation_id) id:vec3u){
    if(id.x==0u){result[0]=react(vec4f(1.,0.,0.,0.),1./30.);return;}
    var q=vec4f(1.,.5,0.,0.);let steps=select(60u,120u,id.x==2u);
    for(var i=0u;i<steps;i++){q=react(q,1./f32(steps));}result[id.x]=q;
   }`})}});
  const storage=device.createBuffer({size:48,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
  const read=device.createBuffer({size:48,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
  try{
   const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:storage}}]});
   const encoder=device.createCommandEncoder();const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(3);pass.end();
   encoder.copyBufferToBuffer(storage,0,read,0,48);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);return [...new Float32Array(read.getMappedRange())];
  }finally{storage.destroy();read.destroy();}
 },thermalModule.REACTION_WGSL);
 assert.equal(reaction[1],0,'cold fuel cannot generate heat');assert.equal(reaction[3],0,'cold fuel cannot burn');
 assert(reaction[4]>=0&&reaction[4]<.01,'hot fuel is consumed without becoming negative');
 assert(reaction[5]>.5,'hot burning releases heat');
 assert(Math.abs(reaction[5]-reaction[9])/reaction[9]<.025,'reaction agrees within 2.5% at 60 and 120 steps');
 assert.deepEqual((await page.evaluate(()=>window.orb.inspectThermal())).total,[0,0,0,0]);
 const result=await page.evaluate(async()=>{
  const orb=window.orb,durations=[];const base={light:false,gazeX:.1,gazeY:.15,blink:1,thinking:false};
  let beforeMean=0,afterMean=0,maxDensity=0,impulsedParticles=0,angularBefore=0,angularAfter=0;
  const meanX=async()=>{const p=await orb.inspectParticles();let x=0;for(let i=0;i<p.length;i+=4)x+=p[i];return x/orb.liquid.n;};
  const angular=async()=>{const p=await orb.inspectParticles(),v=await orb.inspectParticles('velocity');let sum=0;for(let i=0;i<p.length;i+=4)sum+=(p[i+2]-1.2)*v[i]-(p[i]-1.2)*v[i+2];return sum/orb.liquid.n;};
  for(let i=0;i<360;i++){
   if(i===60){
    beforeMean=await meanX();const beforeVelocity=await orb.inspectParticles('velocity');
    orb.nudge(-.25,-.25,1,.45);const afterVelocity=await orb.inspectParticles('velocity');
    for(let j=0;j<beforeVelocity.length;j+=4)if(afterVelocity[j]-beforeVelocity[j]>.01)impulsedParticles++;
   }
   if(i===72)afterMean=await meanX();
   // Repeated worst bounded input checks containment, not just a pretty still.
   if(i>=150&&i<240&&i%15===0)orb.nudge(.25,-.4,i%30?4:-4,3);
   if(i===260)angularBefore=await angular();if(i===300)angularAfter=await angular();
   const start=performance.now();await orb.render({...base,dt:1/60,time:i/60,angularVelocity:i>=260&&i<300?3:0});durations.push(performance.now()-start);
   maxDensity=Math.max(maxDensity,orb.liquid.stats.maxRho);
  }
  const p=await orb.inspectParticles();let radius=0,invalid=0,minY=Infinity,maxY=-Infinity;
  for(let i=0;i<p.length;i+=4){const xyz=[p[i]-1.2,p[i+1]-1.2,p[i+2]-1.2];if(xyz.some(v=>!Number.isFinite(v)))invalid++;radius=Math.max(radius,Math.hypot(...xyz));minY=Math.min(minY,xyz[1]);maxY=Math.max(maxY,xyz[1]);}
  for(let i=0;i<6;i++)await orb.render({...base,dt:0,time:6});
  const frozen=await orb.inspectParticles();const pausePreserved=p.every((v,i)=>v===frozen[i]);
  const gasDivergence=await orb.inspectGas();
  const sorted=durations.slice(10).sort((a,b)=>a-b);
  return {particles:orb.liquid.n,frames:orb.frames,invalid,maxRadius:radius,minY,maxY,maxDensity,
   nudgeDisplacement:afterMean-beforeMean,impulsedParticles,angularBefore,angularAfter,pausePreserved,gasDivergence,medianMs:sorted[Math.floor(sorted.length*.5)],p95Ms:sorted[Math.floor(sorted.length*.95)],errors:window.errors};
 });
 console.log('Numerical result:',JSON.stringify(result));
 assert.equal(result.invalid,0);assert(result.particles>1000);assert(result.maxRadius<=.973);
 assert(result.impulsedParticles>100);assert(result.maxDensity<1.5);assert(result.pausePreserved);assert(result.gasDivergence.after<result.gasDivergence.before);assert.deepEqual(result.errors,[]);
 assert(result.angularAfter>result.angularBefore+.01,'a spinning shell transfers angular momentum into water');
 await page.screenshot({path:path.join(output,'orb-dark.png')});
 await page.evaluate(async()=>{await window.orb.render({dt:0,time:6,light:true,gazeX:.1,gazeY:.15,blink:1,thinking:false});document.body.style.background='#f4f6f8';});
 await page.screenshot({path:path.join(output,'orb-light.png')});
 const recording=await page.evaluate(async()=>{
  const canvas=document.querySelector('canvas');const stream=canvas.captureStream(30);
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4_000_000});const chunks=[];
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
  const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
  for(let i=0;i<100;i++){
   const started=performance.now();
   if(i===15)window.orb.nudge(-.25,-.2,1.2,.45);
   await window.orb.render({dt:1/30,time:6+i/30,light:false,gazeX:Math.sin(i/40)*.3,gazeY:.1,blink:1,thinking:false});
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000/30-(performance.now()-started))));
  }
  recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
  const bytes=new Uint8Array(await new Blob(chunks,{type:'video/webm'}).arrayBuffer());let text='';
  for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
 });
 writeFileSync(path.join(output,'live-fluid.webm'),Buffer.from(recording,'base64'));
 const sustained=await page.evaluate(async()=>{
  for(let i=0;i<1500;i++)await window.orb.render({dt:1/30,time:10+i/30,light:false,gazeX:0,gazeY:0,blink:1,thinking:false});
  return window.orb.inspectGas();
 });
 assert.equal(sustained.invalid,0);assert(sustained.maxSpeed<.8);assert(sustained.maxDye<=1.81);
 assert(sustained.after<sustained.before,'pressure projection must still reduce divergence after a minute');
 result.sustainedGas=sustained;
 const fire=await page.evaluate(async()=>{
  const orb=window.orb,durations=[];let peakEmbers=0;
  for(let i=0;i<600;i++){
   if(i===150)orb.nudge(-.25,-.2,1.2,.45);
   const at=performance.now();await orb.render({dt:1/30,time:60+i/30,light:false,gazeX:.35,gazeY:.1,blink:1,thinking:false,fire:1,lean:.35});durations.push(performance.now()-at);
   if(i%30===0){const embers=await orb.inspectEmbers();peakEmbers=Math.max(peakEmbers,embers.filter((v,i)=>i%4===3&&v>.04).length);}
  }
  const thermal=await orb.inspectThermal(),flow=await orb.inspectGas(),embers=[...await orb.inspectEmbers()];
  const particles=await orb.inspectParticles();const frozenEmbers=await orb.inspectEmbers();
  await orb.render({dt:0,time:80,light:false,gazeX:.35,gazeY:.1,blink:1,thinking:false,fire:0});
  const pausedThermal=await orb.inspectThermal(),pausedEmbers=await orb.inspectEmbers(),pausedParticles=await orb.inspectParticles();
  const pausePreserved=JSON.stringify(thermal)===JSON.stringify(pausedThermal)&&frozenEmbers.every((v,i)=>v===pausedEmbers[i])&&particles.every((v,i)=>v===pausedParticles[i]);
  durations.sort((a,b)=>a-b);
  return {thermal,flow,embers,peakEmbers,pausePreserved,medianMs:durations[300],p95Ms:durations[570]};
 });
 console.log('Fire result:',JSON.stringify({...fire,embers:undefined}));
 assert.equal(fire.thermal.invalid,0);assert.equal(fire.thermal.negative,0);assert(fire.thermal.max[1]>.3&&fire.thermal.max[1]<=2.41);
 assert(fire.thermal.total[3]>0,'the supplied flame burns fuel');assert(fire.peakEmbers>0,'hot flow emits inertial embers');
 assert(fire.pausePreserved,'motion off freezes fuel, heat, water and embers together');
 assert.equal(fire.flow.invalid,0);assert(fire.flow.maxSpeed<.8);assert(fire.flow.after<fire.flow.before);
 for(let i=0;i<fire.embers.length;i+=4){assert(fire.embers.slice(i,i+4).every(Number.isFinite));if(fire.embers[i+3]>.04)assert(Math.hypot(...fire.embers.slice(i,i+3))<=.966);}
 await page.evaluate(()=>{document.body.style.background='#192128';});
 await page.screenshot({path:path.join(output,'ember-dark.png')});
 await page.evaluate(()=>window.orb.render({dt:0,time:80,light:true,gazeX:.35,gazeY:.1,blink:1,thinking:false,fire:1}));
 await page.evaluate(()=>{document.body.style.background='#f4f6f8';});
 await page.screenshot({path:path.join(output,'ember-light.png')});
 const fireRecording=await page.evaluate(async()=>{
  const stream=document.querySelector('canvas').captureStream(30),chunks=[];
  const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4_000_000});
  recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
  const expression=new window.OrbExpression({focused:false,thinking:false,answerEvent:0,attentionEvent:0,temperament:'ember'});
  for(let i=0;i<240;i++){
   const started=performance.now();
   if(i===35)window.orb.nudge(-.25,-.2,1.2,.45);
   if(i===60)expression.spin();
   if(i===140)expression.setContext({focused:true,thinking:false,answerEvent:0,attentionEvent:0,temperament:'ember'});
   if(i===180)expression.setContext({focused:false,thinking:false,answerEvent:1,attentionEvent:0,temperament:'water'});
   await window.orb.render({...expression.step(1/30),dt:1/30,time:80+i/30,light:false,thinking:false});
   await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000/30-(performance.now()-started))));
  }
  recorder.stop();await stopped;stream.getTracks().forEach(t=>t.stop());
  const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
 });
 writeFileSync(path.join(output,'live-flame.webm'),Buffer.from(fireRecording,'base64'));
 const cooled=await page.evaluate(async()=>{
  for(let i=0;i<360;i++)await window.orb.render({dt:1/30,time:86+i/30,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,fire:0});
  const particles=await window.orb.inspectParticles();let maxRadius=0,invalidParticles=0;
  for(let i=0;i<particles.length;i+=4){const p=[particles[i]-1.2,particles[i+1]-1.2,particles[i+2]-1.2];if(!p.every(Number.isFinite))invalidParticles++;maxRadius=Math.max(maxRadius,Math.hypot(...p));}
  return {thermal:await window.orb.inspectThermal(),gas:await window.orb.inspectGas(),maxRadius,invalidParticles,embers:[...await window.orb.inspectEmbers()],errors:window.errors};
 });
 assert(cooled.thermal.total[1]<fire.thermal.total[1]*.1,'stopping supply lets heat dissipate');
 assert(cooled.thermal.total[3]<fire.thermal.total[3]*.01,'burning subsides without supplied fuel');
 assert(cooled.embers.every((v,i)=>i%4!==3||v<=.04),'embers cool after supply stops');assert.deepEqual(cooled.errors,[]);
 assert.equal(cooled.invalidParticles,0);assert(cooled.maxRadius<=.973,'water remains contained after the full expression-driven spin');
 assert.equal(cooled.thermal.invalid,0);assert.equal(cooled.thermal.negative,0);assert.equal(cooled.gas.invalid,0);
 assert(cooled.gas.after<cooled.gas.before,'pressure still improves after the spin and cooling sequence');
 result.fire={...fire,cooled,reaction};
 const report={...result,recordedAt:new Date().toISOString(),rendererSha256:createHash('sha256').update(readFileSync(path.join(assets,chunk))).digest('hex'),scope:'Isolated Electron44, 900px GPU canvas. GPU work completion included; not whole-app frame rate.'};
 writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');console.log('All GPU physics checks passed:',report.rendererSha256);
 await page.evaluate(()=>window.orb.destroy());
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
