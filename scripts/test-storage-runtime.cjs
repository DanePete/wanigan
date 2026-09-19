// Required Storage host admission. No Electron, network or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/main/modules/storage-runtime.ts'), 'utf8');
function fixture(maintenance = false) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  vm.runInThisContext(`(function(module,exports,process){${code}\n})`)(module, module.exports,
    { argv: maintenance ? ['fixture', '--storage-maintenance'] : ['fixture'] });
  return module.exports;
}
async function main() {
  const active = fixture();
  active.assertStorageRuntimeRestoreReady();
  active.markStorageRuntimeStarted();
  assert.throws(() => active.assertStorageRuntimeRestoreReady(), /fresh maintenance startup/);
  const maintenance = fixture(true);
  assert.throws(() => maintenance.markStorageRuntimeStarted(), /reserved for storage/);
  let entered = 0;
  for (const channel of ['batch:dryRun', 'learning:probe', 'sessions:create', 'git:pull', 'settings:set', 'providers:list']) {
    await assert.rejects(maintenance.storageIpcScope(channel, () => entered++), /Only Backup, Recovery/);
  }
  assert.equal(entered, 0);
  assert.equal(await maintenance.storageIpcScope('recovery:inspect', () => 'local evidence'), 'local evidence');
  let finish;
  const pending = maintenance.storageIpcScope('backup:create', () => new Promise(resolve => { finish = resolve; }));
  assert.throws(() => maintenance.assertStorageRuntimeRestoreReady(), /in-flight/);
  finish(); await pending;
  await maintenance.storageIpcScope('backup:restore', () => maintenance.assertStorageRuntimeRestoreReady());
  await assert.rejects(maintenance.storageIpcScope('backup:inspect', () => { throw new Error('canceled fixture'); }), /canceled fixture/);
  maintenance.assertStorageRuntimeRestoreReady();
  const restored = fixture();
  restored.holdStorageRuntimeForInspection();
  await assert.rejects(restored.storageIpcScope('learning:probe', () => entered++), /restarting does not reconcile/);
  assert.equal(await restored.storageIpcScope('recovery:inspect', () => 'retained history'), 'retained history');
  assert.equal(entered, 0);
  console.log('Storage runtime: fresh startup, monotonic live-service refusal, offline allowlist, asynchronous drain, failed-call drain and restored inspection gates passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
