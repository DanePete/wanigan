export const prelude = `
struct Params {
  boxMin      : vec3f,
  dt          : f32,
  boxMax      : vec3f,
  h           : f32,
  gridDim     : vec3i,
  h2          : f32,
  clampMin    : vec3f,
  poly6       : f32,
  clampMax    : vec3f,
  spikyGrad   : f32,
  gravity     : f32,
  mass        : f32,
  rho0        : f32,
  invRho0     : f32,
  cfmEps      : f32,
  sCorrK      : f32,
  sCorrWq     : f32,
  xsphC       : f32,
  n           : u32,
  nCells      : u32,
  nBoundary   : u32,
  omega       : f32,
  sorAverage  : u32,
  invDt       : f32,
  volume      : f32,
  tension     : f32,
  cohes       : f32,
  cohesTerm   : f32,
}
@group(0) @binding(0) var<uniform> P : Params;

fn confine(p: vec3f) -> vec3f {
  let offset = p - vec3f(1.2);
  let radius = 1.0 - P.clampMin.x;
  return vec3f(1.2) + offset * min(1.0, radius / max(length(offset), 1e-8));
}
fn cellOf(p: vec3f) -> vec3i {
  let c = vec3i(floor((p - P.boxMin) / P.h));
  return clamp(c, vec3i(0), P.gridDim - vec3i(1));
}
fn cellIndex(c: vec3i) -> u32 {
  return u32((c.z * P.gridDim.y + c.y) * P.gridDim.x + c.x);
}
fn poly6(r2: f32) -> f32 {
  let t = P.h2 - r2;
  return select(0.0, P.poly6 * t * t * t, r2 < P.h2);
}
`;

export const predictWGSL = `
@group(0) @binding(1) var<storage, read_write> pos  : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel  : array<vec4f>;
@group(0) @binding(3) var<storage, read_write> pred : array<vec4f>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }

  let v = vel[i].xyz + P.dt * vec3f(0.0, -P.gravity, 0.0);
  vel[i] = vec4f(v, 0.0);
  pred[i] = vec4f(pos[i].xyz + P.dt * v, 1.0);
}
`;

export const velFromPosWGSL = `
@group(0) @binding(1) var<storage, read>       pos  : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel  : array<vec4f>;
@group(0) @binding(3) var<storage, read>       pred : array<vec4f>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  vel[i] = vec4f((pred[i].xyz - pos[i].xyz) * P.invDt, 0.0);
}
`;

export const xsphWGSL = `
@group(0) @binding(1) var<storage, read>       pred      : array<vec4f>;
@group(0) @binding(2) var<storage, read>       vel       : array<vec4f>;
@group(0) @binding(3) var<storage, read>       density   : array<f32>;
@group(0) @binding(4) var<storage, read_write> corr      : array<vec4f>;
@group(0) @binding(5) var<storage, read>       cellStart : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let pi = pred[i].xyz;
  let vi = vel[i].xyz;
  let c = cellOf(pi);
  let x0 = max(c.x - 1, 0);
  let x1 = min(c.x + 1, P.gridDim.x - 1);
  var acc = vec3f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    let z = c.z + dz;
    if (z < 0 || z >= P.gridDim.z) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = c.y + dy;
      if (y < 0 || y >= P.gridDim.y) { continue; }
      let rowBase = u32((z * P.gridDim.y + y) * P.gridDim.x);
      let b = cellStart[rowBase + u32(x0)];
      let e = cellStart[rowBase + u32(x1) + 1u];
      for (var j = b; j < e; j++) {
        if (j == i) { continue; }
        let rij = pi - pred[j].xyz;
        let r2 = dot(rij, rij);
        if (r2 >= P.h2) { continue; }
        let f = P.mass * poly6(r2) / max(density[j], 0.5 * P.rho0);
        acc += f * (vel[j].xyz - vi);
      }
    }
  }
  corr[i] = vec4f(P.xsphC * acc, 0.0);
}
`;

export const impulseWGSL = `
struct Ray {
  origin     : vec3f,
  radius     : f32,
  dir        : vec3f,
  speedLimit : f32,
  impulse    : vec3f,
  n          : u32,
}
@group(0) @binding(0) var<uniform> R : Ray;
@group(0) @binding(1) var<storage, read>       pos : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel : array<vec4f>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= R.n) { return; }
  let toP = pos[i].xyz - R.origin;
  let along = dot(toP, R.dir);
  if (along <= 0.0) { return; }
  let radial = toP - along * R.dir;
  let d2 = dot(radial, radial);
  if (d2 >= R.radius * R.radius) { return; }
  let x = 1.0 - sqrt(d2) / R.radius;
  let v = vel[i].xyz;
  let oldSpeed = length(v);
  var nv = v + (x * x) * R.impulse;
  let ns = length(nv);
  let allowed = max(oldSpeed, R.speedLimit);
  if (ns > allowed) { nv *= allowed / ns; }
  vel[i] = vec4f(nv, 0.0);
}
`;

export const normalsWGSL = `
@group(0) @binding(1) var<storage, read>       pred      : array<vec4f>;
@group(0) @binding(2) var<storage, read>       density   : array<f32>;
@group(0) @binding(3) var<storage, read_write> normalBuf : array<vec4f>;
@group(0) @binding(4) var<storage, read>       cellStart : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let pi = pred[i].xyz;
  let c = cellOf(pi);
  let x0 = max(c.x - 1, 0);
  let x1 = min(c.x + 1, P.gridDim.x - 1);
  var acc = vec3f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    let z = c.z + dz;
    if (z < 0 || z >= P.gridDim.z) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = c.y + dy;
      if (y < 0 || y >= P.gridDim.y) { continue; }
      let rowBase = u32((z * P.gridDim.y + y) * P.gridDim.x);
      let b = cellStart[rowBase + u32(x0)];
      let e = cellStart[rowBase + u32(x1) + 1u];
      for (var j = b; j < e; j++) {
        if (j == i) { continue; }
        let rij = pi - pred[j].xyz;
        let r2 = dot(rij, rij);
        if (r2 >= P.h2 || r2 < 1.0e-12) { continue; }
        let r = sqrt(r2);
        let hr = P.h - r;
        acc += (P.mass / max(density[j], 0.5 * P.rho0)) *
               (P.spikyGrad * hr * hr / r) * rij;
      }
    }
  }
  normalBuf[i] = vec4f(P.h * acc, 0.0);
}
`;

export const tensionWGSL = `
@group(0) @binding(1) var<storage, read>       pred      : array<vec4f>;
@group(0) @binding(2) var<storage, read>       density   : array<f32>;
@group(0) @binding(3) var<storage, read>       normalBuf : array<vec4f>;
@group(0) @binding(4) var<storage, read_write> corr      : array<vec4f>;
@group(0) @binding(5) var<storage, read>       cellStart : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let pi = pred[i].xyz;
  let ni = normalBuf[i].xyz;
  let rhoi = density[i];
  let c = cellOf(pi);
  let x0 = max(c.x - 1, 0);
  let x1 = min(c.x + 1, P.gridDim.x - 1);
  var acc = vec3f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    let z = c.z + dz;
    if (z < 0 || z >= P.gridDim.z) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = c.y + dy;
      if (y < 0 || y >= P.gridDim.y) { continue; }
      let rowBase = u32((z * P.gridDim.y + y) * P.gridDim.x);
      let b = cellStart[rowBase + u32(x0)];
      let e = cellStart[rowBase + u32(x1) + 1u];
      for (var j = b; j < e; j++) {
        if (j == i) { continue; }
        let rij = pi - pred[j].xyz;
        let r2 = dot(rij, rij);
        if (r2 >= P.h2 || r2 < 1.0e-12) { continue; }
        let r = sqrt(r2);
        let hrr = P.h - r;
        let k = hrr * hrr * hrr * r * r * r;
        var cw = P.cohes * (2.0 * k - P.cohesTerm);
        if (2.0 * r > P.h) { cw = P.cohes * k; }
        let fCoh = (-P.tension * P.mass * cw / r) * rij;
        let fCurv = -P.tension * (ni - normalBuf[j].xyz);
        acc += (2.0 * P.rho0 / (rhoi + density[j])) * (fCoh + fCurv);
      }
    }
  }
  corr[i] = vec4f(corr[i].xyz + P.dt * acc, 0.0);
}
`;

export const finalizeWGSL = `
@group(0) @binding(1) var<storage, read_write> pos  : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> vel  : array<vec4f>;
@group(0) @binding(3) var<storage, read>       pred : array<vec4f>;
@group(0) @binding(4) var<storage, read>       corr : array<vec4f>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let position = confine(pred[i].xyz);
  let offset = position - vec3f(1.2);
  let normal = normalize(offset + vec3f(0.0, 1e-8, 0.0));
  var velocity = vel[i].xyz + corr[i].xyz;
  if (length(offset) >= 1.0 - P.clampMin.x - 0.001) {
    velocity -= normal * max(0.0, dot(velocity, normal));
  }
  vel[i] = vec4f(velocity, 0.0);
  pos[i] = vec4f(position, 1.0);
}
`;

export const countWGSL = `
@group(0) @binding(1) var<storage, read>       pred      : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> cellCount : array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  atomicAdd(&cellCount[cellIndex(cellOf(pred[i].xyz))], 1u);
}
`;

export const scanBlockWGSL = `
@group(0) @binding(1) var<storage, read>       cellCount : array<u32>;
@group(0) @binding(2) var<storage, read_write> cellStart : array<u32>;
@group(0) @binding(3) var<storage, read_write> blockSum  : array<u32>;

var<workgroup> tmp : array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(local_invocation_id) lid: vec3u,
        @builtin(workgroup_id) wid: vec3u) {
  let i = gid.x;
  let t = lid.x;
  tmp[t] = select(0u, cellCount[i], i < P.nCells);
  workgroupBarrier();

  for (var off = 1u; off < 256u; off = off << 1u) {
    var v = tmp[t];
    if (t >= off) { v = v + tmp[t - off]; }
    workgroupBarrier();
    tmp[t] = v;
    workgroupBarrier();
  }
  if (i < P.nCells) {
    cellStart[i] = select(tmp[t - 1u], 0u, t == 0u);
  }
  if (t == 255u) { blockSum[wid.x] = tmp[255]; }
}
`;

export const scanBlocksWGSL = `
@group(0) @binding(1) var<storage, read_write> blockSum : array<u32>;

@compute @workgroup_size(1)
fn main() {
  let nBlocks = (P.nCells + 255u) / 256u;
  var run = 0u;
  for (var b = 0u; b < nBlocks; b++) {
    let v = blockSum[b];
    blockSum[b] = run;
    run = run + v;
  }

  blockSum[nBlocks] = run;
}
`;

export const scanAddWGSL = `
@group(0) @binding(1) var<storage, read_write> cellStart : array<u32>;
@group(0) @binding(2) var<storage, read>       blockSum  : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u,
        @builtin(workgroup_id) wid: vec3u) {
  let i = gid.x;
  if (i > P.nCells) { return; }
  if (i == P.nCells) { cellStart[i] = blockSum[(P.nCells + 255u) / 256u]; return; }
  cellStart[i] = cellStart[i] + blockSum[wid.x];
}
`;

export const scatterSlotWGSL = `
@group(0) @binding(1) var<storage, read>       pred      : array<vec4f>;
@group(0) @binding(2) var<storage, read>       cellStart : array<u32>;
@group(0) @binding(3) var<storage, read_write> cursor    : array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> slot      : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let cell = cellIndex(cellOf(pred[i].xyz));
  slot[i] = cellStart[cell] + atomicAdd(&cursor[cell], 1u);
}
`;

export const scatterMoveWGSL = `
@group(0) @binding(1) var<storage, read>       slot  : array<u32>;
@group(0) @binding(2) var<storage, read>       pos   : array<vec4f>;
@group(0) @binding(3) var<storage, read>       vel   : array<vec4f>;
@group(0) @binding(4) var<storage, read>       pred  : array<vec4f>;
@group(0) @binding(5) var<storage, read_write> pos2  : array<vec4f>;
@group(0) @binding(6) var<storage, read_write> vel2  : array<vec4f>;
@group(0) @binding(7) var<storage, read_write> pred2 : array<vec4f>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let s = slot[i];
  pos2[s]  = pos[i];
  vel2[s]  = vel[i];
  pred2[s] = pred[i];
}
`;

export const lambdaWGSL = `
@group(0) @binding(1) var<storage, read>       pred       : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> lambda     : array<f32>;
@group(0) @binding(3) var<storage, read_write> density    : array<f32>;
@group(0) @binding(4) var<storage, read>       cellStart  : array<u32>;
@group(0) @binding(5) var<storage, read>       bpos       : array<vec4f>;
@group(0) @binding(6) var<storage, read>       bpsi       : array<f32>;
@group(0) @binding(7) var<storage, read>       bcellStart : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let pi = pred[i].xyz;
  let c = cellOf(pi);
  let x0 = max(c.x - 1, 0);
  let x1 = min(c.x + 1, P.gridDim.x - 1);
  var rho = P.mass * poly6(0.0);
  var gradSum = vec3f(0.0);
  var sumGrad2 = 0.0;
  for (var dz = -1; dz <= 1; dz++) {
    let z = c.z + dz;
    if (z < 0 || z >= P.gridDim.z) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = c.y + dy;
      if (y < 0 || y >= P.gridDim.y) { continue; }
      let rowBase = u32((z * P.gridDim.y + y) * P.gridDim.x);
      let b = cellStart[rowBase + u32(x0)];
      let e = cellStart[rowBase + u32(x1) + 1u];
      for (var j = b; j < e; j++) {
        if (j == i) { continue; }
        let rij = pi - pred[j].xyz;
        let r2 = dot(rij, rij);
        if (r2 >= P.h2) { continue; }
        rho += P.mass * poly6(r2);
        if (r2 > 1.0e-12) {
          let r = sqrt(r2);
          let hr = P.h - r;
          let g = (P.volume * P.spikyGrad * hr * hr / r) * rij;
          gradSum += g;
          sumGrad2 += dot(g, g);
        }
      }
      if (P.nBoundary > 0u) {
        let bb = bcellStart[rowBase + u32(x0)];
        let be = bcellStart[rowBase + u32(x1) + 1u];
        for (var k = bb; k < be; k++) {
          let rij = pi - bpos[k].xyz;
          let r2 = dot(rij, rij);
          if (r2 >= P.h2 || r2 < 1.0e-12) { continue; }
          rho += bpsi[k] * poly6(r2);
          let r = sqrt(r2);
          let hr = P.h - r;
          gradSum += (bpsi[k] * P.invRho0 * P.spikyGrad * hr * hr / r) * rij;
        }
      }
    }
  }
  density[i] = rho;
  let C = rho * P.invRho0 - 1.0;
  if (C > 0.0) {
    lambda[i] = -C / (dot(gradSum, gradSum) + sumGrad2 + P.cfmEps + 1.0e-12);
  } else {
    lambda[i] = 0.0;
  }
}
`;

export const deltaWGSL = `
@group(0) @binding(1) var<storage, read>       pred       : array<vec4f>;
@group(0) @binding(2) var<storage, read_write> predOut    : array<vec4f>;
@group(0) @binding(3) var<storage, read>       lambda     : array<f32>;
@group(0) @binding(4) var<storage, read>       cellStart  : array<u32>;
@group(0) @binding(5) var<storage, read>       bpos       : array<vec4f>;
@group(0) @binding(6) var<storage, read>       bpsi       : array<f32>;
@group(0) @binding(7) var<storage, read>       bcellStart : array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.n) { return; }
  let pi = pred[i].xyz;
  let li = lambda[i];
  let c = cellOf(pi);
  let x0 = max(c.x - 1, 0);
  let x1 = min(c.x + 1, P.gridDim.x - 1);

  var d = vec3f(0.0);
  var dB = vec3f(0.0);
  var nc = 1.0;
  for (var dz = -1; dz <= 1; dz++) {
    let z = c.z + dz;
    if (z < 0 || z >= P.gridDim.z) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = c.y + dy;
      if (y < 0 || y >= P.gridDim.y) { continue; }
      let rowBase = u32((z * P.gridDim.y + y) * P.gridDim.x);
      let b = cellStart[rowBase + u32(x0)];
      let e = cellStart[rowBase + u32(x1) + 1u];
      for (var j = b; j < e; j++) {
        if (j == i) { continue; }
        let rij = pi - pred[j].xyz;
        let r2 = dot(rij, rij);
        if (r2 >= P.h2 || r2 < 1.0e-12) { continue; }
        let r = sqrt(r2);
        let hr = P.h - r;
        let s = P.spikyGrad * hr * hr / r;

        let t = P.h2 - r2;
        let ratio = P.poly6 * t * t * t * P.sCorrWq;
        let r2r = ratio * ratio;
        let sc = -P.sCorrK * r2r * r2r;
        d += (li + lambda[j] + sc) * s * rij;
        nc += 1.0;
      }
      if (P.nBoundary > 0u) {
        let bb = bcellStart[rowBase + u32(x0)];
        let be = bcellStart[rowBase + u32(x1) + 1u];
        for (var k = bb; k < be; k++) {
          let rij = pi - bpos[k].xyz;
          let r2 = dot(rij, rij);
          if (r2 >= P.h2 || r2 < 1.0e-12) { continue; }
          let r = sqrt(r2);
          let hr = P.h - r;
          dB += (li * bpsi[k]) * (P.spikyGrad * hr * hr / r) * rij;
        }
      }
    }
  }
  d = d * P.volume + dB * P.invRho0;

  var scale = P.omega;
  if (P.sorAverage == 1u) { scale = P.omega / max(nc, 1.0); }
  predOut[i] = vec4f(confine(pi + d * scale), 1.0);
}
`;
