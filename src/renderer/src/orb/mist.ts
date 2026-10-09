/** The mist above the water: 3D flow with limited MacCormack advection and a
 * pressure projection, with the water field as an obstacle. Dye is transported
 * by the velocity, never redrawn as animated noise. The same field carries the
 * rainstorm's cloud and, when something fails, the fire chamber's flame and
 * whirl: Wanigan 1's gas (`gas.ts` there). Every one of those terms is zero at
 * rest, so the idle mist is unchanged. */
const SIZE = 64;

const COMMON = `
const N:f32=${SIZE}.;
struct Params { dt:f32, time:f32, impulse:f32, fire:f32, direction:vec4f, story:vec4f }
@group(0) @binding(0) var<uniform> u:Params;
@group(0) @binding(1) var source:texture_3d<f32>;
@group(0) @binding(2) var destination:texture_storage_3d<rgba16float,write>;
@group(0) @binding(3) var linearSampler:sampler;
@group(0) @binding(4) var water:texture_3d<f32>;
fn open(p:vec3f)->bool {
 return length(p-vec3f(.5)) < .485 && (u.fire>.5 || textureSampleLevel(water,linearSampler,p,0.).x < .35);
}
fn at(c:vec3i)->vec4f {return textureLoad(source,clamp(c,vec3i(0),vec3i(${SIZE - 1})),0);}
`;

const ADVECT = COMMON + `
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let v=textureLoad(source,id,0).xyz;
 textureStore(destination,id,textureSampleLevel(source,linearSampler,clamp(uv-v*u.dt,vec3f(.02),vec3f(.98)),0.));
}`;

// direction: lean, energy, the glass's spin, the cloud. story: whirl, recovery,
// and whether the fire chamber's heat field is live.
const CORRECT = COMMON + `
@group(0) @binding(5) var predicted:texture_3d<f32>;
@group(0) @binding(6) var thermal:texture_3d<f32>;
fn curl(c:vec3i)->vec3f {
 let dx=(at(c+vec3i(1,0,0)).xyz-at(c-vec3i(1,0,0)).xyz)*(N*.5);
 let dy=(at(c+vec3i(0,1,0)).xyz-at(c-vec3i(0,1,0)).xyz)*(N*.5);
 let dz=(at(c+vec3i(0,0,1)).xyz-at(c-vec3i(0,0,1)).xyz)*(N*.5);
 return vec3f(dy.z-dz.y,dz.x-dx.z,dx.y-dy.x);
}
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let v=textureLoad(source,id,0).xyz;
 let previous=clamp(uv-v*u.dt,vec3f(.02),vec3f(.98));
 let reverse=textureSampleLevel(predicted,linearSampler,clamp(uv+v*u.dt,vec3f(.02),vec3f(.98)),0.);
 let forward=textureLoad(predicted,id,0);
 var value=forward+.5*(textureLoad(source,id,0)-reverse);
 // Limit each transported quantity to the departure cell's eight neighbors.
 // This preserves wisps without creating negative dye or new extrema.
 let base=vec3i(floor(previous*N-.5));var lo=vec4f(1e10);var hi=vec4f(-1e10);
 for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
  let sample=at(base+vec3i(x,y,z));lo=min(lo,sample);hi=max(hi,sample);
 }}}
 value=clamp(value,lo,hi);
 // First-order transport damps unresolved velocity modes on this collocated
 // grid; use the higher-order correction only for the visible dye.
 value=vec4f(forward.xyz,value.w);
 value = vec4f(value.xyz * exp(-u.dt*.22), value.w);
 // Buoyancy and a slow submerged-source plume; actual transport follows velocity.
 var heat=vec4f(0.);
 if(u.story.z>.5){heat=textureLoad(thermal,id,0);}
 value.y += u.dt * (value.w*.045+heat.y*.42-heat.z*.03);
 let position=uv-vec3f(.5,.49,.49);
 let emitter=exp(-dot(position,position*vec3f(1.,.45,1.))*850.);
 value.w = min(1.8,value.w*exp(-u.dt*.22)+emitter*u.dt*.7*(1.-u.fire));
 // A supplied cloud deck for the short rainstorm. Dye keeps moving through the
 // same advection and projection after its source switches off.
 if(u.direction.w>0.){
  let cloud=uv-vec3f(.5,.79,.48);
  value.w=min(1.8,value.w+exp(-dot(cloud*vec3f(1.,3.,1.4),cloud*vec3f(1.,3.,1.4))*65.)*u.dt*u.direction.w*3.);
 }
 value = vec4f(value.xyz + u.dt*emitter*vec3f(.055*sin(u.time*.47)+u.impulse*.03,.14,.03*cos(u.time*.37)), value.w);
 // A bounded stirring force excites vortices; projection removes divergence.
 let q=uv-vec3f(.49,.69,.5);
 let vortex=vec3f(-q.y,q.x,.02*sin(u.time*.4))*mix(.5,.14,u.fire)*exp(-dot(q,q)*12.);
 // The fire whirl: radial entrainment, a rotating updraft and a broad return
 // flow. Projection, wall contact and transported fuel shape the flame.
 let story=max(u.story.x,u.story.y*.5);
 if(story>0.){
  let axis=uv-vec3f(.5+.025*sin(u.time*1.7)*u.story.x,.25,.48);
  let r2=dot(axis.xz,axis.xz);let core=exp(-r2*95.);
  let swirl=cross(vec3f(0.,1.,0.),axis)*7.*exp(-r2*16.);
  let funnel=vec3f(-axis.x*.8*core,core*.95-.09,-axis.z*.8*core);
  value=vec4f(value.xyz+u.dt*(swirl+funnel)*story,value.w);
 }
 let c=vec3i(id);let omega=curl(c);
 let eta=vec3f(length(curl(c+vec3i(1,0,0)))-length(curl(c-vec3i(1,0,0))),
   length(curl(c+vec3i(0,1,0)))-length(curl(c-vec3i(0,1,0))),
   length(curl(c+vec3i(0,0,1)))-length(curl(c-vec3i(0,0,1))));
 let confinement=(.0125+min(heat.y,1.)*.013)*cross(eta/max(length(eta),.00001),omega);
 // A bounded divergence-free stirring field seeds flame eddies. An art-directed
 // body force; visible density and heat still come from transport.
 if(heat.y>0.){
  let phase=u.time*2.3;let p=uv*28.;
  let eddies=vec3f(sin(p.y+phase)*cos(p.z-phase*.7),sin(p.z+phase*.8)*cos(p.x-phase),sin(p.x+phase*.7)*cos(p.y+phase));
  value=vec4f(value.xyz+u.dt*eddies*min(heat.y,1.)*.60,value.w);
 }
 value = vec4f(value.xyz + u.dt*(vortex+confinement+vec3f(u.direction.x*.055,u.direction.y*.015,0.)*exp(-dot(q,q)*12.)), value.w);
 // The turning glass drags the mist at the wall.
 let contact=smoothstep(.39,.48,length(uv-.5));
 let wall=cross(vec3f(0.,u.direction.z,0.),uv-.5);
 value=vec4f(value.xyz+(wall-value.xyz)*(1.-exp(-contact*u.dt*1.5)),value.w);
 textureStore(destination,id,value);
}`;

const DIVERGENCE = COMMON + `
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=vec3i(id);let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let d=(at(c+vec3i(1,0,0)).x-at(c-vec3i(1,0,0)).x+
 at(c+vec3i(0,1,0)).y-at(c-vec3i(0,1,0)).y+
 at(c+vec3i(0,0,1)).z-at(c-vec3i(0,0,1)).z)*(N*.5);
 textureStore(destination,id,vec4f(0.,d,0.,0.));
}`;

const PRESSURE = COMMON + `
fn pressure(c:vec3i,center:f32)->f32 {
 let uv=(vec3f(c)+.5)/N; return select(center,at(c).x,open(uv));
}
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=vec3i(id); let current=at(c);
 let sum=pressure(c+vec3i(1,0,0),current.x)+pressure(c-vec3i(1,0,0),current.x)+
 pressure(c+vec3i(0,1,0),current.x)+pressure(c-vec3i(0,1,0),current.x)+
 pressure(c+vec3i(0,0,1),current.x)+pressure(c-vec3i(0,0,1),current.x);
 textureStore(destination,id,vec4f((sum-current.y/(N*N))/6.,current.y,0.,0.));
}`;

const PROJECT = COMMON + `
@group(0) @binding(5) var velocity:texture_3d<f32>;
fn pressure(c:vec3i,center:f32)->f32 {return select(center,at(c).x,open((vec3f(c)+.5)/N));}
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
 let c=vec3i(id); let uv=(vec3f(id)+.5)/N;
 if(!open(uv)){textureStore(destination,id,vec4f(0.));return;}
 let center=at(c).x;
 let gradient=vec3f(pressure(c+vec3i(1,0,0),center)-pressure(c-vec3i(1,0,0),center),
 pressure(c+vec3i(0,1,0),center)-pressure(c-vec3i(0,1,0),center),
 pressure(c+vec3i(0,0,1),center)-pressure(c-vec3i(0,0,1),center))*(N*.5);
 var value=textureLoad(velocity,id,0);value=vec4f(value.xyz-gradient,value.w);
 // No flow through the vessel or the reconstructed water surface.
 for(var axis=0;axis<3;axis++) {
  var offset=vec3f(0.);offset[axis]=sign(value[axis])/N;
  if(!open(uv+offset)){value[axis]=0.;}
 }
 textureStore(destination,id,value);
}`;

const SEED = `
const N:f32=${SIZE}.;
@group(0) @binding(0) var destination:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
  let p=(vec3f(id)+.5)/N-.5;
  // Thin initial mist, subsequently transported entirely by the flow.
  let q=p-vec3f(-.025,.20,-.025);
  var density=exp(-dot(q*vec3f(4.,6.,10.),q*vec3f(4.,6.,10.)))*.35;
  density *= pow(.5+.5*sin(p.x*72.+sin(p.y*51.)*1.5+p.z*60.),3.);
  density*=smoothstep(-.03,.04,p.y)*(1.-smoothstep(.38,.46,p.y));
  if(length(p)>.45){density=0.;}
  let v=vec3f(-q.y*.18,q.x*.18+.018,p.x*.05);
  textureStore(destination,id,vec4f(v,density));
}`;

export type MistForces = {
  impulse: number; lean: number; energy: number; spin: number;
  /** The rainstorm's cloud, 0..1. */
  cloud: number;
  /** The fire chamber: hearth strength (0 for water), whirl and recovery. */
  fire: number; whirl: number; recovery: number;
  /** Whether the heat field is live this frame. A cooled, idle one is never read. */
  heat: boolean;
};

export class Mist {
  /** Velocity in xyz, dye density in w. */
  readonly texture: GPUTexture;
  private readonly device: GPUDevice;
  private readonly uniform: GPUBuffer;
  private readonly passes: { pipeline: GPUComputePipeline; group: GPUBindGroup }[];
  private readonly warm: (heat: GPUTexture) => GPUBindGroup;
  private heated = false;

  constructor(device: GPUDevice, water: GPUTexture) {
    this.device = device;
    const make = (label: string): GPUTexture => device.createTexture({
      label, size: [SIZE, SIZE, SIZE], dimension: '3d', format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
    });
    const compile = (label: string, code: string): GPUComputePipeline => device.createComputePipeline({
      label, layout: 'auto', compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
    this.texture = make('Mist velocity and density');
    const predicted = make('Mist advection predictor'), advected = make('Advected mist');
    const a = make('Mist pressure A'), b = make('Mist pressure B');

    const seed = compile('Mist initial condition', SEED);
    const seedEncoder = device.createCommandEncoder(), seedPass = seedEncoder.beginComputePass();
    seedPass.setPipeline(seed);
    seedPass.setBindGroup(0, device.createBindGroup({ layout: seed.getBindGroupLayout(0), entries: [{ binding: 0, resource: this.texture.createView() }] }));
    seedPass.dispatchWorkgroups(SIZE / 4, SIZE / 4, SIZE / 4);
    seedPass.end();
    device.queue.submit([seedEncoder.finish()]);

    this.uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    // Every pass reads the uniform, because a fire opens the water to the flame.
    // The extra field belongs to correction and projection, heat to correction.
    const bind = (pipeline: GPUComputePipeline, input: GPUTexture, output: GPUTexture, extra?: GPUTexture, heat?: GPUTexture) => {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.uniform } },
        { binding: 1, resource: input.createView() }, { binding: 2, resource: output.createView() },
        { binding: 3, resource: sampler }, { binding: 4, resource: water.createView() },
      ];
      if (extra) entries.push({ binding: 5, resource: extra.createView() });
      if (heat) entries.push({ binding: 6, resource: heat.createView() });
      return { pipeline, group: device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries }) };
    };
    const pressure = compile('Mist pressure Jacobi', PRESSURE);
    const ab = bind(pressure, a, b), ba = bind(pressure, b, a);
    const correct = compile('Mist advection correction', CORRECT);
    this.warm = (heat) => bind(correct, this.texture, advected, predicted, heat).group;
    // Until something fails there is no heat field. This one-voxel stand-in is
    // bound in its place and never read (the shader checks story.z first).
    const cold = device.createTexture({ size: [1, 1, 1], dimension: '3d', format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    this.passes = [
      bind(compile('Mist advection', ADVECT), this.texture, predicted),
      bind(correct, this.texture, advected, predicted, cold),
      bind(compile('Mist divergence', DIVERGENCE), advected, a),
      ...Array.from({ length: 24 }, (_, i) => (i % 2 ? ba : ab)),
      bind(compile('Mist projection', PROJECT), a, this.texture, advected),
    ];
  }

  /** From now on the fire chamber's heat lifts and stirs the flow. */
  heat(field: GPUTexture): void {
    if (this.heated) return;
    this.heated = true;
    const correction = this.passes[1];
    if (correction) correction.group = this.warm(field);
  }

  step(encoder: GPUCommandEncoder, dt: number, time: number, f: MistForces): void {
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      dt, time, f.impulse, f.fire, f.lean, f.energy, Math.max(-6, Math.min(6, f.spin)), f.cloud,
      f.whirl, f.recovery, this.heated && f.heat ? 1 : 0, 0,
    ]));
    for (const { pipeline, group } of this.passes) {
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.dispatchWorkgroups(SIZE / 4, SIZE / 4, SIZE / 4);
      pass.end();
    }
  }
}
