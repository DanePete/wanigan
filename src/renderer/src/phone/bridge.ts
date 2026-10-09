// `window.wanigan` on a phone: the same shape the desktop app's preload gives,
// over the gateway's HTTP API, so the shared API client, queries and terminal
// work unchanged. Requests carry this phone's token; events arrive on one
// stream, which follows the terminals being watched.
import type { CoreStatus, WaniganBridge } from '@shared/bridge';

const TOKEN = 'wanigan.phone.token';
const RETRY_MS = [1_000, 2_000, 5_000, 10_000];
// One active request plus waiting input, measured as the serialized UTF-8 body.
// The gateway accepts at most 256 KiB in a request; this also caps all retained
// input together. Other RPCs do not wait behind terminal keystrokes.
const MAX_INPUT_CALLS = 128;
const MAX_INPUT_BYTES = 256 * 1024;
interface Input {
  body: string;
  bytes: number;
  token: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  controller: AbortController;
}

export class PhoneLink {
  private token: string | null;
  private status: CoreStatus = 'connecting';
  private readonly listeners = new Set<(event: string, data: unknown) => void>();
  private readonly statusListeners = new Set<(s: CoreStatus) => void>();
  private readonly watched = new Map<string, number>();
  private stream: AbortController | null = null;
  private attempt = 0;
  private readonly inputQueue: Input[] = [];
  private activeInput: Input | null = null;
  private inputBytes = 0;
  private inputStopped: Error | null = null;
  /** Called when the Mac says this phone is not paired (forgotten, or never). */
  onUnpaired: () => void = () => {};

  constructor() {
    this.token = read();
  }

  get paired(): boolean {
    return !!this.token;
  }

  /** Pair with the code shown on the Mac; keeps the token for every later visit. */
  async pair(code: string, name: string): Promise<void> {
    const res = await fetch('api/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, name }) });
    const reply = await res.json() as { ok: boolean; result?: { token: string }; error?: { message: string } };
    if (!reply.ok || !reply.result) throw new Error(reply.error?.message ?? 'Pairing failed.');
    if (this.activeInput || this.inputQueue.length) this.stopInput('Pairing changed while keys were waiting.');
    this.token = reply.result.token;
    try { localStorage.setItem(TOKEN, this.token); } catch { /* kept for this visit only */ }
    void this.connect();
  }

  /** Forget this phone's token here (the Mac forgets it in Settings › Phone). */
  unpair(): void {
    if (this.activeInput || this.inputQueue.length) this.stopInput('This phone was unpaired while keys were waiting.');
    this.token = null;
    try { localStorage.removeItem(TOKEN); } catch { /* nothing kept */ }
    this.stream?.abort();
    this.onUnpaired();
  }

  async rpc(method: string, params: unknown): Promise<unknown> {
    if (method === 'sessions.input') return this.input(params);
    const id = (params as { id?: unknown } | null)?.id;
    // A terminal's output stream is open before its replay is read, so nothing
    // falls between the two; the terminal drops what it already has, by sequence.
    if (method === 'sessions.watch' && typeof id === 'string') await this.follow(id, 1);
    return this.post(JSON.stringify({ method, params }), this.token ?? '', undefined, () => {
      if (method === 'sessions.unwatch' && typeof id === 'string') void this.follow(id, -1);
    });
  }

  private async post(body: string, token: string, signal?: AbortSignal, afterReply?: () => void): Promise<unknown> {
    const res = await fetch('api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body, signal,
    });
    const reply = await res.json() as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    if (res.status === 401) this.unpair();
    afterReply?.();
    if (!reply.ok) throw Object.assign(new Error(reply.error?.message ?? `The Mac answered ${res.status}.`), { code: reply.error?.code ?? 'internal' });
    return reply.result;
  }

  /** Keyboard, paste and extra keys share one ordered path, including Enter. */
  private input(params: unknown): Promise<unknown> {
    if (this.inputStopped) return Promise.reject(this.inputStopped);
    const token = this.token;
    if (!token) return Promise.reject(this.stopInput('This phone is not paired.'));
    if (this.inputQueue.length + (this.activeInput ? 1 : 0) >= MAX_INPUT_CALLS) {
      return Promise.reject(this.stopInput('Too many keys are waiting for the Mac.'));
    }
    let body: string;
    try { body = JSON.stringify({ method: 'sessions.input', params }); }
    catch { return Promise.reject(this.stopInput('The input could not be sent.')); }
    const bytes = new TextEncoder().encode(body).byteLength;
    // Serialization may invoke a caller's toJSON. Recheck admission after it.
    if (this.inputStopped) return Promise.reject(this.inputStopped);
    if (this.token !== token || this.inputQueue.length + (this.activeInput ? 1 : 0) >= MAX_INPUT_CALLS || this.inputBytes + bytes > MAX_INPUT_BYTES) {
      return Promise.reject(this.stopInput('Too much input is waiting for the Mac.'));
    }
    return new Promise((resolve, reject) => {
      this.inputQueue.push({ body, bytes, token, resolve, reject, controller: new AbortController() });
      this.inputBytes += bytes;
      this.sendInput();
    });
  }

  private sendInput(): void {
    if (this.activeInput || this.inputStopped) return;
    const input = this.inputQueue.shift();
    if (!input) return;
    this.activeInput = input;
    if (input.token !== this.token) { this.stopInput('Pairing changed while keys were waiting.'); return; }
    // Never retry: a lost response can still mean the terminal received a key.
    void this.post(input.body, input.token, input.controller.signal).then(
      (result) => {
        if (this.activeInput !== input) return;
        this.activeInput = null;
        this.inputBytes -= input.bytes;
        input.resolve(result);
        this.sendInput();
      },
      (error: unknown) => { this.stopInput(error instanceof Error ? error.message : 'The Mac did not confirm the input.'); },
    );
    input.body = ''; // fetch owns the active body; only waiting bodies stay here.
  }

  private stopInput(reason: string): Error {
    this.inputStopped ??= new Error(`${reason} Terminal input is paused. Earlier keys may already have reached the session. Review the terminal on your Mac, then reload this page before typing again.`);
    const stopped = this.inputQueue.splice(0);
    if (this.activeInput) stopped.push(this.activeInput);
    this.activeInput = null;
    this.inputBytes = 0;
    for (const input of stopped) {
      input.body = '';
      input.controller.abort();
      input.reject(this.inputStopped);
    }
    return this.inputStopped;
  }

  /** Open (or reopen) the event stream, following the terminals being watched. Resolves once it is open. */
  connect(): Promise<void> {
    if (!this.token) return Promise.resolve();
    this.stream?.abort();
    const controller = new AbortController();
    this.stream = controller;
    const watch = [...this.watched.keys()].join(',');
    let opened: () => void = () => {};
    const open = new Promise<void>((resolve) => { opened = resolve; });
    void fetch(`api/events${watch ? `?watch=${encodeURIComponent(watch)}` : ''}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: controller.signal })
      .then(async (res) => {
        if (res.status === 401) { this.unpair(); return; }
        if (!res.ok || !res.body) throw new Error(`events ${res.status}`);
        this.attempt = 0;
        this.setStatus('connected');
        opened();
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let end: number;
          while ((end = buffer.indexOf('\n\n')) >= 0) {
            const chunk = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!chunk.startsWith('data: ')) continue;
            const { event, data } = JSON.parse(chunk.slice(6)) as { event: string; data: unknown };
            for (const l of this.listeners) l(event, data);
          }
        }
        throw new Error('the stream ended');
      })
      .catch(() => {
        opened();
        if (controller.signal.aborted || this.stream !== controller) return;
        this.setStatus('connecting');
        const wait = RETRY_MS[Math.min(this.attempt++, RETRY_MS.length - 1)]!;
        if (this.attempt > RETRY_MS.length) this.setStatus('unavailable');
        setTimeout(() => { if (this.stream === controller) void this.connect(); }, wait);
      });
    return open;
  }

  bridge(): WaniganBridge {
    const none = async () => null;
    return {
      call: (method, params) => this.rpc(method, params) as never,
      on: (listener) => { this.listeners.add(listener as never); return () => { this.listeners.delete(listener as never); }; },
      status: async () => this.status,
      onStatus: (l) => { this.statusListeners.add(l); return () => { this.statusListeners.delete(l); }; },
      coreProblem: none,
      onCoreProblem: () => () => {},
      coreAction: async () => {},
      pickFolder: none,
      openDemo: async () => false,
      pickFiles: none,
      openPath: async () => {},
      onNavigate: () => () => {},
      onAlerts: () => () => {},
      alertsSeen: async () => {},
      alertsDismissed: async () => {},
      onCommand: () => () => {},
      appState: none,
      setSettings: none,
      checkForUpdates: none,
      openUpdate: async () => {},
      onAppState: () => () => {},
      platform: 'phone',
    };
  }

  private follow(id: string, change: 1 | -1): Promise<void> {
    const n = (this.watched.get(id) ?? 0) + change;
    if (n > 0) this.watched.set(id, n); else this.watched.delete(id);
    return this.connect();
  }

  private setStatus(status: CoreStatus): void {
    if (status === this.status) return;
    this.status = status;
    for (const l of this.statusListeners) l(status);
  }
}

function read(): string | null {
  try { return localStorage.getItem(TOKEN); } catch { return null; }
}
