const poly6Coef = h => 315 / (64 * Math.PI * Math.pow(h, 9));

function fluidBlock(d) {
  const d2 = (1 - d) ** 2;
  const out = [];
  // A full three-dimensional particle volume, bounded by the inner vessel.
  for (let x = -1 + d; x < 1; x += d)
    for (let y = -1 + d; y < -0.12; y += d)
      for (let z = -1 + d; z < 1; z += d)
        if (x*x + y*y + z*z < d2) out.push(x+1.2, y+1.2, z+1.2);
  return out;
}

function boundaryParticles(p, d, h) {
  const size = p.box;
  const pts = [];
  // Equal-area Fibonacci shell, with the upstream per-particle boundary mass.
  const count = Math.ceil(4 * Math.PI / (d*d));
  for (let i = 0; i < count; i++) {
    const y = 1 - 2 * (i + .5) / count;
    const r = Math.sqrt(1-y*y), theta = i * Math.PI * (3-Math.sqrt(5));
    pts.push(1.2+r*Math.cos(theta), 1.2+y, 1.2+r*Math.sin(theta));
  }
  const n = pts.length / 3;
  const dim = size.map(s => Math.max(1, Math.ceil(s / h)));
  const cellOf = (x, y, z) => [
    Math.min(dim[0] - 1, Math.max(0, Math.floor(x / h))),
    Math.min(dim[1] - 1, Math.max(0, Math.floor(y / h))),
    Math.min(dim[2] - 1, Math.max(0, Math.floor(z / h))),
  ];
  const key = (a, b, c) => (c * dim[1] + b) * dim[0] + a;
  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const [a, b, c] = cellOf(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    const k = key(a, b, c);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }
  const coef = poly6Coef(h);
  const h2 = h * h;
  const psi = new Float32Array(Math.max(1, n));
  for (let i = 0; i < n; i++) {
    const [a, b, c] = cellOf(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
    let sum = 0;
    for (let dc = -1; dc <= 1; dc++) {
      if (c + dc < 0 || c + dc >= dim[2]) continue;
      for (let db = -1; db <= 1; db++) {
        if (b + db < 0 || b + db >= dim[1]) continue;
        for (let da = -1; da <= 1; da++) {
          if (a + da < 0 || a + da >= dim[0]) continue;
          const arr = buckets.get(key(a + da, b + db, c + dc));
          if (!arr) continue;
          for (const j of arr) {
            const dx = pts[i * 3] - pts[j * 3];
            const dy = pts[i * 3 + 1] - pts[j * 3 + 1];
            const dz = pts[i * 3 + 2] - pts[j * 3 + 2];
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 >= h2) continue;
            const t = h2 - r2;
            sum += t * t * t;
          }
        }
      }
    }
    sum *= coef;
    psi[i] = sum > 0 ? p.restDensity / sum : 0;
  }
  return { pts, psi, count: n };
}

export function buildScene(p) {
  const d = p.spacing;
  const h = 2 * d;
  const [bx, by, bz] = p.box;

  const fluid = fluidBlock(d);
  const n = fluid.length / 3;

  const pos = new Float32Array(n * 4);
  const vel = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    pos[i * 4 + 0] = fluid[i * 3 + 0];
    pos[i * 4 + 1] = fluid[i * 3 + 1];
    pos[i * 4 + 2] = fluid[i * 3 + 2];
  }

  const boundary = boundaryParticles(p, d, h);

  const coef = poly6Coef(h);
  const h2 = h * h;
  const spiky = -45 / (Math.PI * Math.pow(h, 6));
  const dim = [Math.max(1, Math.floor(bx / h)), Math.max(1, Math.floor(by / h)),
               Math.max(1, Math.floor(bz / h))];
  const cellOf = i => [
    Math.min(dim[0] - 1, Math.max(0, Math.floor(pos[i * 4 + 0] / h))),
    Math.min(dim[1] - 1, Math.max(0, Math.floor(pos[i * 4 + 1] / h))),
    Math.min(dim[2] - 1, Math.max(0, Math.floor(pos[i * 4 + 2] / h))),
  ];
  const key = (a, b, c) => (c * dim[1] + b) * dim[0] + a;

  const buckets = new Map();
  for (let i = 0; i < n; i++) {
    const [a, b, c] = cellOf(i);
    const k = key(a, b, c);
    let arr = buckets.get(k);
    if (!arr) { arr = []; buckets.set(k, arr); }
    arr.push(i);
  }
  const forEachNeighbour = (i, f) => {
    const [a, b, c] = cellOf(i);
    for (let dc = -1; dc <= 1; dc++) {
      if (c + dc < 0 || c + dc >= dim[2]) continue;
      for (let db = -1; db <= 1; db++) {
        if (b + db < 0 || b + db >= dim[1]) continue;
        for (let da = -1; da <= 1; da++) {
          if (a + da < 0 || a + da >= dim[0]) continue;
          const arr = buckets.get(key(a + da, b + db, c + dc));
          if (arr) for (const j of arr) if (j !== i) f(j);
        }
      }
    }
  };
  const densityAt = (i, m) => {
    let rho = m * coef * h2 * h2 * h2;
    forEachNeighbour(i, j => {
      const r2 = (pos[i * 4] - pos[j * 4]) ** 2 + (pos[i * 4 + 1] - pos[j * 4 + 1]) ** 2 +
                 (pos[i * 4 + 2] - pos[j * 4 + 2]) ** 2;
      if (r2 >= h2) return;
      const t = h2 - r2;
      rho += m * coef * t * t * t;
    });
    return rho;
  };
  let mass = p.restDensity * d * d * d;
  {
    let maxRho = 0;
    for (let i = 0; i < n; i++) maxRho = Math.max(maxRho, densityAt(i, mass));
    if (maxRho > 0.5 * p.restDensity) {
      mass *= p.restDensity / maxRho;
    } else if (n > 0) {
      console.info(`scene: no interior fluid particle to calibrate against ` +
                   `(densest ${maxRho.toFixed(1)} of ${p.restDensity}); ` +
                   `keeping m = rho0 d^3`);
    }
  }
  let denomRest = 0;
  {
    const volume = mass / p.restDensity;

    for (let i = 0; i < n; i++) {
      if (densityAt(i, mass) < 0.99 * p.restDensity) continue;
      let gx = 0, gy = 0, gz = 0, sumGrad2 = 0;
      forEachNeighbour(i, j => {
        const rx = pos[i * 4] - pos[j * 4];
        const ry = pos[i * 4 + 1] - pos[j * 4 + 1];
        const rz = pos[i * 4 + 2] - pos[j * 4 + 2];
        const r2 = rx * rx + ry * ry + rz * rz;
        if (r2 < 1e-12 || r2 >= h2) return;
        const r = Math.sqrt(r2);
        const hr = h - r;
        const s = volume * spiky * hr * hr / r;
        gx += s * rx; gy += s * ry; gz += s * rz;
        sumGrad2 += s * s * r2;
      });
      denomRest = Math.max(denomRest, gx * gx + gy * gy + gz * gz + sumGrad2);
      if (i > 2000 && denomRest > 0) break;
    }
  }

  return { n, pos, vel, boundary, mass, h, denomRest };
}
