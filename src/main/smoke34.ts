import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/** The repository root when run from a checkout, as smoke3 resolves it. */
function sourceOf(rel: string): string {
  const a = app.getAppPath();
  const root = fs.existsSync(path.join(a, 'src', 'main')) ? a : process.cwd();
  try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return ''; }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitFor(test: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await test()) return true;
    await sleep(100);
  }
  return test();
}

/**
 * helper sweep · P5 runtime — what a session left running.
 *
 * A real process tree stands in for a PTY session: a shell that starts a TCP
 * listener in the background and then waits. The shell is killed the way a
 * session's agent dies, the listener is reparented to launchd, and the checks
 * below walk the whole path an operator would: the live tree with its port,
 * the survivor after the end, a Stop that is refused for a pid whose identity
 * changed, and a Stop that works.
 */
export async function runProcessHygieneSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · what a session left running');
  const watch = await import('./process-watch');
  watch.resetProcessWatch();

  const createdAt = Date.now() - 1_000;
  // The listener is Electron running as plain Node, so no other runtime has to
  // be installed for this to run. Port 0 asks the kernel for a free one.
  const script = "require('net').createServer().listen(0,'127.0.0.1',()=>{});setTimeout(()=>{},120000)";
  const root = spawn('/bin/sh', ['-c', `"$WANIGAN_NODE" -e "$WANIGAN_SCRIPT" & sleep 120`], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', WANIGAN_NODE: process.execPath, WANIGAN_SCRIPT: script, ELECTRON_RUN_AS_NODE: '1' },
  });
  const rootPid = root.pid!;
  let status: 'running' | 'exited' = 'running';
  let endedAt: number | null = null;
  const sessionId = 's_smoke_proc';
  watch.setProcessSessionSource(() => [{ id: sessionId, pid: rootPid, status, createdAt, endedAt, harnessId: 'claude-code' }]);

  try {
    let live = await watch.processesForSession(sessionId);
    const listening = await waitFor(async () => {
      await watch.sampleProcesses(true);
      live = await watch.processesForSession(sessionId);
      return live.ports.length > 0;
    }, 8_000);
    check(live.live && (live.tree?.processes ?? 0) >= 3,
      'a live session’s tree is read from ps: the agent, its shell children and what they started', live.tree);
    check(listening && live.ports.every((p) => p.address === '127.0.0.1' && p.port > 0),
      'the listening TCP port inside the tree is found with lsof', live.ports);
    check((live.tree?.rssBytes ?? 0) > 0, 'memory for the tree is summed from rss', live.tree?.rssBytes);
    const listenerPid = live.ports[0]?.pid ?? 0;

    const throttledAt = live.sampledAt;
    await watch.processesForSession(sessionId);
    check((await watch.processesForSession(sessionId)).sampledAt === throttledAt,
      'a second read inside ten seconds reuses the sample instead of running ps again');

    const whileLive = await watch.stopSurvivor(sessionId, listenerPid);
    check(whileLive.outcome === 'refused' && alive(listenerPid),
      'Stop is refused while the session still runs — ending the session is a different button', whileLive);

    // The agent dies the way a PTY child does. Its background listener is
    // reparented to launchd and keeps its port.
    process.kill(rootPid, 'SIGKILL');
    await waitFor(() => !alive(rootPid), 3_000);
    status = 'exited';
    endedAt = Date.now();
    await watch.sampleProcesses(true);
    const after = await watch.processesForSession(sessionId);
    const survivor = after.survivors.find((s) => s.pid === listenerPid);
    check(!after.live && !!survivor, 'after the session ends, the recorded listener is listed as still running', after.survivors);
    check(!!survivor && survivor.ports.length > 0, 'and it still names the port it holds', survivor?.ports);
    check(!!survivor && survivor.cpuIdleMs >= 0 && (survivor.cpuIdleBasis === 'observed' || survivor.cpuIdleBasis === 'since-first-seen'),
      'with a CPU idle time that says whether it was observed or is a lower bound', survivor);
    const across = await watch.allSurvivors();
    check(across.some((r) => r.sessionId === sessionId), 'the cross-session list carries it too, so a closed tab does not hide it');

    const notRecorded = await watch.stopSurvivor(sessionId, process.pid);
    check(notRecorded.outcome === 'refused', 'Stop refuses a pid Wanigan never recorded in that session — Wanigan itself included', notRecorded);
    const garbage = await watch.stopSurvivor(sessionId, '12; rm -rf /');
    check(garbage.outcome === 'refused', 'a renderer-supplied pid that is not an integer is refused before anything runs', garbage);

    // Pid reuse, stood up by changing what was recorded rather than waiting for
    // the kernel: the live process no longer matches, so nothing is signalled.
    const forged = watch.__test.forgeRecordedCommand(sessionId, listenerPid, 'some other program');
    const reused = await watch.stopSurvivor(sessionId, listenerPid);
    check(forged && reused.outcome === 'refused' && alive(listenerPid),
      'a pid whose command no longer matches the recorded one is never signalled', reused);

    // Re-record the real identity by resampling as a fresh live session, then stop it.
    watch.resetProcessWatch();
    const secondId = 's_smoke_proc_2';
    watch.setProcessSessionSource(() => [{ id: secondId, pid: listenerPid, status: 'running', createdAt, endedAt: null }]);
    await watch.sampleProcesses(true);
    watch.setProcessSessionSource(() => [{ id: secondId, pid: listenerPid, status: 'exited', createdAt, endedAt: Date.now() }]);
    const stopped = await watch.stopSurvivor(secondId, listenerPid);
    check((stopped.outcome === 'terminated' || stopped.outcome === 'killed') && await waitFor(() => !alive(listenerPid), 3_000),
      'Stop on a recorded survivor sends SIGTERM and the process is gone', stopped);

    const index = sourceOf('src/main/index.ts');
    check(/name: 'sessions',[\s\S]{0,400}captureBeforeStop\(\)[\s\S]{0,200}killAll\(\)[\s\S]{0,400}survivorCountAfter/.test(index),
      'Halt records the trees before it signals, and its sessions line counts what survived');
    check(index.includes('processWatch.setProcessSessionSource(() => listSessions())'),
      'the sampler is fed the real session list at the call site, not only in this suite');
  } finally {
    try { process.kill(-rootPid, 'SIGKILL'); } catch { /* group already gone */ }
    watch.resetProcessWatch();
    watch.setProcessSessionSource(() => []);
  }
}

/**
 * helper sweep · P5 runtime — honest Codex readers.
 *
 * A temporary Codex home with three rollouts: a plain one carrying a line that
 * is not JSON, one named `.jsonl` whose bytes are a zstd frame, and one named
 * `.jsonl.zst`. The real `~/.codex` is never walked: the health read is scoped
 * to the temporary home explicitly.
 */
export async function runCodexReaderSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · honest Codex readers');
  const os = await import('node:os');
  const health = await import('./codex-rollout-health');
  const usage = await import('./codex-usage');
  health.resetCodexReaderHealth();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-codex-home-'));
  try {
    const day = path.join(home, 'sessions', '2026', '09', '14');
    fs.mkdirSync(day, { recursive: true });
    const plain = path.join(day, 'rollout-2026-09-14T10-00-00-11111111-2222-4333-8444-555555555555.jsonl');
    fs.writeFileSync(plain, [
      JSON.stringify({ timestamp: '2026-09-14T10:00:00.000Z', type: 'session_meta', payload: { id: '11111111-2222-4333-8444-555555555555', cwd: home, source: 'cli' } }),
      '{"timestamp": "2026-09-14T10:00:01.000Z", "type": "event_msg", "payload": {"type": "tok',
      JSON.stringify({ timestamp: '2026-09-14T10:00:02.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 7 } } } }),
    ].join('\n') + '\n');
    const disguised = path.join(day, 'rollout-2026-09-14T11-00-00-22222222-2222-4333-8444-555555555555.jsonl');
    fs.writeFileSync(disguised, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x24, 0x00, 0x01, 0x00, 0x00]));
    const named = path.join(day, 'rollout-2026-09-14T12-00-00-33333333-2222-4333-8444-555555555555.jsonl.zst');
    fs.writeFileSync(named, Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00]));

    const snapshot = usage.__test.readSnapshot(plain);
    check(snapshot?.totalTokens === 107 && snapshot?.cacheRead === 40,
      'a plain rollout still reads its counters when one line in it is not JSON', snapshot);
    check(usage.__test.readSnapshot(disguised) === null,
      'a zstd frame under a .jsonl name yields no counters — and is not read as a zero-usage thread', null);

    const read = health.codexReaderHealth('0.154.0', true, [home]);
    const row = read.accounts[0];
    check(row?.rollouts === 3 && row.unreadable === 2,
      'the account is counted with 2 of 3 rollouts in a format this version cannot read', row);
    check(!!row && row.codecs.includes('zstd'), 'the codec is named from the file’s magic bytes', row?.codecs);
    check(!!row && row.unparsedLines === 1 && row.filesWithUnparsed === 1,
      'the reader’s refused line is counted, so format drift is visible rather than silent', row);
    check(read.cliVersion === '0.154.0', 'the Codex CLI version the readers ran against is recorded', read.cliVersion);
    const next = health.recordReaderCliVersion('0.155.0');
    check(next.version === '0.155.0' && next.previous === '0.154.0',
      'a new Codex CLI keeps the previous version beside it, so a format change can be dated', next);
    health.recordReaderCliVersion('0.154.0');

    const sessionsSrc = sourceOf('src/main/codex-sessions.ts');
    check(/rolloutFormatOf\(rolloutPath\)[\s\S]{0,900}cannot read \(compressed rollout\)/.test(sessionsSrc),
      'exact recovery refuses a compressed rollout by name instead of calling its metadata inconsistent');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    health.resetCodexReaderHealth();
  }
}
