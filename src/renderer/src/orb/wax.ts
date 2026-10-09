/** The lava lamp: reduced wax dynamics. Cohesive particles carry heat; a heater
 * at the floor warms them, height cools them, and buoyancy follows temperature,
 * so blobs rise hot, stretch, cool, sink and join again. Reconstructed as a
 * smooth density and temperature field. Not a multiphase solver. A port of
 * Wanigan 1's `wax.ts`; the equations are unchanged. */
const COUNT = 64;
const SIZE = 48;

const COMMON = `
struct Particle { p:vec4f, v:vec4f }
@group(0) @binding(0) var<uniform> u:array<vec4f,2>;
@group(0) @binding(1) var<storage,read> particles:array<Particle>;
`;

const MOVE = COMMON + `
@group(0) @binding(2) var<storage,read_write> next:array<Particle>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  let i=id.x;if(i>=${COUNT}u){return;}let dt=u[0].x;
  var p=particles[i].p.xyz;var heat=particles[i].p.w;var v=particles[i].v.xyz;
  // Local heating below, cooling above. Heat is persistent and diffuses
  // through neighboring wax rather than prescribing particle trajectories.
  let heater=.25+.75*exp(-((p.x+.36)*(p.x+.36)*14.+p.z*p.z*6.));
  heat+=dt*((1.-smoothstep(-.65,-.3,p.y))*(1.-heat)*heater*1.5-(.025+smoothstep(.0,.65,p.y)*.55)*heat);
  var force=vec3f(u[1].xy*.13,0.);var exchange=0.;var neighbors=0.;
  for(var j=0u;j<${COUNT}u;j++){
    if(i==j){continue;}let delta=particles[j].p.xyz-p;let d=length(delta);
    if(d<.34&&d>.00001){
      // Four cohesive parcels exchange heat and repel on contact. Weak
      // adhesion between parcels lets a shared neck detach as they heat
      // differently, instead of collapsing all wax into one rigid ball.
      let parcelI=select(i/12u,4u+(i-48u)/4u,i>=48u);let parcelJ=select(j/12u,4u+(j-48u)/4u,j>=48u);
      let adhesion=select(.25,1.2,parcelI==parcelJ)*(1.-heat*.32);
      let magnitude=select((d-.13)*adhesion*(1.-smoothstep(.22,.34,d)),(d-.13)*18.,d<.13);
      force+=delta/d*magnitude;
      exchange+=(particles[j].p.w-heat)*(1.-d/.34);neighbors+=1.;
    }
  }
  heat=clamp(heat+exchange*dt*.25/max(1.,neighbors),0.,1.);
  force.y+=(heat-.37)*2.2+u[1].z*2.;
  v=(v+force*dt)*exp(-dt*.65);v*=min(1.,.8/max(length(v),.00001));p+=v*dt;
  if(length(p)>.80){let n=normalize(p);p=n*.80;v-=n*max(0.,dot(v,n))*1.35;}
  next[i].p=vec4f(p,heat);next[i].v=vec4f(v,0.);
}`;

const FIELD = COMMON + `
@group(0) @binding(2) var field:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
  let p=(vec3f(id)+.5)/${SIZE}.*2.-1.;var density=0.;var heat=0.;
  for(var i=0u;i<${COUNT}u;i++){
    let delta=p-particles[i].p.xyz;let q=max(0.,1.-dot(delta,delta)/select(.0676,.0361,i>=48u));
    let weight=q*q*q;density+=weight;heat+=weight*particles[i].p.w;
  }
  textureStore(field,id,vec4f(density,heat/max(density,.0001),0.,0.));
}`;

export class Wax {
  /** Density in x, temperature 0..1 in y. */
  readonly texture: GPUTexture;
  private readonly device: GPUDevice;
  private readonly particles: GPUBuffer;
  private readonly next: GPUBuffer;
  private readonly uniform: GPUBuffer;
  private readonly move: { pipeline: GPUComputePipeline; group: GPUBindGroup };
  private readonly field: { pipeline: GPUComputePipeline; group: GPUBindGroup };

  constructor(device: GPUDevice) {
    this.device = device;
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.particles = device.createBuffer({ size: COUNT * 32, usage });
    this.next = device.createBuffer({ size: COUNT * 32, usage });
    // 48 large particles in four parcels of 12 and 16 small ones in four of 4,
    // seeded cool at the bottom of the lamp.
    const initial = new Float32Array(COUNT * 8);
    for (let i = 0; i < COUNT; i++) {
      const small = i >= 48, cluster = small ? Math.floor((i - 48) / 4) : Math.floor(i / 12), angle = i * 2.399;
      const ring = (small ? 0.022 : 0.045) * Math.sqrt(i % (small ? 4 : 12));
      initial.set([Math.cos(cluster * 1.9) * 0.48 + Math.cos(angle) * ring, -0.67 + (i % 3) * 0.065,
        Math.sin(cluster * 1.9) * 0.4 + Math.sin(angle) * ring, small ? 0.65 : 0.18 + cluster * 0.16, 0, 0, 0, 0], i * 8);
    }
    device.queue.writeBuffer(this.particles, 0, initial);
    this.uniform = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.texture = device.createTexture({ label: 'Wax density and temperature', size: [SIZE, SIZE, SIZE], dimension: '3d',
      format: 'rgba16float', usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING });
    const compile = (label: string, code: string): GPUComputePipeline => device.createComputePipeline({
      label, layout: 'auto', compute: { entryPoint: 'main', module: device.createShaderModule({ label, code }) },
    });
    const move = compile('Heated cohesive wax', MOVE), field = compile('Wax surface reconstruction', FIELD);
    this.move = { pipeline: move, group: device.createBindGroup({ layout: move.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.particles } },
      { binding: 2, resource: { buffer: this.next } },
    ] }) };
    this.field = { pipeline: field, group: device.createBindGroup({ layout: field.getBindGroupLayout(0), entries: [
      { binding: 1, resource: { buffer: this.particles } }, { binding: 2, resource: this.texture.createView() },
    ] }) };
    // Build the field once, so a still frame drawn with motion off has wax in it.
    const encoder = device.createCommandEncoder();
    this.reconstruct(encoder);
    device.queue.submit([encoder.finish()]);
  }

  /** `ax`, `ay` tilt the lamp; `kick` (a shake or splash) is a buoyant surge. */
  step(encoder: GPUCommandEncoder, dt: number, ax: number, ay: number, kick: number): void {
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([dt, 0, 0, 0, ax, ay, kick, 0]));
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.move.pipeline);
    pass.setBindGroup(0, this.move.group);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(this.next, 0, this.particles, 0, COUNT * 32);
    this.reconstruct(encoder);
  }

  private reconstruct(encoder: GPUCommandEncoder): void {
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.field.pipeline);
    pass.setBindGroup(0, this.field.group);
    pass.dispatchWorkgroups(SIZE / 4, SIZE / 4, SIZE / 4);
    pass.end();
  }
}
