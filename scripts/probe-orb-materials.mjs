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
const output=path.resolve(root,process.argv[2]??'docs/visuals/orb-materials/physics');mkdirSync(output,{recursive:true});
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


 const frames=async(count,extra={})=>page.evaluate(async({count,extra})=>{
  window.t??=0;window.timings??=[];
  for(let i=0;i<count;i++){
   window.t+=1/30;const at=performance.now();
   await window.orb.render({dt:1/30,time:window.t,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,...extra});
   window.timings.push(performance.now()-at);
  }
 },{count,extra});
 const record=async(name,count,extra={})=>{
  const result=await page.evaluate(async({count,extra})=>{
   document.body.style.background='#192128';
   const canvas=document.querySelector('canvas'),stream=canvas.captureStream(30),chunks=[];
   const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9',videoBitsPerSecond:4_000_000});
   recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
   const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start();
   try{for(let i=0;i<count;i++){
    const at=performance.now();window.t+=1/30;
    if(i===12&&[5,6,7].includes(extra.material))window.orb.play('shake');
    if(extra.material===3){if(i===12)window.orb.point(.25,.65,true);if(i===85)window.orb.point(0,0,false);}
    if(extra.material===8&&i%60===0)window.orb.point(i===0?.6:-.6,.2,true);
    if(extra.material===4&&i===0)window.orb.play('bloom');
    await window.orb.render({dt:1/30,time:window.t,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,...extra});
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,1000/30-(performance.now()-at))));
   }}finally{recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());}
   const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());let text='';
   for(let i=0;i<bytes.length;i+=32768)text+=String.fromCharCode(...bytes.subarray(i,i+32768));return btoa(text);
  },{count,extra});
  writeFileSync(path.join(output,name+'.webm'),Buffer.from(result,'base64'));
 };
 const inspect=()=>page.evaluate(()=>window.orb.inspectMaterials());
 const mean=(values,axis,stride=8)=>values.reduce((sum,v,i)=>sum+(i%stride===axis?v:0),0)/(values.length/stride);
 const reports={};
 const capture=async(name,extra)=>{
  for(const light of [false,true]){
   await page.evaluate(async({light,extra})=>{
    document.body.style.background=light?'#f4f6f8':'#192128';
    await window.orb.render({dt:0,time:window.t,light,gazeX:0,gazeY:0,blink:1,thinking:false,...extra});
   },{light,extra});
   await page.screenshot({path:path.join(output,`${name}-${light?'light':'dark'}.png`)});
  }
 };
 const only=process.argv.find(arg=>arg.startsWith('--only='))?.slice(7).split(',');
 for(const [name,material] of [['water',0],['fire',1],['lava',2],['ferro',3],['ink',4],['jelly',5],['honey',6],['snow',7],['plasma',8],['pearls',9]].filter(([name])=>!only||only.includes(name))){
  const timingStart=await page.evaluate(()=>window.timings?.length??0);
  const extra={material,fire:material===1?1:0,lava:material===2?1:0};
  await frames(1,extra);
  const initial=await inspect();
  await frames(material===9?360:material===1||material===2?240:100,extra);
  let state=await inspect();
  for(const key of ['matter','snow','plasma','pearls'])assert(state[key].every(Number.isFinite),`${name}: finite ${key}`);
  if(material===3){
   const settled=state.ferro;
   await page.evaluate(()=>window.orb.point(.25,.65,true));await frames(100,extra);
   state=await inspect();
   assert(state.ferro.max>settled.max+.15&&state.ferro.invalid===0,'magnetic pressure raises the evolving liquid surface');
   assert(Math.abs(state.ferro.mean-settled.mean)<.03,'magnetic peaks displace the surrounding pool without excessive height drift');
   reports.ferro={rest:settled,attracted:state.ferro};
   await capture(name,extra);
   await page.evaluate(()=>window.orb.point(0,0,false));await frames(160,extra);
   assert((await inspect()).ferro.max<reports.ferro.attracted.max-.1,'magnetic surface relaxes after field removal');
  }else if(material===4){
   const ink=await page.evaluate(()=>window.orb.inspectInk());assert.equal(ink.invalid,0);assert(ink.amount>10&&ink.active>100,'ink retains a transported volume');
   const transfer=await page.evaluate(async()=>{
    const orb=window.orb,source=orb.liquid.buf['vel'+(orb.liquid.parity===0?'A':'B')];
    const original=await orb.inspectParticles('velocity');orb.ink.push(orb.liquid,1/30);const after=await orb.inspectParticles('velocity');
    orb.device.queue.writeBuffer(source,0,original);let downward=0,changed=0;
    for(let i=0;i<original.length;i+=4){const dy=after[i+1]-original[i+1];downward+=dy;if(dy<-.00001)changed++;}
    return {downward,changed};
   });
   assert(transfer.changed>20&&transfer.downward<-.01,'denser ink pushes the real fluid downward');
   reports.ink={...ink,transfer};await capture(name,extra);
  }else if(material===5||material===6){
   const quiet=state.matter;await page.evaluate(()=>window.orb.play('shake'));await frames(20,extra);
   state=await inspect();
   assert(mean(state.matter,1)>mean(quiet,1)+.03,`${name}: handling moves the material`);
   reports[name]={beforeY:mean(quiet,1),kickedY:mean(state.matter,1)};
   await capture(name,extra);
  }else if(material===7){
   assert(state.snowfall.deposited>initial.snowfall.deposited+.03,'snow deposits under gravity');
   await capture(name,extra);
   const checkpoints=[];
   for(const seconds of [30,60,90]){
    await page.evaluate(seconds=>{const physics=window.orb.snow.physics;while(physics.time<seconds-1/30)physics.advance(1/30);},seconds);
    await frames(1,extra);state=await inspect();checkpoints.push(state.snowfall);
    await capture(`snow-${seconds}s`,extra);
   }
   const before=state.snowfall;await page.evaluate(()=>window.orb.play('shake'));await frames(30,extra);
   state=await inspect();assert(state.snowfall.lifted>.1&&state.snowfall.deposited<before.deposited-.1,'shake lifts accumulated snow');
   assert(Math.abs(state.snowfall.massError)<.00001,'shake conserves powder');
   reports.snow={checkpoints,shaken:state.snowfall};await capture('snow-shaken',extra);
   const isolated=await page.evaluate(async()=>{
    const orb=window.orb,frame={dt:0,time:window.t,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,material:7};
    await orb.render(frame);const before=document.querySelector('canvas').toDataURL();
    const original=await orb.inspectParticles();
    orb.liquid.applyRayImpulse([1.2,.8,4.],[0,0,-1],[2.,1.,0.],.8,4.);
    for(let i=0;i<20;i++)orb.liquid.step(1/30);
    const after=await orb.inspectParticles();await orb.render(frame);
    return {waterMoved:after.some((v,i)=>Math.abs(v-original[i])>.01),identical:before===document.querySelector('canvas').toDataURL()};
   });
   assert(isolated.waterMoved&&isolated.identical,'dry snow pixels do not depend on the water simulation');reports.snow.isolation=isolated;
  }else if(material===8){
   await capture('plasma-idle',extra);
   await page.evaluate(()=>window.orb.point(.65,.15,true));await frames(70,extra);state=await inspect();
   const main=state.discharge.channels.slice(0,8),winner=main.reduce((a,b)=>a.power>b.power?a:b);
   assert(Math.hypot(...winner.tip.map((v,i)=>v-state.discharge.contact[i]))<.03,'plasma attaches at the actual touched glass');
   assert(winner.power/main.reduce((sum,c)=>sum+c.power,0)>.7,'touch concentrates the discharge');
   reports.plasma=state.discharge;await capture(name,extra);await page.evaluate(()=>window.orb.point(0,0,false));
  }else if(material===9){
   assert(state.pearls.every((v,i)=>i%4!==3||v>.1),'three actual rigid pearls are reconstructed');
   assert(state.pearls[1]>state.pearls[9]+.05,'light pearl floats above the dense pearl');
   reports.pearls={centers:state.pearls,particleCount:await page.evaluate(()=>window.orb.liquid.n)};
   await capture(name,extra);
  }else{await capture(name,extra);}
  if([5,6].includes(material)){
   let radius=0;for(let i=0;i<state.matter.length;i+=8)radius=Math.max(radius,Math.hypot(...state.matter.slice(i,i+3)));
   assert(radius<.86,`${name}: all material particles remain in the vessel`);reports[name].maxRadius=radius;
  }
  const frozen=await inspect();await frames(3,{...extra,dt:0});assert.deepEqual(await inspect(),frozen,`${name}: motion off freezes the new particles`);
  assert.deepEqual(await page.evaluate(()=>window.errors),[],`${name}: GPU errors`);
  if(process.argv.includes('--record'))await record(name,120,extra);
  if(material===1){
   const switching=await page.evaluate(async()=>{
    const orb=window.orb,thermal=await orb.inspectThermal();
    const frame={dt:0,time:window.t,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,material:0,fire:0};
    await orb.render(frame);const withResidualHeat=document.querySelector('canvas').toDataURL();
    // Counterfactual: keep the water, view and gas identical, remove only the
    // old fire field. Water's rendered pixels must not depend on that field.
    const pipeline=orb.device.createComputePipeline({layout:'auto',compute:{entryPoint:'main',module:orb.device.createShaderModule({code:`
      @group(0) @binding(0) var field:texture_storage_3d<rgba16float,write>;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){textureStore(field,id,vec4f(0.));}`})}});
    const encoder=orb.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);
    pass.setBindGroup(0,orb.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:orb.gas.thermal.texture.createView()}]}));
    const groups=orb.gas.thermal.texture.width/4;pass.dispatchWorkgroups(groups,groups,groups);pass.end();orb.device.queue.submit([encoder.finish()]);
    await orb.render(frame);
    return {heatBeforeSwitch:thermal.max[1],identical:withResidualHeat===document.querySelector('canvas').toDataURL()};
   });
   assert(switching.heatBeforeSwitch>.2,'switching check starts with a burning chamber');
   assert(switching.identical,'switching to water hides all residual fire and fire lighting');
   reports.fire={switching};
   await capture('water-after-fire',{material:0,fire:0,lava:0});
  }
  const renderMs=await page.evaluate(start=>{const values=window.timings.slice(start+5).sort((a,b)=>a-b);return {median:values[Math.floor(values.length*.5)],p95:values[Math.floor(values.length*.95)],frames:values.length,includesGpuWait:true,pixels:document.querySelector('canvas').width};},timingStart);
  reports[name]={...reports[name],renderMs};
  console.log('Verified',name,JSON.stringify(reports[name]??{}));
 }
 await frames(2,{material:0});assert.equal(await page.evaluate(()=>window.orb.liquid.n),8144,'leaving pearls restores the original water scene');
 const report={recordedAt:new Date().toISOString(),rendererSha256:createHash('sha256').update(readFileSync(path.join(assets,chunk))).digest('hex'),reports,errors:await page.evaluate(()=>window.errors),scope:'Isolated Electron, actual GPU simulations; no sessions or model calls'};
 writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log('All material physics checks passed');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
