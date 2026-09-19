// Production Review, real SQLite/Git and local command processes. Only the app's
// database/project accessors are fixtures; no provider or production data runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function until(predicate, label) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await pause(20);
  }
}
function fixture(directory) {
  const created = !directory;
  directory ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-review-recovery-')));
  const repo = path.join(directory, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const native = new DatabaseSync(path.join(directory, 'evidence.sqlite'));
  native.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  native.exec('CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,path TEXT);');
  const transaction = fn => {
    const run = (...args) => {
      native.exec('BEGIN IMMEDIATE');
      try { const result = fn(...args); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    };
    run.immediate = run;
    return run;
  };
  const database = { prepare: sql => native.prepare(sql), exec: sql => native.exec(sql), transaction };
  const project = { id: 'fixture', name: 'Fixture', path: repo };
  const cache = new Map();
  const environment = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: directory, SHELL: '/bin/sh',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} }; cache.set(absolute, mod);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(name) {
      if (name === 'electron') return { dialog: {} };
      if (name === './db') return { db: () => database };
      if (name === './store') return { projectById: () => project };
      if (name === './worktrees') return { repoRootFor: async () => repo };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), `${name}.ts`));
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected import ${name}`);
    }
    const runtimeProcess = { env: environment, platform: process.platform, pid: process.pid, kill: process.kill.bind(process) };
    vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: absolute })(localRequire, mod, mod.exports, runtimeProcess);
    return mod.exports;
  }
  load('src/main/modules/session-storage.ts').migrateSessions(database);
  load('src/main/modules/review.ts').reviewModule.migrate(database);
  if (created) {
    for (const args of [['init', '--initial-branch=main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'fixture']]) {
      const result = cp.spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { env: environment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  const review = load('src/main/review.ts');
  return { directory, repo, review, native, environment, activity: load('src/main/checkout-activity.ts'), close() { native.close(); } };
}
function owner(f) {
  return cp.spawn(process.execPath, [__filename, 'owner', f.directory], {
    env: f.environment, stdio: ['ignore', 'pipe', 'pipe'],
  });
}
async function dispose(f, child) {
  fs.writeFileSync(path.join(f.directory, 'release'), 'release');
  if (child && alive(child.pid)) {
    child.kill('SIGKILL');
    await until(() => !alive(child.pid), 'owner cleanup');
  }
  const pidFile = path.join(f.directory, 'command.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    // This fixture created the detached group and retains its child identity;
    // product recovery never sends signals to a PID read from persisted rows.
    try { process.kill(-pid, 'SIGKILL'); } catch { /* fixture already ended */ }
    await until(() => !alive(-pid), 'command group cleanup');
  }
  f.close(); fs.rmSync(f.directory, { recursive: true, force: true });
}
function waitingCommand(f) {
  return `printf '%s' "$$" > ${quote(path.join(f.directory, 'command.pid'))}; while [ ! -f ${quote(path.join(f.directory, 'release'))} ]; do printf . >> ${quote(path.join(f.directory, 'writes'))}; sleep 0.03; done`;
}
async function runOwner() {
  const f = fixture(process.argv[3]);
  try {
    const result = await f.review.runAt('fixture');
    fs.writeFileSync(path.join(f.directory, 'owner-result.json'), JSON.stringify(result));
  } catch (error) {
    fs.writeFileSync(path.join(f.directory, 'owner-error.txt'), String(error));
    process.exitCode = 1;
  } finally { f.close(); }
}
if (process.argv[2] === 'owner') {
  void runOwner();
} else {
  const test = require('node:test');
  test('another live owner cannot launch checks or falsify the first running receipt', async () => {
    const f = fixture(); let child;
    try {
      f.review.saveRecipe('fixture', [waitingCommand(f)]);
      child = owner(f);
      await until(() => fs.existsSync(path.join(f.directory, 'command.pid')), 'first command');
      f.review.saveRecipe('fixture', ['true']);
      await assert.rejects(f.review.runAt('fixture'), /already running|unresolved/i);
      const rows = f.review.history('fixture');
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, 'running');
    } finally { await dispose(f, child); }
  });
  test('owner death leaves honest unresolved evidence and forbids a replacement while its command survives', async () => {
    const f = fixture(); let child;
    try {
      f.review.saveRecipe('fixture', [waitingCommand(f)]);
      child = owner(f);
      const writes = path.join(f.directory, 'writes');
      await until(() => fs.existsSync(writes), 'command writes');
      child.kill('SIGKILL');
      await until(() => !alive(child.pid), 'owner exit');
      const before = fs.statSync(writes).size;
      await until(() => fs.statSync(writes).size > before, 'surviving command writes');
      const [run] = f.review.history('fixture');
      assert.equal(run.status, 'failed');
      assert.match(run.results.at(-1).output, /unknown.*may still be running/i);
      assert.doesNotMatch(run.results.at(-1).output, /went with it|commands.*stopped/i);
      f.review.saveRecipe('fixture', ['true']);
      await assert.rejects(f.review.runAt('fixture'), /unresolved/i);
      assert.equal(f.review.history('fixture').length, 1);
    } finally { await dispose(f, child); }
  });
  test('a real expired lease cannot be stolen while the paused owner and its command still exist', { skip: process.platform === 'win32' }, async () => {
    const f = fixture(); let child;
    try {
      f.review.saveRecipe('fixture', [waitingCommand(f)]);
      child = owner(f);
      const writes = path.join(f.directory, 'writes');
      await until(() => fs.existsSync(writes), 'command writes');
      child.kill('SIGSTOP');
      // Exercise the actual thirty-second lease, without editing the clock or
      // the recorded expiry. The independent shell keeps running throughout.
      await pause(31_000);
      assert(alive(child.pid));
      const before = fs.statSync(writes).size;
      await until(() => fs.statSync(writes).size > before, 'command survives lease expiry');
      const [run] = f.review.history('fixture');
      assert.equal(run.status, 'failed');
      assert.match(run.results.at(-1).output, /process state is unknown/i);
      f.review.saveRecipe('fixture', ['true']);
      await assert.rejects(f.review.runAt('fixture'), /unresolved/i);
    } finally { await dispose(f, child); }
  });
  test('graceful shutdown waits for owned commands and records failure before returning', async () => {
    const f = fixture();
    try {
      f.review.saveRecipe('fixture', [waitingCommand(f)]);
      const pending = f.review.runAt('fixture');
      const writes = path.join(f.directory, 'writes');
      await until(() => fs.existsSync(writes), 'command writes');
      await f.review.stopReviewChecks();
      const result = await pending;
      assert.equal(result.status, 'failed');
      assert.match(result.results.at(-1).output, /shutdown/i);
      const before = fs.statSync(writes).size;
      await pause(100);
      assert.equal(fs.statSync(writes).size, before);
      assert.equal(f.review.history('fixture')[0].status, 'failed');
    } finally { await dispose(f); }
  });
  test('a shell exit does not release a checkout while its process group still contains a background command', async () => {
    const f = fixture();
    try {
      f.review.saveRecipe('fixture', [`printf '%s' "$$" > ${quote(path.join(f.directory, 'command.pid'))}; sleep 60 >/dev/null 2>&1 &`]);
      const result = await f.review.runAt('fixture');
      assert.equal(result.status, 'failed');
      assert.match(result.results[0].output, /process.*unknown|may still be running/i);
      f.review.saveRecipe('fixture', ['true']);
      await assert.rejects(f.review.runAt('fixture'), /unresolved/i);
    } finally { await dispose(f); }
  });
  test('legacy interrupted receipts remain blocked across reopening instead of inventing a stopped process', async () => {
    const f = fixture();
    try {
      f.review.saveRecipe('fixture', ['true']);
      f.native.prepare('INSERT INTO review_runs(id,project_id,started_at,status,results_json) VALUES (?,?,?,?,?)')
        .run('legacy', 'fixture', 1, 'running', '[]');
      assert.equal(f.review.history('fixture')[0].status, 'failed');
      const reopened = fixture(f.directory);
      try {
        await assert.rejects(reopened.review.runAt('fixture'), /unresolved/i);
        assert.match(reopened.review.history('fixture')[0].results[0].output, /process state is unknown/i);
        assert.throws(() => reopened.activity.acquireCheckoutActivity(f.repo, 'restore', 'legacy-restore'), /review/i);
      } finally { reopened.close(); }
    } finally { await dispose(f); }
  });
  test('an active restore blocks review and an active review blocks restore through the shared checkout claim', async () => {
    const f = fixture(); let pending;
    try {
      f.review.saveRecipe('fixture', [waitingCommand(f)]);
      const releaseRestore = f.activity.acquireCheckoutActivity(f.repo, 'restore', 'restore-fixture');
      try { await assert.rejects(f.review.runAt('fixture'), /restore/i); }
      finally { releaseRestore(); }
      pending = f.review.runAt('fixture');
      await until(() => fs.existsSync(path.join(f.directory, 'command.pid')), 'review launch');
      assert.throws(() => f.activity.acquireCheckoutActivity(f.repo, 'restore', 'restore-fixture'), /review/i);
      fs.writeFileSync(path.join(f.directory, 'release'), 'release');
      await pending;
      const release = f.activity.acquireCheckoutActivity(f.repo, 'restore', 'restore-after-checks');
      release();
    } finally {
      if (pending) { fs.writeFileSync(path.join(f.directory, 'release'), 'release'); await pending; }
      await dispose(f);
    }
  });
  test('shutdown during initial checkout inspection cannot start the first command afterward', async () => {
    const f = fixture();
    try {
      f.review.saveRecipe('fixture', [waitingCommand(f)]);
      const pending = f.review.runAt('fixture');
      await f.review.stopReviewChecks();
      const run = await pending;
      assert.equal(run.status, 'failed');
      assert(!fs.existsSync(path.join(f.directory, 'command.pid')));
      assert.match(run.results.at(-1).output, /shutdown/i);
      await assert.rejects(f.review.runAt('fixture'), /shutting down/i);
      const release = f.activity.acquireCheckoutActivity(f.repo, 'restore', 'after-clean-shutdown');
      release();
    } finally { await dispose(f); }
  });
}
