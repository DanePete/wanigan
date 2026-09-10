/** Supplied rain and shell condensation. Inertial droplets follow gas drag and
 * gravity; impacts feed the water force pass. This is not closed mass transfer. */
export class Weather {
  readonly positions:GPUBuffer;
  readonly impacts:GPUBuffer;
  private readonly uniform:GPUBuffer;
  private readonly pipeline:GPUComputePipeline;
  private readonly group:GPUBindGroup;
  private readonly splashes:GPUComputePipeline;
  private readonly splashGroup:GPUBindGroup;
  constructor(private readonly device:GPUDevice,water:GPUTexture,gas:GPUTexture,impacts:GPUBuffer,ripples:GPUTexture){
    this.positions=device.createBuffer({size:176*16,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
    this.impacts=impacts;
    const velocity=device.createBuffer({size:176*16,usage:GPUBufferUsage.STORAGE});
    this.uniform=device.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST});
    const code=`
      @group(0) @binding(0) var<uniform> u:vec4f;
      @group(0) @binding(1) var<storage,read_write> drops:array<vec4f>;
      @group(0) @binding(2) var<storage,read_write> velocities:array<vec4f>;
      @group(0) @binding(3) var water:texture_3d<f32>;
      @group(0) @binding(4) var gas:texture_3d<f32>;
      @group(0) @binding(5) var s:sampler;
      @group(0) @binding(6) var<storage,read_write> impacts:array<vec4f>;
      @group(0) @binding(7) var ripples:texture_2d<f32>;
      fn hash(x:f32)->f32{return fract(sin(x*127.1+18.4)*43758.5453);}
      fn waterDensity(p:vec3f)->f32 {
        let ripple=textureSampleLevel(ripples,s,(p.xz+1.)*.5,0.).x*smoothstep(-.5,-.25,p.y);
        return textureSampleLevel(water,s,(p-vec3f(0.,ripple,0.)+1.)*.5,0.).x;
      }
      @compute @workgroup_size(128) fn main(@builtin(global_invocation_id) id:vec3u){
        let i=id.x;if(i>=176u||(i>=48u&&i<144u)){return;}let dt=u.x;
        var p=drops[i];var v=velocities[i];let seed=f32(i)*1.719;
        if(i>=144u){
          // Shell droplets grow with supplied humidity, drain tangentially and
          // evaporate as the chamber clears. Negative radius marks shell water.
          if(p.w==0.&&u.w>.1){
            let x=(hash(seed)-.5)*1.5;let y=hash(seed+2.)*.9-.05;
            let z=sqrt(max(.02,.986-x*x-y*y));p=vec4f(normalize(vec3f(x,y,z))*.993,-.002);
          }
          if(p.w<0.){
            let radius=clamp(-p.w+dt*(u.w*.0025-(1.-u.w)*.005),0.,.021);
            let n=normalize(p.xyz);let gravity=vec3f(0.,-.08,0.);
            v=vec4f((v.xyz+(gravity-n*dot(gravity,n))*dt*radius*80.)*exp(-dt*3.),0.);
            p=vec4f(normalize(p.xyz+v.xyz*dt)*.993,-radius);
            if(p.y<-.65||radius<.0002){p.w=0.;}
          }
        }else{
          impacts[i].w*=exp(-dt*18.);
          if(p.w<=0.){
            v.w+=dt;
            if(u.z>.1&&v.w>(.18+hash(seed)*1.8)/max(.2,u.z)){
              let x=(hash(seed+floor(u.y)*.07)-.5)*1.15;
              let z=(hash(seed+7.)-.5)*.8;
              p=vec4f(x,.58+hash(seed+2.)*.12,z,.006+hash(seed+8.)*.006);
              v=vec4f(0.,-.05,0.,0.);
            }
          }else{
            let flow=textureSampleLevel(gas,s,(p.xyz+1.)*.5,0.).xyz*2.;
            v=vec4f(v.xyz+(flow-v.xyz)*min(1.,dt*.6)+vec3f(0.,-1.65*dt,0.),0.);
            p=vec4f(p.xyz+v.xyz*dt,p.w);
            if(waterDensity(p.xyz)>.32){
              impacts[i]=vec4f(p.xyz,min(1.,length(v.xyz)));
              p.w=0.;v.w=0.;
            }
            if(length(p.xyz)>.96){p.w=0.;v.w=0.;}
          }
        }
        drops[i]=p;velocities[i]=v;
      }
      @compute @workgroup_size(128) fn splash(@builtin(global_invocation_id) id:vec3u){
        let i=id.x+48u;if(i>=144u){return;}let parent=(i-48u)/2u;let dt=u.x;
        var p=drops[i];var v=velocities[i];impacts[i].w*=exp(-dt*18.);
        if(impacts[parent].w>.8){
          let seed=f32(i)*2.399+floor(u.y)*.173;let angle=hash(seed)*6.283185;
          p=vec4f(impacts[parent].xyz+vec3f(0.,.045,0.),.008+hash(seed+7.)*.007);
          v=vec4f(cos(angle)*.4,.55+hash(seed+3.)*.45,sin(angle)*.4,0.);
        }else if(p.w>0.){
          let flow=textureSampleLevel(gas,s,(p.xyz+1.)*.5,0.).xyz*2.;
          v=vec4f(v.xyz+(flow-v.xyz)*dt*.3+vec3f(0.,-2.4*dt,0.),v.w+dt);
          p=vec4f(p.xyz+v.xyz*dt,p.w);
          if(v.y<0.&&waterDensity(p.xyz)>.28){
            impacts[i]=vec4f(p.xyz,min(.4,length(v.xyz)*.3));p.w=0.;
          }
          if(length(p.xyz)>.97||v.w>2.){p.w=0.;}
        }
        drops[i]=p;velocities[i]=v;
      }`;
    const module=device.createShaderModule({code});
    this.pipeline=device.createComputePipeline({label:'Rain and draining condensation',layout:'auto',compute:{entryPoint:'main',module}});
    this.splashes=device.createComputePipeline({label:'Impact splash droplets',layout:'auto',compute:{entryPoint:'splash',module}});
    const entries:GPUBindGroupEntry[]=[
      {binding:0,resource:{buffer:this.uniform}},{binding:1,resource:{buffer:this.positions}},
      {binding:2,resource:{buffer:velocity}},{binding:3,resource:water.createView()},
      {binding:4,resource:gas.createView()},{binding:5,resource:device.createSampler({minFilter:'linear',magFilter:'linear'})},
      {binding:6,resource:{buffer:this.impacts}},{binding:7,resource:ripples.createView()}];
    this.group=device.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries});
    this.splashGroup=device.createBindGroup({layout:this.splashes.getBindGroupLayout(0),entries});
  }
  step(encoder:GPUCommandEncoder,dt:number,time:number,rain:number,humidity:number){
    this.device.queue.writeBuffer(this.uniform,0,new Float32Array([dt,time,rain,humidity]));
    for(const [pipeline,group,count] of [[this.pipeline,this.group,2],[this.splashes,this.splashGroup,1]] as const){
      const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count);pass.end();
    }
  }
}
