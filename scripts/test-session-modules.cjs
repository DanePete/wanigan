// Real schema/IPC module code with isolated SQLite and explicit runtime stubs.
// No Electron window, user database, filesystem operation or agent is launched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture() {
  const calls = [];
  const live = [{ id: 'live', status: 'running', projectPath: '/registered', worktree: '/checkout',
    baseline: { head: 'head', dirty: ['already-edited'], at: 1 } }];
  const boundary = name => (...args) => { calls.push([name, ...args]); return true; };
  const stubs = {
    'electron': { shell: { openPath: async target => { calls.push(['open', target]); return ''; } } },
    'src/main/sessions.ts': {
      listSessions: () => live, liveSessionIds: () => new Set(['live']),
      createSession: async opts => { calls.push(['launch', opts]); return live[0]; },
      recoverExactCodexThread: boundary('recover'), scrollback: boundary('scrollback'),
      interruptSession: boundary('interrupt'), killSession: () => false,
      closeSession: boundary('close'), markRead: boundary('read'),
      setSessionTuning: boundary('tuning'), sendSessionPermissionControl: boundary('permission'),
      writeSession: boundary('write'), resizeSession: boundary('resize'),
    },
    'src/main/session-history.ts': {
      assertConversationExists: boundary('resume-proof'), pastSessions: boundary('past'),
      forgetPastSession: boundary('forget'), setConversationFlag: boundary('flag'),
      renameSession: boundary('rename'), sessionBaseline: boundary('baseline'),
    },
    'src/main/queue.ts': { slots: () => ({ session: 3 }) },
    'src/main/worktrees.ts': Object.fromEntries(['listWorktrees', 'worktreeStatus', 'removeWorktree',
      'mergeWorktree', 'reconcileWorktrees', 'relinkWorktree', 'worktreeForSession', 'worktreeSetupConfig']
      .map(name => [name, boundary(name)])),
    'src/main/worktree-setup.ts': Object.fromEntries(['setDepsMode', 'saveWorktreeCommandsWithConsent', 'worktreeCommandRuns']
      .map(name => [name, boundary(name)])),
    'src/main/roots.ts': { assertManagedRoot: root => { if (root !== '/registered') throw new Error('Unmanaged root'); return root; } },
    'src/main/collisions.ts': { forecastCollisions: boundary('forecast') },
    'src/main/checkpoints.ts': Object.fromEntries(['listCheckpoints', 'checkpointDiff',
      'checkpointRevertPlan', 'applyCheckpointRevert', 'removeRepoCheckpoints'].map(name => [name, boundary(name)])),
  };
  const cache = new Map();
  function load(relative) {
    if (relative in stubs) return stubs[relative];
    if (cache.has(relative)) return cache.get(relative).exports;
    const mod = { exports: {} };
    cache.set(relative, mod);
    const file = path.join(root, relative);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    const localRequire = name => {
      if (name in stubs) return stubs[name];
      if (!name.startsWith('.')) throw new Error(`Unexpected runtime import: ${name}`);
      return load(path.relative(root, path.resolve(path.dirname(file), `${name}.ts`)));
    };
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: file })(localRequire, mod, mod.exports);
    return mod.exports;
  }
  return { calls, load };
}

async function main() {
  const { calls, load } = fixture();
  const registry = load('src/main/module-registry.ts');
  const modules = [load('src/main/modules/sessions.ts').sessionsModule,
    load('src/main/modules/worktrees.ts').worktreesModule,
    load('src/main/modules/checkpoints.ts').checkpointsModule];
  const native = new DatabaseSync(':memory:');
  native.exec('PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES (\'p\');');
  const d = {
    exec: sql => native.exec(sql), prepare: sql => native.prepare(sql),
    transaction: fn => () => { native.exec('BEGIN'); try { fn(); native.exec('COMMIT'); } catch (error) { native.exec('ROLLBACK'); throw error; } },
  };
  // A pre-upgrade table/row must gain columns without losing its identity.
  load('src/main/modules/session-storage.ts').sessionSchema.base(d);
  native.exec("INSERT INTO session_log(id,provider_id,project_path,project_name,started_at) VALUES('old','fixture','/registered','Old session',1)");
  registry.migrateModules(d);
  for (const module of modules) {
    assert(module.required.reason.length > 20);
    registry.registerModule(module); // late registration exercises an actual migration
  }
  native.exec("INSERT INTO worktrees(path,repo_root,created_at) VALUES('/checkout','/registered',1)");
  const snapshot = () => native.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all();
  const originalSchema = snapshot();
  const originalSession = native.prepare('SELECT * FROM session_log').get();
  registry.migrateModules(d);
  assert.deepEqual(snapshot(), originalSchema);
  assert.deepEqual(native.prepare('SELECT * FROM session_log').get(), originalSession);
  assert.equal(native.prepare('SELECT path FROM worktrees').get().path, '/checkout');
  assert(registry.moduleNeedsStartedServices('sessions:create'));
  assert(registry.moduleNeedsStartedServices('sessions:recoverExactCodex'));
  assert(!registry.moduleNeedsStartedServices('sessions:list'));
  const handlers = new Map();
  const win = {};
  registry.registerModuleIpc((channel, fn) => { assert(!handlers.has(channel)); handlers.set(channel, fn); },
    { getWindow: () => win, onAgentLaunched: () => { calls.push(['awake']); } });
  assert.equal(handlers.size, 34);
  assert.deepEqual(handlers.get('sessions:liveCount')(), { live: 1, limit: 3 });
  const listed = handlers.get('sessions:list')()[0];
  assert(!('baseline' in listed));
  assert.deepEqual(listed.baselineSummary, { head: 'head', dirtyCount: 1, at: 1 });
  const opts = { resumeFrom: { sessionId: 'old', conversationId: 'conversation' } };
  await handlers.get('sessions:create')(opts);
  assert.deepEqual(calls.slice(-3), [['resume-proof', opts.resumeFrom], ['launch', opts], ['awake']]);
  assert.equal(handlers.get('sessions:kill')('live'), false);
  assert.throws(() => handlers.get('sessions:past')({}), /valid project/);
  await assert.rejects(handlers.get('sessions:reveal')('/arbitrary'), /no longer open/);
  await handlers.get('sessions:reveal')('live');
  assert.deepEqual(calls.at(-1), ['open', '/checkout']);
  assert.throws(() => handlers.get('worktrees:remove')('/arbitrary', true), /Unmanaged root/);
  handlers.get('worktrees:saveCommands')('p', { setup: ['example'] });
  assert.deepEqual(calls.at(-1), ['saveWorktreeCommandsWithConsent', win, 'p', { setup: ['example'] }]);
  assert.throws(() => handlers.get('checkpoints:revert')('live', 1.1), /not valid/);
  const events = new Map();
  registry.registerModuleEvents((channel, fn) => events.set(channel, fn));
  assert.deepEqual([...events.keys()], ['sessions:write', 'sessions:resize']);
  events.get('sessions:write')('live', 'literal input');
  events.get('sessions:resize')('live', 80, 24);
  assert.deepEqual(calls.slice(-2), [['write', 'live', 'literal input'], ['resize', 'live', 80, 24]]);
  registry.registerModule({ id: 'wrong-scope', label: 'Test', required: null,
    events: on => on('sessions:spoof', () => {}) });
  assert.throws(() => registry.registerModuleEvents(() => {}), /outside its namespace/);
  native.close();
  console.log('Session modules: legacy row/schema preserved; 34 IPC operations and 2 guarded event registrations verified offline.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
