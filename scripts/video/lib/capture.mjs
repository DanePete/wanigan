// Recording the window: Chromium's own screencast of the page, sampled onto a
// steady 30 fps clock and encoded as it arrives.
//
// Why this way (measured on an M-series Mac, window 1440x810 CSS px at 2x):
// - CDP Page.startScreencast sends a JPEG of the composited page at full device
//   resolution (2880x1620) whenever it changes, at up to ~57 fps. At quality 92
//   the text is as sharp as a PNG screenshot once scaled to 1080p.
// - A page.screenshot loop takes ~55 ms a frame: under 20 fps, and it stalls
//   the page while it reads back.
// - Playwright's recordVideo encodes VP8 at a low, fixed bitrate: small text smears.
// Screencast frames only come when something changes, so a ticker writes the
// newest frame every 1/30 s of wall time. Time in the master file is therefore
// wall time, which the edit relies on: a mark at 12.4 s is 12.4 s into the file.
import { spawn } from 'node:child_process';
import { VIDEO_COLOR, ffmpegPath } from './env.mjs';

export class ScreenRecorder {
  /**
   * @param {object} o
   * @param {import('playwright-core').Page} o.page
   * @param {string} o.file  master .mp4 to write
   * @param {number} [o.fps]
   * @param {number} [o.quality]  JPEG quality of the screencast
   * @param {'x264'|'vt'} [o.encoder]
   */
  constructor({ page, file, fps = 30, quality = 92, encoder = 'x264', width = 2880, height = 1620 }) {
    Object.assign(this, { page, file, fps, quality, encoder, width, height });
    this.frames = 0;
    this.latest = null;
    this.received = 0;
    this.paused = false;
    this.stopped = false;
    this.timer = null;
  }

  /** Seconds into the master file: what every mark is stamped with. */
  get t() {
    return this.frames / this.fps;
  }

  async start() {
    const enc = this.encoder === 'vt'
      ? ['-c:v', 'h264_videotoolbox', '-b:v', '40M', '-maxrate', '60M']
      // Visually lossless text at this size; veryfast keeps up in real time beside the app.
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '60'];
    this.ffmpeg = spawn(ffmpegPath(), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'image2pipe', '-framerate', String(this.fps), '-c:v', 'mjpeg', '-i', '-',
      // The window may come out a pixel off its asked-for size; the master is always exact.
      // JPEG is full-range BT.601; video is limited-range BT.709, converted here, once.
      '-vf', `scale=${this.width}:${this.height}:flags=lanczos:out_range=tv:out_color_matrix=bt709,format=yuv420p`,
      ...enc, ...VIDEO_COLOR, '-r', String(this.fps), '-movflags', '+faststart', this.file,
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    this.ffmpegErr = '';
    this.ffmpeg.stderr.on('data', (d) => { this.ffmpegErr = (this.ffmpegErr + d).slice(-4000); });
    this.ffmpeg.stdin.on('error', () => {});
    this.done = new Promise((resolve) => this.ffmpeg.on('exit', (code) => resolve(code)));

    this.cdp = await this.page.context().newCDPSession(this.page);
    this.cdp.on('Page.screencastFrame', (f) => {
      this.latest = Buffer.from(f.data, 'base64');
      this.received += 1;
      this.cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    });
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: this.width, maxHeight: this.height, everyNthFrame: 1 });
    // Wait for the first frame, so the file never starts black.
    for (let i = 0; i < 100 && !this.latest; i++) await new Promise((r) => setTimeout(r, 50));
    this.base = performance.now();
    this.written = 0;
    this.tick();
  }

  tick() {
    if (this.stopped) return;
    const interval = 1000 / this.fps;
    if (!this.paused && this.latest) {
      // Catch up after a stall (a busy event loop), so file time stays wall time.
      const due = Math.floor((performance.now() - this.base) / interval) + 1;
      let n = Math.min(due - this.written, this.fps * 2);
      while (n-- > 0) {
        this.ffmpeg.stdin.write(this.latest);
        this.written += 1;
        this.frames += 1;
      }
      if (due - this.written > 0) this.written = due; // a stall longer than 2 s is dropped, not replayed
    }
    const next = this.base + (this.written + 1) * interval - performance.now();
    this.timer = setTimeout(() => this.tick(), Math.max(1, next));
  }

  /** Stop writing frames: what happens meanwhile is not in the file (a key pasted off camera). */
  pause() {
    this.paused = true;
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.base = performance.now() - this.written * (1000 / this.fps);
  }

  /** A still of the newest frame, as JPEG bytes. */
  still() {
    return this.latest;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.cdp?.send('Page.stopScreencast').catch(() => {});
    await this.cdp?.detach().catch(() => {});
    this.ffmpeg.stdin.end();
    const code = await this.done;
    if (code !== 0) throw new Error(`the recording's encoder exited ${code}: ${this.ffmpegErr.trim()}`);
  }
}
