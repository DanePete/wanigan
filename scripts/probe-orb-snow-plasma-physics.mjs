#!/usr/bin/env node
// Deterministic production solvers, no browser, model calls or user data.
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
const require=createRequire(import.meta.url),ts=require('typescript');
const load=async name=>import('data:text/javascript;base64,'+Buffer.from(ts.transpileModule(readFileSync(new URL(`../src/renderer/src/orb/${name}.ts`,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText).toString('base64'));
const {SnowPhysics}=await load('snow'),{PlasmaPhysics,plasmaContact,PLASMA_STATIONS}=await load('plasma');
const snow=new SnowPhysics(),checkpoints=[];
for(let second=1;second<=120;second++){
 for(let i=0;i<30;i++)snow.advance(1/30);
 if([1,15,30,60,90,120].includes(second)){const state=snow.inspect();checkpoints.push(state);console.log('Snow',JSON.stringify(state));}
}
assert(checkpoints[2].deposited>checkpoints[1].deposited+.3,'snow visibly accumulates over time');
assert(checkpoints[4].fill>.85,'globe is nearly filled at 90 seconds');
assert(checkpoints[5].fill>.96,'globe fills within two minutes');
assert(snow.supplied<=3.000001,'snowfall stops at bounded capacity');
assert(Math.abs(snow.inspect().massError)<.00001,'bed plus airborne mass equals supplied snow');
const before=snow.inspect();
for(let i=0;i<30;i++)snow.advance(1/30,1.5*Math.exp(-i/6));
const shaken=snow.inspect();console.log('Shaken',JSON.stringify(shaken));
assert(shaken.lifted>.15&&shaken.deposited<before.deposited-.1,'shake lifts actual deposited snow');
assert.equal(shaken.supplied,before.supplied,'shake at capacity creates no new mass');
assert(Math.abs(shaken.massError)<.00001,'shaking conserves snow');
for(let i=0;i<600;i++)snow.advance(1/30);
const settled=snow.inspect();assert(settled.deposited>shaken.deposited+.1,'lifted powder settles back into the bed');
assert(settled.invalid===0&&settled.maxRadius<.941,'snow stays finite and inside its vessel');
const frozen=[...snow.values,...snow.heights];snow.advance(0,2,7,7,5);assert.deepEqual([...snow.values,...snow.heights],frozen,'motion off freezes the snow');
const cadenceA=new SnowPhysics(),cadenceB=new SnowPhysics();
for(let i=0;i<300;i++)cadenceA.advance(1/30);
for(let i=0;i<600;i++)cadenceB.advance(1/60);
assert.deepEqual(cadenceA.values,cadenceB.values,'30/60 Hz snow trajectories agree');
assert.deepEqual(cadenceA.bed,cadenceB.bed,'30/60 Hz deposition agrees');
const cadenceMini=new SnowPhysics();for(let i=0;i<180;i++)cadenceMini.advance(1/18);
assert.deepEqual(cadenceA.bed,cadenceMini.bed,'miniature cadence preserves snowfall timing');
const plasma=new PlasmaPhysics();
for(let i=0;i<450;i++)plasma.advance(1/30,[0,0,0]);
const idle=plasma.inspect();
assert(idle.channels.reduce((n,c)=>n+c.renewals,0)>=8,'channels renew independently');
assert(idle.channels.filter(c=>c.parent>=0).length===4,'four connected branch channels');
const rootRadius=[];
for(let s=0;s<8;s++){const i=s*PLASMA_STATIONS*8;rootRadius.push(Math.hypot(plasma.values[i],plasma.values[i+1]+.08,plasma.values[i+2]));}
assert(rootRadius.every(r=>Math.abs(r-.145)<.000001),'roots lie on the finite electrode');
const contacts=[];
for(const point of [[.65,.15,1],[-.6,.35,1],[0,-.65,1],[.82,.4,1]]){
 const hit=plasmaContact(point);assert(hit&&Math.abs(Math.hypot(...hit)-.965)<.000001,'pointer hits inner glass');
 for(let i=0;i<100;i++)plasma.advance(1/30,point);
 const state=plasma.inspect(),main=state.channels.slice(0,8),winner=main.reduce((a,b)=>a.power>b.power?a:b);
 assert(Math.hypot(...winner.tip.map((v,i)=>v-hit[i]))<.03,'dominant discharge reaches the touched shell point');
 assert(winner.power/main.reduce((s,c)=>s+c.power,0)>.7,'touch concentrates power instead of multiplying all glow');
 assert(state.power<4.5,'bounded total excitation');contacts.push(state);
}
assert.equal(plasmaContact([1,1,1]),null,'canvas corners outside glass are not contact');
for(let i=0;i<150;i++)plasma.advance(1/30,[0,0,0]);
const released=plasma.inspect();assert(released.touch<.001,'contact excitation fades after release');
assert(released.channels.slice(0,8).filter(c=>c.power>.1).length>=5,'distributed channels return after release');
assert.equal(released.invalid,0);
const held=[...plasma.values];plasma.advance(0,[.7,.2,1],4);assert.deepEqual([...plasma.values],held,'motion off freezes plasma');
const a=new PlasmaPhysics(),b=new PlasmaPhysics();
for(let i=0;i<300;i++)a.advance(1/30,[.5,.2,1]);
for(let i=0;i<600;i++)b.advance(1/60,[.5,.2,1]);
assert.deepEqual(a.values,b.values,'30/60 Hz discharge trajectories agree');
const stressed=new PlasmaPhysics();let maxRadius=0;
for(let i=0;i<1800;i++){
 stressed.advance(1/30,[Math.sin(i*.021)*.85,Math.cos(i*.043)*.65,i%200<160?1:0],2);
 for(let j=0;j<stressed.values.length;j+=8)maxRadius=Math.max(maxRadius,Math.hypot(stressed.values[j],stressed.values[j+1],stressed.values[j+2]));
}
assert(maxRadius<.966,'rapid moving contact cannot push channels outside the glass');
const report={scope:'Deterministic production physics; simulation seconds, not a physical calibration',snow:{checkpoints,shaken,settled},plasma:{idle,contacts,released,rootRadius,maxRadius}};
if(process.argv[2]){const dir=path.resolve(process.argv[2]);mkdirSync(dir,{recursive:true});writeFileSync(path.join(dir,'physics.json'),JSON.stringify(report,null,2)+'\n');}
console.log('Snow accumulation, mass conservation, shaking, plasma contact, topology, power and cadence passed');
