// Draws every picture the demo sites use: made-up products and landscapes,
// written as SVG and rendered to JPEG. Nothing is downloaded or copied: the
// same seed always draws the same picture, so a rebuild gives the same files.
//
// Runs inside a ddev web container (Node, ImageMagick and the URW fonts are
// there): node make-images.mjs northstar|fieldnotes <out-dir>
// Renderer: @resvg/resvg-js, installed next to this file by build.sh.

import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* ── helpers ────────────────────────────────────────────────────────────── */

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash(text) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

const f = (n) => Math.round(n * 10) / 10;

/** A smooth closed silhouette across the picture: a ridge line, filled to the bottom. */
function ridge(w, h, baseY, amp, seed, { steps = 9, jag = 0 } = {}) {
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
function ridgeAt(w, baseY, amp, seed, x, { steps = 9 } = {}) {
  const r = rng(seed);
  const ys = [];
  for (let i = 0; i <= steps; i++) ys.push(baseY - amp * (0.35 + 0.65 * r()));
  const seg = Math.min(steps - 1, Math.floor(x / (w / steps)));
  const t = (x - seg * (w / steps)) / (w / steps);
  const s = t * t * (3 - 2 * t);
  return ys[seg] + (ys[seg + 1] - ys[seg]) * s;
}

function pine(x, baseY, hgt, color, snow = null) {
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

function forest(w, baseY, amp, seed, color, { count = 40, min = 40, max = 110, snow = null, from = 0, to = 1 } = {}) {
  const r = rng(seed * 7 + 3);
  let out = '';
  for (let i = 0; i < count; i++) {
    const x = w * (from + (to - from) * r());
    const y = ridgeAt(w, baseY, amp, seed, x) + 6;
    out += pine(x, y, min + (max - min) * r(), color, snow);
  }
  return out;
}

function birch(x, baseY, hgt, width, r) {
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

function canoe(x, y, s, color) {
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${s})">
    <path d="M-120 -8 Q-60 22 0 22 Q60 22 120 -8 Q60 4 0 4 Q-60 4 -120 -8 Z" fill="${color}"/>
    <path d="M-104 -6 Q0 10 104 -6" stroke="#000" stroke-opacity="0.25" stroke-width="3" fill="none"/>
    <circle cx="-30" cy="-20" r="9" fill="#1b1f24"/><path d="M-38 -10 L-22 -10 L-26 4 L-34 4 Z" fill="#1b1f24"/>
    <path d="M-28 -12 L10 30" stroke="#1b1f24" stroke-width="4" stroke-linecap="round"/>
  </g>`;
}

function tent(x, y, s, color, glow = false) {
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${s})">
    ${glow ? '<ellipse cx="0" cy="-30" rx="140" ry="70" fill="url(#glow)"/>' : ''}
    <path d="M-80 0 L0 -90 L80 0 Z" fill="${color}"/>
    <path d="M0 -90 L80 0 L30 0 Z" fill="#000" opacity="0.18"/>
    <path d="M-16 0 L0 -44 L16 0 Z" fill="${glow ? '#ffd27a' : '#2b2b2b'}"/>
  </g>`;
}

function stars(w, h, seed, count = 160) {
  const r = rng(seed);
  let out = '';
  for (let i = 0; i < count; i++) {
    const big = r() > 0.93;
    out += `<circle cx="${f(r() * w)}" cy="${f(r() * h)}" r="${big ? f(1.6 + r() * 1.4) : f(0.6 + r() * 0.9)}" fill="#fffbe8" opacity="${f(0.45 + r() * 0.55)}"/>`;
  }
  return out;
}

function clouds(w, y, seed, color, opacity = 0.85, count = 4) {
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

function birds(x, y, seed, color = '#2b2b2b', count = 5) {
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

function reeds(w, baseY, seed, color, count = 70) {
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

function svg(w, h, body, defs = '', viewBox = `0 0 ${w} ${h}`) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${viewBox}"><defs>${defs}</defs>${body}</svg>`;
}

const lin = (id, stops, { x2 = 0, y2 = 1 } = {}) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${x2}" y2="${y2}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('')}</linearGradient>`;
const rad = (id, stops, { cx = 0.5, cy = 0.5, r = 0.5 } = {}) =>
  `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}">${stops.map(([o, c, op = 1]) => `<stop offset="${o}" stop-color="${c}" stop-opacity="${op}"/>`).join('')}</radialGradient>`;

/* ── landscapes ─────────────────────────────────────────────────────────── */

const SKIES = {
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
function landscape(w, h, o) {
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

/* ── products ───────────────────────────────────────────────────────────── */

const LOGO = (x, y, s, color) => `<g transform="translate(${x} ${y}) scale(${s})" fill="${color}">
  <path d="M-60 30 L-12 -40 L8 -12 L22 -30 L64 30 Z"/>
  <path d="M0 -78 L6 -64 L20 -60 L6 -56 L0 -42 L-6 -56 L-20 -60 L-6 -64 Z"/>
</g>`;

function mug({ body, dark, inner = '#3b2a1e', speckle = false, label = 'NORTHSTAR' }) {
  const r = rng(hash(body));
  let s = `<path d="M800 520 C935 520 965 610 965 668 C965 770 880 828 790 836" fill="none" stroke="${dark}" stroke-width="58" stroke-linecap="round"/>`;
  s += `<path d="M350 420 L850 420 L830 900 C828 935 800 960 765 960 L435 960 C400 960 372 935 370 900 Z" fill="url(#body)"/>`;
  if (speckle) for (let i = 0; i < 160; i++) s += `<circle cx="${f(380 + r() * 440)}" cy="${f(440 + r() * 500)}" r="${f(1.5 + r() * 3)}" fill="#f6efe1" opacity="${f(0.35 + r() * 0.4)}"/>`;
  s += `<ellipse cx="600" cy="420" rx="252" ry="40" fill="${dark}"/><ellipse cx="600" cy="416" rx="236" ry="30" fill="${inner}"/>`;
  s += `<path d="M412 470 L430 880" stroke="#ffffff" stroke-opacity="0.2" stroke-width="22" stroke-linecap="round"/>`;
  s += `<path d="M352 430 L848 430" stroke="#ffffff" stroke-opacity="0.35" stroke-width="6"/>`;
  s += LOGO(600, 680, 1.25, '#f3efe4');
  s += `<text x="600" y="790" font-family="URW Gothic" font-weight="bold" font-size="40" fill="#f3efe4" text-anchor="middle" letter-spacing="9">${label}</text>`;
  const defs = lin('body', [[0, dark], [0.32, body], [1, dark]], { x2: 1, y2: 0 });
  return { s, defs };
}

function bottle({ body, dark, cap = '#2a2f33' }) {
  let s = `<rect x="505" y="190" width="190" height="90" rx="26" fill="${cap}"/><rect x="530" y="160" width="140" height="50" rx="18" fill="${cap}"/>`;
  s += `<path d="M640 172 Q760 150 760 230 Q760 270 700 268" fill="none" stroke="${cap}" stroke-width="16"/>`;
  s += `<path d="M470 300 Q470 270 520 270 L680 270 Q730 270 730 300 L740 960 Q740 1000 700 1000 L500 1000 Q460 1000 460 960 Z" fill="url(#body)"/>`;
  s += `<rect x="462" y="560" width="276" height="200" fill="#efe7d6"/>`;
  s += LOGO(600, 650, 0.9, dark);
  s += `<text x="600" y="730" font-family="URW Gothic" font-weight="bold" font-size="26" fill="${dark}" text-anchor="middle" letter-spacing="6">TRAIL · 750 ML</text>`;
  s += `<path d="M500 320 L506 960" stroke="#ffffff" stroke-opacity="0.22" stroke-width="18" stroke-linecap="round"/>`;
  return { s, defs: lin('body', [[0, dark], [0.35, body], [1, dark]], { x2: 1, y2: 0 }) };
}

function tote({ canvas, strap, ink }) {
  let s = `<path d="M470 470 C470 250 730 250 730 470" fill="none" stroke="${strap}" stroke-width="34"/>`;
  s += `<path d="M420 470 C420 210 780 210 780 470" fill="none" stroke="${strap}" stroke-width="34" opacity="0.85"/>`;
  s += `<path d="M330 460 L870 460 L900 1000 L300 1000 Z" fill="${canvas}"/>`;
  s += `<path d="M330 460 L870 460 L874 520 L326 520 Z" fill="#000" opacity="0.07"/>`;
  s += `<path d="M345 480 L855 480 M318 980 L882 980" stroke="#000" stroke-opacity="0.22" stroke-width="3" stroke-dasharray="10 8"/>`;
  s += `<circle cx="600" cy="720" r="150" fill="none" stroke="${ink}" stroke-width="10"/>`;
  s += `<path d="M470 790 L560 660 L600 715 L640 670 L730 790 Z" fill="${ink}"/>`;
  s += `<path d="M480 810 Q540 790 600 810 T720 810" stroke="${ink}" stroke-width="8" fill="none"/>`;
  s += `<text x="600" y="930" font-family="URW Gothic" font-weight="bold" font-size="34" fill="${ink}" text-anchor="middle" letter-spacing="10">MARKET</text>`;
  return { s, defs: '' };
}

function pack({ body, dark, accent }) {
  let s = `<path d="M400 330 Q400 280 450 280 L750 280 Q800 280 800 330 L820 960 Q820 1010 770 1010 L430 1010 Q380 1010 380 960 Z" fill="${body}"/>`;
  s += `<rect x="410" y="200" width="380" height="120" rx="40" fill="${dark}"/><rect x="430" y="232" width="340" height="16" rx="8" fill="#000" opacity="0.25"/>`;
  s += `<rect x="560" y="300" width="80" height="210" rx="10" fill="${accent}"/><rect x="566" y="470" width="68" height="48" rx="8" fill="#1d1f22"/>`;
  s += `<path d="M450 620 L750 620 L760 900 Q760 930 730 930 L470 930 Q440 930 440 900 Z" fill="${dark}"/>`;
  s += `<path d="M450 650 L750 650" stroke="#000" stroke-opacity="0.25" stroke-width="4"/>`;
  s += `<path d="M380 520 L320 540 L330 800 L384 800" fill="none" stroke="${dark}" stroke-width="18"/>`;
  s += `<path d="M820 520 L880 540 L870 800 L816 800" fill="none" stroke="${dark}" stroke-width="18"/>`;
  s += LOGO(600, 820, 0.7, accent);
  s += `<path d="M420 340 L410 940" stroke="#ffffff" stroke-opacity="0.15" stroke-width="20" stroke-linecap="round"/>`;
  return { s, defs: '' };
}

function framedPrint({ kind, frame }) {
  const r = rng(hash(kind));
  let s = `<rect x="300" y="190" width="600" height="800" fill="${frame}"/>`;
  s += `<rect x="330" y="220" width="540" height="740" fill="#fbf8f1"/>`;
  if (kind === 'map') {
    s += `<rect x="380" y="270" width="440" height="560" fill="#eef1e8"/>`;
    const lake = 'M470 380 C540 300 700 330 720 420 C745 520 650 540 690 640 C720 720 610 790 540 740 C470 690 520 600 470 560 C420 520 410 440 470 380 Z';
    for (let i = 5; i >= 1; i--) s += `<path d="${lake}" transform="translate(600 560) scale(${1 + i * 0.12}) translate(-600 -560)" fill="none" stroke="#b6c3a9" stroke-width="2"/>`;
    s += `<path d="${lake}" fill="#8db7cc"/><path d="${lake}" transform="translate(600 560) scale(0.7) translate(-600 -560)" fill="#6fa0bb"/><path d="${lake}" transform="translate(600 560) scale(0.4) translate(-600 -560)" fill="#4f86a5"/>`;
    for (let i = 0; i < 9; i++) s += `<circle cx="${f(400 + r() * 400)}" cy="${f(290 + r() * 520)}" r="5" fill="#2f5a46"/>`;
    s += `<text x="600" y="890" font-family="URW Gothic" font-weight="bold" font-size="30" fill="#24363a" text-anchor="middle" letter-spacing="8">SILVERPINE LAKE</text>`;
    s += `<text x="600" y="925" font-family="URW Gothic" font-size="16" fill="#5c6a66" text-anchor="middle" letter-spacing="4">DEPTHS IN FEET · DRAWN BY HAND</text>`;
  } else {
    s += `<rect x="380" y="270" width="440" height="560" fill="#13213f"/>`;
    for (let i = 1; i <= 4; i++) s += `<circle cx="600" cy="540" r="${i * 55}" fill="none" stroke="#3a4c78" stroke-width="1.5"/>`;
    for (let a = 0; a < 12; a++) s += `<path d="M600 540 L${f(600 + Math.cos((a * Math.PI) / 6) * 220)} ${f(540 + Math.sin((a * Math.PI) / 6) * 220)}" stroke="#3a4c78" stroke-width="1"/>`;
    s += stars(440, 560, 99, 120).replace(/cx="([\d.]+)" cy="([\d.]+)"/g, (_, x, y) => `cx="${f(380 + +x)}" cy="${f(270 + +y)}"`);
    const dipper = [[470, 420], [520, 400], [570, 415], [610, 450], [600, 510], [660, 530], [670, 470]];
    s += `<path d="M${dipper.map((p) => p.join(' ')).join(' L')} L610 450" fill="none" stroke="#e6c46b" stroke-width="2"/>`;
    for (const [x, y] of dipper) s += `<circle cx="${x}" cy="${y}" r="6" fill="#fff6d8"/>`;
    s += `<path d="M720 640 L730 610 L740 640 L770 650 L740 660 L730 690 L720 660 L690 650 Z" fill="#fff6d8"/>`;
    s += `<text x="600" y="890" font-family="URW Gothic" font-weight="bold" font-size="30" fill="#13213f" text-anchor="middle" letter-spacing="8">NORTHERN SKY</text>`;
    s += `<text x="600" y="925" font-family="URW Gothic" font-size="16" fill="#5c6a66" text-anchor="middle" letter-spacing="4">AS SEEN AT MIDNIGHT IN AUGUST</text>`;
  }
  return { s, defs: '' };
}

function cap({ crown, brim, patch }) {
  let s = `<path d="M340 720 C330 430 870 430 860 720 Z" fill="url(#body)"/>`;
  s += `<path d="M600 506 L600 712 M480 530 C445 590 430 650 430 716 M720 530 C755 590 770 650 770 716" stroke="#000" stroke-opacity="0.2" stroke-width="5" fill="none"/>`;
  s += `<ellipse cx="600" cy="504" rx="22" ry="10" fill="${brim}"/>`;
  s += `<path d="M330 712 Q600 668 870 712 Q910 770 840 812 Q600 880 360 812 Q290 770 330 712 Z" fill="${brim}"/>`;
  s += `<path d="M352 752 Q600 712 848 752" stroke="#000" stroke-opacity="0.22" stroke-width="5" fill="none" stroke-dasharray="12 9"/>`;
  s += `<path d="M380 812 Q600 862 820 812" stroke="#ffffff" stroke-opacity="0.12" stroke-width="10" fill="none"/>`;
  s += `<rect x="520" y="560" width="160" height="110" rx="14" fill="${patch}"/>`;
  s += LOGO(600, 630, 0.6, crown);
  return { s, defs: lin('body', [[0, crown], [1, brim]], { x2: 1, y2: 1 }) };
}

function beanie({ color, dark, stripe }) {
  const r = rng(hash(color));
  let s = `<circle cx="600" cy="440" r="82" fill="${stripe}"/>`;
  for (let i = 0; i < 90; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 74;
    s += `<circle cx="${f(600 + Math.cos(a) * d)}" cy="${f(440 + Math.sin(a) * d)}" r="${f(5 + r() * 9)}" fill="${r() > 0.5 ? '#ffffff' : '#d9cdb4'}" opacity="0.55"/>`;
  }
  s += `<path d="M360 720 C360 450 840 450 840 720 Z" fill="${color}"/>`;
  for (let x = 400; x <= 800; x += 40) s += `<path d="M${x} 720 C${x} 620 ${600 + (x - 600) * 0.6} 540 ${600 + (x - 600) * 0.25} 520" stroke="#000" stroke-opacity="0.08" stroke-width="4" fill="none"/>`;
  s += `<rect x="340" y="700" width="520" height="190" rx="30" fill="${dark}"/>`;
  s += `<rect x="340" y="760" width="520" height="40" fill="${stripe}"/>`;
  for (let x = 360; x <= 840; x += 20) s += `<path d="M${x} 705 L${x} 885" stroke="#000" stroke-opacity="0.14" stroke-width="3"/>`;
  return { s, defs: '' };
}

function journal({ cover, band }) {
  let s = `<rect x="390" y="230" width="460" height="740" rx="24" fill="#efe6d2"/>`;
  for (let y = 250; y < 960; y += 12) s += `<path d="M846 ${y} L860 ${y}" stroke="#cbbf9f" stroke-width="2"/>`;
  s += `<rect x="350" y="210" width="480" height="760" rx="26" fill="${cover}"/>`;
  s += `<rect x="350" y="210" width="40" height="760" rx="14" fill="#000" opacity="0.15"/>`;
  s += `<rect x="740" y="210" width="26" height="760" fill="${band}"/>`;
  s += `<rect x="440" y="420" width="240" height="140" rx="8" fill="none" stroke="#efe6d2" stroke-width="4" opacity="0.8"/>`;
  s += `<text x="560" y="480" font-family="URW Gothic" font-weight="bold" font-size="30" fill="#efe6d2" text-anchor="middle" letter-spacing="6">FIELD</text>`;
  s += `<text x="560" y="525" font-family="URW Gothic" font-weight="bold" font-size="30" fill="#efe6d2" text-anchor="middle" letter-spacing="6">JOURNAL</text>`;
  s += LOGO(560, 800, 0.8, '#efe6d2');
  s += `<path d="M700 970 L700 1080 L720 1060 L740 1080 L740 970" fill="#c4512d"/>`;
  return { s, defs: '' };
}

function lantern({ body, glow }) {
  let s = '';
  s += `<path d="M480 280 C480 150 720 150 720 280" fill="none" stroke="#2a2a2a" stroke-width="14"/>`;
  s += `<rect x="470" y="270" width="260" height="90" rx="20" fill="${body}"/><rect x="520" y="250" width="160" height="40" rx="14" fill="${body}"/>`;
  s += `<path d="M490 360 L710 360 L740 760 L460 760 Z" fill="${glow}" opacity="0.85"/>`;
  s += `<path d="M520 360 L500 760 M680 360 L700 760" stroke="${body}" stroke-width="12"/>`;
  s += `<ellipse cx="600" cy="560" rx="60" ry="110" fill="#fff4cf"/>`;
  s += `<rect x="430" y="750" width="340" height="140" rx="26" fill="${body}"/><rect x="430" y="800" width="340" height="16" fill="#000" opacity="0.2"/>`;
  return { s, defs: '' };
}

function blanket({ base, stripes }) {
  let s = '';
  const layers = [[300, 760, 600, 180], [320, 590, 560, 170], [340, 430, 520, 160]];
  layers.forEach(([x, y, w, h], i) => {
    s += `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="40" fill="${base}"/>`;
    stripes.forEach((c, j) => { s += `<rect x="${x + 40 + j * 46}" y="${y}" width="22" height="${h}" fill="${c}"/>`; });
    s += `<rect x="${x}" y="${y + h - 30}" width="${w}" height="30" rx="14" fill="#000" opacity="${0.08 + i * 0.02}"/>`;
  });
  for (let x = 330; x < 880; x += 14) s += `<path d="M${x} 940 L${x - 4} 980" stroke="${base}" stroke-width="5" stroke-linecap="round"/>`;
  return { s, defs: '' };
}

const DRAW = { mug, bottle, tote, pack, framedPrint, cap, beanie, journal, lantern, blanket };

/**
 * A product picture, as a shop photographs its range: the same warm seamless
 * backdrop and light for every product, the object centred in the same box
 * (so each has the same margin around it), and only a faint contact shadow.
 * 'detail' is a closer crop of the same picture.
 */
function product(spec, shot) {
  const { s, defs } = DRAW[spec.draw](spec.with);
  const W = 1200;
  const [x0, y0, x1, y1] = spec.box;
  const scale = Math.min(800 / (x1 - x0), 720 / (y1 - y0));
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const floor = 590 + (y1 - cy) * scale;
  let d = defs;
  d += rad('studio', [[0, '#fbf9f4'], [0.7, '#f3eee5'], [1, '#ebe3d6']], { cx: 0.5, cy: 0.38, r: 0.85 });
  d += rad('contact', [[0, '#3b3024', 0.16], [0.6, '#3b3024', 0.05], [1, '#3b3024', 0]]);
  let bg = `<rect width="${W}" height="${W}" fill="url(#studio)"/>`;
  bg += `<ellipse cx="600" cy="${f(floor + 4)}" rx="${f((x1 - x0) * scale * 0.62)}" ry="${f(22 + (x1 - x0) * scale * 0.02)}" fill="url(#contact)"/>`;
  const body = `<g transform="translate(600 590) scale(${f(scale * 1000) / 1000}) translate(${f(-cx)} ${f(-cy)})">${s}</g>`;
  let view = `0 0 ${W} ${W}`;
  if (shot === 'detail') {
    // A close-up at twice the size, centred on the part worth a closer look.
    const [px, py] = spec.focus;
    const size = 600;
    const clamp = (v) => Math.max(0, Math.min(W - size, v));
    view = `${f(clamp(600 + (px - cx) * scale - size / 2))} ${f(clamp(590 + (py - cy) * scale - size / 2))} ${size} ${size}`;
  }
  return svg(W, W, bg + body, d, view);
}

/* ── flat-lays and desks (top-down pictures) ────────────────────────────── */

function topoMap(w, h, name) {
  const r = rng(hash(name));
  let b = `<rect width="${w}" height="${h}" fill="#f1ede1"/>`;
  for (let k = 0; k < 4; k++) {
    const cx = r() * w;
    const cy = r() * h;
    for (let i = 1; i < 14; i++) {
      const rx = i * (22 + r() * 6);
      const ry = rx * (0.55 + r() * 0.3);
      b += `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="none" stroke="${i % 5 === 0 ? '#9a7b55' : '#c8b28c'}" stroke-width="${i % 5 === 0 ? 2.6 : 1.4}" transform="rotate(${f(r() * 40 - 20)} ${f(cx)} ${f(cy)})"/>`;
    }
  }
  b += `<path d="M${w * 0.1} ${h * 0.7} C${w * 0.3} ${h * 0.5} ${w * 0.45} ${h * 0.9} ${w * 0.62} ${h * 0.62} S${w * 0.85} ${h * 0.3} ${w * 0.95} ${h * 0.4}" stroke="#6fa0bb" stroke-width="10" fill="none" stroke-linecap="round"/>`;
  b += `<path d="M${w * 0.55} ${h * 0.2} C${w * 0.7} ${h * 0.1} ${w * 0.82} ${h * 0.25} ${w * 0.76} ${h * 0.38} C${w * 0.7} ${h * 0.5} ${w * 0.52} ${h * 0.4} ${w * 0.55} ${h * 0.2} Z" fill="#8db7cc"/>`;
  b += `<path d="M${w * 0.15} ${h * 0.25} L${w * 0.35} ${h * 0.35} L${w * 0.42} ${h * 0.6} L${w * 0.6} ${h * 0.7}" stroke="#c4512d" stroke-width="5" stroke-dasharray="14 10" fill="none"/>`;
  b += `<g transform="translate(${w * 0.86} ${h * 0.8})"><circle r="46" fill="none" stroke="#24363a" stroke-width="3"/><path d="M0 -40 L10 0 L0 40 L-10 0 Z" fill="#24363a"/><text y="-54" font-family="URW Gothic" font-weight="bold" font-size="22" fill="#24363a" text-anchor="middle">N</text></g>`;
  return b;
}

function flatlay(w, h, name) {
  let b = `<rect width="${w}" height="${h}" fill="#b89b77"/>`;
  for (let y = 0; y < h; y += 34) b += `<rect y="${y}" width="${w}" height="2" fill="#000" opacity="0.06"/>`;
  b += `<g transform="rotate(-6 ${w * 0.3} ${h * 0.45})"><rect x="${w * 0.1}" y="${h * 0.14}" width="${w * 0.38}" height="${h * 0.62}" fill="#f1ede1"/>${topoMap(w * 0.38, h * 0.62, name).replace('<rect', `<rect x="${w * 0.1}" y="${h * 0.14}"`).replace(/<(ellipse|path|g) /g, (m) => m)}</g>`;
  b += `<g transform="translate(${w * 0.62} ${h * 0.3}) rotate(8)"><rect x="-120" y="-150" width="240" height="320" rx="14" fill="#2f5a46"/><rect x="90" y="-150" width="16" height="320" fill="#c4512d"/><text x="-10" y="-40" font-family="URW Gothic" font-weight="bold" font-size="24" fill="#efe6d2" text-anchor="middle" letter-spacing="4">NOTES</text></g>`;
  b += `<g transform="translate(${w * 0.82} ${h * 0.68})"><circle r="92" fill="#d8d2c4"/><circle r="78" fill="#f7f3ea"/><path d="M0 -64 L12 0 L0 64 L-12 0 Z" fill="#c4512d"/><path d="M0 0 L12 0 L0 64 L-12 0 Z" fill="#2b2b2b"/><circle r="6" fill="#2b2b2b"/></g>`;
  b += `<g transform="translate(${w * 0.6} ${h * 0.78}) rotate(-70)"><rect x="-150" y="-40" width="300" height="80" rx="38" fill="#2a2f33"/><rect x="-110" y="-40" width="160" height="80" fill="#3d6a52"/></g>`;
  b += `<g transform="translate(${w * 0.44} ${h * 0.86}) rotate(20)"><rect x="-100" y="-7" width="200" height="14" rx="4" fill="#e3b341"/><path d="M100 -7 L126 0 L100 7 Z" fill="#e8d6b0"/><path d="M118 -2 L126 0 L118 2 Z" fill="#2b2b2b"/></g>`;
  return svg(w, h, b, '');
}

function desk(w, h, name) {
  let b = `<rect width="${w}" height="${h}" fill="#3e4a45"/>`;
  b += `<g transform="rotate(3 ${w / 2} ${h / 2})"><rect x="${w * 0.22}" y="${h * 0.12}" width="${w * 0.48}" height="${h * 0.76}" fill="#fbf8f1"/>`;
  b += `<g transform="translate(${w * 0.22} ${h * 0.12})">${topoMap(w * 0.48, h * 0.76, name).replace(/fill="#f1ede1"/, 'fill="#fbf8f1"')}</g></g>`;
  b += `<g transform="translate(${w * 0.8} ${h * 0.3})"><rect x="-50" y="-70" width="100" height="120" rx="16" fill="#1d2a50" opacity="0.92"/><rect x="-30" y="-100" width="60" height="36" rx="6" fill="#2b2b2b"/></g>`;
  for (let i = 0; i < 3; i++) b += `<g transform="translate(${w * 0.8 + i * 30} ${h * 0.7}) rotate(${80 + i * 6})"><rect x="-160" y="-8" width="300" height="16" rx="4" fill="${['#e3b341', '#2f5a46', '#c4512d'][i]}"/><path d="M140 -8 L172 0 L140 8 Z" fill="#e8d6b0"/></g>`;
  b += `<ellipse cx="${w * 0.1}" cy="${h * 0.75}" rx="90" ry="90" fill="#c9a77d"/><ellipse cx="${w * 0.1}" cy="${h * 0.75}" rx="70" ry="70" fill="#3b2a1e"/>`;
  return svg(w, h, b, '');
}

/* ── what each site gets ────────────────────────────────────────────────── */

const PRODUCTS = [
  { slug: 'lakeside-enamel-mug', draw: 'mug', with: { body: '#2f6b5a', dark: '#173a31' }, box: [350, 380, 995, 960], focus: [600, 700] },
  { slug: 'ember-camp-mug', draw: 'mug', with: { body: '#d9772b', dark: '#9a4718', speckle: true }, box: [350, 380, 995, 960], focus: [600, 700] },
  { slug: 'trail-bottle', draw: 'bottle', with: { body: '#2b5f7a', dark: '#163747' }, box: [460, 150, 768, 1000], focus: [600, 640] },
  { slug: 'canvas-market-tote', draw: 'tote', with: { canvas: '#eadfc8', strap: '#8a6a45', ink: '#2f5a46' }, box: [300, 225, 900, 1000], focus: [600, 720] },
  { slug: 'rolltop-day-pack', draw: 'pack', with: { body: '#c4512d', dark: '#8e3519', accent: '#f0c75e' }, box: [312, 200, 888, 1010], focus: [600, 440] },
  { slug: 'silverpine-lake-map', draw: 'framedPrint', with: { kind: 'map', frame: '#7a5a3a' }, box: [300, 190, 900, 990], focus: [600, 540] },
  { slug: 'northern-sky-star-chart', draw: 'framedPrint', with: { kind: 'sky', frame: '#1f2421' }, box: [300, 190, 900, 990], focus: [600, 520] },
  { slug: 'waxed-field-cap', draw: 'cap', with: { crown: '#6b5a3a', brim: '#4a3e28', patch: '#efe6d2' }, box: [290, 450, 910, 850], focus: [600, 640] },
  { slug: 'ridge-wool-beanie', draw: 'beanie', with: { color: '#a8452b', dark: '#7d2f1c', stripe: '#efe6d2' }, box: [340, 358, 860, 890], focus: [600, 700] },
  { slug: 'field-journal', draw: 'journal', with: { cover: '#2f5a46', band: '#1c3a2d' }, box: [350, 210, 862, 1080], focus: [560, 520] },
  { slug: 'harbor-camp-lantern', draw: 'lantern', with: { body: '#2b5f7a', glow: '#ffd98a' }, box: [430, 180, 770, 890], focus: [600, 520] },
  { slug: 'lakehouse-wool-blanket', draw: 'blanket', with: { base: '#efe6d2', stripes: ['#c4512d', '#e3b341', '#2f5a46'] }, box: [296, 430, 904, 985], focus: [470, 640] },
];

const NORTHSTAR_SCENES = [
  { name: 'hero-lake', w: 2000, h: 1050, o: { sky: 'dawn', water: true, horizon: 0.55, canoe: [0.62, 0.8, 1.6], birds: [0.3, 0.22], mist: 0.6, sunX: 0.7 } },
  { name: 'journal-cold-morning', w: 1600, h: 900, o: { sky: 'dawn', water: true, horizon: 0.58, mist: 0.8, sunX: 0.3 } },
  { name: 'journal-first-overnight', w: 1600, h: 900, o: { sky: 'dusk', water: true, horizon: 0.56, canoe: [0.4, 0.82, 1.2], tent: [0.82, 0.66, 0.8], sunX: 0.55 } },
  { name: 'journal-shop-autumn', w: 1600, h: 900, o: { sky: 'autumn', horizon: 0.55, trail: true, birds: [0.65, 0.25] } },
];

const FIELDNOTES_SCENES = [
  { name: 'birch-trail', w: 1600, h: 1000, o: { sky: 'day', horizon: 0.5, birches: 26, trail: true, trailColor: '#cdb48a', trees: false } },
  { name: 'weather-front', w: 1600, h: 1000, o: { sky: 'storm', horizon: 0.62, clouds: 7, cloudColor: '#56616a', cloudOpacity: 0.9, rain: 220, treeCount: 8, treeFrom: 0.7, treeTo: 1 } },
  { name: 'river-crossing', w: 1600, h: 1000, o: { sky: 'day', water: true, horizon: 0.5, waterAt: 0.04, clouds: 3, birds: [0.7, 0.2] } },
  { name: 'night-sky', w: 1600, h: 1000, o: { sky: 'night', horizon: 0.66, stars: 320, milkyWay: true, tent: [0.3, 0.9, 1], tentColor: '#c4512d', sunX: 0.85, sunR: 0.035 } },
  { name: 'marsh-fog', w: 1600, h: 1000, o: { sky: 'dawn', water: true, horizon: 0.55, mist: 0.9, reeds: 120, birds: [0.25, 0.3] } },
  { name: 'first-snow', w: 1600, h: 1000, o: { sky: 'winter', horizon: 0.55, snow: true, snowcaps: true, snowfall: 240, treeCount: 30 } },
  { name: 'ridge-sunrise', w: 1600, h: 1000, o: { sky: 'dawn', horizon: 0.6, sunY: 0.7, sunR: 0.1, clouds: 2, cloudColor: '#ffe4cf', trees: true } },
  { name: 'lake-ice', w: 1600, h: 1000, o: { sky: 'winter', water: true, ice: true, horizon: 0.5, snow: true, palette: { water: ['#dfe9f0', '#f4f8fb'] } } },
  { name: 'autumn-trail', w: 1600, h: 1000, o: { sky: 'autumn', horizon: 0.55, trail: true, birds: [0.3, 0.2], clouds: 2 } },
  { name: 'dusk-paddle', w: 1600, h: 1000, o: { sky: 'dusk', water: true, horizon: 0.55, canoe: [0.55, 0.8, 1.3], canoeColor: '#2f3d2a' } },
  { name: 'meadow-rain', w: 1600, h: 1000, o: { sky: 'storm', horizon: 0.6, rain: 160, reeds: 90, reedColor: '#6b7a3a', trees: true, treeCount: 12 } },
  { name: 'header-ridge', w: 2400, h: 700, o: { sky: 'dawn', horizon: 0.62, sunX: 0.8, sunR: 0.07, birds: [0.25, 0.3], mist: 0.5 } },
];

/* ── render ─────────────────────────────────────────────────────────────── */

function render(svgText, file, quality = 84) {
  const png = new Resvg(svgText, { font: { loadSystemFonts: true, defaultFontFamily: 'URW Gothic' } }).render().asPng();
  const tmp = `${file}.png`;
  writeFileSync(tmp, png);
  execFileSync('magick', [tmp, '-strip', '-interlace', 'Plane', '-quality', String(quality), file]);
  unlinkSync(tmp);
}

const [set, out] = process.argv.slice(2);
if (!['northstar', 'fieldnotes'].includes(set) || !out) {
  console.error('usage: node make-images.mjs northstar|fieldnotes <out-dir>');
  process.exit(64);
}
mkdirSync(out, { recursive: true });
const jobs = [];
if (set === 'northstar') {
  for (const p of PRODUCTS) {
    jobs.push([`${p.slug}-1.jpg`, () => product(p, 'studio')]);
    jobs.push([`${p.slug}-2.jpg`, () => product(p, 'detail')]);
  }
  for (const s of NORTHSTAR_SCENES) jobs.push([`${s.name}.jpg`, () => landscape(s.w, s.h, { name: s.name, ...s.o })]);
  jobs.push(['journal-reading-maps.jpg', () => svg(1600, 900, topoMap(1600, 900, 'reading-maps'))]);
  jobs.push(['journal-behind-the-print.jpg', () => desk(1600, 900, 'behind-the-print')]);
} else {
  for (const s of FIELDNOTES_SCENES) jobs.push([`${s.name}.jpg`, () => landscape(s.w, s.h, { name: s.name, ...s.o })]);
  jobs.push(['gear-flatlay.jpg', () => flatlay(1600, 1000, 'gear-flatlay')]);
  jobs.push(['trail-map.jpg', () => svg(1600, 1000, topoMap(1600, 1000, 'trail-map'))]);
}
let made = 0;
for (const [name, draw] of jobs) {
  const file = join(out, name);
  if (existsSync(file) && !process.env.REDRAW) continue;
  render(draw(), file);
  made++;
}
console.log(`${set}: ${made} drawn, ${jobs.length - made} already there, in ${out}`);
