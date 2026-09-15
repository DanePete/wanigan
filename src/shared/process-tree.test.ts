/**
 * The process-table and listening-port readers. Fixture lines are the byte
 * shapes macOS `ps -axww -o pid,ppid,pgid,%cpu,rss,etime,time,command` and
 * `lsof -nP -iTCP -sTCP:LISTEN` printed on the machine that wrote this
 * (Darwin 25.5), including the empty `lsof` answer, which exits 1 with no
 * output at all when nothing listens.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cpuIdle, descendantsOf, observe, parseCpuTime, parseEtime, parseLsofListen, parsePsTable,
  recordFrom, sameProcess, survivors, lsofListenArgs, PS_ARGS,
} from './process-tree.ts';

const PS = [
  '  PID  PPID  PGID  %CPU    RSS     ELAPSED      TIME COMMAND',
  '    1     0     1   0.1  19776 06-13:53:08  96:45.24 /sbin/launchd',
  '  500     1   500   0.0  16320    01:00:00   0:00.10 /Applications/Wanigan.app/Contents/MacOS/Wanigan',
  '  600   500   600   2.5 120000       10:05   0:12.34 claude --session-id 11111111-2222-4333-8444-555555555555',
  '  601   600   600   0.0   4000       09:00   0:00.02 /bin/zsh -c npm run dev',
  '  602   601   600  12.0  90000       08:59   1:02.50 node /repo/node_modules/.bin/vite --port 5173',
  '  700     1   700   0.0   2000       00:03   0:00.00 /usr/bin/unrelated',
].join('\n');

test('the ps table parses every well-formed row and skips the header', () => {
  const rows = parsePsTable(PS);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[3], {
    pid: 601, ppid: 600, pgid: 600, cpuPercent: 0, rssKb: 4000, elapsedSeconds: 540, cpuSeconds: 0.02,
    command: '/bin/zsh -c npm run dev',
  });
  assert.equal(rows[0].elapsedSeconds, 6 * 86_400 + 13 * 3600 + 53 * 60 + 8);
  assert.equal(rows[0].cpuSeconds, 96 * 60 + 45.24);
});

test('empty and odd ps output reads as no rows, never as a thrown error', () => {
  assert.deepEqual(parsePsTable(''), []);
  assert.deepEqual(parsePsTable('\n\n'), []);
  assert.deepEqual(parsePsTable('  PID  PPID  PGID  %CPU    RSS     ELAPSED      TIME COMMAND\n'), []);
  // A truncated line, a non-numeric pid and a mangled etime are each dropped;
  // the good line between them survives.
  const odd = [
    '  12   1',
    ' abc   1   1  0.0  10  00:01  0:00.00 /bin/x',
    '  13   1  13  0.0  10  99:99  0:00.00 /bin/bad-etime',
    '  14   1  14  0.0  10  00:01  0:00.00 /bin/good arg with spaces  ',
  ].join('\n');
  const rows = parsePsTable(odd);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].command, '/bin/good arg with spaces');
});

test('etime and cpu time accept every shape ps prints and nothing else', () => {
  assert.equal(parseEtime('00:03'), 3);
  assert.equal(parseEtime('01:00:00'), 3600);
  assert.equal(parseEtime('2-00:00:01'), 172_801);
  assert.equal(parseEtime('61:00'), 3660, 'minutes-seconds with no hour field may pass sixty minutes');
  assert.equal(parseEtime('1:61:00'), null);
  assert.equal(parseEtime('soon'), null);
  assert.equal(parseCpuTime('0:00.02'), 0.02);
  assert.equal(parseCpuTime('1:02:03.5'), 3723.5);
  assert.equal(parseCpuTime('1-00:00:00'), 86_400);
  assert.equal(parseCpuTime('0:99.00'), null);
});

test('descendants walk the ppid tree from the agent, and never loop on a malformed table', () => {
  const rows = parsePsTable(PS);
  assert.deepEqual(descendantsOf(rows, 600).map((r) => r.pid), [600, 601, 602]);
  assert.deepEqual(descendantsOf(rows, 999).map((r) => r.pid), [], 'a root not in the table has no tree');
  const cyclic = parsePsTable([
    '  10  11  10  0.0  1  00:01  0:00.00 a',
    '  11  10  10  0.0  1  00:01  0:00.00 b',
  ].join('\n'));
  assert.deepEqual(descendantsOf(cyclic, 10).map((r) => r.pid), [10, 11]);
});

const LSOF = [
  'COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
  'node        602 dane   23u  IPv6 0x7e557323286301a9      0t0  TCP [::1]:5173 (LISTEN)',
  'node        602 dane   24u  IPv4 0xf49268577760f397      0t0  TCP 127.0.0.1:5173 (LISTEN)',
  'node        602 dane   24u  IPv4 0xf49268577760f397      0t0  TCP 127.0.0.1:5173 (LISTEN)',
  'ControlCe   439 dane   10u  IPv4 0xf49268577760f397      0t0  TCP *:7000 (LISTEN)',
].join('\n');

test('listening sockets parse per pid, address and port, and collapse an exact repeat', () => {
  assert.deepEqual(parseLsofListen(LSOF), [
    { pid: 602, command: 'node', address: '[::1]', port: 5173 },
    { pid: 602, command: 'node', address: '127.0.0.1', port: 5173 },
    { pid: 439, command: 'ControlCe', address: '*', port: 7000 },
  ]);
});

test('the zero case: lsof with nothing listening prints nothing, and that is no ports', () => {
  assert.deepEqual(parseLsofListen(''), []);
  assert.deepEqual(parseLsofListen('COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n'), []);
  assert.deepEqual(parseLsofListen('lsof: WARNING: can\'t stat() fuse file system\n'), []);
});

test('the argv shapes are the verified ones, and a pid list is comma-joined', () => {
  assert.deepEqual([...PS_ARGS], ['-axww', '-o', 'pid,ppid,pgid,%cpu,rss,etime,time,command']);
  assert.deepEqual(lsofListenArgs([1, 22]), ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', '1,22']);
});

test('a reused pid is never the recorded process: the command and start time must both match', () => {
  const at = 1_000_000_000;
  const [row] = parsePsTable('  602   601   600  12.0  90000  08:59  1:02.50 node vite');
  const recorded = recordFrom(row, at);
  assert.equal(sameProcess(recorded, row, at), true);
  // Ten seconds later the same process has an etime ten seconds longer.
  const later = { ...row, elapsedSeconds: row.elapsedSeconds + 10 };
  assert.equal(sameProcess(recorded, later, at + 10_000), true);
  // Same pid, different program.
  assert.equal(sameProcess(recorded, { ...later, command: 'node other' }, at + 10_000), false);
  // Same pid and command, but started a minute after the recorded one.
  assert.equal(sameProcess(recorded, { ...row, elapsedSeconds: 5 }, at + 60_000), false);
});

test('survivors are only the recorded processes still running as themselves', () => {
  const at = 2_000_000_000;
  const rows = parsePsTable(PS);
  const recorded = descendantsOf(rows, 600).map((row) => recordFrom(row, at));
  const later = at + 30_000;
  const after = parsePsTable([
    // 600 is gone; 601 is gone; 602 was reparented to launchd and lives on.
    '  602     1   600   0.0  90000  09:29  1:02.50 node /repo/node_modules/.bin/vite --port 5173',
    // A new program now holds pid 601.
    '  601     1   601   0.0   1000  00:02  0:00.00 /usr/bin/something-else',
  ].join('\n'));
  assert.deepEqual(survivors(recorded, after, later).map((s) => s.recorded.pid), [602]);
  assert.deepEqual(survivors(recorded, [], later), []);
});

test('idle time is observed only once CPU was seen moving; before that it is a lower bound', () => {
  const at = 3_000_000_000;
  const [row] = parsePsTable('  602   601   600  0.0  90000  08:59  1:02.50 node vite');
  let recorded = recordFrom(row, at);
  assert.deepEqual(cpuIdle(recorded, at + 60_000), { ms: 60_000, basis: 'since-first-seen' });
  recorded = observe(recorded, { ...row, cpuSeconds: row.cpuSeconds + 0.5 }, at + 10_000);
  recorded = observe(recorded, { ...row, cpuSeconds: row.cpuSeconds + 0.5 }, at + 20_000);
  assert.deepEqual(cpuIdle(recorded, at + 80_000), { ms: 70_000, basis: 'observed' });
});
