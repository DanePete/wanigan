import { BUBBLES, RESTING_BUBBLES } from './bubbles';
import { EMBERS } from './fire';
import { DROPS, IMPACTS } from './weather';

/** Floats in the View uniform (128 bytes). The first 17 are Wanigan 2's water
 * port unchanged; the rest carry Wanigan 1's play and story terms, each zero
 * at rest so the idle water draws exactly as before. */
export const VIEW_FLOATS = 32;

/** One full-screen pass that ray-traces a refracting glass shell around the
 * simulated water. The eyes are analytic geometry inside the shell; both the
 * water and the glass bend the camera ray on its way to them and to the room.
 * The same march draws the lava lamp's wax, the fire chamber a failure turns
 * the globe into, the rainstorm and ink. Writes premultiplied HDR radiance for
 * the lens. A port of Wanigan 1's `optics.ts`, without the other materials.
 *
 * It compiles twice. With the PLAY override false every play term is dead code
 * and the resting water costs what it did before any of them existed; the
 * runtime switches to the full pipeline only while something is on show. */
export const OPTICS = `
override PLAY:bool=true;
struct View { size:vec2f, light:f32, blink:f32, gaze:vec2f, curiosity:f32, warmth:f32,
 tint:vec3f, tintStrength:f32, yaw:f32, roll:f32, pitch:f32, wink:f32, surprise:f32,
 time:f32, lava:f32, cloud:f32, chamber:f32, fire:f32, whirl:f32, recovery:f32, ink:f32, weather:f32 }
@group(0) @binding(0) var<uniform> u:View;
@group(0) @binding(1) var liquid:texture_3d<f32>;
@group(0) @binding(2) var mist:texture_3d<f32>;
@group(0) @binding(3) var smoothSampler:sampler;
@group(0) @binding(4) var environment:texture_2d<f32>;
@group(0) @binding(5) var<storage,read> bubbles:array<vec4f>;
@group(0) @binding(6) var room:texture_2d<f32>;
@group(0) @binding(7) var wakes:texture_3d<f32>;
@group(0) @binding(8) var<storage,read> bubbleGaze:array<vec4f>;
@group(0) @binding(9) var thermal:texture_3d<f32>;
@group(0) @binding(10) var<storage,read> embers:array<vec4f>;
@group(0) @binding(11) var wax:texture_3d<f32>;
@group(0) @binding(12) var<storage,read> drops:array<vec4f>;
@group(0) @binding(13) var rippleField:texture_2d<f32>;
@group(0) @binding(14) var ink:texture_3d<f32>;
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
 let p=array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.));return vec4f(p[i],0.,1.);
}
fn sphere(o:vec3f,d:vec3f,r:f32)->vec2f {
 let b=dot(o,d);let c=dot(o,o)-r*r;let h=b*b-c;
 if(h<0.){return vec2f(-1.);}let s=sqrt(h);return vec2f(-b-s,-b+s);
}
fn rect(p:vec2f, halfSize:vec2f, edge:f32)->f32 {
 return (1.-smoothstep(halfSize.x-edge,halfSize.x+edge,abs(p.x)))*
 (1.-smoothstep(halfSize.y-edge,halfSize.y+edge,abs(p.y)));
}
// The fire chamber hides the water while it burns; the water is kept, not lost.
fn dry()->bool {return PLAY && u.chamber>.5;}
fn studio(o:vec3f,d:vec3f)->vec3f {
 // A real ray/plane environment: large area lights, the room and a desk.
 // Position-dependent parallax lets refraction reveal the room behind the vessel.
 var result=mix(vec3f(.012,.019,.027),vec3f(.34,.37,.40),u.light);
 let backT=(-5.-o.z)/d.z;
 if(backT>0.){
  let p=(o+d*backT).xy;
  let uv=clamp(vec2f(.31+p.x*.052,.53-p.y*.075),vec2f(0.),vec2f(1.));
  let back=textureSampleLevel(room,smoothSampler,uv,0.).rgb;
  result=mix(back*.90+vec3f(.010,.017,.025),back*.32+vec3f(.19,.22,.25),u.light);
 }
 let floorT=(-1.22-o.y)/d.y;
 if(floorT>0. && (backT<0. || floorT<backT) && !dry()){
  let p=o+d*floorT;
  let grain=.0015*sin(p.x*145.+sin(p.z*22.)*2.)+.0015*sin(p.x*45.+p.z*52.);
  let floorColor=mix(vec3f(.065,.10,.145),vec3f(.28,.31,.35),u.light);
  result=floorColor+grain+vec3f(.025,.033,.042)*exp(-dot(p.xz,p.xz)*.055);
 }
 // Large studio softboxes. Sharp outlines and broad interiors define real glass.
 if(d.z>.01){
  let p=o+d*((4.-o.z)/d.z);
  result+=vec3f(3.4,3.6,3.8)*rect(p.xy-vec2f(-4.8,3.),vec2f(.22,2.4),.04);
  result+=vec3f(3.,2.8,2.5)*rect(p.xy-vec2f(4.7,.1),vec2f(.10,2.25),.04);
  result+=vec3f(1.2)*rect(p.xy-vec2f(.0,4.2),vec2f(2.2,.15),.07);
 }
 return result;
}
fn lighting(o:vec3f,d:vec3f)->vec3f {
 let rotated=vec3f(d.x,d.y*.866-d.z*.5,d.y*.5+d.z*.866);
 let uv=vec2f(fract(atan2(rotated.z,rotated.x)/6.283185+.62),acos(clamp(rotated.y,-1.,1.))/3.14159265);
 let captured=textureSampleLevel(environment,smoothSampler,uv,0.).rgb;
 return captured*.45 + studio(o,d)*.85;
}
fn rho(p:vec3f)->f32 {
 if(!PLAY){return textureSampleLevel(liquid,smoothSampler,clamp((p+1.)*.5,vec3f(0.),vec3f(1.)),0.).x;}
 if(dry()){return 0.;}
 var q=p;
 // Rain rings the surface: a height field displaces the reconstructed water.
 if(u.weather>0.){q.y-=textureSampleLevel(rippleField,smoothSampler,(p.xz+1.)*.5,0.).x*smoothstep(-.5,-.25,p.y);}
 // The lava lamp's wax replaces the water as it fades in.
 return textureSampleLevel(liquid,smoothSampler,clamp((q+1.)*.5,vec3f(0.),vec3f(1.)),0.).x*(1.-u.lava);
}
fn gradient(p:vec3f)->vec3f {
 let h=.032;
 return normalize(vec3f(rho(p-vec3f(h,0,0))-rho(p+vec3f(h,0,0)),
 rho(p-vec3f(0,h,0))-rho(p+vec3f(0,h,0)),rho(p-vec3f(0,0,h))-rho(p+vec3f(0,0,h)))+vec3f(0.,1e-7,0.));
}
fn fresnel(cosine:f32, n1:f32,n2:f32)->f32 {
 let f=(n1-n2)/(n1+n2);return f*f+(1.-f*f)*pow(1.-clamp(cosine,0.,1.),5.);
}
fn rotateY(p:vec3f,angle:f32)->vec3f {let c=cos(angle);let s=sin(angle);return vec3f(c*p.x+s*p.z,p.y,-s*p.x+c*p.z);}
fn handled(p:vec3f)->vec3f {
 let c=cos(-u.roll);let s=sin(-u.roll);let q=vec3f(c*p.x-s*p.y,s*p.x+c*p.y,p.z);
 let cx=cos(-u.pitch);let sx=sin(-u.pitch);return vec3f(q.x,cx*q.y-sx*q.z,sx*q.y+cx*q.z);
}
fn eyes(origin:vec3f,direction:vec3f)->vec4f {
 let o=rotateY(handled(origin),-u.yaw);let d=rotateY(handled(direction),-u.yaw);
 let gaze=mix(u.gaze,bubbleGaze[0].xy,bubbleGaze[0].z);
 var nearest=100.;var color=vec3f(0.);
 for(var i=0;i<2;i++){
  let side=f32(i)*2.-1.;
  let faceX=side*.18+gaze.x*.085;let faceY=.12+gaze.y*.065+side*u.curiosity*.012;
  let center=vec3f(faceX,faceY,.80);
  let wink=select(0.,u.wink,i==1);
  let aperture=u.blink*(1.-wink*.96)*(1.+side*u.curiosity*.14-u.warmth*.25+u.surprise*.45);
  let scale=vec3f(.037+u.warmth*.006+u.surprise*.004,max(.003,.051*aperture),.028);
  let ro=(o-center)/scale;let rd=d/scale;
  let a=dot(rd,rd);let b=dot(ro,rd);let c=dot(ro,ro)-1.;let h=b*b-a*c;
  if(h>=0.){
   let t=(-b-sqrt(h))/a;
   if(t>0. && t<nearest){
    nearest=t;let n=normalize((o+d*t-center)/(scale*scale));
    let refl=lighting(rotateY(o+d*t,u.yaw),rotateY(reflect(d,n),u.yaw));
    color=vec3f(.003,.005,.008)+refl*.19;
   }
  }
 }
 return vec4f(color,nearest);
}
// Blackbody-inspired display palette. The simulation temperature is normalized;
// these artist-selected linear RGB knots are not a calibrated Kelvin spectrum.
// A recovery mixes the flame to blue.
fn fireColor(heat:f32)->vec3f {
 let warm=mix(vec3f(1.,.035,.001),vec3f(1.,.27,.018),smoothstep(.12,.75,heat));
 let gold=mix(warm,vec3f(1.,.78,.36),smoothstep(.75,1.8,heat));
 return mix(gold,vec3f(.035,.45,2.4)+vec3f(.35,.6,.8)*smoothstep(.6,1.8,heat),u.recovery);
}
fn sparks(o:vec3f,d:vec3f)->vec4f {
 var result=vec4f(0.,0.,0.,100.);if(!dry()){return result;}
 for(var i=0;i<${EMBERS};i++){
  let e=embers[i];if(e.w<.04){continue;}
  let hit=sphere(o-e.xyz,d,.0035+f32(i%4)*.0015);
  if(hit.x>.001 && hit.x<result.w){result=vec4f(fireColor(e.w)*e.w*5.,hit.x);}
 }
 return result;
}
fn airBubbles(o:vec3f,d:vec3f)->vec4f {
 var result=vec4f(0.,0.,0.,100.);
 if(dry()){return result;}
 // At rest only the first half rise; the rest wait for a burst.
 for(var i=0;i<select(${RESTING_BUBBLES},${BUBBLES},PLAY);i++){
  let b=bubbles[i];if(b.w<=0.){continue;}
  let hit=sphere(o-b.xyz,d,b.w);
  if(hit.x>.002 && hit.x<result.w){
   let p=o+d*hit.x;let n=normalize(p-b.xyz);
   let f=fresnel(-dot(d,n),1.333,1.);
   let glint=lighting(p,reflect(d,n))*f;
   result=vec4f(glint,hit.x);
  }
 }
 return result;
}
fn raindrops(o:vec3f,d:vec3f)->vec4f {
 var result=vec4f(0.,0.,0.,100.);if(dry()||u.weather<=0.){return result;}
 for(var i=0;i<${IMPACTS};i++){
  let drop=drops[i];if(drop.w<=0.){continue;}
  let scale=vec3f(drop.w,drop.w*select(1.1,2.2,i<48),drop.w);
  let ro=(o-drop.xyz)/scale;let rd=d/scale;
  let a=dot(rd,rd);let b=dot(ro,rd);let h=b*b-a*(dot(ro,ro)-1.);
  if(h>0.){
   let t=(-b-sqrt(h))/a;
   if(t>0.&&t<result.w){
    let p=o+d*t;let n=normalize((p-drop.xyz)/(scale*scale));
    let f=fresnel(-dot(d,n),1.,1.333);
    result=vec4f(lighting(p,reflect(d,n))*f+studio(p,refract(d,n,1./1.333))*.45+vec3f(.015,.025,.03),t);
   }
  }
 }
 return result;
}
fn waxAt(p:vec3f)->vec2f{return textureSampleLevel(wax,smoothSampler,(p+1.)*.5,0.).xy;}
fn waxNormal(p:vec3f)->vec3f {
 let h=.035;
 return normalize(vec3f(waxAt(p-vec3f(h,0,0)).x-waxAt(p+vec3f(h,0,0)).x,
 waxAt(p-vec3f(0,h,0)).x-waxAt(p+vec3f(0,h,0)).x,
 waxAt(p-vec3f(0,0,h)).x-waxAt(p+vec3f(0,0,h)).x)+vec3f(0.,.00001,0.));
}
fn exitGlass(p:vec3f,d:vec3f,inWater:bool)->vec3f {
 let n=-normalize(p);let eta=select(1.,1.333,inWater)/1.46;
 let shellRay=refract(d,n,eta);
 if(dot(shellRay,shellRay)<.01){return studio(p,reflect(d,n));}
 let outPoint=p+shellRay*sphere(p,shellRay,1.015).y;
 let outRay=refract(shellRay,-normalize(outPoint),1.46);
 if(dot(outRay,outRay)<.01){return studio(outPoint,reflect(shellRay,-normalize(outPoint)));}
 return studio(outPoint,outRay);
}
fn display(color:vec3f,coverage:f32)->vec4f {
 return vec4f(max(color,vec3f(0.))*coverage,coverage);
}
@fragment fn fs(@builtin(position) pixel:vec4f)->@location(0) vec4f {
 let uv=(pixel.xy/u.size-.5)*vec2f(2.5,-2.5);
 let origin=vec3f(0.,.22,4.6);
 let forward=normalize(-origin);let right=vec3f(1.,0.,0.);let up=cross(right,forward);
 let direction=normalize(forward*4.6+right*uv.x+up*uv.y);
 let edgeDistance=1.015-length(cross(origin,direction));
 let coverage=clamp(edgeDistance/max(fwidth(edgeDistance),.0001)+.5,0.,1.);
 let hit=sphere(origin,direction,1.015);
 if(hit.x<0.){return vec4f(0.);}
 let surface=origin+direction*hit.x;let normal=normalize(surface);
 let reflection=lighting(surface,reflect(direction,normal));
 let glassF=fresnel(-dot(direction,normal),1.,1.46);
 var ray=refract(direction,normal,1./1.46);
 let innerHit=sphere(surface,ray,1.);
 if(innerHit.x<0.){return display(reflection,coverage);}
 var position=surface+ray*innerHit.x;
 var inWater=rho(position)>.4;
 // The lamp is filled with clear liquid around the wax.
 let lamp=PLAY&&u.lava>.5;
 let medium=select(1.,1.333,inWater||lamp);
 ray=refract(ray,normalize(position),1.46/medium);
 if(dot(ray,ray)<.01){return display(reflection,coverage);}
 position+=ray*.008;
 let tint=u.tint*u.tintStrength;
 var throughput=vec3f(1.);var radiance=vec3f(0.);
 var crossings=0;
 var nextBubble=airBubbles(position,ray);
 var nextSpark=vec4f(0.,0.,0.,100.);var nextRain=vec4f(0.,0.,0.,100.);
 if(PLAY){nextSpark=sparks(position,ray);nextRain=raindrops(position,ray);}
 var insideWax=false;var waxShade=1.;
 for(var step=0;step<160;step++){
  let distanceToExit=sphere(position,ray,1.).y;
  if(distanceToExit<.016){
   radiance+=throughput*exitGlass(normalize(position),ray,inWater||lamp);break;
  }
  let lengthStep=.017;
  let next=position+ray*lengthStep;
  let nextWater=rho(next)>.4;
  if(nextWater!=inWater && crossings<6){
   var a=position;var b=next;
   for(var k=0;k<5;k++){
    let mid=(a+b)*.5;
    if((rho(mid)>.4)==inWater){a=mid;}else{b=mid;}
   }
   position=(a+b)*.5;
   var n=gradient(position);
   if(inWater){n=-n;}
   let n1=select(1.,1.333,inWater);let n2=select(1.333,1.,inWater);
   let f=fresnel(-dot(ray,n),n1,n2);
   let transmitted=refract(ray,n,n1/n2);
   if(dot(transmitted,transmitted)<.01){ray=reflect(ray,n);position+=ray*.02;}
   else {
    radiance+=throughput*lighting(position,reflect(ray,n))*f;
    throughput*=1.-f;ray=transmitted;position+=ray*.02;inWater=nextWater;
   }
   nextBubble=airBubbles(position,ray);
   if(PLAY){nextSpark=sparks(position,ray);nextRain=raindrops(position,ray);}
   crossings++;continue;
  }
  if(inWater && nextBubble.w<lengthStep){
   radiance+=throughput*nextBubble.xyz;
   let advance=nextBubble.w+.05;nextBubble=airBubbles(position+ray*advance,ray);nextBubble.w+=advance;
  }
  if(PLAY && !inWater && nextSpark.w<lengthStep){
   radiance+=throughput*nextSpark.xyz;
   let advance=nextSpark.w+.018;nextSpark=sparks(position+ray*advance,ray);nextSpark.w+=advance;
  }
  if(PLAY && !inWater && nextRain.w<lengthStep){
   radiance+=throughput*nextRain.xyz;
   throughput*=.75;
   let advance=nextRain.w+.06;nextRain=raindrops(position+ray*advance,ray);nextRain.w+=advance;
  }
  if(PLAY && u.lava>.001){
   // Cool wax is a deep purple, hot wax glows orange; it absorbs strongly and
   // emits with its heat. Wanigan 1's hot colour was (1.8,.44,.045), which the
   // camera's tone curve turned yellow; less green keeps it orange.
   let material=waxAt(position);let density=smoothstep(.35,.85,material.x)*u.lava;
   let color=mix(vec3f(.24,.025,.20),vec3f(1.8,.22,.02),smoothstep(.12,.75,material.y));
   if(density>.15&&!insideWax){
    let n=waxNormal(position);
    waxShade=.28+.72*max(0.,dot(n,normalize(vec3f(-.5,.8,.7))));
    radiance+=throughput*(lighting(position,reflect(ray,n))*.07+color*.28)*u.lava;
   }
   insideWax=density>.15;
   let transmitted=exp(-density*lengthStep*24.);
   radiance+=throughput*(1.-transmitted)*color*(.3+waxShade*.7)*(.8+material.y*.9)+throughput*color*material.y*lengthStep*.18;throughput*=transmitted;
  }
  if(inWater){
   if(PLAY && u.ink>0.){
    let dye=textureSampleLevel(ink,smoothSampler,(position+1.)*.5,0.);
    let pigment=dye.rgb/max(dye.a,.0001);let opticalDepth=dye.a*lengthStep*22.;
    let transmitted=exp(-opticalDepth);
    radiance+=throughput*(1.-transmitted)*(pigment*.8+vec3f(.025));throughput*=transmitted;
   }
   let extinction=vec3f(.48,.15,.075);
   let transmittance=exp(-extinction*lengthStep);
   // Single-scattered studio fill gives clear water depth without an opaque tint.
   let fill=vec3f(.025,.11,.18)+tint*.9;
   radiance+=throughput*(1.-transmittance)*fill;throughput*=transmittance;
   let glow=textureSampleLevel(wakes,smoothSampler,(position+1.)*.5,0.).x;
   radiance+=throughput*vec3f(.035,1.2,1.7)*glow*lengthStep*4.;
  }
  else {
   radiance+=throughput*u.tint*u.tintStrength*lengthStep*.24;
   var smoke=0.;
   if(!PLAY){smoke=textureSampleLevel(mist,smoothSampler,(position+1.)*.5,0.).w;}
   else if(!dry()){smoke=textureSampleLevel(mist,smoothSampler,(position+1.)*.5,0.).w*(1.-u.lava);}
   var heat=vec4f(0.);
   if(dry()){heat=textureSampleLevel(thermal,smoothSampler,(position+1.)*.5,0.);}
   let extinction=smoke*2.2+heat.z*4.;
   let transmission=exp(-extinction*lengthStep);
   let lightDirection=normalize(vec3f(-.7,.8,.55));
   var opticalDepth=0.;
   if(smoke>.015){
    for(var k=1;k<=6;k++){
     let samplePoint=position+lightDirection*f32(k)*.1;
     opticalDepth+=textureSampleLevel(mist,smoothSampler,clamp((samplePoint+1.)*.5,vec3f(0.),vec3f(1.)),0.).w*.1;
    }
   }
   let visibility=exp(-opticalDepth*8.);
   let light=vec3f(.10,.14,.19)+vec3f(.65,.77,.91)*visibility;
   var emission=vec3f(0.);
   if(dry()){emission=fireColor(heat.y)*pow(max(0.,heat.y-.12),1.65)*1.15*(.12+heat.z*4.+heat.w*.2);}
   let integral=select(lengthStep,(1.-transmission)/max(extinction,.00001),extinction>.0001);
   radiance+=throughput*(light*smoke*2.2+emission)*integral;throughput*=transmission;
  }
  let eyeHit=eyes(position,ray);
  if(eyeHit.w<lengthStep){radiance+=throughput*eyeHit.xyz;throughput=vec3f(0.);break;}
  position=next;nextBubble.w-=lengthStep;
  if(PLAY){nextSpark.w-=lengthStep;nextRain.w-=lengthStep;}
  if(step==159){radiance+=throughput*exitGlass(normalize(position),ray,inWater||lamp);}
 }
 let signalLight=tint*(.06+.55*pow(1.-abs(dot(normal,-direction)),2.));
 // Condensation beads on the inside of the glass while the cloud is up.
 var dew=vec3f(0.);
 if(PLAY&&u.weather>0.&&!dry()){
  for(var i=${IMPACTS};i<${DROPS};i++){
   let drop=drops[i];if(drop.w>=0.){continue;}
   let delta=surface-drop.xyz;let radius=-drop.w;
   let shape=exp(-dot(delta,delta)/max(radius*radius*3.,.00001));
   dew+=vec3f(.45,.62,.72)*shape*.65;
  }
 }
 return display(mix(radiance,reflection,glassF)+signalLight+dew,coverage);
}`;
