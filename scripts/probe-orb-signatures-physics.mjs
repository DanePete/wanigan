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
const output=path.resolve(root,process.argv[2]??'docs/visuals/orb-signatures/physics');mkdirSync(output,{recursive:true});
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
 const page=await app.firstWindow();page.setDefaultTimeout(180000);
 await page.evaluate(async()=>{
  const {OrbRuntime}=await import('./runtime.js');window.OrbRuntime=OrbRuntime;window.orb=await OrbRuntime.create(document.querySelector('canvas'));window.errors=[];
  window.orb.device.addEventListener('uncapturederror',e=>window.errors.push(e.error.message));
 });
 await page.evaluate(async code=>{window.OrbExpression=(await import('data:text/javascript;base64,'+btoa(code))).OrbExpression;},expressionCode);
 const report={};
 const frame={dt:1/30,time:0,light:false,gazeX:0,gazeY:0,blink:1,thinking:false,material:0};
 await page.evaluate(base=>{window.base=base;window.clock=0;window.tick=async (count,over={})=>{for(let i=0;i<count;i++)await window.orb.render({...window.base,...over,time:window.clock++/30});};
 window.inspect=async()=>{const p=await window.orb.inspectParticles();let y=0,invalid=0,maxRadius=0;for(let i=0;i<p.length;i+=4){y+=p[i+1]-1.2;const xyz=[p[i]-1.2,p[i+1]-1.2,p[i+2]-1.2];if(!xyz.every(Number.isFinite))invalid++;maxRadius=Math.max(maxRadius,Math.hypot(...xyz));}return {meanY:y/window.orb.liquid.n,invalid,maxRadius,particles:window.orb.liquid.n};};},frame);
 await page.evaluate(()=>window.tick(75));
 report.settled=await page.evaluate(()=>window.inspect());
 await page.evaluate(async()=>{for(let i=0;i<180;i++)await window.tick(1,{float:1-Math.exp(-i/30*1.8)});});
 report.floating=await page.evaluate(()=>window.inspect());
 for(const light of [false,true]){await page.evaluate(light=>window.tick(1,{float:1,light}),light);await page.screenshot({path:path.join(output,`float-${light?'light':'dark'}.png`)});}
 assert(report.floating.meanY-report.settled.meanY>.15,'Float lifts the actual liquid mass');
 assert.equal(report.floating.particles,report.settled.particles,'Float preserves every water particle');
 await page.evaluate(async()=>{for(let i=0;i<150;i++)await window.tick(1,{float:Math.exp(-i/30*1.8)});});
 report.restored=await page.evaluate(()=>window.inspect());assert(report.restored.meanY<report.floating.meanY-.12,'restoring gravity settles the same water');
 console.log('Water lift and restoration:',JSON.stringify({settled:report.settled,floating:report.floating,restored:report.restored}));
 await page.evaluate(()=>window.tick(100,{pressure:.96,storyScope:'fixture'}));
 report.pockets=await page.evaluate(()=>window.orb.inspectKeepsakes());
 for(const light of [false,true]){await page.evaluate(light=>window.tick(1,{pressure:.96,storyScope:'fixture',light}),light);await page.screenshot({path:path.join(output,`crowded-${light?'light':'dark'}.png`)});}
 await page.evaluate(()=>window.tick(70,{pressure:.96,gather:1,storyScope:'fixture'}));
 report.gathered=await page.evaluate(()=>window.orb.inspectKeepsakes());
 const spread=particles=>{let total=0;for(let i=0;i<24;i++)total+=Math.hypot(particles[i*8],particles[i*8+1]-.3,particles[i*8+2]+.13);return total/24;};
 assert(spread(report.gathered)<spread(report.pockets)*.85,'compaction physically gathers the same pockets');
 await page.evaluate(()=>window.tick(100,{pressure:.15,memoryCount:3,storyScope:'fixture'}));
 report.keepsakes=await page.evaluate(()=>window.orb.inspectKeepsakes());
 for(let i=24;i<27;i++)assert(report.keepsakes[i*8+1]<.1&&report.keepsakes[i*8+3]>.07,'completed keepsakes fall through and settle into water');
 for(const light of [false,true]){await page.evaluate(light=>window.tick(1,{pressure:.15,memoryCount:3,storyScope:'fixture',light}),light);await page.screenshot({path:path.join(output,`keepsakes-${light?'light':'dark'}.png`)});}
 const liquidBefore=await page.evaluate(()=>Array.from(window.orb.liquid.buf.posA?[window.orb.liquid.n]:[]));
 await page.evaluate(()=>window.tick(110,{whirl:1,material:0}));
 report.thermal=await page.evaluate(()=>window.orb.inspectThermal());report.gas=await page.evaluate(()=>window.orb.inspectGas());
 for(const light of [false,true]){await page.evaluate(light=>window.tick(1,{whirl:1,light}),light);await page.screenshot({path:path.join(output,`whirl-${light?'light':'dark'}.png`)});}
 assert(report.thermal.total[1]>100&&report.thermal.max[1]>.5,'failure transports a burning thermal volume');
 assert.equal(report.thermal.invalid,0);assert.equal(report.thermal.negative,0);assert.equal(report.gas.invalid,0);
 await page.evaluate(()=>window.tick(50,{recovery:1,material:0}));
 for(const light of [false,true]){await page.evaluate(light=>window.tick(1,{recovery:1,light}),light);await page.screenshot({path:path.join(output,`recovery-${light?'light':'dark'}.png`)});}
 await page.evaluate(()=>window.tick(15,{material:0}));
 assert.equal(await page.evaluate(()=>window.orb.liquid.n),liquidBefore[0],'temporary fire does not reset liquid');
 report.errors=await page.evaluate(()=>window.errors);assert.deepEqual(report.errors,[]);
 for(const result of [report.settled,report.floating,report.restored]){assert.equal(result.invalid,0);assert(result.maxRadius<=.974);}
 for(const particles of [report.pockets,report.gathered,report.keepsakes])assert(particles.every(Number.isFinite));
 report.runtimeSha256=createHash('sha256').update(readFileSync(path.join(assets,chunk))).digest('hex');
 report.recordedAt=new Date().toISOString();report.scope='Isolated Electron/WebGPU, synthetic story controls; no agent or provider calls. Normalized combustion, colliding context bodies and microgravity water with gentle centering.';
 writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2)+'\n');
 console.log('Signature physics passed: liquid mass lift/restoration, context gathering, keepsake settling, transported flame and GPU validation.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
