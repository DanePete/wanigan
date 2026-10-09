export const densityWGSL = `
struct DensityParams {
  vertDim    : vec3i,
  voxel      : f32,
  gridOrigin : vec3f,
  invSupport : f32,
  boxMin     : vec3f,
  support2   : f32,
  simGridDim : vec3i,
  poly6      : f32,
  mass       : f32,
  rho0       : f32,
}
@group(0) @binding(0) var<uniform> M : DensityParams;
@group(0) @binding(1) var<storage, read> pos       : array<vec4f>;
@group(0) @binding(2) var<storage, read> rho       : array<f32>;
@group(0) @binding(3) var<storage, read> cellStart : array<u32>;
@group(0) @binding(4) var field : texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var<storage, read> velocity  : array<vec4f>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3u, @builtin(local_invocation_id) lid: vec3u,
        @builtin(num_workgroups) nwg: vec3u) {
  let idx = (wid.y * nwg.x + wid.x) * 256u + lid.x;
  let total = u32(M.vertDim.x * M.vertDim.y * M.vertDim.z);
  if (idx >= total) { return; }
  var v: vec3i;
  v.x = i32(idx) % M.vertDim.x;
  v.y = (i32(idx) / M.vertDim.x) % M.vertDim.y;
  v.z = i32(idx) / (M.vertDim.x * M.vertDim.y);
  let p = M.gridOrigin + M.voxel * vec3f(v);

  let c = clamp(vec3i(floor((p - M.boxMin) * M.invSupport)),
                vec3i(0), M.simGridDim - vec3i(1));
  let x0 = max(c.x - 1, 0);
  let x1 = min(c.x + 1, M.simGridDim.x - 1);
  var acc = 0.0;
  var flow = vec3f(0.0);
  for (var dz = -1; dz <= 1; dz++) {
    let z = c.z + dz;
    if (z < 0 || z >= M.simGridDim.z) { continue; }
    for (var dy = -1; dy <= 1; dy++) {
      let y = c.y + dy;
      if (y < 0 || y >= M.simGridDim.y) { continue; }
      let rowBase = u32((z * M.simGridDim.y + y) * M.simGridDim.x);
      let b = cellStart[rowBase + u32(x0)];
      let e = cellStart[rowBase + u32(x1) + 1u];
      for (var j = b; j < e; j++) {
        let vol = M.mass / max(rho[j], 0.5 * M.rho0);
        let rij = p - pos[j].xyz;
        let r2 = dot(rij, rij);
        if (r2 >= M.support2) { continue; }
        let t = M.support2 - r2;
        let weight = vol * M.poly6 * t * t * t;
        acc += weight;
        flow += weight * velocity[j].xyz;
      }
    }
  }
  textureStore(field, v, vec4f(acc, flow / max(acc, 0.001)));
}
`;
