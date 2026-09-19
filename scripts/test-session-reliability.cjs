// Actual session/worktree modules, isolated SQLite and filesystem. Process,
// account, configuration and timer boundaries are explicit test doubles.
// Only the small APFS fixture uses a real /bin/cp; no agent/network/keychain runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const { promisify } = require('node:util');
const childProcess = require('node:child_process');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const noop = () => {};

function fixture({ nativePrompt = true, harness = 'generic-cli', cloneFailure = false, platform = process.platform, realGit = false } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-session-reliability-')));
  const projectPath = path.join(directory, 'project');
  const worktreePath = path.join(directory, 'checkout');
  fs.mkdirSync(projectPath); fs.mkdirSync(worktreePath);
  const native = new DatabaseSync(':memory:');
  const database = { exec: sql => native.exec(sql), prepare: sql => native.prepare(sql), transaction: fn => fn };
  native.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES ('project');");
  const timers = new Map(), cache = new Map(), launches = [], writes = [], removed = [], checks = [], cpCalls = [];
  let clock = 100_000, timerId = 0;
  const state = { privateFailure: false, conversationId: null, providerEvents: [], handBackCount: 0 };
  const project = { id: 'project', path: projectPath, name: 'Fixture' };
  const git = (cwd, args) => {
    assert(cwd.startsWith(directory + path.sep));
    const result = childProcess.spawnSync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args],
      { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: directory, GIT_CONFIG_NOSYSTEM: '1' } });
    return { ok: result.status === 0, out: result.stdout ?? '', err: result.stderr ?? '' };
  };
  if (realGit) {
    assert(git(projectPath, ['init', '--initial-branch=main']).ok);
    fs.writeFileSync(path.join(projectPath, '.gitignore'), 'node_modules/\n');
    assert(git(projectPath, ['add', '.gitignore']).ok);
    assert(git(projectPath, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture']).ok);
  }
  const definition = {
    id: 'fixture', label: 'Fixture', source: 'builtin', harness, backendId: 'fixture-backend', bin: 'fixture',
    packId: 'fixture', packVersion: '1', profileFingerprint: 'fixed', declaredCapabilities: {}, launchFields: [],
    supports: { resume: true, model: true, effort: false, permissionMode: false },
    launchArgs: () => ['--fixture-launch'], resumeArgs: id => ['resume', ...(id ? [id] : [])],
    ...(nativePrompt ? { initialPromptArgs: prompt => prompt ? ['--', prompt] : [] } : {}),
  };
  const proc = { pid: 4242, write: data => writes.push(data), resize: noop, kill: noop,
    onData(fn) { this.data = fn; }, onExit(fn) { this.exit = fn; } };
  const execFile = () => { throw new Error('Unexpected real subprocess'); };
  execFile[promisify.custom] = async () => ({ stdout: '', stderr: '' });
  const doubles = {
    './db': { db: () => database, dataDir: () => directory },
    './platform': { hostPlatform: () => platform },
    './providers': { providerById: () => definition, shellPath: async () => '/fixture',
      detectProviders: async () => [{ id: 'fixture', path: '/fixture/bin', profileFingerprint: 'fixed', capabilities: {} }],
      refreshProviderPacks: noop, runsClaudeCli: () => false, missingCredentialIds: () => [], providerProbeEnvironment: () => ({}) },
    './store': { projectById: () => project, listProjects: () => [project] },
    './halt': { refuseIfHalted: noop },
    './accounts': { appliesTo: () => false, resolve: () => {
      if (state.accountFailure) throw new Error('The chosen account no longer exists.');
      return { account: null };
    }, applyLaunchEnv: noop,
      get: () => null, byId: () => null, supportsAccounts: () => false },
    './handoff': {}, './config-pins': { gateLaunch: async () => ({ allowed: true, note: null }) },
    './hooks': { cleanupHookSettings: noop,
      recordProviderEvent(sessionId, event, summary = null, at = Date.now()) {
        const row = { id: state.providerEvents.length + 1, sessionId, event, summary, at, toolName: null };
        state.providerEvents.push(row); return row;
      },
      eventsRevision: () => state.providerEvents.length,
      sessionEvents: id => state.providerEvents.filter(row => row.sessionId === id).slice().reverse(),
      liveState: () => ({ blocked: state.providerEvents.at(-1)?.event === 'PermissionRequest',
        lastAt: state.providerEvents.at(-1)?.at ?? null, tool: null, since: 0 }),
    },
    './codex-hooks': { prepareCodexHookLaunch: () => null, forgetCodexHookSession: noop, codexHookDelivered: () => false },
    './checkout-activity': { acquireCheckoutActivity: () => () => { checks.push('released'); } },
    './checkpoints': { cancelSessionCheckpointLaunch: async () => { state.checkpointCancelled = true; },
      registerSessionCheckpoints: async () => { checks.push('register'); await state.registration; },
      finalizeSessionCheckpoints: async () => { checks.push('checkpoint'); await state.finalization; } },
    './transcripts': {},
    './session-history': { setLiveSessions: noop, deriveSessionTitle: () => null },
    './worktrees': {
      createWorktree: async (...args) => { checks.push(['create', ...args]); return { path: worktreePath }; },
      ensurePrivateWorktreeDependencies: async dir => { checks.push(['private', dir]); if (state.privateFailure) throw new Error('private isolation refused'); },
      removeWorktree: async dir => { removed.push(dir); return { removed: true }; },
      cleanupSessionWorktree: async dir => { removed.push(dir); return { removed: true }; },
      retainWorktreeForReview: noop,
      repoRootFor: async () => projectPath, worktreeLaunchEnv: async () => ({}),
      worktreeStatus: async dir => ({ path: dir, repoRoot: projectPath }),
    },
    './policy': { trustFor: () => 'trusted', waniganCredentialDirs: () => [] },
    './queue': { slots: () => ({ session: 3 }) }, './spend': { budgetBreached: () => [] },
    './mcp/registry': { cleanupMcpConfig: noop },
    './attention': { attentionOf: () => ({}), noteOutput: noop, forgetSession: noop },
    './settings': { flags: () => ({}), learningSettings: () => ({ enabled: false }), getSetting: (_key, fallback) => fallback },
    './attachments': { prepareAttachmentDir: () => directory, cleanupSessionAttachments: noop, attachmentsDir: () => directory, markSessionAttachmentsSent: noop },
    './redact': { redactCredentials: value => value }, './learning': { refreshDeliveredKnowledgeTtl: noop },
    './otel': {},
    './codex-sessions': { discoverCodexThreadId: async () => '11111111-1111-4111-8111-111111111111',
      captureNewCodexThreadId: () => null, codexThreadIdForSession: () => state.conversationId },
  };
  const worktreeDoubles = {
    './db': doubles['./db'], './platform': doubles['./platform'], './store': doubles['./store'],
    './checkout-activity': doubles['./checkout-activity'],
    './git': { OBJECT_NAME: /^[a-f0-9]+$/, head: async cwd => git(cwd, ['rev-parse', 'HEAD']).out.trim(),
      repoState: async () => ({ kind: 'branch', branch: 'main' }), runGit: async (cwd, args) => {
      if (realGit) return git(cwd, args);
      assert.equal(args[0], 'check-ignore', 'this dependency-only fixture must not mutate Git');
      return { ok: true, out: '', err: '' };
    } },
    './worktree-setup': { projectForDirectory: () => project, depsModeFor: () => 'link',
      latestWorktreeRun: () => null, worktreeCommands: () => ({ setup: [], teardown: [] }),
      runWorktreePhase: async () => { checks.push('setup'); return null; } },
  };
  const goalGateDoubles = {
    './control': {
      stopGateTarget: () => ({ nodeId: 'node', docketId: 'goal', returnFailures: true,
        gateReturns: state.handBackCount, budgetUsd: 5, spendUsd: 0, spendStatus: 'reported' }),
      runGateOnStop: async () => ({ proof: { id: 'proof', status: 'failed', gate: {} },
        failing: { command: 'test', exitCode: 1, output: 'error: failed test\nexpected 1' } }),
      countHandBack: (_node, _session, attempt) => { state.handBackCount = attempt; return true; },
      recordHandBack: noop,
    },
    './goal-trace': { recordGoalTrace: noop }, './halt': { halted: () => false },
    './hooks': { onHookEvent: noop },
  };
  const fakeTimeout = (fn, delay = 0) => { const id = { id: ++timerId, unref: noop }; timers.set(id, { fn, at: clock + delay }); return id; };
  class Clock extends Date { static now() { return clock; } }
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} }; cache.set(absolute, mod);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const sessionFile = absolute.endsWith('/src/main/sessions.ts');
    const worktreeFile = absolute.endsWith('/src/main/worktrees.ts');
    function localRequire(name) {
      if (absolute.endsWith('/src/main/attention.ts') && ['./hooks', './settings'].includes(name)) return doubles[name];
      if (absolute.endsWith('/src/main/goal-gate.ts') && name in goalGateDoubles) return goalGateDoubles[name];
      if (name === 'electron') return { BrowserWindow: { getAllWindows: () => [] } };
      if (name === 'node-pty') return { spawn: (file, args, options) => { launches.push({ file, args, options }); return proc; } };
      if (name === 'node:child_process' && sessionFile) return { execFile };
      if (name === 'node:net' && worktreeFile) return { connect: () => {
        const socket = new EventEmitter(); socket.destroy = noop; socket.setTimeout = noop;
        setImmediate(() => socket.emit('error', new Error('fixture has no listener'))); return socket;
      } };
      if (name === 'node:child_process' && worktreeFile) return { spawn: (file, args, options) => {
        assert.equal(file, '/bin/cp'); cpCalls.push(args);
        if (!cloneFailure) return childProcess.spawn(file, args, options);
        const child = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = noop;
        setImmediate(() => child.emit('close', 1, null)); return child;
      } };
      if ((sessionFile || worktreeFile) && name.startsWith('./')) {
        const boundaries = sessionFile ? doubles : worktreeDoubles;
        if (!(name in boundaries)) throw new Error(`Unmocked process boundary ${name}`);
        return boundaries[name];
      }
      if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), name.replace(/\.ts$/, '') + '.ts'));
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected import ${name}`);
    }
    vm.runInThisContext(`(function(require,module,exports,process,setTimeout,clearTimeout,Date){${code}\n})`, { filename: absolute })(
      localRequire, mod, mod.exports, { env: {}, platform, pid: process.pid,
        kill(pid, signal) {
          assert.equal(pid, -proc.pid); assert.equal(signal, 0);
          if (!state.groupAlive) throw Object.assign(new Error('no process group'), { code: 'ESRCH' });
        } },
      sessionFile ? fakeTimeout : setTimeout, sessionFile ? id => timers.delete(id) : clearTimeout, sessionFile ? Clock : Date,
    );
    return mod.exports;
  }
  const schema = load('src/main/modules/session-storage.ts');
  schema.migrateSessions(database); schema.migrateWorktrees(database);
  native.prepare('INSERT INTO worktrees(path,repo_root,branch,session_id,created_at) VALUES (?,?,?,?,?)')
    .run(worktreePath, projectPath, 'fixture', 'prior', clock);
  async function advance(ms) {
    const until = clock + ms;
    for (let guard = 0; guard < 1000; guard++) {
      const entry = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      timers.delete(entry[0]); clock = entry[1].at; entry[1].fn(); await Promise.resolve();
    }
    clock = until; await Promise.resolve();
  }
  return { load, native, projectPath, worktreePath, directory, launches, writes, removed, checks, state, cpCalls, proc, advance,
    close() { native.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

for (const harness of ['generic-cli', 'codex']) test(`${harness}: native initial prompt is one literal argv; no delayed paste`, async () => {
  const f = fixture({ harness });
  try {
    const sessions = f.load('src/main/sessions.ts');
    const prompt = '--keep literal $& and a\nsecond line';
    await sessions.createSession({ providerId: 'fixture', projectId: 'project', initialPrompt: prompt });
    assert.deepEqual(f.launches[0].args.slice(-3), ['--fixture-launch', '--', prompt]);
    f.proc.data('Update available\r\nPress Enter to update');
    await f.advance(25_000);
    assert.deepEqual(f.writes, []);
  } finally { f.close(); }
});

test('fallback never types into a modal after a ready marker; manual typing cancels pending submission', async () => {
  const f = fixture({ nativePrompt: false, harness: 'codex' });
  try {
    const sessions = f.load('src/main/sessions.ts');
    const session = await sessions.createSession({ providerId: 'fixture', projectId: 'project', initialPrompt: 'task' });
    f.proc.data('Ask Codex to do anything'); await f.advance(300);
    f.proc.data('\x1b[2JUpdate available\r\n1. Update now'); await f.advance(25_000);
    assert.deepEqual(f.writes, []);
    assert.match(sessions.scrollback(session.id), /did not send the initial task automatically/);
  } finally { f.close(); }
  const manual = fixture({ nativePrompt: false, harness: 'codex' });
  try {
    const sessions = manual.load('src/main/sessions.ts');
    const session = await sessions.createSession({ providerId: 'fixture', projectId: 'project', initialPrompt: 'task' });
    manual.proc.data('Ask Codex to do anything');
    sessions.writeSession(session.id, 'my own task'); await manual.advance(25_000);
    assert.deepEqual(manual.writes, ['my own task']);
  } finally { manual.close(); }
});

test('an exact Codex resume places the prompt after its id; a native picker never mistakes the prompt for an id', async () => {
  for (const exact of [true, false]) {
    const f = fixture({ harness: 'codex' });
    try {
      const sessions = f.load('src/main/sessions.ts');
      const saved = await sessions.createSession({ providerId: 'fixture', projectId: 'project' });
      f.proc.exit({ exitCode: 0 });
      f.state.conversationId = exact ? '11111111-1111-4111-8111-111111111111' : null;
      await sessions.createSession({ providerId: 'fixture', projectId: 'project', initialPrompt: 'continue task',
        resumeFrom: { sessionId: saved.id, conversationId: 'renderer-does-not-choose' } });
      const args = f.launches[1].args;
      if (exact) {
        assert.deepEqual(args.slice(0, 2), ['resume', f.state.conversationId]);
        assert.deepEqual(args.slice(-2), ['--', 'continue task']);
      } else {
        assert.equal(args[0], 'resume'); assert(!args.includes('continue task'));
        f.proc.data('Choose a session'); await f.advance(25_000);
      }
      assert.deepEqual(f.writes, []);
    } finally { f.close(); }
  }
});

test('a settled fallback prompt submits once, while a modal between paste and Enter receives no Enter', async () => {
  for (const modal of [false, true]) {
    const f = fixture({ nativePrompt: false, harness: 'codex' });
    try {
      await f.load('src/main/sessions.ts').createSession({ providerId: 'fixture', projectId: 'project', initialPrompt: 'task' });
      f.proc.data('Ask Codex to do anything'); await f.advance(900);
      assert.deepEqual(f.writes, ['task']);
      if (modal) f.proc.data('Update now?');
      await f.advance(2000);
      assert.deepEqual(f.writes, modal ? ['task'] : ['task', '\r']);
    } finally { f.close(); }
  }
});

test('Codex OSC fallback hand-back preserves the stop through its paste and starts one turn only on Enter', async () => {
  for (const changedAttention of [false, true]) {
    const f = fixture({ harness: 'codex' });
    try {
      const sessions = f.load('src/main/sessions.ts');
      const attention = f.load('src/main/attention.ts');
      const gate = f.load('src/main/goal-gate.ts');
      const session = await sessions.createSession({ providerId: 'fixture', projectId: 'project' });
      f.proc.data('\x1b]9;Agent turn complete\x07');
      const event = f.state.providerEvents.at(-1);
      assert.equal(attention.attentionOf(session).kind, 'finished');
      const result = await gate.runStopGate(event, {
        session: () => session, attention: attention.attentionOf, write: sessions.writeSession,
        wait: async () => {
          assert.deepEqual(f.state.providerEvents.map(row => row.event), ['Stop'], 'pasted newlines are not a submitted prompt');
          assert.equal(attention.attentionOf(session).transitionId, `event:${event.id}`);
          if (changedAttention) f.proc.data('\x1b]9;Approval requested\x07');
        },
      });
      assert.equal(result.handBack.sent, !changedAttention);
      assert.equal(f.state.handBackCount, 1);
      assert.equal(f.writes.length, changedAttention ? 1 : 2);
      assert(f.writes[0].startsWith('\x1b[200~'));
      if (changedAttention) {
        assert.deepEqual(f.state.providerEvents.map(row => row.event), ['Stop', 'PermissionRequest']);
        assert.equal(attention.attentionOf(session).kind, 'permission');
      } else {
        assert.equal(f.writes[1], '\r');
        assert.deepEqual(f.state.providerEvents.map(row => row.event), ['Stop', 'UserPromptSubmit']);
        assert.equal(attention.attentionOf(session).kind, 'working');
        f.proc.data('\x1b]9;Agent turn complete\x07');
        sessions.writeSession(session.id, 'manual prompt\r');
        assert.deepEqual(f.state.providerEvents.map(row => row.event), ['Stop', 'UserPromptSubmit', 'Stop', 'UserPromptSubmit']);
      }
    } finally { f.close(); }
  }
});

test('a clean goal checkout survives process exit and checkpoint completion; ordinary clean sessions still clean up', async () => {
  for (const retainWorktree of [true, false]) {
    const f = fixture();
    try {
      const sessions = f.load('src/main/sessions.ts');
      const session = await sessions.createSession({ providerId: 'fixture', projectId: 'project', isolate: true },
        { retainWorktree, requirePrivateDependencies: true });
      assert.equal(f.checks.find(value => Array.isArray(value) && value[0] === 'create')[4].requirePrivateDependencies, true);
      f.proc.exit({ exitCode: 0 }); await f.advance(0); await Promise.resolve();
      assert(f.checks.includes('checkpoint'));
      assert.deepEqual(f.removed, retainWorktree ? [] : [f.worktreePath]);
      assert.equal(f.native.prepare('SELECT worktree FROM session_log WHERE id=?').get(session.id).worktree, f.worktreePath);
    } finally { f.close(); }
  }
});

test('session cleanup retains a checkout and its ownership when the terminal group survives', async () => {
  const f = fixture();
  try {
    f.state.groupAlive = true;
    await f.load('src/main/sessions.ts').createSession({ providerId: 'fixture', projectId: 'project', isolate: true });
    f.proc.exit({ exitCode: 0 }); await new Promise(setImmediate);
    assert.deepEqual(f.removed, []);
    assert(!f.checks.includes('released'));
  } finally { f.close(); }
});

test('quit waits for an already-exited session checkpoint and ownership cleanup', async () => {
  const f = fixture();
  let finish;
  try {
    f.state.finalization = new Promise(resolve => { finish = resolve; });
    const sessions = f.load('src/main/sessions.ts');
    await sessions.createSession({ providerId: 'fixture', projectId: 'project', isolate: true });
    f.proc.exit({ exitCode: 0 });
    let drained = false;
    const shutdown = sessions.shutdownAll().then(() => { drained = true; });
    await new Promise(setImmediate);
    assert.equal(drained, false);
    finish(); await shutdown;
    assert.deepEqual(f.removed, [f.worktreePath]);
    assert(f.checks.includes('released'));
  } finally { finish?.(); await new Promise(setImmediate); f.close(); }
});

test('quit refuses a session still waiting for its pre-agent checkpoint', async () => {
  const f = fixture();
  let finish;
  try {
    f.state.registration = new Promise(resolve => { finish = resolve; });
    const sessions = f.load('src/main/sessions.ts');
    const opening = sessions.createSession({ providerId: 'fixture', projectId: 'project', isolate: true });
    await new Promise(setImmediate);
    assert(f.checks.includes('register'));
    assert.equal(f.launches.length, 0);
    const shutdown = sessions.shutdownAll();
    finish();
    await assert.rejects(opening, /shutting down/);
    await shutdown;
    assert.equal(f.launches.length, 0);
    assert(f.checks.includes('released'));
  } finally { finish?.(); await new Promise(setImmediate); f.close(); }
});

test('an adopted implementation checkout is checked before spawn and refusal launches no agent', async () => {
  const f = fixture();
  try {
    const sessions = f.load('src/main/sessions.ts'); f.state.privateFailure = true;
    await assert.rejects(sessions.createSession({ providerId: 'fixture', projectId: 'project' },
      { useWorktree: f.worktreePath, retainWorktree: true, requirePrivateDependencies: true }), /private isolation refused/);
    assert.deepEqual(f.checks, [['private', f.worktreePath], 'released']); assert.equal(f.launches.length, 0);
  } finally { f.close(); }
});

test('goal ownership survives subsequent cleanup calls and unreadable ownership is kept conservatively', async () => {
  const f = fixture();
  try {
    const worktrees = f.load('src/main/worktrees.ts');
    worktrees.retainWorktreeForReview(f.worktreePath);
    const stored = JSON.parse(f.native.prepare('SELECT bootstrap_json FROM worktrees').get().bootstrap_json);
    assert.equal(stored.retainForReview, true);
    assert.equal((await worktrees.cleanupSessionWorktree(f.worktreePath)).removed, false);
    // Models a later session with no main-only retention argument: the durable
    // worktree owner, rather than that session's transient options, decides.
    assert.equal((await worktrees.cleanupSessionWorktree(f.worktreePath)).removed, false);
    f.native.prepare('UPDATE worktrees SET bootstrap_json=?').run('{broken');
    assert.equal((await worktrees.cleanupSessionWorktree(f.worktreePath)).removed, false);
    assert(fs.existsSync(f.worktreePath));
  } finally { f.close(); }
});

test('final launch authorization is synchronous after preparation, preserves adopted work, and refuses before PTY spawn', async () => {
  const f = fixture();
  try {
    const sessions = f.load('src/main/sessions.ts');
    await assert.rejects(sessions.createSession({ providerId: 'fixture', projectId: 'project' },
      { useWorktree: f.worktreePath, retainWorktree: true, requirePrivateDependencies: true,
        beforeSpawn() {
          assert.deepEqual(f.checks, [['private', f.worktreePath], 'register']);
          assert.equal(f.launches.length, 0);
          throw new Error('Automatic spending was paused during preparation');
        } }), /paused during preparation/);
    assert.deepEqual(f.removed, []); assert.equal(f.launches.length, 0);
  } finally { f.close(); }
});

function dependencyFixture(f, sourceLink = false) {
  const source = path.join(f.projectPath, 'node_modules');
  const contents = sourceLink ? path.join(f.directory, 'source-dependencies') : source;
  fs.mkdirSync(contents); fs.writeFileSync(path.join(contents, 'preserve.txt'), 'parent dependency');
  if (sourceLink) fs.symlinkSync(contents, source);
  const target = path.join(f.worktreePath, 'node_modules'); fs.symlinkSync(source, target);
  return { source, contents, target };
}

test('clone failure preserves the existing link and parent bytes, records refusal and never falls back to sharing', async () => {
  const f = fixture({ cloneFailure: true });
  try {
    const { contents, target } = dependencyFixture(f);
    const worktrees = f.load('src/main/worktrees.ts');
    await assert.rejects(worktrees.ensurePrivateWorktreeDependencies(f.worktreePath), /No shared fallback was created/);
    assert(fs.lstatSync(target).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(contents, 'preserve.txt'), 'utf8'), 'parent dependency');
    assert.equal(fs.readdirSync(f.worktreePath).filter(name => name.startsWith('.wanigan-private')).length, 0);
    const record = JSON.parse(f.native.prepare('SELECT bootstrap_json FROM worktrees').get().bootstrap_json);
    assert.equal(record.privateDependencies, true); assert.equal(record.deps[0].result, 'failed');
  } finally { f.close(); }
});

test('unsupported cloning refuses before any copy or shared fallback', async () => {
  const f = fixture({ platform: 'linux' });
  try {
    dependencyFixture(f);
    await assert.rejects(f.load('src/main/worktrees.ts').ensurePrivateWorktreeDependencies(f.worktreePath), /same APFS volume/);
    assert.equal(f.cpCalls.length, 0);
  } finally { f.close(); }
});

test('a real APFS clone replaces a shared source symlink; package-manager deletion cannot touch its parent', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture();
  try {
    const { contents, target } = dependencyFixture(f, true);
    const worktrees = f.load('src/main/worktrees.ts');
    await worktrees.ensurePrivateWorktreeDependencies(f.worktreePath);
    assert(!fs.lstatSync(target).isSymbolicLink());
    fs.rmSync(target, { recursive: true });
    assert.equal(fs.readFileSync(path.join(contents, 'preserve.txt'), 'utf8'), 'parent dependency');
    await worktrees.relinkWorktree(f.worktreePath);
    assert(!fs.lstatSync(target).isSymbolicLink(), 'repair preserves private policy');
    assert.equal(fs.readFileSync(path.join(target, 'preserve.txt'), 'utf8'), 'parent dependency');
  } finally { f.close(); }
});

test('an escaping symlink inside a dependency clone is refused before replacing the existing shared link', { skip: process.platform !== 'darwin' }, async () => {
  const f = fixture();
  try {
    const { contents, target } = dependencyFixture(f);
    fs.symlinkSync(f.projectPath, path.join(contents, 'workspace-package'));
    await assert.rejects(f.load('src/main/worktrees.ts').ensurePrivateWorktreeDependencies(f.worktreePath), /links outside/);
    assert(fs.lstatSync(target).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(contents, 'preserve.txt'), 'utf8'), 'parent dependency');
  } finally { f.close(); }
});

test('fresh real Git worktrees override the shared default, and clone failure stops before setup', { skip: process.platform !== 'darwin' }, async () => {
  for (const cloneFailure of [false, true]) {
    const f = fixture({ realGit: true, cloneFailure });
    try {
      const source = path.join(f.projectPath, 'node_modules'); fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, 'parent.txt'), 'parent survives');
      const worktrees = f.load('src/main/worktrees.ts');
      const creating = worktrees.createWorktree(f.projectPath, 'Fixture', 'private-test', { requirePrivateDependencies: true });
      if (cloneFailure) {
        await assert.rejects(creating, /No shared fallback was created/);
        assert(!f.checks.includes('setup'));
        const row = f.native.prepare("SELECT path,bootstrap_json FROM worktrees WHERE session_id='private-test'").get();
        assert(!fs.existsSync(path.join(row.path, 'node_modules')));
        assert.equal(JSON.parse(row.bootstrap_json).deps[0].result, 'failed');
      } else {
        const result = await creating;
        assert(f.checks.includes('setup'));
        assert.equal(result.bootstrap.privateDependencies, true);
        assert(!fs.lstatSync(path.join(result.path, 'node_modules')).isSymbolicLink());
        fs.rmSync(path.join(result.path, 'node_modules'), { recursive: true });
        worktrees.retainWorktreeForReview(result.path);
        assert.equal((await worktrees.cleanupSessionWorktree(result.path)).removed, false);
        assert.equal((await worktrees.removeWorktree(result.path, false)).removed, true, 'explicit removal remains available');
      }
      assert.equal(fs.readFileSync(path.join(source, 'parent.txt'), 'utf8'), 'parent survives');
    } finally { f.close(); }
  }
});

test('a rejected account after preparation cancels its checkpoint and releases the checkout without spawning', async () => {
  const f = fixture();
  try {
    f.state.accountFailure = true;
    await assert.rejects(f.load('src/main/sessions.ts').createSession({ providerId: 'fixture', projectId: 'project', accountId: 'removed' }), /account no longer exists/);
    assert.equal(f.launches.length, 0);
    assert.equal(f.state.checkpointCancelled, true);
    assert.equal(f.checks.filter(value => value === 'released').length, 1);
  } finally { f.close(); }
});

test('a failed resume account does not strand the conversation launch lock', async () => {
  const f = fixture({ harness: 'codex' });
  try {
    const sessions = f.load('src/main/sessions.ts');
    const saved = await sessions.createSession({ providerId: 'fixture', projectId: 'project' });
    f.proc.exit({ exitCode: 0 }); await new Promise(setImmediate);
    f.state.conversationId = '11111111-1111-4111-8111-111111111111';
    const options = { providerId: 'fixture', projectId: 'project', resumeFrom: { sessionId: saved.id } };
    f.state.accountFailure = true;
    await assert.rejects(sessions.createSession(options), /account no longer exists/);
    f.state.accountFailure = false;
    await sessions.createSession(options);
    assert.equal(f.launches.length, 2);
  } finally { f.close(); }
});

for (const replacement of ['alias', 'directory']) test(`${replacement} replacement during checkpoint preparation cannot redirect the process outside its claimed checkout`, async () => {
  const f = fixture(); let finish;
  try {
    const held = path.join(f.directory, 'held-project');
    if (replacement === 'alias') {
      fs.renameSync(f.projectPath, held);
      fs.symlinkSync(held, f.projectPath);
    }
    f.state.registration = new Promise(resolve => { finish = resolve; });
    const opening = f.load('src/main/sessions.ts').createSession({ providerId: 'fixture', projectId: 'project' });
    await new Promise(setImmediate);
    assert(f.checks.includes('register'));
    if (replacement === 'alias') {
      fs.unlinkSync(f.projectPath);
      fs.symlinkSync(f.worktreePath, f.projectPath);
    } else {
      fs.renameSync(f.projectPath, held);
      fs.mkdirSync(f.projectPath);
    }
    finish();
    await assert.rejects(opening, /checkout.*changed/i);
    assert.equal(f.launches.length, 0);
    assert.equal(f.checks.filter(value => value === 'released').length, 1);
    assert.equal(f.state.checkpointCancelled, true);
    assert(fs.existsSync(held));
    assert(fs.existsSync(f.worktreePath));
  } finally { finish?.(); await new Promise(setImmediate); f.close(); }
});
