// What the UI sweep and the crawler share: a real core seeded with the demo,
// serving the built renderer (scripts/ui-gateway.ts), and `window.wanigan`
// bridged to it over HTTP in the page. Test-only; never shipped.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const electron = require('electron');

/**
 * Start a gateway on a free port and wait for its address. `demo` runs the core
 * as the real demo does, so what would leave the machine (signing in, a
 * terminal in the home folder) is refused with the demo's own words.
 */
export async function startGateway({ demo = false, quiet = false, label = 'gateway', phase = 'initial' } = {}) {
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  for (const k of Object.keys(env)) if (k.startsWith('VSCODE_')) delete env[k];
  const gateway = spawn(electron, [join(root, 'scripts/ui-gateway.ts'), ...(demo ? ['--demo'] : [])],
    { env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Keep draining after readiness; quiet suppresses relay, never failure capture.
  if (!quiet) gateway.stderr.pipe(process.stderr, { end: false });
  const base = await gatewayAddress(gateway, 30_000, { label, phase });
  return { base, gateway };
}

/** Wait for the disposable gateway to name its listening address. */
export function gatewayAddress(gateway, timeoutMs = 30_000, { label = 'gateway', phase = 'initial' } = {}) {
  return new Promise((resolveUrl, reject) => {
    const limit = 8192;
    let buf = '';
    let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
    let stdoutBytes = 0, stderrBytes = 0;
    let settled = false, exit = null, drainTimer;
    const tail = (prior, chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (bytes.length >= limit) return bytes.subarray(bytes.length - limit);
      return Buffer.concat([prior.subarray(Math.max(0, prior.length + bytes.length - limit)), bytes]);
    };
    const finish = (error, url) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      gateway.stdout.off('data', read);
      gateway.stderr?.off('data', readError);
      gateway.off('exit', exited);
      gateway.off('close', closed);
      gateway.off('error', failed);
      gateway.stdout.resume();
      gateway.stderr?.resume();
      if (error) {
        const diagnostic = {
          label, phase, pid: gateway.pid ?? null,
          code: exit?.code ?? gateway.exitCode ?? null,
          signal: exit?.signal ?? gateway.signalCode ?? null,
          stdout: stdout.toString(), stderr: stderr.toString(),
          stdoutTruncated: stdoutBytes > limit, stderrTruncated: stderrBytes > limit,
        };
        error.gatewayStartup = diagnostic;
        error.message += ` [${label}; ${phase}; pid ${diagnostic.pid}; code ${diagnostic.code}; signal ${diagnostic.signal}]`
          + (stdout.length ? `\nstdout tail${diagnostic.stdoutTruncated ? ' (truncated)' : ''}:\n${diagnostic.stdout}` : '')
          + (stderr.length ? `\nstderr tail${diagnostic.stderrTruncated ? ' (truncated)' : ''}:\n${diagnostic.stderr}` : '');
        gateway.kill('SIGTERM');
        reject(error);
      } else resolveUrl(url);
    };
    const read = (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk);
      stdout = tail(stdout, chunk);
      const text = String(chunk);
      if (buf.length + text.length > 65_536) { finish(new Error('gateway printed too much output before starting')); return; }
      buf += text;
      const match = buf.match(/(?:^|\n)gateway (http:\/\/\S+)\r?\n/);
      if (match && exit === null) finish(null, match[1]);
    };
    const readError = (chunk) => { stderrBytes += Buffer.byteLength(chunk); stderr = tail(stderr, chunk); };
    const exitError = () => new Error(`gateway exited ${exit?.code ?? gateway.exitCode} (signal ${exit?.signal ?? gateway.signalCode ?? 'none'})`);
    const exited = (code, signal) => {
      exit = { code, signal };
      // exit can precede the last pipe data; close drains it. Descendants must
      // not keep readiness waiting forever by inheriting one of those pipes.
      drainTimer = setTimeout(() => finish(exitError()), 250);
    };
    const closed = (code, signal) => { exit ??= { code, signal }; finish(exitError()); };
    const failed = (error) => finish(error);
    const timer = setTimeout(() => finish(exit ? exitError() : new Error('gateway did not start')), timeoutMs);
    gateway.stdout.on('data', read);
    gateway.stderr?.on('data', readError);
    gateway.once('exit', exited);
    gateway.once('close', closed);
    gateway.once('error', failed);
  });
}

export const BRIDGE = `
  (() => {
    const listeners = new Set();
    const es = new EventSource('/events');
    es.onmessage = (m) => { const { event, data } = JSON.parse(m.data); for (const l of listeners) l(event, data); };
    window.wanigan = {
      async call(method, params) {
        const r = await (await fetch('/rpc', { method: 'POST', body: JSON.stringify({ method, params }) })).json();
        if (!r.ok) throw Object.assign(new Error(r.error.message), { code: r.error.code });
        return r.result;
      },
      on(l) { listeners.add(l); return () => listeners.delete(l); },
      status: async () => 'connected',
      onStatus: () => () => {},
      // What is wrong with the core is the main process's to say; the sweep says it here.
      coreProblem: async () => window.__wgProblem,
      onCoreProblem(l) { problemListeners.add(l); return () => problemListeners.delete(l); },
      coreAction: async (action) => { window.__wgCoreActions.push(action); },
      pickFolder: async () => null,
      openDemo: async () => false,
      pickFiles: async () => null,
      openPath: async () => {},
      onNavigate: () => () => {},
      // The app's announcer lives in Electron's main process; here the sweep plays it.
      onAlerts(l) { alertListeners.add(l); return () => alertListeners.delete(l); },
      alertsSeen: async (keys) => { window.__wgAlertLog.seen.push(...keys); },
      alertsDismissed: async (keys) => { window.__wgAlertLog.dismissed.push(...keys); },
      // The app's own settings live in the main process too; the sweep keeps them in memory.
      appState: async () => window.__wgApp,
      setSettings: async (patch) => {
        window.__wgApp = { ...window.__wgApp, settings: { ...window.__wgApp.settings, ...patch } };
        window.__wgApp.awake = { ...window.__wgApp.awake, holding: window.__wgApp.settings.keepAwake && window.__wgApp.awake.live > 0 };
        // The main process tells every listener, not just the caller.
        window.__wgSetApp(window.__wgApp);
        return window.__wgApp;
      },
      // The update check is the main process's too: the sweep answers it, and logs what the window asked.
      checkForUpdates: async () => {
        window.__wgUpdateLog.push('check');
        window.__wgSetApp({ ...window.__wgApp, updates: window.__wgUpdateAnswer ?? { state: 'current', checkedAt: Date.now() } });
        return window.__wgApp;
      },
      openUpdate: async (which) => { window.__wgUpdateLog.push('open ' + which); },
      onAppState(l) { appListeners.add(l); return () => appListeners.delete(l); },
      // The app menu sends commands; the sweep plays the menu.
      onCommand(l) { commandListeners.add(l); return () => commandListeners.delete(l); },
      platform: 'darwin',
    };
    // Updates are answered and up to date, so the rail is calm everywhere but where the sweep looks at them.
    window.__wgApp = {
      settings: { keepAwake: true, notifications: 'all', updateChecks: 'daily' },
      awake: { holding: true, live: 4 },
      version: '2.0.0-alpha.2',
      updates: { state: 'current', checkedAt: Date.now() - 3 * 3600_000 },
    };
    window.__wgUpdateLog = [];
    window.__wgUpdateAnswer = null;
    // What the main process pushes when the app's state changes; the sweep plays it.
    const appListeners = new Set();
    window.__wgSetApp = (next) => { window.__wgApp = next; for (const l of appListeners) l(next); };
    const problemListeners = new Set();
    window.__wgProblem = null;
    window.__wgCoreActions = [];
    window.__wgCoreProblem = (p) => { window.__wgProblem = p; for (const l of problemListeners) l(p); };
    const alertListeners = new Set();
    const commandListeners = new Set();
    window.__wgCommand = (id) => { for (const l of commandListeners) l(id); };
    window.__wgAlertLog = { seen: [], dismissed: [] };
    window.__wgOfferAlerts = (needs) => { for (const l of alertListeners) l(needs); };
  })();`;
