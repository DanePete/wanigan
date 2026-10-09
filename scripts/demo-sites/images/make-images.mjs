// Draws every picture a demo site uses: made-up products and landscapes,
// written as SVG and rendered to JPEG. Nothing is downloaded or copied: the
// same seed always draws the same picture, so a rebuild gives the same files.
//
// Runs inside a ddev web container (Node, ImageMagick and the URW fonts are
// there): node make-images.mjs northstar|fieldnotes <out-dir>
// Only missing pictures are drawn; REDRAW=1 draws them all again.
// Renderer: @resvg/resvg-js, installed next to this file by build.sh.

import { Resvg } from '@resvg/resvg-js';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
const { jobs } = await import(`./${set}.mjs`);
mkdirSync(out, { recursive: true });
const list = jobs();
let made = 0;
for (const [name, draw] of list) {
  const file = join(out, name);
  if (existsSync(file) && !process.env.REDRAW) continue;
  render(draw(), file);
  made++;
}
console.log(`${set}: ${made} drawn, ${list.length - made} already there, in ${out}`);
