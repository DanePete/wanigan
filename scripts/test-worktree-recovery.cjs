// Production worktree commands, real SQLite/Git and local command processes. Only the app's
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
  directory ??= fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-worktree-recovery-')));
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
  native.prepare('INSERT OR IGNORE INTO projects(id,path) VALUES (?,?)').run(project.id, repo);
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
      if (name === './db') return { db: () => database, dataDir: () => directory };
      if (name === './store') return { projectById: () => project, listProjects: () => [project] };
      if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), `${name}.ts`));
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected import ${name}`);
    }
    const runtimeProcess = { env: environment, platform: process.platform, pid: process.pid, kill: process.kill.bind(process) };
    vm.runInThisContext(`(function(require,module,exports,process){${code}\n})`, { filename: absolute })(localRequire, mod, mod.exports, runtimeProcess);
    return mod.exports;
  }
  load('src/main/modules/session-storage.ts').migrateSessions(database);
  load('src/main/modules/session-storage.ts').migrateWorktrees(database);
  if (created) {
    for (const args of [['init', '--initial-branch=main'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '--allow-empty', '-m', 'fixture']]) {
      const result = cp.spawnSync('git', ['-C', repo, '-c', 'core.hooksPath=/dev/null', ...args], { env: environment, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
  }
  const setup = load('src/main/worktree-setup.ts');
  const context = { projectId: 'fixture', worktree: repo, env: { WANIGAN_WORKTREE: repo, WANIGAN_REPO_ROOT: repo, WANIGAN_PORT: '42000', WANIGAN_PORT_COUNT: '10' } };
  return { directory, repo, setup, context, native, environment, worktrees: load('src/main/worktrees.ts'), activity: load('src/main/checkout-activity.ts'), close() { native.close(); } };
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
  try { await f.setup.runWorktreePhase('setup', f.context); }
  finally { f.close(); }
}
if (process.argv[2] === 'owner') {
  void runOwner();
} else {
  const test = require('node:test');
  test('a completed setup that backgrounds a real writer keeps restore blocked', async () => {
    const f = fixture();
    try {
      const command = `printf '%s' "$$" > ${quote(path.join(f.directory, 'command.pid'))}; (while [ ! -f ${quote(path.join(f.directory, 'release'))} ]; do printf . >> ${quote(path.join(f.directory, 'writes'))}; sleep 0.03; done) >/dev/null 2>&1 &`;
      f.setup.saveWorktreeCommands('fixture', { setup: [command, 'printf after-background'], teardown: [] });
      const result = await f.setup.runWorktreePhase('setup', f.context);
      assert.equal(result.status, 'passed', 'the recorded shell really exited zero');
      const writes = path.join(f.directory, 'writes');
      await until(() => fs.existsSync(writes), 'background writer');
      const before = fs.statSync(writes).size;
      await until(() => fs.statSync(writes).size > before, 'writer survives phase completion');
      assert.throws(() => f.activity.acquireCheckoutActivity(f.repo, 'restore', 'restore-fixture'), /worktree/i);
      assert.match(result.note, /unresolved|may still be running/i);
    } finally { await dispose(f); }
  });
  test('a normal multi-command phase releases ownership once every command group has ended', async () => {
    const f = fixture();
    try {
      f.setup.saveWorktreeCommands('fixture', { setup: ['printf first', 'printf second'], teardown: [] });
      const result = await f.setup.runWorktreePhase('setup', f.context);
      assert.equal(result.status, 'passed');
      const release = f.activity.acquireCheckoutActivity(f.repo, 'restore', 'after-clean-setup');
      release();
    } finally { await dispose(f); }
  });
  test('a restore owner prevents setup commands and worktree removal before they can write', async () => {
    const f = fixture();
    try {
      const checkout = path.join(f.repo, 'isolated');
      const added = cp.spawnSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', checkout, 'HEAD'], { env: f.environment, encoding: 'utf8' });
      assert.equal(added.status, 0, added.stderr);
      f.native.prepare('INSERT INTO worktrees(path,repo_root,session_id,created_at) VALUES (?,?,?,?)')
        .run(checkout, f.repo, 'fixture-session', Date.now());
      f.setup.saveWorktreeCommands('fixture', { setup: [waitingCommand(f)], teardown: [] });
      const release = f.activity.acquireCheckoutActivity(f.repo, 'restore', 'active-restore');
      try {
        await assert.rejects(f.setup.runWorktreePhase('setup', f.context), /restore/i);
        assert(!fs.existsSync(path.join(f.directory, 'command.pid')));
        await assert.rejects(f.worktrees.removeWorktree(checkout, true), /restore/i);
        assert(fs.existsSync(checkout));
      } finally { release(); }
      assert.equal((await f.worktrees.removeWorktree(checkout, false)).removed, true);
      assert(!fs.existsSync(checkout));
      f.activity.acquireCheckoutActivity(f.repo, 'restore', 'after-removal')();
    } finally { await dispose(f); }
  });
  test('a second runtime preserves a live setup owner and holds a crashed owner with a surviving writer', async () => {
    const f = fixture(); let child;
    try {
      f.setup.saveWorktreeCommands('fixture', { setup: [waitingCommand(f)], teardown: [] });
      child = owner(f);
      const writes = path.join(f.directory, 'writes');
      await until(() => fs.existsSync(writes), 'setup writer');
      assert.equal(f.setup.worktreeCommandRuns('fixture')[0].status, 'running');
      child.kill('SIGKILL');
      await until(() => !alive(child.pid), 'setup owner exit');
      const before = fs.statSync(writes).size;
      await until(() => fs.statSync(writes).size > before, 'writer survives owner death');
      const [run] = f.setup.worktreeCommandRuns('fixture');
      assert.equal(run.status, 'failed');
      assert.match(run.note, /process state is unknown/i);
      assert.throws(() => f.activity.acquireCheckoutActivity(f.repo, 'restore', 'after-owner-death'), /worktree/i);
    } finally { await dispose(f, child); }
  });
  for (const phase of ['setup', 'teardown']) test(`automatic removal preserves a clean worktree with an unresolved ${phase} writer`, async () => {
    const f = fixture();
    try {
      const checkout = path.join(f.directory, 'isolated');
      const added = cp.spawnSync('git', ['-C', f.repo, 'worktree', 'add', '--detach', checkout, 'HEAD'], { env: f.environment, encoding: 'utf8' });
      assert.equal(added.status, 0, added.stderr);
      f.native.prepare('INSERT INTO worktrees(path,repo_root,session_id,project_id,port_base,created_at) VALUES (?,?,?,?,?,?)')
        .run(checkout, f.repo, 'fixture-session', 'fixture', 42000, Date.now());
      const command = `printf '%s' "$$" > ${quote(path.join(f.directory, 'command.pid'))}; (while [ ! -f ${quote(path.join(f.directory, 'release'))} ]; do printf . >> ${quote(path.join(f.directory, 'writes'))}; sleep 0.03; done) >/dev/null 2>&1 &`;
      f.setup.saveWorktreeCommands('fixture', { setup: phase === 'setup' ? [command] : [], teardown: phase === 'teardown' ? [command] : [] });
      if (phase === 'setup') await f.setup.runWorktreePhase('setup', { ...f.context, worktree: checkout });
      const removed = await f.worktrees.removeWorktree(checkout, false);
      assert.equal(removed.removed, false);
      assert.match(removed.detail, /commands.*running|unresolved/i);
      assert(fs.existsSync(checkout));
      const writes = path.join(f.directory, 'writes');
      await until(() => fs.existsSync(writes), 'setup/teardown writer');
      const before = fs.statSync(writes).size;
      await until(() => fs.statSync(writes).size > before, 'writer remains live after removal refusal');
      f.setup.saveWorktreeCommands('fixture', { setup: [], teardown: [] });
      assert.equal((await f.worktrees.removeWorktree(checkout, true)).removed, true);
    } finally { await dispose(f); }
  });
}
