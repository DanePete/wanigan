import { Sim } from './vendor/sim.js';
import { meshPrelude, meshDensityWGSL } from './vendor/density.js';
import { Gas } from './gas';
import { Bubbles } from './bubbles';
import { Embers } from './embers';
import { ShellDrag } from './shell-drag';
import { Lens } from './lens';
import { OPTICS } from './optics';
import { loadStudio, loadBackdrop } from './environment';
import { Handling } from './handling';
import { Wakes } from './wakes';
import { Weather } from './weather';
import { Wax } from './wax';
import { Ripples } from './ripples';
import { Matter } from './matter';
import { Ink } from './ink';
import { Snow } from './snow';
import { Plasma, PLASMA_COUNT } from './plasma';
import { Pearls } from './pearls';
import { Ferrofluid } from './ferrofluid';
import { Keepsakes } from './keepsakes';

const RESOLUTION = 80;
const DENSITY = (meshPrelude + meshDensityWGSL)
  .replace('var<storage, read_write> field     : array<f32>', 'var field : texture_storage_3d<rgba16float,write>')
  .replace('var acc = 0.0;', 'var acc = 0.0; var flow = vec3f(0.);')
  .replace('acc += vol * M.poly6 * t * t * t;', 'let weight=vol*M.poly6*t*t*t; acc+=weight; flow+=weight*velocity[j].xyz;')
  .replace('field[idx] = acc;', 'textureStore(field, v, vec4f(acc,flow/max(acc,.001)));')
  + '\n@group(0) @binding(6) var<storage,read> velocity:array<vec4f>;';

export type OrbFrame = { dt:number; elapsedDt?:number; time:number; light:boolean; gazeX:number; gazeY:number; blink:number; thinking:boolean;
  whirl?:number;recovery?:number;pressure?:number;gather?:number;memoryCount?:number;storyScope?:string;float?:number;
  fire?:number; energy?:number; lean?:number; curiosity?:number; warmth?:number; yaw?:number; angularVelocity?:number;
  roll?:number;pitch?:number;accelX?:number;accelY?:number;wink?:number;surprise?:number;
  material?:number;tint?:[number,number,number];tintStrength?:number;lava?:number;vortex?:number;celebration?:number;bubbleInterest?:number };
export type OrbPlay='splash'|'burst'|'rain'|'bloom'|'shake';
export class OrbRuntime {
  readonly liquid: Sim;
  private readonly water: GPUTexture;
  private readonly blurPasses:{pipeline:GPUComputePipeline;group:GPUBindGroup}[];
  private readonly gas: Gas;
  private readonly bubbles:Bubbles;
  private readonly embers:Embers;
  private shell:ShellDrag;
  private readonly lens:Lens;
  private readonly handling=new Handling();
  private readonly wakes:Wakes;
  private readonly weather:Weather;
  private readonly wax:Wax;
  private readonly ripples:Ripples;
  private readonly densityPipeline: GPUComputePipeline;
  private densityGroups: GPUBindGroup[];
  private readonly raw:GPUTexture;
  private readonly densityUniform:GPUBuffer;
  private readonly matter:Matter;
  private readonly ferrofluid:Ferrofluid;
  private readonly ink:Ink;
  private readonly snow:Snow;
  private readonly plasma:Plasma;
  private readonly pearls:Pearls;
  private readonly keepsakes:Keepsakes;
  private material=0;
  private materialSeeded=false;
  private hasPearls=false;
  private pointer:[number,number,number]=[0,0,0];
  private kick=0;
  private readonly pipeline: GPURenderPipeline;
  private readonly group: GPUBindGroup;
  private readonly view: GPUBuffer;
  private impulse = 0;
  private stroke={x:0,y:-.4,strength:0};
  private rainAge=100;
  private party=0;
  private previousCelebration=0;
  private bursts=0;
  private disposed = false;
  frames = 0;
  private submissions = 0;
  private constructor(readonly device:GPUDevice, private canvas:HTMLCanvasElement, private context:GPUCanvasContext, environment:GPUTexture, backdrop:GPUTexture) {
    const format=navigator.gpu.getPreferredCanvasFormat();
    context.configure({device,format,alphaMode:'premultiplied'});
    this.lens=new Lens(device,format);
    this.liquid = new Sim(device);
    this.liquid.reset({box:[2.4,2.4,2.4],spacing:.055,restDensity:1000,gravity:9.81,
      substeps:2,iterations:4,cfmEpsilonRel:.01,sCorrK:.1,sCorrDq:.3,xsphC:.066,
      omega:1.03,sorAverage:false,surfaceTensionK:.4,bodies:[],pour:false});
    const makeVolume=(label:string)=>device.createTexture({label,size:[RESOLUTION,RESOLUTION,RESOLUTION],
      dimension:'3d',format:'rgba16float',usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING});
    const raw=makeVolume('Raw liquid density'), middle=makeVolume('Filtered liquid X'), end=makeVolume('Filtered liquid Y');
    this.water=makeVolume('Reconstructed liquid volume');this.raw=raw;
    const volumes=[raw,middle,end,this.water];
    this.blurPasses=[0,1,2].map(axis=>{
      const axisVector=[0,0,0];axisVector[axis]=1;
      const pipeline=device.createComputePipeline({label:'Liquid field smoothing',layout:'auto',compute:{entryPoint:'main',
        module:device.createShaderModule({code:`
        @group(0) @binding(0) var inputField:texture_3d<f32>;
        @group(0) @binding(1) var outputField:texture_storage_3d<rgba16float,write>;
        @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
          let c=vec3i(id);let axis=vec3i(${axisVector.join(',')});
          let hi=vec3i(${RESOLUTION-1});
          let value=textureLoad(inputField,clamp(c-axis*2,vec3i(0),hi),0)*.0625+
            textureLoad(inputField,clamp(c-axis,vec3i(0),hi),0)*.25+textureLoad(inputField,c,0)*.375+
            textureLoad(inputField,clamp(c+axis,vec3i(0),hi),0)*.25+textureLoad(inputField,clamp(c+axis*2,vec3i(0),hi),0)*.0625;
          textureStore(outputField,id,value);
        }`})}});
      return {pipeline,group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:volumes[axis].createView()},{binding:1,resource:volumes[axis+1].createView()}]})};
    });
    const densityUniform=this.densityUniform=device.createBuffer({size:112,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const f=new Float32Array(28), ints=new Int32Array(f.buffer), h=this.liquid.h;
    ints.set([RESOLUTION,RESOLUTION,RESOLUTION]);f[3]=2/(RESOLUTION-1);
    f.set([.2,.2,.2,.4,0,0,0,1/h],4);f[15]=h*h;
    ints.set(this.liquid.gridDim,16);f[19]=315/(64*Math.PI*h**9);
    f[20]=this.liquid.scene.mass;f[21]=1000;
    device.queue.writeBuffer(densityUniform,0,f);
    this.densityPipeline=device.createComputePipeline({label:'Liquid density reconstruction',layout:'auto',
      compute:{module:device.createShaderModule({code:DENSITY}),entryPoint:'main'}});
    this.densityGroups=this.bindDensity();
    // Initialize density once even when decorative motion starts switched off.
    this.liquid.step(1/60);
    this.gas=new Gas(device,this.water);
    this.keepsakes=new Keepsakes(device,this.water,this.gas.texture);
    const impacts=device.createBuffer({size:144*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    this.ripples=new Ripples(device,impacts);
    this.weather=new Weather(device,this.water,this.gas.texture,impacts,this.ripples.texture);
    this.shell=new ShellDrag(device,this.liquid,this.weather.impacts,this.keepsakes.particles);
    this.wakes=new Wakes(device,this.water);
    this.wax=new Wax(device);
    this.matter=new Matter(device);this.ferrofluid=new Ferrofluid(device,this.matter.texture);this.ink=new Ink(device,this.water);this.snow=new Snow(device);
    this.plasma=new Plasma(device);this.pearls=new Pearls(device);this.ink.bind(this.liquid);
    const waxSeed=device.createCommandEncoder();this.wax.step(waxSeed,0,0,0);device.queue.submit([waxSeed.finish()]);
    this.bubbles=new Bubbles(device,this.water);
    this.embers=new Embers(device,this.gas.texture,this.water,this.gas.thermal.texture);
    this.view=device.createBuffer({size:128,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const material=device.createShaderModule({label:'Glass, liquid and vapor optics',code:OPTICS});
    this.pipeline=device.createRenderPipeline({label:'Wanigan glass vessel',layout:'auto',
      vertex:{module:material,entryPoint:'vs'},fragment:{module:material,entryPoint:'fs',targets:[{format:'rgba16float'}]},
      primitive:{topology:'triangle-list'}});
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.view}}, {binding:1,resource:this.water.createView()},
      {binding:2,resource:this.gas.texture.createView()},
      {binding:3,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
      {binding:4,resource:environment.createView()},
      {binding:5,resource:{buffer:this.bubbles.positions}},
      {binding:6,resource:backdrop.createView()},
      {binding:7,resource:this.gas.thermal.texture.createView()},
      {binding:8,resource:{buffer:this.embers.positions}},
      {binding:9,resource:this.wakes.texture.createView()},
      {binding:10,resource:this.wax.texture.createView()},
      {binding:11,resource:{buffer:this.weather.positions}},
      {binding:12,resource:{buffer:this.bubbles.gaze}},
      {binding:13,resource:this.ripples.texture.createView()},
      {binding:14,resource:this.matter.texture.createView()},{binding:15,resource:this.ink.texture.createView()},
      {binding:16,resource:{buffer:this.snow.particles}},{binding:17,resource:{buffer:this.plasma.particles}},
      {binding:18,resource:{buffer:this.pearls.positions}},{binding:19,resource:this.snow.texture.createView()},{binding:20,resource:{buffer:this.keepsakes.particles}}]});
  }
  private bindDensity(){
    return ['A','B'].map(side=>this.device.createBindGroup({layout:this.densityPipeline.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.densityUniform}},{binding:1,resource:{buffer:this.liquid.buf['pos'+side]}},
      {binding:2,resource:{buffer:this.liquid.buf.density}},{binding:3,resource:{buffer:this.liquid.buf.cellStart}},
      {binding:4,resource:this.raw.createView()},{binding:5,resource:{buffer:this.liquid.buf['body'+side]}},
      {binding:6,resource:{buffer:this.liquid.buf['vel'+side]}}]}));
  }
  private configurePearls(enabled:boolean){
    if(enabled===this.hasPearls)return;
    this.hasPearls=enabled;
    this.liquid.reset({...this.liquid.params,bodySize:.145,bodies:enabled?['sphere:0.45:0.60','sphere:0.72:0.70','sphere:1.7:0.65']:[]});
    this.liquid.step(1/60);
    this.device.queue.writeBuffer(this.densityUniform,23*4,new Uint32Array([enabled?1:0]));
    this.densityGroups=this.bindDensity();this.shell.destroy();this.shell=new ShellDrag(this.device,this.liquid,this.weather.impacts,this.keepsakes.particles);
    if(enabled)this.pearls.bind(this.liquid);this.ink.bind(this.liquid);
  }
  point(x:number,y:number,inside:boolean){this.pointer=[x,y,inside?1:0];}
  static async create(canvas:HTMLCanvasElement):Promise<OrbRuntime> {
    if(!navigator.gpu)throw new Error('WebGPU is unavailable');
    const adapter=await navigator.gpu.requestAdapter({powerPreference:'low-power'});
    if(!adapter)throw new Error('A WebGPU adapter is unavailable');
    const device=await adapter.requestDevice();
    device.pushErrorScope('validation');
    try {
      const context=canvas.getContext('webgpu');
      if(!context)throw new Error('A WebGPU canvas is unavailable');
      const environment=await loadStudio(device);
      const backdrop=await loadBackdrop(device);
      const runtime=new OrbRuntime(device,canvas,context,environment,backdrop);
      const error=await device.popErrorScope();
      if(error)throw new Error(error.message);
      return runtime;
    } catch(error) {device.destroy();throw error;}
  }
  nudge(x:number,y:number,dx:number,dy:number) {
    if(this.disposed)return;
    this.impulse=Math.max(-2,Math.min(2,dx));
    this.kick=Math.max(this.kick,Math.min(1.5,Math.hypot(dx,dy)));
    this.stroke={x,y:Math.min(.05,y),strength:Math.min(1.5,Math.hypot(dx,dy))};
    this.liquid.applyRayImpulse([1.2+x,1.2+y,4.],[0,0,-1],
      [Math.max(-2.4,Math.min(2.4,dx*3)),Math.max(-1,Math.min(1.2,dy*2)),.08],.65,3);
  }
  grab(x:number,y:number){if(!this.disposed){this.handling.grab(x,y);this.canvas.dataset.grabbed='true';}}
  release(){this.handling.release();this.canvas.dataset.grabbed='false';}
  play(kind:OrbPlay){
    if(this.disposed)return;
    if(kind==='rain'){this.rainAge=0;return;}
    if(kind==='bloom'){this.ink.bloom();return;}
    if(kind==='shake'){this.kick=1.5;this.nudge(-.25,-.3,1.5,1.5);return;}
    if(kind==='burst'){this.party=1;return;}
    this.nudge(-.25,-.35,1.2,.8);
  }
  async render(frame:OrbFrame) {
    if(this.disposed)return;
    const pixels=Math.min(900,Math.max(200,Math.round(this.canvas.clientWidth*Math.min(devicePixelRatio,2))));
    if(this.canvas.width!==pixels){this.canvas.width=pixels;this.canvas.height=pixels;}
    this.lens.resize(pixels);
    const dt=Math.min(Math.max(0,frame.dt),1/30),handled=this.handling.step(dt);
    // Expression moves the vessel, and the contents receive its acceleration.
    // Keep the same bounded force path used by deliberate grabbing and flicking.
    const pose={roll:handled.roll+(frame.roll??0),pitch:handled.pitch+(frame.pitch??0),
      ax:Math.max(-7,Math.min(7,handled.ax+(frame.accelX??0))),ay:Math.max(-7,Math.min(7,handled.ay+(frame.accelY??0)))};
    // These small CPU solvers substep internally. Keep their real elapsed time
    // at the mini's lower draw rate, without changing the fluid solver's bound.
    const chamberDt=dt>0?Math.min(Math.max(0,frame.elapsedDt??frame.dt),.1):0;
    const performance=Math.max(frame.whirl??0,frame.recovery??0);
    const material=frame.material??((frame.lava??0)>.5?2:(frame.fire??0)>.5?1:0);
    const changed=material!==this.material||!this.materialSeeded;
    if(changed){this.configurePearls(material===9);if(material===4)this.ink.bloom();this.material=material;this.materialSeeded=true;}
    // Temporary fire chamber preserves the selected material and liquid buffers.
    const displayMaterial=performance>.015?1:material;
    const fire=performance>.015?Math.max(.65,performance):(frame.fire??0);
    const solid=displayMaterial===1||material===1||material===3||material===5||material===6||material===7||material===8;
    const answer=frame.celebration??0;
    const burst=dt>0&&(this.party===1||answer>this.previousCelebration+.1);
    if(burst){this.bursts++;if(material===4)this.ink.bloom(true);}
    this.canvas.dataset.bursts=String(this.bursts);
    this.previousCelebration=answer;
    const celebration=Math.max(this.party,answer);
    const smooth=(x:number)=>{const t=Math.max(0,Math.min(1,x));return t*t*(3-2*t);};
    const cloud=smooth(this.rainAge/1.5)*(1.-smooth((this.rainAge-7)/3));
    const rain=smooth((this.rainAge-1.5)/1.5)*(1.-smooth((this.rainAge-6)/2));
    if(frame.dt>0&&!solid){
      this.shell.step(dt,frame.angularVelocity??0,frame.vortex??0,pose.ax,pose.ay,celebration,cloud,frame.float??0);
      this.liquid.params.gravity=9.81*(1-(frame.float??0));
      this.liquid.params.surfaceTensionK=.4+(frame.float??0)*.45;
      if(material===4)this.ink.push(this.liquid,dt);
      this.liquid.step(dt);
    }
    const encoder=this.device.createCommandEncoder();
    const density=encoder.beginComputePass();density.setPipeline(this.densityPipeline);
    density.setBindGroup(0,this.densityGroups[this.liquid.parity]);
    density.dispatchWorkgroups(Math.ceil(RESOLUTION**3/256));density.end();
    for(const {pipeline,group} of this.blurPasses){
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);
      pass.dispatchWorkgroups(RESOLUTION/4,RESOLUTION/4,RESOLUTION/4);pass.end();
    }
    if(frame.dt>0){
      if(!solid||displayMaterial===1)this.gas.step(encoder,dt,frame.time,this.impulse,fire,frame.lean??0,frame.energy??0,frame.angularVelocity??0,cloud,frame.whirl??0,frame.recovery??0);
      if(!solid)this.bubbles.step(encoder,dt,frame.time,burst,(frame.bubbleInterest??0)*(1-(frame.lava??0)));
      if(!solid||displayMaterial===1)this.embers.step(encoder,dt,frame.time,fire);
      if(!solid)this.wakes.step(encoder,dt,Math.max(this.stroke.strength,celebration),this.stroke.x,this.stroke.y);
      if(!solid)this.weather.step(encoder,dt,frame.time,rain,cloud);
      if(!solid)this.ripples.step(encoder,dt,cloud);
      if((frame.lava??0)>.001)this.wax.step(encoder,dt,pose.ax,pose.ay,this.kick);
      if(material===4)this.ink.step(encoder,dt);
      if(material===7)this.snow.step(encoder,chamberDt,Math.max(this.kick,celebration),pose.ax,pose.ay,frame.angularVelocity??0);
      this.rainAge+=dt;this.party=Math.max(0,this.party-dt*2.5);this.stroke.strength*=Math.exp(-dt*3.);
    }
    if((dt>0||changed)&&(material===5||material===6))this.matter.step(encoder,dt,material,pose.ax,pose.ay,Math.max(this.kick,celebration));
    if((dt>0||changed)&&material===3)this.ferrofluid.step(encoder,dt,this.pointer,pose.ax,pose.ay,this.kick);
    if((dt>0||changed)&&material===8)this.plasma.step(encoder,chamberDt,frame.time,this.pointer,frame.angularVelocity??0);
    if(material===9&&(dt>0||changed))this.pearls.step(encoder,this.liquid.parity);
    this.keepsakes.step(encoder,chamberDt,frame.pressure??0,frame.gather??0,frame.memoryCount??0,frame.storyScope??'',pose.ax,pose.ay,frame.float??0,!solid);
    this.kick*=Math.exp(-dt*5.);
    this.impulse*=Math.exp(-frame.dt*6.);
    this.device.queue.writeBuffer(this.view,0,new Float32Array([pixels,pixels,frame.time,frame.light?1:0,
      frame.gazeX,frame.gazeY,frame.blink,frame.thinking?1:0,frame.curiosity??0,frame.warmth??0,frame.energy??0,
      frame.tintStrength??0,frame.yaw??0,...(frame.tint??[0,0,0]),(displayMaterial===1?0:frame.lava??0),pose.roll,pose.pitch,cloud,displayMaterial,...this.pointer,fire,frame.wink??0,frame.surprise??0,0,frame.whirl??0,frame.recovery??0,frame.pressure??0,frame.gather??0]));
    this.canvas.dataset.material=String(displayMaterial);
    this.canvas.dataset.gravity=String(this.liquid.params.gravity);
    this.canvas.dataset.whirl=String(frame.whirl??0);
    this.canvas.dataset.recovery=String(frame.recovery??0);
    this.canvas.dataset.pressure=String(frame.pressure??0);
    this.canvas.dataset.memories=String(frame.memoryCount??0);
    this.canvas.dataset.snowSeconds=String(this.snow.physics.time);
    this.canvas.dataset.lava=String(frame.lava??0);this.canvas.dataset.vortex=String(frame.vortex??0);
    this.canvas.dataset.weather=String(cloud);this.canvas.dataset.celebration=String(celebration);
    const pass=encoder.beginRenderPass({colorAttachments:[{view:this.lens.scene.createView(),
      clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});
    pass.setPipeline(this.pipeline);pass.setBindGroup(0,this.group);pass.draw(3);pass.end();
    this.lens.render(encoder,this.context.getCurrentTexture().createView());
    this.device.queue.submit([encoder.finish()]);
    this.canvas.dataset.submissions=String(++this.submissions);
    // Backpressure: decorative work cannot build an unbounded queue beside PTYs.
    await this.device.queue.onSubmittedWorkDone();
    this.frames++;
  }
  /** Used by the isolated GPU verification harness, never by the product loop. */
  async inspectParticles(kind:'position'|'velocity'='position'):Promise<Float32Array> {
    const source=this.liquid.buf[(kind==='position'?'pos':'vel')+(this.liquid.parity===0?'A':'B')];
    const buffer=this.device.createBuffer({size:this.liquid.n*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try {
      const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,buffer,0,this.liquid.n*16);
      this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
      return new Float32Array(buffer.getMappedRange().slice(0));
    } finally {buffer.destroy();}
  }
  async inspectKeepsakes(){
    const buffer=this.device.createBuffer({size:30*32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(this.keepsakes.particles,0,buffer,0,30*32);
      this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);return [...new Float32Array(buffer.getMappedRange().slice(0))];}
    finally{buffer.destroy();}
  }
  inspectGas() { return this.gas.inspectDivergence(); }
  /** Readbacks are only used by isolated verification, never the product loop. */
  async inspectPlay(){
    const read=async(source:GPUBuffer,size:number)=>{
      const buffer=this.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,buffer,0,size);
        this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        return [...new Float32Array(buffer.getMappedRange().slice(0))];}finally{buffer.destroy();}
    };
    // A compact reduction keeps texture readback independent of half-float layout.
    const pipeline=this.device.createComputePipeline({layout:'auto',compute:{entryPoint:'main',module:this.device.createShaderModule({code:`
      @group(0) @binding(0) var field:texture_3d<f32>;
      @group(0) @binding(1) var<storage,read_write> result:array<f32>;
      @compute @workgroup_size(256) fn main(@builtin(global_invocation_id) id:vec3u){
        let i=id.x;if(i>=110592u){return;}let c=vec3i(i32(i)%48,(i32(i)/48)%48,i32(i)/2304);
        result[i]=textureLoad(field,c,0).x;
      }`})}});
    const storage=this.device.createBuffer({size:48**3*4,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    try{
      const encoder=this.device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);
      pass.setBindGroup(0,this.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:this.wakes.texture.createView()},{binding:1,resource:{buffer:storage}}]}));
      pass.dispatchWorkgroups(432);pass.end();this.device.queue.submit([encoder.finish()]);
      const wake=await read(storage,48**3*4);
      return {bubbles:await read(this.bubbles.positions,64*16),gaze:await read(this.bubbles.gaze,32),
        drops:await read(this.weather.positions,176*16),impacts:await read(this.weather.impacts,144*16),
        wax:await read(this.wax.particles,64*32),ripples:await this.ripples.inspect(),wakeTotal:wake.reduce((a,b)=>a+b,0),wakeMax:wake.reduce((a,b)=>Math.max(a,b),0)};
    }finally{storage.destroy();}
  }
  async inspectMaterials(){
    const read=async(source:GPUBuffer,size:number)=>{
      const buffer=this.device.createBuffer({size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
      try{const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(source,0,buffer,0,size);
        this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);return [...new Float32Array(buffer.getMappedRange().slice(0))];}
      finally{buffer.destroy();}
    };
    return {material:this.material,ferro:await this.ferrofluid.inspect(),matter:await read(this.matter.particles,64*32),snow:await read(this.snow.particles,192*32),
      plasma:await read(this.plasma.particles,PLASMA_COUNT*32),pearls:await read(this.pearls.positions,3*16),
      snowfall:this.snow.inspect(),discharge:this.plasma.inspect()};
  }
  async inspectInk(){
    const buffer=this.device.createBuffer({size:64**3*8,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{
      const encoder=this.device.createCommandEncoder();encoder.copyTextureToBuffer({texture:this.ink.texture},
        {buffer,bytesPerRow:512,rowsPerImage:64},[64,64,64]);this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);const half=new Uint16Array(buffer.getMappedRange());
      let amount=0,weightedY=0,peak=0,active=0,invalid=0;
      for(let i=0;i<64**3;i++){
        const bits=half[i*4+3],e=(bits>>10)&31,m=bits&1023;
        const value=(bits&32768?-1:1)*(e===31?Infinity:e===0?m*2**-24:(1+m/1024)*2**(e-15));
        if(!Number.isFinite(value)||value<0)invalid++;
        amount+=value;weightedY+=value*((Math.floor(i/64)%64+.5)/32-1);peak=Math.max(peak,value);if(value>.01)active++;
      }
      return {amount,centerY:weightedY/Math.max(amount,.0001),peak,active,invalid};
    }finally{buffer.destroy();}
  }
  inspectThermal() { return this.gas.thermal.inspect(); }
  async inspectEmbers():Promise<Float32Array> {
    const buffer=this.device.createBuffer({size:32*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    try{
      const encoder=this.device.createCommandEncoder();encoder.copyBufferToBuffer(this.embers.positions,0,buffer,0,32*16);
      this.device.queue.submit([encoder.finish()]);await buffer.mapAsync(GPUMapMode.READ);
      return new Float32Array(buffer.getMappedRange().slice(0));
    }finally{buffer.destroy();}
  }
  destroy() {if(this.disposed)return;this.disposed=true;this.context.unconfigure();this.keepsakes.destroy();this.device.destroy();}
}
