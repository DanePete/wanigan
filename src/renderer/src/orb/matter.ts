/** Cohesive material solver. Jelly has an elastic rest network; honey yields
 * and sticks. These are bounded graphics models, not calibrated rheology. */
const COUNT=64,SIZE=80;
export class Matter {
  readonly texture:GPUTexture;
  readonly particles:GPUBuffer;
  private readonly next:GPUBuffer;
  private readonly rest:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly move:GPUComputePipeline;
  private readonly reconstruct:GPUComputePipeline;
  private readonly moveGroup:GPUBindGroup;
  private readonly fieldGroup:GPUBindGroup;
  private mode=0;
  constructor(private readonly device:GPUDevice){
    const usage=GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST;
    this.particles=device.createBuffer({size:COUNT*32,usage});this.next=device.createBuffer({size:COUNT*32,usage});
    this.rest=device.createBuffer({size:COUNT*16,usage});
    this.uniform=device.createBuffer({size:48,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    this.texture=device.createTexture({label:'Cohesive material density',size:[SIZE,SIZE,SIZE],dimension:'3d',format:'rgba16float',
      usage:GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_SRC});
    const common=`struct Particle { p:vec4f, v:vec4f }
      @group(0) @binding(0) var<uniform> u:array<vec4f,3>;
      @group(0) @binding(1) var<storage,read> particles:array<Particle>;
      @group(0) @binding(2) var<storage,read_write> next:array<Particle>;
      @group(0) @binding(3) var<storage,read> rest:array<vec4f>;`;
    this.move=device.createComputePipeline({label:'Elastic and viscous material forces',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:common+`
      @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
        let i=id.x;let dt=u[0].x;let mode=u[0].y;
        var p=particles[i].p.xyz;var v=particles[i].v.xyz;
        var force=vec3f(u[2].x*.6,u[2].y*.6-1.25,0.);
        // A physical kick is an initial velocity impulse, not a new trajectory.
        force+=vec3f(0.,u[2].z*7.,0.);
        for(var j=0u;j<${COUNT}u;j++){
          if(i==j){continue;}
          let delta=particles[j].p.xyz-p;let d=max(.0001,length(delta));let n=delta/d;
          if(mode==5.){
            let restLength=distance(rest[i].xyz,rest[j].xyz);
            if(restLength<.30){force+=n*((d-restLength)*45.+dot(particles[j].v.xyz-v,n)*1.2);}
          }else if(d<.34){
            let contact=1.-smoothstep(.15,.34,d);
            force+=n*select((d-.15)*8.*contact,(d-.15)*65.,d<.15);
            if(mode==6.){force+=(particles[j].v.xyz-v)*contact*2.8;}

          }
        }
        if(mode==6.){
          let wall=smoothstep(.70,.85,length(p));
          // Near-wall adhesion and viscous drag leave long, slowly draining tails.
          force+=normalize(p+vec3f(0.,.0001,0.))*wall*.8;
          v*=exp(-dt*wall*7.);
        }
        v=(v+force*dt)*exp(-dt*select(.9,1.8,mode==6.));
        v*=min(1.,2./max(length(v),.0001));p+=v*dt;
        let radius=.83;
        if(length(p)>radius){let n=normalize(p);p=n*radius;v-=n*max(0.,dot(v,n))*1.15;v*=.94;}
        next[i].p=vec4f(p,particles[i].p.w);next[i].v=vec4f(v,0.);
      }`})}});
    this.reconstruct=device.createComputePipeline({label:'Smooth material surface',layout:'auto',compute:{entryPoint:'main',module:device.createShaderModule({code:`
      struct Particle { p:vec4f, v:vec4f }
      @group(0) @binding(0) var<storage,read> particles:array<Particle>;
      @group(0) @binding(1) var field:texture_storage_3d<rgba16float,write>;
      @compute @workgroup_size(4,4,4) fn main(@builtin(global_invocation_id) id:vec3u){
        let p=(vec3f(id)+.5)/${SIZE}.*2.-1.;var density=0.;var shade=0.;
        for(var i=0u;i<${COUNT}u;i++){
          let delta=p-particles[i].p.xyz;
          let q=max(0.,1.-dot(delta,delta)/.055225);
          let w=q*q*q;density+=w;shade+=w*particles[i].p.w;
        }
        textureStore(field,id,vec4f(density,shade/max(density,.0001),0.,0.));
      }`})}});
    this.moveGroup=device.createBindGroup({layout:this.move.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.particles}},
      {binding:2,resource:{buffer:this.next}},{binding:3,resource:{buffer:this.rest}}]});
    this.fieldGroup=device.createBindGroup({layout:this.reconstruct.getBindGroupLayout(0),entries:[
      {binding:0,resource:{buffer:this.particles}},{binding:1,resource:this.texture.createView()}]});
  }
  step(encoder:GPUCommandEncoder,dt:number,mode:number,ax:number,ay:number,kick:number){
    if(this.mode!==mode){
      const p=new Float32Array(COUNT*8),rest=new Float32Array(COUNT*4);
      for(let i=0;i<COUNT;i++){
        const xyz=[(i%4-1.5)*.155,Math.floor(i/16)*.155-.40,(Math.floor(i/4)%4-1.5)*.155];
        if(mode===5||mode===6){
          const local=[xyz[0],xyz[1]+.1675,xyz[2]],length=Math.hypot(...local),radius=Math.max(...local.map(Math.abs));
          for(let axis=0;axis<3;axis++)xyz[axis]=local[axis]*radius/Math.max(length,.0001)*(mode===5?1.4:1.2);
          xyz[1]-=.22;
        }
        p.set([...xyz,i/COUNT,0,0,0,0],i*8);rest.set([...xyz,0],i*4);
      }
      this.device.queue.writeBuffer(this.particles,0,p);this.device.queue.writeBuffer(this.rest,0,rest);this.mode=mode;
    }
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([Math.min(dt,1/30)/4,mode,0,0,0,0,0,0,ax,ay,kick,0]));
    for(let i=0;i<4;i++){
      const pass=encoder.beginComputePass();pass.setPipeline(this.move);pass.setBindGroup(0,this.moveGroup);pass.dispatchWorkgroups(1);pass.end();
      encoder.copyBufferToBuffer(this.next,0,this.particles,0,COUNT*32);
    }
    const pass=encoder.beginComputePass();pass.setPipeline(this.reconstruct);pass.setBindGroup(0,this.fieldGroup);pass.dispatchWorkgroups(SIZE/4,SIZE/4,SIZE/4);pass.end();
  }
}
