// Shared drawing for the demo sites' pictures: a seeded random source,
// landscapes (sky, ridges, water, trees, weather) and top-down maps. Each
// site's own file (northstar.mjs, fieldnotes.mjs) composes these into the
// pictures it needs. Pure: returns SVG text, touches nothing.

/* ── helpers ────────────────────────────────────────────────────────────── */

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export const f = (n) => Math.round(n * 10) / 10;

/** A smooth closed silhouette across the picture: a ridge line, filled to the bottom. */
export function ridge(w, h, baseY, amp, seed, { steps = 9, jag = 0 } = {}) {
  const r = rng(seed);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const x = (w / steps) * i;
    const y = baseY - amp * (0.35 + 0.65 * r()) + (jag ? (r() - 0.5) * jag : 0);
    pts.push([x, y]);
  }
  let d = `M0 ${h} L0 ${f(pts[0][1])}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const mx = (x0 + x1) / 2;
    d += ` C${f(mx)} ${f(y0)} ${f(mx)} ${f(y1)} ${f(x1)} ${f(y1)}`;
  }
  return `${d} L${w} ${h} Z`;
}

/** The height of a ridge at x, sampled the same way ridge() draws it (near enough to stand trees on). */
export function ridgeAt(w, baseY, amp, seed, x, { steps = 9 } = {}) {
  const r = rng(seed);
  const ys = [];
  for (let i = 0; i <= steps; i++) ys.push(baseY - amp * (0.35 + 0.65 * r()));
  const seg = Math.min(steps - 1, Math.floor(x / (w / steps)));
  const t = (x - seg * (w / steps)) / (w / steps);
  const s = t * t * (3 - 2 * t);
  return ys[seg] + (ys[seg + 1] - ys[seg]) * s;
}

export function pine(x, baseY, hgt, color, snow = null) {
  const w = hgt * 0.34;
  const tiers = 5;
  let d = `M${f(x)} ${f(baseY - hgt)}`;
  const left = [];
  const right = [];
  for (let i = 1; i <= tiers; i++) {
    const y = baseY - hgt + (hgt * 0.86 * i) / tiers;
    const ww = (w * i) / tiers;
    left.push([x - ww, y], [x - ww * 0.45, y - hgt * 0.035]);
    right.push([x + ww * 0.45, y - hgt * 0.035], [x + ww, y]);
  }
  for (const [px, py] of right) d += ` L${f(px)} ${f(py)}`;
  d += ` L${f(x + w * 0.08)} ${f(baseY - hgt * 0.14)} L${f(x + w * 0.08)} ${f(baseY)} L${f(x - w * 0.08)} ${f(baseY)} L${f(x - w * 0.08)} ${f(baseY - hgt * 0.14)}`;
  for (const [px, py] of left.reverse()) d += ` L${f(px)} ${f(py)}`;
  let out = `<path d="${d} Z" fill="${color}"/>`;
  if (snow) {
    for (let i = 1; i <= tiers; i++) {
      const y = baseY - hgt + (hgt * 0.86 * i) / tiers;
      const ww = (w * i) / tiers;
      out += `<path d="M${f(x - ww * 0.9)} ${f(y - 2)} Q${f(x)} ${f(y - hgt * 0.07)} ${f(x + ww * 0.9)} ${f(y - 2)}" stroke="${snow}" stroke-width="${f(hgt * 0.025)}" fill="none" stroke-linecap="round"/>`;
    }
  }
  return out;
}

export function forest(w, baseY, amp, seed, color, { count = 40, min = 40, max = 110, snow = null, from = 0, to = 1 } = {}) {
  const r = rng(seed * 7 + 3);
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = w * (from + (to - from) * r());
    const y = ridgeAt(w, baseY, amp, seed, x) + 6;
    out += pine(x, y, min + (max - min) * r(), color, snow);
  }
  return out;
}

export function birch(x, baseY, hgt, width, r) {
  let out = `<rect x="${f(x - width / 2)}" y="${f(baseY - hgt)}" width="${f(width)}" height="${f(hgt)}" fill="#f4f1ea"/>`;
  out += `<rect x="${f(x + width * 0.15)}" y="${f(baseY - hgt)}" width="${f(width * 0.35)}" height="${f(hgt)}" fill="#d9d4c7" opacity="0.6"/>`;
  const marks = Math.floor(hgt / 40);
  for (let i = 0; i < marks; i++) {
    const y = baseY - hgt + r() * hgt;
    const mw = width * (0.3 + r() * 0.6);
    out += `<rect x="${f(x - width / 2 + (r() > 0.5 ? 0 : width - mw))}" y="${f(y)}" width="${f(mw)}" height="${f(2 + r() * 5)}" rx="2" fill="#2c2a26"/>`;
  }
  return out;
}

export function canoe(x, y, s, color) {
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${s})">
    <path d="M-120 -8 Q-60 22 0 22 Q60 22 120 -8 Q60 4 0 4 Q-60 4 -120 -8 Z" fill="${color}"/>
    <path d="M-104 -6 Q0 10 104 -6" stroke="#000" stroke-opacity="0.25" stroke-width="3" fill="none"/>
    <circle cx="-30" cy="-20" r="9" fill="#1b1f24"/><path d="M-38 -10 L-22 -10 L-26 4 L-34 4 Z" fill="#1b1f24"/>
    <path d="M-28 -12 L10 30" stroke="#1b1f24" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

export function tent(x, y, s, color, glow = false) {
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${s})">
    ${glow ? '<ellipse cx="0" cy="-30" rx="140" ry="70" fill="url(#glow)"/>' : ''}
    <path d="M-80 0 L0 -90 L80 0 Z" fill="${color}"/>
    <path d="M0 -90 L80 0 L30 0 Z" fill="#000" opacity="0.18"/>
    <path d="M-16 0 L0 -44 L16 0 Z" fill="${glow ? '#ffd27a' : '#2b2b2b'}"/>
  </g>`;
}

export function stars(w, h, seed, count = 160) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const big = r() > 0.93;
    out += `<circle cx="${f(r() * w)}" cy="${f(r() * h)}" r="${big ? f(1.6 + r() * 1.4) : f(0.6 + r() * 0.9)}" fill="#fffbe8" opacity="${f(0.45 + r() * 0.55)}"/>`;
  }
  return out;
}

export function clouds(w, y, seed, color, opacity = 0.85, count = 4) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const cx = r() * w;
    const cy = y + (r() - 0.5) * 80;
    const s = 0.7 + r() * 0.9;
    out += `<g opacity="${opacity}" fill="${color}"><ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(120 * s)}" ry="${f(26 * s)}"/><ellipse cx="${f(cx - 40 * s)}" cy="${f(cy - 18 * s)}" rx="${f(52 * s)}" ry="${f(30 * s)}"/><ellipse cx="${f(cx + 30 * s)}" cy="${f(cy - 26 * s)}" rx="${f(62 * s)}" ry="${f(38 * s)}"/></g>`;
  }
  return out;
}

export function birds(x, y, seed, color = '#2b2b2b', count = 5) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const bx = x + (r() - 0.5) * 220;
    const by = y + (r() - 0.5) * 90;
    const s = 6 + r() * 8;
    out += `<path d="M${f(bx - s)} ${f(by)} Q${f(bx - s / 2)} ${f(by - s / 2)} ${f(bx)} ${f(by)} Q${f(bx + s / 2)} ${f(by - s / 2)} ${f(bx + s)} ${f(by)}" stroke="${color}" stroke-width="2.4" fill="none" stroke-linecap="round"/>`;
  }
  return out;
}

export function reeds(w, baseY, seed, color, count = 70) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = r() * w;
    const hgt = 60 + r() * 140;
    const lean = (r() - 0.5) * 60;
    out += `<path d="M${f(x)} ${f(baseY)} Q${f(x + lean * 0.3)} ${f(baseY - hgt * 0.6)} ${f(x + lean)} ${f(baseY - hgt)}" stroke="${color}" stroke-width="${f(2 + r() * 3)}" fill="none" stroke-linecap="round"/>`;
    if (r() > 0.7) out += `<ellipse cx="${f(x + lean)}" cy="${f(baseY - hgt + 14)}" rx="5" ry="16" fill="#5a3b22" transform="rotate(${f(lean / 3)} ${f(x + lean)} ${f(baseY - hgt + 14)})"/>`;
  }
  return out;
}

export function svg(w, h, body, defs = '', viewBox = `0 0 ${w} ${h}`) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}"><defs>${defs}</defs>${body}</svg>`;
}

export const lin = (id, stops, { x2 = 0, y2 = 1 } = {}) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('')}</linearGradient>`;
export const rad = (id, stops, { cx = 0.5, cy = 0.5, r = 0.5 } = {}) =>
  `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('')}</radialGradient>`;

/* ── landscapes ─────────────────────────────────────────────────────────── */

export const SKIES = {
  dawn: { sky: ['#f6c9a6', '#fde9d3'], sun: '#fff3dc', far: '#cdb7c3', mid: '#9a8ea9', near: '#56607a', water: ['#e8c8c0', '#f6e1d4'], tree: '#3c4660' },
  day: { sky: ['#9ccbe2', '#e6f2f4'], sun: '#fff6d8', far: '#a9c7b6', mid: '#77a08a', near: '#3d6a52', water: ['#6ea7c2', '#a9d0df'], tree: '#24483a' },
  dusk: { sky: ['#33406a', '#f2a86a'], sun: '#ffd593', far: '#7c5f80', mid: '#4b4166', near: '#262742', water: ['#d39272', '#5b4e72'], tree: '#1b1d33' },
  night: { sky: ['#0c1330', '#2a3766'], sun: '#f5f0d8', far: '#1f2a4c', mid: '#161e39', near: '#0c1124', water: ['#1d2a50', '#0e1530'], tree: '#090d1c' },
  storm: { sky: ['#4f5b66', '#b7c0c4'], sun: null, far: '#8d9a95', mid: '#677a70', near: '#3e4d45', water: ['#7e8e95', '#a6b2b5'], tree: '#2d3a33' },
  winter: { sky: ['#c4d7e6', '#f3f7fa'], sun: '#ffffff', far: '#dfe8f0', mid: '#b9cad9', near: '#8aa3b8', water: ['#c9d8e3', '#e9f0f5'], tree: '#2f4a4a' },
  autumn: { sky: ['#e9c79a', '#f8ead2'], sun: '#fff1d0', far: '#d5a77a', mid: '#b5703f', near: '#7a3f22', water: ['#c99a76', '#ead2b6'], tree: '#4b2a1c' },
};

/**
 * A landscape: sky, sun or moon, three ridges, optional water, trees and
 * small things in it. Every option is plain data so each picture reads as a
 * recipe in the lists below.
 */
export function landscape(w, h, o) {
  const p = { ...SKIES[o.sky ?? 'day'], ...(o.palette ?? {}) };
  const seed = hash(o.name);
  const r = rng(seed);
  const horizon = h * (o.horizon ?? 0.6);
  let defs = lin('sky', [[0, p.sky[0]], [1, p.sky[1]]]);
  defs += rad('sunglow', [[0, p.sun ?? '#fff', 0.55], [1, p.sun ?? '#fff', 0]]);
  defs += rad('glow', [[0, '#ffcf73', 0.7], [1, '#ffcf73', 0]]);
  defs += lin('water', [[0, p.water[0]], [1, p.water[1]]]);
  defs += lin('mist', [[0, '#ffffff', 0], [0.5, '#ffffff', o.mist ?? 0], [1, '#ffffff', 0]]);
  defs += lin('shade', [[0, '#000', 0], [1, '#000', 0.22]]);
  let b = `<rect width="${w}" height="${h}" fill="url(#sky)"/>`;
  if (o.stars) b += stars(w, horizon, seed, o.stars);
  if (o.milkyWay) {
    defs += rad('milky', [[0, '#c9d4ff', 0.32], [1, '#c9d4ff', 0]]);
    b += `<ellipse cx="${w * 0.55}" cy="${horizon * 0.45}" rx="${w * 0.6}" ry="${h * 0.12}" fill="url(#milky)" transform="rotate(-24 ${w * 0.55} ${horizon * 0.45})"/>`;
    b += stars(w, horizon * 0.9, seed + 11, 260).replace(/r="[\d.]+"/g, 'r="0.7"');
  }
  if (p.sun && o.sun !== false) {
    const sx = w * (o.sunX ?? 0.72);
    const sy = horizon * (o.sunY ?? 0.42);
    const sr = Math.min(w, h) * (o.sunR ?? 0.08);
    b += `<circle cx="${f(sx)}" cy="${f(sy)}" r="${f(sr * 3.2)}" fill="url(#sunglow)"/><circle cx="${f(sx)}" cy="${f(sy)}" r="${f(sr)}" fill="${p.sun}"/>`;
    if (o.sky === 'night') b += `<circle cx="${f(sx + sr * 0.38)}" cy="${f(sy - sr * 0.2)}" r="${f(sr * 0.92)}" fill="${p.sky[0]}"/>`;
  }
  if (o.clouds) b += clouds(w, horizon * 0.3, seed + 5, o.cloudColor ?? '#ffffff', o.cloudOpacity ?? 0.8, o.clouds);
  b += `<path d="${ridge(w, h, horizon - h * 0.02, h * 0.16, seed + 1, { steps: 7 })}" fill="${p.far}"/>`;
  if (o.snowcaps) b += `<path d="${ridge(w, h, horizon - h * 0.02, h * 0.16, seed + 1, { steps: 7 })}" fill="#ffffff" opacity="0.35"/>`;
  b += `<rect y="${f(horizon - h * 0.12)}" width="${w}" height="${f(h * 0.14)}" fill="url(#mist)"/>`;
  b += `<path d="${ridge(w, h, horizon + h * 0.04, h * 0.12, seed + 2, { steps: 10 })}" fill="${p.mid}"/>`;
  if (o.trees !== false) b += forest(w, horizon + h * 0.04, h * 0.12, seed + 2, p.mid, { count: 50, min: h * 0.03, max: h * 0.07, snow: o.snow ? '#ffffff' : null });
  if (o.water) {
    const wy = horizon + h * (o.waterAt ?? 0.06);
    b += `<rect y="${f(wy)}" width="${w}" height="${f(h - wy)}" fill="url(#water)"/>`;
    for (let i = 0; i < 26; i++) {
      const y = wy + 8 + r() * (h - wy - 10);
      const x = r() * w;
      const len = 30 + r() * 160;
      b += `<rect x="${f(x)}" y="${f(y)}" width="${f(len)}" height="2" rx="1" fill="#ffffff" opacity="${f(0.12 + r() * 0.25)}"/>`;
    }
    if (p.sun && o.sun !== false) b += `<rect x="${f(w * (o.sunX ?? 0.72) - 40)}" y="${f(wy + 4)}" width="80" height="${f((h - wy) * 0.7)}" fill="${p.sun}" opacity="0.18"/>`;
    if (o.ice) {
      for (let i = 0; i < 14; i++) {
        const x = r() * w;
        const y = wy + r() * (h - wy);
        b += `<path d="M${f(x)} ${f(y)} l${f(40 + r() * 120)} ${f((r() - 0.5) * 40)} l${f(30 + r() * 90)} ${f((r() - 0.5) * 50)}" stroke="#ffffff" stroke-width="2" fill="none" opacity="0.7"/>`;
      }
    }
    // the near shore, left and right
    b += `<path d="M0 ${f(wy - 4)} Q${f(w * 0.18)} ${f(wy - 30)} ${f(w * 0.3)} ${f(wy + 18)} L${f(w * 0.3)} ${f(wy + 26)} L0 ${f(wy + 40)} Z" fill="${p.near}"/>`;
    if (o.trees !== false) {
      b += forest(w * 0.3, wy + 10, 0, seed + 9, p.tree, { count: 14, min: h * 0.1, max: h * 0.24, snow: o.snow ? '#ffffff' : null });
    }
  } else {
    b += `<path d="${ridge(w, h, horizon + h * 0.2, h * 0.1, seed + 3, { steps: 6 })}" fill="${p.near}"/>`;
    if (o.trees !== false && !o.birches) b += forest(w, horizon + h * 0.2, h * 0.1, seed + 3, p.tree, { count: o.treeCount ?? 22, min: h * 0.1, max: h * 0.26, snow: o.snow ? '#ffffff' : null, from: o.treeFrom ?? 0, to: o.treeTo ?? 1 });
  }
  if (o.trail) {
    b += `<path d="M${f(w * 0.46)} ${h} C${f(w * 0.5)} ${f(h * 0.85)} ${f(w * 0.56)} ${f(h * 0.8)} ${f(w * 0.52)} ${f(horizon + h * 0.16)} L${f(w * 0.535)} ${f(horizon + h * 0.16)} C${f(w * 0.6)} ${f(h * 0.8)} ${f(w * 0.62)} ${f(h * 0.85)} ${f(w * 0.66)} ${h} Z" fill="${o.trailColor ?? '#d8c19a'}" opacity="0.9"/>`;
  }
  if (o.birches) {
    const rb = rng(seed + 21);
    for (let i = 0; i < o.birches; i++) {
      const x = rb() * w;
      const near = rb();
      if (x > w * 0.42 && x < w * 0.7 && o.trail) continue;
      b += birch(x, h * (0.92 + near * 0.08), h * (0.8 + near * 0.3), 14 + near * 26, rb);
    }
    b += `<rect y="${f(h * 0.9)}" width="${w}" height="${f(h * 0.1)}" fill="${p.near}" opacity="0.65"/>`;
  }
  if (o.reeds) b += reeds(w, h + 4, seed + 31, o.reedColor ?? '#4d5a2e', o.reeds);
  if (o.canoe) b += canoe(w * o.canoe[0], h * o.canoe[1], o.canoe[2] ?? 1, o.canoeColor ?? '#c4512d');
  if (o.tent) b += tent(w * o.tent[0], h * o.tent[1], o.tent[2] ?? 1, o.tentColor ?? '#d9772b', o.sky === 'night' || o.sky === 'dusk');
  if (o.birds) b += birds(w * o.birds[0], h * o.birds[1], seed + 41, o.birdColor ?? '#2f3237');
  if (o.rain) {
    const rr = rng(seed + 51);
    for (let i = 0; i < o.rain; i++) {
      const x = rr() * w * 1.2;
      const y = rr() * h;
      b += `<path d="M${f(x)} ${f(y)} l-18 46" stroke="#ffffff" stroke-width="1.6" opacity="${f(0.2 + rr() * 0.35)}"/>`;
    }
  }
  if (o.snowfall) {
    const rs = rng(seed + 61);
    for (let i = 0; i < o.snowfall; i++) b += `<circle cx="${f(rs() * w)}" cy="${f(rs() * h)}" r="${f(1.5 + rs() * 3)}" fill="#ffffff" opacity="${f(0.5 + rs() * 0.5)}"/>`;
  }
  if (o.mist) b += `<rect y="${f(horizon + h * 0.05)}" width="${w}" height="${f(h * 0.18)}" fill="url(#mist)"/>`;
  b += `<rect width="${w}" height="${h}" fill="url(#shade)" opacity="0.5"/>`;
  return svg(w, h, b, defs);
}

/* ── flat-lays and desks (top-down pictures) ────────────────────────────── */

/** A smooth closed blob: a circle whose radius wanders with a few slow waves. */
export function blob(cx, cy, r, seed, { waves = 4, wobble = 0.22, points = 48, rot = 0 } = {}) {
  const g = rng(seed);
  const terms = Array.from({ length: waves }, (_, k) => [k + 2, (g() - 0.5) * 2 * wobble / (k + 1), g() * Math.PI * 2]);
  const pts = [];
  for (let i = 0; i < points; i++) {
    const t = (i / points) * Math.PI * 2;
    let k = 1;
    for (const [n, amp, ph] of terms) k += amp * Math.sin(n * t + ph);
    pts.push([cx + Math.cos(t + rot) * r * k, cy + Math.sin(t + rot) * r * k * 0.78]);
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < points; i++) {
    const p0 = pts[(i - 1 + points) % points];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % points];
    const p3 = pts[(i + 2) % points];
    d += ` C${f(p1[0] + (p2[0] - p0[0]) / 6)} ${f(p1[1] + (p2[1] - p0[1]) / 6)} ${f(p2[0] - (p3[0] - p1[0]) / 6)} ${f(p2[1] - (p3[1] - p1[1]) / 6)} ${f(p2[0])} ${f(p2[1])}`;
  }
  return `${d} Z`;
}

/**
 * A topographic map, as a printed one looks: nested contour lines around a
 * few hills (every fifth line heavier), a lake with depth bands, a river, a
 * dashed trail and a north arrow.
 */
export function topoMap(w, h, name, { paper = '#f3efe4', line = '#cdb994', index = '#a8885e', water = ['#a9cbdb', '#86b3c9', '#6197b3'] } = {}) {
  const r = rng(hash(name));
  let b = `<rect width="${w}" height="${h}" fill="${paper}"/>`;
  const hills = [[0.22, 0.3], [0.78, 0.72], [0.18, 0.84]].map(([x, y]) => [w * (x + (r() - 0.5) * 0.08), h * (y + (r() - 0.5) * 0.08)]);
  hills.forEach(([cx, cy], i) => {
    const seed = hash(name) + i * 97;
    const rings = 11 + Math.floor(r() * 4);
    for (let k = rings; k >= 1; k--) {
      b += `<path d="${blob(cx, cy, k * Math.min(w, h) * 0.034, seed, { rot: i })}" fill="none" stroke="${k % 5 === 0 ? index : line}" stroke-width="${k % 5 === 0 ? 2.2 : 1.2}"/>`;
    }
  });
  const lx = w * 0.62;
  const ly = h * 0.3;
  const lr = Math.min(w, h) * 0.17;
  const ls = hash(name) + 500;
  b += `<path d="${blob(lx, ly, lr, ls, { wobble: 0.3 })}" fill="${water[0]}"/>`;
  b += `<path d="${blob(lx + lr * 0.06, ly + lr * 0.04, lr * 0.66, ls, { wobble: 0.3 })}" fill="${water[1]}"/>`;
  b += `<path d="${blob(lx + lr * 0.1, ly + lr * 0.08, lr * 0.34, ls, { wobble: 0.3 })}" fill="${water[2]}"/>`;
  b += `<path d="M${f(lx - lr * 0.9)} ${f(ly + lr * 0.5)} C${f(w * 0.45)} ${f(h * 0.62)} ${f(w * 0.32)} ${f(h * 0.5)} ${f(w * 0.1)} ${f(h * 0.66)} S${f(-20)} ${f(h * 0.7)} ${f(-20)} ${f(h * 0.72)}" stroke="${water[1]}" stroke-width="7" fill="none" stroke-linecap="round"/>`;
  b += `<path d="M${f(w * 0.08)} ${f(h * 0.14)} C${f(w * 0.3)} ${f(h * 0.2)} ${f(w * 0.36)} ${f(h * 0.46)} ${f(w * 0.5)} ${f(h * 0.56)} S${f(w * 0.72)} ${f(h * 0.5)} ${f(w * 0.86)} ${f(h * 0.4)}" stroke="#c4512d" stroke-width="4" stroke-dasharray="12 9" fill="none" stroke-linecap="round"/>`;
  b += `<circle cx="${f(w * 0.08)}" cy="${f(h * 0.14)}" r="7" fill="#c4512d"/><circle cx="${f(w * 0.86)}" cy="${f(h * 0.4)}" r="7" fill="#c4512d"/>`;
  b += `<g transform="translate(${f(w * 0.9)} ${f(h * 0.82)})"><circle r="34" fill="${paper}" stroke="#24363a" stroke-width="2"/><path d="M0 -26 L8 0 L0 26 L-8 0 Z" fill="#24363a"/><path d="M0 0 L8 0 L0 26 L-8 0 Z" fill="${paper}" stroke="#24363a" stroke-width="1.5"/><text y="-44" font-family="URW Gothic" font-weight="bold" font-size="20" fill="#24363a" text-anchor="middle">N</text></g>`;
  return b;
}

export function flatlay(w, h, name) {
  let b = `<rect width="${w}" height="${h}" fill="#b89b77"/>`;
  for (let y = 0; y < h; y += 34) b += `<rect y="${y}" width="${w}" height="2" fill="#000" opacity="0.06"/>`;
  // A sheet of map, clipped to its paper, lying at an angle.
  const mw = w * 0.4;
  const mh = h * 0.64;
  b += `<g transform="translate(${f(w * 0.08)} ${f(h * 0.13)}) rotate(-6 ${f(mw / 2)} ${f(mh / 2)})"><rect x="6" y="10" width="${f(mw)}" height="${f(mh)}" fill="#000" opacity="0.12"/><svg width="${f(mw)}" height="${f(mh)}" viewBox="0 0 ${f(mw)} ${f(mh)}">${topoMap(mw, mh, name)}</svg></g>`;
  b += `<g transform="translate(${w * 0.62} ${h * 0.3}) rotate(8)"><rect x="-120" y="-150" width="240" height="320" rx="14" fill="#2f5a46"/><rect x="90" y="-150" width="16" height="320" fill="#c4512d"/><text x="-10" y="-40" font-family="URW Gothic" font-weight="bold" font-size="24" fill="#efe6d2" text-anchor="middle" letter-spacing="4">NOTES</text></g>`;
  b += `<g transform="translate(${w * 0.82} ${h * 0.68})"><circle r="92" fill="#d8d2c4"/><circle r="78" fill="#f7f3ea"/><path d="M0 -64 L12 0 L0 64 L-12 0 Z" fill="#c4512d"/><path d="M0 0 L12 0 L0 64 L-12 0 Z" fill="#2b2b2b"/><circle r="6" fill="#2b2b2b"/></g>`;
  b += `<g transform="translate(${w * 0.6} ${h * 0.78}) rotate(-70)"><rect x="-150" y="-40" width="300" height="80" rx="38" fill="#2a2f33"/><rect x="-110" y="-40" width="160" height="80" fill="#3d6a52"/></g>`;
  b += `<g transform="translate(${w * 0.44} ${h * 0.86}) rotate(20)"><rect x="-100" y="-7" width="200" height="14" rx="4" fill="#e3b341"/><path d="M100 -7 L126 0 L100 7 Z" fill="#e8d6b0"/><path d="M118 -2 L126 0 L118 2 Z" fill="#2b2b2b"/></g>`;
  return svg(w, h, b, '');
}

export function desk(w, h, name) {
  let b = `<rect width="${w}" height="${h}" fill="#3e4a45"/>`;
  const mw = w * 0.48;
  const mh = h * 0.76;
  b += `<g transform="translate(${f(w * 0.22)} ${f(h * 0.12)}) rotate(3 ${f(mw / 2)} ${f(mh / 2)})"><rect x="8" y="12" width="${f(mw)}" height="${f(mh)}" fill="#000" opacity="0.18"/><svg width="${f(mw)}" height="${f(mh)}" viewBox="0 0 ${f(mw)} ${f(mh)}">${topoMap(mw, mh, name, { paper: '#fbf8f1' })}</svg></g>`;
  b += `<g transform="translate(${w * 0.8} ${h * 0.3})"><rect x="-50" y="-70" width="100" height="120" rx="16" fill="#1d2a50" opacity="0.92"/><rect x="-30" y="-100" width="60" height="36" rx="6" fill="#2b2b2b"/></g>`;
  for (let i = 0; i < 3; i++) b += `<g transform="translate(${w * 0.8 + i * 30} ${h * 0.7}) rotate(${80 + i * 6})"><rect x="-160" y="-8" width="300" height="16" rx="4" fill="${['#e3b341', '#2f5a46', '#c4512d'][i]}"/><path d="M140 -8 L172 0 L140 8 Z" fill="#e8d6b0"/></g>`;
  b += `<ellipse cx="${w * 0.1}" cy="${h * 0.75}" rx="90" ry="90" fill="#c9a77d"/><ellipse cx="${w * 0.1}" cy="${h * 0.75}" rx="70" ry="70" fill="#3b2a1e"/>`;
  return svg(w, h, b, '');
}

