// Northstar Storefront's pictures: the products, photographed alike, and the
// journal's landscapes.

import { f, hash, landscape, lin, rad, rng, stars, svg, topoMap, desk } from './draw.mjs';

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

export const PRODUCTS = [
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

/** Every picture this site needs: [file name, () => SVG text]. */
export function jobs() {
  const out = [];
  for (const p of PRODUCTS) {
    out.push([`${p.slug}-1.jpg`, () => product(p, 'studio')]);
    out.push([`${p.slug}-2.jpg`, () => product(p, 'detail')]);
  }
  for (const s of NORTHSTAR_SCENES) out.push([`${s.name}.jpg`, () => landscape(s.w, s.h, { name: s.name, ...s.o })]);
  out.push(['journal-reading-maps.jpg', () => svg(1600, 900, topoMap(1600, 900, 'reading-maps'))]);
  out.push(['journal-behind-the-print.jpg', () => desk(1600, 900, 'behind-the-print')]);
  return out;
}
