// Production storage protocol, real SQLite files and separate Node processes.
// The adapter supplies better-sqlite3's synchronous interface to node:sqlite;
// no provider process, credentials, scheduler registration or production root.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

class Sqlite {
  constructor(file, options = {}) {
    if (options.fileMustExist && !fs.existsSync(file)) throw new Error('Database file missing');
    this.native = new DatabaseSync(file, { readOnly: options.readonly === true });
    this.open = true;
  }
  prepare(sql) {
    const native = this.native.prepare(sql);
    const result = { readonly: /^\s*(?:SELECT|EXPLAIN|PRAGMA\s+(?![^;]*=))/i.test(sql), database: this,
      run: (...args) => native.run(...args), get: (...args) => native.get(...args), all: (...args) => native.all(...args),
      iterate: (...args) => native.iterate(...args) };
    return result;
  }
  pragma(sql, options) {
    const rows = this.native.prepare(`PRAGMA ${sql}`).all();
    return options?.simple ? Object.values(rows[0] || {})[0] : rows;
  }
  exec(sql) { this.native.exec(sql); return this; }
  transaction(fn) {
    const run = (...args) => {
      this.native.exec('BEGIN IMMEDIATE');
      try { const value = fn(...args); this.native.exec('COMMIT'); return value; }
      catch (error) { this.native.exec('ROLLBACK'); throw error; }
    };
    run.immediate = run.deferred = run.exclusive = run;
    return run;
  }
  close() { this.native.close(); this.open = false; }
}

function fixture(directory) {
  const cache = new Map();
  const stubs = { electron: { app: { getPath: () => directory } }, 'better-sqlite3': Sqlite };
  function load(relative) {
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
  const maintenance = load('src/main/storage-maintenance.ts');
  return { ...maintenance, settings: () => load('src/main/settings.ts'), open() {
    const database = load('src/main/modules/storage-connection.ts').openStorageConnection(d => {
      d.exec('CREATE TABLE IF NOT EXISTS fixture(value TEXT); CREATE TABLE IF NOT EXISTS queue(state TEXT); CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT NOT NULL)');
    });
    stubs['src/main/db.ts'] = { db: () => database };
    cache.set('src/main/db.ts', { exports: stubs['src/main/db.ts'] });
    return database;
  } };
}

const safeEnv = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, NODE_NO_WARNINGS: '1' };
function worker(directory) {
  const child = cp.fork(__filename, ['worker', directory], { env: safeEnv, stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const pending = new Map();
  let sequence = 0;
  child.on('message', message => { pending.get(message.id)?.(message); pending.delete(message.id); });
  const ready = new Promise((resolve, reject) => {
    child.once('message', resolve); child.once('error', reject);
  });
  return { child, ready, async command(command, input) {
    const id = ++sequence;
    const result = new Promise(resolve => { pending.set(id, resolve); });
    child.send({ id, command, input });
    const answer = await result;
    if (answer.error) throw new Error(answer.error);
    return answer.result;
  }, async stop() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.send({ command: 'exit' }); await exited;
    assert.equal(child.exitCode, 0, 'a graceful fixture participant closed without a runtime error');
  }, async crash() {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
  } };
}

async function serve(directory) {
  const f = fixture(directory);
  let d, cached, transaction, iterator, restore;
  process.on('message', message => {
    if (message.command === 'exit') { if (d?.open) d.close(); process.exit(0); }
    try {
      let result;
      switch (message.command) {
        case 'open':
          d = f.open(); cached = d.prepare('INSERT INTO fixture VALUES(?)');
          transaction = d.transaction(value => cached.run(value));
          iterator = d.prepare('SELECT value FROM fixture').iterate();
          result = f.storageStatus(); break;
        case 'legacy-open': d = new Sqlite(path.join(directory, 'wanigan.db')); result = 'legacy handle opened'; break;
        case 'legacy-write': result = d.prepare('INSERT INTO fixture VALUES(?)').run(message.input); break;
        case 'write': result = cached.run(message.input); break;
        case 'write-transaction': result = transaction(message.input); break;
        case 'write-statement-db': result = cached.database.exec("INSERT INTO fixture VALUES('escape')"); result = 'wrote'; break;
        case 'next': result = iterator.next(); break;
        case 'setting': result = f.settings().getSetting('fixture', 'fallback'); break;
        case 'ddl': result = d.exec(message.input); result = 'executed'; break;
        case 'disable-readonly': result = d.pragma('query_only=OFF'); break;
        case 'pragma': result = d.pragma(message.input, { simple: true }); break;
        case 'prepare-sql': d.prepare(message.input); result = 'prepared'; break;
        case 'transaction-factory': d.transaction(() => {}); result = 'prepared'; break;
        case 'values': result = d.prepare('SELECT value FROM fixture').all(); break;
        case 'close': d.close(); result = 'closed'; break;
        case 'status': result = f.storageStatus(); break;
        case 'admit': f.assertStorageAdmission(message.input); result = 'admitted'; break;
        case 'begin': {
          const current = f.storageStatus();
          const staging = path.join(directory, 'staging'), replaced = path.join(directory, 'retained');
          fs.mkdirSync(staging, { recursive: true });
          restore = f.beginStorageRestore({ expectedGeneration: message.input?.generation ?? current.generation,
            expectedRevision: message.input?.revision ?? current.revision, source: '/synthetic-backup', manifestDigest: 'a'.repeat(64),
            stagingDir: staging, replacedDir: replaced,
            validateCurrent: () => { if (message.input?.unsafe) throw new Error('unresolved execution/liability'); } });
          result = { id: restore.id, generation: restore.generation }; break;
        }
        case 'prepare': {
          const staged = new Sqlite(path.join(directory, 'staging', 'wanigan.db'));
          staged.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('archived'); CREATE TABLE queue(state TEXT); INSERT INTO queue VALUES('waiting')");
          restore.prepareRestoredDatabase(staged); staged.close(); result = 'prepared'; break;
        }
        case 'close-restore': restore.closeCurrent(); result = 'closed'; break;
        case 'swap':
          restore.beforeSwap(); fs.mkdirSync(path.join(directory, 'retained'));
          fs.renameSync(path.join(directory, 'wanigan.db'), path.join(directory, 'retained', 'wanigan.db'));
          fs.renameSync(path.join(directory, 'staging', 'wanigan.db'), path.join(directory, 'wanigan.db'));
          result = 'swapped'; break;
        case 'publish': restore.publish(); result = f.storageStatus(); break;
        case 'cancel': restore.cancel(); result = f.storageStatus(); break;
        case 'fail': restore.fail('fixture failure after close'); result = f.storageStatus(); break;
        default: throw new Error(`Unknown test command: ${message.command}`);
      }
      process.send({ id: message.id, result }, error => { if (error) process.exitCode = 1; });
    } catch (error) { process.send({ id: message.id, error: String(error) }); }
  });
  process.send({ ready: true });
}

async function scenario(name, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-storage-maintenance-'));
  const workers = [];
  async function start() { const w = worker(directory); workers.push(w); await w.ready; return w; }
  try { await run(directory, start); console.log(`ok - ${name}`); }
  finally { for (const w of workers) await w.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
}

async function main() {
  await scenario('foreign SQLite handle refuses; exact close permits; third startup remains outside; cached handles fenced; inspection holds history', async (directory, start) => {
    const a = await start(), b = await start();
    const initial = await a.command('open');
    assert.equal(await a.command('setting'), 'fallback');
    assert.equal((await a.command('status')).revision, initial.revision, 'no-op lazy schema read does not invalidate a preview');
    await b.command('open');
    await b.command('write', 'newer-evidence');
    await assert.rejects(a.command('begin'), /not acknowledged closed handles/);
    assert.equal((await a.command('status')).mode, 'active');
    await b.command('close');
    await assert.rejects(b.command('write', 'late'), /fenced/);
    await assert.rejects(b.command('write-transaction', 'late'), /fenced/);
    await assert.rejects(b.command('write-statement-db'), /fenced/);
    await assert.rejects(b.command('next'), /fenced/);
    await assert.rejects(a.command('begin', initial), /changed after review/);
    await assert.rejects(a.command('begin', { unsafe: true }), /unresolved execution\/liability/);
    await a.command('begin');
    await assert.rejects(a.command('write', 'late'), /fenced/);
    await assert.rejects(a.command('admit'), /maintenance/);
    const third = await start(); await assert.rejects(third.command('open'), /database stays closed/);
    await a.command('prepare'); await a.command('close-restore'); await a.command('swap');
    const published = await a.command('publish');
    assert.equal(published.mode, 'inspection'); assert(published.automationHeld && published.spendingHeld);
    await assert.rejects(a.command('publish'), /already been applied/);
    await assert.rejects(a.command('write', 'late'), /fenced/);
    assert(fs.existsSync(path.join(directory, 'retained', 'wanigan.db')));
    const reopened = await start(); await reopened.command('open');
    assert.deepEqual(await reopened.command('values'), [{ value: 'archived' }]);
    assert.equal(await reopened.command('setting'), 'fallback', 'real Settings getter permits its no-op lazy CREATE');
    assert.equal(await reopened.command('pragma', 'query_only'), 0);
    await assert.rejects(reopened.command('pragma', 'query_only=ON'), /read-only/);
    assert.equal(await reopened.command('pragma', 'query_only'), 0, 'a refused PRAGMA cannot mutate during speculative native preparation');
    for (const sql of ['PRAGMA query_only=ON', '/* comment */ PRAGMA query_only(ON)', '; -- comment\n PRAGMA query_only=ON', 'EXPLAIN PRAGMA query_only=ON', 'EXPLAIN QUERY PLAN /* comment */ PRAGMA query_only=ON', 'EXPLAIN /*a*/ QUERY /*b*/ PLAN /*c*/ PRAGMA query_only=ON']) {
      await assert.rejects(reopened.command('prepare-sql', sql), /read-only/);
      assert.equal(await reopened.command('pragma', 'query_only'), 0, `preparing a refused statement has no connection side effect: ${sql}`);
    }
    await assert.rejects(reopened.command('ddl', 'CREATE TABLE IF NOT EXISTS new_table(value TEXT)'), /readonly|read-only/);
    await assert.rejects(reopened.command('ddl', "CREATE TABLE IF NOT EXISTS fixture(value TEXT); INSERT INTO fixture VALUES('injected')"), /read-only/);
    await assert.rejects(reopened.command('disable-readonly'), /read-only/);
    await assert.rejects(reopened.command('write', 'replay'), /read-only/);
    await assert.rejects(reopened.command('write-transaction', 'replay'), /read-only/);
    await assert.rejects(reopened.command('admit', { automatic: true }), /inspection mode/);
    await assert.rejects(reopened.command('admit', { paid: true }), /spending is historical/);
    assert.equal(fs.statSync(path.join(directory, '.storage-control')).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(directory, '.storage-control', 'journal.sqlite')).mode & 0o777, 0o600);
  });
  await scenario('observed unregistered legacy SQLite handle refuses without treating its PID as authority', async (_directory, start) => {
    const a = await start(), legacy = await start();
    await a.command('open'); await legacy.command('legacy-open');
    await assert.rejects(a.command('begin'), /unregistered\/legacy database handles/);
    const reviewed = await a.command('status');
    await legacy.command('legacy-write', 'outside-control-journal');
    await legacy.command('close');
    await assert.rejects(a.command('begin', reviewed), /changed after review/, 'SQLite data_version binds a native commit even without a matching control revision');
    await a.command('begin'); await a.command('cancel');
  });
  await scenario('cancellation before close is reversible; a second coordinator cannot seize the barrier', async (_directory, start) => {
    const a = await start(); await a.command('open'); await a.command('begin');
    await assert.rejects(a.command('begin'), /unfinished storage operation/);
    await assert.rejects(a.command('pragma', 'query_only=ON'), /fenced/);
    await assert.rejects(a.command('prepare-sql', 'PRAGMA query_only=ON'), /fenced/);
    await assert.rejects(a.command('transaction-factory'), /fenced/);
    assert.equal((await a.command('cancel')).mode, 'active');
    assert.equal(await a.command('pragma', 'query_only'), 0, 'maintenance refusal precedes native PRAGMA preparation');
    await a.command('write', 'still-live');
    await assert.rejects(a.command('cancel'), /already been applied/);
  });
  for (const phase of ['prepared', 'closed', 'swapping', 'published']) {
    await scenario(`coordinator crash at ${phase} preserves identifiable generation and journal`, async (directory, start) => {
      const a = await start(); await a.command('open'); await a.command('begin'); await a.command('prepare');
      if (phase !== 'prepared') await a.command('close-restore');
      if (['swapping', 'published'].includes(phase)) await a.command('swap');
      if (phase === 'published') await a.command('publish');
      await a.crash();
      const b = await start(), status = await b.command('status');
      assert.equal(status.operation.phase, phase);
      if (phase === 'published') {
        await b.command('open'); await assert.rejects(b.command('write', 'replay'), /read-only/);
      } else { await assert.rejects(b.command('open'), /database stays closed/); }
      if (['swapping', 'published'].includes(phase)) assert(fs.existsSync(path.join(directory, 'retained', 'wanigan.db')));
    });
  }
  await scenario('dead participant is retained with no PID or lease takeover', async (_directory, start) => {
    const a = await start(); await a.command('open'); await a.crash();
    const b = await start(); await b.command('open');
    await assert.rejects(b.command('begin'), /identity\/liveness unproven/);
  });
  await scenario('out-of-band main database replacement fences cached handles and reopening', async (directory, start) => {
    const a = await start(); await a.command('open');
    const file = path.join(directory, 'wanigan.db');
    fs.renameSync(file, file + '.retained'); fs.copyFileSync(file + '.retained', file);
    await assert.rejects(a.command('write', 'old-inode'), /database file identity changed/);
    const b = await start(); await assert.rejects(b.command('open'), /database file identity changed/);
    assert(fs.existsSync(file + '.retained'));
    await a.crash(); await b.crash();
  });
  await scenario('incompatible participant protocol and corrupt operation phases refuse mutation', async (directory, start) => {
    const a = await start(); await a.command('open');
    const journal = new Sqlite(path.join(directory, '.storage-control', 'journal.sqlite'));
    journal.exec('UPDATE participants SET protocol=2');
    await assert.rejects(a.command('begin'), /incompatible or corrupt participant/);
    journal.exec('UPDATE participants SET protocol=1');
    await a.command('begin');
    journal.exec("UPDATE restores SET phase='unrecognized'");
    await assert.rejects(a.command('write', 'unsafe'), /corrupt or unsupported/);
    const b = await start(); await assert.rejects(b.command('open'), /corrupt or unsupported/);
    journal.close(); await a.crash(); await b.crash();
  });
  for (const corruption of ['missing-journal', 'missing-marker', 'corrupt-marker', 'replaced-journal', 'removed-directory']) {
    await scenario(`${corruption} fails closed with cached handle and on restart`, async (directory, start) => {
      const a = await start(); await a.command('open');
      const control = path.join(directory, '.storage-control'), file = path.join(control, 'journal.sqlite'), marker = path.join(control, 'format.json');
      if (corruption === 'missing-journal') fs.unlinkSync(file);
      if (corruption === 'missing-marker') fs.unlinkSync(marker);
      if (corruption === 'corrupt-marker') fs.writeFileSync(marker, '{broken');
      if (corruption === 'replaced-journal') { fs.renameSync(file, file + '.retained'); fs.copyFileSync(file + '.retained', file); }
      if (corruption === 'removed-directory') fs.renameSync(control, control + '.retained');
      await assert.rejects(a.command('write', 'unsafe'), /Storage recovery required/);
      const b = await start();
      if (corruption === 'replaced-journal') {
        // A newly started process sees the same complete persisted coordination
        // content; the abandoned original handle can never acknowledge closure.
        await b.command('open'); await assert.rejects(b.command('begin'), /not acknowledged closed handles/);
      } else await assert.rejects(b.command('open'), /Storage recovery required/);
      await a.crash(); await b.crash();
    });
  }
  console.log('Storage maintenance: 15 adversarial process scenarios passed; zero provider calls.');
}

if (process.argv[2] === 'worker') void serve(process.argv[3]);
else main().catch(error => { console.error(error); process.exitCode = 1; });
