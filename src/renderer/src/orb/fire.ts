/** The fire chamber that a failure turns the globe into for a few seconds:
 * supplied, incompressible flame (transported fuel, excess heat and soot) and
 * the embers it throws. Temperature is a normalized proxy, not degrees. No
 * oxygen, expansion or heat feedback into the water is implied. A port of
 * Wanigan 1's `thermal.ts` and `embers.ts`; the equations are unchanged.
 *
 * It is made the first time something fails, not before: a quiet orb never
 * pays for a fire it has not had. */
const SIZE = 64;
export const EMBERS = 32;

const REACTION = `
fn react(input:vec4f,dt:f32)->vec4f {
 var q=max(input,vec4f(0.));
 let ignition=smoothstep(.12,.22,q.y);
 let burned=q.x*(1.-exp(-5.*ignition*dt));
 q.x=(q.x-burned)*exp(-.3*dt);
 q.y=min(2.4,(q.y+1.6*burned)*exp(-.9*dt));
 q.z=min(1.5,(q.z+.20*burned)*exp(-.5*dt));
 q.w=burned/max(dt,.00001);
 return q;
}`;

const COMMON = `
struct Params { dt:f32, time:f32, source:f32, energy:f32, direction:vec4f }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var source:texture_3d<f32>;
@group(0) @binding(2) var destination:texture_storage_3d<rgba16float,write>;
@group(0) @binding(3) var smoothSampler:sampler;
@group(0) @binding(4) var water:texture_3d<f32>;
@group(0) @binding(5) var velocity:texture_3d<f32>;
fn open(p:vec3f)->bool {
 return length(p-.5)<.485 && (u.source>.5 || textureSampleLevel(water,smoothSampler,p,0.).x<.35);
}
`;

const TRANSPORT = COMMON + `
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
  let uv=(vec3f(id)+.5)/${SIZE}.;
  if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
  let v=textureLoad(velocity,id,0).xyz;
  textureStore(destination,id,textureSampleLevel(source,smoothSampler,clamp(uv-v*u.dt,vec3f(.02),vec3f(.98)),0.));
}`;

const BURN = COMMON + REACTION + `
@group(0) @binding(6) var predicted:texture_3d<f32>;
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
  let uv=(vec3f(id)+.5)/${SIZE}.;
  if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
  let v=textureLoad(velocity,id,0).xyz;
  let previous=clamp(uv-v*u.dt,vec3f(.02),vec3f(.98));
  let reverse=textureSampleLevel(predicted,smoothSampler,clamp(uv+v*u.dt,vec3f(.02),vec3f(.98)),0.);
  var q=textureLoad(predicted,id,0)+.5*(textureLoad(source,id,0)-reverse);
  let base=vec3i(floor(previous*${SIZE}.-.5));var lo=vec4f(1e10);var hi=vec4f(-1e10);
  for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let value=textureLoad(source,clamp(base+vec3i(x,y,z),vec3i(0),vec3i(${SIZE - 1})),0);
    lo=min(lo,value);hi=max(hi,value);
  }}}
  q=clamp(q,lo,hi);
  // A broad, supplied hearth behind the eyes. Its material persists when
  // the supply stops; nothing is reseeded when a request or theme changes.
  let center=vec3f(.5+u.direction.x*.025,.23,.48);
  let p=(uv-center)/vec3f(.13,.055,.14);
  let left=(uv-center-vec3f(-.19,0.,.025))/vec3f(.10,.045,.12);
  let right=(uv-center-vec3f(.19,0.,-.015))/vec3f(.10,.045,.12);
  // Three supplied roots span the hearth, so the side plumes have enough
  // local heat to ignite in the moving flow.
  let hearth=min(1.,exp(-dot(p,p)*2.)+.9*exp(-dot(left,left)*2.)+.9*exp(-dot(right,right)*2.))*u.source;
  // A whirl draws the roots into one column.
  let column=(uv-vec3f(.5,.23,.48))/vec3f(.12,.065,.12);
  let emitter=mix(hearth,exp(-dot(column,column)*1.6)*u.source*1.7,u.direction.y);
  let supply=.60+.40*sin(u.time*3.+uv.x*29.+uv.z*19.);
  q.x+=emitter*supply*u.dt*5.5;q.y+=emitter*supply*u.dt*3.;
  textureStore(destination,id,react(q,u.dt));
}`;

const PUBLISH = `
@group(0) @binding(0) var inputField:texture_3d<f32>;
@group(0) @binding(1) var outputField:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){textureStore(outputField,id,textureLoad(inputField,id,0));}`;

// One-way hot tracers: gas drag, inertia, gravity, cooling and water contact.
const EMBER = `
@group(0) @binding(0) var<uniform> u:vec4f;
@group(0) @binding(1) var flow:texture_3d<f32>;
@group(0) @binding(2) var water:texture_3d<f32>;
@group(0) @binding(3) var thermal:texture_3d<f32>;
@group(0) @binding(4) var smoothSampler:sampler;
@group(0) @binding(5) var<storage,read_write> positions:array<vec4f>;
@group(0) @binding(6) var<storage,read_write> velocities:array<vec4f>;
fn hash(s:f32)->f32{return fract(sin(s*127.1+31.7)*43758.5453);}
@compute @workgroup_size(${EMBERS}) fn main(@builtin(global_invocation_id) id:vec3u){
 let i=id.x;var p=positions[i];var v=velocities[i];
 let lifetime=1.6+hash(f32(i)+17.)*2.;
 // Stagger emission. Dead particles wait without fabricated glowing motion.
 if(p.w==0. && v.w==0.){v.w=-hash(f32(i)+1.)*2.-.01;}
 v.w+=u.x;
 if(p.w<=.025 || v.w>lifetime){
  p.w=0.;
  if(v.w>0. && u.z>.05){
   let seed=f32(i)*1.71+floor(u.y)*.13;
   let center=vec3f((hash(seed)-.5)*.65,-.49,-.04+(hash(seed+9.)-.5)*.20);
   let heat=textureSampleLevel(thermal,smoothSampler,(center+1.)*.5,0.).y;
   if(heat>.18){p=vec4f(center,min(1.8,heat));v=vec4f((hash(seed+8.)-.5)*.07,.16+hash(seed+4.)*.1,0.,0.);}
  }
 }else{
  let uv=(p.xyz+1.)*.5;
  let gas=textureSampleLevel(flow,smoothSampler,uv,0.).xyz*2.;
  let velocity=v.xyz+(gas-v.xyz)*(1.-exp(-3.*u.x))+vec3f(0.,-.12*u.x,0.);
  v=vec4f(velocity,v.w);p=vec4f(p.xyz+v.xyz*u.x,p.w*exp(-.72*u.x));
  if(length(p.xyz)>.965){
   let n=normalize(p.xyz);p=vec4f(n*.965,p.w);
   v=vec4f(v.xyz-n*max(0.,dot(v.xyz,n))*1.25,v.w);
  }
  if(u.z<.5&&textureSampleLevel(water,smoothSampler,(p.xyz+1.)*.5,0.).x>.32){p.w=0.;v.w=-.4;}
 }
 positions[i]=p;velocities[i]=v;
}`;

type Pass = { pipeline: GPUComputePipeline; group: GPUBindGroup; groups: [number, number, number] };

export class Fire {
  /** Fuel, heat, soot and the burn rate, per voxel. */
  readonly heat: GPUTexture;
  /** xyz and glow per ember; a glow of zero is an empty slot. */
  readonly embers: GPUBuffer;
  private readonly device: GPUDevice;
  private readonly uniform: GPUBuffer;
  private readonly emberUniform: GPUBuffer;
  private readonly passes: Pass[];
  private readonly emberPass: Pass;

  /** `flow` is the mist's velocity field, which carries the flame. */
  constructor(device: GPUDevice, water: GPUTexture, flow: GPUTexture) {
    this.device = device;
    const make = (label: string): GPUTexture => device.createTexture({ label, size: [SIZE, SIZE, SIZE], dimension: '3d',
      format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING });
    this.heat = make('Fuel, heat, soot and reaction');
    const predicted = make('Thermal advection predictor'), corrected = make('Thermal transport and reaction');
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const compile = (label: string, code: string): GPUComputePipeline => device.createComputePipeline({
      label, layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ label, code }) },
    });
    const volume: [number, number, number] = [SIZE / 4, SIZE / 4, SIZE / 4];
    const transport = compile('Thermal transport', TRANSPORT), burn = compile('Thermal correction and burning', BURN);
    const publish = compile('Publish thermal field', PUBLISH);
    const shared = (output: GPUTexture): GPUBindGroupEntry[] => [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: this.heat.createView() },
      { binding: 2, resource: output.createView() }, { binding: 3, resource: sampler },
      { binding: 4, resource: water.createView() }, { binding: 5, resource: flow.createView() },
    ];
    this.passes = [
      { pipeline: transport, groups: volume, group: device.createBindGroup({ layout: transport.getBindGroupLayout(0), entries: shared(predicted) }) },
      { pipeline: burn, groups: volume, group: device.createBindGroup({ layout: burn.getBindGroupLayout(0), entries: [
        ...shared(corrected), { binding: 6, resource: predicted.createView() }] }) },
      // A compute copy keeps the published texture's bindings stable for the mist and the optics.
      { pipeline: publish, groups: volume, group: device.createBindGroup({ layout: publish.getBindGroupLayout(0), entries: [
        { binding: 0, resource: corrected.createView() }, { binding: 1, resource: this.heat.createView() }] }) },
    ];
    this.embers = device.createBuffer({ size: EMBERS * 16, usage: GPUBufferUsage.STORAGE });
    const velocities = device.createBuffer({ size: EMBERS * 16, usage: GPUBufferUsage.STORAGE });
    this.emberUniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const ember = compile('Inertial cooling embers', EMBER);
    this.emberPass = { pipeline: ember, groups: [1, 1, 1], group: device.createBindGroup({ layout: ember.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.emberUniform } }, { binding: 1, resource: flow.createView() },
      { binding: 2, resource: water.createView() }, { binding: 3, resource: this.heat.createView() },
      { binding: 4, resource: sampler }, { binding: 5, resource: { buffer: this.embers } },
      { binding: 6, resource: { buffer: velocities } },
    ] }) };
  }

  /** `source` is how hard the hearth burns (0 lets it die down); `whirl` draws
   * it into a column; `lean` shifts it with his posture. */
  step(encoder: GPUCommandEncoder, dt: number, time: number, source: number, energy: number, lean: number, whirl: number): void {
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([dt, time, source, energy, lean, whirl, 0, 0]));
    this.device.queue.writeBuffer(this.emberUniform, 0, new Float32Array([dt, time, source, 0]));
    for (const { pipeline, group, groups } of [...this.passes, this.emberPass]) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(...groups);
      pass.end();
    }
  }
}
