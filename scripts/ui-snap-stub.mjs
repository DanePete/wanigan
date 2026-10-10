// Snap and Record played in the browser harness, which has no native view:
// added as an init script after scripts/ui-live-stub.mjs. A snap's picture is
// that stub's wireframe (grey boxes and their names, never a website); a
// recording is a made-up one of the acme site at example.test, its clip
// whatever the sweep gives as __wgLive.clip (a WebM the sweep encodes from
// wireframe frames), its key frames the wireframe. The core's
// attachments.save and sessions.queue still reach the demo's real core; what
// they were given is kept in __wgLive.sent, for the sweep to read. Test-only;
// never shipped.

export function snapStub() {
  const w = window.__wgLive;
  const live = window.wanigan.live;
  w.sent = [];
  w.noAgents = false;
  w.consoleErrors = [];
  w.clip = null;
  const listeners = new Set();
  let rec = { on: false, projectId: null, startedAt: null, limitMs: 120000, frames: 0, steps: 0, saving: false, done: null, error: null };
  const tell = () => { for (const l of listeners) l({ ...rec }); };

  /** The wireframe the stage shows, as a PNG (base64) `width` × `height` CSS pixels, at the screen's scale. */
  const png = async (width, height, type = 'image/png') => {
    const img = new Image();
    await new Promise((done, fail) => { img.onload = done; img.onerror = fail; img.src = w.wire(width, height); });
    const scale = window.devicePixelRatio || 1;
    const c = document.createElement('canvas');
    c.width = Math.round(width * scale);
    c.height = Math.round(height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL(type, 0.85).split(',')[1];
  };
  const box = () => document.getElementById('__wg_live_stub')?.getBoundingClientRect() ?? { width: 1000, height: 700 };
  // The project the view shows, as the window gave it: a recording is that project's.
  let shown = null;
  const show = live.show;
  live.show = (id, ...rest) => { shown = id; return show(id, ...rest); };

  live.snap = async (mode) => {
    w.calls.push(`snap ${mode}`);
    const b = box();
    const width = Math.round(b.width);
    // The whole page is the wireframe's whole height (its footer ends at 1214 px).
    const height = mode === 'page' ? 1240 : Math.round(b.height);
    const data = await png(width, height);
    const scale = window.devicePixelRatio || 1;
    return {
      scope: mode, data, width: Math.round(width * scale), height: Math.round(height * scale), cssWidth: width, cssHeight: height,
      scrollX: 0, scrollY: mode === 'page' ? 0 : w.scrollY ?? 0, url: 'https://acme.example.test/', regions: mode === 'page' ? await live.scan() : null, cut: false,
    };
  };
  const real = live.problems;
  live.problems = async () => [...(await real()), ...w.consoleErrors.map((text) => ({ level: 'error', text, source: 'console' }))];

  // What a made-up recording of the acme site came to: a click on the opening hours, a password typed (never kept),
  // a page, a request that failed, a console error, and what the owner said.
  const recording = (startedAt, ms) => ({
    id: '20261009T120000-ab12cd', projectId: rec.projectId, url: 'https://acme.example.test/', startedAt, ms, viewWidth: Math.round(box().width),
    folder: '/Users/acme/Library/Application Support/Wanigan 2/live-recordings/NS-1a2b3c4d/20261009T120000-ab12cd',
    clip: w.clip ? { file: '…/clip.webm', bytes: Math.round((w.clip.length * 3) / 4), width: 1200, height: 800, frames: 22 } : null,
    clipWhy: w.clip ? null : 'Not played in this sweep.',
    keyFrames: [
      { n: 1, file: '…/frame-1.jpg', at: 800, why: 'clicked link “Opening hours”', step: 0 },
      { n: 2, file: '…/frame-2.jpg', at: 3000, why: 'went to /events', step: 3 },
      { n: 3, file: '…/frame-3.jpg', at: 3400, why: 'a console error', step: 5 },
    ],
    steps: [
      { type: 'click', at: 900, x: 1020, y: 830, target: 'link “Opening hours”', selector: 'aside > div:nth-of-type(3)', part: 'p-hours', made: 'block block_content:hours@acme_hours' },
      { type: 'typed', at: 1800, text: null, secret: true, target: 'password field “Password”' },
      { type: 'key', at: 2100, key: null, secret: true, target: 'password field “Password”' },
      { type: 'navigate', at: 2200, path: '/events', status: 200, inPage: false },
      { type: 'request', at: 2900, method: 'POST', path: '/cart/add', status: 500, error: null, ms: 312 },
      { type: 'console', at: 3400, text: 'TypeError: hours is undefined (/themes/custom/acme/js/hours.js:12)' },
      { type: 'said', at: 3600, text: 'The hours vanish after I sign in.' },
    ],
    cut: false, stopped: 'owner',
  });
  let started = 0;
  live.recordStart = async () => {
    w.calls.push('recordStart');
    started = Date.now();
    rec = { ...rec, on: true, projectId: shown, startedAt: started, frames: 0, steps: 0, done: null, error: null };
    tell();
    return { ...rec };
  };
  live.recordStop = async () => {
    if (!rec.on) return null;
    w.calls.push('recordStop');
    rec = { ...rec, on: false, saving: true };
    tell();
    await new Promise((done) => setTimeout(done, 60));
    const done = recording(started, Math.max(4200, Date.now() - started));
    rec = { ...rec, saving: false, done };
    tell();
    return done;
  };
  live.recordSay = async (text) => { w.calls.push(`recordSay ${text}`); return rec.on; };
  live.onRecord = (l) => { listeners.add(l); return () => listeners.delete(l); };
  live.recordFile = async (_project, _id, file) => {
    w.calls.push(`recordFile ${file}`);
    if (file === 'clip') return w.clip;
    const b = box();
    return png(Math.round(b.width), Math.round(b.height), 'image/jpeg');
  };
  live.recordReveal = async () => { w.calls.push('recordReveal'); return true; };
  live.recordDelete = async () => { w.calls.push('recordDelete'); return true; };

  // What the note composer hands the core, kept for the sweep (the core still gets it: the demo's own).
  const call = window.wanigan.call.bind(window.wanigan);
  window.wanigan.call = (method, params) => {
    if (method === 'attachments.save') w.sent.push({ method, name: params.name, data: params.data, session: params.to?.session ?? null });
    // No agent session running here (`noAgents`): the composer offers to start one on the note.
    if (method === 'sessions.list' && params?.live && w.noAgents) return Promise.resolve([]);
    if (method === 'sessions.start') {
      return call(method, params).then((s) => { w.sent.push({ method, provider: params.provider, projectId: params.projectId, session: s.id }); return s; });
    }
    if (method === 'sessions.queue') {
      const sent = { method, session: params.id, text: params.text, attachments: params.attachments.length, queued: null };
      w.sent.push(sent);
      // The core's own answer: how many messages wait for that session now.
      return call(method, params).then((r) => { sent.queued = r.queued; return r; });
    }
    return call(method, params);
  };
}
