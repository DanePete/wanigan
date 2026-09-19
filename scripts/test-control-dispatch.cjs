// Real Control implementation and module schema against isolated SQLite.
// The session/process, telemetry and queue boundaries are explicit doubles;
// no Electron app, provider CLI, credential, network or paid call is reachable.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-control-dispatch-'));
  const native = new DatabaseSync(':memory:');
  native.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE projects (id TEXT PRIMARY KEY);
    INSERT INTO projects VALUES ('project');
    CREATE TABLE queue (kind TEXT,state TEXT,payload_json TEXT);
    CREATE TABLE session_log (id TEXT PRIMARY KEY,effort TEXT);`);
  const database = {
    prepare: sql => native.prepare(sql),
    exec: sql => native.exec(sql),
    transaction(fn) {
      const run = (...args) => {
        native.exec('BEGIN IMMEDIATE');
        try { const result = fn(...args); native.exec('COMMIT'); return result; }
        catch (error) { native.exec('ROLLBACK'); throw error; }
      };
      run.immediate = run;
      return run;
    },
  };
  const launches = [], attempted = [], killed = [], enqueued = [];
  const meters = new Map();
  const state = { returned: {}, launchError: null, halted: false, prepare: null, profiles: new Map() };
  const unavailable = { costStatus: 'unavailable', costUsd: 0, models: [] };
  const doubles = {
    './db': { db: () => database },
    './halt': { halted: () => state.halted },
    './providers': { providerById: id => state.profiles.has(id) ? state.profiles.get(id)
      : { id, harness: 'claude-code', profileFingerprint: `fingerprint-${id}` } },
    './git': { headSync: () => 'fixture-base' },
    './store': { projectById: id => ({ id, name: 'Dispatch fixture', path: directory }), listProjects: () => [] },
    './sessions': {
      async createSession(options, internal) {
        attempted.push({ options, internal });
        if (state.launchError) throw state.launchError;
        if (state.prepare) await state.prepare();
        internal.beforeSpawn?.();
        const id = `session-${launches.length + 1}`;
        const worktree = internal.useWorktree ?? path.join(directory, id);
        fs.mkdirSync(worktree, { recursive: true });
        const session = { ...options, id, worktree, conversationId: `conversation-${id}`, ...state.returned };
        launches.push({ options, internal, session });
        native.prepare('INSERT INTO session_log VALUES (?,?)').run(id, session.effort ?? null);
        return session;
      },
      killSession: id => killed.push(id), listSessions: () => [],
    },
    './review': { recipe: () => ({ commands: ['fixture check'] }) },
    './otel': {
      usageFor: id => meters.get(id) ?? unavailable,
      usageForMany: ids => Object.fromEntries(ids.map(id => [id, meters.get(id) ?? unavailable])),
    },
    './goal-trace': { listGoalTrace: () => [], recordGoalTrace: () => {} },
    './goal-plans': { latestGoalPlan: () => null },
    './queue': { enqueue(kind, title, payload) {
      enqueued.push({ kind, title, payload });
      native.prepare('INSERT INTO queue VALUES (?,?,?)').run(kind, 'waiting', JSON.stringify(payload));
    } },
    './tree-snapshot': {}, './transcripts': {},
    './control-outcomes': { recordOutcomeReview() { throw new Error('This fixture does not review model outcomes.'); } },
  };
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} };
    cache.set(absolute, mod);
    const source = process.env.WANIGAN_CONTROL_TEST_REF && absolute === path.join(root, 'src/main/control.ts')
      ? execFileSync('git', ['show', `${process.env.WANIGAN_CONTROL_TEST_REF}:src/main/control.ts`], { cwd: root, encoding: 'utf8' })
      : fs.readFileSync(absolute, 'utf8');
    const code = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(name) {
      if (absolute === path.join(root, 'src/main/control.ts') && name.startsWith('./')) {
        if (!(name in doubles)) throw new Error(`Unmocked Control process boundary: ${name}`);
        return doubles[name];
      }
      if (name.startsWith('.')) return load(path.resolve(path.dirname(absolute), name.replace(/\.ts$/, '') + '.ts'));
      if (name.startsWith('node:')) return require(name);
      throw new Error(`Unexpected external import: ${name}`);
    }
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: absolute })(localRequire, mod, mod.exports);
    return mod.exports;
  }
  load('src/main/modules/control.ts').controlModule.migrate(database);
  native.exec('ALTER TABLE work_dockets ADD COLUMN relay INTEGER NOT NULL DEFAULT 0');
  const control = load('src/main/control.ts');
  function seed(id, overrides = {}) {
    const { autopilot = 0, budget = 10, provider = 'stage-profile', model = 'stage-model',
      effort = 'low', account = 'stage-account', permission = 'acceptEdits', status = 'pending',
      worktree = null, session = null, kind = 'implement', claim = null } = overrides;
    native.prepare(`INSERT INTO work_dockets (id,project_id,title,objective,acceptance_json,created_at,updated_at,
      autopilot,autopilot_provider,autopilot_model,budget_usd) VALUES (?,'project','Goal','Fix it','["Checked"]',1,1,?,'global-profile','global-model',?)`)
      .run(id, autopilot, budget);
    native.prepare(`INSERT INTO work_nodes (id,docket_id,kind,title,instructions,provider_id,model,effort,account_id,
      permission_mode,status,worktree,session_id,claim_path) VALUES (?,?,?,'Stage','Do work',?,?,?,?,?,?,?,?,?)`)
      .run(`node-${id}`, id, kind, provider, model, effort, account, permission, status, worktree, session, claim);
    return `node-${id}`;
  }
  const row = id => native.prepare('SELECT * FROM work_nodes WHERE id=?').get(id);
  const goal = id => native.prepare('SELECT * FROM work_dockets WHERE id=?').get(id);
  function meter(node, id, cost) {
    native.prepare('INSERT INTO work_node_sessions VALUES (?,?,?,?)').run(node, row(node).docket_id, id, 1);
    if (cost !== null) meters.set(id, { costStatus: 'reported', costUsd: cost, models: [] });
  }
  return { directory, native, control, seed, row, goal, meter, state, launches, attempted, killed, enqueued,
    close() { native.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

async function withFixture(run) {
  const f = fixture();
  try { await run(f); } finally { f.close(); }
}

test('dispatch persists returned session model, effort, account and permission in the node and recovery receipt', () => withFixture(async f => {
  const node = f.seed('resolved');
  await f.control.startNode(node, { providerId: 'stage-profile', effort: 'high', accountId: 'override-account', permissionMode: 'plan' });
  const launch = f.launches[0];
  assert.equal(launch.options.model, 'stage-model');
  assert.equal(launch.internal.retainWorktree, true);
  assert.equal(launch.internal.requirePrivateDependencies, true);
  const saved = f.row(node);
  assert.equal(saved.provider_id, launch.session.providerId);
  assert.equal(saved.model, 'stage-model');
  assert.equal(saved.effort, 'high');
  assert.equal(saved.account_id, 'override-account');
  assert.equal(saved.permission_mode, 'plan');
  assert.equal(f.native.prepare('SELECT model FROM work_resume_receipts WHERE node_id=?').get(node).model, 'stage-model');
  // The launcher may decline an unsupported field or resolve a different
  // account. The returned facts, including unknowns, must beat requested pins.
  const unsupported = f.seed('unsupported');
  f.state.returned = { model: undefined, effort: undefined, accountId: null, permissionMode: undefined };
  await f.control.startNode(unsupported, { providerId: 'stage-profile', model: 'requested-model', effort: 'high' });
  const unknown = f.row(unsupported);
  assert.equal(unknown.model, null);
  assert.equal(unknown.effort, null);
  assert.equal(unknown.account_id, null);
  assert.equal(unknown.permission_mode, null);
}));

test('queued dispatch keeps the stage route and only falls back to compatible autopilot defaults', () => withFixture(async f => {
  const pinned = f.seed('pinned', { autopilot: 1 });
  await f.control.startQueuedNode(pinned);
  assert.equal(f.launches[0].options.providerId, 'stage-profile');
  assert.equal(f.launches[0].options.model, 'stage-model');
  assert.equal(f.launches[0].options.effort, 'low');
  const fallback = f.seed('fallback', { autopilot: 1, provider: null, model: null });
  await f.control.startQueuedNode(fallback);
  assert.equal(f.launches[1].options.providerId, 'global-profile');
  assert.equal(f.launches[1].options.model, 'global-model');
  const profileDefault = f.seed('profile-default', { autopilot: 1, model: null });
  await f.control.startQueuedNode(profileDefault);
  assert.equal(f.launches[2].options.providerId, 'stage-profile');
  assert.equal(f.launches[2].options.model, undefined, 'another profile’s model must not cross the stage provider pin');
}));

test('reopening implementation reuses its recorded checkout and retains retry spend linkage', () => withFixture(async f => {
  const prior = path.join(f.directory, 'prior-checkout');
  fs.mkdirSync(prior);
  fs.writeFileSync(path.join(prior, 'prior-work.txt'), 'keep this change');
  const node = f.seed('retry', { status: 'failed', worktree: prior, session: 'prior-session' });
  f.control.retryNode(node);
  assert.equal(f.row(node).session_id, null);
  await f.control.startNode(node, { providerId: 'stage-profile' });
  assert.equal(f.launches[0].internal.useWorktree, prior);
  assert.equal(f.launches[0].options.isolate, false);
  assert.equal(fs.readFileSync(path.join(prior, 'prior-work.txt'), 'utf8'), 'keep this change');
  assert.equal(f.row(node).worktree, prior);
  assert.equal(f.launches[0].internal.retainWorktree, true);
  assert.equal(f.launches[0].internal.requirePrivateDependencies, true, 'a retry must also keep dependencies private');
  assert.equal(f.native.prepare('SELECT COUNT(*) AS n FROM work_node_sessions WHERE node_id=?').get(node).n, 2);
}));

test('planning retains its goal checkout without requesting mutating dependency preparation', () => withFixture(async f => {
  const node = f.seed('planner', { kind: 'plan' });
  await f.control.startNode(node, { providerId: 'stage-profile' });
  assert.equal(f.launches[0].internal.retainWorktree, true);
  assert.equal(f.launches[0].internal.requirePrivateDependencies, false);
}));

test('missing retry checkout refuses before launch; launcher repository rejection preserves the old checkout', () => withFixture(async f => {
  const gone = f.seed('gone', { status: 'failed', worktree: path.join(f.directory, 'missing') });
  f.control.retryNode(gone);
  await assert.rejects(f.control.startNode(gone, { providerId: 'stage-profile' }), /no longer|missing/);
  assert.equal(f.attempted.length, 0);
  const foreign = path.join(f.directory, 'foreign-checkout');
  fs.mkdirSync(foreign);
  const node = f.seed('foreign', { status: 'failed', worktree: foreign, claim: 'src' });
  f.control.retryNode(node);
  // createSession owns repository membership validation. Model its refusal
  // here to verify Control propagates it and never falls back to a new tree.
  f.state.launchError = new Error('The worktree this task was given belongs to a different repository.');
  await assert.rejects(f.control.startNode(node, { providerId: 'stage-profile' }), /different repository/);
  assert.equal(f.launches.length, 0);
  assert.equal(f.attempted.length, 1);
  assert.equal(f.attempted[0].internal.useWorktree, foreign);
  assert.equal(f.row(node).worktree, foreign);
  assert.equal(f.native.prepare('SELECT COUNT(*) AS n FROM work_claims WHERE released_at IS NULL').get().n, 0);
}));

test('queued dispatch rechecks spend and budget after sweep without launching over-cap work', () => withFixture(async f => {
  const node = f.seed('capped', { autopilot: 1, budget: 1 });
  assert.equal(f.control.sweepAutopilot(), 1);
  f.meter(node, 'prior-attempt', 1);
  await f.control.startQueuedNode(node);
  assert.equal(f.launches.length, 0);
  assert.equal(f.goal('capped').autopilot, 0);
  assert.equal(f.row(node).dispatch_state, null);
  const zero = f.seed('zero', { autopilot: 1, budget: 0 });
  await f.control.startQueuedNode(zero);
  assert.equal(f.launches.length, 0);
  const uncapped = f.seed('uncapped', { autopilot: 1, budget: null });
  await f.control.startQueuedNode(uncapped);
  assert.equal(f.launches.length, 0);
}));

test('automatic dispatch stops on unknown or partial meters, while no prior sessions and reported zero can run', () => withFixture(async f => {
  for (const [name, costs] of [['unknown', [null]], ['partial', [0.1, null]]]) {
    const node = f.seed(name, { autopilot: 1 });
    costs.forEach((cost, i) => f.meter(node, `${name}-${i}`, cost));
    assert.equal(f.control.sweepAutopilot(), 0);
    assert.equal(f.goal(name).autopilot, 0);
    assert.equal(f.enqueued.length, 0);
    f.native.prepare('UPDATE work_dockets SET autopilot=1 WHERE id=?').run(name);
    await f.control.startQueuedNode(node);
    assert.equal(f.launches.length, 0);
    assert.equal(f.goal(name).autopilot, 0);
  }
  const fresh = f.seed('fresh', { autopilot: 1 });
  await f.control.startQueuedNode(fresh);
  assert.equal(f.launches.length, 1);
  const zero = f.seed('reported-zero', { autopilot: 1 });
  f.meter(zero, 'zero-dollar-meter', 0);
  await f.control.startQueuedNode(zero);
  assert.equal(f.launches.length, 2);
}));

test('generic and missing profiles stay manual at arm, sweep and actual stage dequeue; free checks remain eligible', () => withFixture(async f => {
  f.state.profiles.set('generic', { id: 'generic', harness: 'generic-cli', profileFingerprint: 'generic-v1' });
  f.state.profiles.set('missing', undefined);
  for (const provider of ['generic', 'missing']) {
    const node = f.seed(`arm-${provider}`, { provider });
    assert.throws(() => f.control.setAutopilot(`arm-${provider}`, { enabled: true, providerId: 'global-profile' }), /manual stages/);
    assert.equal(f.goal(`arm-${provider}`).autopilot, 0);
    f.native.prepare('UPDATE work_dockets SET autopilot=1 WHERE id=?').run(`arm-${provider}`);
    assert.equal(f.control.sweepAutopilot(), 0);
    assert.equal(f.goal(`arm-${provider}`).autopilot, 0);
    f.native.prepare('UPDATE work_dockets SET autopilot=1 WHERE id=?').run(`arm-${provider}`);
    await f.control.startQueuedNode(node);
    assert.equal(f.launches.length, 0);
    assert.equal(f.goal(`arm-${provider}`).autopilot, 0);
  }
  const pinned = f.seed('changed-stage', { autopilot: 1 });
  assert.equal(f.control.sweepAutopilot(), 1);
  f.native.prepare("UPDATE work_nodes SET provider_id='generic' WHERE id=?").run(pinned);
  await f.control.startQueuedNode(pinned);
  assert.equal(f.launches.length, 0);
  const manual = f.seed('manual-generic', { provider: 'generic' });
  await f.control.startNode(manual, { providerId: 'generic' });
  assert.equal(f.launches.length, 1, 'explicit manual dispatch is unchanged');
  const free = f.seed('free-generic', { kind: 'verify', provider: 'generic' });
  f.control.registerAutomaticNodeRunner({ id: 'free', matches: ({ node }) => node.kind === 'verify',
    async run(nodeId) { f.native.prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(nodeId); },
  });
  f.control.setAutopilot('free-generic', { enabled: true, providerId: 'generic' });
  await f.control.startQueuedNode(free, 'free');
  assert.equal(f.row(free).status, 'completed');
  assert.equal(f.launches.length, 1, 'the generic provider is not called by deterministic work');
}));

test('automatic launch rechecks pause, halt, ownership, route, profile and meters after asynchronous preparation', async () => {
  for (const change of ['pause', 'halt', 'ownership', 'route', 'profile', 'generic', 'cap', 'unmetered']) {
    await withFixture(async f => {
      const node = f.seed(`prepared-${change}`, { autopilot: 1, claim: 'owned-path' });
      assert.equal(f.control.sweepAutopilot(), 1);
      let release;
      f.state.prepare = () => new Promise(resolve => { release = resolve; });
      const pending = f.control.startQueuedNode(node);
      assert.equal(f.attempted.length, 1);
      assert.equal(f.launches.length, 0);
      if (change === 'pause') f.control.setAutopilot(`prepared-${change}`, { enabled: false });
      if (change === 'halt') f.state.halted = true;
      if (change === 'ownership') f.native.prepare("UPDATE work_nodes SET status='canceled',dispatch_state=NULL WHERE id=?").run(node);
      if (change === 'route') f.native.prepare("UPDATE work_nodes SET effort='high' WHERE id=?").run(node);
      if (change === 'profile') f.state.profiles.set('stage-profile', { id: 'stage-profile', harness: 'claude-code', profileFingerprint: 'changed' });
      if (change === 'generic') f.state.profiles.set('stage-profile', { id: 'stage-profile', harness: 'generic-cli', profileFingerprint: 'fingerprint-stage-profile' });
      if (change === 'cap') f.meter(node, 'new-spend', 10);
      if (change === 'unmetered') f.meter(node, 'unmetered-session', null);
      release();
      await pending;
      assert.equal(f.launches.length, 0, `${change} must refuse before the process boundary`);
      assert.equal(f.row(node).dispatch_state, null);
      assert.equal(f.row(node).session_id, null);
      assert.equal(f.native.prepare('SELECT COUNT(*) AS n FROM work_claims WHERE released_at IS NULL').get().n, 0);
    });
  }
});

test('registered deterministic verification runs at a reached cap or unknown spend without a provider launch', () => withFixture(async f => {
  const runs = [];
  f.control.registerAutomaticNodeRunner({ id: 'fixture-verification',
    matches: ({ node }) => node.kind === 'verify',
    async run(nodeId) { runs.push(nodeId); f.native.prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(nodeId); },
  });
  for (const [id, cost] of [['at-cap', 10], ['unmetered', null]]) {
    const node = f.seed(id, { autopilot: 1, kind: 'verify' });
    f.meter(node, `${id}-attempt`, cost);
    f.native.prepare('UPDATE work_dockets SET autopilot_provider=NULL WHERE id=?').run(id);
    assert.equal(f.control.sweepAutopilot(), 1);
    const queued = f.enqueued.at(-1).payload;
    assert.equal(queued.automaticRunnerId, 'fixture-verification');
    await f.control.startQueuedNode(node, queued.automaticRunnerId);
    assert.equal(f.row(node).status, 'completed');
  }
  assert.equal(runs.length, 2);
  assert.equal(f.launches.length, 0);
}));

test('unknown spend while a task is still running does not disarm the later free verification path', () => withFixture(async f => {
  const node = f.seed('running-unmetered', { autopilot: 1, status: 'running', session: 'active-session' });
  f.meter(node, 'active-session', null);
  f.control.registerAutomaticNodeRunner({ id: 'fixture-verification', matches: ({ node }) => node.kind === 'verify',
    async run(nodeId) { f.native.prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(nodeId); },
  });
  const verify = 'verify-after-unmetered';
  f.native.prepare(`INSERT INTO work_nodes (id,docket_id,kind,title,instructions,depends_json)
    VALUES (?,'running-unmetered','verify','Check','Run checks',?)`).run(verify, JSON.stringify([node]));
  assert.equal(f.control.sweepAutopilot(), 0);
  assert.equal(f.goal('running-unmetered').autopilot, 1);
  f.native.prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(node);
  assert.equal(f.control.sweepAutopilot(), 1);
  await f.control.startQueuedNode(verify, f.enqueued.at(-1).payload.automaticRunnerId);
  assert.equal(f.row(verify).status, 'completed');
  assert.equal(f.launches.length, 0);
}));

test('failed or removed deterministic runners never fall through to a paid agent or retry forever', () => withFixture(async f => {
  const remove = f.control.registerAutomaticNodeRunner({ id: 'fixture-verification', matches: ({ node }) => node.kind === 'verify',
    async run() { throw new Error('Review gate failed'); },
  });
  const failed = f.seed('failed-free', { autopilot: 1, kind: 'verify' });
  await f.control.startQueuedNode(failed, 'fixture-verification');
  assert.equal(f.row(failed).status, 'failed');
  assert.equal(f.goal('failed-free').autopilot, 0);
  assert.match(f.row(failed).detail, /Review gate failed/);
  assert.equal(f.control.sweepAutopilot(), 0);
  const removed = f.seed('removed-free', { autopilot: 1, kind: 'verify' });
  assert.equal(f.control.sweepAutopilot(), 1);
  remove();
  await f.control.startQueuedNode(removed, 'fixture-verification');
  assert.equal(f.launches.length, 0);
  assert.equal(f.goal('removed-free').autopilot, 0);
}));

test('a deterministic task is atomically claimed before awaiting the runner', () => withFixture(async f => {
  let finish;
  let calls = 0;
  f.control.registerAutomaticNodeRunner({ id: 'fixture-verification', matches: ({ node }) => node.kind === 'verify',
    async run(nodeId) {
      calls++;
      await new Promise(resolve => { finish = resolve; });
      f.native.prepare("UPDATE work_nodes SET status='completed' WHERE id=?").run(nodeId);
    },
  });
  const node = f.seed('concurrent-free', { autopilot: 1, kind: 'verify' });
  const first = f.control.startQueuedNode(node, 'fixture-verification');
  await f.control.startQueuedNode(node, 'fixture-verification');
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(f.row(node).status, 'completed');
  assert.equal(f.launches.length, 0);
}));
