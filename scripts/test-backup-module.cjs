// Exercise the real required Backup module with explicit native-dialog/runtime doubles.
// No user database, Electron process, provider or filesystem mutation is involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function fixture() {
  const calls = [];
  const check = { createdAt: 1, latestEvidenceAt: 1, currentLatestEvidenceAt: 2,
    wouldDiscardNewer: true, transcripts: { files: 2 }, problems: [] };
  const state = { window: { isDestroyed: () => false }, sessions: [], headless: 0,
    save: { canceled: false, filePath: '/backup/new' },
    open: { canceled: false, filePaths: ['/backup/existing'] }, response: 1, check };
  const record = name => (...args) => { calls.push([name, ...args]); };
  const stubs = {
    'node:path': path,
    electron: {
      app: { getPath: name => `/fixture/${name}` },
      dialog: {
        showSaveDialog: async (...args) => { record('save')(...args); return state.save; },
        showOpenDialog: async (...args) => { record('open')(...args); return state.open; },
        showMessageBox: async (...args) => { record('message')(...args); return { response: state.response }; },
      },
    },
    '../backup': {
      createBackup: dir => { record('create')(dir); return { dir }; },
      inspectBackup: dir => { record('inspect')(dir); return state.check; },
      restoreBackup: (dir, opts) => { record('restore')(dir, opts); return { replacedDir: '/retained', relaunchRequired: true }; },
    },
    '../headless': { liveHeadlessCount: () => state.headless },
    '../sessions': { listSessions: () => state.sessions },
  };
  const source = fs.readFileSync(path.join(root, 'src/main/modules/backup.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const mod = { exports: {} };
  const pending = [];
  const wrapper = vm.runInThisContext(`(function(require,module,exports,setTimeout){${compiled}\n})`);
  wrapper(name => { assert(name in stubs, `Unexpected runtime dependency ${name}`); return stubs[name]; },
    mod, mod.exports, (fn, delay) => { assert.equal(delay, 0); pending.push(fn); });
  const module = mod.exports.backupModule;
  assert.equal(module.id, 'backup');
  assert(module.required.reason.includes('canonical evidence database'));
  assert.equal(module.migrate, undefined, 'conversion must not introduce or move legacy schemas');
  const handlers = new Map();
  module.ipc((channel, fn) => { assert(!handlers.has(channel)); handlers.set(channel, fn); }, {
    getWindow: () => state.window, relaunchAfterRestore: record('relaunch'),
  });
  assert.deepEqual([...handlers.keys()], ['backup:create', 'backup:inspect', 'backup:restore']);
  return { state, calls, handlers, pending };
}

async function main() {
  let f = fixture();
  f.state.window = null;
  for (const channel of f.handlers.keys()) assert.equal(await f.handlers.get(channel)(), null);
  assert.equal(f.calls.length, 0, 'headless host opens no native dialogs');

  f = fixture();
  f.state.save.canceled = true;
  assert.equal(await f.handlers.get('backup:create')(), null);
  assert(!f.calls.some(call => call[0] === 'create'));
  f.state.save.canceled = false;
  assert.deepEqual(await f.handlers.get('backup:create')(), { dir: '/backup/new' });
  const save = f.calls.find(call => call[0] === 'save')[2];
  assert(save.defaultPath.startsWith('/fixture/documents/wanigan-backup-'));
  assert.deepEqual(save.properties, ['createDirectory']);

  f = fixture();
  assert.equal(await f.handlers.get('backup:inspect')(), f.state.check);
  assert.deepEqual(f.calls.at(-1), ['inspect', '/backup/existing']);
  f.state.open.canceled = true;
  assert.equal(await f.handlers.get('backup:inspect')(), null);

  for (const active of ['session', 'headless']) {
    f = fixture();
    if (active === 'session') f.state.sessions = [{ status: 'starting' }];
    else f.state.headless = 1;
    await assert.rejects(f.handlers.get('backup:restore')(), /1 agent is still running/);
    assert.equal(f.calls.length, 0, 'live work refuses before dialogs');
  }
  f = fixture();
  f.state.open.canceled = true;
  assert.equal(await f.handlers.get('backup:restore')(), null);
  assert.deepEqual(f.calls.map(call => call[0]), ['open']);
  f = fixture();
  f.state.check.problems = [{ detail: 'Manifest mismatch' }];
  await assert.rejects(f.handlers.get('backup:restore')(), /Manifest mismatch/);
  assert.deepEqual(f.calls.map(call => call[0]), ['open', 'inspect']);
  f = fixture();
  f.state.response = 0;
  assert.equal(await f.handlers.get('backup:restore')(), null);
  assert(!f.calls.some(call => call[0] === 'restore'));

  f = fixture();
  const restored = await f.handlers.get('backup:restore')();
  assert.deepEqual(restored, { replacedDir: '/retained', relaunchRequired: true });
  assert.deepEqual(f.calls.at(-1), ['restore', '/backup/existing', { confirm: true, overwriteNewer: true }]);
  const confirm = f.calls.find(call => call[0] === 'message')[2];
  assert.deepEqual(confirm.buttons, ['Cancel', 'Replace the database']);
  assert.equal(confirm.defaultId, 0);
  assert(confirm.detail.includes('provider/MCP trust grants are not restored'));
  assert.equal(f.pending.length, 1, 'restart remains deferred until the IPC result can return');
  f.pending[0]();
  await Promise.resolve();
  assert.deepEqual(f.calls.at(-1), ['relaunch']);
  assert(f.calls.at(-2)[1].detail.includes('/retained'));

  const index = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8');
  assert(!/handle\('backup:/.test(index), 'host no longer owns Backup handlers');
  const registration = fs.readFileSync(path.join(root, 'src/main/modules/register.ts'), 'utf8');
  assert(registration.includes('registerModule(backupModule)'));
  console.log('Backup module: 3 unchanged IPC channels, native dialog cancellation, live-work refusals, manifest/overwrite consent and deferred host restart verified offline.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
