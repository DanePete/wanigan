/**
 * The screen-space fluid renderer's shaders, verbatim from the verified demo
 * (`relay-sluice.html`): depth splat → narrow-range bilateral blur → normals
 * reconstructed from the blurred depth → Fresnel at IOR 1.333 against a
 * small fixed studio (three lights plus a sky gradient) with refraction and
 * thickness-based colour absorption. Kept as plain template strings, not
 * rewritten as a shader-graph or split into includes, because the point of
 * this file is that it can be diffed against the demo it was copied from.
 *
 * `render.ts` is the only importer. Nothing here reads solver state or the
 * DOM; every uniform is passed in by whoever draws.
 */

/** Depth pass vertex shader: a GL point per particle, sized in device pixels
 *  by the caller so the point always covers roughly one particle radius. */
export const DEPTH_VERT = `#version 300 es
in vec3 aPos; uniform mat4 uProj; uniform float uSize; out vec3 vEye;
void main(){ vEye = aPos; gl_Position = uProj*vec4(aPos,1.0); gl_PointSize = uSize; }`;

/** Depth pass fragment shader: discards outside the point's circle, and
 *  writes both an eye-space depth (for the blur and the normal
 *  reconstruction) and `gl_FragDepth` (so nearer splats occlude farther
 *  ones through ordinary depth testing). */
export const DEPTH_FRAG = `#version 300 es
precision highp float; in vec3 vEye; uniform float uRadW; layout(location=0) out vec4 outD;
void main(){ vec2 c = gl_PointCoord*2.0-1.0; float r2 = dot(c,c); if(r2>1.0) discard;
  float eyeZ = vEye.z + sqrt(1.0-r2)*uRadW; gl_FragDepth = 0.5 - eyeZ*0.25; outD = vec4(eyeZ,1.0,0.0,1.0); }`;

/** Thickness pass fragment shader: additively accumulates a per-splat
 *  thickness contribution, later used to darken/absorb colour through the
 *  body of the water. Shares `DEPTH_VERT` as its vertex stage. */
export const THICKNESS_FRAG = `#version 300 es
precision highp float; in vec3 vEye; layout(location=0) out vec4 outT;
void main(){ vec2 c = gl_PointCoord*2.0-1.0; float r2 = dot(c,c); if(r2>1.0) discard; outT = vec4((1.0-r2)*0.07,0.0,0.0,1.0); }`;

/** A full-screen triangle with no vertex buffer, used by both the blur pass
 *  and the composite pass. */
export const QUAD_VERT = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.)); out vec2 vUv;
void main(){ vec2 p = P[gl_VertexID]; vUv = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

/** Separable narrow-range depth blur: a 21-tap 1D pass, run twice per axis
 *  (four passes total), that widens spatially but narrows across a depth
 *  discontinuity so the smoothing rounds a single splat into a surface
 *  without bleeding across the gap between two unrelated blobs of water. */
export const BLUR_FRAG = `#version 300 es
precision highp float; in vec2 vUv; uniform sampler2D uSrc; uniform vec2 uDir; layout(location=0) out vec4 outD;
void main(){ vec4 c = texture(uSrc, vUv); if(c.y < 0.5){ outD = c; return; }
  float sum = 0.0, wsum = 0.0;
  for(int i=-10;i<=10;i++){ vec4 s = texture(uSrc, vUv + uDir*float(i)); if(s.y < 0.5) continue;
    float w = exp(-float(i*i)*0.02); float dz = abs(s.x-c.x); w *= exp(-dz*dz*90.0); sum += s.x*w; wsum += w; }
  outD = vec4(wsum > 0.0 ? sum/wsum : c.x, 1.0, 0.0, 1.0); }`;

/** Composite pass: reconstructs eye-space normals from the blurred depth's
 *  own screen-space derivatives, then shades with Fresnel at IOR 1.333
 *  (water in air) against a small fixed three-light studio, refraction
 *  through that same studio, and colour absorption keyed to thickness. */
export const COMPOSITE_FRAG = `#version 300 es
precision highp float; in vec2 vUv; uniform sampler2D uDepth, uThick; uniform vec2 uTexel, uHalf;
uniform vec3 uTint; uniform float uLight; layout(location=0) out vec4 outC;
vec3 studio(vec3 d){ vec3 n = normalize(d);
  float key = smoothstep(0.62,0.80,dot(n,normalize(vec3(-0.45,0.80,0.55))));
  float fill = smoothstep(0.45,0.85,dot(n,normalize(vec3(0.75,0.25,0.45))));
  float rim = smoothstep(0.55,0.95,dot(n,normalize(vec3(0.10,-0.60,0.70))));
  float sky = n.y*0.5+0.5; vec3 base = mix(vec3(0.020,0.030,0.042), vec3(0.075,0.115,0.150), sky);
  return base + vec3(1.0,0.99,0.96)*key*1.35 + vec3(0.42,0.60,0.80)*fill*0.34 + vec3(0.55,0.72,0.92)*rim*0.28; }
float fresnel(float c, float n1, float n2){ float r0 = (n1-n2)/(n1+n2); r0 *= r0; return r0 + (1.0-r0)*pow(1.0-clamp(c,0.0,1.0),5.0); }
vec3 eyeOf(vec2 uv, float z){ return vec3((uv*2.0-1.0)*uHalf, z); }
void main(){ vec4 d = texture(uDepth, vUv); if(d.y < 0.5) discard; float z = d.x; vec3 p = eyeOf(vUv, z);
  vec4 dxr = texture(uDepth, vUv+vec2(uTexel.x,0.0)), dxl = texture(uDepth, vUv-vec2(uTexel.x,0.0));
  vec4 dyu = texture(uDepth, vUv+vec2(0.0,uTexel.y)), dyd = texture(uDepth, vUv-vec2(0.0,uTexel.y));
  vec3 ddx = (dxr.y > 0.5 && abs(dxr.x-z) < abs(dxl.x-z)) || dxl.y < 0.5 ? eyeOf(vUv+vec2(uTexel.x,0.0), dxr.x)-p : p-eyeOf(vUv-vec2(uTexel.x,0.0), dxl.x);
  vec3 ddy = (dyu.y > 0.5 && abs(dyu.x-z) < abs(dyd.x-z)) || dyd.y < 0.5 ? eyeOf(vUv+vec2(0.0,uTexel.y), dyu.x)-p : p-eyeOf(vUv-vec2(0.0,uTexel.y), dyd.x);
  vec3 nrm = normalize(cross(ddx, ddy)); if(nrm.z < 0.0) nrm = -nrm;
  vec3 view = vec3(0.0,0.0,1.0); float thick = clamp(texture(uThick, vUv).x, 0.0, 1.6);
  float F = fresnel(dot(nrm, view), 1.0, 1.333);
  vec3 refl = studio(reflect(-view, nrm)), refr = studio(refract(-view, nrm, 1.0/1.333));
  vec3 absorb = exp(-thick*vec3(0.95,0.52,0.34));
  vec3 body = mix(vec3(0.16,0.46,0.62), vec3(0.02,0.13,0.24), clamp(thick*0.75,0.0,1.0))*uTint;
  vec3 col = body + refr*(1.0-F)*0.40*absorb*uTint + refl*(F*6.0+0.10) + vec3(0.015,0.025,0.030);
  vec3 hv = normalize(normalize(vec3(-0.45,0.80,0.55)) + view);
  col += vec3(1.0,0.99,0.95)*pow(max(0.0,dot(nrm,hv)),28.0)*0.55*uLight;
  outC = vec4(col, clamp(0.45 + thick*1.6 + F*3.0, 0.0, 1.0)); }`;
