// Foreign SQLite paths are untrusted filesystem entries. A blocked synchronous
// open must be killed by a parent that owns every temporary file the child uses.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const imports = `
  import assert from 'node:assert/strict';
  import Database from ${JSON.stringify(new URL('../../node_modules/better-sqlite3/lib/index.js', import.meta.url).href)};
  import fs from 'node:fs';
  import { execFileSync } from 'node:child_process';
  import { syncBuiltinESMExports } from 'node:module';
  import { join } from 'node:path';
  import { testCore } from ${JSON.stringify(new URL('./test-support.ts', import.meta.url).href)};
  import { readForeignDb } from ${JSON.stringify(new URL('./readonly-db.ts', import.meta.url).href)};

  function snapshot(folder) {
    return fs.readdirSync(folder).sort().map((name) => {
      const path = join(folder, name);
      const stat = fs.lstatSync(path);
      return { name, mode: stat.mode, ino: stat.ino, size: stat.size, mtime: stat.mtimeMs,
        bytes: stat.isFile() ? fs.readFileSync(path).toString('base64') : null,
        link: stat.isSymbolicLink() ? fs.readlinkSync(path) : null };
    });
  }
  function createIndex(file, cwd, marker) {
    const writer = new Database(file);
    try {
      writer.exec('CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, first_user_message TEXT)');
      writer.prepare('INSERT INTO threads VALUES (?,?,?,?)').run(
        '11111111-1111-4111-8111-111111111111', cwd, 'user', marker);
    } finally { writer.close(); }
  }
`;

function isolated(script: string): void {
  // Short paths keep the real core's Unix socket inside this cleanup root.
  const root = mkdtempSync('/tmp/wg-db-safety-');
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(temporary);
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', imports + script], {
      env: { HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
      timeout: 2_000, killSignal: 'SIGKILL', encoding: 'utf8',
    });
    assert.equal(result.error, undefined, `foreign database reading must finish within the child deadline: ${result.error?.message}\n${result.stdout}\n${result.stderr}`);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const kind of ['database', 'wal']) {
  test(`History refuses a FIFO ${kind} index component and answers the next owner call`, () => {
    isolated(`
      const t = await testCore();
      try {
        const project = await t.owner.call('projects.add', { path: t.projectDir });
        const account = join(t.dir, 'home', '.codex');
        fs.mkdirSync(account, { recursive: true });
        const file = join(account, 'state_5.sqlite');
        if (${JSON.stringify(kind)} === 'wal') createIndex(file, t.projectDir, 'A real index');
        execFileSync('/usr/bin/mkfifo', [${JSON.stringify(kind)} === 'wal' ? file + '-wal' : file]);
        const before = snapshot(account);
        console.log('reading ${kind} FIFO through history.list');
        await assert.rejects(t.owner.call('history.list', { projectId: project.id }), { code: 'refused' });
        assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
        assert.deepEqual(await t.owner.call('sessions.list', {}), []);
        assert.deepEqual(snapshot(account), before, 'the source entries and bytes stay untouched');
        assert.deepEqual(fs.readdirSync(process.env.TMPDIR).filter((name) => name.startsWith('wanigan-read-')), [], 'private copies are cleaned');
      } finally { await t.close(); }
    `);
  });
}

test('descriptor copying handles partial reads and writes with bounded storage and stops at the observed size', () => {
  isolated(`
    const file = join(process.env.HOME, 'state.sqlite');
    createIndex(file, process.env.HOME, 'A bounded copy');
    const writer = new Database(file);
    writer.exec('CREATE TABLE payload (body BLOB); INSERT INTO payload VALUES (zeroblob(200000))');
    writer.close();
    const before = fs.readFileSync(file);
    const initialSize = before.length;
    const appended = Buffer.alloc(4096, 123);
    const original = { open: fs.openSync, read: fs.readSync, write: fs.writeSync };
    let source, destination, readBytes = 0, reads = 0, writes = 0;
    fs.openSync = (...args) => {
      const fd = original.open(...args);
      if (args[0] === file && typeof args[1] === 'number') source = fd;
      if (args[1] === 'wx') destination = fd;
      return fd;
    };
    fs.readSync = (fd, buffer, offset, length, position) => {
      if (fd !== source) return original.read(fd, buffer, offset, length, position);
      assert.ok(buffer.length <= 64 * 1024, 'no file-sized scratch allocation');
      assert.ok(length <= 64 * 1024);
      assert.equal(position, readBytes, 'each read uses an explicit source offset');
      const count = original.read(fd, buffer, offset, Math.min(length, 32749), position);
      readBytes += count;
      if (!reads++) fs.appendFileSync(file, appended);
      return count;
    };
    fs.writeSync = (fd, buffer, offset, length, position) => {
      if (fd === destination) { writes++; length = Math.min(length, 4093); }
      return original.write(fd, buffer, offset, length, position);
    };
    syncBuiltinESMExports();
    let result;
    try {
      result = readForeignDb(file, (db) => ({
        size: fs.statSync(db.name).size,
        count: db.prepare('SELECT length(body) AS n FROM payload').get().n,
      }));
    } finally {
      fs.openSync = original.open; fs.readSync = original.read; fs.writeSync = original.write;
      syncBuiltinESMExports();
    }
    assert.deepEqual(result, { size: initialSize, count: 200000 });
    assert.equal(readBytes, initialSize, 'growth after fstat does not lengthen copying');
    assert.ok(reads > 1 && writes > reads, 'both partial-progress loops actually ran');
    assert.throws(() => fs.fstatSync(source), { code: 'EBADF' });
    assert.throws(() => fs.fstatSync(destination), { code: 'EBADF' });
    assert.deepEqual(fs.readFileSync(file), Buffer.concat([before, appended]), 'only the fixture writer appended');
    assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
  `);
});

for (const failure of ['read error', 'early EOF', 'write error', 'write zero']) {
  test(`a private-copy ${failure} refuses, closes descriptors and permits a clean retry`, () => {
    isolated(`
      const file = join(process.env.HOME, 'state.sqlite');
      createIndex(file, process.env.HOME, 'Retry works');
      const before = snapshot(process.env.HOME);
      const original = { open: fs.openSync, read: fs.readSync, write: fs.writeSync };
      let source, destination, injected = false, called = false;
      fs.openSync = (...args) => {
        const fd = original.open(...args);
        if (args[0] === file) source = fd;
        if (args[1] === 'wx') destination = fd;
        return fd;
      };
      fs.readSync = (fd, ...args) => {
        if (fd === source && ${JSON.stringify(failure)}.startsWith('read')) { injected = true; throw new Error('fixture read error'); }
        if (fd === source && ${JSON.stringify(failure)} === 'early EOF') { injected = true; return 0; }
        return original.read(fd, ...args);
      };
      fs.writeSync = (fd, ...args) => {
        if (fd === destination && ${JSON.stringify(failure)} === 'write error') { injected = true; throw new Error('fixture write error'); }
        if (fd === destination && ${JSON.stringify(failure)} === 'write zero') { injected = true; return 0; }
        return original.write(fd, ...args);
      };
      syncBuiltinESMExports();
      let result;
      try { result = readForeignDb(file, () => { called = true; return true; }); }
      finally {
        fs.openSync = original.open; fs.readSync = original.read; fs.writeSync = original.write;
        syncBuiltinESMExports();
      }
      assert.equal(injected, true);
      assert.equal(result, null);
      assert.equal(called, false, 'a failed copy never reaches the reader');
      assert.throws(() => fs.fstatSync(source), { code: 'EBADF' });
      assert.throws(() => fs.fstatSync(destination), { code: 'EBADF' });
      assert.deepEqual(snapshot(process.env.HOME), before);
      assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
      assert.equal(readForeignDb(file, (db) => db.prepare('SELECT first_user_message AS message FROM threads').get().message), 'Retry works');
      assert.deepEqual(snapshot(process.env.HOME), before);
      assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
    `);
  });
}

test('History reads an uncheckpointed WAL without altering any provider file', () => {
  isolated(`
    const t = await testCore();
    let writer;
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const account = join(t.dir, 'home', '.codex');
      fs.mkdirSync(account, { recursive: true });
      const file = join(account, 'state_5.sqlite');
      createIndex(file, t.projectDir, 'Checkpointed row');
      writer = new Database(file);
      writer.pragma('journal_mode = WAL');
      writer.pragma('wal_autocheckpoint = 0');
      writer.prepare('UPDATE threads SET first_user_message = ?').run('Only in the WAL');
      assert.ok(fs.statSync(file + '-wal').size > 0);
      const before = snapshot(account);
      const listed = await t.owner.call('history.list', { projectId: project.id });
      assert.equal(listed.length, 1);
      assert.equal(listed[0].firstPrompt, 'Only in the WAL');
      assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
      assert.deepEqual(snapshot(account), before, 'database, WAL and SHM remain byte-for-byte unchanged');
      assert.deepEqual(fs.readdirSync(process.env.TMPDIR).filter((name) => name.startsWith('wanigan-read-')), []);
    } finally { writer?.close(); await t.close(); }
  `);
});

test('regular databases and links to regular databases remain readable', () => {
  isolated(`
    const file = join(process.env.HOME, 'state.sqlite');
    const link = join(process.env.HOME, 'linked.sqlite');
    createIndex(file, process.env.HOME, 'Regular file');
    fs.symlinkSync(file, link);
    const before = snapshot(process.env.HOME);
    for (const path of [file, link]) {
      assert.equal(readForeignDb(path, (db) => db.prepare('SELECT first_user_message AS message FROM threads').get().message), 'Regular file');
    }
    assert.equal(readForeignDb(join(process.env.HOME, 'missing.sqlite'), () => true), null);
    assert.equal(readForeignDb(process.env.HOME, () => true), null);
    assert.deepEqual(snapshot(process.env.HOME), before);
    assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
  `);
});

for (const kind of ['database', 'wal']) {
  test(`a ${kind} path replaced by a FIFO after descriptor validation uses the pinned file`, () => {
    isolated(`
      const file = join(process.env.HOME, 'state.sqlite');
      createIndex(file, process.env.HOME, 'Pinned database');
      let writer;
      if (${JSON.stringify(kind)} === 'wal') {
        writer = new Database(file);
        writer.pragma('journal_mode = WAL');
        writer.pragma('wal_autocheckpoint = 0');
        writer.prepare('UPDATE threads SET first_user_message = ?').run('Pinned WAL');
      }
      const target = ${JSON.stringify(kind)} === 'wal' ? file + '-wal' : file;
      const originalBytes = fs.readFileSync(target);
      const inode = fs.statSync(target).ino;
      const fstat = fs.fstatSync;
      let replaced = false;
      // Replace exactly after the real descriptor metadata is obtained. No
      // production hook is needed, and only this isolated child's fs is patched.
      fs.fstatSync = (...args) => {
        const stat = fstat(...args);
        if (!replaced && stat.ino === inode) {
          replaced = true;
          fs.renameSync(target, target + '.held');
          execFileSync('/usr/bin/mkfifo', [target]);
        }
        return stat;
      };
      syncBuiltinESMExports();
      try {
        assert.equal(readForeignDb(file, (db) => db.prepare('SELECT first_user_message AS message FROM threads').get().message),
          ${JSON.stringify(kind)} === 'wal' ? 'Pinned WAL' : 'Pinned database');
        assert.equal(replaced, true, 'the path was actually replaced at the descriptor boundary');
        assert.ok(fs.lstatSync(target).isFIFO());
        assert.deepEqual(fs.readFileSync(target + '.held'), originalBytes);
        assert.deepEqual(fs.readdirSync(process.env.TMPDIR), []);
      } finally {
        fs.fstatSync = fstat;
        syncBuiltinESMExports();
        if (replaced) { fs.unlinkSync(target); fs.renameSync(target + '.held', target); }
        writer?.close();
      }
    `);
  });
}
