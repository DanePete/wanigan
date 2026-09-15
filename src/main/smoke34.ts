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

/**
 * helper sweep · P5 runtime — headless runs that tell the truth.
 *
 * The refusal is walked through the two real entry points a prompt reaches:
 * startHeadlessRun, which the Runs view, the queue and a firing schedule all
 * call, and createSchedule. Neither may leave a run, a queue item or a schedule
 * behind, and both must leave a refusal row.
 */
export async function runHeadlessTruthSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · headless runs that tell the truth');
  const os = await import('node:os');
  const { db } = await import('./db');
  const headless = await import('./headless');
  const schedule = await import('./schedule');
  const guard = await import('./headless-guard');
  const { addProject, removeProject } = await import('./store');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-refuse-'));
  const project = await addProject(root);
  try {
    const runsBefore = (db().prepare('SELECT COUNT(*) n FROM runs').get() as { n: number }).n;
    const queueBefore = (db().prepare('SELECT COUNT(*) n FROM queue').get() as { n: number }).n;
    let message = '';
    try {
      await headless.startHeadlessRun({
        name: 'refuse login', providerId: 'claude', projectIds: [project.id], prompt: '/login',
        maxBudgetUsd: 1, timeoutMs: 60_000, isolate: false,
      } as Parameters<typeof headless.startHeadlessRun>[0]);
    } catch (error) { message = error instanceof Error ? error.message : String(error); }
    check(/only works in an interactive Claude Code terminal/.test(message) && /nothing was spent/.test(message),
      'a headless run whose prompt is /login is refused with the reason, before anything starts', message);
    const runsAfter = (db().prepare('SELECT COUNT(*) n FROM runs').get() as { n: number }).n;
    const queueAfter = (db().prepare('SELECT COUNT(*) n FROM queue').get() as { n: number }).n;
    check(runsAfter === runsBefore && queueAfter === queueBefore,
      'and it leaves no run row and no queue item behind', { runsBefore, runsAfter, queueBefore, queueAfter });
    const refusals = guard.recentRefusals(5);
    check(refusals[0]?.command === '/login' && refusals[0]?.harness === 'claude-code' && refusals[0]?.source === 'headless run',
      'the refusal is recorded with the command, the harness and where it came from', refusals[0]);

    // The allowed direction is asserted without calling startHeadlessRun: a
    // prompt the guard lets through would go on to launch a real agent, and
    // this suite never spends. The same classifier is what the entry point runs.
    const { classifyHeadlessPrompt } = await import('../shared/slash-commands');
    check(classifyHeadlessPrompt('claude-code', '/my-team-skill tidy the README').kind === 'allowed',
      'a skill or custom command is not refused by the slash-command guard');

    const schedulesBefore = schedule.listSchedules().length;
    let scheduleMessage = '';
    try {
      schedule.createSchedule({ name: 'nightly resume', cron: '0 3 * * *', kind: 'headless',
        payload: { prompt: '/resume', providerId: 'claude' }, projectId: project.id });
    } catch (error) { scheduleMessage = error instanceof Error ? error.message : String(error); }
    check(/\/resume/.test(scheduleMessage) && schedule.listSchedules().length === schedulesBefore,
      'a schedule whose prompt is /resume is refused at creation and never stored', scheduleMessage);
    check(guard.recentRefusals(1)[0]?.source === 'schedule', 'and the schedule refusal is recorded as a schedule');

    // Finer outcomes are written by runRow from the output it just stored; a
    // real agent cannot run offline, so the read side is exercised on a row and
    // the write side is asserted at its call site.
    const runId = `p5-outcome-${Date.now()}`;
    db().prepare(`INSERT INTO runs (id, name, model, status, config_json, kind, total_requests, created_at)
                  VALUES (?, 'outcomes', 'claude', 'ended', '{}', 'headless', 1, ?)`).run(runId, Date.now());
    db().prepare(`INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status, outcome, outcome_reason, outcome_detail)
                  VALUES (?, ?, ?, ?, 'succeeded', 'waiting_on_input', 'permission-denials', 'denied twice')`)
      .run(runId, project.id, project.name, project.path);
    const read = headless.headlessOutcomes(runId);
    check(read[project.id]?.kind === 'waiting_on_input' && read[project.id]?.reason === 'permission-denials',
      'a row’s finer outcome reads back beside its unchanged status', read);
    db().prepare('DELETE FROM runs WHERE id=?').run(runId);
    const src = sourceOf('src/main/headless.ts');
    check(/classifyHeadlessOutcome\(\{\s*harness: def\.harness, status, stdout, stderr, spawnFailed: outcome\.spawnError !== null,?\s*\}\)/.test(src)
      && /UPDATE headless_rows SET outcome=\?, outcome_reason=\?, outcome_detail=\?/.test(src),
    'runRow classifies every finished row from its own recorded output and stores the outcome');
  } finally {
    try { removeProject(project.id); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * helper sweep · P5 runtime — continue a Claude conversation in Codex.
 *
 * Against the installed Codex when there is one, with a synthetic two-turn
 * Claude transcript and a temporary HOME and CODEX_HOME. The real ~/.codex is
 * never an input: its import ledger's modification time is compared before and
 * after. No login exists in the temporary home, so a turn could not spend if
 * one started — and the importer is stopped if one does.
 */
export async function runCodexImportSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · continue a Claude conversation in Codex');
  const os = await import('node:os');
  const { db } = await import('./db');
  const importer = await import('./codex-import');
  const { detectProviders } = await import('./providers');
  const { ledgerThreadFor } = await import('../shared/codex-import');

  // The plan refuses what it cannot import, by name, before anything runs.
  const rowId = `s_p5_import_${Date.now()}`;
  db().prepare(`INSERT INTO session_log (id, conversation_id, provider_id, project_path, project_name, started_at, harness_id)
                VALUES (?, ?, 'codex', ?, 'p5', ?, 'codex')`).run(rowId, '11111111-2222-4333-8444-555555555555', os.tmpdir(), Date.now());
  const refused = await importer.planCodexImport(rowId, null);
  check(refused.refusal === 'Only a Claude Code conversation can be continued in Codex.',
    'a Codex conversation is refused as a source for the Claude → Codex import', refused.refusal);
  check(refused.notImported.includes('hooks') && refused.notImported.includes('MCP servers') && refused.notImported.includes('CLAUDE.md, AGENTS.md and memory'),
    'the plan lists what is never imported, for the consent dialog to show', refused.notImported);
  db().prepare('DELETE FROM session_log WHERE id=?').run(rowId);
  const guard = await importer.importIntoCodex('s_missing_row', null, '/tmp/x.jsonl').catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  check(!guard.ok, 'an import for a conversation Wanigan has no record of does not run', guard);

  const codex = (await detectProviders()).find((p) => p.harnessId === 'codex' && p.path);
  if (!codex?.path) {
    say('   (codex is not installed here: the live import checks are skipped, not passed)');
    return;
  }
  const realLedger = path.join(os.homedir(), '.codex', 'external_agent_session_imports.json');
  const realLedgerBefore = fs.existsSync(realLedger) ? fs.statSync(realLedger).mtimeMs : null;
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-codex-import-')));
  try {
    const home = path.join(root, 'home');
    const codexHome = path.join(root, 'codex');
    const work = path.join(root, 'work');
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    const sid = '11111111-2222-4333-8444-555555555555';
    const dir = path.join(home, '.claude', 'projects', work.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, `${sid}.jsonl`);
    const at = '2026-09-14T10:00:00.000Z';
    fs.writeFileSync(transcript, [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId: sid, cwd: work, timestamp: at, version: '2.1.271', userType: 'external', isSidechain: false, message: { role: 'user', content: 'Add a README line saying hello.' } },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', sessionId: sid, cwd: work, timestamp: at, version: '2.1.271', userType: 'external', isSidechain: false, message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content: [{ type: 'text', text: 'I added the line.' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome, TMPDIR: os.tmpdir() };

    const run = await importer.runSessionImport({ bin: codex.path, env, transcriptPath: transcript, cwd: work, title: null, timeoutMs: 60_000 });
    check(run.result.ok, 'Codex imports the synthetic Claude transcript into the temporary CODEX_HOME with no login', run.result);
    check(!run.observed.some((m) => /^(turn|item)\//.test(m)), 'the import starts no turn', run.observed);
    if (run.result.ok) {
      const ledger = fs.readFileSync(path.join(codexHome, 'external_agent_session_imports.json'), 'utf8');
      check(ledgerThreadFor(ledger, transcript) === run.result.threadId,
        'Codex’s own import ledger names the same thread the completed notification did', run.result.threadId);
      const rollouts: string[] = [];
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else rollouts.push(f); } };
      walk(path.join(codexHome, 'sessions'));
      check(rollouts.some((f) => f.includes(run.result.ok ? run.result.threadId : '-')),
        'and a resumable rollout for that thread exists in the temporary home', rollouts.length);
      check(!fs.existsSync(path.join(codexHome, 'hooks.json')) && !fs.existsSync(path.join(codexHome, 'config.toml')),
        'no hooks or config were written: only the conversation was imported');
    }

    const elsewhere = path.join(root, 'elsewhere', `${sid}.jsonl`);
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true });
    fs.copyFileSync(transcript, elsewhere);
    const outside = await importer.runSessionImport({ bin: codex.path, env, transcriptPath: elsewhere, cwd: work, title: null, timeoutMs: 60_000 });
    check(!outside.result.ok && /session_not_detected/.test(outside.result.ok ? '' : outside.result.failures.join(' ')),
      'a transcript outside $HOME/.claude/projects is not detected by Codex — the case the plan refuses up front', outside.result);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const realLedgerAfter = fs.existsSync(realLedger) ? fs.statSync(realLedger).mtimeMs : null;
  check(realLedgerBefore === realLedgerAfter, 'the real ~/.codex import ledger was not touched', { realLedgerBefore, realLedgerAfter });
}

/**
 * helper sweep · P5 runtime — per-account health and a diagnostics bundle.
 *
 * The doctor is exercised through a stand-in `codex` that prints Codex
 * 0.154.0's recorded report for an unauthenticated home and exits 1, the way
 * the real one does: the real doctor probes OpenAI's endpoints, and this suite
 * stays off the network. The bundle is built, previewed and saved for real.
 */
export async function runHealthAndDiagnosticsSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · per-account health and a diagnostics bundle');
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const doctor = await import('./codex-doctor');
  const diagnostics = await import('./diagnostics');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-health-'));
  try {
    const report = JSON.stringify({
      schemaVersion: 1, overallStatus: 'fail', codexVersion: '0.154.0',
      checks: {
        'auth.credentials': { id: 'auth.credentials', category: 'auth', status: 'fail', summary: 'no Codex credentials were found', remediation: 'Run codex login or provide an API key through a supported auth env var.' },
        'config.load': { id: 'config.load', category: 'config', status: 'ok', summary: 'config loaded', remediation: null },
      },
    });
    const fixture = path.join(root, 'report.json');
    fs.writeFileSync(fixture, report);
    const fake = path.join(root, 'codex');
    fs.writeFileSync(fake, `#!/bin/sh\nif [ "$1" = "doctor" ] && [ "$2" = "--json" ]; then cat "${fixture}"; exit 1; fi\nexit 2\n`, { mode: 0o755 });
    const ran = await doctor.doctorWithBinary(fake, { PATH: '/usr/bin:/bin', CODEX_HOME: root });
    check(ran.exitCode === 1 && ran.report.state === 'report',
      'a doctor that exits 1 with a well-formed report is read as a report, not a crash', ran);
    check(ran.report.state === 'report' && ran.report.failing.map((c) => c.id).join() === 'auth.credentials',
      'the unauthenticated account’s failing check is named', ran.report);
    const old = path.join(root, 'old-codex');
    fs.writeFileSync(old, `#!/bin/sh\nif [ "$2" = "--json" ]; then echo "error: unexpected argument '--json' found" >&2; exit 2; fi\necho "Codex doctor summary: 3 ok, 1 failed"\nexit 1\n`, { mode: 0o755 });
    const fallback = await doctor.doctorWithBinary(old, { PATH: '/usr/bin:/bin' });
    check(fallback.report.state === 'summary-text' && /1 failed/.test(fallback.report.state === 'summary-text' ? fallback.report.text : ''),
      'a Codex without --json falls back to --summary, shown as text and not parsed into checks', fallback.report);
    const junk = path.join(root, 'junk-codex');
    fs.writeFileSync(junk, '#!/bin/sh\necho "{\\"schemaVersion\\": 7}"\nexit 0\n', { mode: 0o755 });
    const unreadable = await doctor.doctorWithBinary(junk, { PATH: '/usr/bin:/bin' });
    check(unreadable.report.state === 'unreadable', 'a report in an unknown schema is unreadable, never "no failing checks"', unreadable.report);

    const preview = await diagnostics.previewDiagnostics();
    const names = preview.files.map((f) => f.name);
    check(['app.json', 'settings.redacted.json', 'providers.json', 'gate-results.json', 'preflight.json', 'table-counts.json', 'readme.txt'].every((n) => names.includes(n)),
      'the preview lists every file the bundle will hold, with what each one says', names);
    check(preview.excluded.some((e) => /transcripts/.test(e)) && preview.files.every((f) => f.bytes > 0 && f.describes.length > 0),
      'and states what is deliberately left out', preview.excluded);
    const target = path.join(root, 'bundle.zip');
    let refusedMismatch = false;
    try { await diagnostics.saveDiagnostics(null, [...names, 'extra.json'], target); } catch { refusedMismatch = true; }
    check(refusedMismatch && !fs.existsSync(target), 'a save whose file list differs from the preview is refused, and writes nothing');
    const saved = await diagnostics.saveDiagnostics(null, names, target);
    check(saved === target && fs.existsSync(target), 'the bundle is saved as a zip with ditto', saved);
    const listing = execFileSync('/usr/bin/unzip', ['-l', target]).toString();
    check(names.every((n) => listing.includes(n)), 'the zip holds exactly the previewed files', listing.split('\n').length);
    const unpacked = path.join(root, 'unpacked');
    execFileSync('/usr/bin/ditto', ['-x', '-k', target, unpacked]);
    const all = execFileSync('/bin/cat', names.map((n) => path.join(unpacked, 'bundle', n))).toString();
    const counts = JSON.parse(fs.readFileSync(path.join(unpacked, 'bundle', 'table-counts.json'), 'utf8')) as Record<string, unknown>;
    check(Object.values(counts).every((v) => typeof v === 'number') && 'session_log' in counts,
      'table counts are numbers per table and nothing else', Object.keys(counts).length);
    check(!all.includes(os.homedir() + path.sep), 'no file in the bundle spells out the home directory');
    check(!/sk-[A-Za-z0-9_-]{8,}|"initial_prompt"|BEGIN [A-Z ]*PRIVATE KEY/.test(all), 'and none carries a key, a prompt column or a private key');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * helper sweep · P5 runtime — where each launch value came from.
 */
export async function runLaunchProvenanceSmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · where each launch value came from');
  const provenance = await import('./launch-provenance');
  const now = Date.now();
  const session = {
    id: `s_p5_prov_${now}`, providerId: 'claude', projectId: 'p_none', projectPath: '/tmp', projectName: 'prov',
    title: 'Claude · prov', status: 'running', pid: null, exitCode: null, createdAt: now, endedAt: null, unread: 0,
    model: 'opus', effort: undefined, permissionMode: 'acceptEdits', accountId: null, accountLabel: null,
    worktree: '/tmp/wt', harnessId: 'claude-code',
    providerProfile: {
      id: 'claude', packId: 'builtin', packVersion: '1', label: 'Claude Code', harness: 'claude-code', backendId: 'anthropic',
      bin: 'claude', enabled: true, supports: { model: true, effort: true, permissionMode: true, resume: true }, capabilities: {},
      launchFields: [{ id: 'permissionMode', label: 'Permission mode', kind: 'select', defaultValue: 'acceptEdits' }],
    },
  } as unknown as Parameters<typeof provenance.recordLaunchProvenance>[0];
  provenance.recordLaunchProvenance(session, { providerId: 'claude', projectId: 'p_none', model: 'opus', permissionMode: 'acceptEdits', isolate: true, extraArgs: '--verbose' });
  const read = provenance.launchProvenanceFor(session.id);
  const field = (name: string) => read?.values.find((v) => v.field === name);
  check(read?.origin === 'renderer', 'a renderer launch is recorded with its origin', read?.origin);
  check(field('model')?.source === 'at-launch' && field('permissionMode')?.source === 'provider-profile' && field('effort')?.source === 'cli-default',
    'a chosen model is set at launch, a declared default is the profile’s, and an empty effort is the CLI’s own default',
    read?.values.map((v) => `${v.field}:${v.source}`));
  check(field('isolation')?.source === 'at-launch' && field('extraArgs')?.value === '--verbose',
    'isolation and extra flags carry their launch source', [field('isolation'), field('extraArgs')]);
  check(!!field('env')?.value?.includes('CLAUDE_CONFIG_DIR') && field('env')?.note?.includes('names only') === true,
    'environment appears as names with their sources, never values', field('env'));
  check(provenance.launchProvenanceFor('s_never_launched') === null, 'a session with no record and no snapshot has no invented provenance');
  const index = sourceOf('src/main/index.ts');
  check(/handle\('sessions:create'[\s\S]{0,200}createSession\(opts\);[\s\S]{0,120}recordLaunchProvenance\(created, opts\)/.test(index),
    'the renderer’s launch handler records provenance at the call site');
}

/**
 * helper sweep · P5 runtime — reviewer sessions with no command tools, and
 * Review PR #N.
 *
 * The PR fetch runs against real git with a local bare repository standing in
 * for origin, so nothing leaves the machine: one origin publishes
 * refs/pull/7/head, and a second is reached through a url.insteadOf rewrite of
 * https://gitlab.com/… so the GitLab branch is exercised on a GitLab-looking
 * origin without a network. No agent is launched: the review-only refusals are
 * the checks that run before one would be.
 */
export async function runReviewOnlySmoke(check: Check, say: Say): Promise<void> {
  say('── helper sweep · P5 runtime · reviewer sessions and Review PR #N');
  const os = await import('node:os');
  const { execFileSync } = await import('node:child_process');
  const review = await import('./review-only');
  const sessions = await import('./sessions');
  const control = await import('./control');
  const { addProject, removeProject } = await import('./store');
  const { removeWorktree } = await import('./worktrees');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-review-pr-')));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' }).toString().trim();
  const made: string[] = [];
  let projectId: string | null = null;
  let gitlabProjectId: string | null = null;
  try {
    check(review.reviewOnlyRefusal({ harness: 'codex', source: 'builtin' })?.includes('Claude Code sessions only') === true,
      'review only is refused for a Codex profile, which has no verified way to remove its command tools');
    check(review.reviewOnlyRefusal({ harness: 'claude-code', source: 'builtin', permissionMode: 'bypassPermissions' })?.includes('bypassPermissions') === true,
      'and refused with bypassPermissions, as Claude Code itself refuses it');
    check(review.reviewOnlyRefusal({ harness: 'claude-code', source: 'local' }) !== null,
      'a local pack on the Claude harness is not trusted to honour --restricted');
    check(review.reviewOnlyRefusal({ harness: 'claude-code', source: 'builtin', permissionMode: 'plan' }) === null, 'a built-in Claude profile may');

    const withFlag = path.join(root, 'claude-new');
    fs.writeFileSync(withFlag, '#!/bin/sh\necho "  --restricted                          Restricted mode: removes the built-in"\n', { mode: 0o755 });
    const withoutFlag = path.join(root, 'claude-old');
    fs.writeFileSync(withoutFlag, '#!/bin/sh\necho "  --resume   Resume a conversation"\n', { mode: 0o755 });
    check(await review.restrictedFlagSupported(withFlag) && !(await review.restrictedFlagSupported(withoutFlag)),
      '--restricted is looked for in the help of the binary about to run, not assumed from a version');

    const src = sourceOf('src/main/sessions.ts');
    check(/\.\.\.\(reviewOnly \? \[RESTRICTED_FLAG\] : \[\]\)/.test(src) && /restrictedFlagSupported\(resolvedBin\)/.test(src),
      'a review-only Claude launch adds --restricted to argv, after checking the resolved binary lists it');

    // Review PR against a local bare origin.
    const origin = path.join(root, 'origin.git');
    const work = path.join(root, 'work');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git(work, 'config', 'user.email', 'smoke@wanigan.test'); git(work, 'config', 'user.name', 'Smoke');
    fs.writeFileSync(path.join(work, 'README.md'), '# base\n');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'base');
    git(work, 'remote', 'add', 'origin', origin);
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(work, 'feature.txt'), 'the change under review\n');
    git(work, 'add', '-A'); git(work, 'commit', '-qm', 'feature');
    const prHead = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    git(work, 'checkout', '-q', 'main');
    git(work, 'branch', '-q', '-D', 'feature');
    const branchesBefore = git(work, 'branch', '--list').split('\n').map((b) => b.replace('*', '').trim()).sort();
    const project = await addProject(work);
    projectId = project.id;

    let codexMessage = '';
    try {
      await sessions.createSession({ providerId: 'codex', projectId: project.id, reviewOnly: true } as Parameters<typeof sessions.createSession>[0]);
    } catch (error) { codexMessage = error instanceof Error ? error.message : String(error); }
    check(/Claude Code sessions only/.test(codexMessage),
      'a review-only launch on a Codex profile is refused by name and never starts an agent', codexMessage);

    let badNumber = '';
    try { await review.preparePrReview(project.id, '7; rm -rf /'); } catch (error) { badNumber = error instanceof Error ? error.message : String(error); }
    check(/Enter a pull request number/.test(badNumber), 'a PR number that is not a number is refused before git runs', badNumber);

    let missing = '';
    try { await review.preparePrReview(project.id, '8'); } catch (error) { missing = error instanceof Error ? error.message : String(error); }
    check(/git fetch origin pull\/8\/head: .*(couldn't find remote ref|not our ref|fatal)/i.test(missing),
      'a PR that origin does not have is reported in git’s own words', missing);

    const ready = await review.preparePrReview(project.id, '#7');
    made.push(ready.worktree);
    check(ready.forge === 'other' && ready.ref === 'pull/7/head' && ready.head === prHead,
      'the pull request head is fetched from origin by pull/N/head', ready);
    check(fs.existsSync(path.join(ready.worktree, 'feature.txt')) && git(ready.worktree, 'rev-parse', 'HEAD') === prHead,
      'into a new Wanigan-managed worktree checked out at that head', ready.worktree);
    const branchesAfter = git(work, 'branch', '--list').split('\n').map((b) => b.replace('*', '').trim()).filter((b) => !b.startsWith('wanigan/') && !b.startsWith('+ wanigan/')).sort();
    check(JSON.stringify(branchesAfter) === JSON.stringify(branchesBefore) && git(work, 'rev-parse', 'main') !== prHead,
      'and no branch of the operator’s moved', { branchesBefore, branchesAfter });
    check(/pull request #7/.test(ready.prompt) && /no command tools/.test(ready.prompt), 'the prompt stub names the PR and the missing command tools', ready.prompt);
    check(await review.assertReviewWorktree(ready.worktree, project.id) === ready.worktree,
      'the prepared worktree is accepted as this project’s review worktree');
    let foreign = '';
    try { await review.assertReviewWorktree(work, project.id); } catch (error) { foreign = error instanceof Error ? error.message : String(error); }
    check(/not a review worktree/.test(foreign), 'any other folder handed in by the renderer is refused', foreign);

    // GitLab: a GitLab-looking origin, rewritten to a local bare repository.
    const glOrigin = path.join(root, 'gitlab.git');
    const glWork = path.join(root, 'gitlab-work');
    execFileSync('git', ['init', '-q', '--bare', glOrigin]);
    execFileSync('git', ['clone', '-q', origin, glWork]);
    git(glWork, 'config', 'user.email', 'smoke@wanigan.test'); git(glWork, 'config', 'user.name', 'Smoke');
    git(glWork, 'remote', 'set-url', 'origin', 'https://gitlab.com/acme/app.git');
    git(glWork, 'config', `url.${glOrigin}.insteadOf`, 'https://gitlab.com/acme/app.git');
    git(glWork, 'push', '-q', 'origin', `${prHead}:refs/merge-requests/3/head`);
    const glProject = await addProject(glWork);
    gitlabProjectId = glProject.id;
    const gl = await review.preparePrReview(glProject.id, '!3');
    made.push(gl.worktree);
    check(gl.forge === 'gitlab' && gl.ref === 'merge-requests/3/head' && gl.head === prHead && /merge request !3/.test(gl.prompt),
      'a GitLab origin fetches merge-requests/N/head instead', gl);

    const goal = control.createDocket({ projectId: project.id, title: 'Review default', objective: 'Check the review toggle.', acceptance: ['It persists.'], risk: 'low' });
    check(review.goalReviewOnly(goal.id) === true, 'a goal’s review task has no command tools by default');
    review.setGoalReviewOnly(goal.id, false);
    check(review.goalReviewOnly(goal.id) === false, 'and the per-goal toggle turns it off');
    let unknownGoal = '';
    try { review.setGoalReviewOnly('dock_missing', true); } catch (error) { unknownGoal = error instanceof Error ? error.message : String(error); }
    check(/no longer exists/.test(unknownGoal), 'a toggle for a goal that does not exist is refused', unknownGoal);
    const controlSrc = sourceOf('src/main/control.ts');
    check(/node\.kind === 'review' && !!reviewDef && goalReviewOnly\(parent\.id\)/.test(controlSrc),
      'the review task launch reads the goal toggle at its call site');
  } finally {
    for (const wt of made) { try { await removeWorktree(wt, true); } catch { /* best effort */ } }
    if (projectId) try { removeProject(projectId); } catch { /* gone */ }
    if (gitlabProjectId) try { removeProject(gitlabProjectId); } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
}
