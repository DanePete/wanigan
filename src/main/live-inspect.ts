// The live view's deeper side, built on the view in live-view.ts: the site
// helper's trace of the page shown (which code made each part, its hooks,
// cache, cost and data, and what can be edited there), lenses painted over the
// page, and editing in place. The contract with the helpers is
// src/shared/live-trace.ts.
//
// - A page the helper rendered for the view says `X-Wanigan-Trace: <id>`. Only
//   the view's own main-frame responses from the site it shows are read.
// - The trace, the site's own edit forms and schema saves are asked of the
//   site's origin, through the view's session (so as the user logged in
//   there), with the helper's token. Nothing is asked of any other origin, and
//   the token goes nowhere else.
// - A native form opens in a small view of its own in the same session, laid
//   over the sheet the window draws beside the part. When the site redirects
//   it to /_wanigan/edit/done, it closes and the page reloads with the change.
// - A schema save is checked here against the schema the trace gave before it
//   is posted; the helper checks it again and is the authority.
// - Moving parts by hand (live-arrange.ts): the page script shows handles and
//   where a drag would land, and answers a drop; a move or an insert is checked
//   against the trace here, posted to the helper, and its undo token kept, so
//   only an undo the site gave can be asked for.
import { WebContentsView, ipcMain, type BrowserWindow, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import type { LiveBounds } from '../shared/bridge.ts';
import { sameSite } from '../shared/live.ts';
import { boxOf, paintItems, type LiveEditSaved, type LiveEdited, type LiveTraceAnswer } from '../shared/live-lens.ts';
import { arrangeDrop, arrangeSpec, checkInsert, checkMove, undoToken, type ArrangeDrop, type LiveMoveSaved } from '../shared/live-arrange.ts';
import { checkValue } from '../shared/live-schema.ts';
import { TRACE_ID, parseTrace, type EditTarget, type LiveTrace } from '../shared/live-trace.ts';
import type { LiveCurrent, LiveViewHooks } from './live-view.ts';

/** Past these, an answer is not read: a trace is bounded by the helper, and a save's answer is a line. */
const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_ANSWER_BYTES = 64 * 1024;
const MAX_VALUE_BYTES = 64 * 1024;
const FETCH_MS = 15_000;

type Rect = { x: number; y: number; width: number; height: number };

/** A response header, whatever case the server wrote it in. */
function header(headers: Record<string, string[]> | undefined, name: string): string | null {
  if (!headers) return null;
  for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === name) return v[0]?.trim() ?? null;
  return null;
}

class TooLarge extends Error {}

/** A response's body as text, refused past `max` bytes rather than read whole. */
async function readBounded(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > max) throw new TooLarge();
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) { await reader.cancel().catch(() => {}); throw new TooLarge(); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function wireLiveInspect(options: {
  window: () => BrowserWindow | null;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  /** Whether the owner has the live view switched on. */
  enabled: () => boolean;
  /** The live view as it is now (live-view.ts). */
  current: () => LiveCurrent | null;
  /** Run code in the page script's isolated world (live-view.ts). */
  run: <T>(code: string, fallback: T) => Promise<T>;
}): { hooks: LiveViewHooks } {
  /** The view's last page as the site sent it: where from, and its trace id (null when it sent none). */
  let latest: { webContentsId: number; url: string; id: string | null } | null = null;
  /** The last trace read for the view: what edit targets are checked against. */
  let held: { projectId: string; webContentsId: number; origin: string; trace: LiveTrace } | null = null;
  /** A lens is painted: Escape in the page takes it away. */
  let painting = false;
  /** The sheet showing a site's own edit form. */
  let editing: { view: WebContentsView; target: EditTarget } | null = null;
  /** Undo tokens the site gave for moves and inserts in this view, newest last. */
  let undos: string[] = [];

  const ok = (event: IpcMainInvokeEvent): boolean => options.trusted(event) && options.enabled();
  const tell = (channel: string, payload: unknown): void => {
    const w = options.window();
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  };

  const closeEdit = (): void => {
    const e = editing;
    editing = null;
    if (!e) return;
    const w = options.window();
    if (w && !w.isDestroyed()) w.contentView.removeChildView(e.view);
    if (!e.view.webContents.isDestroyed()) e.view.webContents.close();
  };

  const hooks: LiveViewHooks = {
    session(ses: Session) {
      // Read, never changed: the site's answer to the view's own page load says which render's trace it is.
      ses.webRequest.onResponseStarted((details) => {
        const cur = options.current();
        if (!cur || details.resourceType !== 'mainFrame' || details.webContentsId !== cur.webContents.id || !sameSite(cur.base, details.url)) return;
        const id = header(details.responseHeaders, 'x-wanigan-trace');
        latest = { webContentsId: cur.webContents.id, url: details.url, id: id && TRACE_ID.test(id) ? id : null };
      });
    },
    view(wc: WebContents | null) {
      closeEdit();
      latest = null;
      held = null;
      painting = false;
      undos = [];
      if (!wc) return;
      // Escape in the page, while a lens is on, takes the lens away; the page still hears it.
      wc.on('before-input-event', (_e, input) => {
        if (painting && input.type === 'keyDown' && input.key === 'Escape') tell('live:key', 'Escape');
      });
    },
  };

  /** The site's helper, asked as the view's user with the token. Only ever the origin the view's page came from. */
  const ask = async (cur: LiveCurrent, origin: string, path: string, init: { method?: 'GET' | 'POST'; body?: string } = {}): Promise<Response> => {
    if (!cur.token || !sameSite(cur.base, origin)) throw new Error('not this site');
    return cur.webContents.session.fetch(`${origin}${path}`, {
      method: init.method ?? 'GET',
      credentials: 'include',
      // A helper never redirects these; following one could take the token somewhere else.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_MS),
      headers: { 'X-Wanigan-Live': cur.token, Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(init.body ? { body: init.body } : {}),
    });
  };

  /** Post JSON to the helper and read its short JSON answer; the status is 0 when nothing answered. */
  const post = async (cur: LiveCurrent, origin: string, path: string, payload: unknown): Promise<{ status: number; answer: Record<string, unknown> | null; error: string | null }> => {
    let status = 0;
    try {
      const res = await ask(cur, origin, path, { method: 'POST', body: JSON.stringify(payload) });
      status = res.status;
      const parsed = JSON.parse(await readBounded(res, MAX_ANSWER_BYTES)) as unknown;
      return { status, answer: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null, error: null };
    } catch (error) {
      return { status, answer: null, error: (error as Error).message || 'no answer' };
    }
  };

  /** The trace the view holds now, if it is for the page shown. */
  const holding = (): { cur: LiveCurrent; origin: string; trace: LiveTrace } | null => {
    const cur = options.current();
    const h = held;
    return cur && h && h.projectId === cur.projectId && h.webContentsId === cur.webContents.id ? { cur, origin: h.origin, trace: h.trace } : null;
  };

  /** What a move, an insert or an undo came to, from the helper's answer. A 409 is the collection having changed meanwhile. */
  const moved = (cur: LiveCurrent, r: { status: number; answer: Record<string, unknown> | null; error: string | null }): LiveMoveSaved => {
    if (r.answer?.ok === true) {
      const undo = undoToken(r.answer.undo);
      if (undo) undos = [...undos.filter((u) => u !== undo), undo].slice(-50);
      if (!cur.webContents.isDestroyed()) cur.webContents.reloadIgnoringCache();
      return { ok: true, undo, revision: typeof r.answer.revision === 'string' ? r.answer.revision.slice(0, 100) : null };
    }
    const items = Array.isArray(r.answer?.items) ? (r.answer.items as unknown[]).filter((i): i is string => typeof i === 'string').slice(0, 4000) : null;
    if (r.status === 409) {
      // What the page shows is out of date: show the order as it is now.
      if (!cur.webContents.isDestroyed()) cur.webContents.reloadIgnoringCache();
      return { ok: false, conflict: true, items, error: 'It changed on the site since this page was shown, so nothing was moved. The page now shows the order as it is.' };
    }
    const said = typeof r.answer?.error === 'string' ? r.answer.error.slice(0, 500) : null;
    return {
      ok: false, conflict: false, items: null,
      error: said ?? (r.status === 0 ? `The site did not answer: ${r.error ?? 'no answer'}.`
        : r.status === 403 ? 'The site refused: the user logged in in the live view may not change this.'
          : `The site did not save it (it answered ${r.status}).`),
    };
  };

  ipcMain.handle('live:trace', async (event): Promise<LiveTraceAnswer> => {
    if (!ok(event)) return { state: 'none' };
    const cur = options.current();
    const page = cur?.webContents.getURL();
    if (!cur || !page || !sameSite(cur.base, page)) return { state: 'none' };
    if (!cur.token) return { state: 'no-helper' };
    if (!latest || latest.webContentsId !== cur.webContents.id || !latest.id) return { state: 'missing' };
    const { id, url } = latest;
    const origin = new URL(url).origin;
    let text: string;
    let res: Response;
    try {
      res = await ask(cur, origin, `/_wanigan/trace/${id}`);
      if (res.status === 404) return { state: 'expired' };
      if (res.status === 401 || res.status === 403) return { state: 'refused', status: res.status };
      if (!res.ok) return { state: 'down', error: `it answered ${res.status}` };
      text = await readBounded(res, MAX_TRACE_BYTES);
    } catch (error) {
      if (error instanceof TooLarge) return { state: 'too-large' };
      return { state: 'down', error: (error as Error).message || 'no answer' };
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return { state: 'unreadable', version: null }; }
    const trace = parseTrace(raw);
    // A trace for another render is not this page's, however well formed.
    if (!trace || trace.id !== id) {
      const version = raw && typeof raw === 'object' && typeof (raw as { version?: unknown }).version === 'number' ? (raw as { version: number }).version : null;
      return { state: 'unreadable', version };
    }
    held = { projectId: cur.projectId, webContentsId: cur.webContents.id, origin, trace };
    return { state: 'ok', trace };
  });

  ipcMain.handle('live:paint', async (event, raw: unknown) => {
    if (!ok(event)) return 0;
    const items = paintItems(raw);
    painting = items.length > 0;
    return options.run<number>(`window.__wl && window.__wl.paint ? window.__wl.paint(${JSON.stringify(items)}) : 0`, 0);
  });

  ipcMain.handle('live:where', async (event, index: unknown) => {
    if (!ok(event) || !Number.isInteger(index) || (index as number) < 0) return null;
    const r = await options.run<Rect | null>(`window.__wl && window.__wl.where ? window.__wl.where(${index as number}) : null`, null);
    return boxOf(r, 100_000);
  });

  /** The edit target the window named, if the trace the view holds offers it by that route. */
  const target = (raw: unknown, via: EditTarget['via']): { cur: LiveCurrent; origin: string; trace: LiveTrace; target: EditTarget } | string => {
    const cur = options.current();
    const h = held;
    if (!cur || !h || h.projectId !== cur.projectId || h.webContentsId !== cur.webContents.id) return 'There is no trace for this page yet. Reload it, then try again.';
    const t = typeof raw === 'string' ? h.trace.edits.find((e) => e.id === raw) : undefined;
    if (!t) return 'This page’s trace offers no such edit. Reload it, then try again.';
    if (t.why) return t.why;
    if (t.via !== via) return via === 'schema' ? 'That edit is made in the site’s own form.' : 'That edit is made here, not in a form.';
    return { cur, origin: h.origin, trace: h.trace, target: t };
  };

  ipcMain.handle('live:editOpen', async (event, rawTarget: unknown, rawBounds: unknown) => {
    if (!ok(event)) return { ok: false, error: 'The live view is off.' };
    const found = target(rawTarget, 'native-form');
    if (typeof found === 'string') return { ok: false, error: found };
    const b = boxOf(rawBounds);
    const w = options.window();
    if (!b || !w || w.isDestroyed()) return { ok: false, error: 'There is nowhere to show the form.' };
    closeEdit();
    const { cur, origin, trace, target: t } = found;
    const view = new WebContentsView({
      webPreferences: { session: cur.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, spellcheck: true },
    });
    const wc = view.webContents;
    editing = { view, target: t };
    const isDone = (u: string): boolean => {
      try { return sameSite(cur.base, u) && new URL(u).pathname === '/_wanigan/edit/done'; } catch { return false; }
    };
    const finish = (saved: boolean, error: string | null = null): void => {
      if (editing?.view !== view) return;
      closeEdit();
      tell('live:edited', { target: t.id, label: t.label, saved, error } satisfies LiveEdited);
      // Past the browser's cache: the page shows what the site saved, at once.
      if (saved && !cur.webContents.isDestroyed()) cur.webContents.reloadIgnoringCache();
    };
    // The form stays on the site; done is the site saying it saved.
    const guard = (e: { preventDefault(): void }, u: string): void => {
      if (isDone(u)) { e.preventDefault(); finish(true); return; }
      if (!sameSite(cur.base, u)) e.preventDefault();
    };
    wc.on('will-navigate', guard);
    wc.on('will-redirect', guard);
    wc.on('did-navigate', (_e, u) => { if (isDone(u)) finish(true); });
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    wc.on('did-fail-load', (_e, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) finish(false, `The site did not open the form (${description}).`);
    });
    w.contentView.addChildView(view);
    view.setBounds(b);
    // The token rides on the view's own page loads to the site (live-view.ts), this one's included.
    void wc.loadURL(`${origin}/_wanigan/edit/${encodeURIComponent(t.id)}?trace=${trace.id}`).catch(() => {});
    wc.focus();
    return { ok: true, error: null };
  });

  ipcMain.on('live:editBounds', (event, rawBounds: unknown) => {
    if (!options.trusted(event as unknown as IpcMainInvokeEvent)) return;
    const b = boxOf(rawBounds as LiveBounds);
    if (b && editing) editing.view.setBounds(b);
  });

  ipcMain.handle('live:editClose', (event) => { if (options.trusted(event)) closeEdit(); });

  ipcMain.handle('live:editSave', async (event, rawTarget: unknown, rawValue: unknown): Promise<LiveEditSaved> => {
    if (!ok(event)) return { ok: false, error: 'The live view is off.', revision: null };
    const found = target(rawTarget, 'schema');
    if (typeof found === 'string') return { ok: false, error: found, revision: null };
    const { cur, origin, trace, target: t } = found;
    let body: string;
    try { body = JSON.stringify({ trace: trace.id, value: rawValue ?? null }); } catch { return { ok: false, error: 'That value cannot be sent.', revision: null }; }
    if (body.length > MAX_VALUE_BYTES) return { ok: false, error: 'That value is too large to save here.', revision: null };
    const wrong = checkValue(t.schema, rawValue);
    if (wrong.length) return { ok: false, error: wrong.join(' '), revision: null };
    type Answer = { ok?: unknown; error?: unknown; revision?: unknown };
    let answer: Answer | null = null;
    let status = 0;
    try {
      const res = await ask(cur, origin, `/_wanigan/edit/${encodeURIComponent(t.id)}`, { method: 'POST', body });
      status = res.status;
      answer = JSON.parse(await readBounded(res, MAX_ANSWER_BYTES)) as Answer | null;
    } catch (error) {
      if (!status) return { ok: false, error: `The site did not answer: ${(error as Error).message || 'no answer'}.`, revision: null };
    }
    const said: Answer | null = answer && typeof answer === 'object' ? answer : null;
    if (said?.ok === true) {
      if (!cur.webContents.isDestroyed()) cur.webContents.reloadIgnoringCache();
      return { ok: true, error: null, revision: typeof said.revision === 'string' ? said.revision.slice(0, 100) : null };
    }
    const why = typeof said?.error === 'string' ? said.error.slice(0, 500)
      : status === 403 ? 'The site refused: the user logged in in the live view may not edit this.'
        : status === 404 ? 'The site no longer offers this edit. Reload the page, then try again.'
          : `The site did not save it (it answered ${status}).`;
    return { ok: false, error: why, revision: null };
  });

  // Arranging: the page shows handles and where a drag would land; this answers when something is dropped.
  ipcMain.handle('live:arrange', async (event, raw: unknown): Promise<ArrangeDrop | null> => {
    if (!ok(event)) return null;
    const spec = arrangeSpec(raw);
    if (!spec) return null;
    return arrangeDrop(await options.run<unknown>(`window.__wl && window.__wl.arrange ? window.__wl.arrange(${JSON.stringify(spec)}) : null`, null));
  });
  ipcMain.handle('live:disarm', async (event) => { if (options.trusted(event)) await options.run('window.__wl && window.__wl.disarm && window.__wl.disarm()', null); });

  // A new order shown on the page before it is saved (the keyboard's moves), and taking it away.
  ipcMain.handle('live:preview', async (event, item: unknown, ref: unknown, place: unknown) => {
    const n = (v: unknown): number | null => (Number.isInteger(v) && (v as number) >= 0 ? v as number : null);
    if (!ok(event) || n(item) === null || n(ref) === null || (place !== 'before' && place !== 'after' && place !== 'into')) return false;
    return options.run<boolean>(`window.__wl && window.__wl.preview ? window.__wl.preview(${n(item)}, ${n(ref)}, ${JSON.stringify(place)}) : false`, false);
  });
  ipcMain.handle('live:unpreview', async (event) => { if (options.trusted(event)) await options.run('window.__wl && window.__wl.unpreview && window.__wl.unpreview()', null); });

  ipcMain.handle('live:move', async (event, raw: unknown): Promise<LiveMoveSaved> => {
    const refused = (error: string): LiveMoveSaved => ({ ok: false, error, conflict: false, items: null });
    if (!ok(event)) return refused('The live view is off.');
    const h = holding();
    if (!h) return refused('There is no trace for this page yet. Reload it, then try again.');
    const move = checkMove(h.trace, raw);
    if (typeof move === 'string') return refused(move);
    return moved(h.cur, await post(h.cur, h.origin, '/_wanigan/move', { trace: h.trace.id, ...move }));
  });

  ipcMain.handle('live:insert', async (event, raw: unknown): Promise<LiveMoveSaved> => {
    const refused = (error: string): LiveMoveSaved => ({ ok: false, error, conflict: false, items: null });
    if (!ok(event)) return refused('The live view is off.');
    const h = holding();
    if (!h) return refused('There is no trace for this page yet. Reload it, then try again.');
    const insert = checkInsert(h.trace, raw);
    if (typeof insert === 'string') return refused(insert);
    return moved(h.cur, await post(h.cur, h.origin, '/_wanigan/insert', { trace: h.trace.id, ...insert }));
  });

  ipcMain.handle('live:undo', async (event, raw: unknown): Promise<LiveMoveSaved> => {
    const refused = (error: string): LiveMoveSaved => ({ ok: false, error, conflict: false, items: null });
    if (!ok(event)) return refused('The live view is off.');
    const token = undoToken(raw);
    const cur = options.current();
    const page = cur?.webContents.getURL();
    // Only an undo this view was given by this site, asked of the site the page is on.
    if (!token || !undos.includes(token) || !cur || !page || !sameSite(cur.base, page)) return refused('That can no longer be undone here.');
    const result = moved(cur, await post(cur, new URL(page).origin, '/_wanigan/undo', { undo: token }));
    if (result.ok) undos = undos.filter((u) => u !== token);
    return result.ok || !result.conflict ? result : { ...result, error: 'It changed on the site since, so it was not put back. The page now shows it as it is.' };
  });

  return { hooks };
}
