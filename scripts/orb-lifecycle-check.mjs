// Optional native WebGPU regression. Not part of GPU-less npm test/CI.
// Plan: node scripts/orb-lifecycle-check.mjs
// Run:  node scripts/orb-lifecycle-check.mjs --run --browser /absolute/path/to/chromium
// Uses a standalone renderer bundle, never Electron/Core or provider sessions.
// GPU calls remain native; holds delay result delivery, not native execution.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, readdirSync, lstatSync, realpathSync, mkdirSync,
  mkdtempSync, openSync, closeSync, rmSync, accessSync, constants } from 'node:fs';
import { join, extname, resolve, dirname, relative, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const self = realpathSync(fileURLToPath(import.meta.url));
const root = resolve(dirname(self), '..');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const HTML = `<!doctype html><html lang="en" data-theme="dark"><meta charset="utf-8">
<title>Orb lifecycle regression</title><style>
body { margin: 16px; background: #18202a; color: white; font: 14px sans-serif; }
main { display: flex; gap: 24px; } .host { width: 192px; height: 192px; }
canvas { display: block; width: 192px; height: 192px; }
</style><p>Isolated Orb lifecycle regression — real renderer; no app or core.</p>
<main id="canvases"></main><script type="module" src="/scripts/orb-lifecycle-probe.mjs"></script></html>`;

function sourceInventory() {
  const entries = [];
  function visit(path) {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, 'Source symlink refused: ' + path);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name));
    else {
      assert.ok(stat.isFile(), 'Only regular source files are supported');
      const bytes = readFileSync(path);
      entries.push({ path: relative(root, path), bytes: bytes.length, sha256: sha(bytes) });
    }
  }
  for (const name of ['.nvmrc', 'package.json', 'package-lock.json', 'src/renderer/src/orb',
    'scripts/orb-lifecycle-probe.mjs', 'scripts/orb-lifecycle-check.mjs']) visit(join(root, name));
  return entries;
}
function directory(path) {
  try {
    const stat = lstatSync(path);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'Artifact directory must be ordinary');
    assert.equal(realpathSync(path), resolve(path), 'Artifact ancestor symlink refused');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Validate each ancestor before allocation, including an existing .artifacts.
  directory(dirname(path));
  mkdirSync(path, { mode: 0o700 });
}
function sealedEnvironment(state) {
  const env = {
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':'),
    HOME: join(state, 'home'), ZDOTDIR: join(state, 'home'), TMPDIR: join(state, 'tmp'),
    XDG_CONFIG_HOME: join(state, 'config'), XDG_CACHE_HOME: join(state, 'cache'),
    XDG_DATA_HOME: join(state, 'data'), XDG_STATE_HOME: join(state, 'state'),
    USER: 'wanigan-orb-test', LOGNAME: 'wanigan-orb-test', LANG: 'C', LC_ALL: 'C', TZ: 'UTC',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0', NODE_DISABLE_COMPILE_CACHE: '1', CI: '1', BROWSER: 'none',
  };
  for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) directory(env[key]);
  return env;
}
async function launch(browserArgument) {
  assert.ok(isAbsolute(browserArgument), 'Supply an explicit absolute Chromium executable; no browser install or discovery occurs');
  const browserPath = realpathSync(browserArgument);
  assert.ok(lstatSync(browserPath).isFile()); accessSync(browserPath, constants.X_OK);
  const before = sourceInventory();
  const runs = join(root, '.artifacts', 'orb-lifecycle'); directory(runs);
  const output = mkdtempSync(join(runs, 'run-'));
  const state = join(output, 'environment'); directory(state);
  const env = sealedEnvironment(state);
  writeFileSync(join(output, 'source-before.json'), JSON.stringify(before, null, 2) + '\n', { flag: 'wx' });
  const log = join(output, 'run.log'), fd = openSync(log, 'wx', 0o600);
  const child = spawn(process.execPath, [self, '--worker', output, browserPath], {
    cwd: root, env, detached: true, stdio: ['ignore', fd, fd, 'ipc'],
  }); closeSync(fd);
  const receipt = { output, pid: child.pid, log, browserPath, browserSha256: sha(readFileSync(browserPath)),
    startedAt: new Date().toISOString(), envKeys: Object.keys(env), ownedBrowserPid: null,
    browserClosed: false, interrupted: null, timedOut: false, environmentRemoved: false };
  const record = () => writeFileSync(join(output, 'launcher.json'), JSON.stringify(receipt, null, 2) + '\n');
  let forceTimer;
  function killGroup(pid, signal) {
    if (pid) try { process.kill(-pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  function stop(reason) {
    if (receipt.interrupted) return;
    receipt.interrupted = reason; killGroup(child.pid, 'SIGTERM'); record();
    forceTimer = setTimeout(() => {
      receipt.forcedCleanup = true;
      // Only IDs from this invocation; never discover/kill applications by name.
      if (!receipt.browserClosed) killGroup(receipt.ownedBrowserPid, 'SIGKILL');
      killGroup(child.pid, 'SIGKILL'); record();
    }, 40000);
  }
  const onInt = () => stop('SIGINT'), onTerm = () => stop('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  child.on('message', message => {
    if (Number.isSafeInteger(message?.ownedBrowserPid) && message.ownedBrowserPid > 1) {
      if (receipt.ownedBrowserPid !== null) { stop('Duplicate browser owner message'); return; }
      receipt.ownedBrowserPid = message.ownedBrowserPid;
    }
    if (message?.ownedBrowserClosed === true) receipt.browserClosed = true;
    record();
  });
  const watchdog = setTimeout(() => { receipt.timedOut = true; stop('Worker exceeded 300 seconds'); }, 300000);
  record(); console.log(JSON.stringify({ output, pid: child.pid, log }));
  const ended = await new Promise(resolve => {
    child.once('error', error => resolve({ exitCode: 1, error: String(error) }));
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(watchdog); clearTimeout(forceTimer); process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  Object.assign(receipt, ended, { finishedAt: new Date().toISOString(), logSha256: sha(readFileSync(log)) });
  if (receipt.ownedBrowserPid && !receipt.browserClosed) {
    killGroup(receipt.ownedBrowserPid, 'SIGKILL'); receipt.browserFallbackKilled = true;
  }
  try { assert.deepEqual(sourceInventory(), before); receipt.sourceUnchanged = true; }
  catch (error) { receipt.sourceUnchanged = false; receipt.sourceError = String(error); }
  const passed = ended.exitCode === 0 && !receipt.interrupted && receipt.browserClosed && receipt.sourceUnchanged;
  if (passed) { rmSync(state, { recursive: true }); receipt.environmentRemoved = true; }
  receipt.passed = passed; record(); console.log(JSON.stringify({ output, ...ended, passed, environmentRemoved: receipt.environmentRemoved }));
  process.exitCode = passed ? 0 : ended.exitCode || 1;
}

function analyze(result) {
  const { name, trace } = result;
  const find = (kind, fields = {}) => trace.find(e => e.kind === kind && Object.entries(fields).every(([key, value]) => e[key] === value));
  const order = (...events) => {
    assert.ok(events.every(Boolean), 'Required actual boundary absent');
    for (let i = 1; i < events.length; i++) assert.ok(events[i-1].n < events[i].n, 'Controlled order changed');
  };
  assert.notEqual(result.status, 'blocked', 'No real WebGPU: blocked, not passed');
  assert.notEqual(result.status, 'failed', result.reason);
  assert.equal(result.cleanup.creationsSettled, true);
  assert.equal(result.cleanup.emergencyDeviceDestructions, 0);
  assert.equal(result.cleanup.wrappersRestored, true);
  assert.equal(result.cleanup.unhandledCount, 0);
  assert.ok(Object.values(result.cleanup.owners).every(owner => owner === null));
  assert.deepEqual([...result.cleanup.destroyedIds].sort(), name === 'single' ? ['A'] : ['A','B']);
  if (name === 'single') {
    assert.equal(result.ready.A, true); assert.ok(result.frames.A >= 2);
    assert.equal(result.nativeErrors.length, 0); assert.equal(result.failures.length, 0);
    order(find('configure', {id:'A'}), find('ready', {id:'A'}), find('runtime-destroy', {id:'A'}));
    return { name, outcome: 'Single real mount/redraw and owned cleanup remain healthy' };
  }
  assert.equal(result.ready.B, true, 'Replacement must render before old completion');
  order(find('dispose', {id:'A'}), find('mount', {id:'B'}), find('ready', {id:'B'}));
  if (name === 'late-frame') {
    order(find('render-done', {id:'A'}), find('gate', {label:'frame-A'}), find('dispose', {id:'A'}),
      find('ready', {id:'B'}), find('release', {label:'frame-A'}), find('render-delivered', {id:'A'}));
    assert.equal(result.ready.A, undefined, 'Disposed first-frame continuation must not call onReady');
    assert.equal(result.observation.staleReady, false);
    assert.ok(result.frames.B >= 2);
  } else {
    assert.equal(result.ready.A, undefined, 'Disposed creation must not report ready');
    const gate = name === 'late-pipeline' ? 'pipeline-A' : 'texture-A';
    order(find('gate', {label:gate}), find('dispose', {id:'A'}), find('ready', {id:'B'}), find('release', {label:gate}));
    assert.ok(find('create-done', {id:'A'}) || find('create-error', {id:'A'}), 'Old native creation must actually settle');
    const rejected = find('create-error', {id:'A'});
    if (rejected) assert.equal(rejected.errorName, 'AbortError', 'Only the intended canceled creation is an accepted rejection');
    assert.ok(result.frames.B >= (name === 'late-pipeline' ? 2 : 3), 'Replacement must complete actual requested frames after old completion');
    assert.deepEqual(result.observation, { overwritten:false, staleUnconfigure:false, wrongOwner:false, functionalFailure:false },
      'Old creation must not replace or clear the replacement context');
  }
  assert.equal(result.nativeErrors.length, 0, 'Actual native validation errors are never waived');
  assert.equal(result.failures.length, 0, 'No replacement or disposed-mount fallback is permitted');
  assert.equal(trace.some(e => e.kind === 'create-error' && e.id === 'B'), false);
  return { name, outcome: 'Replacement remains healthy across actual stale completion; disposed mount stays silent' };
}

async function worker(output, browserPath) {
  const result = { status: 'running', output, cases: [], browser: null, startedAt: new Date().toISOString(), closed: {} };
  const record = () => writeFileSync(join(output, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  let server, browserServer, browser, context, interrupted = null;
  let closing;
  const cleanup = () => closing ||= (async () => {
    if (context) { try { await context.close(); } catch (error) { result.closed.contextError = String(error); } context = undefined; }
    if (browserServer) {
      const owner = browserServer;
      let timer;
      try { await Promise.race([owner.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Owned browser close timeout')), 7000); })]); }
      catch (error) { result.closed.browserCloseError = String(error); await owner.kill(); }
      finally { clearTimeout(timer); }
      result.closed.browser = true; browserServer = undefined; browser = undefined;
      process.send?.({ ownedBrowserClosed: true });
    }
    if (server) { server.closeAllConnections(); await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok())); server = undefined; result.closed.http = true; }
  })();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
    interrupted = signal;
    // Playwright also owns signal cleanup during launch, before launchServer resolves.
    // Do not exit early or memoize empty cleanup while that launch is in flight.
    if (browserServer) void cleanup().catch(error => { result.closed.signalCleanupError = String(error); });
  });
  record();
  try {
    const require = createRequire(join(root, 'package.json'));
    const { build } = await import(pathToFileURL(require.resolve('vite')).href);
    const dist = join(output, 'dist');
    const entry = join(output, 'index.html');
    writeFileSync(entry, HTML, { flag: 'wx', mode: 0o600 });
    // Bundle only the probe and its real source imports; do not load app config or env files.
    await build({ configFile: false, root, publicDir: false, envDir: false, cacheDir: join(output, 'vite-cache'),
      build: { outDir: dist, emptyOutDir: false, assetsInlineLimit: 0, target: 'esnext', minify: false,
        rollupOptions: { input: entry } } });
    const entries = [];
    function inventory(dir, prefix = '') {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        assert.equal(entry.isSymbolicLink(), false); const path = join(dir, entry.name), name = prefix + entry.name;
        if (entry.isDirectory()) inventory(path, name + '/');
        else { assert.equal(entry.isFile(), true); const bytes = readFileSync(path); entries.push({ path: name, bytes: bytes.length, sha256: sha(bytes) }); }
      }
    }
    inventory(dist); writeFileSync(join(output, 'dist.json'), JSON.stringify(entries, null, 2) + '\n');
    assert.equal(interrupted, null, 'Interrupted during the standalone bundle');
    const contents = new Map(entries.map(entry => ['/' + entry.path, readFileSync(join(dist, entry.path))]));
    const entryKey = '/' + relative(root, entry).split(sep).join('/');
    assert.ok(contents.has(entryKey), 'Standalone HTML output missing');
    contents.set('/', contents.get(entryKey));
    const contentType = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.hdr': 'application/octet-stream' };
    let origin;
    server = createServer((req, res) => {
      try {
        assert.ok(['GET', 'HEAD'].includes(req.method)); assert.equal(req.headers.host, new URL(origin).host);
        const url = new URL(req.url, origin); assert.equal(url.origin, origin);
        const bytes = contents.get(url.pathname); if (!bytes) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': contentType[extname(url.pathname)] || (url.pathname === '/' ? contentType['.html'] : 'application/octet-stream'),
          'Content-Length': bytes.length, 'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; object-src 'none'; base-uri 'none'" });
        res.end(req.method === 'HEAD' ? undefined : bytes);
      } catch { res.writeHead(400).end(); }
    });
    await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
    origin = 'http://127.0.0.1:' + server.address().port; result.origin = origin; record();
    const { chromium } = require('playwright-core');
    const executable = browserPath;
    assert.ok(lstatSync(executable).isFile());
    result.browser = { executable, sha256: sha(readFileSync(executable)), headless: false, forcedBackend: false };
    browserServer = await chromium.launchServer({ host: '127.0.0.1', port: 0, headless: false, executablePath: executable,
      env: process.env, timeout: 30000, handleSIGINT: true, handleSIGTERM: true, handleSIGHUP: true,
      args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    const ownedBrowser = browserServer.process(); assert.ok(ownedBrowser?.pid);
    result.browser.pid = ownedBrowser.pid; process.send?.({ ownedBrowserPid: ownedBrowser.pid });
    ownedBrowser.once('close', () => process.send?.({ ownedBrowserClosed: true }));
    assert.equal(interrupted, null, 'Interrupted during browser launch');
    browser = await chromium.connect(browserServer.wsEndpoint()); result.browser.version = browser.version(); record();
    for (const name of ['single', 'late-texture', 'late-pipeline', 'fresh-canvas', 'late-frame']) {
      assert.equal(interrupted, null);
      context = await browser.newContext({ viewport: { width: 520, height: 300 }, deviceScaleFactor: 1, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
      const item = { name, requests: [], blockedRequests: [], console: [], pageErrors: [], images: [], status: 'running' };
      result.cases.push(item); record();
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) { item.blockedRequests.push(url.href); return route.abort('blockedbyclient'); }
        item.requests.push(url.pathname); return route.continue();
      });
      const page = await context.newPage(); page.setDefaultTimeout(45000);
      await page.exposeFunction('orbCheckpoint', async label => {
        assert.ok(['healthy', 'replacement-ready', 'after-stale-creation'].includes(label));
        const path = join(output, name + '-' + label + '.png');
        await page.screenshot({ path, timeout: 5000 });
        const bytes = readFileSync(path); item.images.push({ path, bytes: bytes.length, sha256: sha(bytes) });
      });
      page.on('console', message => item.console.push({ type: message.type(), text: message.text() }));
      page.on('pageerror', error => item.pageErrors.push(error.message));
      await page.goto(origin, { waitUntil: 'load' });
      await page.waitForFunction(() => typeof window.runOrbCase === 'function');
      await page.bringToFront();
      let timer;
      try {
        const actual = await Promise.race([page.evaluate(name => window.runOrbCase(name), name), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Whole case exceeded 60 seconds')), 60000); })]);
        item.result = actual; writeFileSync(join(output, name + '.json'), JSON.stringify(actual, null, 2) + '\n');
        if (actual.status === 'blocked') { item.status = 'blocked'; result.status = 'blocked'; throw new Error(actual.reason); }
        item.analysis = analyze(actual); assert.equal(item.blockedRequests.length, 0); assert.equal(item.pageErrors.length, 0); item.status = 'passed';
      } catch (error) {
        // Preserve partial events after any timeout/assertion. Browser closure below owns all native cleanup.
        if (!item.result) {
          let partialTimer;
          try { item.partial = await Promise.race([page.evaluate(() => window.orbProbe), new Promise((_, reject) => { partialTimer = setTimeout(() => reject(new Error('Partial trace unavailable')), 2000); })]); } catch {}
          finally { clearTimeout(partialTimer); }
        }
        item.error = String(error); if (item.status === 'running') item.status = 'failed'; record();
      } finally { clearTimeout(timer); if (context) { await context.close(); context = undefined; } record(); }
      if (item.status === 'blocked') break;
    }
    assert.equal(interrupted, null); await cleanup(); assert.equal(interrupted, null);
    assert.equal(result.cases.length, 5, 'All five cases must run for a complete probe');
    assert.ok(result.cases.every(item => item.status === 'passed'), 'At least one case lacks its required actual outcome');
    assert.equal(result.closed.browserCloseError, undefined, 'Normal owned browser cleanup must succeed');
    assert.equal(result.closed.contextError, undefined);
    result.status = 'passed';
  } catch (error) { if (result.status === 'running') result.status = 'failed'; result.error = String(error); }
  finally {
    try { await cleanup(); } catch (error) { result.status = 'failed'; result.closed.cleanupError = String(error); }
    result.interrupted = interrupted; result.finishedAt = new Date().toISOString(); record();
  }
  process.exitCode = result.status === 'passed' ? 0 : result.status === 'blocked' ? 2 : 1;

}

const [mode = '--plan', ...args] = process.argv.slice(2);
assert.equal(process.version, 'v' + readFileSync(join(root, '.nvmrc'), 'utf8').trim(), 'Use the repository Node version');
if (mode === '--plan') {
  assert.equal(args.length, 0);
  console.log(JSON.stringify({ command: 'node scripts/orb-lifecycle-check.mjs --run --browser /absolute/path/to/chromium',
    source: 'Actual repository Orb modules and bundled assets', cases: ['single', 'late-texture', 'late-pipeline', 'fresh-canvas', 'late-frame'],
    limits: { devicesPerCase: 2, canvas: '192x192', reducedMotion: true, caseSeconds: 60, workerSeconds: 300, cleanupGraceSeconds: 40 },
    output: '.artifacts/orb-lifecycle/run-*', browser: 'Explicit existing Chromium, visible; no install or forced GPU backend',
    qualifications: 'Adapter absence exits blocked (2), never passed. Controlled scheduling does not establish frequency, all hardware support or historical warning causes. Browser request routing is not an OS network sandbox. No app/Core/provider or owner profile is opened.',
  }, null, 2));
} else if (mode === '--run') {
  assert.equal(args.length, 2); assert.equal(args[0], '--browser');
  await launch(args[1]);
} else if (mode === '--worker') {
  assert.equal(args.length, 2); assert.equal(typeof process.send, 'function', 'Worker requires its owning launcher IPC');
  const [output, browserPath] = args;
  const expected = join(root, '.artifacts', 'orb-lifecycle');
  assert.equal(dirname(output), expected); assert.ok(/^run-[a-zA-Z0-9]+$/.test(output.slice(expected.length + 1)));
  assert.equal(realpathSync(output), output); assert.equal(realpathSync(browserPath), browserPath);
  await worker(output, browserPath);
} else throw new Error('Use --plan or --run --browser /absolute/path/to/chromium');
