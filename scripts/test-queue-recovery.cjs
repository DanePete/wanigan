// Actual queue code, shared SQLite and two process owners. Only the transport
// runner is a fixture: its detached child writes synthetic bytes, never tokens.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { promisify } = require('node:util');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture(directory) {
  const native = new DatabaseSync(path.join(directory, 'queue.sqlite'));
  native.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000');
  const d = { exec: sql => native.exec(sql), prepare: sql => native.prepare(sql), transaction(fn) {
    const run = (...args) => {
      native.exec('BEGIN IMMEDIATE');
      try { const value = fn(...args); native.exec('COMMIT'); return value; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    };
    run.immediate = run;
    return run;
  } };
  const events = [];
  const noop = () => {};
  const stubs = {
    'src/main/db.ts': { db: () => d, logEvent: (...args) => events.push(args), newRunId: () => 'fixture-new-run' },
    'src/main/hooks.ts': { pruneEvents: () => 0 },
    'src/main/checkpoints.ts': { pruneCheckpoints: () => 0 },
    'src/main/otel.ts': { pruneSpans: () => 0 },
    'src/main/statusline.ts': { pruneStatusObservations: () => 0 },
    'src/main/providers.ts': {},
    'src/main/store.ts': { projectById: id => ({ id, name: 'Fixture', path: directory }) },
    'src/main/policy.ts': {},
    'src/main/worktrees.ts': {},
    'src/main/config-pins.ts': {},
    'src/main/learning.ts': { refreshDeliveredKnowledgeTtl: noop },
    'src/main/schedule.ts': {},
    'src/main/notify.ts': { announceRunEnded: noop },
    'src/main/accounts.ts': {},
    'src/main/sessions.ts': {},
    'src/main/transcripts.ts': {},
  };
  const cache = new Map();
  function load(relative) {
    if (stubs[relative]) return stubs[relative];
    if (cache.has(relative)) return cache.get(relative).exports;
    const mod = { exports: {} }; cache.set(relative, mod);
    const file = path.join(root, relative);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = name => stubs[name] || (name.startsWith('.')
      ? load(path.relative(root, path.resolve(path.dirname(file), `${name}.ts`)).split(path.sep).join('/')) : require(name));
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(localRequire, mod, mod.exports);
    return mod.exports;
  }
  const storage = load('src/main/modules/execution-storage.ts');
  storage.migrateQueue(d);
  native.exec(`CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,status TEXT,name TEXT,kind TEXT,config_json TEXT,
    cost_usd REAL DEFAULT 0,ended_at INTEGER,created_at INTEGER,in_tokens INTEGER DEFAULT 0,out_tokens INTEGER DEFAULT 0,
    cache_read INTEGER DEFAULT 0,cache_write INTEGER DEFAULT 0,preset TEXT,project_id TEXT,model TEXT,
    total_requests INTEGER,submitted_at INTEGER)`);
  storage.migrateHeadless(d);
  load('src/main/modules/session-storage.ts').migrateSessions(d);
  return { native, d, load, events, stubs, close: () => native.close() };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error('Timed out waiting for the local process fixture');
    await sleep(20);
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function kill(pid, group = false) { try { process.kill(group ? -pid : pid, 'SIGKILL'); } catch { /* Already reaped. */ } }
const safeEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NODE_NO_WARNINGS: '1' };

async function owner(directory) {
  const f = fixture(directory), queue = f.load('src/main/queue.ts');
  let release;
  queue.registerRunner('headless', async () => {
    const child = cp.spawn(process.execPath, [__filename, 'writer', directory], {
      detached: process.platform !== 'win32', stdio: 'ignore', env: safeEnv,
    });
    child.unref();
    fs.appendFileSync(path.join(directory, 'starts.jsonl'), JSON.stringify({ owner: process.pid, child: child.pid }) + '\n');
    await new Promise(resolve => { release = resolve; });
  });
  process.on('message', async message => {
    if (message === 'tick') await queue.tick();
    else if (message === 'finish') { release?.(); await queue.drain(); }
    process.send({ ready: message });
  });
  process.send({ ready: 'open' });
}

function worker(directory) {
  const child = cp.fork(__filename, ['owner', directory], { env: safeEnv, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  let awaiting;
  const first = new Promise(resolve => { awaiting = resolve; });
  child.on('message', message => { const resolve = awaiting; awaiting = null; resolve?.(message); });
  return { child, first, async send(message) {
    const answer = new Promise(resolve => { awaiting = resolve; });
    child.send(message); return answer;
  } };
}

async function queueRecovery(ownerDies) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-queue-recovery-'));
  const f = fixture(directory), queue = f.load('src/main/queue.ts');
  const item = queue.enqueue('headless', 'Synthetic detached writer', {});
  const a = worker(directory), b = worker(directory);
  const starts = () => fs.existsSync(path.join(directory, 'starts.jsonl'))
    ? fs.readFileSync(path.join(directory, 'starts.jsonl'), 'utf8').trim().split('\n').map(JSON.parse) : [];
  try {
    await Promise.all([a.first, b.first]);
    await a.send('tick');
    await until(() => starts().length === 1 && fs.existsSync(path.join(directory, 'writes')));
    await b.send('tick');
    assert.equal(starts().length, 1, 'a valid lease admits exactly one owner');
    const first = starts()[0];
    if (ownerDies) { a.child.kill('SIGKILL'); await until(() => !alive(a.child.pid)); }
    // Only time is fault-injected: the original audit separately waited the
    // real 120-second lease. Both owners, SQLite and surviving writer are real.
    f.native.prepare('UPDATE queue SET lease_expires_at=0 WHERE id=?').run(item.id);
    await b.send('tick');
    const recovered = queue.listQueue().find(row => row.id === item.id);
    assert.equal(starts().length, 1, 'expired ownership must not start a second child while the first can survive');
    assert.equal(recovered.state, 'failed');
    assert.match(recovered.error, /unknown|unreconciled/i);
    assert(alive(first.child), 'the original child really survives its owner/lease');
    const bytes = fs.statSync(path.join(directory, 'writes')).size;
    await until(() => fs.statSync(path.join(directory, 'writes')).size > bytes);
    if (!ownerDies) {
      await a.send('finish');
      assert.equal(queue.listQueue().find(row => row.id === item.id).state, 'failed',
        'the stale owner cannot overwrite quarantine with its later completion');
    }
    f.native.prepare('UPDATE queue SET ended_at=? WHERE id=?').run(Date.now() - 40 * 86_400_000, item.id);
    queue.prune();
    assert(queue.listQueue().some(row => row.id === item.id), 'unresolved process evidence must outlive normal failed-row retention');
    console.log(`PASS: ${ownerDies ? 'owner death' : 'lease loss with late completion'} retains unknown ownership and never duplicates its real writer`);
  } finally {
    a.child.kill('SIGKILL'); b.child.kill('SIGKILL');
    for (const row of starts()) kill(row.child, process.platform !== 'win32');
    await Promise.all([a.child, b.child].map(child => child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    f.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function headlessRecovery() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-headless-recovery-'));
  const f = fixture(directory);
  const child = cp.spawn(process.execPath, [__filename, 'writer', directory], {
    detached: process.platform !== 'win32', stdio: 'ignore', env: safeEnv,
  });
  try {
    await until(() => fs.existsSync(path.join(directory, 'writes')));
    f.native.prepare("INSERT INTO runs(id,status,name,kind,config_json) VALUES('old','in_progress','Fixture','headless','{}')").run();
    f.native.prepare(`INSERT INTO headless_rows(run_id,project_id,project_name,project_path,status,started_at)
      VALUES('old','p','Fixture',?,'running',?)`).run(directory, Date.now() - 60_000);
    const headless = f.load('src/main/headless.ts');
    f.native.prepare(`INSERT INTO headless_rows(run_id,project_id,project_name,project_path,status,started_at,owner_id,owner_pid)
      VALUES('old','foreign','Foreign fixture',?,'running',?,'other-runtime',?)`).run(directory, Date.now() - 60_000, process.pid);
    await assert.rejects(headless.runOneRepo('old', 'foreign'), /already running/);
    const foreign = f.native.prepare("SELECT status,recovery_unresolved,error FROM headless_rows WHERE project_id='foreign'").get();
    assert.equal(foreign.status, 'running');
    assert.equal(foreign.recovery_unresolved, 0, 'a live foreign owner is not inferred dead from row age');
    assert.equal(foreign.error, null);
    await assert.rejects(headless.runOneRepo('old', 'p'), /unknown|unreconciled/i,
      'reopening a running legacy row cannot report success or claim its surviving agent stopped');
    const row = headless.headlessRows('old').find(row => row.projectId === 'p');
    assert.equal(row.status, 'running');
    assert.equal(row.endedAt, null);
    assert.match(row.error, /unknown|unreconciled/i);
    assert(!f.events.some(event => /agent went with it|commands went with it/.test(String(event))));
    assert.equal(headless.cancelHeadless('old'), 0, 'a foreign running row is not a local pre-spawn row that can be reported dropped');
    const activity = f.load('src/main/checkout-activity.ts');
    assert.throws(() => activity.assertCheckoutAvailable(directory, 'restore'), /active or unreconciled/);
    assert(alive(child.pid), 'the unknown execution really still has a live child');
    console.log('PASS: reopened legacy headless execution remains unknown, cannot rerun, and cannot falsely clear checkout ownership');
  } finally {
    kill(child.pid, process.platform !== 'win32');
    await new Promise(resolve => child.once('exit', resolve));
    f.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function headlessProcesses(mode) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-headless-process-'));
  const f = fixture(directory);
  let resumeCleanup, cleanupEntered = false;
  if (mode.startsWith('cleanup')) {
    let snapshots = 0;
    const execute = promisify(cp.execFile);
    const execFile = (...args) => cp.execFile(...args);
    execFile[promisify.custom] = async (...args) => {
      if (args[0] === 'git' && args[1].includes('status') && ++snapshots === 2) {
        cleanupEntered = true;
        await new Promise(resolve => { resumeCleanup = resolve; });
      }
      return execute(...args);
    };
    f.stubs['node:child_process'] = { ...cp, execFile };
  }
  const cli = path.join(directory, 'fixture-cli');
  fs.writeFileSync(cli, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');
const directory=${JSON.stringify(directory)};
fs.writeFileSync(directory+'/launched','1');
if (${JSON.stringify(mode)}==='orphan') {
 const child=cp.spawn(process.execPath,[${JSON.stringify(__filename)},'writer',directory],{stdio:'ignore'});
 child.unref();fs.writeFileSync(directory+'/descendant.pid',String(child.pid));
}

if (${JSON.stringify(mode)}==='hold') setInterval(()=>fs.appendFileSync(directory+'/writes','fixture\\n'),20);
else console.log(JSON.stringify({type:'result',total_cost_usd:0,usage:{input_tokens:1,output_tokens:0}}));
`, { mode: 0o700 });
  const definition = { id: 'fixture', label: 'Synthetic local CLI', harness: 'generic-cli', headless: 'claude-json',
    backendId: 'fixture', bin: 'wanigan-synthetic-cli', profileFingerprint: 'fixture-v1',
    fallbacks: () => [cli], supports: { model: false, effort: false, permissionMode: false }, launchArgs: () => [] };
  Object.assign(f.stubs['src/main/providers.ts'], { providerById: () => definition, refreshProviderPacks: () => {},
    shellPath: async () => safeEnv.PATH });
  f.stubs['src/main/policy.ts'].trustFor = () => 'trusted';
  f.stubs['src/main/config-pins.ts'].gateLaunch = async () => ({ allowed: true });
  Object.assign(f.stubs['src/main/accounts.ts'], { resolve: () => ({ account: null }), appliesTo: () => false,
    applyLaunchEnv: env => { for (const key of Object.keys(env)) if (key !== 'PATH') delete env[key]; } });
  Object.assign(f.stubs['src/main/sessions.ts'], { redirectsAnthropicApi: () => false, stripAmbientAnthropicCredentials: () => {} });
  const config = { providerId: 'fixture', providerProfileFingerprint: 'fixture-v1', prompt: 'synthetic fixture',
    name: 'Fixture', isolate: false, timeoutMs: 10_000, maxBudgetUsd: 0 };
  f.native.prepare("INSERT INTO runs(id,status,name,kind,config_json) VALUES('current','in_progress','Fixture','headless',?)")
    .run(JSON.stringify(config));
  f.native.prepare(`INSERT INTO headless_rows(run_id,project_id,project_name,project_path,status)
    VALUES('current','p','Fixture',?,'pending')`).run(directory);
  // Nobody is present for a fan-out row. The gate's own rule is tested in
  // test-account-eligibility.cjs; here it is the production headless path that
  // must stop on its refusal without starting the child or trying elsewhere.
  if (mode === 'refused') f.stubs['src/main/modules/account-eligibility.ts'] = { checkAccountEligibility: async (_account, options) => {
    assert.deepEqual(options, { attended: false });
    throw new Error('Work reports no signed-in account. Unattended work was not started, and no other account was tried.');
  } };
  const headless = f.load('src/main/headless.ts');
  let running;
  try {
    running = headless.runOneRepo('current', 'p');
    if (mode === 'refused') {
      await running;
      const [row] = headless.headlessRows('current');
      assert.equal(row.status, 'errored'); assert.match(row.error, /no signed-in account.*no other account was tried/);
      assert.equal(fs.existsSync(path.join(directory, 'launched')), false, 'the refused child was never started');
      const activity = f.load('src/main/checkout-activity.ts');
      assert.doesNotThrow(() => activity.assertCheckoutAvailable(directory, 'restore'), 'a launch that never started holds no checkout');
      console.log('PASS: a login refused for unattended work fails its headless row without starting the child or holding the checkout');
      return;
    }
    if (mode === 'hold') {
      await until(() => fs.existsSync(path.join(directory, 'writes')));
      await assert.rejects(headless.runOneRepo('current', 'p'), /already running/);
      assert.equal(headless.headlessRows('current')[0].status, 'running', 'duplicate dispatch cannot fail the original local owner');
      const activity = f.load('src/main/checkout-activity.ts');
      assert.throws(() => activity.assertCheckoutAvailable(directory, 'restore'), /active or unreconciled/);
      await headless.shutdownHeadless(100);
    }
    if (mode.startsWith('cleanup')) {
      await until(() => cleanupEntered);
      let shutdownFinished = false;
      const stopping = headless.shutdownHeadless(500).then(() => { shutdownFinished = true; });
      await sleep(40);
      assert.equal(shutdownFinished, false, 'shutdown must await row finalization after the real child closes');
      const activity = f.load('src/main/checkout-activity.ts');
      assert.throws(() => activity.assertCheckoutAvailable(directory, 'restore'), /active or unreconciled/);
      if (mode === 'cleanup-timeout') {
        await until(() => shutdownFinished, 2_000);
        assert.throws(() => activity.assertCheckoutAvailable(directory, 'restore'), /active or unreconciled/,
          'bounded shutdown cannot release checkout ownership while finalization is still pending');
        assert(f.events.some(event => /finalizations remain incomplete/.test(String(event))));
      }
      resumeCleanup();
      await stopping;
      await running;
      assert.doesNotThrow(() => activity.assertCheckoutAvailable(directory, 'restore'));
    }
    await running;
    const row = headless.headlessRows('current')[0];
    const activity = f.load('src/main/checkout-activity.ts');
    if (mode === 'orphan') {
      const descendant = Number(fs.readFileSync(path.join(directory, 'descendant.pid'), 'utf8'));
      assert(alive(descendant), 'the orphan fixture leaves a real group member behind after CLI close');
      assert.equal(row.status, 'errored');
      assert.match(row.error, /unknown|unconfirmed|could not be confirmed/);
      assert.throws(() => activity.assertCheckoutAvailable(directory, 'restore'), /active or unreconciled/);
      await assert.rejects(headless.runOneRepo('current', 'p'), /unreconciled/);
    } else if (process.platform !== 'win32') {
      assert.equal(row.status, mode === 'hold' || mode.startsWith('cleanup') ? 'canceled' : 'succeeded');
      assert.doesNotThrow(() => activity.assertCheckoutAvailable(directory, 'restore'));
    }
    console.log(`PASS: real headless ${mode} process preserves ownership until its group is confirmed closed`);
  } finally {
    resumeCleanup?.();
    if (fs.existsSync(path.join(directory, 'descendant.pid'))) kill(Number(fs.readFileSync(path.join(directory, 'descendant.pid'), 'utf8')));
    await headless.shutdownHeadless(100);
    await running?.catch(() => {});
    f.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function headlessShutdownPreflight() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-headless-preflight-'));
  const f = fixture(directory), cli = path.join(directory, 'fixture-cli');
  fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const definition = { id: 'fixture', label: 'Synthetic local CLI', harness: 'generic-cli', headless: 'claude-json',
    backendId: 'fixture', bin: 'wanigan-synthetic-cli', profileFingerprint: 'fixture-v1',
    fallbacks: () => [cli], supports: { model: false, effort: false, permissionMode: false }, launchArgs: () => [] };
  let resumeDetection, detectionEntered = false, dispatched = 0;
  Object.assign(f.stubs['src/main/providers.ts'], { providerById: () => definition, refreshProviderPacks: () => {},
    shellPath: async () => safeEnv.PATH, detectProviders: async () => {
      detectionEntered = true;
      await new Promise(resolve => { resumeDetection = resolve; });
      return [{ ...definition, path: cli, capabilities: { headlessJson: true } }];
    } });
  f.stubs['src/main/policy.ts'].trustFor = () => 'trusted';
  const headless = f.load('src/main/headless.ts');
  headless.registerHeadlessRunner(() => { dispatched++; });
  const cfg = { providerId: 'fixture', prompt: 'synthetic fixture', projectIds: ['p'], name: 'Fixture',
    isolate: false, timeoutMs: 10_000, maxBudgetUsd: 0 };
  let starting;
  try {
    starting = headless.startHeadlessRun(cfg);
    await until(() => detectionEntered);
    await headless.shutdownHeadless(100);
    resumeDetection();
    await assert.rejects(starting, /shutting down|stopping/i,
      'a start whose preflight was pending at quit cannot dispatch after shutdown completes');
    assert.equal(dispatched, 0);
    assert.equal(f.native.prepare('SELECT COUNT(*) AS n FROM runs').get().n, 0);
    await assert.rejects(headless.startHeadlessRun(cfg), /shutting down|stopping/i);
    await assert.rejects(headless.runOneRepo('not-started', 'p'), /shutting down|stopping/i);
    console.log('PASS: delayed headless preflight and later launch requests cannot escape runtime shutdown');
  } finally {
    resumeDetection?.();
    await starting?.catch(() => {});
    f.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv[2] === 'writer') {
    setInterval(() => fs.appendFileSync(path.join(process.argv[3], 'writes'), 'fixture\n'), 20);
    return;
  }
  if (process.argv[2] === 'owner') { await owner(process.argv[3]); return; }
  await headlessShutdownPreflight();
  await queueRecovery(true);
  await queueRecovery(false);
  await headlessRecovery();
  if (process.platform !== 'win32') {
    await headlessProcesses('refused');
    await headlessProcesses('complete');
    await headlessProcesses('hold');
    await headlessProcesses('orphan');
    await headlessProcesses('cleanup');
    await headlessProcesses('cleanup-timeout');
  } else console.log('SKIP: executable-script and POSIX process-group fixtures are unavailable on Windows');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
