// Production Recovery service, registry, owner adapters and real SQLite/filesystem.
// Storage status is an explicit generation/admission fixture; no provider runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture({ register = true } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-recovery-inspection-')));
  const checkout = path.join(directory, 'checkout'); fs.mkdirSync(checkout);
  const native = new DatabaseSync(path.join(directory, 'wanigan.db'));
  native.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE projects(id TEXT PRIMARY KEY,path TEXT);
    CREATE TABLE runs(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL,kind TEXT NOT NULL,status TEXT NOT NULL,total_requests INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE batches(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,created_at INTEGER NOT NULL,processing_status TEXT NOT NULL,results_ingested_at INTEGER);
    CREATE TABLE events(id INTEGER PRIMARY KEY,run_id TEXT NOT NULL,at INTEGER NOT NULL,level TEXT NOT NULL,message TEXT NOT NULL);
    CREATE TABLE learning_model_runs(id TEXT PRIMARY KEY,at INTEGER NOT NULL,status TEXT NOT NULL,cost_reported INTEGER NOT NULL,cost_usd REAL NOT NULL);
    CREATE TABLE companion_turns(id TEXT PRIMARY KEY,at INTEGER NOT NULL,status TEXT NOT NULL,input_tokens INTEGER,output_tokens INTEGER,cost_usd REAL);
    CREATE TABLE interviews(id TEXT PRIMARY KEY,updated_at INTEGER NOT NULL,status TEXT NOT NULL,calls INTEGER,spend_usd REAL);`);
  const database = { prepare: sql => native.prepare(sql), exec: sql => native.exec(sql), transaction: fn => {
    const invoke = (...args) => {
      native.exec('BEGIN IMMEDIATE');
      try { const result = fn(...args); native.exec('COMMIT'); return result; }
      catch (error) { native.exec('ROLLBACK'); throw error; }
    };
    invoke.immediate = invoke; return invoke;
  } };
  let generation = 'fixture-generation-1', held = false, operation = null, now = Date.now();
  class FixtureDate extends Date { static now() { return now; } }
  const cache = new Map();
  const actual = new Set(['recovery', 'recovery-inspection', 'paid-operation-evidence', 'review-recovery', 'module-registry', 'checkout-activity', 'suggest-usage', 'prompt-improve-usage', 'telemetry-accounting']);
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} }; cache.set(absolute, mod);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(name) {
      if (name === 'electron') return { dialog: {}, shell: {}, app: {} };
      if (name.startsWith('node:')) return require(name);
      if (!name.startsWith('.')) throw new Error(`Unexpected external import: ${name}`);
      const target = path.resolve(path.dirname(absolute), `${name}.ts`);
      if (target === path.join(root, 'src/main/db.ts')) return { db: () => database };
      if (target === path.join(root, 'src/main/storage-maintenance.ts')) return {
        storageStatus: () => ({ generation, mode: operation ? 'maintenance' : held ? 'inspection' : 'active', operation, automationHeld: held, spendingHeld: held }),
        assertStorageAdmission: () => { if (held) throw new Error('Storage maintenance admission is closed.'); },
      };
      if (target.includes('/src/shared/') || target.includes('/src/main/modules/') || actual.has(path.basename(target, '.ts'))) return load(target);
      // Required modules' IPC/runtime imports are inert here. Only their actual
      // schema and recovery declaration are used, never these service doubles.
      return {};
    }
    vm.runInThisContext(`(function(require,module,exports,Date){${code}\n})`, { filename: absolute })(localRequire, mod, mod.exports, FixtureDate);
    return mod.exports;
  }
  const registry = load('src/main/module-registry.ts');
  const moduleNames = ['sessions', 'queue', 'headless', 'worktrees', 'review', 'recovery', 'suggest', 'usage'];
  const modules = moduleNames.map(name => load(`src/main/modules/${name}.ts`)[`${name}Module`]);
  for (const module of modules) {
    module.migrate?.(database);
    if (register) registry.registerModule(module);
  }
  // Improve prompt's module constructs a provider client on import, so only its
  // actual schema is loaded; the adapter it declares is the shared owner read.
  load('src/main/prompt-improve-usage.ts').migratePromptImproveUsage(database);
  native.prepare('INSERT INTO projects(id,path) VALUES (?,?)').run('fixture', checkout);
  const recovery = load('src/main/recovery.ts');
  const activity = load('src/main/checkout-activity.ts');
  function finalized(cwd = checkout) {
    native.prepare('INSERT INTO review_runs(id,project_id,started_at,ended_at,status,results_json,evidence_json) VALUES (?,?,?,?,?,?,?)')
      .run('review-fixture', 'fixture', 1, 2, 'failed', '[{"exitCode":null}]',
        JSON.stringify({ before: { cwd, fingerprint: 'f'.repeat(64), unavailableReason: null } }));
    native.prepare('INSERT INTO review_checkout_owners(cwd,run_id,owner_id,owner_pid,lease_expires_at,state) VALUES (?,?,?,?,?,?)')
      .run(cwd, 'review-fixture', 'owner-fixture', process.pid, 0, 'unresolved');
    native.prepare('INSERT INTO checkout_activity(id,cwd,kind,operation_id,owner_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('claim-fixture', cwd, 'review', 'review-fixture', 'activity-owner-fixture', 1);
    // A synthetic no-spawn completion; test-review-recovery.cjs verifies this
    // writer is reached through real Review preparation and finalization.
    load('src/main/review-recovery.ts').recordReviewNeverSpawned(database, 'review-fixture', 'owner-fixture');
    return 'review:review-fixture';
  }
  return { directory, checkout, native, database, recovery, registry, activity, finalized, paid: load('src/main/modules/usage-paid-operations.ts'),
    generation(value) { generation = value; }, hold() { held = true; }, operation(value) { operation = value; }, advance(delta) { now += delta; },
    close() { native.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('required owner modules declare their adapters; legacy claims remain unknown through the production inspection service', () => {
  const f = fixture();
  try {
    for (const id of ['sessions', 'queue', 'headless', 'worktrees', 'review', 'usage']) {
      const module = f.registry.modules().find(row => row.id === id);
      assert(module.required.reason); assert.equal(typeof module.recovery.inspect, 'function');
    }
    const recovery = f.registry.modules().find(row => row.id === 'recovery');
    assert(recovery.required.reason);
    const channels = [];
    recovery.ipc(channel => channels.push(channel));
    assert.deepEqual(channels, ['recovery:inspect', 'recovery:preview', 'recovery:apply']);
    f.native.prepare('INSERT INTO review_runs(id,project_id,started_at,status,results_json) VALUES (?,?,?,?,?)')
      .run('legacy', 'fixture', 1, 'running', '[]');
    const observation = f.recovery.inspectRecovery().observations.find(row => row.module === 'review');
    assert.equal(observation.execution, 'unknown');
    assert.throws(() => f.recovery.previewRecovery(observation.key), /sufficient completion/i);
    assert.throws(() => f.recovery.assertRestoreSafe(f.database), /claim|Restore refused/i);
  } finally { f.close(); }
});

test('reviewed release records an exact generation receipt, preserves failure/billing and really admits subsequent checkout restore', () => {
  const f = fixture();
  try {
    const key = f.finalized();
    f.native.exec("INSERT INTO batches VALUES ('bill','remote',3,'in_progress',NULL)");
    const before = f.native.prepare('SELECT * FROM review_runs').get();
    const preview = f.recovery.previewRecovery(key);
    assert.throws(() => f.activity.acquireCheckoutActivity(f.checkout, 'restore', 'before'), /review/);
    const result = f.recovery.applyRecovery(preview.token);
    assert(result.id); assert.match(result.decision, /No retry/);
    assert.deepEqual(f.native.prepare('SELECT * FROM review_runs').get(), before);
    assert.equal(f.native.prepare('SELECT processing_status FROM batches').get().processing_status, 'in_progress');
    const inspection = f.recovery.inspectRecovery();
    assert.equal(inspection.resolutions.length, 1);
    assert.equal(inspection.resolutions[0].generation, 'fixture-generation-1');
    assert.equal(inspection.observations.find(row => row.operationId === 'remote').billing, 'unresolved');
    assert.throws(() => f.recovery.assertRestoreSafe(f.database), /billing|remote|claim/i);
    const release = f.activity.acquireCheckoutActivity(f.checkout, 'restore', 'after'); release();
    assert.throws(() => f.recovery.applyRecovery(preview.token), /used|expired/);
  } finally { f.close(); }
});

test('opaque receipt and key input reject tampering; a newer preview invalidates the earlier authority', () => {
  const f = fixture();
  try {
    const key = f.finalized();
    for (const invalid of [null, {}, [], 1, '', 'x'.repeat(501)]) assert.throws(() => f.recovery.previewRecovery(invalid), /claim|recorded/);
    const first = f.recovery.previewRecovery(key);
    for (const invalid of [null, { token: first.token }, [], 1, first.token + 'tampered']) assert.throws(() => f.recovery.applyRecovery(invalid), /preview/i);
    const second = f.recovery.previewRecovery(key);
    assert.throws(() => f.recovery.applyRecovery(first.token), /used|expired/);
    f.recovery.applyRecovery(second.token);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM recovery_resolutions').get().n, 1);
  } finally { f.close(); }
});

test('any new claim, late owner result or generation replacement invalidates and consumes the reviewed receipt', () => {
  for (const mutate of [
    f => f.native.prepare('INSERT INTO checkout_activity(id,cwd,kind,operation_id,owner_id,created_at) VALUES (?,?,?,?,?,?)')
      .run('new-claim', f.checkout, 'session', 'other-operation', 'foreign', 3),
    f => f.native.exec("UPDATE review_runs SET results_json='[{}]'"),
    f => f.generation('replacement-generation'),
  ]) {
    const f = fixture();
    try {
      const preview = f.recovery.previewRecovery(f.finalized()); mutate(f);
      assert.throws(() => f.recovery.applyRecovery(preview.token), /changed/i);
      assert.throws(() => f.recovery.applyRecovery(preview.token), /used|expired/);
      assert.equal(f.native.prepare('SELECT count(*) AS n FROM review_checkout_owners').get().n, 1);
      assert.equal(f.native.prepare('SELECT count(*) AS n FROM recovery_resolutions').get().n, 0);
    } finally { f.close(); }
  }
});

test('replaced directory or symlink target invalidates checkout identity before any claim is released', () => {
  for (const symlink of [false, true]) {
    const f = fixture();
    try {
      const alias = path.join(f.directory, 'alias');
      if (symlink) fs.symlinkSync(f.checkout, alias);
      const key = f.finalized(symlink ? alias : f.checkout);
      const preview = f.recovery.previewRecovery(key);
      if (symlink) {
        fs.unlinkSync(alias); const other = path.join(f.directory, 'other'); fs.mkdirSync(other); fs.symlinkSync(other, alias);
      } else {
        fs.renameSync(f.checkout, path.join(f.directory, 'retained')); fs.mkdirSync(f.checkout);
      }
      assert.throws(() => f.recovery.applyRecovery(preview.token), /checkout identity|changed/i);
      assert.equal(f.native.prepare('SELECT count(*) AS n FROM checkout_activity').get().n, 1);
      assert.equal(f.native.prepare('SELECT count(*) AS n FROM recovery_resolutions').get().n, 0);
    } finally { f.close(); }
  }
});

test('maintenance closes both preview and apply admission; rejected apply consumes the token', () => {
  const f = fixture();
  try {
    const key = f.finalized(); const preview = f.recovery.previewRecovery(key); f.hold();
    assert.throws(() => f.recovery.previewRecovery(key), /admission/);
    assert.throws(() => f.recovery.applyRecovery(preview.token), /admission/);
    assert.throws(() => f.recovery.applyRecovery(preview.token), /used|expired/);
    assert.match(f.recovery.inspectRecovery().storageReason, /older spending totals/);
  } finally { f.close(); }
});

test('direct restore guard sees persisted owners even before module registration', () => {
  const f = fixture({ register: false });
  try {
    f.finalized();
    assert.throws(() => f.recovery.assertRestoreSafe(f.database), /claim|Restore refused/i);
  } finally { f.close(); }
});

test('each independent owner or remote liability refuses direct restore without module registration', () => {
  const cases = [
    ['checkout receipt', f => f.native.prepare('INSERT INTO checkout_activity VALUES (?,?,?,?,?,?)')
      .run('claim', f.checkout, 'session', 'session', 'owner', 1)],
    ['unclosed session', f => f.native.prepare('INSERT INTO session_log(id,provider_id,project_path,project_name,started_at) VALUES (?,?,?,?,?)')
      .run('session', 'fixture', f.checkout, 'Fixture', 1)],
    ['expired queue', f => f.native.exec("INSERT INTO queue(id,kind,state,label,payload_json,created_at,lease_expires_at,recovery_unresolved) VALUES ('queue','headless','failed','Fixture','{}',1,0,1)")],
    ['headless owner', f => f.native.prepare('INSERT INTO headless_rows(run_id,project_id,project_name,project_path,status,started_at,cost_reported,recovery_unresolved) VALUES (?,?,?,?,?,?,?,?)')
      .run('run', 'fixture', 'Fixture', f.checkout, 'errored', 1, 1, 1)],
    ['unmetered completed headless', f => f.native.prepare('INSERT INTO headless_rows(run_id,project_id,project_name,project_path,status,started_at,ended_at,cost_reported) VALUES (?,?,?,?,?,?,?,?)')
      .run('run', 'fixture', 'Fixture', f.checkout, 'done', 1, 2, 0)],
    ['worktree quarantine', f => f.native.prepare('INSERT INTO worktree_command_runs(id,project_id,worktree,phase,started_at,status,recovery_unresolved) VALUES (?,?,?,?,?,?,?)')
      .run('worktree', 'fixture', f.checkout, 'setup', 1, 'failed', 1)],
    ['review owner', f => {
      f.native.exec("INSERT INTO review_runs(id,project_id,started_at,status,results_json) VALUES ('review','fixture',1,'failed','[]')");
      f.native.prepare('INSERT INTO review_checkout_owners VALUES (?,?,?,?,?,?)').run(f.checkout, 'review', 'owner', process.pid, 0, 'unresolved');
    }],
    ['TypeSafe pending', f => f.native.exec("INSERT INTO suggest_usage(at,model,attempt_status) VALUES (1,'fixture','pending')")],
    ['TypeSafe unresolved', f => f.native.exec("INSERT INTO suggest_usage(at,model,attempt_status) VALUES (1,'fixture','unresolved')")],
    ['TypeSafe legacy unmetered', f => f.native.exec("INSERT INTO suggest_usage(at,model) VALUES (1,'fixture')")],
    ['Improve prompt pending', f => f.native.exec("INSERT INTO prompt_improve_usage(request_id,at,requested_model,status) VALUES ('improve',1,'fixture','pending')")],
    ['Improve prompt stopped before meters', f => f.native.exec("INSERT INTO prompt_improve_usage(request_id,at,requested_model,status) VALUES ('improve',1,'fixture','cancelled')")],
    ['Improve prompt failed before meters', f => f.native.exec("INSERT INTO prompt_improve_usage(request_id,at,requested_model,status) VALUES ('improve',1,'fixture','failed')")],
    ['Improve prompt answered on an unpriced model', f => f.native.exec("INSERT INTO prompt_improve_usage VALUES ('improve',1,'fixture','fixture','answered',4,2,0,NULL)")],
    ['paid request admitted before submission', f => f.native.exec("INSERT INTO usage_paid_operations VALUES ('paid','anthropic:messages',1)")],
    ['paid request answered with no recorded meters', f => f.native.exec("INSERT INTO usage_paid_operations VALUES ('paid','anthropic:messages',1); INSERT INTO usage_paid_settlements(receipt_id,at,outcome,http_status,request_id) VALUES ('paid',2,'responded',200,'req')")],
    ['terminal label without evidence', f => f.native.exec("INSERT INTO usage_paid_operations VALUES ('paid','anthropic:messages',1); INSERT INTO usage_paid_settlements(receipt_id,at,outcome,http_status,request_id) VALUES ('paid',2,'metered',200,'req')")],
    ['remote batch', f => f.native.exec("INSERT INTO batches VALUES ('batch','run',1,'in_progress',NULL)")],
    ['ended batch without ingestion', f => f.native.exec("INSERT INTO batches VALUES ('batch','run',1,'ended',NULL)")],
    ['ended batch with partial ingestion', f => f.native.exec("INSERT INTO batches VALUES ('batch','run',1,'ended',-1)")],
    ['abandoned results despite positive ingestion stamp', f => f.native.exec(`INSERT INTO batches VALUES ('batch','run',1,'ended',2);
      INSERT INTO events VALUES (1,'run',2,'error','Batch batch was never downloaded and its results are now past the 29-day window — 1 request(s) marked expired. They are gone from the API; Retry will resubmit and re-pay for them.')`)],
    ['in-progress submission', f => f.native.exec("INSERT INTO runs VALUES ('run',1,'batch','in_progress',1)")],
    ['failed submitted run', f => f.native.exec("INSERT INTO runs VALUES ('run',1,'batch','failed',1)")],
    ['unmetered learning result', f => f.native.exec("INSERT INTO learning_model_runs VALUES ('learning',1,'ok',0,0)")],
    ['failed unmetered learning result', f => f.native.exec("INSERT INTO learning_model_runs VALUES ('learning',1,'failed',0,0)")],
    ['unknown learning attempt state', f => f.native.exec("INSERT INTO learning_model_runs VALUES ('learning',1,'pending',1,0)")],
    ['companion with missing cost', f => f.native.exec("INSERT INTO companion_turns VALUES ('turn',1,'failed',NULL,NULL,NULL)")],
    ['legacy committed interview cannot prove every prior request settled', f => f.native.exec("INSERT INTO interviews VALUES ('interview',1,'committed',2,0.05)")],
  ];
  for (const [label, seed] of cases) {
    const f = fixture({ register: false });
    try {
      seed(f); const inspected = f.recovery.inspectRecovery();
      assert.equal(inspected.unavailable, undefined, label);
      assert(inspected.observations.length > 0, label);
      assert.throws(() => f.recovery.assertRestoreSafe(f.database), /Restore refused/, label);
    } finally { f.close(); }
  }
});

test('real telemetry accounting independently refuses uncovered activity, source coverage and durable issues', () => {
  const cases = [
    ['positive tokens without cost', f => f.native.exec("INSERT INTO session_metrics(session_id,metric,attrs,value,last_at) VALUES ('usage','claude_code.token.usage','{}',4,2)")],
    ['API activity without cost meter', f => f.native.exec("INSERT INTO session_api_events(session_id,at,kind,cost_usd) VALUES ('usage',2,'request',0)")],
    ['durable conflict', f => f.native.exec("INSERT INTO session_telemetry_issues VALUES ('usage','conflicting-retry',2)")],
    ['source activity survives loss of an aggregate row', f => f.native.prepare('INSERT INTO session_telemetry_coverage VALUES (?,?,?,?,?,?)')
      .run('usage', 'active', '{"model":"fixture"}', 0, null, '00000000000002000000')],
    ['a different source cannot cover positive activity', f => {
      f.native.exec("INSERT INTO session_metrics(session_id,metric,attrs,value,last_at) VALUES ('usage','claude_code.token.usage','{}',4,2)");
      f.native.prepare('INSERT INTO session_telemetry_coverage VALUES (?,?,?,?,?,?)').run('usage', 'active', '{"model":"first"}', 0, null, '00000000000002000000');
      f.native.prepare('INSERT INTO session_telemetry_coverage VALUES (?,?,?,?,?,?)').run('usage', 'priced', '{"model":"second"}', 1, '00000000000003000000', null);
    }],
  ];
  for (const [label, seed] of cases) {
    const f = fixture({ register: false });
    try {
      seed(f); const inspected = f.recovery.inspectRecovery();
      assert.equal(inspected.unavailable, undefined, label);
      assert.equal(inspected.observations.find(row => row.module === 'usage').billing, 'unresolved', label);
      assert.throws(() => f.recovery.assertRestoreSafe(f.database), /financial uncertainty|claim/, label);
    } finally { f.close(); }
  }
});

test('reported zero-dollar telemetry and headless completion are valid controls, while local completion leaves remote exposure', () => {
  const f = fixture({ register: false });
  try {
    f.native.exec(`INSERT INTO session_metrics(session_id,metric,attrs,value,last_at) VALUES
      ('usage','claude_code.token.usage','{"model":"fixture"}',4,2),
      ('usage','claude_code.cost.usage','{"model":"fixture"}',0,2);
      INSERT INTO runs VALUES ('run',1,'batch','completed',1);
      INSERT INTO batches VALUES ('batch','run',1,'ended',2);
      INSERT INTO learning_model_runs VALUES ('learning',1,'ok',1,0);
      INSERT INTO learning_model_runs VALUES ('refused',1,'refused',0,0);
      INSERT INTO prompt_improve_usage VALUES ('answered',1,'fixture','fixture','answered',4,2,0,0.001);
      INSERT INTO usage_paid_operations VALUES ('stated','anthropic:messages',1),('metered','anthropic:messages',1),('estimated','learning:cli',1);
      INSERT INTO prompt_improve_usage VALUES ('metered-failure',1,'fixture','fixture','failed',4,2,0,0.001);`);
    f.paid.recordPaidResponse('stated', 429, 'req_a', f.database, true);
    f.paid.recordPaidResponse('metered', 200, 'req_b', f.database, true);
    assert(f.paid.accountForPaidOperation({ requestId: 'req_b', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'answered' }, f.database));
    assert(f.paid.accountForPaidOperation({ receiptId: 'estimated', outcome: 'reported-estimate', ownerTable: 'learning_model_runs', ownerId: 'learning' }, f.database));
    f.native.prepare('INSERT INTO headless_rows(run_id,project_id,project_name,project_path,status,started_at,ended_at,cost_reported,cost_usd) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('headless', 'fixture', 'Fixture', f.checkout, 'done', 1, 2, 1, 0);
    assert.deepEqual(f.recovery.inspectRecovery().observations, []);
    assert.doesNotThrow(() => f.recovery.assertRestoreSafe(f.database));
    f.native.exec("INSERT INTO suggest_usage(at,model,attempt_status) VALUES (1,'fixture','unresolved')");
    assert.throws(() => f.recovery.assertRestoreSafe(f.database), /TypeSafe/);
    assert.equal(f.recovery.inspectRecovery().observations[0].billing, 'unresolved');
  } finally { f.close(); }
});

test('accounted requests become blockers again when their linked evidence changes, disappears or becomes ambiguous', () => {
  for (const mutate of [
    f => f.native.exec("DELETE FROM prompt_improve_usage WHERE request_id='owner'"),
    f => f.native.exec("UPDATE prompt_improve_usage SET input_tokens=99 WHERE request_id='owner'"),
    f => f.native.exec("UPDATE usage_paid_settlements SET owner_id='other' WHERE receipt_id='paid'"),
    f => { f.native.exec("INSERT INTO usage_paid_operations VALUES ('duplicate','anthropic:messages',1)");
      f.paid.recordPaidResponse('duplicate', 200, 'req_owned', f.database, true); },
  ]) {
    const f = fixture();
    try {
      f.native.exec("INSERT INTO prompt_improve_usage VALUES ('owner',1,'fixture','fixture','answered',4,2,0,0.001); INSERT INTO usage_paid_operations VALUES ('paid','anthropic:messages',1)");
      f.paid.recordPaidResponse('paid', 200, 'req_owned', f.database, true);
      assert(f.paid.accountForPaidOperation({ requestId: 'req_owned', outcome: 'metered', ownerTable: 'prompt_improve_usage', ownerId: 'owner' }, f.database));
      assert.doesNotThrow(() => f.recovery.assertRestoreSafe(f.database));
      const preview = f.recovery.previewRecovery(f.finalized());
      mutate(f);
      assert.throws(() => f.recovery.applyRecovery(preview.token), /changed/);
      assert.throws(() => f.recovery.assertRestoreSafe(f.database), /Restore refused/);
      assert(f.recovery.inspectRecovery().observations.some(row => row.key === 'usage:usage_paid_operations:paid' && row.billing === 'unresolved'));
    } finally { f.close(); }
  }
});

test('missing required schema is explicitly unavailable and cannot authorize preview or direct restore', () => {
  for (const table of ['checkout_activity', 'review_recovery_evidence', 'session_telemetry_issues', 'session_telemetry_coverage', 'runs', 'batches', 'events', 'learning_model_runs', 'usage_paid_operations', 'usage_paid_settlements']) {
    const f = fixture({ register: false });
    try {
      f.finalized(); f.native.exec(`DROP TABLE ${table}`);
      const inspected = f.recovery.inspectRecovery();
      assert.match(inspected.unavailable, /schema is incomplete/);
      assert.match(inspected.unavailable, new RegExp(table));
      assert.throws(() => f.recovery.previewRecovery('review:review-fixture'), /schema is incomplete/);
      assert.throws(() => f.recovery.assertRestoreSafe(f.database), /schema is incomplete/);
    } finally { f.close(); }
  }
});

test('a partial Improve prompt table is unavailable evidence, while a never-installed one is not a claim', () => {
  const f = fixture({ register: false });
  try {
    f.native.exec('DROP TABLE prompt_improve_usage');
    assert.doesNotThrow(() => f.recovery.assertRestoreSafe(f.database));
    f.native.exec('CREATE TABLE prompt_improve_usage(request_id TEXT PRIMARY KEY,at INTEGER NOT NULL,status TEXT NOT NULL)');
    assert.match(f.recovery.inspectRecovery().unavailable, /could not be read/);
    assert.throws(() => f.recovery.assertRestoreSafe(f.database), /no such column/);
  } finally { f.close(); }
});

test('an interview is covered only when every counted call has its own per-request record', () => {
  const blocked = f => f.recovery.inspectRecovery().observations.filter(row => row.module === 'legacy-interviews').map(row => row.operationId);
  const f = fixture({ register: false });
  try {
    const record = (id, subject, source = 'interview') => f.native.prepare('INSERT INTO usage_direct_requests(id,at,source,model,input_tokens,output_tokens,request_id,subject_id) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, 5, source, 'fixture', 4, 2, null, subject);
    f.native.exec(`INSERT INTO interviews VALUES ('covered',9,'committed',2,0.05),('partly',9,'asking',2,0.05),
      ('older',9,'committed',1,0.02),('uncounted',9,'committed',NULL,NULL),('untouched',9,'abandoned',0,0)`);
    record('r1', 'covered'); record('r2', 'covered'); record('r3', 'partly'); record('r4', 'older', 'batch:dry-run');
    assert.deepEqual(blocked(f), ['older', 'partly', 'uncounted'], 'another source\'s record, a missing record and an unrecorded count all leave the interview open');
    record('r5', 'partly'); assert.deepEqual(blocked(f), ['older', 'uncounted']);

    // A first call that failed left nothing behind before receipts existed; since then it is a receipt.
    f.native.exec("INSERT INTO interviews VALUES ('failed-before',3,'failed',0,0),('failed-since',30,'failed',0,0)");
    assert.deepEqual(blocked(f), ['failed-before', 'failed-since', 'older', 'uncounted'], 'with no receipt ever recorded, every such failure predates them');
    f.native.exec("INSERT INTO usage_paid_operations VALUES ('first-receipt','anthropic:messages',10)");
    assert.deepEqual(blocked(f), ['failed-before', 'older', 'uncounted']);
    f.native.exec('DROP INDEX idx_usage_direct_requests_subject; ALTER TABLE usage_direct_requests DROP COLUMN subject_id');
    assert(blocked(f).includes('covered'), 'a ledger that cannot name its subject covers no interview');
  } finally { f.close(); }
});

test('an unfinished restore exposes its retained paths even when business evidence cannot be read', () => {
  const f = fixture();
  try {
    const journal = { id: 'restore', phase: 'swap-interrupted', source_generation: 'source', destination_generation: 'destination',
      replaced_dir: path.join(f.directory, 'retained'), staging_dir: path.join(f.directory, 'staged'), detail: 'Fixture crash' };
    f.operation(journal); f.native.exec('DROP TABLE checkout_activity');
    const inspected = f.recovery.inspectRecovery();
    assert.equal(inspected.storageMode, 'maintenance');
    assert.equal(inspected.storageOperation.retainedDir, journal.replaced_dir);
    assert.equal(inspected.storageOperation.stagingDir, journal.staging_dir);
    assert.equal(inspected.storageOperation.phase, 'swap-interrupted');
    assert.match(inspected.unavailable, /schema is incomplete/);
  } finally { f.close(); }
});

test('returned preview mutation cannot extend expiry or rewrite the retained resolution authority', () => {
  const f = fixture();
  try {
    const key = f.finalized(); const preview = f.recovery.previewRecovery(key);
    const token = preview.token;
    preview.decision = 'Tampered decision'; preview.observation.operationId = 'unrelated';
    preview.observation.key = 'unrelated'; preview.generation = 'unrelated';
    f.recovery.applyRecovery(token);
    const resolution = f.recovery.inspectRecovery().resolutions[0];
    assert.equal(resolution.operationId, 'review-fixture');
    assert.equal(resolution.generation, 'fixture-generation-1');
    assert.match(resolution.decision, /No retry/);
  } finally { f.close(); }
  const expired = fixture();
  try {
    const preview = expired.recovery.previewRecovery(expired.finalized());
    preview.expiresAt = Number.MAX_SAFE_INTEGER; expired.advance(5 * 60000);
    assert.throws(() => expired.recovery.applyRecovery(preview.token), /changed/);
    assert.equal(expired.native.prepare('SELECT count(*) AS n FROM recovery_resolutions').get().n, 0);
  } finally { expired.close(); }
});

test('an existing regular file cannot stand in for a checkout directory at preview time', () => {
  const f = fixture();
  try {
    const key = f.finalized(); fs.rmdirSync(f.checkout); fs.writeFileSync(f.checkout, 'not a checkout');
    assert.throws(() => f.recovery.previewRecovery(key), /canonical directory/);
    assert.equal(f.native.prepare('SELECT count(*) AS n FROM checkout_activity').get().n, 1);
  } finally { f.close(); }
});

test('late accounting evidence invalidates the global receipt even when its maximum timestamp and unresolved label do not change', () => {
  for (const mutate of [
    f => f.native.exec("INSERT INTO session_api_events(session_id,at,kind,cost_usd) VALUES ('usage',2,'request',0.5)"),
    f => f.native.exec("INSERT INTO session_telemetry_issues VALUES ('usage','another-issue',2)"),
    f => f.native.prepare('INSERT INTO session_telemetry_coverage VALUES (?,?,?,?,?,?)')
      .run('usage', 'active', '{}', 0, null, '00000000000002000000'),
  ]) {
    const f = fixture();
    try {
      const key = f.finalized(); f.native.exec("INSERT INTO session_telemetry_issues VALUES ('usage','original-issue',2)");
      const before = f.recovery.inspectRecovery().observations.find(row => row.module === 'usage');
      const preview = f.recovery.previewRecovery(key); mutate(f);
      const after = f.recovery.inspectRecovery().observations.find(row => row.module === 'usage');
      assert.equal(after.observedAt, before.observedAt); assert.equal(after.billing, before.billing);
      assert.notEqual(after.revision, before.revision);
      assert.throws(() => f.recovery.applyRecovery(preview.token), /changed/);
      assert.equal(f.native.prepare('SELECT count(*) AS n FROM review_checkout_owners').get().n, 1);
    } finally { f.close(); }
  }
});
