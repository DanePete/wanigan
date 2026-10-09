// Fieldnotes' pictures, all drawn from code for a made-up field-journal site.
// Four families share one palette (the site's own inks), and each keeps one
// kind of light, so a page of them reads as a designed series:
//
//   plates  landscapes set like screenprints: flat layered silhouettes, grain
//   maps    survey sheets: contours of a seeded heightfield, an ember route
//   kits    gear laid out flat and photographed straight down
//   charts  a week of weather on a barograph and thermograph strip
//
// Pure and seeded: the same file name always draws the same picture.

import { rng, hash, f, svg } from './draw.mjs';

/* ── palette and small helpers ──────────────────────────────────────────── */

const C = {
  paper: '#F2EEE4', bright: '#FAF8F2', fog: '#DEDBCF', lichen: '#C8C3A8', sage: '#8E9F8C',
  moss: '#3E5A49', deep: '#24372E', ink: '#1A211D', stone: '#5E655F', ember: '#B5532B',
  ochre: '#C9923E', lake: '#4A6878', lakeLight: '#A3B8C2', rose: '#E2B79C',
};
const hex = (c) => C[c] ?? c;
const rgbOf = (c) => [1, 3, 5].map((i) => parseInt(hex(c).slice(i, i + 2), 16));
/** A tint between two inks (names or hex): t = 0 is a, t = 1 is b. */
function mix(a, b, t) {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}
const ramp = (a, b, n) => Array.from({ length: n }, (_, i) => mix(a, b, n === 1 ? 0 : i / (n - 1)));
const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const f3 = (n) => Math.round(n * 1000) / 1000;
const pt = ([x, y]) => `${f(x)} ${f(y)}`;
const poly = (pts, close = true) => `M${pts.map(pt).join('L')}${close ? 'Z' : ''}`;

/* ── noise: smooth seeded values in 1-D and 2-D (roughly 0..1) ──────────── */

function noise1(seed) {
  const r = rng(seed);
  const v = Array.from({ length: 256 }, r);
  const at = (i) => v[i & 255];
  return (x) => {
    const i = Math.floor(x);
    const t = x - i;
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  };
}
function fbm1(seed, octaves = 3, gain = 0.5) {
  const ns = Array.from({ length: octaves }, (_, k) => noise1(seed + k * 7919));
  let norm = 0;
  for (let k = 0, a = 1; k < octaves; k++, a *= gain) norm += a;
  return (x) => {
    let s = 0;
    let a = 1;
    let q = 1;
    for (const n of ns) { s += a * n(x * q); a *= gain; q *= 2.03; }
    return s / norm;
  };
}
function noise2(seed) {
  const r = rng(seed);
  const v = Float64Array.from({ length: 4096 }, r);
  const at = (i, j) => v[((j & 63) << 6) | (i & 63)];
  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  return (x, y) => {
    const i = Math.floor(x);
    const j = Math.floor(y);
    const u = fade(x - i);
    const w = fade(y - j);
    return lerp(lerp(at(i, j), at(i + 1, j), u), lerp(at(i, j + 1), at(i + 1, j + 1), u), w);
  };
}
function fbm2(seed, octaves = 3) {
  const ns = Array.from({ length: octaves }, (_, k) => noise2(seed + k * 104729));
  return (x, y) => {
    let s = 0;
    let a = 1;
    let q = 1;
    let norm = 0;
    ns.forEach((n, k) => { s += a * n(x * q + k * 17.3, y * q + k * 9.1); norm += a; a *= 0.5; q *= 2.1; });
    return s / norm;
  };
}

/* ── plates: the screenprint toolkit ────────────────────────────────────────
   A plate is drawn back to front. A ground line is a function y(x), so
   anything standing on it (a tree, a tent, a hiker) is placed at its exact
   height, and each layer's trees are drawn before the next, nearer layer.
   Whatever is added with mirror=true is also reflected in the water.        */

/** A smooth ground or ridge line: mid height y0, rising and falling by amp. */
function ground(seed, { w = 1600, y0, amp = 0, scale = 400, oct = 3, tilt = 0, bumps = [] }) {
  const n = fbm1(seed, oct);
  return (x) => {
    let y = y0 - amp * (n(x / scale) - 0.5) * 2 + tilt * (x / w - 0.5);
    for (const [bx, bw, bh] of bumps) y -= bh * Math.exp(-(((x - bx) / bw) ** 2));
    return y;
  };
}
const flat = (y) => () => y;

/** The filled shape below a ground line, sampled every few pixels. */
function groundD(at, w, h, step = 5) {
  let d = `M-12 ${h + 12}`;
  for (let x = -12; x <= w + 12; x += step) d += `L${f(x)} ${f(at(x))}`;
  return `${d}L${w + 12} ${h + 12}Z`;
}
/** The filled shape above a hanging line (a canopy seen from beneath). */
function hangD(at, w, step = 5) {
  let d = 'M-12 -12';
  for (let x = -12; x <= w + 12; x += step) d += `L${f(x)} ${f(at(x))}`;
  return `${d}L${w + 12} -12Z`;
}

/**
 * One spruce: a narrow spire of drooping tiers on a short trunk. base is
 * where the trunk meets the ground. Returns the silhouette path, and with
 * snow, the snow lying on each tier.
 */
function spruce(x, base, H, r, { width = 0.3, droop = 0.25, jitter = 0.45, lean = 0, tiers, snow = false } = {}) {
  const n = tiers ?? clamp(Math.round(H / 9), 3, 14);
  const top = base - H;
  const crown = base - H * 0.06;
  const half = (H * width) / 2;
  const th = (crown - top) / n;
  const tw = Math.max(0.5, H * 0.018);
  const cx = (y) => x + lean * (base - y);
  const R = [];
  const L = [];
  for (let i = 1; i <= n; i++) {
    const y = top + th * i;
    const spread = half * Math.pow(i / n, 0.8);
    const wr = spread * (1 - jitter / 2 + jitter * r());
    const wl = spread * (1 - jitter / 2 + jitter * r());
    const c = cx(y);
    R.push([c + wr, y], [c + wr * 0.35, y - th * droop]);
    L.push([c - wl, y], [c - wl * 0.35, y - th * droop]);
  }
  const P = (q) => `L${pt(q)}`;
  let d = `M${f(cx(top))} ${f(top)}`;
  for (let i = 0; i < n; i++) { d += P(R[2 * i]); if (i < n - 1) d += P(R[2 * i + 1]); }
  d += P([cx(crown) + tw, crown]) + P([x + tw, base]) + P([x - tw, base]) + P([cx(crown) - tw, crown]);
  for (let i = n - 1; i >= 0; i--) { if (i < n - 1) d += P(L[2 * i + 1]); d += P(L[2 * i]); }
  d += 'Z';
  let s = '';
  if (snow) {
    for (let i = 0; i < n; i++) {
      for (const side of [R, L]) {
        const A = i === 0 ? [cx(top), top] : side[2 * i - 1];
        const B = side[2 * i];
        const t = th * (0.34 + 0.16 * r());
        const M = [lerp(A[0], B[0], 0.55), lerp(A[1], B[1], 0.55)];
        const Bp = [B[0] + (A[0] - B[0]) * 0.22, B[1] + (A[1] - B[1]) * 0.22 + t * 0.55];
        s += `M${f(A[0])} ${f(A[1] - 1)}L${pt([M[0], M[1] - t * 0.18])}L${f(B[0] - (B[0] - A[0]) * 0.03)} ${f(B[1] - 0.5)}L${pt(Bp)}L${pt([M[0], M[1] + t * 0.8])}L${f(A[0])} ${f(A[1] + t)}Z`;
      }
    }
  }
  return { d, s };
}

/** Stand a tree of height H at x on a ground line: its trunk sinks into the lowest ground under it. */
function plant(at, x, H, width = 0.3, sink = 0.05) {
  const tw = Math.max(1, H * width * 0.12);
  return { x, H, base: Math.max(at(x - tw), at(x), at(x + tw)) + H * sink };
}

/** Trees in clumps along a ground line: tallest in the middle of a clump. */
function grove(at, r, { x0, x1, minH, maxH, clumps = 3, per = 5, singles = 0, width = 0.3 }) {
  const out = [];
  for (let k = 0; k < clumps; k++) {
    const c = x0 + ((x1 - x0) * (k + 0.15 + 0.7 * r())) / clumps;
    const spread = maxH * width * (0.6 + per * 0.3);
    const peak = maxH * (0.72 + 0.28 * r());
    for (let i = 0; i < per; i++) {
      const u = r() * 2 - 1;
      const H = minH + (peak - minH) * (1 - Math.abs(u) ** 1.4) * (0.6 + 0.4 * r());
      out.push(plant(at, clamp(c + (u * spread) / 2, x0, x1), H, width));
    }
  }
  for (let i = 0; i < singles; i++) out.push(plant(at, lerp(x0, x1, r()), minH + (maxH - minH) * 0.45 * r(), width));
  return out;
}

/** A continuous forest edge along a ridge: small trees shoulder to shoulder, tapering into clearings. */
function edge(at, r, seed, { x0 = -30, x1, minH, maxH, width = 0.38, gaps = 0.25, scale = 160, body = 0.4 }) {
  const n = fbm1(seed, 2);
  const wave = fbm1(seed + 5, 2);
  const k = (x) => clamp((n(x / scale) - gaps) / 0.3);
  const out = [];
  for (let x = x0; x < x1;) {
    const H = maxH * k(x) * (0.45 + 0.55 * r() ** 0.8);
    if (H > minH * 0.45) out.push(plant(at, x, H, width, 0.12));
    x += Math.max(minH, H) * width * (0.22 + 0.34 * r());
  }
  // the body of the wood under the spires, so only their tops break the skyline
  out.band = (x) => at(x) - body * maxH * k(x) * (0.55 + 0.6 * wave(x / 45));
  return out;
}

/** A path leading away in perspective: wide at the bottom, narrowing toward (vx, vy), with a gentle bend. */
function trail(vx, vy, bx, by, halfBottom, { bend = 0, halfTop = 2 } = {}) {
  const at = (y) => {
    const u = clamp((y - vy) / (by - vy));
    return [lerp(vx, bx, u) + bend * Math.sin(Math.PI * u), lerp(halfTop, halfBottom, u ** 1.1)];
  };
  const L = [];
  const R = [];
  for (let k = 0; k <= 48; k++) {
    const y = vy + ((by - vy) * k) / 48;
    const [c, hw] = at(y);
    L.push([c - hw, y]);
    R.unshift([c + hw, y]);
  }
  return { d: poly([...L, ...R]), at, on: (x, y, pad = 0) => { const [c, hw] = at(y); return Math.abs(x - c) < hw + pad; } };
}

class Plate {
  constructor(w, h, name) {
    Object.assign(this, { w, h, seed: hash(name), defs: [], body: [], mirror: [], n: 0 });
    this.r = rng(this.seed);
  }

  id(prefix) { return `${prefix}${this.n++}`; }

  add(s, mirror = false) {
    this.body.push(s);
    if (mirror) this.mirror.push(s);
    return this;
  }

  grad(stops, y1 = 0, y2 = this.h, x1 = 0, x2 = 0) {
    const id = this.id('g');
    this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${hex(c)}" stop-opacity="${op}"/>`).join('')}</linearGradient>`);
    return `url(#${id})`;
  }

  blur(sd) {
    const id = this.id('b');
    this.defs.push(`<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${sd}"/></filter>`);
    return `url(#${id})`;
  }

  sky(stops, y2 = this.h) { return this.add(`<rect width="${this.w}" height="${this.h}" fill="${this.grad(stops, 0, y2)}"/>`); }

  land(at, color, { mirror = false, op = 1, step = 5 } = {}) {
    return this.add(`<path d="${groundD(at, this.w, this.h, step)}" fill="${hex(color)}"${op < 1 ? ` opacity="${op}"` : ''}/>`, mirror);
  }

  hang(at, color, { step = 5 } = {}) { return this.add(`<path d="${hangD(at, this.w, step)}" fill="${hex(color)}"/>`); }

  /** Haze lying in a valley: clear at y1, thickening to op at y2. */
  mist(y1, y2, color, op = 0.8, mirror = false) {
    return this.add(`<rect y="${f(y1)}" width="${this.w}" height="${f(y2 - y1)}" fill="${this.grad([[0, color, 0], [1, color, op]], y1, y2)}"/>`, mirror);
  }

  trees(list, color, { mirror = false, snow = null, ...opt } = {}) {
    const sorted = [...list].sort((a, b) => a.base - b.base);
    if (!snow) {
      const d = sorted.map((t) => spruce(t.x, t.base, t.H, this.r, opt).d).join('');
      return this.add(`<path d="${d}" fill="${hex(color)}"/>`, mirror);
    }
    const parts = sorted.map((t) => {
      const s = spruce(t.x, t.base, t.H, this.r, { ...opt, snow: true });
      return `<path d="${s.d}" fill="${hex(color)}"/><path d="${s.s}" fill="${hex(snow)}"/>`;
    });
    return this.add(parts.join(''), mirror);
  }

  grove(at, opts) { return grove(at, this.r, opts); }

  edge(at, opts) { return edge(at, this.r, this.seed + this.n++ * 31, { x1: this.w + 30, ...opts }); }

  /** A wood seen from afar: a filled band along a ground line, its top broken by spruce spires. */
  forest(at, color, opts, treeOpts = {}) {
    const list = this.edge(at, opts);
    const top = [];
    const bot = [];
    for (let x = -12; x <= this.w + 12; x += 4) { top.push([x, list.band(x)]); bot.unshift([x, at(x) + 3]); }
    this.add(`<path d="${poly([...top, ...bot])}" fill="${hex(color)}"/>`, treeOpts.mirror);
    return this.trees(list, color, treeOpts);
  }

  /** Still water from yW down: flat colour, a soft mirror of what was marked mirror, thin lines. */
  water(yW, color, { reflect = 0.45, blur = '0.8 2.6', lines = 14, lineColor = 'bright', lineOp = 0.4, glint = 0.5 } = {}) {
    const { w, h, r } = this;
    const clip = this.id('c');
    this.defs.push(`<clipPath id="${clip}"><rect y="${f(yW)}" width="${w}" height="${f(h - yW + 2)}"/></clipPath>`);
    this.add(`<rect y="${f(yW)}" width="${w}" height="${f(h - yW)}" fill="${hex(color)}"/>`);
    if (reflect && this.mirror.length) {
      this.add(`<g clip-path="url(#${clip})"><g opacity="${reflect}" filter="${this.blur(blur)}"><g transform="matrix(1 0 0 -1 0 ${f(2 * yW)})">${this.mirror.join('')}</g></g></g>`);
    }
    if (glint) this.add(`<rect y="${f(yW)}" width="${w}" height="1.6" fill="${hex(lineColor)}" opacity="${glint}"/>`);
    let d = '';
    for (let i = 0; i < lines; i++) {
      const u = (i + 0.2 + 0.6 * r()) / lines;
      const y = yW + 4 + (h - yW - 8) * u ** 1.5;
      const len = w * (0.03 + 0.12 * r()) * (0.5 + u);
      const x = r() * (w - len);
      const t = 0.8 + u * 1.4;
      d += `M${f(x)} ${f(y)}h${f(len)}v${f(t)}h${f(-len)}Z`;
    }
    if (lines) this.add(`<path d="${d}" fill="${hex(lineColor)}" opacity="${lineOp}"/>`);
    return this;
  }

  /** Film grain: a faint light and dark speckle over everything. */
  grain(amount = 0.045) {
    const id = this.id('n');
    const k = f3(amount / 0.12);
    this.defs.push(`<filter id="${id}" x="0" y="0" width="1" height="1" color-interpolation-filters="sRGB"><feTurbulence type="fractalNoise" baseFrequency="0.82" numOctaves="2" seed="${this.seed % 997}" result="t"/><feColorMatrix in="t" type="matrix" values="0 0 0 0 0.10 0 0 0 0 0.13 0 0 0 0 0.11 ${k} 0 0 0 ${f3(-0.5 * k)}" result="d"/><feColorMatrix in="t" type="matrix" values="0 0 0 0 0.98 0 0 0 0 0.97 0 0 0 0 0.95 ${-k} 0 0 0 ${f3(0.5 * k)}" result="l"/><feMerge><feMergeNode in="d"/><feMergeNode in="l"/></feMerge></filter>`);
    return this.add(`<rect width="${this.w}" height="${this.h}" filter="url(#${id})"/>`);
  }

  done(grainAmount = 0.045) {
    if (grainAmount) this.grain(grainAmount);
    return svg(this.w, this.h, this.body.join(''), this.defs.join(''));
  }
}

/* ── plates: small things standing in the landscape ─────────────────────── */

/** A canoe side-on with its waterline at y; an optional paddler and a wake trailing behind. */
function canoe(x, y, L, hull, { paddler = null, wake = null, dir = 1, wakeLen = 2.6, wakeOp = 0.55, inside = false } = {}) {
  const hh = L * 0.09;
  let s = '';
  if (wake) {
    const sx = x - (dir * L) / 2;
    let d = '';
    for (const k of [-1, 1]) {
      const ex = sx - dir * L * wakeLen;
      const ey = y + 1 + k * L * 0.05 * wakeLen + L * 0.02 * wakeLen;
      d += `M${f(sx)} ${f(y + 0.5)}L${f(ex)} ${f(ey)}L${f(ex)} ${f(ey + Math.max(1, L * 0.012))}Z`;
    }
    s += `<path d="${d}" fill="${hex(wake)}" opacity="${wakeOp}"/>`;
  }
  s += `<path d="M${f(x - L / 2)} ${f(y - hh)}Q${f(x)} ${f(y + hh * 0.1)} ${f(x + L / 2)} ${f(y - hh)}C${f(x + L * 0.4)} ${f(y + hh * 0.35)} ${f(x + L * 0.25)} ${f(y + hh * 0.4)} ${f(x)} ${f(y + hh * 0.4)}C${f(x - L * 0.25)} ${f(y + hh * 0.4)} ${f(x - L * 0.4)} ${f(y + hh * 0.35)} ${f(x - L / 2)} ${f(y - hh)}Z" fill="${hex(hull)}"/>`;
  if (inside) {
    // seen from a little above: the far gunwale and the dark inside between
    s += `<path d="M${f(x - L * 0.48)} ${f(y - hh * 0.95)}Q${f(x)} ${f(y - hh * 0.75)} ${f(x + L * 0.48)} ${f(y - hh * 0.95)}Q${f(x)} ${f(y + hh * 0.02)} ${f(x - L * 0.48)} ${f(y - hh * 0.95)}Z" fill="${mix(hull, 'ink', 0.5)}"/>`;
    s += `<path d="M${f(x - L * 0.18)} ${f(y - hh * 0.6)}l${f(L * 0.02)} ${f(hh * 0.38)}M${f(x + L * 0.16)} ${f(y - hh * 0.6)}l${f(-L * 0.02)} ${f(hh * 0.38)}" stroke="${mix(hull, 'paper', 0.3)}" stroke-width="${f(L * 0.012)}" stroke-linecap="round"/>`;
  }
  if (paddler) {
    const px = x - dir * L * 0.12;
    const top = y - hh * 0.45;
    const tH = L * 0.17;
    const tw = L * 0.055;
    s += `<path d="M${f(px - tw / 2)} ${f(top)}L${f(px - tw * 0.32)} ${f(top - tH)}L${f(px + tw * 0.32)} ${f(top - tH)}L${f(px + tw / 2)} ${f(top)}Z" fill="${hex(paddler)}"/>`;
    s += `<rect x="${f(px - L * 0.027)}" y="${f(top - tH - L * 0.062)}" width="${f(L * 0.054)}" height="${f(L * 0.06)}" rx="${f(L * 0.024)}" fill="${hex(paddler)}"/>`;
    s += `<path d="M${f(px + dir * L * 0.01)} ${f(top - tH * 1.05)}L${f(px + dir * L * 0.12)} ${f(y + hh * 0.9)}" stroke="${hex(paddler)}" stroke-width="${f(Math.max(1.2, L * 0.013))}" stroke-linecap="round"/>`;
  }
  return s;
}

/** A canoe turned over (hull up) as it rests on a rack: y is the gunwale line at mid-length. */
function canoeOver(x, y, L, hull) {
  const hh = L * 0.14;
  const top = `M${f(x - L / 2)} ${f(y + hh * 0.45)}C${f(x - L * 0.47)} ${f(y - hh * 0.6)} ${f(x - L * 0.36)} ${f(y - hh)} ${f(x)} ${f(y - hh)}C${f(x + L * 0.36)} ${f(y - hh)} ${f(x + L * 0.47)} ${f(y - hh * 0.6)} ${f(x + L / 2)} ${f(y + hh * 0.45)}`;
  const gun = `Q${f(x)} ${f(y - hh * 0.3)} ${f(x - L / 2)} ${f(y + hh * 0.45)}Z`;
  return `<path d="${top}${gun}" fill="${hex(hull)}"/>`
    + `<path d="M${f(x - L * 0.44)} ${f(y + hh * 0.18)}Q${f(x)} ${f(y - hh * 0.5)} ${f(x + L * 0.44)} ${f(y + hh * 0.18)}L${f(x + L * 0.49)} ${f(y + hh * 0.42)}Q${f(x)} ${f(y - hh * 0.28)} ${f(x - L * 0.49)} ${f(y + hh * 0.42)}Z" fill="${mix(hull, 'ink', 0.35)}"/>`
    + `<path d="M${f(x - L * 0.3)} ${f(y - hh * 0.82)}Q${f(x)} ${f(y - hh * 1.02)} ${f(x + L * 0.3)} ${f(y - hh * 0.82)}" stroke="${mix(hull, 'bright', 0.3)}" stroke-width="${f(L * 0.012)}" fill="none" stroke-linecap="round"/>`;
}

/** A ridge tent in three-quarter view, its front panel at x and floor at y. */
function tent(x, y, s, body, { door = mix(body, 'ink', 0.55), flank = mix(body, 'ink', 0.3), lines = 'stone' } = {}) {
  const P = (dx, dy) => `${f(x + dx * s)} ${f(y - dy * s)}`;
  return `<path d="M${P(-62, 0)}L${P(0, 64)}M${P(120, 56)}L${P(178, 0)}" stroke="${hex(lines)}" stroke-width="${f(Math.max(0.8, s * 1.2))}" opacity="0.7"/>`
    + `<path d="M${P(0, 64)}L${P(120, 56)}L${P(152, 4)}L${P(48, 0)}Z" fill="${flank}"/>`
    + `<path d="M${P(-48, 0)}L${P(0, 64)}L${P(48, 0)}Z" fill="${hex(body)}"/>`
    + `<path d="M${P(-15, 0)}L${P(0, 40)}L${P(15, 0)}Z" fill="${door}"/>`;
}

/** A hiker standing, facing dir, feet at y; the pack is the one ember accent. */
function hiker(x, y, H, ink, pack, dir = 1) {
  const u = H / 100;
  const P = (dx, dy) => `${f(x + dir * dx * u)} ${f(y - dy * u)}`;
  let s = `<path d="M${P(-9, 0)}L${P(-4, 48)}L${P(3, 48)}L${P(-3, 0)}ZM${P(7, 0)}L${P(1, 48)}L${P(8, 48)}L${P(12, 0)}Z" fill="${hex(ink)}"/>`;
  s += `<path d="M${P(-6, 46)}L${P(-7, 81)}L${P(7, 81)}L${P(8, 46)}Z" fill="${hex(ink)}"/>`;
  s += `<rect x="${f(x - 6.5 * u)}" y="${f(y - 99 * u)}" width="${f(13 * u)}" height="${f(16 * u)}" rx="${f(6 * u)}" fill="${hex(ink)}"/>`;
  s += `<path d="M${P(-6, 84)}L${P(-20, 82)}L${P(-21, 50)}L${P(-6, 50)}Z" fill="${hex(pack)}"/>`;
  s += `<path d="M${P(9, 62)}L${P(21, 0)}" stroke="${hex(ink)}" stroke-width="${f(Math.max(1, 2 * u))}" stroke-linecap="round"/>`;
  return s;
}

/** A smooth pebble or boulder: a jittered ring of points rounded off; a lighter top face. */
function stoneShape(cx, cy, rx, ry, r) {
  let pts = [];
  for (let i = 0; i < 9; i++) {
    const t = (i / 9) * Math.PI * 2;
    const k = 0.82 + 0.3 * r();
    pts.push([cx + Math.cos(t) * rx * k, cy + Math.sin(t) * ry * k * (Math.sin(t) > 0 ? 0.8 : 1)]);
  }
  pts.push(pts[0]);
  pts = chaikin(pts, true, 3);
  return poly(pts);
}
function stone(cx, cy, rx, ry, r, { body = 'stone', top = mix('stone', 'fog', 0.45), id }) {
  const d = stoneShape(cx, cy, rx, ry, r);
  return `<clipPath id="${id}"><path d="${d}"/></clipPath><path d="${d}" fill="${hex(body)}"/><g clip-path="url(#${id})"><path d="${stoneShape(cx - rx * 0.12, cy - ry * 0.42, rx * 0.95, ry * 0.75, r)}" fill="${hex(top)}"/></g>`;
}

/** A tapered grass blade from base, leaning over by lean. */
function blade(x, base, H, lean, w) {
  return `M${f(x - w / 2)} ${f(base)}Q${f(x - w * 0.2 + lean * 0.35)} ${f(base - H * 0.55)} ${f(x + lean)} ${f(base - H)}Q${f(x + w * 0.2 + lean * 0.45)} ${f(base - H * 0.5)} ${f(x + w / 2)} ${f(base)}Z`;
}
function meadowGrass(at, r, { x0, x1, count, minH, maxH, w = 3, lean = 30 }) {
  let d = '';
  for (let i = 0; i < count; i++) {
    const x = lerp(x0, x1, r());
    d += blade(x, at(x) + 4, lerp(minH, maxH, r() ** 1.4), (r() - 0.4) * lean, w * (0.7 + 0.6 * r()));
  }
  return d;
}

/** Straight diagonal streaks (rain), as one path. */
function streaks(w, h, r, { count, len = 40, slant = -0.25, y0 = 0, y1 = h }) {
  let d = '';
  for (let i = 0; i < count; i++) {
    const x = r() * (w + 200) - 100;
    const y = lerp(y0, y1, r());
    const L = len * (0.6 + 0.8 * r());
    d += `M${f(x)} ${f(y)}l${f(slant * L)} ${f(L)}`;
  }
  return d;
}

/** A birch trunk: white bark with a shaded side, dark lenticels and branch scars. */
function birchTrunk(x, base, top, wid, r, ink) {
  const span = base - top;
  const lean = (r() - 0.5) * wid * 0.8;
  const wt = wid * 0.72;
  const at = (y) => { const u = (base - y) / span; return [x + lean * u, lerp(wid, wt, u)]; };
  let s = `<path d="M${f(x - wid / 2)} ${f(base)}L${f(x + lean - wt / 2)} ${f(top)}L${f(x + lean + wt / 2)} ${f(top)}L${f(x + wid / 2)} ${f(base)}Z" fill="${ink.bark}"/>`;
  s += `<path d="M${f(x + wid * 0.16)} ${f(base)}L${f(x + lean + wt * 0.16)} ${f(top)}L${f(x + lean + wt / 2)} ${f(top)}L${f(x + wid / 2)} ${f(base)}Z" fill="${ink.shade}"/>`;
  let d = '';
  const count = Math.round(span / Math.max(5, wid * 0.85));
  for (let i = 0; i < count; i++) {
    const y = base - span * r() ** 1.25;
    const [c, ww] = at(y);
    const mh = Math.max(1, ww * (0.05 + 0.1 * r()));
    if (r() < 0.16 && ww > 10) {
      const cw = ww * (0.3 + 0.25 * r());
      d += `M${f(c - cw)} ${f(y - mh * 2)}L${f(c)} ${f(y + mh)}L${f(c + cw)} ${f(y - mh * 2)}L${f(c + cw)} ${f(y - mh * 0.6)}L${f(c)} ${f(y + mh * 2.4)}L${f(c - cw)} ${f(y - mh * 0.6)}Z`;
    } else {
      const mw = ww * (0.2 + 0.5 * r());
      const x0 = r() < 0.5 ? c - ww / 2 : c + ww / 2 - mw;
      d += `M${f(x0)} ${f(y)}h${f(mw)}v${f(mh)}h${f(-mw)}Z`;
    }
  }
  if (wid > 14) {
    // rougher, darker bark at the foot: a ragged band and a few streaks above it
    const fh = wid * (0.45 + 0.35 * r());
    const xl = x - wid / 2;
    const ph = r() * 6;
    let foot = `M${f(xl)} ${f(base)}`;
    for (let k = 0; k <= 8; k++) foot += `L${f(xl + (wid * k) / 8)} ${f(base - fh * (0.42 + 0.12 * Math.sin(ph + k * 1.7)))}`;
    d += `${foot}L${f(x + wid / 2)} ${f(base)}Z`;
    for (let k = 0; k < 3; k++) {
      const y = base - fh * (1.2 + k * 0.5 + r() * 0.3);
      const mw = wid * (0.4 + 0.4 * r());
      d += `M${f(xl + r() * (wid - mw))} ${f(y)}h${f(mw)}v${f(Math.max(1.2, wid * 0.06))}h${f(-mw)}Z`;
    }
  }
  return `${s}<path d="${d}" fill="${ink.mark}"/>`;
}

/* ── plates: the pictures ───────────────────────────────────────────────── */

function heroLakes() {
  const p = new Plate(2400, 1200, 'hero-lakes');
  const { w, h, seed } = p;
  const yW = h * 0.635;
  const haze = mix('paper', 'rose', 0.3);
  p.sky([[0, mix('lakeLight', 'paper', 0.3)], [0.6, mix('paper', 'lakeLight', 0.12)], [1, haze]], yW);
  const ink = ramp(mix(mix('lakeLight', 'rose', 0.3), 'paper', 0.3), mix('moss', 'sage', 0.15), 4);
  const L1 = ground(seed + 1, { w, y0: h * 0.42, amp: h * 0.07, scale: 700 });
  p.land(L1, ink[0], { mirror: true });
  p.mist(h * 0.4, h * 0.52, haze, 0.85, true);
  const L2 = ground(seed + 2, { w, y0: h * 0.5, amp: h * 0.045, scale: 520 });
  p.land(L2, ink[1], { mirror: true });
  p.forest(L2, ink[1], { minH: 6, maxH: 14 }, { mirror: true });
  p.mist(h * 0.49, h * 0.575, haze, 0.8, true);
  const L3 = ground(seed + 4, { w, y0: h * 0.565, amp: h * 0.03, scale: 420, tilt: h * 0.01 });
  p.land(L3, ink[2], { mirror: true });
  p.forest(L3, ink[2], { minH: 10, maxH: 24 }, { mirror: true });
  p.mist(h * 0.565, h * 0.625, haze, 0.65, true);
  const L4 = ground(seed + 6, { w, y0: yW - 6, amp: h * 0.012, scale: 300 });
  p.land(L4, ink[3], { mirror: true });
  p.trees(p.grove(L4, { x0: 0.3 * w, x1: w, minH: 14, maxH: 46, clumps: 7, per: 7 }), ink[3], { mirror: true });
  p.forest(L4, ink[3], { minH: 8, maxH: 20, gaps: 0.35 }, { mirror: true });
  p.water(yW, mix('lakeLight', 'paper', 0.35), { reflect: 0.5, lines: 18 });
  p.add(canoe(w * 0.62, yW + h * 0.12, 72, 'ember', { paddler: 'ink', wake: 'bright' }));
  // the near point: rising out of the water at left, its shore curving away toward us
  const xs = w * 0.22;
  const top = (x) => h * 0.75 + h * 0.07 * (x / xs) ** 2 + 5 * Math.sin(x / 37);
  const point = (x) => (x < xs ? top(x) : top(xs) + (h - top(xs) + 20) * ((x - xs) / (w * 0.1)) ** 2);
  const dark = mix('deep', 'ink', 0.25);
  p.trees(p.grove(point, { x0: -0.02 * w, x1: 0.2 * w, minH: h * 0.25, maxH: h * 0.92, clumps: 2, per: 6, width: 0.27 }), dark);
  p.trees(p.grove(point, { x0: 0.02 * w, x1: 0.23 * w, minH: h * 0.05, maxH: h * 0.16, clumps: 3, per: 4 }), dark);
  p.land(point, dark);
  // undergrowth under the spruce, so no sky shows beneath their lowest boughs
  p.land((x) => point(x) - h * 0.11 * clamp((w * 0.2 - x) / (w * 0.07)) * (0.85 + 0.15 * Math.sin(x / 23)), dark);
  return p.done(0.034);
}

function birchHollow() {
  const p = new Plate(1600, 1000, 'birch-hollow');
  const { w, h, r, seed } = p;
  const yH = h * 0.6;
  p.sky([[0, mix('paper', 'ochre', 0.2)], [1, mix('paper', 'ochre', 0.36)]], yH);
  const floor = ramp(mix('ochre', 'paper', 0.45), mix('ochre', 'ember', 0.2), 3);
  [yH, yH + 60, yH + 190].forEach((y0, i) => p.land(ground(seed + 10 + i, { w, y0, amp: 4 + i * 4, scale: 300 }), floor[i]));
  const path = trail(w * 0.53, yH + 4, w * 0.43, h + 10, w * 0.14, { bend: -w * 0.07 });
  p.add(`<path d="${path.d}" fill="${mix('ochre', 'paper', 0.55)}"/>`);
  // leaf litter on the near floor, thicker at the edges of the path
  let litter = '';
  for (let i = 0; i < 260; i++) {
    const y = lerp(yH + 70, h, r() ** 0.7);
    const x = r() * w;
    const s = (2 + r() * 3) * (0.4 + (y - yH) / (h - yH));
    litter += `M${f(x - s)} ${f(y)}L${f(x)} ${f(y - s * 0.45)}L${f(x + s)} ${f(y)}L${f(x)} ${f(y + s * 0.45)}Z`;
  }
  p.add(`<path d="${litter}" fill="${mix('ochre', 'ember', 0.4)}" opacity="0.55"/>`);
  const bands = [
    { y: [yH + 2, yH + 22], n: 34, canopy: h * 0.36, amp: 30, crown: mix('ochre', 'paper', 0.5), bark: mix('bright', 'ochre', 0.2), shade: mix('fog', 'ochre', 0.25), mark: mix('stone', 'ochre', 0.35) },
    { y: [yH + 30, yH + 110], n: 16, canopy: h * 0.2, amp: 36, crown: mix('ochre', 'paper', 0.2), bark: mix('bright', 'ochre', 0.07), shade: mix('fog', 'ochre', 0.15), mark: mix('ink', 'stone', 0.4) },
    { y: [yH + 160, h * 1.02], n: 6, canopy: h * 0.05, amp: 30, crown: mix('ochre', 'ember', 0.32), bark: hex('bright'), shade: mix('fog', 'lichen', 0.35), mark: mix('ink', 'stone', 0.15) },
  ];
  bands.forEach((b, bi) => {
    const list = [];
    for (let i = 0, tries = 0; i < b.n && tries < 400; tries++) {
      const base = lerp(b.y[0], b.y[1], r());
      const u = (base - yH) / (h - yH);
      const wid = 4 + 64 * u ** 1.15;
      const x = bi === 2 ? lerp(-0.04, 1.04, (i + r() * 0.6) / b.n) * w : r() * w;
      if (path.on(x, base, wid)) continue;
      if (list.some((t) => Math.abs(t.x - x) < (t.wid + wid) * 0.9)) continue;
      list.push({ x, base, wid });
      i++;
    }
    list.sort((a, b2) => a.base - b2.base).forEach((t) => {
      p.add(`<path d="M${f(t.x - t.wid * 0.3)} ${f(t.base)}L${f(t.x + t.wid * 2.4)} ${f(t.base + t.wid * 0.12)}L${f(t.x + t.wid * 0.5)} ${f(t.base + t.wid * 0.22)}Z" fill="${mix('ochre', 'ink', 0.3)}" opacity="0.3"/>`);
      p.add(birchTrunk(t.x, t.base, -20, t.wid, r, b));
    });
    // a warm haze between the bands, so the far trunks sit back
    if (bi < 2) p.mist(yH - h * 0.45, yH + 30 + bi * 60, mix('paper', 'ochre', 0.3), 0.35 - bi * 0.12);
  });
  let d = '';
  for (let i = 0; i < 22; i++) {
    const x = r() * w;
    const y = h * (0.15 + 0.55 * r());
    const s = 3 + r() * 4;
    const a = r() * Math.PI;
    const ca = Math.cos(a) * s;
    const sa = Math.sin(a) * s;
    d += `M${f(x - ca)} ${f(y - sa)}L${f(x - sa * 0.4)} ${f(y + ca * 0.4)}L${f(x + ca)} ${f(y + sa)}L${f(x + sa * 0.4)} ${f(y - ca * 0.4)}Z`;
  }
  p.add(`<path d="${d}" fill="${mix('ochre', 'ember', 0.45)}"/>`);
  return p.done(0.045);
}

function riverFord() {
  const p = new Plate(1600, 1000, 'river-ford');
  const { w, h, r, seed } = p;
  const yH = h * 0.5;
  const haze = mix('paper', 'ochre', 0.14);
  p.sky([[0, mix('lakeLight', 'paper', 0.25)], [1, haze]], yH);
  const far = ground(seed + 1, { w, y0: h * 0.38, amp: h * 0.05, scale: 520 });
  p.land(far, mix('sage', 'paper', 0.55));
  p.mist(h * 0.37, h * 0.47, haze, 0.8);
  const mid = ground(seed + 2, { w, y0: h * 0.47, amp: h * 0.025, scale: 380 });
  const midInk = mix('sage', 'paper', 0.25);
  p.land(mid, midInk);
  p.forest(mid, midInk, { minH: 10, maxH: 26, gaps: 0.1 });
  p.mist(h * 0.45, h * 0.52, haze, 0.45);
  // the valley floor in late summer, warmer and nearer toward us
  const floor = ramp(mix('sage', 'lichen', 0.5), mix('lichen', 'ochre', 0.25), 4);
  [yH + 2, h * 0.58, h * 0.7, h * 0.84].forEach((y0, i) => p.land(ground(seed + 10 + i, { w, y0, amp: 3 + i * 2, scale: 300 }), floor[i]));
  // the river comes out of the distance and bends away to the right past us
  const river = trail(w * 0.5, yH + 26, w * 0.98, h + 12, w * 0.4, { bend: -w * 0.16, halfTop: 6 });
  p.add(`<path d="${river.d}" fill="${mix('lakeLight', 'lake', 0.12)}"/>`);
  // shallows along both banks, gravel showing through
  const shallow = [];
  const shallowR = [];
  for (let k = 0; k <= 48; k++) {
    const y = yH + 4 + ((h + 12 - yH - 4) * k) / 48;
    const [c, hw] = river.at(y);
    const t = 3 + hw * 0.12;
    shallow.push([c - hw, y]);
    shallowR.unshift([c - hw + t, y]);
  }
  p.add(`<path d="${poly([...shallow, ...shallowR])}" fill="${mix('lakeLight', 'lichen', 0.5)}"/>`);
  // riffles running across the current, longer as they come closer
  let rif = '';
  let rifDark = '';
  for (let j = 0; j < 30; j++) {
    const u = (j + 0.5) / 30;
    const y = yH + 10 + (h - yH - 10) * u ** 1.3;
    const [c, hw] = river.at(y);
    const s = 0.25 + u * 1.3;
    for (let x = c - hw + 10 * s + r() * 30 * s; x < c + hw - 10 * s;) {
      const len = Math.min((14 + r() * 50) * s, c + hw - x);
      if (r() < 0.55) {
        rif += `M${f(x)} ${f(y)}h${f(len)}v${f(Math.max(0.8, 1.5 * s))}h${f(-len)}Z`;
        rifDark += `M${f(x + 5 * s)} ${f(y + 2.5 * s)}h${f(len * 0.8)}v${f(Math.max(0.8, 1.2 * s))}h${f(-len * 0.8)}Z`;
      }
      x += len + (20 + r() * 70) * s;
    }
  }
  p.add(`<path d="${rifDark}" fill="${hex('lake')}" opacity="0.35"/><path d="${rif}" fill="${hex('bright')}" opacity="0.6"/>`);
  // the wood the river comes out of
  const woodInk = mix('sage', 'moss', 0.3);
  p.forest(ground(seed + 6, { w, y0: yH + 34, amp: 3, scale: 200 }), woodInk, { minH: 18, maxH: 60, gaps: 0.05, body: 0.5 });
  // spruce along both banks, smaller with distance
  const dark = ramp(mix('moss', 'sage', 0.45), mix('deep', 'ink', 0.2), 6);
  for (let i = 0; i < 6; i++) {
    const u = 0.04 + 0.13 * i + 0.03 * r();
    const y = yH + 4 + (h - yH) * u;
    const [c, hw] = river.at(y);
    const Hmax = 24 + 900 * u ** 1.6;
    const ink = dark[i];
    const leftEdge = c - hw - 14 * (0.3 + u * 2);
    const rightEdge = c + hw + 14 * (0.3 + u * 2);
    if (i < 5) p.trees(p.grove(flat(y), { x0: Math.max(-60, leftEdge - Hmax * 2.4), x1: leftEdge, minH: Hmax * 0.45, maxH: Hmax, clumps: 2, per: 4 }), ink);
    if (rightEdge < w + 40) p.trees(p.grove(flat(y), { x0: rightEdge, x1: Math.min(w + 60, rightEdge + Hmax * 2.6), minH: Hmax * 0.45, maxH: Hmax, clumps: 2, per: 4 }), ink);
  }
  // the ford: a row of stepping stones across, foam on their downstream side
  const ys = h * 0.745;
  const [cs, hws] = river.at(ys);
  const stones = [];
  for (let x = cs - hws + 26; x < cs + hws - 20; x += 50 + r() * 14) stones.push({ x, y: ys + (r() - 0.5) * 6, s: 0.8 + r() * 0.4 });
  let foam = '';
  stones.forEach(({ x, y, s }) => {
    foam += `M${f(x - 24 * s)} ${f(y + 7)}q${f(24 * s)} ${f(8 * s)} ${f(48 * s)} 0q${f(-24 * s)} ${f(14 * s)} ${f(-48 * s)} 0Z`;
    foam += `M${f(x - 10 * s)} ${f(y + 18 * s)}h${f(30 * s)}v1.6h${f(-30 * s)}Z`;
  });
  p.add(`<path d="${foam}" fill="${hex('bright')}" opacity="0.8"/>`);
  stones.forEach(({ x, y, s }) => p.add(stone(x, y, 24 * s, 10 * s, r, { body: mix('stone', 'ink', 0.2), top: mix('stone', 'fog', 0.5), id: p.id('s') })));
  // our bank: a worn path down to the first stone, grass, a tall spruce framing the left
  const path = trail(stones[0].x - 16, ys - 2, w * 0.2, h + 10, w * 0.045, { halfTop: 9, bend: w * 0.05 });
  p.add(`<path d="${path.d}" fill="${mix('paper', 'lichen', 0.45)}"/>`);
  const nb = (x) => h * 0.98 + 6 * Math.sin(x / 40);
  p.trees(p.grove(nb, { x0: -60, x1: w * 0.06, minH: 500, maxH: 980, clumps: 1, per: 3, width: 0.3 }), mix('deep', 'ink', 0.3));
  const grass = (x) => (river.on(x, h * 0.96, 10) ? h + 200 : h * 0.97);
  p.add(`<path d="${meadowGrass(grass, r, { x0: -20, x1: w * 0.6, count: 160, minH: 30, maxH: 110, w: 3.5 })}" fill="${mix('ochre', 'moss', 0.45)}"/>`);
  return p.done(0.045);
}

function nightMeadow() {
  const p = new Plate(1600, 1000, 'night-meadow');
  const { w, h, r, seed } = p;
  const yH = h * 0.64;
  p.sky([[0, mix('ink', 'lake', 0.2)], [0.65, mix('ink', 'lake', 0.42)], [1, mix('lake', 'ink', 0.4)]], yH);
  let st = '';
  for (let i = 0; i < 900; i++) {
    let x = r() * w;
    let y = r() * yH * 0.98;
    if (i % 3 === 0) {
      const t = r();
      x = lerp(-0.1, 1.1, t) * w;
      y = lerp(0.05, 0.75, 1 - t) * yH + (r() + r() - 1) * 90;
    }
    const big = r() > 0.97;
    const rad = big ? 1.5 + r() * 0.8 : 0.45 + r() * 0.7;
    st += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(rad)}" fill="${hex('bright')}" opacity="${f(0.35 + r() * 0.6)}"/>`;
  }
  p.add(st);
  const far = ground(seed + 1, { w, y0: h * 0.6, amp: h * 0.03, scale: 500 });
  p.land(far, mix('ink', 'lake', 0.32));
  const tl = ground(seed + 2, { w, y0: yH, amp: 6, scale: 300 });
  const line = mix('ink', 'deep', 0.4);
  p.land(tl, line);
  p.trees(p.grove(tl, { x0: -60, x1: w + 60, minH: 30, maxH: 150, clumps: 8, per: 7 }), line);
  p.forest(tl, line, { minH: 12, maxH: 40, gaps: 0.18 });
  const m1 = ground(seed + 3, { w, y0: yH + 14, amp: 4, scale: 300 });
  p.land(m1, mix('deep', 'lake', 0.1));
  const m2 = ground(seed + 4, { w, y0: h * 0.76, amp: 10, scale: 400, tilt: 30 });
  p.land(m2, mix('deep', 'ink', 0.25));
  // the tent, lit from inside, and its light lying on the grass in front of the door
  const tx = w * 0.6;
  const ty = m2(tx) + 52;
  const warm = mix('ochre', 'rose', 0.4);
  const spill = p.grad([[0, warm, 0.6], [1, warm, 0]], ty, ty + 46);
  p.add(`<path d="M${f(tx - 22)} ${f(ty - 1)}L${f(tx + 22)} ${f(ty - 1)}L${f(tx + 120)} ${f(ty + 40)}L${f(tx - 170)} ${f(ty + 44)}Z" fill="${spill}" filter="${p.blur('16 6')}"/>`);
  p.add(tent(tx, ty, 1.15, mix('ember', 'ochre', 0.2), { flank: mix('ember', 'ink', 0.45), door: mix('ochre', 'bright', 0.55), lines: mix('ink', 'lake', 0.4) }));
  const fg = ground(seed + 5, { w, y0: h * 0.97, amp: 10, scale: 300 });
  p.land(fg, hex('ink'));
  p.add(`<path d="${meadowGrass(fg, r, { x0: -20, x1: w + 20, count: 320, minH: 20, maxH: 110, w: 3.5 })}" fill="${hex('ink')}"/>`);
  return p.done(0.04);
}

function kettleMarsh() {
  const p = new Plate(1600, 1000, 'kettle-marsh');
  const { w, h, r, seed } = p;
  const yH = h * 0.5;
  const fog = mix('bright', 'rose', 0.12);
  p.sky([[0, mix('fog', 'rose', 0.3)], [1, fog]], yH);
  const inks = [mix('fog', 'sage', 0.25), mix('fog', 'sage', 0.45), mix('sage', 'moss', 0.15)];
  [h * 0.42, h * 0.46, h * 0.495].forEach((y0, i) => {
    const g = ground(seed + i, { w, y0, amp: 6, scale: 300 });
    p.land(g, inks[i]);
    p.trees(p.grove(g, { x0: -40, x1: w + 40, minH: 20 + i * 12, maxH: 60 + i * 50, clumps: 5 + i, per: 6 }), inks[i]);
    p.forest(g, inks[i], { minH: 8 + i * 4, maxH: 22 + i * 10 });
    p.mist(y0 - 50 - i * 20, y0 + 6, fog, 0.85);
  });
  p.add(`<rect y="${f(yH)}" width="${w}" height="${f(h - yH)}" fill="${mix('lakeLight', 'fog', 0.45)}"/>`);
  // sedge hummocks: grassy tops tapering at the ends, and their soft reflections
  const sedge = ramp(mix('lichen', 'fog', 0.4), mix('sage', 'moss', 0.25), 5);
  [0.53, 0.575, 0.635, 0.72, 0.84].forEach((fy, i) => {
    const base = ground(seed + 20 + i, { w, y0: h * fy, amp: 3 + i * 2, scale: 200 });
    const n = fbm1(seed + 30 + i, 2);
    const th = 8 + i * 11;
    const step = 3 + i;
    let d = '';
    let refl = '';
    let run = [];
    const flush = () => {
      if (run.length > 3) {
        const a = run[0];
        const b = run.at(-1);
        const env = (x) => Math.sin((Math.PI * (x - a)) / (b - a)) ** 0.45;
        const top = run.map((x, k) => [x, base(x) - th * env(x) * (k % 2 ? 1 : 0.62 + 0.2 * r())]);
        d += poly([...top, ...run.map((x) => [x, base(x)]).reverse()]);
        refl += poly([...run.map((x) => [x, base(x)]), ...run.map((x) => [x, base(x) + th * 0.45 * env(x)]).reverse()]);
      }
      run = [];
    };
    for (let x = -12; x <= w + 12; x += step) { if (n(x / 220) > 0.44) run.push(x); else flush(); }
    flush();
    p.add(`<path d="${refl}" fill="${sedge[i]}" opacity="0.28"/><path d="${d}" fill="${sedge[i]}"/>`);
  });
  // the boardwalk running away into the fog
  const vx = w * 0.53;
  const vy = yH + 6;
  const bw = (y) => lerp(3, w * 0.13, (y - vy) / (h - vy));
  const cxAt = (y) => lerp(vx, w * 0.47, (y - vy) / (h - vy));
  const deck = mix('stone', 'ochre', 0.3);
  p.add(`<path d="M${f(cxAt(vy) - bw(vy))} ${f(vy)}L${f(cxAt(vy) + bw(vy))} ${f(vy)}L${f(cxAt(h) + bw(h))} ${f(h + 2)}L${f(cxAt(h) - bw(h))} ${f(h + 2)}Z" fill="${deck}"/>`);
  p.add(`<path d="M${f(cxAt(vy) - bw(vy))} ${f(vy)}L${f(cxAt(vy) - bw(vy))} ${f(vy + 1)}L${f(cxAt(h) - bw(h))} ${f(h + 24)}L${f(cxAt(h) - bw(h))} ${f(h)}Z" fill="${mix('stone', 'ink', 0.4)}"/>`);
  let gaps = '';
  for (let k = 1; k < 60; k++) {
    const y = vy + (h - vy) / (1 + (60 - k) * 0.22);
    const t = Math.max(0.6, ((y - vy) / (h - vy)) * 4);
    gaps += `M${f(cxAt(y) - bw(y))} ${f(y)}L${f(cxAt(y) + bw(y))} ${f(y)}L${f(cxAt(y) + bw(y))} ${f(y + t)}L${f(cxAt(y) - bw(y))} ${f(y + t)}Z`;
  }
  p.add(`<path d="${gaps}" fill="${mix('stone', 'ink', 0.35)}"/>`);
  p.add(`<rect y="${f(yH - 10)}" width="${w}" height="${f(h * 0.22)}" fill="${p.grad([[0, fog, 0.95], [1, fog, 0]], yH - 10, yH + h * 0.21)}"/>`);
  // reeds and cattails close by, left and right of the walk
  const reed = mix('moss', 'deep', 0.35);
  let d = '';
  let stalks = '';
  let heads = '';
  const reedsAt = (x0, x1, count, cats) => {
    for (let i = 0; i < count; i++) {
      const x = lerp(x0, x1, r());
      d += blade(x, h + 6, 110 + r() * 300, (r() - 0.5) * 60, 3 + r() * 3);
    }
    for (let i = 0; i < cats; i++) {
      const x = lerp(x0, x1, r());
      const H = 220 + r() * 230;
      const lean = (r() - 0.5) * 40;
      const tx = x + lean;
      const ty = h + 6 - H;
      stalks += `M${f(x)} ${f(h + 6)}Q${f(x + lean * 0.2)} ${f(h - H * 0.5)} ${f(tx)} ${f(ty)}`;
      const hx = x + lean * 0.86;
      const hy = h + 6 - H * 0.86;
      heads += `<rect x="${f(hx - 5.5)}" y="${f(hy - 22)}" width="11" height="${f(40 + r() * 14)}" rx="5.5" fill="${mix('ember', 'ink', 0.6)}" transform="rotate(${f(lean / 5)} ${f(hx)} ${f(hy)})"/>`;
    }
  };
  reedsAt(-20, w * 0.3, 90, 9);
  reedsAt(w * 0.68, w + 20, 80, 8);
  p.add(`<path d="${d}" fill="${reed}"/><path d="${stalks}" stroke="${reed}" stroke-width="2.6" fill="none" stroke-linecap="round"/>${heads}`);
  return p.done(0.04);
}

function firstSnow() {
  const p = new Plate(1600, 1000, 'first-snow');
  const { w, h, r, seed } = p;
  const snowField = mix('bright', 'paper', 0.4);
  p.sky([[0, mix('fog', 'stone', 0.22)], [1, mix('bright', 'fog', 0.35)]], h * 0.55);
  const far = ground(seed + 1, { w, y0: h * 0.41, amp: h * 0.045, scale: 520 });
  p.land(far, mix('fog', 'lakeLight', 0.4));
  p.forest(far, mix('fog', 'stone', 0.4), { minH: 6, maxH: 16 });
  p.mist(h * 0.4, h * 0.5, 'bright', 0.8);
  // the wood along the far side of the field, snow on its spires
  const mid = ground(seed + 2, { w, y0: h * 0.54, amp: h * 0.01, scale: 380 });
  const midInk = mix('stone', 'moss', 0.3);
  p.forest(mid, midInk, { minH: 30, maxH: 90, gaps: 0.05, body: 0.5 });
  p.trees(p.grove(mid, { x0: -40, x1: w + 40, minH: 80, maxH: 190, clumps: 7, per: 4 }), midInk, { snow: 'bright' });
  p.land(mid, snowField);
  p.mist(h * 0.46, h * 0.6, 'bright', 0.3);
  // the open field: drifts, each with a soft blue shadow on its lee side, fading out along its length
  const shadowInk = mix('lakeLight', 'fog', 0.25);
  [[0.635, 16, -30], [0.745, 24, 40], [0.865, 32, -50]].forEach(([fy, depth, tilt], i) => {
    const crest = ground(seed + 10 + i, { w, y0: h * fy, amp: 10 + i * 6, scale: 300 + i * 80, tilt });
    const env = fbm1(seed + 20 + i, 2);
    p.land(crest, snowField);
    const lo = (x) => crest(x) + 2 + depth * clamp((env(x / 260) - 0.3) / 0.35) * (0.7 + 0.6 * env(x / 90));
    const top = [];
    const bot = [];
    for (let x = -12; x <= w + 12; x += 6) { top.push([x, crest(x)]); bot.unshift([x, lo(x)]); }
    p.add(`<path d="${poly([...top, ...bot])}" fill="${p.grad([[0, shadowInk, 0.9], [1, shadowInk, 0]], h * fy - 10, h * fy + depth * 1.6)}"/>`);
  });
  // close by: a snowy rise with tall spruce at left, a smaller stand at right
  const rise = (x) => h * 0.93 - 110 * Math.exp(-(((x - w * 0.13) / 360) ** 2)) + 5 * Math.sin(x / 90);
  const rise2 = (x) => h * 0.9 - 60 * Math.exp(-(((x - w * 0.92) / 260) ** 2)) + 4 * Math.sin(x / 70);
  const dark = mix('deep', 'moss', 0.12);
  const left = [plant(rise, w * 0.06, 780, 0.32), plant(rise, w * 0.15, 620, 0.32), plant(rise, w * 0.21, 430, 0.32), plant(rise, w * 0.0, 520, 0.32), plant(rise, w * 0.26, 250, 0.32)];
  const right = [plant(rise2, w * 0.88, 420, 0.32), plant(rise2, w * 0.95, 330, 0.32), plant(rise2, w * 0.84, 210, 0.32)];
  p.trees(right, dark, { snow: 'bright', width: 0.32 });
  p.land(rise2, snowField);
  p.trees(left, dark, { snow: 'bright', width: 0.32 });
  p.land(rise, snowField);
  let sh = '';
  for (const t of [...left, ...right]) {
    const gy = t.base - t.H * 0.05;
    const L = t.H * 0.6;
    sh += `M${f(t.x - t.H * 0.04)} ${f(gy)}L${f(t.x + L)} ${f(gy + L * 0.06)}L${f(t.x + L * 0.92)} ${f(gy + L * 0.09)}L${f(t.x)} ${f(gy + 4)}Z`;
  }
  p.add(`<path d="${sh}" fill="${shadowInk}" opacity="0.6"/>`);
  let s = '';
  for (let i = 0; i < 560; i++) {
    const big = r() ** 3;
    s += `<circle cx="${f(r() * w)}" cy="${f(r() * h)}" r="${f(1 + big * 3.4)}" fill="${hex('bright')}" opacity="${f(0.55 + r() * 0.45)}"/>`;
  }
  p.add(s);
  return p.done(0.035);
}

function basswoodRidge() {
  const p = new Plate(1600, 1000, 'basswood-ridge');
  const { w, h, r, seed } = p;
  const haze = mix('paper', 'rose', 0.35);
  p.sky([[0, mix('rose', 'lakeLight', 0.45)], [0.45, hex('rose')], [1, mix('paper', 'rose', 0.2)]], h * 0.62);
  const inks = [mix('rose', 'paper', 0.25), mix('rose', 'lake', 0.2), mix('rose', 'lake', 0.4), mix('lake', 'stone', 0.5), mix('stone', 'deep', 0.55)];
  const rows = [[0.46, 0.06, 700], [0.53, 0.05, 520], [0.6, 0.045, 420], [0.68, 0.04, 360], [0.77, 0.04, 300]];
  rows.forEach(([y0, amp, scale], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: h * amp, scale });
    p.land(g, inks[i]);
    if (i >= 2) p.forest(g, inks[i], { minH: 4 + i * 3, maxH: 10 + i * 6 });
    if (i < rows.length - 1) p.mist(h * (y0 - 0.01), h * (rows[i + 1][0] + 0.01), haze, 0.75);
  });
  const crest = ground(seed + 9, { w, y0: h * 0.86, amp: h * 0.02, scale: 300, tilt: -h * 0.14 });
  const near = mix('deep', 'ink', 0.35);
  p.land(crest, near);
  p.trees(p.grove(crest, { x0: w * 0.86, x1: w * 1.04, minH: 60, maxH: 260, clumps: 1, per: 5 }), near);
  p.trees(p.grove(crest, { x0: -40, x1: w * 0.12, minH: 30, maxH: 110, clumps: 1, per: 4 }), near);
  const hx = w * 0.7;
  p.add(hiker(hx, crest(hx) + 2, 46, near, 'ember', -1));
  return p.done(0.04);
}

function tamarackIce() {
  const p = new Plate(1600, 1000, 'tamarack-ice');
  const { w, h, r, seed } = p;
  const yS = h * 0.43;
  p.sky([[0, mix('lakeLight', 'fog', 0.45)], [1, hex('bright')]], yS);
  const hills = ground(seed + 1, { w, y0: h * 0.36, amp: h * 0.035, scale: 520 });
  p.land(hills, mix('lakeLight', 'fog', 0.35));
  p.forest(hills, mix('lakeLight', 'stone', 0.22), { minH: 6, maxH: 14 });
  p.mist(h * 0.36, h * 0.42, 'bright', 0.7);
  // the far shore: a mixed wood, the tamaracks gone gold
  const shore = ground(seed + 2, { w, y0: yS - 3, amp: 3, scale: 200 });
  const tam = { width: 0.24, droop: 0.12, jitter: 0.7 };
  const sprInk = mix('deep', 'stone', 0.3);
  p.forest(shore, sprInk, { minH: 14, maxH: 40, gaps: 0.12 });
  p.trees(p.grove(shore, { x0: -40, x1: w + 40, minH: 40, maxH: 110, clumps: 7, per: 4 }), sprInk);
  p.trees(p.grove(shore, { x0: -40, x1: w + 40, minH: 40, maxH: 120, clumps: 9, per: 4, width: 0.24 }), mix('ochre', 'ember', 0.1), tam);
  p.land(shore, mix('fog', 'stone', 0.2));
  const ice = mix('bright', 'lakeLight', 0.35);
  p.add(`<rect y="${f(yS)}" width="${w}" height="${f(h - yS)}" fill="${ice}"/>`);
  // clear black ice between the snow: flat angular plates
  let plates = '';
  let rims = '';
  for (let i = 0; i < 8; i++) {
    const cy = lerp(yS + 30, h * 0.97, (i + r()) / 8);
    const u = (cy - yS) / (h - yS);
    const cx = r() * w;
    const rx = (90 + 230 * r()) * (0.35 + u);
    const ry = rx * (0.08 + 0.05 * u);
    const pts = [];
    for (let k = 0; k < 7; k++) {
      const a = ((k + 0.3 * r()) / 7) * Math.PI * 2;
      const kk = 0.55 + 0.5 * r();
      pts.push([cx + Math.cos(a) * rx * kk, cy + Math.sin(a) * ry * kk]);
    }
    plates += poly(pts);
    rims += poly(pts.slice(0, 4).map(([x, y]) => [x, y + 1.5]), false);
  }
  p.add(`<path d="${plates}" fill="${mix('lakeLight', 'lake', 0.22)}" opacity="0.5"/><path d="${rims}" stroke="${hex('bright')}" stroke-width="1.2" fill="none"/>`);
  // cracks: thin dark lines, each with a bright lip
  let dk = '';
  let lt = '';
  for (let i = 0; i < 14; i++) {
    let y = lerp(yS + 14, h, r() ** 1.3);
    let x = r() * w;
    const u = (y - yS) / (h - yS);
    const pts = [[x, y]];
    const dir = r() < 0.5 ? -1 : 1;
    for (let k = 0; k < 6 + Math.floor(r() * 5); k++) {
      x += (30 + r() * 90) * (0.4 + u) * dir;
      y += (r() - 0.5) * 16 * (0.3 + u);
      pts.push([x, y]);
    }
    dk += poly(pts, false);
    lt += poly(pts.map(([a, b]) => [a, b + 1.4 + u]), false);
  }
  p.add(`<path d="${lt}" stroke="${hex('bright')}" stroke-width="1.2" fill="none" opacity="0.9"/><path d="${dk}" stroke="${mix('lake', 'lakeLight', 0.3)}" stroke-width="1.1" fill="none" opacity="0.75"/>`);
  // the pressure ridge: a long jumble of upturned slabs with its shadow
  const pr = ground(seed + 7, { w, y0: h * 0.6, amp: 14, scale: 260, tilt: 40 });
  const hn = fbm1(seed + 8, 2);
  let lit = '';
  let dark = '';
  const shadowTop = [];
  const shadowBot = [];
  for (let x = -20; x < w + 20;) {
    const y = pr(x);
    const s = 0.6 + ((y - yS) / (h - yS)) * 1.2;
    const ht = (3 + 24 * hn(x / 110) ** 1.6) * s * (0.6 + 0.6 * r());
    const bw = (8 + r() * 16) * s;
    const ax = x + bw * (0.3 + 0.35 * r());
    lit += `M${f(x)} ${f(y + 1)}L${f(ax)} ${f(y - ht)}L${f(ax + bw * 0.12)} ${f(y + 1)}Z`;
    dark += `M${f(ax)} ${f(y - ht)}L${f(x + bw)} ${f(y + 1)}L${f(ax + bw * 0.12)} ${f(y + 1)}Z`;
    x += bw * (0.5 + 0.3 * r());
  }
  for (let x = -20; x <= w + 20; x += 8) { shadowTop.push([x, pr(x)]); shadowBot.unshift([x, pr(x) + 5 + 5 * hn(x / 110)]); }
  p.add(`<path d="${poly([...shadowTop, ...shadowBot])}" fill="${mix('lakeLight', 'stone', 0.25)}" opacity="0.65"/><path d="${dark}" fill="${mix('lakeLight', 'stone', 0.32)}"/><path d="${lit}" fill="${hex('bright')}"/>`);
  // footprints walking out toward the far shore
  let fp = '';
  const yE = yS - 8;
  for (let i = 0; i < 30; i++) {
    const z = 1 + i * 0.3;
    const y = yE + (h * 1.04 - yE) / z;
    const s = 1 / z;
    const x = lerp(w * 0.5, w * 0.6, 1 - s) + (i % 2 ? 1 : -1) * 34 * s;
    const fw = 62 * s;
    const fh = 24 * s;
    fp += `<rect x="${f(x - fw / 2)}" y="${f(y - fh / 2)}" width="${f(fw)}" height="${f(fh)}" rx="${f(fh / 2)}" fill="${mix('lakeLight', 'stone', 0.3)}" opacity="0.75"/>`;
  }
  p.add(fp);
  // a snowy point at left with three tamaracks close by
  const bank = (x) => (x < w * 0.24 ? h * 0.8 + 10 * Math.sin(x / 60) + (x / (w * 0.24)) ** 2 * h * 0.06 : h * 0.86 + (h * 0.2) * ((x - w * 0.24) / (w * 0.08)) ** 2);
  const near = p.grove(bank, { x0: w * 0.02, x1: w * 0.2, minH: 220, maxH: 560, clumps: 1, per: 4, width: 0.24 });
  p.trees(near, mix('ochre', 'ember', 0.15), tam);
  p.trees(p.grove(bank, { x0: -20, x1: w * 0.08, minH: 200, maxH: 420, clumps: 1, per: 2 }), mix('deep', 'ink', 0.2));
  p.land(bank, mix('bright', 'paper', 0.3));
  p.land((x) => bank(x) + 6, mix('lakeLight', 'fog', 0.3), { op: 0.6 });
  return p.done(0.035);
}

function portageAutumn() {
  const p = new Plate(1600, 1000, 'portage-autumn');
  const { w, h, r, seed } = p;
  const yH = h * 0.6;
  const haze = mix('paper', 'ochre', 0.2);
  p.sky([[0, mix('paper', 'lakeLight', 0.3)], [1, haze]], yH);
  const tam = { width: 0.24, droop: 0.06, jitter: 0.9 };
  const tamInk = ramp(mix('ochre', 'paper', 0.45), mix('ochre', 'ember', 0.28), 5);
  const sprInk = ramp(mix('sage', 'paper', 0.35), mix('deep', 'ink', 0.3), 5);
  const floorInk = ramp(mix('ochre', 'moss', 0.25), mix('ochre', 'moss', 0.5), 5);
  // the wood closing the far end of the trail
  const back = ground(seed + 1, { w, y0: yH + 4, amp: 3, scale: 300 });
  p.forest(back, mix('sage', 'paper', 0.5), { minH: 40, maxH: 110, gaps: 0.05 });
  p.trees(p.grove(back, { x0: -40, x1: w + 40, minH: 60, maxH: 180, clumps: 8, per: 4, width: 0.24 }), mix('ochre', 'paper', 0.55), tam);
  p.land(back, mix('ochre', 'paper', 0.45));
  p.mist(yH - 160, yH + 6, haze, 0.4);
  const path = trail(w * 0.53, yH + 6, w * 0.43, h + 10, w * 0.15, { bend: w * 0.05 });
  // rows of spruce and tamarack on both sides, nearer and larger; a clearing at left for the canoe rack
  for (let i = 0; i < 5; i++) {
    const u = (i + 1) / 5;
    const y = yH + 8 + u ** 1.8 * (h * 0.36);
    const g = flat(y);
    const [c, hw] = path.at(y);
    const gap = hw + lerp(30, 230, u);
    const clearing = i === 3 ? 420 : 0;
    const Hmax = lerp(160, 1150, u ** 1.6);
    for (const [x0, x1] of [[-80, i === 4 ? 30 : c - gap - clearing], [c + gap, w + 80]]) {
      if (x1 - x0 < 30) continue;
      p.trees(p.grove(g, { x0, x1, minH: Hmax * 0.45, maxH: Hmax, clumps: i < 3 ? 2 : 1, per: 4 }), sprInk[i]);
      p.trees(p.grove(g, { x0, x1, minH: Hmax * 0.4, maxH: Hmax * 0.92, clumps: i < 3 ? 2 : 1, per: 3, width: 0.24 }), tamInk[i], tam);
    }
    p.add(`<rect y="${f(y - 2)}" width="${w}" height="${f(h - y + 2)}" fill="${floorInk[i]}"/>`);
    if (i === 3) {
      // the canoe, hull up on its rack in the clearing beside the trail
      const rx = Math.min(c - gap + 60, w * 0.25);
      const ry = y + 34;
      const post = mix('stone', 'ink', 0.4);
      p.add(`<path d="M${f(rx - 210)} ${f(ry + 2)}L${f(rx + 230)} ${f(ry + 2)}L${f(rx + 210)} ${f(ry + 10)}L${f(rx - 190)} ${f(ry + 10)}Z" fill="${mix('ochre', 'ink', 0.45)}" opacity="0.3"/>`);
      p.add(`<rect x="${f(rx - 175)}" y="${f(ry - 70)}" width="350" height="10" fill="${post}"/>`);
      for (const dx of [-135, 125]) p.add(`<path d="M${f(rx + dx - 7)} ${f(ry + 2)}L${f(rx + dx - 6)} ${f(ry - 72)}L${f(rx + dx + 6)} ${f(ry - 72)}L${f(rx + dx + 7)} ${f(ry + 2)}Z" fill="${post}"/>`);
      p.add(canoeOver(rx, ry - 72, 420, 'ember'));
    }
  }
  p.add(`<path d="${path.d}" fill="${mix('lichen', 'ochre', 0.25)}"/>`);
  let litter = '';
  for (let i = 0; i < 200; i++) {
    const y = lerp(yH + 60, h, r() ** 0.7);
    const x = r() * w;
    const s = (2 + r() * 3) * (0.4 + (y - yH) / (h - yH));
    litter += `M${f(x - s)} ${f(y)}L${f(x)} ${f(y - s * 0.45)}L${f(x + s)} ${f(y)}L${f(x)} ${f(y + s * 0.45)}Z`;
  }
  p.add(`<path d="${litter}" fill="${mix('ochre', 'paper', 0.25)}" opacity="0.6"/>`);
  return p.done(0.045);
}

function duskPaddle() {
  const p = new Plate(1600, 1000, 'dusk-paddle');
  const { w, h, r, seed } = p;
  const yW = h * 0.57;
  p.sky([[0, mix('lake', 'lakeLight', 0.15)], [0.55, mix('rose', 'lakeLight', 0.45)], [1, mix('rose', 'paper', 0.25)]], yW);
  const far = ground(seed + 1, { w, y0: h * 0.5, amp: h * 0.035, scale: 520 });
  p.land(far, mix('lake', 'rose', 0.35), { mirror: true });
  p.mist(h * 0.5, h * 0.56, mix('rose', 'paper', 0.25), 0.6, true);
  const shoreInk = mix('deep', 'ink', 0.45);
  const left = (x) => yW - 8 - 120 * Math.exp(-(((x + 60) / 520) ** 2)) - 6 * Math.sin(x / 41);
  p.land(left, shoreInk, { mirror: true });
  p.trees(p.grove(left, { x0: -40, x1: w * 0.4, minH: 30, maxH: 150, clumps: 4, per: 6 }), shoreInk, { mirror: true });
  const right = (x) => yW - 4 - 46 * Math.exp(-(((x - w * 1.02) / 360) ** 2));
  p.land(right, shoreInk, { mirror: true });
  p.trees(p.grove(right, { x0: w * 0.74, x1: w + 40, minH: 20, maxH: 90, clumps: 3, per: 5 }), shoreInk, { mirror: true });
  p.water(yW, mix('rose', 'lake', 0.42), { reflect: 0.7, blur: '0.6 2', lines: 16, lineColor: mix('rose', 'paper', 0.3), lineOp: 0.55, glint: 0.6 });
  p.add(canoe(w * 0.46, h * 0.76, 230, 'ink', { paddler: 'ink', wake: mix('rose', 'paper', 0.4), dir: -1, wakeLen: 3.4, wakeOp: 0.7 }));
  return p.done(0.04);
}

function meadowRain() {
  const p = new Plate(1600, 1000, 'meadow-rain');
  const { w, h, r, seed } = p;
  const veil = mix('fog', 'sage', 0.3);
  p.sky([[0, mix('sage', 'stone', 0.35)], [1, veil]], h * 0.55);
  const far = ground(seed + 1, { w, y0: h * 0.5, amp: h * 0.03, scale: 500 });
  p.land(far, mix('sage', 'fog', 0.35));
  p.forest(far, mix('sage', 'fog', 0.35), { minH: 10, maxH: 30 });
  p.mist(h * 0.48, h * 0.56, veil, 0.7);
  const mid = ground(seed + 2, { w, y0: h * 0.56, amp: 8, scale: 300 });
  p.land(mid, mix('sage', 'moss', 0.25));
  p.trees(p.grove(mid, { x0: w * 0.05, x1: w * 0.4, minH: 40, maxH: 170, clumps: 2, per: 6 }), mix('moss', 'sage', 0.35));
  p.mist(h * 0.5, h * 0.6, veil, 0.35);
  const m1 = ground(seed + 3, { w, y0: h * 0.6, amp: 6, scale: 300 });
  p.land(m1, mix('lichen', 'sage', 0.45));
  const m2 = ground(seed + 4, { w, y0: h * 0.7, amp: 12, scale: 300 });
  p.land(m2, mix('lichen', 'sage', 0.25));
  // rain, heavier and lighter in sheets
  p.add(`<path d="${streaks(w, h, r, { count: 700, len: 46, slant: -0.18, y0: -50, y1: h * 0.75 })}" stroke="${hex('bright')}" stroke-width="1.2" opacity="0.35"/>`);
  // tall grasses up close, with seed heads
  const fg = ground(seed + 5, { w, y0: h * 1.0, amp: 6, scale: 300 });
  p.add(`<path d="${meadowGrass(fg, r, { x0: -20, x1: w + 20, count: 260, minH: 90, maxH: 420, w: 4, lean: 70 })}" fill="${mix('moss', 'sage', 0.2)}"/>`);
  p.add(`<path d="${meadowGrass(fg, r, { x0: -20, x1: w + 20, count: 220, minH: 60, maxH: 300, w: 4.5, lean: 60 })}" fill="${mix('deep', 'moss', 0.4)}"/>`);
  let heads = '';
  for (let i = 0; i < 40; i++) {
    const x = r() * w;
    const H = 240 + r() * 200;
    const lean = (r() - 0.4) * 60;
    heads += `M${f(x)} ${f(h + 4)}Q${f(x + lean * 0.3)} ${f(h - H * 0.6)} ${f(x + lean)} ${f(h - H)}`;
    heads += `M${f(x + lean - 3)} ${f(h - H + 2)}l3 -26l3 26Z`;
  }
  p.add(`<path d="${heads}" stroke="${mix('ochre', 'moss', 0.5)}" stroke-width="2" fill="${mix('ochre', 'moss', 0.4)}"/>`);
  p.add(`<path d="${streaks(w, h, r, { count: 160, len: 90, slant: -0.18, y0: -40, y1: h })}" stroke="${hex('bright')}" stroke-width="1.6" opacity="0.3"/>`);
  return p.done(0.04);
}

function weatherFront() {
  const p = new Plate(1600, 1000, 'weather-front');
  const { w, h, r, seed } = p;
  const yW = h * 0.66;
  p.sky([[0, mix('stone', 'ink', 0.35)], [0.3, mix('stone', 'lakeLight', 0.2)], [0.58, mix('paper', 'rose', 0.25)], [1, mix('bright', 'lakeLight', 0.2)]], yW);
  // rain falling from under the shelf: soft slanted curtains, their tops hidden by the cloud
  const rainInk = mix('stone', 'lake', 0.35);
  for (let k = 0; k < 11; k++) {
    const x0 = lerp(-0.08, 0.6, (k + r() * 0.8) / 11) * w;
    const wd = 40 + r() * 110;
    const slant = -30 - r() * 50;
    const op = 0.25 + 0.35 * r();
    const g = p.grad([[0, rainInk, op], [0.75, rainInk, op * 0.5], [1, rainInk, 0.04]], h * 0.3, yW);
    p.add(`<path d="M${f(x0)} ${f(h * 0.3)}L${f(x0 + wd)} ${f(h * 0.3)}L${f(x0 + wd + slant)} ${f(yW)}L${f(x0 + slant)} ${f(yW)}Z" fill="${g}" filter="${p.blur('14 4')}"/>`);
  }
  // the shelf cloud: tiers stepping down toward the left, each lower tier nearer and paler, each with a lit lip
  const nTop = fbm1(seed + 3, 3);
  const hump = (x) => Math.exp(-(((x - w * 0.22) / (w * 0.62)) ** 2));
  const tiers = [
    { base: h * 0.12, sag: h * 0.08, end: w * 1.3, ink: mix('ink', 'stone', 0.5) },
    { base: h * 0.18, sag: h * 0.1, end: w * 0.98, ink: mix('ink', 'stone', 0.68) },
    { base: h * 0.235, sag: h * 0.11, end: w * 0.72, ink: mix('stone', 'ink', 0.3) },
    { base: h * 0.285, sag: h * 0.1, end: w * 0.46, ink: mix('stone', 'lakeLight', 0.08) },
  ];
  let prev = () => -12;
  tiers.forEach((t, k) => {
    const above = prev;
    const own = (x) => t.base + t.sag * hump(x) + 12 * (nTop(x / 170 + k * 3) - 0.5);
    const lo = (x) => { const s = clamp((t.end - x) / 280); const e = s * s * (3 - 2 * s); return lerp(above(x) + 1, own(x), e); };
    const topPts = [];
    const botPts = [];
    for (let x = -12; x <= w + 12; x += 6) { topPts.push([x, above(x)]); botPts.unshift([x, lo(x)]); }
    p.add(`<path d="${poly([...topPts, ...botPts])}" fill="${t.ink}"/>`);
    // a soft band of shade just above the lip, then the lip itself
    const lip = [];
    const lipLo = [];
    const shadeHi = [];
    for (let x = -12; x <= Math.min(w + 12, t.end + 20); x += 6) {
      const y = lo(x);
      const th = (y - above(x)) * 0.18;
      const lw = Math.min(th, 1.5 + 4 * hump(x) * clamp((t.end - x) / 300));
      lip.push([x, y - lw]);
      lipLo.unshift([x, y]);
      shadeHi.push([x, y - lw - th * 1.4]);
    }
    if (lip.length > 2) {
      p.add(`<path d="${poly([...shadeHi, ...lip.slice().reverse()])}" fill="${mix(t.ink, 'ink', 0.18)}" opacity="0.6"/>`);
      p.add(`<path d="${poly([...lip, ...lipLo])}" fill="${mix(t.ink, mix('stone', 'lakeLight', 0.5), 0.45 + k * 0.08)}"/>`);
    }
    prev = lo;
  });
  // the far shore, low and dark, and the lake below
  const far = ground(seed + 5, { w, y0: yW - 8, amp: 6, scale: 300 });
  const shoreInk = mix('deep', 'stone', 0.35);
  p.land(far, shoreInk, { mirror: true });
  p.forest(far, shoreInk, { minH: 10, maxH: 28 }, { mirror: true });
  p.water(yW, mix('lake', 'stone', 0.35), { reflect: 0.6, lines: 0, glint: 0.8 });
  p.add(`<rect y="${f(yW + 6)}" width="${w}" height="${f(h * 0.07)}" fill="${p.grad([[0, mix('paper', 'rose', 0.2), 0.45], [1, mix('paper', 'rose', 0.2), 0]], yW + 6, yW + 6 + h * 0.07)}"/>`);
  let caps = '';
  for (let i = 0; i < 70; i++) {
    const u = r() ** 1.2;
    const y = yW + 20 + (h - yW - 30) * u;
    const x = r() * w;
    const s = 0.4 + u * 1.6;
    caps += `M${f(x)} ${f(y)}l${f(14 * s)} ${f(-3 * s)}l${f(10 * s)} ${f(3 * s)}Z`;
  }
  p.add(`<path d="${caps}" fill="${mix('fog', 'lakeLight', 0.3)}" opacity="0.55"/>`);
  const rocks = (x) => h * 0.95 - 74 * Math.exp(-(((x - w * 0.06) / 240) ** 2)) - 26 * Math.exp(-(((x - w * 0.3) / 120) ** 2)) + 4 * Math.sin(x / 23);
  p.land(rocks, mix('ink', 'stone', 0.25));
  return p.done(0.045);
}

function lookoutSpur() {
  const p = new Plate(1600, 1000, 'lookout-spur');
  const { w, h, r, seed } = p;
  const haze = mix('paper', 'lakeLight', 0.15);
  p.sky([[0, mix('lakeLight', 'paper', 0.25)], [1, haze]], h * 0.6);
  const inks = ramp(mix('lakeLight', 'paper', 0.4), mix('lake', 'moss', 0.45), 5);
  const rows = [[0.4, 0.06, 640], [0.48, 0.05, 480], [0.56, 0.05, 420], [0.66, 0.05, 360], [0.78, 0.05, 300]];
  rows.forEach(([y0, amp, scale], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: h * amp, scale, tilt: i % 2 ? 60 : -60 });
    p.land(g, inks[i]);
    if (i >= 1) p.forest(g, inks[i], { minH: 3 + i * 3, maxH: 8 + i * 7 });
    if (i < rows.length - 1) p.mist(h * (y0 - 0.005), h * (rows[i + 1][0] + 0.02), haze, 0.7);
  });
  // the outcrop: a shelf of rock from the left, ending in a drop
  const edgeX = w * 0.6;
  const topY = (x) => h * 0.64 + 18 * Math.sin(x / 140) + (x / edgeX) * 20;
  const face = mix('stone', 'ink', 0.45);
  const lit = mix('stone', 'fog', 0.35);
  const topPts = [];
  for (let x = -12; x <= edgeX; x += 8) topPts.push([x, topY(x)]);
  const drop = [[edgeX + 30, topY(edgeX) + 22], [edgeX + 22, topY(edgeX) + 120], [edgeX + 70, topY(edgeX) + 210], [edgeX + 40, h * 0.92], [edgeX + 120, h + 12]];
  p.add(`<path d="${poly([...topPts, ...drop, [-12, h + 12]])}" fill="${face}"/>`);
  const ledge = topPts.map(([x, y]) => [x, y + 26 + 10 * Math.sin(x / 70)]);
  p.add(`<path d="${poly([...topPts, [edgeX + 30, topY(edgeX) + 22], ...ledge.reverse()])}" fill="${lit}"/>`);
  let cracks = '';
  for (let i = 0; i < 9; i++) {
    const x = r() * edgeX;
    const y = topY(x) + 40 + r() * 200;
    cracks += `M${f(x)} ${f(y)}l${f(20 + r() * 60)} ${f(8 + r() * 30)}l${f(-10 + r() * 40)} ${f(30 + r() * 50)}`;
  }
  p.add(`<path d="${cracks}" stroke="${mix('ink', 'stone', 0.2)}" stroke-width="3" fill="none" opacity="0.6"/>`);
  const dark = mix('deep', 'ink', 0.3);
  p.trees(p.grove(topY, { x0: -30, x1: w * 0.14, minH: 120, maxH: 420, clumps: 1, per: 4 }), dark);
  const hx = edgeX - 60;
  p.add(hiker(hx, topY(hx) + 3, 62, 'ink', 'ember', 1));
  return p.done(0.04);
}

function fog404() {
  const p = new Plate(1600, 1000, 'fog-404');
  const { w, h, r, seed } = p;
  const white = hex('bright');
  p.sky([[0, white], [1, mix('fog', 'bright', 0.4)]], h * 0.62);
  [[0.5, 0.06], [0.56, 0.12], [0.6, 0.2]].forEach(([y0, t], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: 6, scale: 300 });
    const ink = mix('bright', 'sage', t);
    p.trees(p.grove(g, { x0: -40, x1: w + 40, minH: 40 + i * 40, maxH: 120 + i * 90, clumps: 4, per: 4 }), ink);
    p.land(g, ink);
    p.mist(h * (y0 - 0.12), h * (y0 + 0.02), white, 0.7);
  });
  const yH = h * 0.62;
  p.land(ground(seed + 5, { w, y0: yH, amp: 3, scale: 300 }), mix('fog', 'lichen', 0.3));
  const path = trail(w * 0.5, yH + 2, w * 0.43, h + 10, w * 0.15, { bend: -w * 0.04 });
  p.add(`<path d="${path.d}" fill="${mix('paper', 'bright', 0.5)}"/>`);
  p.add(`<rect y="${f(yH - 20)}" width="${w}" height="${f(h * 0.22)}" fill="${p.grad([[0, white, 0.95], [1, white, 0]], yH - 20, yH + h * 0.2)}"/>`);
  const px = w * 0.64;
  const pb = h * 0.86;
  const wood = mix('stone', 'ochre', 0.25);
  p.add(`<path d="M${f(px - 18)} ${f(pb)}L${f(px - 16)} ${f(pb - 250)}L${f(px)} ${f(pb - 262)}L${f(px + 16)} ${f(pb - 250)}L${f(px + 18)} ${f(pb)}Z" fill="${wood}"/>`);
  p.add(`<path d="M${f(px + 4)} ${f(pb)}L${f(px + 5)} ${f(pb - 256)}L${f(px + 16)} ${f(pb - 250)}L${f(px + 18)} ${f(pb)}Z" fill="${mix('stone', 'ink', 0.3)}" opacity="0.5"/>`);
  p.add(`<rect x="${f(px - 11)}" y="${f(pb - 214)}" width="22" height="40" fill="${hex('ember')}"/>`);
  p.add(`<path d="${meadowGrass(flat(pb - 2), r, { x0: px - 60, x1: px + 70, count: 40, minH: 10, maxH: 40, w: 3 })}" fill="${mix('sage', 'lichen', 0.4)}"/>`);
  return p.done(0.035);
}

function campMorning() {
  const p = new Plate(1600, 1000, 'camp-morning');
  const { w, h, r, seed } = p;
  const yW = h * 0.56;
  const haze = mix('paper', 'rose', 0.22);
  p.sky([[0, mix('lakeLight', 'paper', 0.3)], [1, haze]], yW);
  const inks = ramp(mix('lakeLight', 'paper', 0.4), mix('moss', 'sage', 0.3), 3);
  [[0.42, 0.05, 600], [0.49, 0.035, 420], [yW / h - 0.008, 0.012, 300]].forEach(([y0, amp, scale], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: h * amp, scale });
    p.land(g, inks[i], { mirror: true });
    if (i) p.forest(g, inks[i], { minH: 6 + i * 6, maxH: 16 + i * 14 }, { mirror: true });
    if (i === 2) p.trees(p.grove(g, { x0: 0, x1: w * 0.5, minH: 16, maxH: 50, clumps: 3, per: 6 }), inks[i], { mirror: true });
    if (i < 2) p.mist(h * (y0 - 0.01), h * (y0 + 0.07), haze, 0.75, true);
  });
  p.water(yW, mix('lakeLight', 'paper', 0.4), { reflect: 0.5, lines: 14 });
  // the near shore curving in from the right, a dark wet rim where it meets the water
  const ctrl = [[w * 0.3, h + 20], [w * 0.38, h * 0.88], [w * 0.5, h * 0.8], [w * 0.68, h * 0.755], [w * 0.86, h * 0.74], [w + 20, h * 0.735]];
  const shoreline = spline(ctrl, false, 6);
  const shoreAt = (x) => { for (let i = 1; i < shoreline.length; i++) if (shoreline[i][0] >= x) { const [x0, y0] = shoreline[i - 1]; const [x1, y1] = shoreline[i]; return lerp(y0, y1, (x - x0) / (x1 - x0 || 1)); } return h * 0.735; };
  const back = (x) => shoreAt(x) + 6;
  p.trees(p.grove(back, { x0: w * 0.74, x1: w * 1.04, minH: 170, maxH: 560, clumps: 2, per: 5 }), mix('deep', 'ink', 0.2));
  // a few rocks at the water's edge, in two small clusters
  let rocks = '';
  [[0.4, 0.91, 40], [0.43, 0.875, 22], [0.375, 0.95, 26], [0.57, 0.79, 18], [0.6, 0.78, 12]].forEach(([fx, fy, s]) => { rocks += stone(w * fx, h * fy, s * 1.5, s * 0.75, r, { body: mix('stone', 'ink', 0.2), top: mix('stone', 'fog', 0.35), id: p.id('k') }); });
  p.add(`<path d="${poly([...shoreline.map(([x, y]) => [x, y - 5]), [w + 20, h + 20]])}" fill="${mix('stone', 'ink', 0.25)}"/>`);
  p.add(rocks);
  p.add(`<path d="${poly([...shoreline.map(([x, y]) => [x + 6, y]), [w + 20, h + 20]])}" fill="${mix('sage', 'moss', 0.45)}"/>`);
  p.add(`<path d="${poly([...shoreline.map(([x, y]) => [x + 40, y + 30]), [w + 20, h + 20]])}" fill="${mix('sage', 'moss', 0.3)}"/>`);
  const tx = w * 0.68;
  const ty = h * 0.85;
  p.add(tent(tx, ty, 1.2, 'ember'));
  // a small fire and its thin line of smoke
  const fx = w * 0.56;
  const fy = h * 0.89;
  const left = [];
  const right = [];
  for (let k = 0; k <= 50; k++) {
    const t = k / 50;
    const y = fy - 8 - t * h * 0.42;
    const x = fx + 14 * Math.sin(t * 7) * t + 22 * Math.sin(t * 15) * t * t + t ** 1.8 * 120;
    const half = 1.2 + t * 5;
    left.push([x - half, y]);
    right.unshift([x + half, y]);
  }
  p.add(`<path d="${poly([...left, ...right])}" fill="${p.grad([[0, mix('fog', 'stone', 0.25), 0.9], [1, mix('fog', 'stone', 0.25), 0]], fy, fy - h * 0.42)}"/>`);
  p.add(`<path d="M${f(fx - 10)} ${f(fy)}L${f(fx - 3)} ${f(fy - 18)}L${f(fx + 1)} ${f(fy - 8)}L${f(fx + 5)} ${f(fy - 22)}L${f(fx + 10)} ${f(fy)}Z" fill="${hex('ochre')}"/>`);
  let ring = '';
  for (let i = 0; i < 7; i++) ring += `<rect x="${f(fx - 26 + i * 8)}" y="${f(fy - 4 + (i % 2) * 2)}" width="10" height="7" rx="3.5" fill="${hex('stone')}"/>`;
  p.add(ring);
  return p.done(0.04);
}

/* gallery: one portage trip, one sky and one light for all four */
const GALLERY_SKY = [[0, mix('lakeLight', 'paper', 0.3)], [1, mix('paper', 'rose', 0.3)]];

function gallerySpruce() {
  const p = new Plate(1600, 1000, 'gallery-spruce');
  const { w, h, r, seed } = p;
  const yH = h * 0.6;
  p.sky(GALLERY_SKY, yH);
  const inks = ramp(mix('sage', 'paper', 0.45), mix('deep', 'ink', 0.3), 5);
  const vx = w * 0.5;
  const path = trail(vx, yH + 8, w * 0.45, h + 10, w * 0.12, { bend: -w * 0.08 });
  for (let i = 0; i < 5; i++) {
    const u = i / 4;
    const y = yH + 8 + u ** 1.6 * (h * 0.36);
    const g = ground(seed + 20 + i, { w, y0: y, amp: 4 + i * 5, scale: 240 });
    const [c, hw] = path.at(y);
    const gap = hw + lerp(24, 200, u ** 1.4);
    const Hmax = lerp(110, 1200, u ** 1.8);
    p.trees(p.grove(g, { x0: -60, x1: c - gap, minH: Hmax * 0.5, maxH: Hmax, clumps: 2, per: 4 + i }), inks[i]);
    p.trees(p.grove(g, { x0: c + gap, x1: w + 60, minH: Hmax * 0.5, maxH: Hmax, clumps: 2, per: 4 + i }), inks[i]);
    p.land(g, mix(inks[i], 'ochre', 0.2));
    if (i < 4) p.mist(y - 120, y, mix('paper', 'rose', 0.3), 0.3 - i * 0.05);
  }
  p.add(`<path d="${path.d}" fill="${mix('lichen', 'ochre', 0.2)}"/>`);
  return p.done(0.045);
}

function galleryLanding() {
  const p = new Plate(1600, 1000, 'gallery-landing');
  const { w, h, r, seed } = p;
  const yW = h * 0.5;
  p.sky(GALLERY_SKY, yW);
  const inks = ramp(mix('lakeLight', 'paper', 0.35), mix('moss', 'sage', 0.25), 3);
  [[0.38, 0.05, 560], [0.44, 0.03, 420], [yW / h - 0.008, 0.012, 300]].forEach(([y0, amp, scale], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: h * amp, scale });
    p.land(g, inks[i], { mirror: true });
    if (i) p.forest(g, inks[i], { minH: 6 + i * 8, maxH: 16 + i * 16 }, { mirror: true });
    if (i < 2) p.mist(h * (y0 - 0.01), h * (y0 + 0.07), GALLERY_SKY[1][1], 0.7, true);
  });
  p.water(yW, mix('lakeLight', 'paper', 0.3), { reflect: 0.5, lines: 14 });
  // the landing: smooth rock running into the water, the canoe pulled up
  const rock = (x) => h * 0.72 + (x / w) * h * 0.12 - 50 * Math.exp(-(((x - w * 0.15) / 300) ** 2));
  p.trees(p.grove(rock, { x0: -40, x1: w * 0.12, minH: 260, maxH: 760, clumps: 1, per: 4 }), mix('deep', 'ink', 0.25));
  p.land((x) => rock(x) - 3, mix('stone', 'fog', 0.35));
  p.land(rock, mix('stone', 'ink', 0.1));
  p.land((x) => rock(x) + 60 + 20 * Math.sin(x / 200), mix('stone', 'ink', 0.3));
  const cx = w * 0.56;
  p.add(`<g transform="rotate(-4 ${f(cx)} ${f(rock(cx))})">${canoe(cx, rock(cx) + 6, 520, 'ember', { inside: true })}</g>`);
  return p.done(0.045);
}

function galleryShore() {
  const p = new Plate(1600, 1000, 'gallery-shore');
  const { w, h, r, seed } = p;
  const yW = h * 0.55;
  p.sky(GALLERY_SKY, yW);
  const inks = ramp(mix('lakeLight', 'paper', 0.35), mix('moss', 'sage', 0.25), 3);
  [[0.42, 0.05, 600], [0.49, 0.03, 420], [yW / h - 0.008, 0.012, 300]].forEach(([y0, amp, scale], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: h * amp, scale });
    p.land(g, inks[i], { mirror: true });
    if (i) p.forest(g, inks[i], { minH: 6 + i * 8, maxH: 16 + i * 16 }, { mirror: true });
    if (i < 2) p.mist(h * (y0 - 0.01), h * (y0 + 0.07), GALLERY_SKY[1][1], 0.7, true);
  });
  p.water(yW, mix('lakeLight', 'paper', 0.3), { reflect: 0.5, lines: 12 });
  // a granite whaleback sloping down into the lake from the right, spruce on its crown
  const x0 = w * 0.36;
  const crown = (x) => {
    const t = clamp((x - x0) / (w - x0));
    return h * 0.86 - h * 0.27 * Math.sin((Math.PI / 2) * t) ** 0.75 + 6 * Math.sin(x / 55) * t;
  };
  const face = mix('stone', 'ink', 0.3);
  const lit = mix('stone', 'fog', 0.42);
  let b = '';
  [[0.27, 0.88, 34], [0.21, 0.83, 18], [0.32, 0.95, 26], [0.15, 0.79, 11]].forEach(([fx, fy, s]) => { b += stone(w * fx, h * fy, s * 1.7, s * 0.75, r, { body: face, top: lit, id: p.id('k') }); });
  p.add(b);
  p.trees(p.grove(crown, { x0: w * 0.6, x1: w * 0.7, minH: 60, maxH: 160, clumps: 1, per: 3 }), mix('deep', 'ink', 0.25));
  p.trees(p.grove(crown, { x0: w * 0.74, x1: w * 1.04, minH: 200, maxH: 600, clumps: 1, per: 5 }), mix('deep', 'ink', 0.25));
  // the rock: its crown, then the shoreline curving down toward us on the left
  const topPts = [];
  for (let x = x0; x <= w + 12; x += 6) topPts.push([x, crown(x)]);
  const shore = spline([[x0, crown(x0)], [x0 - w * 0.05, h * 0.92], [x0 - w * 0.09, h + 12]], false, 6);
  p.add(`<path d="${poly([...topPts, [w + 12, h + 12], ...shore.slice().reverse()])}" fill="${face}"/>`);
  // the sunlit top of the rock, thickest where it is broadest
  const band = topPts.map(([x, y]) => { const t = clamp((x - x0) / (w - x0)); return [x, y + (18 + 70 * Math.sin(Math.PI * Math.min(1, t * 1.6) / 2)) * (0.85 + 0.15 * Math.sin(x / 70))]; });
  p.add(`<path d="${poly([...topPts, ...band.slice().reverse(), [x0 - 4, crown(x0) + 8]])}" fill="${lit}"/>`);
  let cracks = '';
  for (let i = 0; i < 5; i++) {
    const x = lerp(x0 + 120, w - 60, (i + r() * 0.6) / 5);
    const y = band[Math.min(band.length - 1, Math.round((x - x0) / 6))][1] + 10;
    cracks += `M${f(x)} ${f(y)}l${f(-18 - r() * 20)} ${f(40 + r() * 40)}l${f(-6 - r() * 10)} ${f(30 + r() * 50)}`;
  }
  p.add(`<path d="${cracks}" stroke="${mix('ink', 'stone', 0.25)}" stroke-width="2.5" fill="none" opacity="0.45" stroke-linecap="round"/>`);
  return p.done(0.045);
}

function galleryEvening() {
  const p = new Plate(1600, 1000, 'gallery-evening');
  const { w, h, r, seed } = p;
  const yW = h * 0.56;
  const sky = [[0, mix('lakeLight', 'lake', 0.25)], [1, mix('rose', 'paper', 0.2)]];
  p.sky(sky, yW);
  const inks = ramp(mix('rose', 'lake', 0.3), mix('deep', 'lake', 0.25), 3);
  [[0.43, 0.05, 600], [0.5, 0.03, 420], [yW / h - 0.008, 0.012, 300]].forEach(([y0, amp, scale], i) => {
    const g = ground(seed + i, { w, y0: h * y0, amp: h * amp, scale });
    p.land(g, inks[i], { mirror: true });
    if (i) p.forest(g, inks[i], { minH: 6 + i * 8, maxH: 16 + i * 16 }, { mirror: true });
    if (i < 2) p.mist(h * (y0 - 0.01), h * (y0 + 0.07), sky[1][1], 0.6, true);
  });
  p.water(yW, mix('rose', 'lakeLight', 0.45), { reflect: 0.55, lines: 14, lineColor: mix('rose', 'paper', 0.4) });
  const site = (x) => h * 0.78 - 60 * Math.exp(-(((x - w * 0.25) / 380) ** 2)) + 6 * Math.sin(x / 70);
  const dark = mix('deep', 'ink', 0.35);
  p.trees(p.grove(site, { x0: -40, x1: w * 0.3, minH: 200, maxH: 640, clumps: 2, per: 4 }), dark);
  p.land(site, dark);
  const tx = w * 0.4;
  p.add(tent(tx, site(tx) + 26, 1.1, mix('ember', 'ink', 0.15), { door: mix('ochre', 'rose', 0.4), flank: mix('ember', 'ink', 0.4) }));
  const cx = w * 0.6;
  p.add(canoeOver(cx, site(cx) + 30, 300, mix('deep', 'ink', 0.55)));
  p.add(`<path d="${meadowGrass((x) => site(x) + 40, r, { x0: -20, x1: w * 0.9, count: 120, minH: 14, maxH: 44, w: 3 })}" fill="${dark}"/>`);
  return p.done(0.045);
}

/* ── maps: a survey sheet from a seeded heightfield ─────────────────────────
   The terrain is a sum of gaussian hills and basins, ridges and valleys
   along lines, and gentle noise. It is sampled on a grid and contoured with
   marching squares; lines are joined, smoothed (Chaikin) and simplified, so
   they nest and never cross. Water is wherever the ground is below 300 m.  */

const WATER = 300;

/** A Catmull-Rom curve through points, sampled about every step pixels. */
function spline(pts, closed = false, step = 4) {
  const n = pts.length;
  const P = (i) => (closed ? pts[(i + n) % n] : pts[clamp(i, 0, n - 1)]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const [p0, p1, p2, p3] = [P(i - 1), P(i), P(i + 1), P(i + 2)];
    const k = Math.max(2, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / step));
    for (let s = 0; s < k; s++) {
      const t = s / k;
      const t2 = t * t;
      const t3 = t2 * t;
      out.push([0, 1].map((c) => 0.5 * (2 * p1[c] + (-p0[c] + p2[c]) * t + (2 * p0[c] - 5 * p1[c] + 4 * p2[c] - p3[c]) * t2 + (-p0[c] + 3 * p1[c] - 3 * p2[c] + p3[c]) * t3)));
    }
  }
  out.push(closed ? out[0] : pts[n - 1]);
  return out;
}
function chaikin(pts, closed, iter = 2) {
  for (let k = 0; k < iter; k++) {
    const out = closed ? [] : [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[i + 1];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    out.push(closed ? out[0] : pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}
/** Douglas-Peucker, iterative. */
function simplify(pts, eps = 0.3) {
  if (pts.length < 3) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    let best = 0;
    let bi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len;
      if (d > best) { best = d; bi = i; }
    }
    if (best > eps && bi > 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
function cumulative(pts) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return cum;
}
function pointAt(pts, cum, s) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < s) i++;
  const t = clamp((s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1));
  return [lerp(pts[i - 1][0], pts[i][0], t), lerp(pts[i - 1][1], pts[i][1], t)];
}
/** A polyline with its length table and bounding box, for distance queries. */
function track(pts) {
  const cum = cumulative(pts);
  const xs = pts.map((q) => q[0]);
  const ys = pts.map((q) => q[1]);
  return { pts, cum, len: cum[cum.length - 1], box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
}
/** Distance from a point to a track, and how far along it (0..1) the nearest point lies. */
function nearest(px, py, tr) {
  let best = Infinity;
  let bu = 0;
  const { pts, cum } = tr;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const dx = pts[i + 1][0] - x0;
    const dy = pts[i + 1][1] - y0;
    const L2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - x0) * dx + (py - y0) * dy) / L2);
    const qx = x0 + t * dx - px;
    const qy = y0 + t * dy - py;
    const d2 = qx * qx + qy * qy;
    if (d2 < best) { best = d2; bu = cum[i] + t * Math.sqrt(L2); }
  }
  return { d: Math.sqrt(best), u: bu / (tr.len || 1) };
}

/** A sheet's terrain features in pixels, from its spec in fractions of the sheet. */
function sheetFeatures(spec, W, H) {
  const P = ([fx, fy]) => [fx * W, fy * H];
  const hill = ([fx, fy, a, sx, sy = sx, rot = 0]) => ({ x: fx * W, y: fy * H, a, sx: sx * W, sy: sy * W, rot });
  return {
    hills: [...(spec.hills ?? []).map(hill), ...(spec.basins ?? []).map(([x, y, d, ...rest]) => hill([x, y, -Math.abs(d), ...rest]))],
    ridges: (spec.ridges ?? []).map((rd) => ({ pts: spline(rd.pts.map(P), false, 12), a: rd.a, s: rd.s * W })),
    // streams meander a little; the valley is carved along the same line, so the contours bend where they cross
    valleys: [spec.stream, spec.river].filter(Boolean).map((v) => ({ pts: wander(spline(v.pts.map(P), false, 8), hash(spec.name) + 17, v.width ? 4 : 5), depth: v.depth, s: v.s * W, width: v.width ?? 0 })),
  };
}
/** Move features by a scale k about (cx, cy) to (ox, oy): how a sheet sits on the region map. */
function placeFeatures(feat, k, [cx, cy], [ox, oy]) {
  const T = ([x, y]) => [ox + (x - cx) * k, oy + (y - cy) * k];
  return {
    hills: feat.hills.map((g) => { const [x, y] = T([g.x, g.y]); return { ...g, x, y, sx: g.sx * k, sy: g.sy * k }; }),
    ridges: feat.ridges.map((rd) => ({ ...rd, pts: rd.pts.map(T), s: rd.s * k })),
    valleys: feat.valleys.map((v) => ({ ...v, pts: v.pts.map(T), s: v.s * k, width: v.width * Math.max(k, 0.45) })),
  };
}
function heightfield(feat, { base = 335, noise = 12, noiseScale = 300, seed, warp = 0, warpScale = 300 }) {
  const n2 = fbm2(seed, 3);
  const wx = fbm2(seed + 11, 2);
  const wy = fbm2(seed + 23, 2);
  const hills = feat.hills.map((g) => ({ ...g, c: Math.cos(g.rot), s: Math.sin(g.rot) }));
  const ridges = feat.ridges.map((rd) => ({ ...rd, tr: track(rd.pts) }));
  const valleys = feat.valleys.map((v) => ({ ...v, tr: track(v.pts) }));
  return (x0, y0) => {
    let z = base + noise * (n2(x0 / noiseScale, y0 / noiseScale) - 0.5) * 2;
    // hills and ridges are read through a gentle warp, so no shape is a perfect ellipse
    const x = x0 + warp * (wx(x0 / warpScale, y0 / warpScale) - 0.5) * 2;
    const y = y0 + warp * (wy(x0 / warpScale, y0 / warpScale) - 0.5) * 2;
    for (const g of hills) {
      const dx = x - g.x;
      const dy = y - g.y;
      const a = (dx * g.c + dy * g.s) / g.sx;
      const b = (-dx * g.s + dy * g.c) / g.sy;
      const q = a * a + b * b;
      if (q < 16) z += g.a * Math.exp(-q);
    }
    for (const rd of ridges) {
      const [x0, y0, x1, y1] = rd.tr.box;
      const m = rd.s * 3;
      if (x < x0 - m || x > x1 + m || y < y0 - m || y > y1 + m) continue;
      const { d } = nearest(x, y, rd.tr);
      z += rd.a * Math.exp(-((d / rd.s) ** 2));
    }
    for (const v of valleys) {
      const [bx0, by0, bx1, by1] = v.tr.box;
      if (x0 < bx0 - v.s || x0 > bx1 + v.s || y0 < by0 - v.s || y0 > by1 + v.s) continue;
      const { d, u } = nearest(x0, y0, v.tr);
      const q = d / v.s;
      if (q < 1) z -= v.depth * (0.4 + 0.6 * u) * (1 - q) ** 2;
    }
    return z;
  };
}
/** The field on a grid one cell beyond the sheet on every side. */
function sample(fn, W, H, cell) {
  const nx = Math.ceil(W / cell) + 3;
  const ny = Math.ceil(H / cell) + 3;
  const v = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) v[j * nx + i] = fn((i - 1) * cell, (j - 1) * cell);
  return { v, nx, ny, cell, ox: -cell, oy: -cell };
}
/** The same grid with its outer ring forced to a value, so every region inside closes. */
function ringed(F, value) {
  const v = Float64Array.from(F.v);
  for (let i = 0; i < F.nx; i++) { v[i] = value; v[(F.ny - 1) * F.nx + i] = value; }
  for (let j = 0; j < F.ny; j++) { v[j * F.nx] = value; v[j * F.nx + F.nx - 1] = value; }
  return { ...F, v };
}
/** Contour lines at one level: marching squares, saddles split by the cell centre, joined into polylines. */
function isolines(F, level) {
  const { v, nx, ny, cell, ox, oy } = F;
  const key = (i, j, vert) => ((j * nx + i) << 1) | vert;
  const pos = (k) => {
    const vert = k & 1;
    const idx = k >> 1;
    const i = idx % nx;
    const j = (idx - i) / nx;
    const a = v[j * nx + i];
    const b = vert ? v[(j + 1) * nx + i] : v[j * nx + i + 1];
    const t = (level - a) / (b - a);
    return vert ? [ox + i * cell, oy + (j + t) * cell] : [ox + (i + t) * cell, oy + j * cell];
  };
  const segs = [];
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = v[j * nx + i];
      const b = v[j * nx + i + 1];
      const c = v[(j + 1) * nx + i + 1];
      const d = v[(j + 1) * nx + i];
      const code = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (code === 0 || code === 15) continue;
      const T = key(i, j, 0);
      const B = key(i, j + 1, 0);
      const L = key(i, j, 1);
      const R = key(i + 1, j, 1);
      const centre = (a + b + c + d) / 4 > level;
      switch (code) {
        case 1: case 14: segs.push([L, B]); break;
        case 2: case 13: segs.push([B, R]); break;
        case 3: case 12: segs.push([L, R]); break;
        case 4: case 11: segs.push([T, R]); break;
        case 6: case 9: segs.push([T, B]); break;
        case 7: case 8: segs.push([L, T]); break;
        case 5: if (centre) segs.push([L, T], [B, R]); else segs.push([T, R], [L, B]); break;
        case 10: if (centre) segs.push([T, R], [L, B]); else segs.push([L, T], [B, R]); break;
        default: break;
      }
    }
  }
  const at = new Map();
  segs.forEach(([p, q], k) => {
    if (!at.has(p)) at.set(p, []);
    if (!at.has(q)) at.set(q, []);
    at.get(p).push(k);
    at.get(q).push(k);
  });
  const used = new Uint8Array(segs.length);
  const grow = (chain) => {
    for (;;) {
      const end = chain[chain.length - 1];
      const next = (at.get(end) ?? []).find((k) => !used[k]);
      if (next === undefined) return;
      used[next] = 1;
      const [p, q] = segs[next];
      chain.push(p === end ? q : p);
    }
  };
  const lines = [];
  for (let s = 0; s < segs.length; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const fwd = [segs[s][0], segs[s][1]];
    grow(fwd);
    const back = [segs[s][0]];
    grow(back);
    const keys = back.reverse().slice(0, -1).concat(fwd);
    const closed = keys.length > 3 && keys[0] === keys[keys.length - 1];
    lines.push({ pts: keys.map(pos), closed });
  }
  return lines;
}
/** Smooth and thin a contour; a closed loop is simplified in two halves (its ends coincide). */
function smooth(ln, iter = 2, eps = 0.3) {
  const pts = chaikin(ln.pts, ln.closed, iter);
  if (!ln.closed || pts.length < 8) return { ...ln, pts: simplify(pts, eps) };
  const mid = Math.floor(pts.length / 2);
  return { ...ln, pts: [...simplify(pts.slice(0, mid + 1), eps), ...simplify(pts.slice(mid), eps).slice(1)] };
}
function area(pts) {
  let a = 0;
  for (let i = 0; i < pts.length - 1; i++) a += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
  return Math.abs(a / 2);
}

/** A route: a smooth curve through its control points, and how many pixels make a kilometre. */
/** Nudge a line sideways by a few periodic waves: a trail follows the ground, not a ruler. */
function wander(pts, seed, amp = 6) {
  const cum = cumulative(pts);
  const L = cum.at(-1);
  const r = rng(seed);
  const waves = [L / 420, L / 230, L / 130].map((k) => [Math.max(1, Math.round(k)), r() * Math.PI * 2, 0.5 + r() * 0.5]);
  return pts.map((q, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    let o = 0;
    for (const [k, ph, w] of waves) o += w * Math.sin((2 * Math.PI * k * cum[i]) / L + ph);
    o *= amp / 1.6;
    return [q[0] - (dy / len) * o, q[1] + (dx / len) * o];
  });
}
function routeOf(spec, W, H) {
  let pts = spline(spec.route.pts.map(([x, y]) => [x * W, y * H]), spec.route.closed, 3);
  pts = wander(pts, hash(spec.name) + 3, spec.route.wander ?? 6);
  if (spec.route.closed) pts[pts.length - 1] = pts[0];
  const len = cumulative(pts).at(-1);
  const km = spec.km / (spec.route.kind === 'out-and-back' ? 2 : 1);
  return { pts, closed: spec.route.closed, kind: spec.route.kind, pxPerKm: len / km };
}

const MAP_FONT = 'Nimbus Sans Narrow';

/** Text with a paper halo, so it reads over contour lines. */
function haloText(x, y, text, { size = 15, fill = C.moss, weight = 'normal', family = MAP_FONT, rot = 0, anchor = 'middle', spacing = 0, italic = false, halo = C.paper, haloW = 4 } = {}) {
  const attrs = `x="${f(x)}" y="${f(y)}" font-family="${family}" font-size="${size}" font-weight="${weight}"${italic ? ' font-style="italic"' : ''} text-anchor="${anchor}"${spacing ? ` letter-spacing="${spacing}"` : ''}${rot ? ` transform="rotate(${f(rot)} ${f(x)} ${f(y)})"` : ''}`;
  return `<text ${attrs} fill="${halo}" stroke="${halo}" stroke-width="${haloW}" stroke-linejoin="round">${text}</text><text ${attrs} fill="${fill}">${text}</text>`;
}

/**
 * Draws a map body: terrain, water, route(s) and the sheet's furniture.
 * Shared by the route sheets and the region overview.
 */
function drawMap(o) {
  const { W, H, field, prefix = 'm', interval = 10, cell = 6 } = o;
  const inset = 26;
  const F = sample(field, W, H, cell);
  const defs = [`<clipPath id="${prefix}nl"><rect x="${inset}" y="${inset}" width="${W - 2 * inset}" height="${H - 2 * inset}"/></clipPath>`];
  const body = [`<rect width="${W}" height="${H}" fill="${C.paper}"/>`];
  const inner = [];
  const isWater = (x, y) => field(x, y) < WATER;
  // woodland tint: open ground stays paper
  if (o.woods !== false) {
    const wn = fbm2(o.seed + 99, 3);
    const clear = o.clearings ?? [];
    const wf = (x, y) => {
      let v = wn(x / (o.woodScale ?? 300), y / (o.woodScale ?? 300));
      for (const [cx, cy, rad] of clear) v -= 0.6 * Math.exp(-(((x - cx) ** 2 + (y - cy) ** 2) / rad ** 2));
      return v;
    };
    const WF = ringed(sample(wf, W, H, cell * 2), -1);
    const woods = isolines(WF, 0.5).filter((l) => l.closed).map((l) => smooth(l, 2, 0.5)).filter((l) => area(l.pts) > 5000);
    inner.push(`<path d="${woods.map((l) => poly(l.pts)).join('')}" fill="${mix('sage', 'paper', o.woodTint ?? 0.88)}" fill-rule="evenodd"/>`);
  }
  // contours: minor in sage, every fifth an index line in moss
  let lo = Infinity;
  let hi = -Infinity;
  for (const z of F.v) { if (z < lo) lo = z; if (z > hi) hi = z; }
  const indexLines = [];
  let minor = '';
  let major = '';
  for (let lev = Math.ceil(Math.max(lo, WATER + 1) / interval) * interval; lev <= hi; lev += interval) {
    const lines = isolines(F, lev).map((l) => smooth(l)).filter((l) => l.pts.length > 3 && (!l.closed || area(l.pts) > 120));
    const d = lines.map((l) => poly(l.pts, l.closed)).join('');
    if (lev % (interval * 5) === 0) { major += d; indexLines.push({ lev, lines }); } else minor += d;
  }
  inner.push(`<path d="${minor}" fill="none" stroke="${C.sage}" stroke-width="${o.minorW ?? 1.1}" opacity="0.75" stroke-linejoin="round"/>`);
  inner.push(`<path d="${major}" fill="none" stroke="${C.moss}" stroke-width="${o.majorW ?? 1.8}" opacity="0.8" stroke-linejoin="round"/>`);
  // streams and rivers
  for (const v of o.waters ?? []) {
    if (v.width > 4) {
      inner.push(`<path d="${poly(v.pts, false)}" fill="none" stroke="${C.lake}" stroke-width="${f(v.width + 3)}" stroke-linecap="round" stroke-linejoin="round"/>`);
      inner.push(`<path d="${poly(v.pts, false)}" fill="none" stroke="${C.lakeLight}" stroke-width="${f(v.width)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    } else {
      inner.push(`<path d="${poly(v.pts, false)}" fill="none" stroke="${C.lake}" stroke-width="${o.streamW ?? 2}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
  }
  // lakes
  const lakes = isolines(ringed(F, WATER + 500), WATER).filter((l) => l.closed).map((l) => smooth(l, 2, 0.4)).filter((l) => area(l.pts) > (o.minLake ?? 400));
  const lakeD = lakes.map((l) => poly(l.pts)).join('');
  inner.push(`<path d="${lakeD}" fill="${C.lakeLight}" fill-rule="evenodd" stroke="${C.lake}" stroke-width="${o.shoreW ?? 1.6}" stroke-linejoin="round"/>`);
  // marsh: little tufts on the wet flats
  if (o.marsh) {
    let d = '';
    const r = rng(o.seed + 5);
    for (let y = inset + 10; y < H - inset; y += 22) {
      for (let x = inset + 10 + ((y / 22) % 2) * 13; x < W - inset; x += 26) {
        const jx = x + (r() - 0.5) * 8;
        const jy = y + (r() - 0.5) * 6;
        if (!o.marsh(jx, jy) || isWater(jx, jy)) continue;
        d += `M${f(jx - 7)} ${f(jy)}h14M${f(jx)} ${f(jy)}v-6M${f(jx - 4)} ${f(jy)}l-1.5 -4M${f(jx + 4)} ${f(jy)}l1.5 -4`;
      }
    }
    inner.push(`<path d="${d}" stroke="${C.lake}" stroke-width="1.2" fill="none" opacity="0.8"/>`);
  }
  // the 1 km grid
  const g = o.gridPx;
  let gd = '';
  const gx0 = inset + ((o.gridOffset ?? 0.37) * g) % g;
  for (let x = gx0; x < W - inset; x += g) gd += `M${f(x)} ${inset}V${H - inset}`;
  for (let y = gx0; y < H - inset; y += g) gd += `M${inset} ${f(y)}H${W - inset}`;
  inner.push(`<path d="${gd}" stroke="${C.lichen}" stroke-width="1" fill="none" opacity="${o.gridOp ?? 0.9}"/>`);
  if (o.gridMajor) {
    let gm = '';
    for (let x = gx0, k = 0; x < W - inset; x += g, k++) if (k % o.gridMajor === 0) gm += `M${f(x)} ${inset}V${H - inset}`;
    for (let y = gx0, k = 0; y < H - inset; y += g, k++) if (k % o.gridMajor === 0) gm += `M${inset} ${f(y)}H${W - inset}`;
    inner.push(`<path d="${gm}" stroke="${mix('lichen', 'stone', 0.25)}" stroke-width="1.2" fill="none"/>`);
  }
  // reserved boxes (title, scale) and a test for clear space
  const boxes = o.boxes ?? [];
  const routeTracks = (o.routes ?? []).map((rt) => track(rt.pts));
  const placed = [];
  const clear = (x, y, pad = 30) => x > inset + 40 && x < W - inset - 40 && y > inset + 30 && y < H - inset - 30
    && !boxes.some(([bx, by, bw, bh]) => x > bx - pad && x < bx + bw + pad && y > by - pad && y < by + bh + pad)
    && !routeTracks.some((tr) => nearest(x, y, tr).d < 30)
    && !placed.some(([px, py]) => Math.hypot(px - x, py - y) < 170)
    && !isWater(x, y);
  // elevation numbers on a few index contours
  const labels = [];
  for (const { lev, lines } of indexLines) {
    for (const ln of lines) {
      if (labels.length >= (o.maxLabels ?? 6)) break;
      const cum = cumulative(ln.pts);
      const L = cum.at(-1);
      if (L < 240) continue;
      for (const fr of [0.5, 0.3, 0.7, 0.15, 0.85]) {
        const s = L * fr;
        const [x, y] = pointAt(ln.pts, cum, s);
        const a = pointAt(ln.pts, cum, s - 22);
        const b = pointAt(ln.pts, cum, s + 22);
        const c = pointAt(ln.pts, cum, s - 44);
        const d = pointAt(ln.pts, cum, s + 44);
        let ang = (Math.atan2(b[1] - a[1], b[0] - a[0]) * 180) / Math.PI;
        const ang2 = (Math.atan2(d[1] - c[1], d[0] - c[0]) * 180) / Math.PI;
        if (Math.abs(((ang - ang2 + 540) % 360) - 180) > 10) continue;
        if (!clear(x, y)) continue;
        if (ang > 90) ang -= 180;
        if (ang < -90) ang += 180;
        placed.push([x, y]);
        labels.push(haloText(x, y + 5, String(lev), { size: o.labelSize ?? 15, fill: C.moss, rot: ang }));
        break;
      }
    }
  }
  inner.push(labels.join(''));
  for (const lk of o.lakeNames ?? []) inner.push(haloText(lk.x, lk.y, lk.name, { size: lk.size ?? 17, fill: C.lake, italic: true, family: 'Nimbus Sans', spacing: 1.5, halo: C.lakeLight, haloW: 0.01 }));
  // roads: a cased stone track to the trailhead
  for (const rd of o.roads ?? []) {
    inner.push(`<path d="${poly(rd, false)}" fill="none" stroke="${C.stone}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>`);
    inner.push(`<path d="${poly(rd, false)}" fill="none" stroke="${C.paper}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  // routes: a paper casing, then ember; dashed where the route is on the water
  for (const rt of o.routes ?? []) {
    const wdt = rt.width ?? 4.5;
    inner.push(`<path d="${poly(rt.pts, false)}" fill="none" stroke="${C.paper}" stroke-width="${f(wdt * 2.2)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    const runs = [];
    let cur = null;
    for (const q of rt.pts) {
      const wet = rt.dashWater && isWater(q[0], q[1]);
      if (!cur || cur.wet !== wet) { if (cur) cur.pts.push(q); cur = { wet, pts: cur ? [cur.pts.at(-1), q] : [q] }; runs.push(cur); } else cur.pts.push(q);
    }
    for (const run of runs) {
      inner.push(`<path d="${poly(run.pts, false)}" fill="none" stroke="${C.ember}" stroke-width="${wdt}" stroke-linecap="${run.wet ? 'butt' : 'round'}" stroke-linejoin="round"${run.wet ? ` stroke-dasharray="${f(wdt * 3)} ${f(wdt * 2)}"` : ''}/>`);
    }
    if (rt.boardwalk) {
      let d = '';
      const cum = cumulative(rt.pts);
      for (let s = 6; s < cum.at(-1); s += 11) {
        const [x, y] = pointAt(rt.pts, cum, s);
        if (!rt.boardwalk(x, y)) continue;
        const [ax, ay] = pointAt(rt.pts, cum, s - 3);
        const [bx, by] = pointAt(rt.pts, cum, s + 3);
        const len = Math.hypot(bx - ax, by - ay) || 1;
        const nx = (-(by - ay) / len) * wdt * 1.5;
        const ny = ((bx - ax) / len) * wdt * 1.5;
        d += `M${f(x - nx)} ${f(y - ny)}L${f(x + nx)} ${f(y + ny)}`;
      }
      inner.push(`<path d="${d}" stroke="${C.ember}" stroke-width="2" fill="none"/>`);
    }
  }
  inner.push(...(o.marks ?? []));
  body.push(`<g clip-path="url(#${prefix}nl)">${inner.join('')}</g>`);
  body.push(`<rect x="${inset}" y="${inset}" width="${W - 2 * inset}" height="${H - 2 * inset}" fill="none" stroke="${C.ink}" stroke-width="1.6"/>`);
  // grid numbers in the margin
  let gn = '';
  for (let x = gx0, k = 0; x < W - inset - 10; x += g, k++) if (k % (o.gridMajor ?? 1) === 0) gn += `<text x="${f(x)}" y="${inset - 9}" font-family="Nimbus Mono PS" font-size="11" fill="${C.stone}" text-anchor="middle">${String(o.gridStart?.[0] + k).padStart(2, '0')}</text>`;
  for (let y = gx0, k = 0; y < H - inset - 10; y += g, k++) if (k % (o.gridMajor ?? 1) === 0) gn += `<text x="${inset - 5}" y="${f(y + 4)}" font-family="Nimbus Mono PS" font-size="11" fill="${C.stone}" text-anchor="end">${String(o.gridStart?.[1] - k).padStart(2, '0')}</text>`;
  body.push(gn);
  body.push(...(o.furniture ?? []));
  return { body: body.join(''), defs: defs.join('') };
}

/** The P square for a trailhead. */
function trailhead(x, y, s = 26) {
  return `<rect x="${f(x - s / 2 - 2)}" y="${f(y - s / 2 - 2)}" width="${s + 4}" height="${s + 4}" fill="${C.paper}"/><rect x="${f(x - s / 2)}" y="${f(y - s / 2)}" width="${s}" height="${s}" fill="${C.ember}"/><text x="${f(x)}" y="${f(y + s * 0.34)}" font-family="Nimbus Sans" font-weight="bold" font-size="${f(s * 0.78)}" fill="${C.bright}" text-anchor="middle">P</text>`;
}
/** A small ink triangle for a summit or viewpoint, with its height. */
function summit(x, y, height, s = 20) {
  const tri = `M${f(x)} ${f(y - s * 0.62)}L${f(x + s / 2)} ${f(y + s * 0.38)}L${f(x - s / 2)} ${f(y + s * 0.38)}Z`;
  return `<path d="${tri}" fill="${C.ink}" stroke="${C.paper}" stroke-width="2.5" paint-order="stroke"/><path d="${tri}" fill="${C.ink}"/>${haloText(x + s * 0.7, y + 6, String(height), { size: 15, fill: C.ink, anchor: 'start' })}`;
}

/** Title block, north arrow and scale bar: the furniture of a survey sheet. */
function furniture(W, H, { title, sub, corner = 'tl', pxPerKm, scaleKm = 1, legend = true, key = null }) {
  const inset = 26;
  const bw = Math.max(key ? 470 : 520, Math.round(title.length * 15.4 + 44));
  const bh = key ? 70 + key.length * 23 + 16 : legend ? 116 : 84;
  const bx = corner.includes('l') ? inset + 18 : W - inset - 18 - bw;
  const by = corner.includes('t') ? inset + 18 : H - inset - 18 - bh;
  let s = `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${C.paper}" stroke="${C.ink}" stroke-width="1.3"/>`;
  s += `<text x="${bx + 18}" y="${by + 36}" font-family="${MAP_FONT}" font-weight="bold" font-size="25" letter-spacing="3" fill="${C.ink}">${title}</text>`;
  s += `<path d="M${bx + 18} ${by + 48}H${bx + bw - 18}" stroke="${C.ink}" stroke-width="1"/>`;
  s += `<text x="${bx + 18}" y="${by + 68}" font-family="${MAP_FONT}" font-size="13" letter-spacing="2" fill="${C.stone}">${sub}</text>`;
  if (legend && !key) {
    const ly = by + 96;
    s += `<path d="M${bx + 18} ${ly - 4}h34" stroke="${C.paper}" stroke-width="10"/><path d="M${bx + 18} ${ly - 4}h34" stroke="${C.ember}" stroke-width="4.5" stroke-linecap="round"/>`;
    s += `<text x="${bx + 62}" y="${ly}" font-family="${MAP_FONT}" font-size="13" letter-spacing="1.5" fill="${C.ink}">ROUTE</text>`;
    s += trailhead(bx + 148, ly - 4, 16) + `<text x="${bx + 164}" y="${ly}" font-family="${MAP_FONT}" font-size="13" letter-spacing="1.5" fill="${C.ink}">TRAILHEAD</text>`;
    s += `<path d="M${bx + 268} ${ly - 12}l7 12h-14Z" fill="${C.ink}"/><text x="${bx + 284}" y="${ly}" font-family="${MAP_FONT}" font-size="13" letter-spacing="1.5" fill="${C.ink}">SUMMIT / VIEWPOINT</text>`;
  }
  if (key) {
    key.forEach((line, i) => {
      const y = by + 96 + i * 23;
      s += `<text x="${bx + 22}" y="${y}" font-family="${MAP_FONT}" font-weight="bold" font-size="16" fill="${C.ember}">${i + 1}</text>`;
      s += `<text x="${bx + 46}" y="${y}" font-family="${MAP_FONT}" font-size="15" letter-spacing="1.5" fill="${C.ink}">${line}</text>`;
    });
  }
  // scale bar and north arrow, in the opposite bottom corner
  const L = pxPerKm * scaleKm;
  const sw = Math.max(L, 120) + 150;
  const sx = corner === 'br' ? inset + 18 : W - inset - 18 - sw;
  const sy = H - inset - 18 - 96;
  s += `<rect x="${f(sx)}" y="${sy}" width="${f(sw)}" height="96" fill="${C.paper}" stroke="${C.ink}" stroke-width="1.3"/>`;
  const x0 = sx + 26;
  const y0 = sy + 54;
  s += `<rect x="${f(x0)}" y="${y0}" width="${f(L)}" height="8" fill="${C.paper}" stroke="${C.ink}" stroke-width="1.2"/>`;
  s += `<rect x="${f(x0)}" y="${y0}" width="${f(L / 2)}" height="8" fill="${C.ink}"/>`;
  s += `<text x="${f(x0)}" y="${y0 + 28}" font-family="${MAP_FONT}" font-size="15" fill="${C.ink}" text-anchor="middle">0</text>`;
  s += `<text x="${f(x0 + L)}" y="${y0 + 28}" font-family="${MAP_FONT}" font-size="15" fill="${C.ink}" text-anchor="middle">${scaleKm} km</text>`;
  s += `<text x="${f(x0)}" y="${y0 - 14}" font-family="${MAP_FONT}" font-size="12" letter-spacing="2" fill="${C.stone}">SCALE</text>`;
  const ax = sx + sw - 46;
  const ay = sy + 52;
  s += `<path d="M${f(ax)} ${ay - 30}L${f(ax + 11)} ${ay + 6}L${f(ax)} ${ay - 2}Z" fill="${C.paper}" stroke="${C.ink}" stroke-width="1.2" stroke-linejoin="round"/>`;
  s += `<path d="M${f(ax)} ${ay - 30}L${f(ax - 11)} ${ay + 6}L${f(ax)} ${ay - 2}Z" fill="${C.ink}" stroke="${C.ink}" stroke-width="1.2" stroke-linejoin="round"/>`;
  s += `<path d="M${f(ax)} ${ay - 2}V${ay + 30}" stroke="${C.ink}" stroke-width="2"/>`;
  s += `<text x="${f(ax)}" y="${ay - 36}" font-family="${MAP_FONT}" font-weight="bold" font-size="17" fill="${C.ink}" text-anchor="middle">N</text>`;
  return { svg: s, boxes: [[bx, by, bw, bh], [sx, sy, sw, 96]] };
}

/* the eight route sheets, in fractions of a 1600 × 1000 sheet */
const SHEETS = [
  {
    name: 'route-birch-hollow', title: 'BIRCH HOLLOW LOOP · 6.4 KM', km: 6.4, corner: 'tl', grid: [41, 72],
    hills: [[0.24, 0.36, 75, 0.11, 0.09], [0.74, 0.3, 90, 0.12, 0.09, 0.4], [0.82, 0.78, 55, 0.1], [0.14, 0.82, 45, 0.09]],
    basins: [[0.5, 0.6, 60, 0.075, 0.05, 0.3]],
    stream: { pts: [[0.66, 0.16], [0.62, 0.32], [0.57, 0.45], [0.51, 0.56]], depth: 16, s: 0.03 },
    route: { pts: [[0.33, 0.78], [0.24, 0.6], [0.27, 0.44], [0.4, 0.33], [0.55, 0.36], [0.66, 0.46], [0.68, 0.62], [0.6, 0.76], [0.46, 0.82]], closed: true, kind: 'loop' },
    road: [[0.33, 0.78], [0.3, 0.9], [0.26, 1.02]],
    lakes: [{ at: [0.5, 0.605], name: 'Birch Pond' }],
  },
  {
    name: 'route-basswood-ridge', title: 'BASSWOOD RIDGE TRAVERSE · 14.8 KM', km: 14.8, corner: 'tl', grid: [33, 80],
    ridges: [{ pts: [[-0.02, 0.84], [0.18, 0.66], [0.4, 0.58], [0.58, 0.45], [0.78, 0.36], [1.02, 0.24]], a: 95, s: 0.075 }],
    hills: [[0.4, 0.58, 30, 0.05], [0.69, 0.4, 50, 0.05], [0.88, 0.3, 25, 0.04]],
    basins: [[0.26, 0.3, 70, 0.08, 0.05, 0.3], [0.7, 0.78, 75, 0.1, 0.06, -0.2], [0.94, 0.66, 60, 0.05, 0.04]],
    stream: { pts: [[0.6, 0.52], [0.64, 0.62], [0.68, 0.73]], depth: 18, s: 0.03 },
    route: { pts: [[0.08, 0.74], [0.2, 0.63], [0.4, 0.565], [0.57, 0.455], [0.69, 0.395], [0.8, 0.35], [0.9, 0.3]], closed: false, kind: 'traverse' },
    road: [[0.08, 0.74], [0.05, 0.86], [0.03, 1.02]],
    road2: [[0.9, 0.3], [0.95, 0.18], [1.02, 0.1]],
    lakes: [{ at: [0.26, 0.305], name: 'Linden Lake' }, { at: [0.7, 0.785], name: 'Basswood Lake' }],
  },
  {
    name: 'route-cedar-ford', title: 'CEDAR RIVER FORD · 9.2 KM', km: 9.2, corner: 'bl', grid: [52, 64],
    river: { pts: [[-0.04, 0.33], [0.2, 0.4], [0.38, 0.47], [0.55, 0.5], [0.72, 0.58], [0.88, 0.66], [1.04, 0.7]], depth: 34, s: 0.1, width: 16 },
    hills: [[0.3, 0.16, 70, 0.12, 0.08], [0.72, 0.22, 65, 0.12, 0.08], [0.28, 0.82, 45, 0.1], [0.64, 0.86, 70, 0.1, 0.07]],
    route: { pts: [[0.16, 0.22], [0.3, 0.22], [0.43, 0.3], [0.5, 0.44], [0.52, 0.62], [0.62, 0.74], [0.74, 0.72], [0.81, 0.6], [0.8, 0.42], [0.74, 0.27], [0.6, 0.2], [0.42, 0.16], [0.27, 0.16]], closed: true, kind: 'loop' },
    road: [[0.16, 0.22], [0.08, 0.2], [-0.02, 0.18]],
    crossings: true,
  },
  {
    name: 'route-kettle-marsh', title: 'KETTLE MARSH BOARDWALK · 3.1 KM', km: 3.1, corner: 'tl', grid: [18, 47], base: 312, noise: 4,
    hills: [[0.14, 0.22, 26, 0.12], [0.86, 0.86, 22, 0.1], [0.12, 0.85, 18, 0.08]],
    basins: [[0.66, 0.44, 42, 0.17, 0.12, 0.2], [0.42, 0.56, 9, 0.13, 0.1]],
    route: { pts: [[0.2, 0.74], [0.3, 0.64], [0.4, 0.57], [0.46, 0.46], [0.47, 0.32], [0.38, 0.24], [0.27, 0.3], [0.21, 0.46], [0.17, 0.62]], closed: true, kind: 'loop' },
    road: [[0.2, 0.74], [0.18, 0.88], [0.15, 1.02]],
    lakes: [{ at: [0.68, 0.45], name: 'Kettle Lake' }],
    marsh: { at: [0.42, 0.56], r: 0.16, above: 6 }, view: [0.43, 0.5],
    stream: { pts: [[0.93, 0.74], [0.86, 0.64], [0.8, 0.55], [0.75, 0.5]], depth: 8, s: 0.03 },
    interval: 5,
  },
  {
    name: 'route-tamarack-ice', title: 'TAMARACK LAKE ICE ROUTE · 7.5 KM', km: 7.5, corner: 'tl', grid: [27, 55],
    basins: [[0.52, 0.5, 70, 0.21, 0.13, 0.25]],
    hills: [[0.47, 0.49, 64, 0.025], [0.18, 0.2, 60, 0.1], [0.86, 0.8, 70, 0.1], [0.84, 0.16, 50, 0.08], [0.14, 0.86, 40, 0.08]],
    stream: { pts: [[0.81, 0.26], [0.77, 0.32], [0.72, 0.38], [0.67, 0.43]], depth: 14, s: 0.03 },
    route: { pts: [[0.36, 0.88], [0.46, 0.81], [0.53, 0.67], [0.545, 0.5], [0.53, 0.33], [0.47, 0.2], [0.33, 0.19], [0.23, 0.31], [0.205, 0.5], [0.24, 0.7], [0.3, 0.83]], closed: true, kind: 'loop', dashWater: true },
    road: [[0.36, 0.88], [0.38, 0.95], [0.4, 1.02]],
    lakes: [{ at: [0.71, 0.5], name: 'Tamarack Lake' }],
  },
  {
    name: 'route-portage-loop', title: 'PORTAGE LOOP · 11 KM', km: 11, corner: 'bl', grid: [60, 38],
    basins: [[0.3, 0.45, 60, 0.13, 0.09, 0.2], [0.72, 0.52, 60, 0.13, 0.1, -0.3]],
    hills: [[0.5, 0.14, 60, 0.1], [0.52, 0.9, 55, 0.1], [0.1, 0.2, 45, 0.08], [0.92, 0.86, 40, 0.08], [0.51, 0.5, 20, 0.04]],
    stream: { pts: [[0.42, 0.48], [0.5, 0.52], [0.6, 0.53]], depth: 12, s: 0.025 },
    route: { pts: [[0.14, 0.66], [0.3, 0.66], [0.46, 0.62], [0.58, 0.72], [0.74, 0.76], [0.89, 0.64], [0.88, 0.38], [0.72, 0.28], [0.56, 0.36], [0.42, 0.25], [0.24, 0.24], [0.12, 0.42]], closed: true, kind: 'loop' },
    road: [[0.14, 0.66], [0.06, 0.74], [-0.02, 0.8]],
    lakes: [{ at: [0.3, 0.455], name: 'Upper Portage Lake' }, { at: [0.72, 0.525], name: 'Lower Portage Lake' }],
  },
  {
    name: 'route-lookout-spur', title: 'LOOKOUT SPUR · 4.2 KM', km: 4.2, corner: 'tl', grid: [45, 61],
    hills: [[0.64, 0.36, 150, 0.11, 0.085, 0.2], [0.86, 0.2, 60, 0.08]],
    basins: [[0.22, 0.72, 55, 0.1, 0.06]],
    stream: { pts: [[0.52, 0.46], [0.43, 0.55], [0.35, 0.63], [0.27, 0.7]], depth: 14, s: 0.03 },
    route: { pts: [[0.32, 0.86], [0.42, 0.78], [0.52, 0.71], [0.6, 0.69], [0.53, 0.63], [0.6, 0.585], [0.55, 0.53], [0.62, 0.49], [0.6, 0.43], [0.635, 0.37]], closed: false, kind: 'out-and-back' },
    road: [[0.32, 0.86], [0.2, 0.9], [0.04, 0.94], [-0.02, 0.95]],
    lakes: [{ at: [0.22, 0.725], name: 'Spur Lake' }],
  },
  {
    name: 'route-night-meadow', title: 'NIGHT SKY MEADOW · 5 KM', km: 5, corner: 'tl', grid: [12, 29], noise: 8,
    hills: [[0.3, 0.32, 40, 0.06], [0.84, 0.72, 50, 0.1], [0.12, 0.84, 35, 0.08], [0.8, 0.14, 35, 0.08]],
    basins: [[0.74, 0.34, 50, 0.04, 0.03]],
    stream: { pts: [[0.81, 0.2], [0.79, 0.25], [0.77, 0.3], [0.745, 0.335]], depth: 12, s: 0.025 },
    route: { pts: [[0.5, 0.82], [0.3, 0.74], [0.24, 0.52], [0.33, 0.3], [0.52, 0.24], [0.68, 0.36], [0.72, 0.56], [0.66, 0.74]], closed: true, kind: 'loop' },
    road: [[0.5, 0.82], [0.52, 0.92], [0.54, 1.02]],
    lakes: [],
    clearings: [[0.5, 0.52, 0.17]],
  },
];

/** Everything a sheet is made of, in pixels: terrain features, field and route. */
function sheetData(spec, W = 1600, H = 1000) {
  const feat = sheetFeatures(spec, W, H);
  const field = heightfield(feat, { base: spec.base ?? 335, noise: spec.noise ?? 16, noiseScale: 0.14 * W, seed: hash(spec.name), warp: (spec.warp ?? 0.06) * W, warpScale: 0.2 * W });
  return { spec, W, H, feat, field, route: routeOf(spec, W, H) };
}

/** One route sheet: a survey map of a single trail. */
function routeSheet(spec, W = 1600, H = 1000, prefix = 'm') {
  const sd = sheetData(spec, W, H);
  const { field, route } = sd;
  const P = ([x, y]) => [x * W, y * H];
  const fur = furniture(W, H, { title: spec.title, sub: 'FIELDNOTES SURVEY  ·  CONTOUR INTERVAL ' + (spec.interval ?? 10) + ' M', corner: spec.corner, pxPerKm: route.pxPerKm });
  // marks: trailhead(s) and the highest point along the route
  const marks = [];
  // the viewpoint: given, or else the highest point the route reaches
  let top = route.pts[0];
  if (spec.view) {
    const [vx, vy] = P(spec.view);
    for (const q of route.pts) if (Math.hypot(q[0] - vx, q[1] - vy) < Math.hypot(top[0] - vx, top[1] - vy)) top = q;
  } else for (const q of route.pts) if (field(q[0], q[1]) > field(top[0], top[1])) top = q;
  marks.push(summit(top[0], top[1] - 14, Math.round(field(top[0], top[1]))));
  if (spec.crossings) {
    // label the ford and mark the footbridge where the loop crosses the river
    const river = track(sd.feat.valleys[0].pts);
    const hits = [];
    let wasIn = false;
    route.pts.forEach((q) => { const inR = nearest(q[0], q[1], river).d < 9; if (inR && !wasIn) hits.push(q); wasIn = inR; });
    if (hits[0]) marks.push(haloText(hits[0][0] - 24, hits[0][1] + 4, 'FORD', { size: 15, fill: C.ink, anchor: 'end', spacing: 2 }));
    if (hits[1]) marks.push(`<path d="M${f(hits[1][0] - 14)} ${f(hits[1][1] - 12)}l6 5h16l6 -5M${f(hits[1][0] - 14)} ${f(hits[1][1] + 12)}l6 -5h16l6 5" stroke="${C.ink}" stroke-width="2" fill="none" transform="rotate(-60 ${f(hits[1][0])} ${f(hits[1][1])})"/>`);
  }
  const start = route.pts[0];
  marks.push(trailhead(start[0], start[1]));
  if (route.kind === 'traverse') marks.push(trailhead(route.pts.at(-1)[0], route.pts.at(-1)[1]));
  const roads = [spec.road, spec.road2].filter(Boolean).map((rd) => spline(rd.map(P), false, 4));
  const waters = sd.feat.valleys.map((v) => ({ pts: v.width ? v.pts : v.pts.slice(0, Math.ceil(v.pts.length * 0.96)), width: v.width }));
  let marsh = null;
  if (spec.marsh) {
    const [mx, my] = P(spec.marsh.at);
    const mr = spec.marsh.r * W;
    marsh = (x, y) => Math.hypot(x - mx, y - my) < mr && field(x, y) < WATER + spec.marsh.above;
  }
  const { body, defs } = drawMap({
    W, H, field, prefix, seed: hash(spec.name), interval: spec.interval ?? 10,
    gridPx: route.pxPerKm, gridStart: spec.grid, clearings: (spec.clearings ?? []).map(([x, y, rr]) => [x * W, y * H, rr * W]),
    waters, marsh, roads, boxes: fur.boxes,
    routes: [{ pts: route.pts, dashWater: spec.route.dashWater, boardwalk: marsh }],
    lakeNames: (spec.lakes ?? []).map((lk) => ({ x: lk.at[0] * W, y: lk.at[1] * H + 6, name: lk.name })),
    marks, furniture: [fur.svg],
  });
  return { body, defs, sd };
}

/* the region overview: every sheet's terrain set down at one scale */
const REGION = {
  W: 2400, H: 1000, pxPerKm: 60,
  place: {
    'route-birch-hollow': [0.33, 0.3], 'route-basswood-ridge': [0.6, 0.4], 'route-cedar-ford': [0.86, 0.72], 'route-kettle-marsh': [0.47, 0.8],
    'route-tamarack-ice': [0.9, 0.3], 'route-portage-loop': [0.66, 0.84], 'route-lookout-spur': [0.18, 0.7], 'route-night-meadow': [0.35, 0.58],
  },
  hills: [[0.08, 0.3, 70, 0.05], [0.24, 0.16, 60, 0.04], [0.5, 0.15, 55, 0.05], [0.78, 0.12, 50, 0.04], [0.96, 0.55, 60, 0.04], [0.06, 0.88, 40, 0.04], [0.76, 0.62, 40, 0.03]],
  basins: [[0.17, 0.42, 70, 0.06, 0.035, 0.4], [0.44, 0.38, 60, 0.035, 0.03, -0.3], [0.57, 0.66, 70, 0.05, 0.03, 0.2], [0.72, 0.2, 60, 0.03, 0.02], [0.27, 0.86, 60, 0.04, 0.025, -0.2]],
  lakeNames: [[0.17, 0.425, 'Big Spruce Lake'], [0.57, 0.665, 'Long Lake']],
  riverHead: [[0.62, 1.04], [0.7, 0.92]],
  riverTail: [[1.04, 0.92]],
};

function regionMap() {
  const { W, H, pxPerKm } = REGION;
  const feats = { hills: [], ridges: [], valleys: [] };
  const own = sheetFeatures(REGION, W, H);
  feats.hills.push(...own.hills);
  const routes = [];
  const key = [];
  let riverPts = null;
  SHEETS.forEach((spec, i) => {
    const sd = sheetData(spec);
    const k = pxPerKm / sd.route.pxPerKm;
    const xs = sd.route.pts.map((q) => q[0]);
    const ys = sd.route.pts.map((q) => q[1]);
    const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
    const at = [REGION.place[spec.name][0] * W, REGION.place[spec.name][1] * H];
    const pf = placeFeatures(sd.feat, k, c, at);
    feats.hills.push(...pf.hills);
    // a sheet that sits lower or higher than the region keeps its own ground level
    const lift = (spec.base ?? 335) - 335;
    if (lift) feats.hills.push({ x: at[0], y: at[1], a: lift, sx: sd.W * k * 0.4, sy: sd.H * k * 0.4, rot: 0 });
    feats.ridges.push(...pf.ridges);
    if (spec.river) riverPts = pf.valleys[0].pts;
    else feats.valleys.push(...pf.valleys.map((v) => ({ ...v, width: 0 })));
    const T = ([x, y]) => [at[0] + (x - c[0]) * k, at[1] + (y - c[1]) * k];
    routes.push({ pts: sd.route.pts.map(T), dashWater: spec.route.dashWater, width: 3, n: i + 1 });
    key.push(spec.title.replace(' · ', '  ·  '));
  });
  // the Cedar runs the whole way across, through its sheet
  const P = ([x, y]) => [x * W, y * H];
  const river = spline([...REGION.riverHead.map(P), riverPts[0], riverPts[Math.floor(riverPts.length / 2)], riverPts.at(-1), ...REGION.riverTail.map(P)], false, 8);
  feats.valleys.push({ pts: river, depth: 30, s: 70, width: 9 });
  const field = heightfield(feats, { base: 335, noise: 16, noiseScale: 220, seed: hash('map-region'), warp: 50, warpScale: 260 });
  const fur = furniture(W, H, { title: 'THE FIELDNOTES COUNTRY', sub: 'EIGHT ROUTES  ·  CONTOUR INTERVAL 20 M', corner: 'tl', pxPerKm, scaleKm: 5, key });
  const marks = [];
  routes.forEach((rt) => {
    const [x, y] = rt.pts[0];
    marks.push(`<rect x="${f(x - 6)}" y="${f(y - 6)}" width="12" height="12" fill="${C.ember}" stroke="${C.paper}" stroke-width="2"/>`);
    marks.push(haloText(x - 14, y + 7, String(rt.n), { size: 22, weight: 'bold', fill: C.ember, anchor: 'end', haloW: 5 }));
  });
  const { body, defs } = drawMap({
    W, H, field, prefix: 'r', seed: hash('map-region'), interval: 20, cell: 6,
    gridPx: pxPerKm, gridOp: 0.45, gridMajor: 5, gridStart: [20, 60], boxes: fur.boxes, maxLabels: 8, labelSize: 14,
    waters: [{ pts: river, width: 9 }, ...feats.valleys.filter((v) => !v.width).map((v) => ({ pts: v.pts, width: 0 }))], streamW: 1.4,
    routes, marks, furniture: [fur.svg], minLake: 150, woodScale: 200, woodTint: 0.92, minorW: 0.9, majorW: 1.5, shoreW: 1.3,
    lakeNames: REGION.lakeNames.map(([x, y, name]) => ({ x: x * W, y: y * H + 6, name, size: 16 })),
  });
  return svg(W, H, body, defs);
}

/* ── kits: gear laid out flat, shot from straight above ─────────────────────
   Each object is drawn in its own box (origin top left, light from the top
   left). A layout sets them in rows at right angles with even gutters, and
   one soft shadow filter falls down-right from all of them alike.          */

const rr = (x, y, w, h, r, fill, extra = '') => `<rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" rx="${f(r)}" fill="${hex(fill)}"${extra}/>`;
/** A rounded rectangle path with its own radius per corner: [tl, tr, br, bl]. */
function rrD(x, y, w, h, [a, b, c, d]) {
  return `M${f(x + a)} ${f(y)}H${f(x + w - b)}A${f(b)} ${f(b)} 0 0 1 ${f(x + w)} ${f(y + b)}V${f(y + h - c)}A${f(c)} ${f(c)} 0 0 1 ${f(x + w - c)} ${f(y + h)}H${f(x + d)}A${f(d)} ${f(d)} 0 0 1 ${f(x)} ${f(y + h - d)}V${f(y + a)}A${f(a)} ${f(a)} 0 0 1 ${f(x + a)} ${f(y)}Z`;
}
const circleD = (cx, cy, r) => `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
const item = (w, h, s) => ({ w, h, svg: s });
/** The same object turned a quarter, so long things can lie either way. */
const turn = (it) => ({ w: it.h, h: it.w, svg: `<g transform="translate(${f(it.h)} 0) rotate(90)">${it.svg}</g>` });
const shade = (c, t = 0.22) => mix(c, 'ink', t);
const light = (c, t = 0.25) => mix(c, 'bright', t);

function notebook({ w = 230, h = 320, cover = C.moss, band = C.ink } = {}) {
  let s = rr(6, 5, w - 6, h - 5, 7, mix('paper', 'lichen', 0.3));
  for (let i = 1; i < 4; i++) s += `<path d="M${f(w - 6 + i * 1.6)} 14V${f(h - 10)}M14 ${f(h - 6 + i * 1.4)}H${f(w - 10)}" stroke="${C.lichen}" stroke-width="0.8"/>`;
  s += rr(0, 0, w - 6, h - 6, 8, cover);
  s += `<path d="${rrD(0, 0, 20, h - 6, [8, 0, 0, 8])}" fill="${shade(cover, 0.25)}"/>`;
  s += `<path d="M2 2H${w - 10}" stroke="${light(cover, 0.2)}" stroke-width="2" stroke-linecap="round"/>`;
  s += rr(52, 48, 120, 40, 3, mix('paper', 'lichen', 0.15));
  s += `<path d="M62 62h90M62 76h64" stroke="${C.stone}" stroke-width="2"/>`;
  s += rr(w - 46, -3, 11, h, 2, band);
  s += rr(w * 0.42, h - 8, 9, 34, 1, C.ember);
  return item(w, h + 26, s);
}

function pencil({ len = 330, d = 20, body = C.ochre, eraser = C.rose } = {}) {
  let s = `<path d="${rrD(0, 1, 26, d - 2, [5, 0, 0, 5])}" fill="${eraser}"/>`;
  s += rr(22, 0, 24, d, 2, mix('fog', 'stone', 0.25));
  s += `<path d="M28 0v${d}M34 0v${d}M40 0v${d}" stroke="${mix('fog', 'stone', 0.55)}" stroke-width="1.4"/>`;
  s += `<rect x="46" y="0" width="${len - 92}" height="${d}" fill="${hex(body)}"/>`;
  s += `<rect x="46" y="0" width="${len - 92}" height="${f(d * 0.3)}" fill="${light(body, 0.22)}"/>`;
  s += `<rect x="46" y="${f(d * 0.68)}" width="${len - 92}" height="${f(d * 0.32)}" fill="${shade(body, 0.18)}"/>`;
  s += `<path d="M${len - 46} 0L${len - 13} ${f(d * 0.36)}V${f(d * 0.64)}L${len - 46} ${d}Z" fill="${mix('ochre', 'paper', 0.55)}"/>`;
  s += `<path d="M${len - 15} ${f(d * 0.34)}L${len} ${f(d / 2)}L${len - 15} ${f(d * 0.66)}Z" fill="${C.ink}"/>`;
  return item(len, d, s);
}

function compass({ w = 170, h = 270 } = {}) {
  let s = rr(0, 0, w, h, 14, mix('bright', 'lakeLight', 0.35), ' fill-opacity="0.82"');
  let ticks = '';
  for (let y = 24, k = 0; y < h - 20; y += 6, k++) ticks += `M0 ${y}h${k % 5 ? 6 : 12}`;
  s += `<path d="${ticks}" stroke="${C.stone}" stroke-width="1.2"/>`;
  s += `<path d="M${w / 2} 14L${w / 2 + 14} 44H${w / 2 + 5}V74H${w / 2 - 5}V44H${w / 2 - 14}Z" fill="${C.ember}"/>`;
  const cx = w / 2 + 8;
  const cy = h * 0.62;
  const R = w * 0.37;
  s += `<path d="${circleD(cx, cy, R)}" fill="${mix('ink', 'stone', 0.3)}"/>`;
  let bt = '';
  for (let k = 0; k < 36; k++) {
    const a = (k / 36) * Math.PI * 2;
    const r1 = R - (k % 9 === 0 ? 9 : 5);
    bt += `M${f(cx + Math.cos(a) * r1)} ${f(cy + Math.sin(a) * r1)}L${f(cx + Math.cos(a) * (R - 1.5))} ${f(cy + Math.sin(a) * (R - 1.5))}`;
  }
  s += `<path d="${bt}" stroke="${C.fog}" stroke-width="1.4"/>`;
  s += `<path d="${circleD(cx, cy, R * 0.74)}" fill="${mix('lakeLight', 'bright', 0.45)}"/>`;
  s += `<path d="M${f(cx - 9)} ${f(cy + R * 0.55)}V${f(cy - R * 0.45)}L${f(cx)} ${f(cy - R * 0.62)}L${f(cx + 9)} ${f(cy - R * 0.45)}V${f(cy + R * 0.55)}" fill="none" stroke="${C.ember}" stroke-width="2"/>`;
  s += `<path d="M${f(cx)} ${f(cy - R * 0.66)}L${f(cx + 7)} ${f(cy)}L${f(cx - 7)} ${f(cy)}Z" fill="${C.ember}"/><path d="M${f(cx)} ${f(cy + R * 0.66)}L${f(cx + 7)} ${f(cy)}L${f(cx - 7)} ${f(cy)}Z" fill="${C.ink}"/>`;
  s += `<path d="${circleD(cx, cy, 3)}" fill="${C.fog}"/>`;
  s += `<text x="${f(cx)}" y="${f(cy - R + 18)}" font-family="Nimbus Sans" font-weight="bold" font-size="12" fill="${C.bright}" text-anchor="middle">N</text>`;
  s += `<path d="${circleD(w / 2, h - 18, 6)}" fill="${mix('stone', 'ink', 0.3)}" opacity="0.6"/>`;
  return item(w, h, s);
}

function foldedMap({ w = 250, h = 320 } = {}) {
  let s = rr(0, 0, w, h, 2, mix('paper', 'bright', 0.4));
  const cw = w / 2;
  const ch = h / 3;
  for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) if ((i + j) % 2) s += `<rect x="${f(i * cw)}" y="${f(j * ch)}" width="${f(cw)}" height="${f(ch)}" fill="${C.lichen}" opacity="0.28"/>`;
  let contours = '';
  for (let k = 0; k < 9; k++) {
    const y0 = ch * 0.9 + k * 22;
    let d = `M6 ${f(y0)}`;
    for (let x = 6; x <= w - 6; x += 12) d += `L${x} ${f(y0 + 9 * Math.sin(x / 34 + k * 0.6) + 5 * Math.sin(x / 13 + k))}`;
    contours += d;
  }
  s += `<path d="${contours}" stroke="${C.sage}" stroke-width="1.3" fill="none" opacity="0.8"/>`;
  const lake = chaikin([[60, 190], [110, 175], [150, 200], [130, 232], [80, 236], [52, 214], [60, 190]], true, 3);
  s += `<path d="${poly(lake)}" fill="${C.lakeLight}" stroke="${C.lake}" stroke-width="1.2"/>`;
  s += `<path d="M20 290C70 260 110 270 150 250S220 160 232 140" stroke="${C.ember}" stroke-width="3" fill="none" stroke-dasharray="7 5"/>`;
  s += rr(cw + 8, 10, cw - 18, 40, 2, C.moss);
  s += `<text x="${f(cw + cw / 2 - 1)}" y="36" font-family="${MAP_FONT}" font-weight="bold" font-size="13" letter-spacing="2" fill="${C.paper}" text-anchor="middle">SHEET 4</text>`;
  s += `<path d="M${f(cw)} 0V${h}M0 ${f(ch)}H${w}M0 ${f(2 * ch)}H${w}" stroke="${mix('lichen', 'stone', 0.3)}" stroke-width="1.2"/>`;
  return item(w, h, s);
}

function headlamp({ w = 250, h = 180 } = {}) {
  const strap = mix('stone', 'ink', 0.35);
  let s = `<path d="${rrD(0, 24, w, h - 24, [64, 64, 64, 64])}${rrD(22, 46, w - 44, h - 68, [44, 44, 44, 44])}" fill="${strap}" fill-rule="evenodd"/>`;
  s += `<path d="${rrD(11, 35, w - 22, h - 46, [54, 54, 54, 54])}" fill="none" stroke="${C.ochre}" stroke-width="2" stroke-dasharray="10 8" opacity="0.8"/>`;
  s += rr(w / 2 - 50, 0, 100, 58, 14, C.ink);
  s += rr(w / 2 - 46, 3, 92, 8, 4, light(C.ink, 0.15));
  s += `<path d="${circleD(w / 2 - 14, 30, 18)}" fill="${C.fog}"/><path d="${circleD(w / 2 - 14, 30, 11)}" fill="${C.bright}"/>`;
  s += rr(w / 2 + 16, 22, 20, 14, 4, C.ember);
  return item(w, h, s);
}

function bottle({ w = 116, h = 350, color = C.lake } = {}) {
  let s = `<path d="M${f(w * 0.24)} 30H${f(w * 0.76)}L${f(w * 0.9)} 52H${f(w * 0.1)}Z" fill="${shade(color, 0.1)}"/>`;
  s += rr(0, 46, w, h - 46, 26, color);
  s += rr(w * 0.12, 64, w * 0.12, h - 96, w * 0.06, light(color, 0.3));
  s += rr(w - 22, 60, 12, h - 90, 6, shade(color, 0.2));
  s += `<rect x="0" y="${f(h * 0.5)}" width="${w}" height="${f(h * 0.18)}" fill="${mix('paper', color, 0.12)}"/>`;
  s += `<path d="M18 ${f(h * 0.56)}h${w - 36}M18 ${f(h * 0.62)}h${f(w * 0.45)}" stroke="${C.stone}" stroke-width="2"/>`;
  s += rr(w * 0.2, 0, w * 0.6, 34, 7, C.ink);
  s += `<path d="${rrD(w * 0.34, -18, w * 0.32, 26, [12, 12, 0, 0])}${rrD(w * 0.42, -10, w * 0.16, 18, [6, 6, 0, 0])}" fill="${C.ink}" fill-rule="evenodd"/>`;
  return { w, h: h + 18, svg: `<g transform="translate(0 18)">${s}</g>` };
}

/** A rain shell folded square: hood rolled into the collar, sleeves folded behind, zip down the front. */
function shell({ w = 290, h = 310, color = mix('lake', 'moss', 0.35) } = {}) {
  let s = `<path d="${rrD(0, 26, w, h - 26, [26, 26, 18, 18])}" fill="${color}"/>`;
  s += `<path d="${rrD(0, 26, 44, h - 26, [26, 0, 0, 18])}" fill="${shade(color, 0.14)}"/><path d="${rrD(w - 44, 26, 44, h - 26, [0, 26, 18, 0])}" fill="${shade(color, 0.14)}"/>`;
  s += `<path d="M44 40V${h - 6}M${w - 44} 40V${h - 6}" stroke="${shade(color, 0.32)}" stroke-width="2"/>`;
  s += `<path d="${rrD(w * 0.2, 0, w * 0.6, 62, [28, 28, 10, 10])}" fill="${shade(color, 0.08)}"/>`;
  s += `<path d="M${f(w * 0.24)} 22Q${w / 2} 4 ${f(w * 0.76)} 22" stroke="${light(color, 0.2)}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  s += `<path d="M${w / 2} 62V${h}" stroke="${shade(color, 0.45)}" stroke-width="5" stroke-dasharray="3 2"/>`;
  s += rr(w / 2 - 6, 64, 12, 26, 3, C.ink);
  s += `<path d="M${f(w * 0.58)} ${f(h * 0.4)}l66 -18" stroke="${shade(color, 0.45)}" stroke-width="3" stroke-linecap="round"/>`;
  s += `<path d="M${f(w * 0.3)} 54v26M${f(w * 0.7)} 54v26" stroke="${C.ink}" stroke-width="2.5"/>` + rr(w * 0.3 - 5, 78, 10, 16, 4, C.ochre) + rr(w * 0.7 - 5, 78, 10, 16, 4, C.ochre);
  s += `<path d="M58 ${f(h * 0.62)}q40 -10 70 4M${w - 120} ${f(h * 0.78)}q30 -8 56 2" stroke="${light(color, 0.18)}" stroke-width="3" fill="none" stroke-linecap="round"/>`;
  s += `<rect x="44" y="${f(h - 30)}" width="${w - 88}" height="30" fill="${shade(color, 0.08)}"/>`;
  return item(w, h, s);
}

function knife({ w = 230, h = 46, handle = mix('ochre', 'ink', 0.4) } = {}) {
  const metal = mix('fog', 'stone', 0.3);
  let s = rr(16, 0, w - 46, 14, 7, light(metal, 0.2));
  s += `<path d="M${w * 0.55} 2v8" stroke="${C.stone}" stroke-width="2"/>`;
  s += rr(0, 8, w, h - 8, 18, handle);
  s += rr(4, 12, w - 8, 5, 2.5, light(handle, 0.2));
  s += `<path d="${rrD(0, 8, 36, h - 8, [18, 0, 0, 18])}" fill="${metal}"/><path d="${rrD(w - 36, 8, 36, h - 8, [0, 18, 18, 0])}" fill="${metal}"/>`;
  s += `<path d="${circleD(w * 0.35, 27, 3.5)}${circleD(w * 0.68, 27, 3.5)}" fill="${metal}"/>`;
  s += `<path d="${circleD(16, 27, 5)}" fill="${C.ink}"/>`;
  return item(w, h, s);
}

function whistle({ w = 124, h = 44, color = C.ochre } = {}) {
  let s = `<path d="M${w - 18} ${h / 2}c18 -2 30 6 34 16" stroke="${C.ink}" stroke-width="3" fill="none"/>`;
  s += `<path d="${rrD(30, 0, w - 30, h, [8, 22, 22, 8])}" fill="${color}"/>`;
  s += `<path d="${rrD(0, h * 0.2, 36, h * 0.6, [6, 0, 0, 6])}" fill="${shade(color, 0.12)}"/>`;
  s += rr(40, 8, 22, 10, 2, C.ink);
  s += `<path d="${circleD(w - 18, h / 2, 6)}" fill="${shade(color, 0.5)}"/>`;
  s += rr(34, 3, w - 52, 4, 2, light(color, 0.3));
  return item(w + 18, h + 10, s);
}

function firstAid({ w = 250, h = 170, color = C.ember } = {}) {
  let s = rr(0, 0, w, h, 26, color);
  s += `<path d="${rrD(0, h - 34, w, 34, [0, 0, 26, 26])}" fill="${shade(color, 0.18)}"/>`;
  s += `<path d="M24 20H${w - 24}" stroke="${shade(color, 0.5)}" stroke-width="5" stroke-linecap="round"/>`;
  s += rr(w - 52, 14, 14, 26, 3, C.ink);
  s += rr(10, 10, w - 20, h - 20, 18, 'none', ` stroke="${light(color, 0.35)}" stroke-width="1.6" stroke-dasharray="5 4"`);
  s += rr(w / 2 - 12, h / 2 - 34, 24, 68, 3, C.bright) + rr(w / 2 - 34, h / 2 - 12, 68, 24, 3, C.bright);
  return item(w, h, s);
}

function beanie({ w = 240, h = 270, color = C.ochre } = {}) {
  let s = `<path d="${circleD(w / 2, 24, 26)}" fill="${light(color, 0.35)}"/>`;
  s += `<path d="M0 ${h}V${f(h * 0.45)}C0 ${f(h * 0.02)} ${w} ${f(h * 0.02)} ${w} ${f(h * 0.45)}V${h}Z" fill="${color}"/>`;
  let ribs = '';
  for (let x = 14; x < w - 6; x += 13) {
    const t = (x - w / 2) / (w / 2);
    const top = h * 0.45 - h * 0.33 * Math.sqrt(Math.max(0, 1 - t * t)) + 14;
    ribs += `M${x} ${f(top)}V${f(h * 0.66)}`;
  }
  s += `<path d="${ribs}" stroke="${shade(color, 0.12)}" stroke-width="3"/>`;
  s += rr(0, h * 0.66, w, h * 0.34, 6, shade(color, 0.15));
  let cuff = '';
  for (let x = 8; x < w; x += 9) cuff += `M${x} ${f(h * 0.68)}V${h - 4}`;
  s += `<path d="${cuff}" stroke="${shade(color, 0.32)}" stroke-width="3"/>`;
  return item(w, h, s);
}

function glove(color) {
  const cuff = shade(color, 0.2);
  let s = '';
  [[10, 30], [38, 8], [66, 14], [94, 36]].forEach(([x, y]) => { s += rr(x, y, 25, 110, 12.5, color); });
  s += `<g transform="rotate(-28 18 150)">${rr(-14, 92, 28, 82, 14, color)}</g>`;
  s += rr(8, 80, 112, 104, 26, color);
  s += rr(12, 172, 104, 72, 10, cuff);
  let rib = '';
  for (let x = 20; x < 112; x += 9) rib += `M${x} 178V238`;
  s += `<path d="${rib}" stroke="${shade(color, 0.38)}" stroke-width="2.5"/>`;
  s += `<path d="M24 96h80" stroke="${light(color, 0.2)}" stroke-width="3" stroke-linecap="round"/>`;
  return s;
}
const gloves = (color = C.ink) => item(290, 246, `<g transform="translate(18 0)">${glove(color)}</g><g transform="translate(290 0) scale(-1 1) translate(18 0)">${glove(color)}</g>`);

function sock(color, accent) {
  let s = `<path d="${rrD(0, 0, 92, 232, [10, 10, 0, 0])}" fill="${color}"/>`;
  s += `<path d="${rrD(0, 196, 116, 92, [0, 0, 0, 44])}" fill="${color}"/>`;
  s += `<path d="${rrD(112, 196, 40, 92, [0, 44, 44, 0])}" fill="${accent}"/>`;
  s += `<path d="${rrD(0, 236, 52, 52, [0, 0, 0, 44])}" fill="${accent}"/>`;
  s += rr(0, 0, 92, 48, 10, shade(color, 0.12));
  let rib = '';
  for (let x = 8; x < 90; x += 8) rib += `M${x} 4V46`;
  s += `<path d="${rib}" stroke="${shade(color, 0.25)}" stroke-width="2"/>`;
  s += `<rect x="0" y="72" width="92" height="12" fill="${accent}"/><rect x="0" y="92" width="92" height="6" fill="${accent}"/>`;
  return s;
}
const socks = (color = mix('paper', 'lichen', 0.35), accent = C.ember) => item(330, 288, `${sock(color, accent)}<g transform="translate(176 0)">${sock(color, accent)}</g>`);

function mug({ color = C.moss } = {}) {
  let s = `<path d="${rrD(70, 100, 80, 80, [0, 0, 30, 30])}${rrD(92, 100, 36, 56, [0, 0, 14, 14])}" fill="${shade(color, 0.15)}" fill-rule="evenodd"/>`;
  s += `<path d="${rrD(32, 0, 190, 120, [0, 14, 14, 0])}" fill="${color}"/>`;
  s += `<rect x="40" y="12" width="174" height="20" rx="10" fill="${light(color, 0.25)}"/>`;
  s += `<rect x="32" y="92" width="190" height="28" fill="${shade(color, 0.15)}"/>`;
  s += `<path d="${rrD(0, -6, 40, 132, [12, 0, 0, 12])}" fill="${C.ink}"/>`;
  s += rr(8, 40, 14, 44, 6, mix('stone', 'ink', 0.2));
  return { w: 222, h: 186, svg: `<g transform="translate(0 6)">${s}</g>` };
}

function thermometer({ w = 36, h = 260 } = {}) {
  let s = rr(0, 0, w, h, w / 2, C.bright);
  s += rr(w - 8, 10, 5, h - 30, 2.5, C.fog);
  let t = '';
  for (let y = 30, k = 0; y < h - 50; y += 8, k++) t += `M6 ${y}h${k % 5 ? 6 : 11}`;
  s += `<path d="${t}" stroke="${C.stone}" stroke-width="1.3"/>`;
  s += rr(w / 2 - 2.5, h * 0.4, 5, h * 0.5, 2.5, C.ember);
  s += `<path d="${circleD(w / 2, h - w / 2 - 2, w * 0.3)}" fill="${C.ember}"/>`;
  s += `<path d="${circleD(w / 2, 12, 4.5)}" fill="${C.stone}"/>`;
  return item(w, h, s);
}

function stove({ d = 190 } = {}) {
  const c = d / 2;
  const metal = mix('fog', 'stone', 0.35);
  let s = '';
  for (let k = 0; k < 3; k++) {
    const a = -90 + k * 120;
    s += `<g transform="rotate(${a} ${c} ${c})">${rr(c, c - 9, c - 4, 18, 4, mix('stone', 'ink', 0.25))}<path d="M${c + 40} ${c - 9}v-5M${c + 54} ${c - 9}v-5M${c + 68} ${c - 9}v-5" stroke="${mix('stone', 'ink', 0.25)}" stroke-width="4"/></g>`;
  }
  s += `<path d="${circleD(c, c, 36)}" fill="${metal}"/><path d="${circleD(c, c, 24)}" fill="${mix('stone', 'ink', 0.3)}"/>`;
  let holes = '';
  for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; holes += circleD(c + Math.cos(a) * 30, c + Math.sin(a) * 30, 2); }
  s += `<path d="${holes}" fill="${C.ink}"/>`;
  s += `<path d="${circleD(c - 10, c - 10, 8)}" fill="${light(metal, 0.4)}" opacity="0.6"/>`;
  s += `<path d="M${c + 20} ${c + 26}l40 52l26 -6" stroke="${metal}" stroke-width="5" fill="none" stroke-linecap="round"/>`;
  return item(d, d, s);
}

function canister({ w = 150, h = 210, color = C.ember } = {}) {
  let s = `<path d="M0 74C0 44 ${f(w * 0.22)} 32 ${f(w * 0.34)} 30H${f(w * 0.66)}C${f(w * 0.78)} 32 ${w} 44 ${w} 74Z" fill="${light(color, 0.1)}"/>`;
  s += `<path d="${rrD(0, 64, w, h - 64, [0, 0, 18, 18])}" fill="${color}"/>`;
  s += rr(w * 0.36, 4, w * 0.28, 30, 4, mix('fog', 'stone', 0.3));
  s += `<path d="M${f(w * 0.38)} 12h${f(w * 0.24)}M${f(w * 0.38)} 20h${f(w * 0.24)}" stroke="${C.stone}" stroke-width="2"/>`;
  s += `<rect x="0" y="${f(h * 0.5)}" width="${w}" height="${f(h * 0.24)}" fill="${C.bright}"/>`;
  s += `<path d="M${f(w / 2)} ${f(h * 0.54)}c10 12 10 22 0 30c-10 -8 -10 -18 0 -30Z" fill="${color}"/>`;
  s += rr(12, 80, 14, h - 100, 7, light(color, 0.25));
  return item(w, h, s);
}

function spoon({ w = 54, h = 250 } = {}) {
  const metal = mix('fog', 'stone', 0.2);
  let s = `<path d="M${w / 2 - 7} 60L${w / 2 - 5} ${h - 12}Q${w / 2} ${h} ${w / 2 + 5} ${h - 12}L${w / 2 + 7} 60Z" fill="${metal}"/>`;
  s += `<ellipse cx="${w / 2}" cy="36" rx="${w / 2}" ry="36" fill="${metal}"/>`;
  s += `<ellipse cx="${w / 2 + 3}" cy="40" rx="${w / 2 - 8}" ry="28" fill="${shade(metal, 0.1)}"/>`;
  s += `<ellipse cx="${w / 2 - 8}" cy="28" rx="6" ry="14" fill="${C.bright}" opacity="0.7"/>`;
  s += `<path d="${circleD(w / 2, h - 22, 3.5)}" fill="${C.stone}"/>`;
  return item(w, h, s);
}

function matches({ color = C.ochre } = {}) {
  let s = rr(110, 10, 104, 104, 3, mix('paper', 'lichen', 0.35));
  s += rr(116, 16, 92, 92, 2, mix('lichen', 'stone', 0.25));
  for (let k = 0; k < 8; k++) {
    const y = 22 + k * 10.6;
    s += rr(124, y, 70, 5, 2, mix('ochre', 'paper', 0.5)) + rr(190, y - 1.5, 13, 8, 4, C.ember);
  }
  s += rr(0, 0, 150, 124, 4, C.paper);
  s += `<rect x="0" y="0" width="150" height="12" fill="${mix('stone', 'ember', 0.25)}"/><rect x="0" y="112" width="150" height="12" fill="${mix('stone', 'ember', 0.25)}"/>`;
  s += rr(16, 30, 118, 64, 3, color);
  s += `<path d="M75 44c14 14 14 28 0 38c-14 -10 -14 -24 0 -38Z" fill="${C.ember}"/>`;
  return item(214, 124, s);
}

function tapeRoll({ d = 170, color = mix('fog', 'stone', 0.4) } = {}) {
  const c = d / 2;
  let s = `<path d="M${c + 30} 0h52l-6 20h-46Z" fill="${light(color, 0.15)}"/>`;
  s += `<path d="${circleD(c, c, c)}${circleD(c, c, d * 0.24)}" fill="${color}" fill-rule="evenodd"/>`;
  s += `<path d="${circleD(c, c, c * 0.82)}${circleD(c, c, c * 0.66)}" fill="none" stroke="${light(color, 0.2)}" stroke-width="1.4"/>`;
  s += `<path d="${circleD(c, c, d * 0.3)}${circleD(c, c, d * 0.24)}" fill="${mix('ochre', 'paper', 0.45)}" fill-rule="evenodd"/>`;
  s += `<path d="M${f(c - c * 0.7)} ${f(c - c * 0.5)}A${f(c * 0.86)} ${f(c * 0.86)} 0 0 1 ${f(c + c * 0.2)} ${f(c - c * 0.84)}" stroke="${light(color, 0.45)}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
  return item(d + 16, d, s);
}

function cordHank({ w = 110, h = 280, color = C.lake } = {}) {
  let s = `<path d="M${w / 2 - 22} 60C${w / 2 - 40} 10 ${w / 2 + 40} 10 ${w / 2 + 22} 60M${w / 2 - 22} ${h - 60}C${w / 2 - 40} ${h - 10} ${w / 2 + 40} ${h - 10} ${w / 2 + 22} ${h - 60}" stroke="${color}" stroke-width="9" fill="none"/>`;
  s += rr(16, 50, w - 32, h - 100, 26, color);
  let wraps = '';
  for (let y = 96; y < h - 100; y += 12) wraps += `M18 ${y}L${w - 18} ${y + 10}`;
  s += `<path d="${wraps}" stroke="${shade(color, 0.3)}" stroke-width="3"/>`;
  s += `<path d="M30 60V${h - 60}" stroke="${light(color, 0.3)}" stroke-width="3" opacity="0.7"/>`;
  return item(w, h, s);
}

function needleCard({ w = 170, h = 210 } = {}) {
  let s = `<path d="M0 0H${w}V${h * 0.32}l-10 10l10 10V${h}H0V${h * 0.32 + 20}l10 -10l-10 -10Z" fill="${C.bright}"/>`;
  [C.moss, C.lake, C.ember].forEach((c, i) => {
    const y = 92 + i * 38;
    s += `<rect x="0" y="${y}" width="${w}" height="28" fill="${c}"/>`;
    let lines = '';
    for (let k = 3; k < 28; k += 4) lines += `M0 ${y + k}H${w}`;
    s += `<path d="${lines}" stroke="${shade(c, 0.3)}" stroke-width="1"/>`;
  });
  s += `<path d="M18 26h80M18 40h56" stroke="${C.lichen}" stroke-width="5" stroke-linecap="round"/>`;
  const metal = mix('fog', 'stone', 0.45);
  s += `<path d="M24 58L150 52L152 55L26 61Z" fill="${metal}"/><path d="M30 74L156 70L158 73L32 77Z" fill="${metal}"/>`;
  s += `<path d="M140 52.5h6M146 70.5h6" stroke="${C.bright}" stroke-width="1.5"/>`;
  return item(w, h, s);
}

function buckle({ color = C.ink } = {}) {
  let s = `<path d="${rrD(8, 0, 84, 64, [16, 16, 4, 4])}${rrD(22, 12, 56, 14, [3, 3, 3, 3])}" fill="${color}" fill-rule="evenodd"/>`;
  s += `<path d="${rrD(0, 60, 100, 70, [6, 6, 6, 6])}${rrD(14, 72, 72, 20, [3, 3, 3, 3])}" fill="${color}" fill-rule="evenodd"/>`;
  s += `<path d="${rrD(12, 126, 76, 44, [2, 2, 12, 12])}${rrD(22, 136, 56, 16, [3, 3, 3, 3])}" fill="${color}" fill-rule="evenodd"/>`;
  s += `<path d="M12 4h70M4 64h90" stroke="${light(color, 0.3)}" stroke-width="2"/>`;
  return item(100, 170, s);
}

function multitool({ w = 74, h = 236 } = {}) {
  const metal = mix('fog', 'stone', 0.35);
  let s = `<path d="M${w / 2 - 12} 0H${w / 2 + 12}L${w - 4} 72H4Z" fill="${shade(metal, 0.1)}"/>`;
  s += `<path d="M${w / 2} 4V72" stroke="${mix('stone', 'ink', 0.3)}" stroke-width="2"/>`;
  s += rr(0, 66, w, h - 66, 14, metal);
  s += `<path d="${circleD(w / 2, 82, 7)}" fill="${mix('stone', 'ink', 0.2)}"/>`;
  s += rr(10, 104, w - 20, 110, 6, C.ink);
  let g = '';
  for (let y = 112; y < 210; y += 9) g += `M16 ${y}H${w - 16}`;
  s += `<path d="${g}" stroke="${mix('stone', 'ink', 0.3)}" stroke-width="2"/>`;
  s += `<path d="M5 74V${h - 12}" stroke="${light(metal, 0.4)}" stroke-width="2"/>`;
  return item(w, h, s);
}

function patches(colors = [C.moss, C.lake, C.ink]) {
  let s = '';
  [92, 76, 64].forEach((sz, i) => {
    const x = [0, 112, 208][i];
    s += rr(x, 0, sz, sz, 10, colors[i]) + rr(x + 7, 7, sz - 14, sz - 14, 6, 'none', ` stroke="${C.bright}" stroke-width="1.6" stroke-dasharray="4 4" opacity="0.75"`);
  });
  return item(272, 92, s);
}

function poleSleeve({ w = 200, h = 28 } = {}) {
  const metal = mix('fog', 'stone', 0.3);
  let s = rr(0, 0, w, h, 5, metal);
  s += rr(0, 3, w, 6, 3, light(metal, 0.5));
  s += `<rect x="0" y="${h - 8}" width="${w}" height="8" fill="${shade(metal, 0.18)}" rx="4"/>`;
  s += `<path d="M10 0v${h}M${w - 10} 0v${h}" stroke="${shade(metal, 0.25)}" stroke-width="2"/>`;
  return item(w, h, s);
}

/** A pressed birch leaf, stem down. */
function leaf({ L = 150, color = mix('ochre', 'ember', 0.25) } = {}) {
  const edgeL = [];
  const edgeR = [];
  for (let k = 0; k <= 24; k++) {
    const t = k / 24;
    const half = L * 0.36 * Math.sin(Math.PI * t ** 0.8) * (1 - 0.25 * t);
    const z = k % 2 ? 2.4 : 0;
    edgeL.push([L * 0.38 - half - z, L * 1.15 - t * L]);
    edgeR.unshift([L * 0.38 + half + z, L * 1.15 - t * L]);
  }
  let s = `<path d="${poly([...edgeL, ...edgeR])}" fill="${color}"/>`;
  s += `<path d="M${f(L * 0.38)} ${f(L * 1.4)}V${f(L * 0.2)}" stroke="${shade(color, 0.3)}" stroke-width="2.4"/>`;
  let v = '';
  for (let k = 1; k < 8; k++) {
    const y = L * 1.1 - k * L * 0.11;
    v += `M${f(L * 0.38)} ${f(y)}l${f(-L * 0.2)} ${f(-L * 0.12)}M${f(L * 0.38)} ${f(y)}l${f(L * 0.2)} ${f(-L * 0.12)}`;
  }
  s += `<path d="${v}" stroke="${light(color, 0.3)}" stroke-width="1.4"/>`;
  return item(L * 0.76, L * 1.4, s);
}

function handLens() {
  let s = rr(52, 112, 26, 118, 10, C.moss);
  s += rr(56, 112, 6, 110, 3, light(C.moss, 0.25));
  s += `<path d="${circleD(65, 62, 62)}${circleD(65, 62, 50)}" fill="${C.ink}" fill-rule="evenodd"/>`;
  s += `<path d="${circleD(65, 62, 50)}" fill="${C.lakeLight}" opacity="0.45"/>`;
  s += `<path d="M30 46A40 40 0 0 1 60 22" stroke="${C.bright}" stroke-width="6" fill="none" stroke-linecap="round" opacity="0.8"/>`;
  return item(130, 230, s);
}

function ruler({ len = 380, h = 42 } = {}) {
  let s = rr(0, 0, len, h, 3, mix('ochre', 'paper', 0.55));
  let t = '';
  let n = '';
  for (let k = 0; k * 6 < len - 20; k++) {
    const x = 10 + k * 6;
    t += `M${x} 0v${k % 10 === 0 ? 16 : k % 5 === 0 ? 11 : 7}`;
    if (k % 10 === 0 && k) n += `<text x="${x}" y="30" font-family="Nimbus Mono PS" font-size="10" fill="${C.ink}" text-anchor="middle">${k / 10}</text>`;
  }
  s += `<path d="${t}" stroke="${C.ink}" stroke-width="1.1"/>${n}`;
  s += `<rect x="0" y="${h - 5}" width="${len}" height="5" fill="${shade(mix('ochre', 'paper', 0.55), 0.12)}"/>`;
  return item(len, h, s);
}

const eraser = () => item(88, 38, rr(0, 0, 88, 38, 6, C.rose) + `<path d="${rrD(34, 0, 54, 38, [0, 6, 6, 0])}" fill="${C.lake}"/>` + rr(4, 4, 26, 5, 2.5, light(C.rose, 0.4)));

/** Handwriting-like scribble along a baseline: loops and ascenders, no letters. */
function scribble(x0, x1, base, r, { size = 1 } = {}) {
  let d = '';
  let x = x0;
  while (x < x1 - 20) {
    const L = Math.min(x1 - x, (18 + r() * 52) * size);
    const humps = Math.max(2, Math.round(L / (7 * size)));
    const form = Array.from({ length: humps + 1 }, () => { const q = r(); return q < 0.14 ? 2.2 : q < 0.22 ? -1.6 : 0.7 + 0.5 * r(); });
    let w = `M${f(x)} ${f(base)}`;
    for (let k = 1; k <= humps * 5; k++) {
      const t = k / (humps * 5);
      const th = t * humps * Math.PI * 2;
      const hf = form[Math.floor(t * humps)];
      const lift = hf > 0 ? (2.2 + 2.4 * (1 - Math.cos(th)) * hf) * size : (2.2 + 2.4 * (1 - Math.cos(th)) * hf) * size;
      const y = base - lift;
      w += `L${f(x + L * t - 2 * size * Math.sin(th) + 0.3 * (base - y))} ${f(y)}`;
    }
    d += w;
    x += L + (7 + r() * 9) * size;
  }
  return d;
}

function openNotebook({ w = 680, h = 440 } = {}) {
  const r = rng(404);
  let s = rr(0, 0, w, h, 12, C.moss);
  const pw = w / 2 - 14;
  s += rr(12, 10, pw, h - 20, 4, C.bright) + rr(w / 2 + 2, 10, pw, h - 20, 4, C.bright);
  for (let k = 0; k < 5; k++) s += `<rect x="${f(w / 2 - 12 - k * 4)}" y="10" width="4" height="${h - 20}" fill="${C.ink}" opacity="${f(0.02 + k * 0.012)}"/><rect x="${f(w / 2 + 2 + k * 4)}" y="10" width="4" height="${h - 20}" fill="${C.ink}" opacity="${f(0.07 - k * 0.012)}"/>`;
  let rules = '';
  for (let y = 46; y < h - 20; y += 24) rules += `M24 ${y}H${w / 2 - 14}M${w / 2 + 14} ${y}H${w - 24}`;
  s += `<path d="${rules}" stroke="${C.lakeLight}" stroke-width="1"/>`;
  s += `<path d="M64 14V${h - 14}" stroke="${C.rose}" stroke-width="1.4"/>`;
  let hand = '';
  for (let y = 46; y < h - 20; y += 24) hand += scribble(74, w / 2 - 22 - (r() < 0.2 ? 90 : 0), y - 3, r);
  for (let y = 46; y < 46 + 24 * 6; y += 24) hand += scribble(w / 2 + 24, w - 30 - (r() < 0.3 ? 80 : 0), y - 3, r);
  s += `<path d="${hand}" stroke="${mix('ink', 'lake', 0.35)}" stroke-width="1.5" fill="none" stroke-linejoin="round"/>`;
  // a small sketch on the right page: a ridge line and a spruce
  const sx = w / 2 + 40;
  const sy = 46 + 24 * 6 + 20;
  let sk = `M${sx} ${sy + 90}`;
  for (let x = 0; x <= 250; x += 10) sk += `L${sx + x} ${f(sy + 90 - 40 * Math.sin(x / 60) - 18 * Math.sin(x / 23))}`;
  s += `<path d="${sk}" stroke="${C.stone}" stroke-width="1.6" fill="none"/>`;
  s += `<path d="${spruce(sx + 200, sy + 110, 80, rng(9), { width: 0.34 }).d}" fill="none" stroke="${C.stone}" stroke-width="1.4" stroke-linejoin="round"/>`;
  s += rr(w * 0.73, h - 6, 9, 40, 1, C.ember);
  return item(w, h + 34, s);
}

/** Lay items out in rows (a nested array is a column stack) with even gutters; returns the placed group. */
function knoll(W, H, rows, { gutter = 46, margin = 84 } = {}) {
  const slot = (s) => (Array.isArray(s)
    ? { w: Math.max(...s.map((i) => i.w)), h: s.reduce((a, i) => a + i.h, 0) + gutter * (s.length - 1), items: s }
    : { w: s.w, h: s.h, items: [s] });
  const R = rows.map((row) => {
    const slots = row.map(slot);
    return { slots, w: slots.reduce((a, s) => a + s.w, 0) + gutter * (slots.length - 1), h: Math.max(...slots.map((s) => s.h)) };
  });
  const totalW = Math.max(...R.map((r) => r.w));
  const totalH = R.reduce((a, r) => a + r.h, 0) + gutter * (R.length - 1);
  const k = Math.min(1.5, (W - 2 * margin) / totalW, (H - 2 * margin) / totalH);
  let y = (H - totalH * k) / 2;
  let out = '';
  for (const row of R) {
    let x = (W - row.w * k) / 2;
    for (const s of row.slots) {
      let yy = y + ((row.h - s.h) * k) / 2;
      for (const it of s.items) {
        const xx = x + ((s.w - it.w) * k) / 2;
        out += `<g transform="translate(${f(xx)} ${f(yy)}) scale(${f3(k)})">${it.svg}</g>`;
        yy += (it.h + gutter) * k;
      }
      x += (s.w + gutter) * k;
    }
    y += (row.h + gutter) * k;
  }
  return out;
}

const SHADOW = `<filter id="sh" filterUnits="userSpaceOnUse" x="0" y="0" width="2400" height="1600" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="9" result="b1"/><feOffset in="b1" dx="10" dy="13" result="o1"/><feFlood flood-color="${C.ink}" flood-opacity="0.3"/><feComposite in2="o1" operator="in" result="s1"/><feGaussianBlur in="SourceAlpha" stdDeviation="2" result="b2"/><feOffset in="b2" dx="2" dy="3" result="o2"/><feFlood flood-color="${C.ink}" flood-opacity="0.25"/><feComposite in2="o2" operator="in" result="s2"/><feMerge><feMergeNode in="s1"/><feMergeNode in="s2"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;

function kitPicture(ground, rows, opts) {
  const W = 1600;
  const H = 1000;
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${hex(ground)}"/><g filter="url(#sh)">${knoll(W, H, rows, opts)}</g>`, SHADOW);
}

const KITS = {
  'kit-day': () => kitPicture('moss', [
    [shell(), notebook(), foldedMap(), bottle(), turn(pencil())],
    [firstAid(), headlamp(), turn(knife()), compass(), whistle()],
  ]),
  'kit-winter': () => kitPicture('lake', [
    [beanie(), gloves(), socks(), mug()],
    [headlamp(), stove(), canister(), thermometer(), matches(), spoon()],
  ]),
  'kit-repair': () => kitPicture('ochre', [
    [tapeRoll(), cordHank(), needleCard(), buckle(), multitool()],
    [poleSleeve(), knife({ handle: C.moss }), patches()],
  ]),
  'kit-notebook': () => kitPicture('paper', [
    [openNotebook(), turn(pencil({ body: C.moss })), turn(pencil({ body: C.ochre })), turn(pencil({ body: C.ink, len: 280 }))],
    [ruler(), eraser(), thermometer({ w: 30, h: 200 }), leaf(), handLens()],
  ]),
};

/* almanac: the year book, closed and open */
function sprig({ L = 320 } = {}) {
  const twig = mix('ochre', 'ink', 0.5);
  const needles = mix('deep', 'moss', 0.3);
  let d = '';
  const branch = (x, y, len, ang, depth) => {
    const ex = x + Math.cos(ang) * len;
    const ey = y + Math.sin(ang) * len;
    let nd = '';
    for (let t = 0.08; t < 1; t += 0.045) {
      const px = x + (ex - x) * t;
      const py = y + (ey - y) * t;
      const nl = 16 * (1 - t * 0.5);
      for (const side of [-1, 1]) {
        const a = ang + side * 0.95;
        nd += `M${f(px)} ${f(py)}l${f(Math.cos(a) * nl)} ${f(Math.sin(a) * nl)}`;
      }
    }
    d += nd;
    let tw = `M${f(x)} ${f(y)}L${f(ex)} ${f(ey)}`;
    if (depth) {
      tw += branch(x + (ex - x) * 0.35, y + (ey - y) * 0.35, len * 0.42, ang - 0.6, depth - 1);
      tw += branch(x + (ex - x) * 0.6, y + (ey - y) * 0.6, len * 0.36, ang + 0.6, depth - 1);
    }
    return tw;
  };
  const tw = branch(60, L, L * 0.95, -Math.PI / 2, 1);
  return item(120, L + 10, `<path d="${d}" stroke="${needles}" stroke-width="2.6" stroke-linecap="round"/><path d="${tw}" stroke="${twig}" stroke-width="4" stroke-linecap="round" fill="none"/>`);
}

function almanacBook({ w = 600, h = 800 } = {}) {
  const cover = C.moss;
  let s = rr(7, 6, w - 7, h - 6, 4, mix('paper', 'fog', 0.4));
  let pages = '';
  for (let i = 1; i < 5; i++) pages += `M${f(w - 7 + i * 1.5)} 14V${h - 8}M14 ${f(h - 6 + i * 1.3)}H${w - 8}`;
  s += `<path d="${pages}" stroke="${C.lichen}" stroke-width="0.8"/>`;
  s += rr(0, 0, w - 6, h - 6, 6, cover);
  s += `<rect x="0" y="0" width="38" height="${h - 6}" fill="${shade(cover, 0.2)}"/>`;
  s += `<path d="M44 0V${h - 6}" stroke="${shade(cover, 0.45)}" stroke-width="3"/><path d="M48 0V${h - 6}" stroke="${light(cover, 0.18)}" stroke-width="1.5"/>`;
  s += `<path d="M2 2H${w - 9}" stroke="${light(cover, 0.22)}" stroke-width="2"/>`;
  const bx = 96;
  const by = 150;
  const bw = w - 6 - bx - 46;
  const bh = 300;
  s += `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="${C.ember}"/>`;
  s += `<path d="M${bx} ${by + bh}V${by}H${bx + bw}" stroke="${shade(C.ember, 0.4)}" stroke-width="5" fill="none"/>`;
  s += `<path d="M${bx + 2} ${by + bh - 1}H${bx + bw - 1}V${by + 2}" stroke="${mix('ember', 'paper', 0.35)}" stroke-width="3" fill="none"/>`;
  const cx = bx + bw / 2;
  s += `<text x="${cx}" y="${by + 106}" font-family="${MAP_FONT}" font-weight="bold" font-size="66" letter-spacing="9" fill="${C.paper}" text-anchor="middle">FIELDNOTES</text>`;
  s += `<text x="${cx}" y="${by + 172}" font-family="${MAP_FONT}" font-weight="bold" font-size="42" letter-spacing="20" fill="${C.paper}" text-anchor="middle">ALMANAC</text>`;
  s += `<path d="M${cx - 60} ${by + 210}H${cx + 60}" stroke="${C.paper}" stroke-width="2"/>`;
  s += `<text x="${cx}" y="${by + 262}" font-family="${MAP_FONT}" font-size="38" letter-spacing="16" fill="${C.paper}" text-anchor="middle">2027</text>`;
  s += `<path d="${spruce(cx, h - 120, 120, rng(12), { width: 0.34 }).d}" fill="${shade(cover, 0.22)}"/>`;
  s += `<path d="M${cx - 70} ${h - 116}H${cx + 70}" stroke="${shade(cover, 0.22)}" stroke-width="3"/>`;
  return item(w, h, s);
}

function almanacCover() {
  const W = 1600;
  const H = 1000;
  const book = almanacBook();
  const pen = turn(pencil({ len: 420, d: 22, body: C.ochre }));
  const sp = sprig();
  const body = `<g transform="translate(470 90)">${book.svg}</g><g transform="translate(1140 160)">${pen.svg}</g><g transform="translate(1230 300)">${sp.svg}</g>`;
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${C.fog}"/><g filter="url(#sh)">${body}</g>`, SHADOW);
}

function almanacSpread() {
  const W = 1600;
  const H = 1000;
  const bw = 1300;
  const bh = 820;
  const x0 = (W - bw) / 2;
  const y0 = (H - bh) / 2;
  const pw = bw / 2 - 16;
  let s = rr(0, 0, bw, bh, 10, C.moss);
  s += rr(14, 12, pw, bh - 24, 4, C.bright) + rr(bw / 2 + 2, 12, pw, bh - 24, 4, C.bright);
  for (let k = 0; k < 6; k++) s += `<rect x="${f(bw / 2 - 14 - k * 5)}" y="12" width="5" height="${bh - 24}" fill="${C.ink}" opacity="${f(0.012 + k * 0.01)}"/><rect x="${f(bw / 2 + 2 + k * 5)}" y="12" width="5" height="${bh - 24}" fill="${C.ink}" opacity="${f(0.06 - k * 0.01)}"/>`;
  // left page: the Birch Hollow sheet, printed small
  const map = routeSheet(SHEETS[0], 1600, 1000, 'am');
  const mx = 60;
  const my = 70;
  const mw = pw - 90;
  const mh = mw * 0.625;
  s += `<text x="${mx}" y="${my - 18}" font-family="${MAP_FONT}" font-weight="bold" font-size="20" letter-spacing="4" fill="${C.ink}">ROUTE 1</text>`;
  s += `<svg x="${mx}" y="${my}" width="${f(mw)}" height="${f(mh)}" viewBox="0 0 1600 1000"><defs>${map.defs}</defs>${map.body}</svg>`;
  const grey = mix('stone', 'bright', 0.55);
  let lines = '';
  const r = rng(2027);
  const para = (x, y, wdt, n) => {
    for (let i = 0; i < n; i++) lines += `M${f(x)} ${f(y + i * 17)}h${f(i === n - 1 ? wdt * (0.3 + 0.5 * r()) : wdt * (0.92 + 0.08 * r()))}`;
    return y + n * 17 + 14;
  };
  let y = my + mh + 40;
  y = para(mx, y, mw, 5);
  para(mx, y, mw, 4);
  // right page: heading, two columns of text, and a strip chart
  const rx = bw / 2 + 50;
  const cw = (pw - 100 - 30) / 2;
  s += `<text x="${rx}" y="${my - 18}" font-family="${MAP_FONT}" font-weight="bold" font-size="20" letter-spacing="4" fill="${C.ink}">OCTOBER</text>`;
  s += `<rect x="${rx}" y="${my}" width="${f(pw - 100)}" height="10" fill="${mix('stone', 'bright', 0.3)}"/>`;
  let yy = my + 36;
  for (let k = 0; k < 3; k++) yy = para(rx, yy, cw, 5 + k);
  yy = my + 36;
  for (let k = 0; k < 3; k++) yy = para(rx + cw + 30, yy, cw, 6 - k);
  const chartTop = Math.max(yy, my + 36 + 17 * 18 + 42) + 6;
  const chartW = pw - 100;
  const chartH = chartW * 0.625;
  const ch = chartSvgBody(CHARTS[2]);
  s += `<svg x="${rx}" y="${f(chartTop)}" width="${f(chartW)}" height="${f(chartH)}" viewBox="0 0 1600 1000">${ch}</svg>`;
  s += `<path d="${lines}" stroke="${grey}" stroke-width="6" stroke-linecap="round"/>`;
  s += `<text x="${bw / 4 + 6}" y="${bh - 30}" font-family="Nimbus Mono PS" font-size="14" fill="${C.stone}" text-anchor="middle">41</text><text x="${(bw * 3) / 4}" y="${bh - 30}" font-family="Nimbus Mono PS" font-size="14" fill="${C.stone}" text-anchor="middle">42</text>`;
  const pen = pencil({ len: 380, d: 20, body: C.ochre });
  return svg(W, H, `<rect width="${W}" height="${H}" fill="${C.fog}"/><g filter="url(#sh)"><g transform="translate(${x0} ${y0})">${s}</g></g><g filter="url(#sh)"><g transform="translate(${x0 + bw - 330} ${y0 + bh + 30})">${pen.svg}</g></g>`, SHADOW);
}

/* ── charts: a week on the barograph, thermograph and rain gauge ──────────
   Hourly series from a few keyframes (monotone cubic, so no overshoot), a
   daily swing peaking mid-afternoon and the twice-daily pressure tide.     */

function pchip(keys) {
  const xs = keys.map((k) => k[0]);
  const ys = keys.map((k) => k[1]);
  const n = keys.length;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const m = [d[0]];
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (x) => {
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const hh = xs[i + 1] - xs[i];
    const t = clamp((x - xs[i]) / hh);
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hh * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hh * m[i + 1];
  };
}

const CHARTS = [
  {
    name: 'chart-wind-change', week: 'WEEK OF 21 SEPTEMBER', dates: [21, 22, 23, 24, 25, 26, 27], tScale: [-5, 20],
    // follows the post's table: rain all Thursday, the low on Friday morning, the wind veering after dark
    pressure: [[0, 1020], [18, 1019], [42, 1016], [66, 1010], [90, 1003], [100, 1001], [114, 1006], [124, 1011], [138, 1018], [162, 1024], [168, 1024.5]],
    mean: [[0, 13.5], [30, 14.3], [54, 14.4], [78, 12], [102, 10.5], [126, 6.5], [150, 5.8], [168, 6]],
    swing: [[0, 5.5], [42, 5.5], [66, 3.5], [84, 1.4], [100, 2], [126, 3.6], [168, 5]],
    rain: [[72, 92, 4]],
    notes: [{ at: 116, text: 'WIND VEERS NW', series: 'p', below: true }],
  },
  {
    name: 'chart-first-snow', week: 'WEEK OF 10 NOVEMBER', dates: [10, 11, 12, 13, 14, 15, 16], tScale: [-15, 10],
    // follows the post's table: snow from Thursday afternoon to before dawn on Friday, then a cold, clear high
    pressure: [[0, 1011], [18, 1012], [42, 1015], [66, 1008], [90, 998], [96, 997.5], [114, 1011], [138, 1026], [162, 1029], [168, 1029.5]],
    mean: [[0, -0.5], [30, -2], [54, -3.3], [78, -3], [102, -5.5], [126, -8], [150, -5], [168, -4.5]],
    swing: [[0, 2.7], [42, 2.9], [66, 2.6], [88, 1.2], [102, 2.5], [126, 4.2], [168, 3.7]],
    rain: [[86, 101, 3.2]], rainLabel: 'SNOW',
    notes: [{ at: 140, text: 'COLD CLEAR HIGH', series: 'p', below: true }],
  },
  {
    // mild and calm, light rain twice, pressure rising to a high; the last night clear and still, so Sunday dawns at about -3
    name: 'chart-october-week', week: 'WEEK OF 28 SEPTEMBER', dates: [28, 29, 30, 1, 2, 3, 4], tScale: [-5, 20],
    pressure: [[0, 1008], [30, 1010], [60, 1012.5], [90, 1015.5], [120, 1020], [140, 1024], [168, 1026]],
    mean: [[0, 9], [48, 9.5], [96, 8.5], [126, 7.5], [140, 5], [150, 3.5], [168, 6]],
    swing: [[0, 5], [24, 4], [48, 3], [72, 4], [96, 3.2], [120, 5], [138, 6], [150, 6.5], [168, 6]],
    rain: [[29, 40, 1.2], [79, 91, 0.9]], rainLabel: 'LIGHT RAIN',
    notes: [{ at: 150, text: 'CLEAR AND STILL: -3 AT DAWN', series: 't', side: 'left' }, { at: 157, text: 'HIGH BUILDING', series: 'p' }],
  },
  {
    // rain from Tuesday night to Friday morning, pressure low and flat, then clearing
    name: 'chart-meadow-rain', week: 'WEEK OF 1 JUNE', dates: [1, 2, 3, 4, 5, 6, 7], tScale: [0, 25],
    pressure: [[0, 1012], [18, 1011], [42, 1004], [66, 1001], [90, 1001], [106, 1004], [114, 1009], [138, 1016], [162, 1019], [168, 1019.5]],
    mean: [[0, 16.3], [30, 15.6], [54, 13], [78, 12.2], [102, 12.7], [126, 14], [150, 16.1], [168, 16.5]],
    swing: [[0, 5], [36, 3.2], [54, 1.2], [90, 1.3], [106, 3.3], [126, 5.8], [168, 6.2]],
    rain: [[46, 72, 4.5], [62, 98, 5.5], [88, 103, 3.5]], rainLabel: 'THREE DAYS OF RAIN',
    notes: [{ at: 110, text: 'CLEARING', series: 'p' }],
  },
];

function chartSvgBody(spec) {
  const W = 1600;
  const L = 150;
  const R = 1450;
  const T = 168;
  const B = 744;
  const PT = 772;
  const PB = 868;
  const seed = hash(spec.name);
  const n1 = fbm1(seed, 2);
  const n2 = fbm1(seed + 3, 2);
  const P = pchip(spec.pressure);
  const M = pchip(spec.mean);
  const S = pchip(spec.swing);
  const press = [];
  const temp = [];
  for (let t = 0; t <= 168; t += 1) {
    press.push(P(t) + 0.45 * Math.cos(((t - 10) / 12) * Math.PI * 2) + (n1(t / 9) - 0.5) * 0.9);
    const ph = (((t - 6) % 24) + 24) % 24;
    const day = ph < 9 ? -Math.cos((Math.PI * ph) / 9) : Math.cos((Math.PI * (ph - 9)) / 15);
    temp.push(M(t) + S(t) * day + (n2(t / 7) - 0.5) * 0.8);
  }
  const X = (t) => L + ((R - L) * t) / 168;
  const YP = (p) => B - ((B - T) * (p - 985)) / 50;
  const [t0, t1] = spec.tScale;
  const YT = (c) => B - ((B - T) * (c - t0)) / (t1 - t0);
  const r = rng(seed + 9);
  const bins = [];
  for (let k = 0; k < 56; k++) {
    const mid = k * 3 + 1.5;
    let v = 0;
    for (const [s0, s1, peak] of spec.rain) if (mid > s0 && mid < s1) v += peak * Math.sin((Math.PI * (mid - s0)) / (s1 - s0)) ** 0.7 * (0.7 + 0.5 * r());
    bins.push(v);
  }
  const YR = (mm) => PB - ((PB - PT) * Math.min(mm, 10)) / 10;
  const mono = 'Nimbus Mono PS';
  let s = `<rect width="${W}" height="1000" fill="${C.bright}"/>`;
  // grid: minor lines, every fifth heavier
  let gMinor = '';
  let gMajor = '';
  for (let k = 0; k <= 35; k++) {
    const x = L + ((R - L) * k) / 35;
    const d = `M${f(x)} ${T}V${B}M${f(x)} ${PT}V${PB}`;
    if (k % 5 === 0) gMajor += d; else gMinor += d;
  }
  for (let k = 0; k <= 25; k++) {
    const y = T + ((B - T) * k) / 25;
    if (k % 5 === 0) gMajor += `M${L} ${f(y)}H${R}`; else gMinor += `M${L} ${f(y)}H${R}`;
  }
  for (let k = 0; k <= 4; k++) { const y = PT + ((PB - PT) * k) / 4; if (k % 2 === 0) gMajor += `M${L} ${f(y)}H${R}`; else gMinor += `M${L} ${f(y)}H${R}`; }
  s += `<path d="${gMinor}" stroke="${C.lakeLight}" stroke-width="1" opacity="0.55"/><path d="${gMajor}" stroke="${C.lakeLight}" stroke-width="1.8"/>`;
  // axes labels
  for (let k = 0; k <= 5; k++) {
    const y = B - ((B - T) * k) / 5;
    s += `<text x="${L - 14}" y="${f(y + 6)}" font-family="${mono}" font-size="17" fill="${C.ink}" text-anchor="end">${985 + k * 10}</text>`;
    s += `<text x="${R + 14}" y="${f(y + 6)}" font-family="${mono}" font-size="17" fill="${C.ember}">${t0 + (k * (t1 - t0)) / 5}</text>`;
  }
  s += `<text x="${L - 14}" y="${T - 20}" font-family="${mono}" font-size="15" fill="${C.ink}" text-anchor="end">hPa</text><text x="${R + 14}" y="${T - 20}" font-family="${mono}" font-size="15" fill="${C.ember}">°C</text>`;
  s += `<text x="${L - 14}" y="${PT + 6}" font-family="${mono}" font-size="14" fill="${C.lake}" text-anchor="end">10</text><text x="${L - 14}" y="${PB + 5}" font-family="${mono}" font-size="14" fill="${C.lake}" text-anchor="end">0</text><text x="${L - 46}" y="${f((PT + PB) / 2 + 5)}" font-family="${mono}" font-size="14" fill="${C.lake}" text-anchor="end">mm</text>`;
  const days = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  days.forEach((dname, i) => { s += `<text x="${f(X(i * 24 + 12))}" y="${PB + 36}" font-family="${mono}" font-size="20" fill="${C.ink}" text-anchor="middle">${dname} ${spec.dates[i]}</text>`; });
  // precipitation bars
  let bars = '';
  bins.forEach((v, k) => { if (v > 0.05) { const x = X(k * 3) + 2; bars += `M${f(x)} ${f(PB)}V${f(YR(v))}H${f(x + ((R - L) * 3) / 168 - 4)}V${f(PB)}Z`; } });
  s += `<path d="${bars}" fill="${C.lake}"/>`;
  // the two traces
  const line = (vals, Y) => vals.map((v, t) => `${t ? 'L' : 'M'}${f(X(t))} ${f(Y(v))}`).join('');
  s += `<path d="${line(temp, YT)}" stroke="${C.ember}" stroke-width="3" fill="none" stroke-linejoin="round"/>`;
  s += `<path d="${line(press, YP)}" stroke="${C.ink}" stroke-width="3" fill="none" stroke-linejoin="round"/>`;
  // notes on the story of the week
  for (const nt of spec.notes ?? []) {
    const x = X(nt.at);
    const onT = nt.series === 't';
    const yv = onT ? YT(temp[Math.round(nt.at)]) : YP(press[Math.round(nt.at)]);
    const ink = onT ? C.ember : C.ink;
    if (nt.side === 'left') {
      s += `<path d="M${f(x - 8)} ${f(yv)}H${f(x - 32)}" stroke="${ink}" stroke-width="1.4"/>`;
      s += haloText(x - 38, yv + 5, nt.text, { family: mono, size: 15, fill: ink, halo: C.bright, haloW: 6, anchor: 'end' });
    } else {
      const y = nt.below ? yv + 40 : yv - 40;
      s += `<path d="M${f(x)} ${f(nt.below ? yv + 8 : yv - 8)}V${f(nt.below ? y - 18 : y + 8)}" stroke="${ink}" stroke-width="1.4"/>`;
      s += haloText(x, nt.below ? y + 2 : y, nt.text, { family: mono, size: 15, fill: ink, halo: C.bright, haloW: 6 });
    }
  }
  if (spec.rainLabel) {
    // one label over each spell of wet weather
    const spells = [];
    bins.forEach((v, k) => {
      if (v <= 0.05) return;
      const last = spells.at(-1);
      if (last && k - last[1] <= 2) last[1] = k; else spells.push([k, k]);
    });
    for (const [a, b] of spells) s += haloText(X(((a + b + 1) / 2) * 3), PT - 10, spec.rainLabel, { family: mono, size: 14, fill: C.lake, halo: C.bright, haloW: 6 });
  }
  // title strip and legend
  s += `<text x="${L}" y="70" font-family="${MAP_FONT}" font-weight="bold" font-size="40" letter-spacing="6" fill="${C.ink}">${spec.week}</text>`;
  s += `<text x="${L}" y="100" font-family="${mono}" font-size="14" letter-spacing="1" fill="${C.stone}">FIELDNOTES WEATHER LOG  ·  BAROGRAPH, THERMOGRAPH, RAIN GAUGE</text>`;
  const lg = [[C.ink, 'PRESSURE hPa', 'line'], [C.ember, 'TEMPERATURE °C', 'line'], [C.lake, 'PRECIPITATION mm', 'bar']];
  let lx = 900;
  for (const [c, label, kind] of lg) {
    s += kind === 'line' ? `<path d="M${lx} 63h34" stroke="${c}" stroke-width="3"/>` : `<rect x="${lx + 10}" y="52" width="14" height="18" fill="${c}"/>`;
    s += `<text x="${lx + 44}" y="69" font-family="${mono}" font-size="15" fill="${C.ink}">${label}</text>`;
    lx += 44 + label.length * 9 + 34;
  }
  s += `<path d="M${L} 122H${R}" stroke="${C.ink}" stroke-width="1.5"/>`;
  return s;
}

const chart = (spec) => svg(1600, 1000, chartSvgBody(spec));

/* ── the list ───────────────────────────────────────────────────────────── */

/** Every picture this site needs: [file name, () => SVG text]. */
export function jobs() {
  const plates = {
    'hero-lakes': heroLakes, 'birch-hollow': birchHollow, 'river-ford': riverFord, 'night-meadow': nightMeadow,
    'kettle-marsh': kettleMarsh, 'first-snow': firstSnow, 'basswood-ridge': basswoodRidge, 'tamarack-ice': tamarackIce,
    'portage-autumn': portageAutumn, 'dusk-paddle': duskPaddle, 'meadow-rain': meadowRain, 'weather-front': weatherFront,
    'lookout-spur': lookoutSpur, 'fog-404': fog404, 'camp-morning': campMorning,
    'gallery-spruce': gallerySpruce, 'gallery-landing': galleryLanding, 'gallery-shore': galleryShore, 'gallery-evening': galleryEvening,
  };
  const out = Object.entries(plates).map(([name, draw]) => [`${name}.jpg`, draw]);
  for (const spec of SHEETS) out.push([`${spec.name}.jpg`, () => { const m = routeSheet(spec); return svg(1600, 1000, m.body, m.defs); }]);
  out.push(['map-region.jpg', regionMap]);
  for (const [name, draw] of Object.entries(KITS)) out.push([`${name}.jpg`, draw]);
  out.push(['almanac-cover.jpg', almanacCover], ['almanac-spread.jpg', almanacSpread]);
  for (const spec of CHARTS) out.push([`${spec.name}.jpg`, () => chart(spec)]);
  return out;
}
