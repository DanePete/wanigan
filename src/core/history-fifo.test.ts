// A special transcript must not hold the core's event loop waiting for a writer.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readTranscript, transcriptSummary } from './history-transcript.ts';

/** The parent owns the fixture and timeout, even when the child's event loop is blocked. */
function isolated(script: string): void {
  // Keep Unix socket paths short enough to stay inside the parent's cleanup root.
  const root = mkdtempSync('/tmp/wg-history-fifo-');
  const home = join(root, 'home');
  const temporary = join(root, 'tmp');
  mkdirSync(home);
  mkdirSync(temporary);
  try {
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { HOME: home, TMPDIR: temporary, PATH: '/usr/bin:/bin', ELECTRON_RUN_AS_NODE: '1' },
      timeout: 5_000, killSignal: 'SIGKILL', stdio: 'pipe',
    }), 'a transcript read must refuse a FIFO without waiting for a writer');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('History refuses an in-account Codex FIFO and remains responsive', () => {
  isolated(`
    import assert from 'node:assert/strict';
    import Database from ${JSON.stringify(new URL('../../node_modules/better-sqlite3/lib/index.js', import.meta.url).href)};
    import { execFileSync } from 'node:child_process';
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { testCore } from ${JSON.stringify(new URL('./test-support.ts', import.meta.url).href)};
    const t = await testCore();
    try {
      const project = await t.owner.call('projects.add', { path: t.projectDir });
      const account = join(t.dir, 'home', '.codex');
      mkdirSync(account, { recursive: true });
      const fifo = join(account, 'rollout.jsonl');
      execFileSync('/usr/bin/mkfifo', [fifo]);
      const db = new Database(join(account, 'state_5.sqlite'));
      const id = '11111111-1111-4111-8111-111111111111';
      try {
        db.exec('CREATE TABLE threads (id TEXT, cwd TEXT, thread_source TEXT, rollout_path TEXT, first_user_message TEXT)');
        db.prepare('INSERT INTO threads VALUES (?,?,?,?,?)').run(id, t.projectDir, 'user', fifo, 'Read this');
      } finally { db.close(); }
      const listed = await t.owner.call('history.list', { projectId: project.id });
      assert.equal(listed.length, 1, 'the real Codex index reaches this FIFO');
      await assert.rejects(t.owner.call('history.read', { id: listed[0].id }), /regular file/i);
      assert.equal((await t.owner.call('core.hello', {})).role, 'owner');
      assert.deepEqual(await t.owner.call('sessions.list', {}), []);
    } finally { await t.close(); }
  `);
});

test('a transcript changed to a FIFO after discovery is refused during summary reading', () => {
  isolated(`
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    import { statSync, unlinkSync, writeFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { transcriptSummary } from ${JSON.stringify(new URL('./history-transcript.ts', import.meta.url).href)};
    const file = join(process.env.HOME, 'transcript.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'Before replacement' } }));
    const before = statSync(file);
    unlinkSync(file);
    execFileSync('/usr/bin/mkfifo', [file]);
    assert.throws(() => transcriptSummary(file, before.size, before.mtimeMs), /regular file/i);
  `);
});

test('transcript readers refuse directories and final-component links', () => {
  const root = mkdtempSync(join(tmpdir(), 'wg-history-special-'));
  try {
    const file = join(root, 'record.jsonl');
    const link = join(root, 'link.jsonl');
    writeFileSync(file, JSON.stringify({ type: 'user', message: { content: 'A regular transcript' } }) + '\n');
    symlinkSync(file, link);
    for (const read of [readTranscript, (path: string) => transcriptSummary(path, 1, 0)]) {
      assert.throws(() => read(root, 'claude'), /regular file|EISDIR/i);
      assert.throws(() => read(link, 'claude'), /ELOOP|symbolic link/i);
    }
    assert.equal(readTranscript(file, 'claude').turns[0]?.text, 'A regular transcript');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
