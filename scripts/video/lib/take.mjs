// A take: one continuous recording of the app, and the marks that tell the
// edit what happened when. Every mark is stamped with time in the master file.
//   chapter {id}          a chapter starts (the previous one ends)
//   caption {id}          a caption from story.mjs shows from here
//   caption-end           the caption showing goes away
//   speed {factor}        play from here at `factor` (1 is real time)
//   cut {on}              drop footage from here (on) until the next cut {on:false}
//   focus {rect}          what matters on screen, in CSS px: the 4:5 cut frames it
//   privacy {kind}        the scan saw something personal on screen (never what)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AMBER_ORBS, VISIBLE_TEXT } from './page-scripts.mjs';
import { findPrivate } from './privacy.mjs';
import { CAPTION_MIN, EDGE, READ_CPS } from './timeline.mjs';
import { captionText } from '../story.mjs';

const plain = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, ' ').replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b[()][0-9A-Za-z]/g, '').replace(/\s+/g, ' ');

export class Take {
  constructor({ page, rec, mode, dir, human, log }) {
    Object.assign(this, { page, rec, mode, dir, human, log });
    this.marks = [];
    this.notes = [];
    this.terms = [];
  }

  get t() {
    return this.rec ? Number(this.rec.t.toFixed(3)) : 0;
  }

  mark(type, data = {}) {
    const m = { t: this.t, type, ...data };
    this.marks.push(m);
    this.log(`  [${m.t.toFixed(1).padStart(6)}s] ${type} ${Object.keys(data).length ? JSON.stringify(data) : ''}`);
    return m;
  }

  chapter(id) { this.mark('chapter', { id }); this.showing = null; }

  /**
   * Show a caption from here. First, the caption already showing gets its time
   * to be read (a second per 15 characters of output time), so the footage
   * itself has room for the words and the edit never has to stretch them.
   * `pos: 'top'` keeps the 16:9 caption off the bottom, where a terminal's prompt is.
   */
  async caption(id, { pos } = {}) {
    await this.settle();
    this.mark('caption', { id, ...(pos ? { pos } : {}) });
    this.showing = { id, t: this.t };
  }

  /** Wait until the caption showing has been read, plus `extra` seconds of output. */
  async settle(extra = 0) {
    if (!this.showing || !this.rec) return;
    const need = Math.max(CAPTION_MIN, captionText(this.showing.id, this.mode).length / READ_CPS) + extra;
    for (let i = 0; i < 40; i++) {
      const left = need - this.outputSince(this.showing.t);
      if (left <= 0.05) return;
      await this.page.waitForTimeout(Math.min(1000, left * this.factorNow() * 1000));
    }
  }

  /** The speed in force now. */
  factorNow() {
    return this.marks.filter((m) => m.type === 'speed').at(-1)?.factor ?? 1;
  }

  /** Seconds of output since take time `t0`, through every speed change and cut since. */
  outputSince(t0) {
    let factor = 1;
    let cut = false;
    for (const m of this.marks) {
      if (m.t > t0) break;
      if (m.type === 'speed') factor = m.factor;
      if (m.type === 'cut') cut = m.on;
    }
    let at = t0;
    let out = 0;
    for (const m of this.marks.filter((x) => x.t > t0 && (x.type === 'speed' || x.type === 'cut'))) {
      if (!cut) out += (m.t - at) / factor;
      at = m.t;
      if (m.type === 'speed') factor = m.factor;
      else cut = m.on;
    }
    if (!cut) out += (this.t - at) / factor;
    return out;
  }
  captionEnd() { this.mark('caption-end'); }
  speed(factor) { this.mark('speed', { factor }); }
  cut(on = true) { this.mark('cut', { on }); }
  note(text) { this.notes.push({ t: this.t, text }); this.log(`  note: ${text}`); }

  /** Say what the 4:5 cut should frame: a selector, a locator, or a CSS px rect. */
  async focus(target, pad = 24) {
    let rect = Array.isArray(target) ? target : null;
    if (!rect) {
      const loc = typeof target === 'string' ? this.page.locator(target).first() : target;
      const box = await loc.boundingBox().catch(() => null);
      if (!box) { this.note(`focus target not found: ${String(target)}`); return; }
      rect = [box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2];
    }
    this.mark('focus', { rect: rect.map((n) => Math.round(n)) });
  }

  /** Show a caption and stay on this view while it is read. */
  async read(id, ms = 0) {
    await this.caption(id);
    await this.settle();
    if (ms) await this.page.waitForTimeout(ms);
  }

  api(method, params = {}) {
    return this.page.evaluate(([m, p]) => window.wanigan.call(m, p), [method, params]);
  }

  /** Poll until `fn` returns something truthy, or fail with `what`. */
  async until(fn, { timeout = 60_000, every = 500, what = 'a condition' } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try { last = await fn(); } catch (e) { last = undefined; this.lastError = e; }
      if (last) return last;
      await this.page.waitForTimeout(every);
    }
    throw new Error(`timed out after ${Math.round(timeout / 1000)} s waiting for ${what}`);
  }

  /** The tail of a session's terminal, as plain text. */
  async screen(sessionId, tail = 4000) {
    const { replay } = await this.api('sessions.watch', { id: sessionId });
    return plain(replay.slice(-tail * 4)).slice(-tail);
  }

  /**
   * Watch what is on screen for anything personal, once a second and a half.
   * The page masks known patterns before they are painted; this is the alarm
   * for what slips past (a field's value, a new place a name turns up).
   */
  async startPrivacyScan(terms) {
    // Only frames from now on count: what the guard saw while the take was set up was never recorded.
    this.amberSeen = await this.page.evaluate(() => window.__wgGuard?.amberFrames() ?? 0).catch(() => 0);
    let busy = false;
    this.privacyTimer = setInterval(async () => {
      if (busy || this.rec?.paused) return;
      busy = true;
      try {
        const text = await this.page.evaluate(VISIBLE_TEXT);
        for (const kind of findPrivate(text, terms)) this.mark('privacy', { kind });
        // Wanigan amber on screen is refused like a personal detail: now, or on any frame since the last look.
        const frames = await this.page.evaluate(() => window.__wgGuard?.amberFrames() ?? 0);
        if (frames > (this.amberSeen ?? 0) || (await this.page.evaluate(AMBER_ORBS))) this.mark('privacy', { kind: 'amber orb' });
        this.amberSeen = frames;
      } catch { /* the page is between views */ }
      busy = false;
    }, 1500);
  }

  stopPrivacyScan() {
    clearInterval(this.privacyTimer);
  }

  save(extra = {}) {
    const file = join(this.dir, 'take.json');
    writeFileSync(file, `${JSON.stringify({ mode: this.mode, fps: this.rec?.fps ?? 30, css: [1440, 810], px: [2880, 1620], ...extra, marks: this.marks, notes: this.notes }, null, 2)}\n`);
    return file;
  }
}
