import * as S from './wgsl.js';
import { buildScene } from './scene.js';

const WG = 256;
const groups = n => Math.max(1, Math.ceil(n / WG));

export class Sim {
  constructor(device) {
    this.dev = device;
    this.buf = {};
    this.pipe = {};
    this.compilePipelines();
  }

  compilePipelines() {
    const dev = this.dev;
    const make = (name, src, entry = 'main') => {
      const module = dev.createShaderModule({ code: S.prelude + src, label: name });
      this.pipe[name] = dev.createComputePipeline({
        label: name, layout: 'auto', compute: { module, entryPoint: entry },
      });
    };
    make('predict', S.predictWGSL);
    make('velFromPos', S.velFromPosWGSL);
    make('xsph', S.xsphWGSL);
    make('finalize', S.finalizeWGSL);
    make('normals', S.normalsWGSL);
    make('tension', S.tensionWGSL);

    {
      const module = dev.createShaderModule({ code: S.impulseWGSL, label: 'impulse' });
      this.pipe.impulse = dev.createComputePipeline({
        label: 'impulse', layout: 'auto', compute: { module, entryPoint: 'main' } });
    }
    make('count', S.countWGSL);
    make('scanBlock', S.scanBlockWGSL);
    make('scanBlocks', S.scanBlocksWGSL);
    make('scanAdd', S.scanAddWGSL);
    make('scatterSlot', S.scatterSlotWGSL);
    make('scatterMove', S.scatterMoveWGSL);
    make('lambda', S.lambdaWGSL);
    make('delta', S.deltaWGSL);
  }

  reset(params) {
    const dev = this.dev;
    this.params = params;
    const sc = buildScene(params);
    this.scene = sc;

    const n = sc.n;
    const h = sc.h;
    this.h = h;
    const box = params.box;

    this.gridDim = [
      Math.max(1, Math.floor(box[0] / h)),
      Math.max(1, Math.floor(box[1] / h)),
      Math.max(1, Math.floor(box[2] / h)),
    ];
    this.nCells = this.gridDim[0] * this.gridDim[1] * this.gridDim[2];

    for (const b of Object.values(this.buf)) b?.destroy?.();
    this.buf = {};

    const ST = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    const alloc = (name, bytes, usage = ST | GPUBufferUsage.COPY_DST) =>
      this.buf[name] = dev.createBuffer({ label: name, size: Math.max(16, bytes), usage });

    const vec4 = n * 16;
    for (const s of ['A', 'B']) {
      alloc('pos' + s, vec4); alloc('vel' + s, vec4); alloc('pred' + s, vec4);
    }
    alloc('lambda', n * 4);
    alloc('density', n * 4);
    alloc('slot', n * 4);
    alloc('corr', vec4);
    alloc('normal', vec4);
    alloc('cellCount', (this.nCells + 1) * 4);
    alloc('cellStart', (this.nCells + 2) * 4);
    alloc('blockSum', (Math.ceil(this.nCells / WG) + 2) * 4);
    alloc('cursor', (this.nCells + 1) * 4);

    const nb = sc.boundary.count;
    this.nBoundary = nb;
    const bpos = new Float32Array(Math.max(1, nb) * 4);
    for (let i = 0; i < nb; i++) {
      bpos[i * 4 + 0] = sc.boundary.pts[i * 3 + 0];
      bpos[i * 4 + 1] = sc.boundary.pts[i * 3 + 1];
      bpos[i * 4 + 2] = sc.boundary.pts[i * 3 + 2];
    }

    const { sortedPos, sortedPsi, cellStart } = this.sortBoundary(bpos, sc.boundary.psi, nb);
    alloc('bpos', Math.max(1, nb) * 16);
    alloc('bpsi', Math.max(1, nb) * 4);
    alloc('bcellStart', (this.nCells + 2) * 4);
    dev.queue.writeBuffer(this.buf.bpos, 0, sortedPos);
    dev.queue.writeBuffer(this.buf.bpsi, 0, sortedPsi);
    dev.queue.writeBuffer(this.buf.bcellStart, 0, cellStart);

    dev.queue.writeBuffer(this.buf.posA, 0, sc.pos);
    dev.queue.writeBuffer(this.buf.velA, 0, sc.vel);
    dev.queue.writeBuffer(this.buf.predA, 0, sc.pos);

    this.n = n;
    this.parity = 0;
    this.predParity = 0;

    this.uni = dev.createBuffer({ size: 160,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.uniF = new Float32Array(40);
    this.rayUni = dev.createBuffer({ size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.rayF = new Float32Array(12);
    this.uniI = new Int32Array(this.uniF.buffer);
    this.buildBindGroups();
    this.uploadParams(1 / 240);

    this.primeGrid();
  }

  primeGrid() {
    this.uploadParams(0);
    const enc = this.dev.createCommandEncoder();
    const nG = groups(this.n), cG = groups(this.nCells + 1);
    const par = this.parity;
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipe.predict);
    pass.setBindGroup(0, this.g[`predict${par}`]);
    pass.dispatchWorkgroups(nG);
    pass.end();
    enc.clearBuffer(this.buf.cellCount);
    enc.clearBuffer(this.buf.cursor);
    const pass2 = enc.beginComputePass();
    const run = (name, bind, n) => {
      pass2.setPipeline(this.pipe[name]);
      pass2.setBindGroup(0, this.g[bind]);
      pass2.dispatchWorkgroups(n);
    };
    run('count', `count${par}`, nG);
    run('scanBlock', 'scanBlock', groups(this.nCells));
    run('scanBlocks', 'scanBlocks', 1);
    run('scanAdd', 'scanAdd', cG);
    run('scatterSlot', `scatterSlot${par}`, nG);
    run('scatterMove', `scatterMove${par}`, nG);
    pass2.end();
    this.dev.queue.submit([enc.finish()]);
    this.parity ^= 1;
    this.predParity = this.parity;
    this.uploadParams(1 / 240);
  }

  sortBoundary(bpos, psi, nb) {
    const dim = this.gridDim, h = this.h;
    const counts = new Uint32Array(this.nCells + 2);
    const cellOf = (x, y, z) => {
      const c = [
        Math.min(dim[0] - 1, Math.max(0, Math.floor(x / h))),
        Math.min(dim[1] - 1, Math.max(0, Math.floor(y / h))),
        Math.min(dim[2] - 1, Math.max(0, Math.floor(z / h))),
      ];
      return (c[2] * dim[1] + c[1]) * dim[0] + c[0];
    };
    const cell = new Uint32Array(nb);
    for (let i = 0; i < nb; i++) {
      cell[i] = cellOf(bpos[i * 4], bpos[i * 4 + 1], bpos[i * 4 + 2]);
      counts[cell[i]]++;
    }
    const start = new Uint32Array(this.nCells + 2);
    let run = 0;
    for (let c = 0; c <= this.nCells; c++) { start[c] = run; run += counts[c] || 0; }
    start[this.nCells + 1] = run;
    const cursor = start.slice();
    const sortedPos = new Float32Array(Math.max(1, nb) * 4);
    const sortedPsi = new Float32Array(Math.max(1, nb));
    for (let i = 0; i < nb; i++) {
      const s = cursor[cell[i]]++;
      sortedPos[s * 4 + 0] = bpos[i * 4 + 0];
      sortedPos[s * 4 + 1] = bpos[i * 4 + 1];
      sortedPos[s * 4 + 2] = bpos[i * 4 + 2];
      sortedPsi[s] = psi[i];
    }
    return { sortedPos, sortedPsi, cellStart: start };
  }

  bg(pipeName, buffers) {
    const entries = [{ binding: 0, resource: { buffer: this.uni } }];
    buffers.forEach((b, i) => entries.push({ binding: i + 1, resource: { buffer: b } }));
    return this.dev.createBindGroup({
      layout: this.pipe[pipeName].getBindGroupLayout(0), entries });
  }

  buildBindGroups() {
    const B = this.buf;
    const g = {};

    for (let par = 0; par < 2; par++) {
      const s = par === 0 ? 'A' : 'B';
      const o = par === 0 ? 'B' : 'A';
      g[`predict${par}`] = this.bg('predict', [B['pos' + s], B['vel' + s], B['pred' + s]]);
      g[`count${par}`] = this.bg('count', [B['pred' + s], B.cellCount]);
      g[`scatterSlot${par}`] = this.bg('scatterSlot', [
        B['pred' + s], B.cellStart, B.cursor, B.slot]);
      g[`scatterMove${par}`] = this.bg('scatterMove', [
        B.slot, B['pos' + s], B['vel' + s], B['pred' + s],
        B['pos' + o], B['vel' + o], B['pred' + o]]);

      g[`velFromPos${par}`] = this.bg('velFromPos', [B['pos' + s], B['vel' + s], B['pred' + s]]);
      g[`xsph${par}`] = this.bg('xsph', [B['pred' + s], B['vel' + s], B.density, B.corr, B.cellStart]);
      g[`finalize${par}`] = this.bg('finalize', [B['pos' + s], B['vel' + s], B['pred' + s], B.corr]);
      g[`normals${par}`] = this.bg('normals', [B['pred' + s], B.density, B.normal, B.cellStart]);
      g[`tension${par}`] = this.bg('tension', [B['pred' + s], B.density, B.normal, B.corr, B.cellStart]);

      for (let pp = 0; pp < 2; pp++) {
        const ps = pp === 0 ? 'A' : 'B';
        const po = pp === 0 ? 'B' : 'A';
        g[`lambda${par}${pp}`] = this.bg('lambda', [
          B['pred' + ps], B.lambda, B.density, B.cellStart, B.bpos, B.bpsi, B.bcellStart]);
        g[`delta${par}${pp}`] = this.bg('delta', [
          B['pred' + ps], B['pred' + po], B.lambda, B.cellStart, B.bpos, B.bpsi, B.bcellStart]);
      }
    }
    g.scanBlock = this.bg('scanBlock', [B.cellCount, B.cellStart, B.blockSum]);
    g.scanBlocks = this.bg('scanBlocks', [B.blockSum]);
    g.scanAdd = this.bg('scanAdd', [B.cellStart, B.blockSum]);

    for (let par = 0; par < 2; par++) {
      const s = par === 0 ? 'A' : 'B';
      g[`impulse${par}`] = this.dev.createBindGroup({
        layout: this.pipe.impulse.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: this.rayUni } },
                  { binding: 1, resource: { buffer: B['pos' + s] } },
                  { binding: 2, resource: { buffer: B['vel' + s] } }],
      });
    }
    this.g = g;
  }

  uploadParams(dt) {
    const p = this.params, F = this.uniF, I = this.uniI;
    const h = this.h, d = p.spacing;
    const box = p.box;
    F[0] = 0; F[1] = 0; F[2] = 0; F[3] = dt;
    F[4] = box[0]; F[5] = box[1]; F[6] = box[2]; F[7] = h;
    I[8] = this.gridDim[0]; I[9] = this.gridDim[1]; I[10] = this.gridDim[2];
    F[11] = h * h;
    const halfD = 0.5 * d;
    F[12] = halfD; F[13] = halfD; F[14] = halfD;
    F[15] = 315 / (64 * Math.PI * Math.pow(h, 9));
    F[16] = box[0] - halfD; F[17] = box[1] - halfD; F[18] = box[2] - halfD;
    F[19] = -45 / (Math.PI * Math.pow(h, 6));
    F[20] = p.gravity;
    F[21] = this.scene.mass;
    F[22] = p.restDensity;
    F[23] = 1 / p.restDensity;

    F[24] = Math.max(1e-9, p.cfmEpsilonRel * this.scene.denomRest);

    F[25] = p.sCorrK / (this.scene.denomRest * Math.max(1, p.iterations));

    const rq = p.sCorrDq * h;
    const tq = h * h - rq * rq;
    const wq = (315 / (64 * Math.PI * Math.pow(h, 9))) * tq * tq * tq;
    F[26] = wq > 0 ? 1 / wq : 0;
    F[27] = p.xsphC;
    I[28] = this.n;
    I[29] = this.nCells;
    I[30] = this.nBoundary;
    F[31] = p.omega;
    I[32] = p.sorAverage ? 1 : 0;
    F[33] = dt > 0 ? 1 / dt : 0;
    F[34] = this.scene.mass / p.restDensity;
    F[35] = p.surfaceTensionK;
    F[36] = 32 / (Math.PI * Math.pow(h, 9));
    F[37] = Math.pow(h, 6) / 64;
    this.dev.queue.writeBuffer(this.uni, 0, this.uniF);
  }

  step(frameDt) {
    const p = this.params;

    const base = Math.max(1, p.substeps);
    const dtTarget = (1 / 60) / base;
    this.timeBank = (this.timeBank || 0) + frameDt;
    let sub = Math.floor(this.timeBank / dtTarget + 1e-4);
    const workCap = base * 8;
    if (sub > workCap) { sub = workCap; this.timeBank = 0; }
    else { this.timeBank -= sub * dtTarget; }

    if (sub < 1) return;
    const dt = dtTarget;
    this.uploadParams(dt);
    const dev = this.dev;
    const enc = dev.createCommandEncoder();

    const nG = groups(this.n);
    const cG = groups(this.nCells + 1);

    for (let s = 0; s < sub; s++) {
      const par = this.parity;
      const pass = enc.beginComputePass();
      pass.setPipeline(this.pipe.predict);
      pass.setBindGroup(0, this.g[`predict${par}`]);
      pass.dispatchWorkgroups(nG);
      pass.end();
      enc.clearBuffer(this.buf.cellCount);
      enc.clearBuffer(this.buf.cursor);
      const pass2 = enc.beginComputePass();
      const run2 = (name, bind, n) => {
        pass2.setPipeline(this.pipe[name]);
        pass2.setBindGroup(0, this.g[bind]);
        pass2.dispatchWorkgroups(n);
      };
      run2('count', `count${par}`, nG);
      run2('scanBlock', 'scanBlock', groups(this.nCells));
      run2('scanBlocks', 'scanBlocks', 1);
      run2('scanAdd', 'scanAdd', cG);
      run2('scatterSlot', `scatterSlot${par}`, nG);
      run2('scatterMove', `scatterMove${par}`, nG);
      pass2.end();
      this.parity ^= 1;
      this.predParity = this.parity;

      const par2 = this.parity;
      let pp = this.predParity;

      for (let it = 0; it < Math.max(1, p.iterations); it++) {
        const passI = enc.beginComputePass();
        passI.setPipeline(this.pipe.lambda);
        passI.setBindGroup(0, this.g[`lambda${par2}${pp}`]);
        passI.dispatchWorkgroups(nG);
        passI.setPipeline(this.pipe.delta);
        passI.setBindGroup(0, this.g[`delta${par2}${pp}`]);
        passI.dispatchWorkgroups(nG);
        pp ^= 1;
        passI.end();
      }
      this.predParity = pp;

      if (this.predParity !== this.parity) {
        const s = this.predParity === 0 ? 'A' : 'B';
        const o = this.predParity === 0 ? 'B' : 'A';
        enc.copyBufferToBuffer(this.buf['pred' + s], 0, this.buf['pred' + o], 0, this.n * 16);
        this.predParity = this.parity;
      }

      const passF = enc.beginComputePass();
      passF.setPipeline(this.pipe.velFromPos);
      passF.setBindGroup(0, this.g[`velFromPos${par2}`]);
      passF.dispatchWorkgroups(nG);
      passF.setPipeline(this.pipe.xsph);
      passF.setBindGroup(0, this.g[`xsph${par2}`]);
      passF.dispatchWorkgroups(nG);

      if (p.surfaceTensionK > 0) {
        passF.setPipeline(this.pipe.normals);
        passF.setBindGroup(0, this.g[`normals${par2}`]);
        passF.dispatchWorkgroups(nG);
        passF.setPipeline(this.pipe.tension);
        passF.setBindGroup(0, this.g[`tension${par2}`]);
        passF.dispatchWorkgroups(nG);
      }
      passF.setPipeline(this.pipe.finalize);
      passF.setBindGroup(0, this.g[`finalize${par2}`]);
      passF.dispatchWorkgroups(nG);
      passF.end();
    }

    dev.queue.submit([enc.finish()]);
  }

  applyRayImpulse(origin, dir, impulse, radius, speedLimit) {
    if (!this.n || radius <= 0) return;
    const len = Math.hypot(...impulse);
    if (len <= 0) return;
    const dl = Math.hypot(...dir) || 1;
    const F = this.rayF;
    F[0] = origin[0]; F[1] = origin[1]; F[2] = origin[2]; F[3] = radius;
    F[4] = dir[0] / dl; F[5] = dir[1] / dl; F[6] = dir[2] / dl; F[7] = speedLimit;
    F[8] = impulse[0]; F[9] = impulse[1]; F[10] = impulse[2];
    new Uint32Array(F.buffer, 44, 1)[0] = this.n;
    this.dev.queue.writeBuffer(this.rayUni, 0, F);
    const enc = this.dev.createCommandEncoder();
    const pass = enc.beginComputePass();
    pass.setPipeline(this.pipe.impulse);
    pass.setBindGroup(0, this.g[`impulse${this.parity}`]);
    pass.dispatchWorkgroups(groups(this.n));
    pass.end();
    this.dev.queue.submit([enc.finish()]);
  }
}
