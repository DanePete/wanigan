#!/usr/bin/env node
// Look at a cut before anyone else does: frames at an interval, contact sheets
// to page through, and a privacy check that reads every sampled frame's text
// (Apple Vision OCR) for email addresses, home folders, plan names and this
// machine's names and account labels.
//
//   node scripts/video/review.mjs --cut <name> [--every 1] [--no-ocr]
//
// Frames and sheets go to .artifacts/video/cuts/<name>/review/. Exits 1 when the
// OCR finds something personal, and says when and what kind (never the text).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS, VIDEO_DIR, arg, ensureDir, ffmpeg, ffmpegPath as ffmpegBin, flag, probeDuration } from './lib/env.mjs';
import { findPrivate, privateTerms } from './lib/privacy.mjs';

// A take's own frames at given times, to see what happened when (no OCR):
//   node scripts/video/review.mjs --take <name> --at 76,80.5,90
if (arg('--take')) {
  const take = arg('--take');
  const master = join(ARTIFACTS, 'takes', take, 'master.mp4');
  const at = (arg('--at') ?? '').split(',').map(Number).filter((n) => Number.isFinite(n));
  const dir = ensureDir(join(ARTIFACTS, 'takes', take, 'frames'));
  for (const t of at) await ffmpeg(['-ss', String(t), '-i', master, '-frames:v', '1', '-vf', 'scale=1440:-1', '-q:v', '3', join(dir, `t${t}.jpg`)]);
  console.log(`${at.length} frames in ${dir}`);
  process.exit(0);
}

const cut = arg('--cut');
if (!cut) { console.error('Usage: node scripts/video/review.mjs --cut <name> [--every 1] [--no-ocr]\n       node scripts/video/review.mjs --take <name> --at <s,s,...>'); process.exit(1); }
const dir = join(ARTIFACTS, 'cuts', cut);
const every = Number(arg('--every', '1'));
const out = join(dir, 'review');
rmSync(out, { recursive: true, force: true });
ensureDir(out);

const files = { '16x9': join(dir, 'wanigan-2-launch-16x9.mp4'), '4x5': join(dir, 'wanigan-2-launch-4x5.mp4') };
const findings = [];
for (const [shape, file] of Object.entries(files)) {
  if (!existsSync(file)) continue;
  const seconds = probeDuration(file);
  const frames = ensureDir(join(out, shape));
  await ffmpeg(['-i', file, '-vf', `fps=1/${every}`, '-q:v', '3', join(frames, 'f%04d.jpg')]);
  // Sheets of 12 small frames, to page through by eye.
  await ffmpeg(['-i', file, '-vf', `fps=1/${every * 2},scale=${shape === '16x9' ? 480 : 270}:-1,tile=4x3:padding=6:color=0x0c0f12`, '-q:v', '3', join(out, `sheet-${shape}-%02d.jpg`)]);
  console.log(`${shape}: ${seconds.toFixed(1)} s, ${readdirSync(frames).length} frames in ${frames}`);

  // Wanigan in the sidebar, every frame of the 16:9: his spot's average colour must never be warm.
  // (The page hides him when amber; this checks the pixels that were actually encoded.)
  if (shape === '16x9') {
    const raw = execFileSync(ffmpegBin(), ['-v', 'error', '-i', file, '-vf', 'crop=54:54:27:53,scale=1:1:flags=area', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
    let warm = 0;
    for (let i = 0; i + 2 < raw.length; i += 3) {
      const [r, g, b] = [raw[i], raw[i + 1], raw[i + 2]];
      if (r > 70 && r >= g + 8 && r >= b + 25) { // amber measured (111, 92, 61); calm water is blue, hidden is the rail
        warm += 1;
        if (warm <= 5) findings.push({ shape, at: Number((i / 3 / 30).toFixed(2)), kinds: ['warm sidebar orb'], frame: `${file} @ ${(i / 3 / 30).toFixed(2)} s` });
      }
    }
    console.log(`  sidebar orb: ${warm ? `${warm} warm frame(s)` : 'never warm'} in ${raw.length / 3} frames`);
  }

  if (flag('--no-ocr')) continue;
  const ocr = ocrBinary();
  if (!ocr) { console.log('  no OCR here (needs swiftc); look at every frame yourself'); continue; }
  const terms = privateTerms();
  const list = readdirSync(frames).filter((f) => f.endsWith('.jpg')).sort().map((f) => join(frames, f));
  for (let i = 0; i < list.length; i += 40) {
    const res = spawnSync(ocr, list.slice(i, i + 40), { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const line of res.stdout.split('\n').filter(Boolean)) {
      const { file: f, lines } = JSON.parse(line);
      const n = Number(f.match(/f(\d+)\.jpg$/)[1]);
      const kinds = findPrivate(lines.join('\n'), terms);
      if (kinds.length) findings.push({ shape, at: Number(((n - 1) * every).toFixed(1)), kinds, frame: f });
    }
  }
  console.log(`  OCR read ${list.length} frames`);
}
writeFileSync(join(out, 'privacy.json'), `${JSON.stringify(findings.map(({ shape, at, kinds, frame }) => ({ shape, at, kinds, frame })), null, 2)}\n`);
if (findings.length) {
  console.log(`PRIVACY: ${findings.length} frame(s) show something personal:`);
  for (const f of findings) console.log(`  ${f.shape} at ${f.at} s: ${f.kinds.join(', ')}  (${f.frame})`);
  process.exit(1);
}
console.log(flag('--no-ocr') ? 'frames written; OCR skipped' : 'OCR found nothing personal in the sampled frames. Still look at them: it reads text, not faces or orbs.');

function ocrBinary() {
  const bin = join(ARTIFACTS, 'bin', 'ocr');
  const src = join(VIDEO_DIR, 'ocr.swift');
  if (existsSync(bin) && statSync(bin).mtimeMs > statSync(src).mtimeMs) return bin;
  try {
    mkdirSync(join(ARTIFACTS, 'bin'), { recursive: true });
    execFileSync('swiftc', ['-O', src, '-o', bin], { stdio: 'inherit' });
    return bin;
  } catch {
    return null;
  }
}
