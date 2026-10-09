#!/usr/bin/env node
// Cut a take (or several) into the launch video: both aspect ratios, a poster
// and an .srt. Captions come from story.mjs, placed where the take marked them.
//
//   node scripts/video/edit.mjs --take <name> [--from b=<other take>] [--name <cut>]
//
//   --take <name>          the take most chapters come from (.artifacts/video/takes/<name>)
//   --from <ch>=<take>     take one chapter from another take, e.g. --from b=demo-1015
//                          (repeatable): the real cut can use the demo's Jev chapter
//   --chapters a,b,c,d,e,f which chapters, in order (default: every one the takes have)
//   --name <cut>           output folder under .artifacts/video/cuts (default: the take's name)
//   --poster-at <ch>:<s>   the frame on the title card and poster: chapter and seconds into it
//   --allow-privacy        render even where the take's privacy scan saw something (never for posting)
//
// Writes wanigan-2-launch-16x9.mp4, wanigan-2-launch-4x5.mp4, a poster PNG for
// each, and wanigan-2-launch.srt.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS, TO_VIDEO, VIDEO_COLOR, arg, ensureDir, ffmpeg, flag, probeDuration } from './lib/env.mjs';
import { CHAPTERS, END, TITLE, captionText } from './story.mjs';
import { planChapter, cropExpr } from './lib/timeline.mjs';
import { renderPngs } from './lib/overlays.mjs';

const FPS = 30;
const FADE = 0.5;
const TITLE_SECONDS = 3.6;
const END_SECONDS = 5;
const W = 1920;
const H = 1080;
const BAND = 270;

const mainTake = arg('--take');
if (!mainTake) {
  console.error('Usage: node scripts/video/edit.mjs --take <name> [--from b=<take>] [--name <cut>]');
  process.exit(1);
}
const sources = {};
for (let i = 0; i < process.argv.length; i++) {
  if (process.argv[i] === '--from') {
    const [ch, name] = (process.argv[i + 1] ?? '').split('=');
    if (ch && name) sources[ch] = name;
  }
}
const takes = {};
const loadTake = (name) => {
  if (takes[name]) return takes[name];
  const dir = join(ARTIFACTS, 'takes', name);
  const file = join(dir, 'take.json');
  if (!existsSync(file)) throw new Error(`no take at ${dir}`);
  takes[name] = { name, dir, master: join(dir, 'master.mp4'), ...JSON.parse(readFileSync(file, 'utf8')) };
  return takes[name];
};
loadTake(mainTake); // fails early when the take does not exist
const has = (take, id) => take.marks.some((m) => m.type === 'chapter' && m.id === id);
const order = (arg('--chapters') ?? CHAPTERS.map((c) => c.id).filter((id) => id !== 'g').join(',')).split(',').filter((id) => {
  const take = loadTake(sources[id] ?? mainTake);
  if (!has(take, id)) { console.log(`  chapter ${id}: not in take ${take.name}; left out`); return false; }
  return true;
});
const cutName = arg('--name', mainTake);
const out = ensureDir(join(ARTIFACTS, 'cuts', cutName));
const work = ensureDir(join(out, 'work'));
const tagOf = (id) => CHAPTERS.find((c) => c.id === id)?.tag ?? '';

console.log(`Cutting "${cutName}" from ${[...new Set(order.map((id) => sources[id] ?? mainTake))].join(', ')}: chapters ${order.join(', ')}`);

/* ── plan ─────────────────────────────────────────────────────────────────── */

const plans = order.map((id) => {
  const take = loadTake(sources[id] ?? mainTake);
  const plan = planChapter(take, id, { textOf: (cid) => captionText(cid, take.mode) });
  plan.take = take;
  for (const w of plan.warnings) console.log(`  chapter ${id}: ${w}`);
  if (plan.privacy.length && !flag('--allow-privacy')) {
    throw new Error(`chapter ${id} of take ${take.name} keeps footage where the privacy scan saw: ${[...new Set(plan.privacy.map((p) => p.kind))].join(', ')} (at ${plan.privacy.map((p) => p.t.toFixed(1)).join(', ')} s). Re-record, or cut those moments.`);
  }
  console.log(`  chapter ${id} (${take.name}): ${(plan.end - plan.start).toFixed(1)} s of footage -> ${plan.duration.toFixed(1)} s, ${plan.captions.length} captions${plan.badges.length ? `, sped up ${plan.badges.map((b) => `${b.factor}x`).join(' ')}` : ''}`);
  return plan;
});

/* ── overlays ─────────────────────────────────────────────────────────────── */

const jobs = [];
const png = (name) => join(work, `${name}.png`);
for (const p of plans) {
  const tag = tagOf(p.id);
  jobs.push({ kind: 'band45', file: png(`band-${p.id}`), width: 1080, height: BAND, tag });
  p.captions.forEach((c, i) => {
    const text = captionText(c.id, p.take.mode);
    c.text = text;
    jobs.push({ kind: 'caption169', file: png(`cap169-${p.id}-${i}`), width: W, height: H, text, tag, pos: c.pos });
    jobs.push({ kind: 'caption45', file: png(`cap45-${p.id}-${i}`), width: 1080, height: BAND, text, tag });
  });
}
const factors = [...new Set(plans.flatMap((p) => p.badges.map((b) => b.factor)))];
for (const f of factors) {
  jobs.push({ kind: 'badge', file: png(`badge169-${f}`), width: 260, height: 64, factor: f, scale: 1 });
  jobs.push({ kind: 'badge', file: png(`badge45-${f}`), width: 230, height: 56, factor: f, scale: 0.88 });
}

// The title card shows a real frame of the app: by default, the board once the new card is in Ready.
const posterAt = (() => {
  const given = arg('--poster-at');
  if (given) {
    const [ch, s] = given.split(':');
    const take = loadTake(sources[ch] ?? mainTake);
    return { take, t: planChapter(take, ch).start + Number(s) };
  }
  const take = loadTake(sources.b ?? mainTake);
  const m = take.marks.find((x) => x.type === 'caption' && x.id === 'b5') ?? take.marks.find((x) => x.type === 'chapter' && x.id === 'b');
  return m ? { take, t: m.t + 3.2 } : null;
})();
const shot = join(work, 'shot.png');
if (posterAt) await ffmpeg(['-ss', posterAt.t.toFixed(2), '-i', posterAt.take.master, '-frames:v', '1', '-update', '1', shot]);
const posterShot = posterAt ? shot : null;
jobs.push({ kind: 'titleCard', file: join(out, 'wanigan-2-launch-poster-16x9.png'), width: W, height: H, ...TITLE, shot: posterShot, foot: '<b>Open source</b> · MIT' });
jobs.push({ kind: 'titleCard', file: join(out, 'wanigan-2-launch-poster-4x5.png'), width: 1080, height: 1350, ...TITLE, shot: posterShot, foot: '<b>Open source</b> · MIT' });
jobs.push({ kind: 'endCard', file: png('end169'), width: W, height: H, ...END });
jobs.push({ kind: 'endCard', file: png('end45'), width: 1080, height: 1350, ...END });
console.log(`  rendering ${jobs.length} overlays`);
await renderPngs(jobs, { tmp: work });

/* ── each chapter, both shapes, from one decode ───────────────────────────── */

for (const p of plans) {
  const f169 = join(work, `ch-${p.id}-16x9.mp4`);
  const f45 = join(work, `ch-${p.id}-4x5.mp4`);
  const inputs = [];
  const graph = [];
  p.segments.forEach((s, i) => {
    inputs.push('-ss', s.a.toFixed(3), '-t', (s.b - s.a).toFixed(3), '-i', p.take.master);
    // Older masters are full-range BT.601 (straight from JPEG); every segment becomes limited-range BT.709.
    graph.push(`[${i}:v]setpts=(PTS-STARTPTS)/${s.factor},fps=${FPS},${TO_VIDEO},format=yuv420p[s${i}]`);
  });
  const n = p.segments.length;
  graph.push(`${p.segments.map((_, i) => `[s${i}]`).join('')}concat=n=${n}:v=1:a=0,split=2[full][wide]`);
  let idx = n;
  const still = (file, seconds) => { inputs.push('-loop', '1', '-framerate', String(FPS), '-t', seconds.toFixed(3), '-i', file); return idx++; };
  // Overlays are RGBA PNGs: fade them in and out, then convert them the same way as the footage, so the type keeps its colour.
  const timed = (input, start, dur) => `[${input}:v]format=rgba,fade=t=in:st=0:d=0.22:alpha=1,fade=t=out:st=${Math.max(0, dur - 0.22).toFixed(3)}:d=0.22:alpha=1,${TO_VIDEO},format=yuva420p,setpts=PTS-STARTPTS+${start.toFixed(3)}/TB`;

  // 16:9: the whole window, scaled; captions on a plate; the speed badge in the corner.
  graph.push(`[wide]scale=${W}:${H}:flags=lanczos[w0]`);
  let w = 'w0';
  let k = 0;
  p.captions.forEach((c, i) => {
    const dur = c.end - c.start;
    const input = still(png(`cap169-${p.id}-${i}`), dur);
    graph.push(`${timed(input, c.start, dur)}[c169_${i}]`);
    graph.push(`[${w}][c169_${i}]overlay=0:0:eof_action=pass:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[w${++k}]`);
    w = `w${k}`;
  });
  p.badges.forEach((b, i) => {
    const dur = b.end - b.start;
    const input = still(png(`badge169-${b.factor}`), dur);
    graph.push(`${timed(input, b.start, dur)}[b169_${i}]`);
    graph.push(`[${w}][b169_${i}]overlay=${W - 260 - 28}:${28}:eof_action=pass:enable='between(t,${b.start.toFixed(3)},${b.end.toFixed(3)})'[w${++k}]`);
    w = `w${k}`;
  });

  // 4:5: a square of the window that follows the action, over a band for the words.
  graph.push(`[full]crop=1620:1620:x='${cropExpr(p.focus)}':y=0,scale=1080:1080:flags=lanczos,pad=1080:1350:0:0:color=0x0c0f12[t0]`);
  let t = 't0';
  let j = 0;
  const bandIn = still(png(`band-${p.id}`), p.duration + 1);
  graph.push(`[${bandIn}:v]format=rgba,${TO_VIDEO},format=yuva420p[band]`);
  graph.push(`[${t}][band]overlay=0:1080:eof_action=repeat:shortest=0[t${++j}]`);
  t = `t${j}`;
  p.captions.forEach((c, i) => {
    const dur = c.end - c.start;
    const input = still(png(`cap45-${p.id}-${i}`), dur);
    graph.push(`${timed(input, c.start, dur)}[c45_${i}]`);
    graph.push(`[${t}][c45_${i}]overlay=0:1080:eof_action=pass:enable='between(t,${c.start.toFixed(3)},${c.end.toFixed(3)})'[t${++j}]`);
    t = `t${j}`;
  });
  p.badges.forEach((b, i) => {
    const dur = b.end - b.start;
    const input = still(png(`badge45-${b.factor}`), dur);
    graph.push(`${timed(input, b.start, dur)}[b45_${i}]`);
    graph.push(`[${t}][b45_${i}]overlay=1080-230-22:22:eof_action=pass:enable='between(t,${b.start.toFixed(3)},${b.end.toFixed(3)})'[t${++j}]`);
    t = `t${j}`;
  });

  const enc = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '14', '-pix_fmt', 'yuv420p', ...VIDEO_COLOR, '-r', String(FPS)];
  console.log(`  chapter ${p.id}: rendering ${p.duration.toFixed(1)} s`);
  await ffmpeg([
    ...inputs, '-filter_complex', graph.join(';'),
    '-map', `[${w}]`, '-t', p.duration.toFixed(3), ...enc, f169,
    '-map', `[${t}]`, '-t', p.duration.toFixed(3), ...enc, f45,
  ]);
  p.files = { '16x9': f169, '4x5': f45 };
  p.rendered = probeDuration(f169);
}

/* ── the whole: title, chapters, end, crossfaded ──────────────────────────── */

const pieces = [
  { kind: 'title', seconds: TITLE_SECONDS },
  ...plans.map((p) => ({ kind: 'chapter', plan: p, seconds: p.rendered })),
  { kind: 'end', seconds: END_SECONDS },
];
let at = 0;
for (const [i, piece] of pieces.entries()) {
  piece.start = at;
  at += piece.seconds - (i < pieces.length - 1 ? FADE : 0);
}
const total = at;

for (const shape of ['16x9', '4x5']) {
  const [w, h] = shape === '16x9' ? [W, H] : [1080, 1350];
  const inputs = [];
  const graph = [];
  pieces.forEach((piece, i) => {
    if (piece.kind === 'chapter') inputs.push('-i', piece.plan.files[shape]);
    else inputs.push('-loop', '1', '-framerate', String(FPS), '-t', piece.seconds.toFixed(3), '-i',
      piece.kind === 'title' ? join(out, `wanigan-2-launch-poster-${shape}.png`) : png(shape === '16x9' ? 'end169' : 'end45'));
    graph.push(`[${i}:v]scale=${w}:${h}:out_range=tv:out_color_matrix=bt709,fps=${FPS},format=yuv420p,setsar=1,settb=AVTB[p${i}]`);
  });
  let last = 'p0';
  for (let i = 1; i < pieces.length; i++) {
    const label = i === pieces.length - 1 ? 'joined' : `x${i}`;
    graph.push(`[${last}][p${i}]xfade=transition=fade:duration=${FADE}:offset=${(pieces[i].start).toFixed(3)}[${label}]`);
    last = label;
  }
  // Say what the pixels are, on every frame, so the encoder writes it into the file.
  graph.push('[joined]setparams=range=tv:colorspace=bt709:color_primaries=bt709:color_trc=bt709[vout]');
  const file = join(out, `wanigan-2-launch-${shape}.mp4`);
  console.log(`  ${shape}: assembling ${total.toFixed(1)} s`);
  await ffmpeg([
    ...inputs, '-filter_complex', graph.join(';'), '-map', '[vout]',
    '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', ...VIDEO_COLOR, '-r', String(FPS),
    '-movflags', '+faststart', '-an', file,
  ]);
}

/* ── captions as a file, for LinkedIn ─────────────────────────────────────── */

const stamp = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const p2 = (n, w = 2) => String(n).padStart(w, '0');
  return `${p2(Math.floor(ms / 3600000))}:${p2(Math.floor(ms / 60000) % 60)}:${p2(Math.floor(ms / 1000) % 60)},${p2(ms % 1000, 3)}`;
};
const cues = [];
cues.push({ start: 0.3, end: TITLE_SECONDS - FADE, text: `${TITLE.eyebrow}: ${TITLE.title}` });
for (const piece of pieces.filter((x) => x.kind === 'chapter')) {
  for (const c of piece.plan.captions) cues.push({ start: piece.start + c.start, end: piece.start + c.end, text: c.text });
}
const endPiece = pieces.at(-1);
cues.push({ start: endPiece.start + FADE, end: total - 0.2, text: `${END.title} ${END.link}` });
writeFileSync(join(out, 'wanigan-2-launch.srt'), cues.map((c, i) => `${i + 1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n'));

const plan = {
  cut: cutName, seconds: Number(total.toFixed(2)),
  pieces: pieces.map((x) => ({ kind: x.kind, chapter: x.plan?.id, take: x.plan?.take.name, mode: x.plan?.take.mode, start: Number(x.start.toFixed(2)), seconds: Number(x.seconds.toFixed(2)) })),
  captions: cues.map((c) => ({ start: Number(c.start.toFixed(2)), end: Number(c.end.toFixed(2)), text: c.text })),
};
writeFileSync(join(out, 'cut.json'), `${JSON.stringify(plan, null, 2)}\n`);
if (!flag('--keep-work')) for (const p of plans) for (const f of Object.values(p.files)) rmSync(f, { force: true });
console.log(`cut done: ${out} (${total.toFixed(1)} s)`);
