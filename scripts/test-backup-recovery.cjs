// Real Electron, SQLite, Backup, Storage and Recovery modules against disposable roots.
// No services start and no provider is invoked. A second launch verifies the restored hold.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function sourceLoader() {
  const cache = new Map();
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const mod = { exports: {} }; cache.set(absolute, mod);
    const code = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    function localRequire(name) {
      if (name.startsWith('.')) {
        const base = path.resolve(path.dirname(absolute), name);
        return load(fs.existsSync(base) && fs.statSync(base).isFile() ? base
          : fs.existsSync(`${base}.ts`) ? `${base}.ts` : path.join(base, 'index.ts'));
      }
      return require(name);
    }
    vm.runInThisContext(`(function(require,module,exports){${code}\n})`, { filename: absolute })(localRequire, mod, mod.exports);
    return mod.exports;
  }
  return load;
}

async function electronFixture() {
  const { app } = require('electron');
  const phase = process.argv[2];
  const directory = process.argv[3];
  const version = Number(process.argv[4]) || 2;
  app.setPath('userData', path.join(directory, 'user-data'));
  await app.whenReady();
  try {
    const load = sourceLoader();
    if (phase === 'fault-reopen') {
      const status = load('src/main/storage-maintenance.ts').storageStatus();
      assert.equal(status.mode, 'maintenance');
      assert.equal(status.operation.phase, 'failed');
      assert.match(status.operation.detail, /synthetic swap failure/);
      load('src/main/modules/register.ts');
      assert.throws(() => load('src/main/db.ts').db(), /recovery|unfinished|closed/i);
      assert(fs.existsSync(path.join(directory, 'user-data', 'wanigan.db')));
      console.log('Backup recovery interrupted reopen: journal retains the failed operation; normal database startup refused after rollback.');
      app.exit(0); return;
    }
    load('src/main/modules/register.ts');
    const { db } = load('src/main/db.ts');
    const backup = load('src/main/backup.ts');
    const storage = load('src/main/storage-maintenance.ts');
    const d = db();
    if (phase === 'restore' || phase === 'fault') {
      const artifactDir = path.join(directory, 'user-data', 'attachments', 'ended');
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, 'report.txt'), 'backed up artifact');
      d.prepare("INSERT INTO session_log(id,provider_id,project_path,project_name,started_at,ended_at) VALUES('ended','fixture',?,'Fixture',1,2)").run(directory);
      load('src/main/settings.ts').setSetting('fixture-spend-history', 'old total');
      const attached = load('src/main/attachments.ts').attachBufferToSession('ended', Buffer.from('attached text'), 'input.txt');
      d.prepare('UPDATE attachments SET stored_path=? WHERE id=?').run(`/old-machine/attachments/ended/${path.basename(attached.storedPath)}`, attached.id);
      d.prepare("INSERT INTO queue(id,kind,label,payload_json,created_at) VALUES('historical-job','headless','Already performed later','{}',1)").run();
      d.prepare("INSERT INTO schedules(id,name,cron,kind,payload_json,created_at,next_at) VALUES('historical-schedule','Already fired later','* * * * *','headless','{}',1,1)").run();
      const made = backup.createBackup(path.join(directory, 'backup'));
      if (version === 1) {
        const file = path.join(made.dir, 'wanigan-backup.json');
        const legacy = JSON.parse(fs.readFileSync(file, 'utf8'));
        legacy.formatVersion = 1; delete legacy.attachments;
        fs.writeFileSync(file, JSON.stringify(legacy));
      }
      assert.equal(backup.inspectBackup(made.dir).problems.length, 0);
      d.prepare("UPDATE queue SET state='done',ended_at=3 WHERE id='historical-job'").run();
      d.prepare("UPDATE schedules SET next_at=?,runs=1 WHERE id='historical-schedule'").run(Date.now() + 86400000);
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true }), /preview/i);
      let preview = backup.previewBackupRestore(made.dir);
      d.prepare("UPDATE settings SET v='new total' WHERE k='fixture-spend-history'").run();
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /changed/i);
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /already used/i);
      preview = backup.previewBackupRestore(made.dir);
      const manifest = path.join(made.dir, 'wanigan-backup.json');
      const original = fs.readFileSync(manifest, 'utf8');
      fs.writeFileSync(manifest, `${original}\n`);
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /backup changed/i);
      fs.writeFileSync(manifest, original);
      const alias = path.join(directory, 'backup-alias');
      fs.symlinkSync(made.dir, alias, 'dir');
      preview = backup.previewBackupRestore(alias);
      fs.unlinkSync(alias); fs.symlinkSync(directory, alias, 'dir');
      assert.throws(() => backup.restoreBackup(alias, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /backup changed/i);
      fs.unlinkSync(alias);
      preview = backup.previewBackupRestore(made.dir);
      const originalNow = Date.now;
      Date.now = () => originalNow() + 6 * 60_000;
      try { assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /expired/i); }
      finally { Date.now = originalNow; }
      preview = backup.previewBackupRestore(made.dir);
      // A newly recorded uncertain owner after preview invalidates before swap.
      d.prepare("INSERT INTO checkout_activity(id,cwd,kind,operation_id,owner_id,created_at) VALUES('foreign',?,'session','foreign','unproven',1)").run(directory);
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /changed/i);
      preview = backup.previewBackupRestore(made.dir);
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /claim|Recovery/i);
      assert.equal(d.prepare("SELECT owner_id FROM checkout_activity WHERE id='foreign'").get().owner_id, 'unproven');
      assert.equal(storage.storageStatus().mode, 'active');
      // The fixture created this row explicitly; deleting it is fixture teardown,
      // not an operator recovery path or a product bypass.
      d.prepare("DELETE FROM checkout_activity WHERE id='foreign'").run();
      const liability = load('src/main/suggest-usage.ts').beginSuggestAttempt({ at: Date.now(), requestedModel: 'fixture', source: 'fixture', credentialDigest: 'fixture' });
      assert(liability);
      preview = backup.previewBackupRestore(made.dir);
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /claim|liability|Recovery/i);
      assert.equal(d.prepare('SELECT attempt_status FROM suggest_usage WHERE request_id=?').get(liability).attempt_status, 'pending');
      // This was a local synthetic record and no transport occurred. Fixture
      // teardown is not a product action that can settle a real remote bill.
      d.prepare('DELETE FROM suggest_usage WHERE request_id=?').run(liability);
      fs.writeFileSync(path.join(artifactDir, 'report.txt'), 'retained newer artifact');
      // A paid request recorded after the backup was taken and never answered.
      // Unlike every claim above it does not refuse the restore: it is the one
      // thing a restore carries, because leaving it behind would erase it.
      const carriedReceipt = load('src/main/modules/usage-paid-operations.ts').admitPaidOperation('anthropic:messages');
      const replacedGeneration = storage.storageStatus().generation;
      preview = backup.previewBackupRestore(made.dir);
      if (phase === 'fault') {
        const originalRename = fs.renameSync;
        fs.renameSync = (from, to) => {
          if (String(from).includes('.restore-staging-') && String(from).endsWith('wanigan.db')) {
            throw new Error('synthetic swap failure');
          }
          return originalRename(from, to);
        };
        try {
          assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /synthetic swap failure/);
        } finally { fs.renameSync = originalRename; }
        const failed = storage.storageStatus();
        assert.equal(failed.mode, 'maintenance');
        assert.equal(failed.operation.phase, 'failed');
        assert.equal(fs.readFileSync(path.join(artifactDir, 'report.txt'), 'utf8'), 'retained newer artifact');
        const Native = require('better-sqlite3');
        const forensic = new Native(path.join(directory, 'user-data', 'wanigan.db'), { readonly: true });
        try { assert.equal(forensic.prepare("SELECT v FROM settings WHERE k='fixture-spend-history'").get().v, 'new total'); }
        finally { forensic.close(); }
        assert.throws(() => d.prepare('SELECT 1').get(), /fenced|closed/i);
        console.log('Backup recovery rename failure: original database/artifacts rolled back, old handle fenced and failed journal retained.');
        app.exit(0); return;
      }
      const report = backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token });
      assert.equal(storage.storageStatus().mode, 'inspection');
      assert.equal(report.carriedPaidReceipts, 1, 'the unanswered paid request was taken along, not left in the replaced database');
      assert.throws(() => backup.restoreBackup(made.dir, { confirm: true, overwriteNewer: true, previewToken: preview.token }), /already used/i);
      assert.equal(fs.readFileSync(path.join(artifactDir, 'report.txt'), 'utf8'),
        version === 2 ? 'backed up artifact' : 'retained newer artifact');
      if (version === 2) assert.equal(fs.readFileSync(path.join(report.replacedDir, 'attachments', 'ended', 'report.txt'), 'utf8'), 'retained newer artifact');
      else assert.equal(report.attachments, null);
      assert.throws(() => d.prepare('SELECT 1').get(), /fenced|closed/i);
      assert.throws(() => storage.assertStorageAdmission({ automatic: true }), /inspection|archived/i);
      assert.throws(() => storage.assertStorageAdmission({ paid: true }), /spending|historical/i);
      fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ ...report, attached, carriedReceipt, replacedGeneration }));
      console.log('Backup recovery restore: native staging, source/revision/one-use refusal, unknown owner refusal, a carried paid receipt, retained originals and held publication passed.');
    } else {
      const status = storage.storageStatus();
      assert.equal(status.mode, 'inspection');
      assert(status.automationHeld && status.spendingHeld);
      assert.equal(d.prepare("SELECT v FROM settings WHERE k='fixture-spend-history'").get().v, 'old total');
      const report = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
      if (version === 2) assert.equal(d.prepare('SELECT stored_path FROM attachments WHERE id=?').get(report.attached.id).stored_path, report.attached.storedPath);
      // The restored database is the old one, plus the one record it never had.
      assert.deepEqual({ ...d.prepare('SELECT source,carried_from_generation FROM usage_paid_operations WHERE id=?').get(report.carriedReceipt) },
        { source: 'anthropic:messages', carried_from_generation: report.replacedGeneration });
      const carriedClaim = load('src/main/recovery.ts').inspectRecovery().observations.find(row => row.operationId === report.carriedReceipt);
      assert.equal(carriedClaim.billing, 'unresolved', 'carrying is not settling');
      assert.match(carriedClaim.source, /carried across a restore from generation/);
      assert.equal(d.prepare("SELECT state FROM queue WHERE id='historical-job'").get().state, 'waiting');
      assert.equal(d.prepare("SELECT next_at FROM schedules WHERE id='historical-schedule'").get().next_at, 1);
      let ran = 0;
      const queue = load('src/main/queue.ts');
      queue.registerRunner('headless', async () => { ran++; });
      try { await queue.tick(); } catch (error) { assert.match(String(error), /inspection|read.only|held/i); }
      try { await load('src/main/schedule.ts').tickSchedules(); } catch (error) { assert.match(String(error), /inspection|read.only|held/i); }
      assert.equal(ran, 0, 'restored historical work never replays');
      assert.equal(d.prepare("SELECT state FROM queue WHERE id='historical-job'").get().state, 'waiting');
      assert.throws(() => d.prepare("UPDATE settings SET v='must not write' WHERE k='fixture-spend-history'").run(), /inspection|read.only|held/i);
      assert.throws(() => storage.assertStorageAdmission({ automatic: true, paid: true }), /historical|spending/i);
      console.log('Backup recovery reopen: restored history readable, mutations refused, automation/spending holds durable across real Electron restart.');
    }
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
}

async function main() {
  if (process.versions.electron) return electronFixture();
  assert.equal(process.versions.node, '22.23.2');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-backup-recovery-')));
  try {
    const electron = require('electron');
    for (const version of [2, 1, 0]) {
      const fixtureRoot = path.join(directory, `v${version}`);
      fs.mkdirSync(fixtureRoot);
      for (const name of ['user-data', 'home', 'provider-packs']) fs.mkdirSync(path.join(fixtureRoot, name));
      const env = { PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: path.join(fixtureRoot, 'home'),
        TMPDIR: os.tmpdir(), SHELL: '/bin/sh', WANIGAN_PROVIDER_PACKS_DIR: path.join(fixtureRoot, 'provider-packs'), WANIGAN_MOCK: '1', WANIGAN_SMOKE: '1' };
      // The environment is built from nothing so no credential or shell state
      // reaches the child. The display is the one thing the host must supply:
      // on Linux CI the suite runs under xvfb-run, and an Electron started
      // without its DISPLAY dies with "Missing X server" before main runs.
      for (const name of ['DISPLAY', 'XAUTHORITY']) if (process.env[name]) env[name] = process.env[name];
      for (const phase of version === 0 ? ['fault', 'fault-reopen'] : ['restore', 'reopen']) {
        const args = [__filename, phase, fixtureRoot, String(version), '--use-mock-keychain'];
        const native = process.platform === 'darwin' && fs.existsSync('/usr/bin/script');
        const result = cp.spawnSync(native ? '/usr/bin/script' : electron,
          native ? ['-q', '/dev/null', electron, ...args] : args,
          { cwd: root, env, encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 90_000 });
        process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
        assert.equal(result.status, 0, `v${version} ${phase} failed: ${result.error || result.signal || result.status}`);
      }
    }
    console.log('Backup recovery: v1/v2 and failed swap through 6 real Electron processes; rebased v2 artifacts, v1 artifact retention, historical jobs held; isolated data/provider roots; $0 provider spend.');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
