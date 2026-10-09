// From a take's marks to an edit: which footage each chapter keeps, how fast it
// plays, and when each caption, badge and 4:5 framing change lands in the
// output. Pure functions, so the edit can be planned and checked without ffmpeg.

/** Speed-ups read as round numbers. */
const NICE = [2, 3, 4, 6, 8, 10, 12, 15, 20, 30, 40, 60, 90, 120];

export const CAPTION_MIN = 2.6;
/** Reading speed for a caption on a phone, muted: characters a second. */
export const READ_CPS = 15;
export const CAPTION_MAX = 7.5;
/** The longest any sped-up stretch may run in the output; longer waits play faster. */
export const FAST_MAX = 9;
/** How far from a chapter's ends a caption keeps: the crossfade plus a beat. */
export const EDGE = 0.65;

/**
 * Plan one chapter of a take.
 * @param {{ marks: {t:number,type:string}[] }} take
 * @param {string} id chapter id
 */
export function planChapter(take, id, { textOf = () => '' } = {}) {
  const marks = [...take.marks].sort((a, b) => a.t - b.t);
  const startMark = marks.find((m) => m.type === 'chapter' && m.id === id);
  if (!startMark) throw new Error(`the take has no chapter ${id}`);
  const start = startMark.t;
  const after = marks.find((m) => m.t > start && (m.type === 'chapter' || m.type === 'end'))
    ?? marks.filter((m) => m.t >= start).at(-1);
  const end = after ? after.t : start;

  // The speed and cut in force at the chapter's start, then each change in it.
  let factor = 1;
  let cutting = false;
  for (const m of marks) {
    if (m.t >= start) break;
    if (m.type === 'speed') factor = m.factor;
    if (m.type === 'cut') cutting = m.on;
  }
  const changes = marks.filter((m) => m.t >= start && m.t < end && (m.type === 'speed' || m.type === 'cut'));
  const raw = [];
  let from = start;
  for (const m of changes) {
    if (m.t > from) raw.push({ a: from, b: m.t, factor, cut: cutting });
    from = m.t;
    if (m.type === 'speed') factor = m.factor;
    if (m.type === 'cut') cutting = m.on;
  }
  if (end > from) raw.push({ a: from, b: end, factor, cut: cutting });

  // Merge neighbours that play the same way; drop slivers.
  const segments = [];
  for (const s of raw) {
    const last = segments.at(-1);
    if (last && last.cut === s.cut && last.factor === s.factor && Math.abs(last.b - s.a) < 1e-6) last.b = s.b;
    else segments.push({ ...s });
  }
  for (const s of segments) {
    if (s.cut || s.factor <= 1) continue;
    const out = (s.b - s.a) / s.factor;
    if (out > FAST_MAX) s.factor = NICE.find((n) => (s.b - s.a) / n <= FAST_MAX) ?? Math.ceil((s.b - s.a) / FAST_MAX);
  }
  const kept = segments.filter((s) => !s.cut && s.b - s.a > 0.05);

  /** Take seconds to chapter-output seconds. */
  const map = (t) => {
    let out = 0;
    for (const s of kept) {
      if (t >= s.b) out += (s.b - s.a) / s.factor;
      else { if (t > s.a) out += (t - s.a) / s.factor; break; }
    }
    return out;
  };
  const duration = map(end + 1);

  // Captions: from their mark to the next caption (or caption-end, or the chapter's end).
  const capMarks = marks.filter((m) => m.t >= start && m.t < end && (m.type === 'caption' || m.type === 'caption-end'));
  const captions = [];
  for (let i = 0; i < capMarks.length; i++) {
    const m = capMarks[i];
    if (m.type !== 'caption') continue;
    const next = capMarks[i + 1];
    captions.push({ id: m.id, pos: m.pos ?? 'bottom', start: map(m.t), end: next ? map(next.t) : duration, hold: !!m.hold });
  }
  // Chapters crossfade into each other: keep every caption clear of the fade at
  // either end, so two captions are never on screen at once.
  const warnings = [];
  const first = EDGE;
  const last = Math.max(first, duration - EDGE);
  for (let i = 0; i < captions.length; i++) {
    const c = captions[i];
    c.start = Math.min(Math.max(c.start, first), last);
    c.end = Math.min(Math.max(c.end, c.start), last);
    const need = Math.max(CAPTION_MIN, textOf(c.id).length / READ_CPS);
    if (!c.hold && c.end - c.start > Math.max(CAPTION_MAX, need)) c.end = c.start + Math.max(CAPTION_MAX, need);
    if (c.end - c.start < need - 0.01) {
      const was = c.end - c.start;
      c.end = Math.min(last, c.start + need);
      if (c.end - c.start < need - 0.01) c.start = Math.max(first, c.end - need);
      if (c.end - c.start - was > 0.2) warnings.push(`caption ${c.id} had ${was.toFixed(1)} s of footage; shown for ${(c.end - c.start).toFixed(1)} s, over what follows`);
      const next = captions[i + 1];
      if (next && next.start < c.end) next.start = c.end;
    }
  }
  // Never two at once: a caption that would run into the next one ends where it starts.
  for (let i = 0; i < captions.length - 1; i++) {
    const c = captions[i];
    const next = captions[i + 1];
    if (next.start < c.end) {
      if (next.start < c.start + 1) next.start = Math.min(c.end, last);
      else c.end = next.start;
    }
  }
  const shown = captions.filter((c) => c.end - c.start >= 1);
  for (const c of captions) if (!shown.includes(c)) warnings.push(`caption ${c.id} had no room in the chapter and is left out`);

  const badges = [];
  for (const s of kept) {
    if (s.factor > 1) badges.push({ start: map(s.a), end: map(s.b), factor: s.factor });
  }

  // 4:5 framing: the centre of what matters, in CSS px, over output time.
  const focusAt = (t) => marks.filter((m) => m.type === 'focus' && m.t <= t).at(-1);
  const firstFocus = focusAt(start);
  const focus = [];
  if (firstFocus) focus.push({ t: 0, rect: firstFocus.rect });
  for (const m of marks) {
    if (m.type !== 'focus' || m.t < start || m.t >= end) continue;
    focus.push({ t: map(m.t), rect: m.rect });
  }

  const privacy = marks.filter((m) => m.type === 'privacy' && m.t >= start && m.t < end
    && kept.some((s) => m.t >= s.a - 0.5 && m.t <= s.b + 0.5));

  return { id, start, end, segments: kept, duration, captions: shown, badges, focus, privacy, warnings, map };
}

/**
 * The 4:5 crop's left edge in master pixels over chapter-output time, as an
 * ffmpeg expression: hold, then ease to each new focus over `ease` seconds.
 * Written as a sum of eased steps, x0 + Σ dx·smoothstep((t-ti)/ease), so it
 * needs no nesting however many moves a chapter has.
 */
export function cropExpr(focus, { scale = 2, cssW = 1440, crop = 1620, ease = 0.7 } = {}) {
  const maxX = cssW * scale - crop;
  // Centre what matters; if it is wider than the crop, keep its left edge (where its words start).
  const xFor = ([rx, , rw]) => {
    const css = rw * scale > crop * 0.94 ? rx * scale - 24 : (rx + rw / 2) * scale - crop / 2;
    return Math.round(Math.max(0, Math.min(maxX, css)));
  };
  const pts = [];
  for (const f of focus) {
    const x = xFor(f.rect);
    if (pts.length && Math.abs(pts.at(-1).x - x) < 24) continue; // too small a move to be worth a pan
    pts.push({ t: Math.max(0, f.t), x });
  }
  if (!pts.length) return String(xFor([cssW / 2 - 1, 0, 2]));
  let expr = String(pts[0].x);
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const c = `clip((t-${pts[i].t.toFixed(3)})/${ease},0,1)`;
    expr += `${dx >= 0 ? '+' : '-'}${Math.abs(dx)}*(3*${c}*${c}-2*${c}*${c}*${c})`;
  }
  return expr;
}
