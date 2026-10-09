// Everything drawn on top of the footage, rendered as PNGs by Chromium from
// HTML: captions, the speed badge, the title and end cards, the poster. Our
// ffmpeg has no drawtext or subtitles filter; this is better anyway, because
// it is Wanigan's own type (IBM Plex) and colours (tokens.css, dark theme).
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { ROOT } from './env.mjs';

const font = (pkg, file) => pathToFileURL(join(ROOT, 'node_modules', '@fontsource', pkg, 'files', file)).href;

/** Wanigan's dark tokens (src/renderer/src/styles/tokens.css) and its fonts. */
const BASE_CSS = `
@font-face { font-family: 'IBM Plex Sans'; font-weight: 400; src: url('${font('ibm-plex-sans', 'ibm-plex-sans-latin-400-normal.woff2')}'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 500; src: url('${font('ibm-plex-sans', 'ibm-plex-sans-latin-500-normal.woff2')}'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 600; src: url('${font('ibm-plex-sans', 'ibm-plex-sans-latin-600-normal.woff2')}'); }
@font-face { font-family: 'IBM Plex Sans'; font-weight: 700; src: url('${font('ibm-plex-sans', 'ibm-plex-sans-latin-700-normal.woff2')}'); }
@font-face { font-family: 'IBM Plex Sans Condensed'; font-weight: 600; src: url('${font('ibm-plex-sans-condensed', 'ibm-plex-sans-condensed-latin-600-normal.woff2')}'); }
@font-face { font-family: 'IBM Plex Sans Condensed'; font-weight: 700; src: url('${font('ibm-plex-sans-condensed', 'ibm-plex-sans-condensed-latin-700-normal.woff2')}'); }
@font-face { font-family: 'IBM Plex Mono'; font-weight: 500; src: url('${font('ibm-plex-mono', 'ibm-plex-mono-latin-500-normal.woff2')}'); }
:root {
  --bg: #111417; --rail: #0c0f12; --surface: #171b1f; --raised: #1d2227; --line: #252b32; --line-strong: #343c45;
  --fg: #e8e6e1; --muted: #9ba2a8; --faint: #808993; --water: #63b3e4; --water-ink: #06131c; --green: #58c48c;
  --sans: 'IBM Plex Sans', system-ui, sans-serif; --display: 'IBM Plex Sans Condensed', 'IBM Plex Sans', sans-serif; --mono: 'IBM Plex Mono', monospace;
}
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; color: var(--fg); font-family: var(--sans); -webkit-font-smoothing: antialiased; }
`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A caption over 16:9 footage: a dark plate at the bottom (or top), the chapter's tag above the words. */
function caption169({ text, tag, pos = 'bottom' }) {
  return `<style>${BASE_CSS}
  body { width: 1920px; height: 1080px; position: relative; }
  .plate { position: absolute; left: 50%; transform: translateX(-50%); ${pos === 'top' ? 'top: 44px;' : 'bottom: 48px;'}
    max-width: ${pos === 'top' ? 1300 : 1480}px; padding: 20px 34px 24px; border-radius: 18px; background: rgb(12 15 18 / 0.9);
    box-shadow: 0 18px 50px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(255 255 255 / 0.07); text-align: center; }
  .tag { font-family: var(--display); font-weight: 600; font-size: 19px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--water); margin-bottom: 8px; }
  .text { font-weight: 500; font-size: 38px; line-height: 1.28; text-wrap: balance; }
  </style><div class="plate">${tag ? `<div class="tag">${esc(tag)}</div>` : ''}<div class="text">${esc(text)}</div></div>`;
}

/** A caption for the 4:5 cut: the band under the footage. */
function caption45({ text, tag }) {
  return `<style>${BASE_CSS}
  body { width: 1080px; height: 270px; background: var(--rail); position: relative; padding: 30px 56px 0; }
  .tag { font-family: var(--display); font-weight: 600; font-size: 22px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--water); margin-bottom: 10px; }
  .text { font-weight: 500; font-size: 42px; line-height: 1.25; text-wrap: pretty; }
  </style>${tag ? `<div class="tag">${esc(tag)}</div>` : ''}<div class="text">${esc(text)}</div>`;
}

/** The band with no caption, so the 4:5 frame never shows an empty slab. The same in every chapter, so crossfades do not show. */
function band45() {
  return `<style>${BASE_CSS}
  body { width: 1080px; height: 270px; background: var(--rail); position: relative; padding: 30px 56px 0; }
  .tag { font-family: var(--display); font-weight: 600; font-size: 22px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--water); }
  .name { position: absolute; left: 56px; bottom: 30px; font-size: 24px; color: var(--muted); }
  .name b { color: var(--fg); font-weight: 600; }
  </style><div class="name"><b>Wanigan 2</b> · a desk for coding agents</div>`;
}

/** "6× speed", in the corner while the footage runs fast. */
function badge({ factor, scale = 1 }) {
  return `<style>${BASE_CSS}
  body { width: ${Math.round(260 * scale)}px; height: ${Math.round(64 * scale)}px; display: flex; align-items: center; justify-content: flex-end; }
  .pill { display: inline-flex; align-items: center; gap: ${10 * scale}px; padding: ${9 * scale}px ${18 * scale}px; border-radius: 999px;
    background: rgb(12 15 18 / 0.88); box-shadow: 0 0 0 ${1.5 * scale}px rgb(99 179 228 / 0.55), 0 8px 24px rgb(0 0 0 / 0.45);
    font-weight: 600; font-size: ${24 * scale}px; color: var(--water); font-variant-numeric: tabular-nums; }
  svg { width: ${22 * scale}px; height: ${22 * scale}px; }
  </style><div class="pill"><svg viewBox="0 0 24 24"><path d="M3 5l8 7-8 7zM12 5l8 7-8 7z" fill="currentColor"/></svg>${factor}× speed</div>`;
}

/** The title card (and the poster): what this is, beside a real frame of it. */
function titleCard({ width: w, height: h, eyebrow, title, sub, shot, foot }) {
  const tall = h > w;
  return `<style>${BASE_CSS}
  body { width: ${w}px; height: ${h}px; background: radial-gradient(110% 80% at 85% 0%, rgb(99 179 228 / 0.14), transparent 60%), var(--rail); position: relative; overflow: hidden; }
  .words { position: absolute; ${tall ? 'left: 72px; right: 72px; top: 96px;' : 'left: 120px; top: 50%; transform: translateY(-50%); width: 640px;'} }
  .eyebrow { font-family: var(--display); font-weight: 600; font-size: ${tall ? 30 : 30}px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--water); margin-bottom: 22px; }
  h1 { font-family: var(--sans); font-weight: 700; font-size: ${tall ? 84 : 88}px; line-height: 1.04; letter-spacing: -0.02em; text-wrap: balance; }
  .sub { margin-top: 28px; font-size: ${tall ? 36 : 34}px; line-height: 1.35; color: var(--muted); text-wrap: pretty; }
  .shot { position: absolute; ${tall ? 'left: 72px; right: -40px; bottom: 120px; height: 640px;' : 'left: 840px; right: -60px; top: 150px; bottom: 150px;'}
    border-radius: 18px; overflow: hidden; box-shadow: 0 40px 100px rgb(0 0 0 / 0.6), 0 0 0 1px rgb(255 255 255 / 0.09); background: var(--bg); }
  .shot img { position: absolute; left: 0; top: 0; height: 100%; width: auto; }
  .foot { position: absolute; ${tall ? 'left: 72px; bottom: 48px;' : 'left: 120px; bottom: 64px;'} font-size: 26px; color: var(--faint); }
  .foot b { color: var(--fg); font-weight: 600; }
  </style>
  <div class="words"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1>${sub ? `<p class="sub">${esc(sub)}</p>` : ''}</div>
  ${shot ? `<div class="shot"><img src="${pathToFileURL(shot).href}" alt=""></div>` : ''}
  ${foot ? `<div class="foot">${foot}</div>` : ''}`;
}

/** The end card: open source, and where to get it. */
function endCard({ width: w, height: h, eyebrow, title, sub, link }) {
  const tall = h > w;
  return `<style>${BASE_CSS}
  body { width: ${w}px; height: ${h}px; background: radial-gradient(110% 80% at 15% 100%, rgb(99 179 228 / 0.13), transparent 60%), var(--rail); position: relative; }
  .words { position: absolute; left: ${tall ? 72 : 160}px; right: ${tall ? 72 : 160}px; top: 50%; transform: translateY(-50%); }
  .eyebrow { font-family: var(--display); font-weight: 600; font-size: 30px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--water); margin-bottom: 22px; }
  h1 { font-weight: 700; font-size: ${tall ? 80 : 92}px; line-height: 1.05; letter-spacing: -0.02em; text-wrap: balance; }
  .sub { margin-top: 26px; font-size: ${tall ? 36 : 36}px; line-height: 1.35; color: var(--muted); max-width: 1300px; text-wrap: pretty; }
  .link { margin-top: 56px; display: inline-block; font-family: var(--mono); font-weight: 500; font-size: ${tall ? 38 : 44}px; color: var(--water-ink); background: var(--water); padding: 16px 30px; border-radius: 14px; }
  </style><div class="words"><div class="eyebrow">${esc(eyebrow)}</div><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p><div class="link">${esc(link)}</div></div>`;
}

const TEMPLATES = { caption169, caption45, band45, badge, titleCard, endCard };

/**
 * Render each job { file, kind, width, height, ...props } to a PNG.
 * Transparent where the template leaves the page transparent.
 */
export async function renderPngs(jobs, { tmp }) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    for (const job of jobs) {
      const file = join(tmp, `${job.kind}.html`);
      writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"></head><body>${TEMPLATES[job.kind](job)}</body></html>`);
      await page.setViewportSize({ width: job.width, height: job.height });
      await page.goto(pathToFileURL(file).href);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(50);
      await page.screenshot({ path: job.file, omitBackground: true, clip: { x: 0, y: 0, width: job.width, height: job.height } });
    }
  } finally {
    await browser.close();
  }
}
