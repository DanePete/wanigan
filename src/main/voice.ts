// Voice input, the main process's side: the owner's voice settings, the speech
// models (downloaded only on a click: voice-models.ts), the voice worker's life
// (forked on the first use, a model loaded, stopped after a minute and a half
// unused, when the window closes, or when it grows past its memory ceiling),
// the MessagePort each listening stream gets (audio never passes through this
// process), and who may use the microphone: Wanigan's own page in its own
// window, audio only.
// Design: docs/design/2026-10-10-voice-input.md.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import type { IpcMain, IpcMainInvokeEvent, MessagePortMain, Session, WebContents } from 'electron';
import {
  VOICE_DEFAULTS, VOICE_MODELS, cleanVoiceSettings, voiceModel,
  type MicAccess, type VoiceDownload, type VoiceEngineState, type VoiceModelId, type VoiceSettings, type VoiceStart, type VoiceState,
} from '../shared/voice.ts';
import { downloadModel, modelReady, removeModel } from './voice-models.ts';

/** What the host needs of a utilityProcess: Electron's, or a test's stand-in. */
export interface VoiceWorker {
  readonly pid?: number | undefined;
  postMessage(message: unknown, transfer?: MessagePortMain[]): void;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  kill(): boolean;
  stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
}

/** A port pair: Electron's MessageChannelMain, or a test's. */
export interface VoiceChannel { port1: MessagePortMain; port2: MessagePortMain }

/** Unused this long, the worker is stopped (and its model's memory given back). */
const IDLE_MS = 90_000;
/** The worker's memory is looked at this often while it runs. */
const WATCH_MS = 5_000;
/** The most memory the worker may use, by model: about twice what each peaked at in Phase 1. */
const MEMORY_CEILING: Record<VoiceModelId, number> = { fast: 1.5 * 1024 ** 3, accurate: 2.5 * 1024 ** 3 };

/** The OS's own page for the microphone, where there is one. */
export function micSettingsUrl(platform: string): string | null {
  if (platform === 'darwin') return 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone';
  if (platform === 'win32') return 'ms-settings:privacy-microphone';
  return null;
}

/**
 * Whether a permission request for media may be granted: only to Wanigan's own page (`own`), only for audio. Answers
 * null for any other permission, which keeps the answer the window has always had.
 */
export function mediaAllowed(permission: string, details: { mediaTypes?: readonly string[] }, own: boolean): boolean | null {
  if (permission !== 'media') return null;
  const types = details.mediaTypes ?? [];
  return own && types.length > 0 && types.every((t) => t === 'audio');
}

/**
 * The window's session answers the microphone for Wanigan's own page only, audio only. The live view's sites never
 * reach this: their sessions refuse every permission (live-view.ts).
 */
export function guardMicrophone(ses: Pick<Session, 'setPermissionRequestHandler' | 'setPermissionCheckHandler'>, own: (wc: WebContents | null, url: string) => boolean): void {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const d = details as { mediaTypes?: string[]; requestingUrl?: string };
    const allowed = mediaAllowed(permission, d, own(wc, d.requestingUrl ?? wc.getURL()));
    callback(allowed ?? true);
  });
  ses.setPermissionCheckHandler((wc, permission, _origin, details) => {
    if (permission !== 'media') return true;
    const type = (details as { mediaType?: string }).mediaType;
    return type !== 'video' && own(wc, wc?.getURL() ?? '');
  });
}

export interface VoiceWiring {
  /** The window went away: stop listening and the worker. */
  release(): void;
  /** For tests: the state now. */
  state(): VoiceState;
}

export function wireVoice(o: {
  ipc: Pick<IpcMain, 'handle'>;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  dataDir: string;
  /** The window's contents, to tell it of changes. */
  send: (channel: string, payload: unknown) => void;
  /** Fork the worker (Electron's utilityProcess.fork of out/main/voice-worker.js). */
  fork: () => VoiceWorker;
  channel: () => VoiceChannel;
  fetch: typeof fetch;
  micAccess: () => MicAccess;
  openExternal: (url: string) => Promise<unknown>;
  platform: string;
  /** The worker's memory in bytes, when the OS can say. */
  memory?: (pid: number) => number | null;
  idleMs?: number;
  watchMs?: number;
}): VoiceWiring {
  const folder = join(o.dataDir, 'voice');
  const root = join(folder, 'models');
  const settingsFile = join(folder, 'settings.json');
  let settings: VoiceSettings = (() => {
    try { return cleanVoiceSettings(JSON.parse(readFileSync(settingsFile, 'utf8'))); } catch { return { ...VOICE_DEFAULTS }; }
  })();
  const downloads = new Map<VoiceModelId, { download: VoiceDownload; abort: AbortController | null }>();
  let worker: VoiceWorker | null = null;
  let engine: VoiceEngineState = 'off';
  let engineError: string | null = null;
  let loaded: string | null = null;
  let loading: string | null = null;
  let stopping = false;
  let stderr = '';
  const streams = new Set<string>();
  let idle: ReturnType<typeof setTimeout> | null = null;
  let watch: ReturnType<typeof setInterval> | null = null;

  const state = (): VoiceState => ({
    settings: { ...settings },
    models: VOICE_MODELS.map((m) => ({ id: m.id, ready: modelReady(root, m), download: downloads.get(m.id)?.download ?? { state: 'idle' } })),
    engine, engineError,
    mic: o.micAccess(),
    micSettings: micSettingsUrl(o.platform) !== null,
    platform: o.platform,
  });
  const tell = (): void => o.send('voice:state', state());

  const stopWorker = (why: string | null = null): void => {
    if (idle) { clearTimeout(idle); idle = null; }
    if (watch) { clearInterval(watch); watch = null; }
    const w = worker;
    worker = null;
    loaded = null;
    loading = null;
    streams.clear();
    if (w) {
      stopping = true;
      try { w.postMessage({ type: 'stop' }); } catch { /* already gone */ }
      setTimeout(() => { try { w.kill(); } catch { /* gone */ } }, 2_000).unref?.();
    }
    engine = why ? 'failed' : 'off';
    engineError = why;
    tell();
  };

  const settle = (): void => {
    if (idle) clearTimeout(idle);
    idle = null;
    if (worker && streams.size === 0) {
      idle = setTimeout(() => stopWorker(), o.idleMs ?? IDLE_MS);
      (idle as { unref?: () => void }).unref?.();
    }
  };

  const ensureWorker = (): VoiceWorker => {
    if (worker) return worker;
    stopping = false;
    stderr = '';
    const w = o.fork();
    worker = w;
    engine = 'loading';
    engineError = null;
    w.stderr?.on('data', (chunk) => { stderr = `${stderr}${String(chunk)}`.slice(-2_000); });
    w.on('message', (raw) => {
      if (worker !== w || !raw || typeof raw !== 'object') return;
      const msg = raw as { type?: string; repo?: string; message?: string; id?: string };
      if (msg.type === 'loaded' && msg.repo === loading) { loaded = msg.repo; loading = null; engine = 'ready'; engineError = null; tell(); }
      else if (msg.type === 'load-failed') {
        loading = null;
        stopWorker(`The speech model could not be loaded: ${String(msg.message ?? 'no reason given').slice(0, 300)}. Remove it in Settings › Voice and download it again.`);
      } else if (msg.type === 'stream-done' && typeof msg.id === 'string') { streams.delete(msg.id); settle(); }
    });
    w.on('exit', (code) => {
      if (worker !== w) return;
      const expected = stopping;
      worker = null;
      if (watch) { clearInterval(watch); watch = null; }
      if (expected) return;
      const tail = stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300);
      stopWorker(`The speech engine stopped unexpectedly (exit code ${code})${tail ? `: ${tail}` : ''}.`);
    });
    if (o.memory) {
      watch = setInterval(() => {
        if (worker !== w || !w.pid) return;
        const bytes = o.memory?.(w.pid) ?? null;
        const model = VOICE_MODELS.find((m) => m.repo === (loaded ?? loading))?.id ?? settings.model;
        if (bytes !== null && bytes > MEMORY_CEILING[model]) {
          stopWorker(`The speech engine used ${(bytes / 1024 ** 3).toFixed(1)} GB of memory, more than it may, so it was stopped.`);
        }
      }, o.watchMs ?? WATCH_MS);
      (watch as { unref?: () => void }).unref?.();
    }
    return w;
  };

  const load = (w: VoiceWorker, repo: string): void => {
    if (loaded === repo || loading === repo) return;
    loading = repo;
    engine = 'loading';
    w.postMessage({ type: 'load', root, repo, threads: Math.max(1, Math.min(4, cpus().length - 1)) });
  };

  const start = (event: IpcMainInvokeEvent): VoiceStart => {
    const m = voiceModel(settings.model);
    if (!m || !modelReady(root, m)) return { ok: false, code: 'no-model', message: 'Voice input needs its speech model first.' };
    let w: VoiceWorker;
    try { w = ensureWorker(); } catch (e) {
      stopWorker(`The speech engine could not start: ${(e as Error).message}`);
      return { ok: false, code: 'engine', message: engineError ?? 'The speech engine could not start.' };
    }
    load(w, m.repo);
    if (idle) { clearTimeout(idle); idle = null; }
    const id = randomUUID();
    const { port1, port2 } = o.channel();
    w.postMessage({ type: 'stream', id, language: settings.language === 'auto' ? null : settings.language }, [port2]);
    event.sender.postMessage('voice:port', { id }, [port1]);
    streams.add(id);
    tell();
    return { ok: true, id };
  };

  const save = (): void => {
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(settingsFile, `${JSON.stringify(settings)}\n`, { mode: 0o600 });
  };

  const download = (id: VoiceModelId): void => {
    const m = voiceModel(id);
    if (!m || downloads.get(id)?.download.state === 'downloading') return;
    const abort = new AbortController();
    const entry: { download: VoiceDownload; abort: AbortController | null } = { download: { state: 'downloading', done: 0, total: 0 }, abort };
    downloads.set(id, entry);
    tell();
    void downloadModel(root, m, {
      fetch: o.fetch, signal: abort.signal,
      onProgress: (done, total) => { entry.download = { state: 'downloading', done, total }; tell(); },
    }).then(() => { downloads.delete(id); tell(); }, (e: Error) => {
      const was = entry.download;
      const done = was.state === 'idle' ? 0 : was.done;
      const total = was.state === 'idle' ? 0 : was.total;
      entry.abort = null;
      entry.download = abort.signal.aborted ? { state: 'failed', done, total, error: 'Stopped. Download carries on from where it stopped.' }
        : { state: 'failed', done, total, error: e.message || String(e) };
      tell();
    });
  };

  const ok = (event: IpcMainInvokeEvent): boolean => o.trusted(event);
  o.ipc.handle('voice:state', (event) => (ok(event) ? state() : null));
  o.ipc.handle('voice:setSettings', (event, patch: unknown) => {
    if (!ok(event)) return null;
    const next = cleanVoiceSettings(patch && typeof patch === 'object' ? { ...settings, ...(patch as object) } : settings, settings);
    settings = next;
    try { save(); } catch { /* kept for this launch */ }
    // A new model or language takes effect at the next press: the worker loads the model then, in place of the last.
    tell();
    return state();
  });
  o.ipc.handle('voice:download', (event, id: unknown) => { if (ok(event) && voiceModel(id)) download(id as VoiceModelId); return ok(event) ? state() : null; });
  o.ipc.handle('voice:cancel', (event, id: unknown) => {
    if (!ok(event)) return null;
    downloads.get(id as VoiceModelId)?.abort?.abort();
    return state();
  });
  o.ipc.handle('voice:remove', (event, id: unknown) => {
    if (!ok(event)) return null;
    const m = voiceModel(id);
    if (!m) return state();
    downloads.get(m.id)?.abort?.abort();
    downloads.delete(m.id);
    if (worker && (loaded === m.repo || loading === m.repo)) stopWorker();
    removeModel(root, m);
    tell();
    return state();
  });
  o.ipc.handle('voice:start', (event) => (ok(event) ? start(event) : { ok: false, code: 'engine', message: 'Untrusted sender.' }));
  o.ipc.handle('voice:openMicSettings', async (event) => {
    if (!ok(event)) return false;
    const url = micSettingsUrl(o.platform);
    if (!url) return false;
    await o.openExternal(url);
    return true;
  });

  return {
    release: () => { if (worker) stopWorker(); },
    state,
  };
}
