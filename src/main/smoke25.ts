import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import { runGit } from './git';
import * as gh from './gh';
import { addProject, removeProject } from './store';
import { dismissEvent } from './control';
import { checkGitHub, intakeOverview, intakeTimer, setIntakeReadTimeoutForTest, setIntakeTimer, tickIntake } from './intake';
import { FIRST_LOOKBACK_MS, WINDOW_OVERLAP_MS, gapSentence, githubTime, lookbackSentence, type IntakePoll } from '../shared/intake';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Issue intake through a fake gh, against real repositories with GitHub-style
 * remotes. The stub answers each read — stdout, stderr, exit status or a hang —
 * from files the scenario writes, and records every argv token of every call,
 * which is how the suite shows each poll's three states, the dedupe across
 * overlapping windows, the honest failures, and that nothing it ran could write
 * to GitHub. No network, no GitHub account.
 */
export async function runIssueIntakeSmoke(check: Check, say: Say): Promise<void> {
  say('── issue intake via gh · fired, ran and succeeded, one event per fact, honest failures, the gap, the timer, redaction');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-intake-'));
  const binDir = path.join(base, 'bin');
  const emptyDir = path.join(base, 'empty');
  const scene = path.join(base, 'scene');
  const callsDir = path.join(base, 'calls');
  for (const d of [binDir, emptyDir, scene, callsDir]) fs.mkdirSync(d, { recursive: true });
  const projects: string[] = [];

  // Each call in a file of its own, argv tokens NUL-terminated: a poll runs its
  // three reads at once, and stubs appending to one shared file would interleave
  // into calls nobody made. gh runs with the stub directory as its whole PATH, so
  // every program the stub uses is named by absolute path.
  fs.writeFileSync(path.join(binDir, 'gh'), [
    '#!/bin/sh',
    `D='${scene}'`,
    'if [ "$1" = "--version" ]; then echo "gh version 9.9.9-smoke (2026-01-01)"; exit 0; fi',
    `f="$(/usr/bin/mktemp '${callsDir}/call.XXXXXX')" || exit 70`,
    `for a in "$@"; do printf '%s\\0' "$a" >> "$f"; done`,
    'case "$1 $2" in',
    '  "issue list") key=issues ;;',
    '  "run list") key=runs ;;',
    '  "auth status") key=auth; if [ -n "$3" ]; then h="${3#--hostname=}"; if [ -f "$D/auth-$h.code" ]; then key="auth-$h"; fi; fi ;;',
    '  *) if [ "$1" = "api" ]; then key=comments; else echo "unexpected: $*" >&2; exit 64; fi ;;',
    'esac',
    'if [ -f "$D/$key.sleep" ]; then exec /bin/sleep "$(/bin/cat "$D/$key.sleep")"; fi',
    'if [ -f "$D/$key.out" ]; then /bin/cat "$D/$key.out"; fi',
    'if [ -f "$D/$key.err" ]; then /bin/cat "$D/$key.err" >&2; fi',
    'if [ -f "$D/$key.code" ]; then exit "$(/bin/cat "$D/$key.code")"; fi',
    'exit 0',
  ].join('\n') + '\n', { mode: 0o755 });
  fs.chmodSync(path.join(binDir, 'gh'), 0o755);

  const calls = (): string[][] => {
    try {
      return fs.readdirSync(callsDir).map((name) => fs.readFileSync(path.join(callsDir, name), 'utf8').split('\0').slice(0, -1));
    } catch { return []; }
  };
  // Every call the suite ever made, kept as the log is cleared, so the no-writes
  // check at the end covers each poll rather than the ones still on disk.
  const allCalls: string[][] = [];
  const clearCalls = () => {
    allCalls.push(...calls());
    fs.rmSync(callsDir, { recursive: true, force: true });
    fs.mkdirSync(callsDir, { recursive: true });
  };
  const setScene = (files: Record<string, string>) => {
    fs.rmSync(scene, { recursive: true, force: true });
    fs.mkdirSync(scene, { recursive: true });
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(scene, name), text);
    clearCalls();
    gh.setGhSearchDirsForTest([binDir]);
  };
  const git = async (cwd: string, ...args: string[]) => {
    const r = await runGit(cwd, args, { timeout: 15_000 });
    if (!r.ok) throw new Error(`git ${args[0]}: ${r.err}`);
    return r.out;
  };
  const repoWith = async (name: string, remote: string | null) => {
    const dir = path.join(base, name);
    fs.mkdirSync(dir, { recursive: true });
    await git(dir, 'init', '-q');
    fs.writeFileSync(path.join(dir, 'README.md'), '# app\n');
    await git(dir, 'add', '-A');
    await git(dir, '-c', 'user.name=Smoke', '-c', 'user.email=smoke@localhost', 'commit', '-q', '-m', 'Start');
    if (remote) await git(dir, 'remote', 'add', 'origin', remote);
    const project = await addProject(dir);
    projects.push(project.id);
    return { dir, id: project.id };
  };
  const pollRows = (projectId: string) =>
    (db().prepare('SELECT COUNT(*) AS n FROM intake_polls WHERE project_id=?').get(projectId) as { n: number }).n;
  const keyed = (projectId: string) => db().prepare('SELECT id, external_key, kind, summary, status FROM control_events WHERE project_id=? AND external_key IS NOT NULL ORDER BY external_key')
    .all(projectId) as Array<{ id: string; external_key: string; kind: string; summary: string; status: string }>;
  const ordered = (p: IntakePoll) => p.ranAt !== null && p.finishedAt !== null && p.firedAt <= p.ranAt && p.ranAt <= p.finishedAt;
  const noCounts = (p: IntakePoll) => Object.values(p.counts).every((n) => n === 0);

  // Built from parts at run time, so no credential-shaped literal sits in the
  // repository for the secret scanner to report; it matches the GitHub token
  // shape src/main/redact.ts knows.
  const plantedToken = ['gh', 'p_', 'SMOKE', 'intakeTitle', '0123456789'].join('');

  // "Recent" is a minute before each scene is written, which puts every recent
  // fact inside the overlap the next poll's window reaches back by: that overlap
  // is how GitHub hands intake the same fact twice, and what the dedupe is for.
  // "Old" is days outside any window this suite opens, the first lookback included.
  const recent = () => githubTime(Date.now() - 60_000);
  const old = githubTime(Date.now() - 3 * 86_400_000);
  const issue = (number: number, title: string, created: string, labels: string[]) => ({
    author: { id: 'MDQ6VXNlcjE=', is_bot: false, login: 'reporter', name: 'Reporter' }, createdAt: created,
    labels: labels.map((name) => ({ id: `LA_${name}`, name, description: '', color: 'd73a4a' })), number, title,
    updatedAt: recent(), url: `https://github.com/octo/app/issues/${number}`,
  });
  const comment = (id: number, kind: 'issues' | 'pull', number: number, created: string, body: string) => ({
    url: `https://api.github.com/repos/octo/app/issues/comments/${id}`, html_url: `https://github.com/octo/app/${kind}/${number}#issuecomment-${id}`,
    issue_url: `https://api.github.com/repos/octo/app/issues/${number}`, id, user: { login: 'reviewer' }, created_at: created, updated_at: recent(),
    body, author_association: 'MEMBER',
  });
  const run = (id: number, updated: string) => ({
    attempt: 1, conclusion: 'failure', createdAt: updated, databaseId: id, displayTitle: 'Retry twice', event: 'push', headBranch: 'main',
    name: 'CI', number: 512, updatedAt: updated, url: `https://github.com/octo/app/actions/runs/${id}`, workflowName: 'CI',
  });
  const okScene = (extraIssues: object[] = []) => setScene({
    'issues.out': JSON.stringify([...extraIssues, issue(42, 'Checkout double-charges on retry', recent(), ['bug']), issue(7, 'Old flaky test', old, ['flaky'])]) + '\n',
    'comments.out': JSON.stringify([
      comment(9001, 'issues', 42, recent(), 'Reproduced on main.'),
      comment(9002, 'pull', 43, recent(), 'A pull request conversation comment.'),
      comment(9003, 'issues', 7, old, 'Edited long after it was written.'),
    ]) + '\n',
    'runs.out': JSON.stringify([run(7001, recent()), run(6999, old)]) + '\n',
  });

  try {
    // ── the timer, before anything turns it on ─────────────────────────
    const repo = await repoWith('app', 'https://github.com/octo/app.git');
    const gitlab = await repoWith('mirror', 'https://gitlab.com/octo/mirror.git');
    const offline = await repoWith('offline', null);
    check(JSON.stringify(intakeTimer()) === JSON.stringify({ enabled: false, intervalMinutes: 15 }),
      'the GitHub intake timer is off on a fresh install, with a fifteen-minute interval waiting for someone to turn it on', JSON.stringify(intakeTimer()));
    okScene();
    const polledOff = await tickIntake();
    check(polledOff === 0 && pollRows(repo.id) === 0 && calls().length === 0,
      'a timer tick while the timer is off polls nothing, writes no poll row and runs no gh', JSON.stringify({ polledOff, rows: pollRows(repo.id), calls: calls().length }));
    let refused: string | null = null;
    try { setIntakeTimer({ enabled: true, intervalMinutes: 9 }); } catch (e) { refused = e instanceof Error ? e.message : String(e); }
    check(refused !== null && /at least 10 minutes/.test(refused) && intakeTimer().enabled === false && intakeTimer().intervalMinutes === 15,
      'turning the timer on with a nine-minute interval is refused in main, and neither the switch nor the interval is stored', refused);

    // ── the first press: fired, ran, succeeded, one event per fact ───────
    const first = await checkGitHub(repo.id);
    const firstCalls = calls();
    check(first.trigger === 'manual' && first.outcome === 'succeeded' && ordered(first) && first.repo === 'github.com/octo/app',
      'a press is recorded as fired by a press, then ran, then succeeded, in that order, against the repository its origin remote names', JSON.stringify(first));
    check(JSON.stringify(first.counts) === JSON.stringify({ opened: 1, labelled: 2, commented: 1, ci_failed: 1 }) && first.factsRead === 5,
      'the first poll records an opened issue, two labels, an issue comment and a failed run — not the old issue, the pull request comment, the old comment edited late or the run from days ago',
      JSON.stringify({ counts: first.counts, factsRead: first.factsRead }));
    check(first.lookback && first.until === first.ranAt && first.since === (first.until ?? 0) - FIRST_LOOKBACK_MS && first.gapMs === null
      && lookbackSentence(first) === 'This was the first successful check of octo/app, so it read the 24 h before it; anything older is not in this inbox.',
    'a repository’s first check reads a stated day back, says so, and claims no gap', JSON.stringify({ since: first.since, until: first.until, lookback: first.lookback }));
    const events = keyed(repo.id);
    check(JSON.stringify(events.map((e) => [e.external_key, e.kind])) === JSON.stringify([
      ['github.com/octo/app:comment:9001', 'commented'],
      ['github.com/octo/app:issue:42:label:bug', 'labelled'],
      ['github.com/octo/app:issue:42:opened', 'opened'],
      ['github.com/octo/app:issue:7:label:flaky', 'labelled'],
      ['github.com/octo/app:run:7001:attempt:1', 'CI failed'],
    ]) && events.every((e) => e.status === 'new'),
    'each fact becomes one new Control event keyed by its GitHub identity, with the kind the inbox prints', JSON.stringify(events.map((e) => [e.external_key, e.kind])));
    const links = db().prepare('SELECT event_id, poll_id, kind, url FROM intake_events WHERE poll_id=? ORDER BY kind').all(first.id) as Array<{ event_id: string; kind: string; url: string }>;
    check(links.length === 5 && links.every((l) => l.url.startsWith('https://github.com/octo/app/')) && events.find((e) => e.kind === 'opened')?.summary
      === 'Issue #42 opened by reporter in octo/app: “Checkout double-charges on retry” — https://github.com/octo/app/issues/42',
    'every new event carries its https link and the poll that recorded it, and its summary keeps the link so a goal made from it can find the issue', JSON.stringify(links));
    const issueCall = firstCalls.find((c) => c[0] === 'issue') ?? [];
    const commentCall = firstCalls.find((c) => c[0] === 'api') ?? [];
    const runCall = firstCalls.find((c) => c[0] === 'run') ?? [];
    const from = githubTime((first.since ?? 0) - WINDOW_OVERLAP_MS);
    check(issueCall.includes('--repo=github.com/octo/app') && issueCall.includes('--state=open') && issueCall.includes(`--search=updated:>=${from}`)
      && commentCall[1] === '--method=GET' && commentCall.includes('--hostname=github.com')
      && commentCall.includes(`repos/octo/app/issues/comments?since=${from}&sort=updated&direction=desc&per_page=100`)
      && runCall.includes('--repo=github.com/octo/app') && runCall.includes('--status=failure'),
    'the three reads travel as single argv tokens scoped to the chosen repository and to the window, overlap included', JSON.stringify({ issueCall, commentCall, runCall }));

    // ── the second press reads the same facts and records none again ────
    clearCalls();
    const second = await checkGitHub(repo.id);
    const secondCalls = calls();
    check(second.outcome === 'succeeded' && noCounts(second) && second.factsRead === 5 && keyed(repo.id).length === 5,
      'a second poll that reads the same five facts adds no event: each kind is recorded once across two polls', JSON.stringify({ counts: second.counts, factsRead: second.factsRead, events: keyed(repo.id).length }));
    check(!second.lookback && second.since === first.until && (secondCalls.find((c) => c[0] === 'issue') ?? []).includes(`--search=updated:>=${githubTime((first.until ?? 0) - WINDOW_OVERLAP_MS)}`),
      'the second window starts where the first success ended, and its query reaches back by the stated overlap', JSON.stringify({ since: second.since, firstUntil: first.until }));
    const dismissedId = events.find((e) => e.kind === 'CI failed')?.id ?? '';
    dismissEvent(dismissedId);
    const third = await checkGitHub(repo.id);
    check(third.outcome === 'succeeded' && noCounts(third) && keyed(repo.id).find((e) => e.id === dismissedId)?.status === 'dismissed',
      'a dismissed GitHub event stays dismissed when a later poll reads the same failed run again', JSON.stringify(third.counts));

    // ── redaction ─────────────────────────────────────────────────────────
    okScene([issue(44, `Rotate ${plantedToken} before release`, recent(), [`leak-${plantedToken}`])]);
    const planted = await checkGitHub(repo.id);
    const stored = JSON.stringify([
      db().prepare('SELECT * FROM control_events WHERE project_id=?').all(repo.id),
      db().prepare('SELECT * FROM intake_events').all(),
      db().prepare('SELECT * FROM intake_polls WHERE project_id=?').all(repo.id),
    ]);
    check(planted.outcome === 'succeeded' && planted.counts.opened === 1 && planted.counts.labelled === 1 && !stored.includes(plantedToken)
      && keyed(repo.id).some((e) => e.summary === 'Issue #44 opened by reporter in octo/app: “Rotate [REDACTED CREDENTIAL] before release” — https://github.com/octo/app/issues/44'),
    'a credential planted in an issue title and a label is redacted in main before it is stored in any event, link or poll row', keyed(repo.id).find((e) => e.external_key.endsWith(':issue:44:opened'))?.summary);

    // ── a failed read: ran, failed, gh's own line, no events ─────────────
    okScene([issue(45, 'Should not be recorded', recent(), [])]);
    fs.writeFileSync(path.join(scene, 'runs.err'), 'HTTP 502: Bad Gateway (https://api.github.com/repos/octo/app/actions/runs)\nsecond line\n');
    fs.writeFileSync(path.join(scene, 'runs.code'), '1');
    const failed = await checkGitHub(repo.id);
    check(failed.outcome === 'failed' && ordered(failed) && failed.error === 'HTTP 502: Bad Gateway (https://api.github.com/repos/octo/app/actions/runs)'
      && failed.reason === 'gh could not read the failed workflow runs of octo/app, so nothing from this check was recorded.'
      && noCounts(failed) && !keyed(repo.id).some((e) => e.external_key.includes(':issue:45:')),
    'a gh read that fails is recorded as ran and failed, with gh’s own first line, and the issue the other reads found is not recorded', JSON.stringify(failed));
    okScene();
    const afterFailure = await checkGitHub(repo.id);
    check(failed.since === planted.until && afterFailure.since === planted.until && afterFailure.until !== null && afterFailure.until > (failed.until ?? 0),
      'the poll after a failure starts where the last success ended, so the failed window is read again rather than skipped',
      JSON.stringify({ planted: planted.until, failed: failed.since, after: afterFailure.since }));

    setScene({ 'issues.err': 'HTTP 401: Bad credentials (https://api.github.com/graphql)\n', 'issues.code': '1', 'auth-github.com.code': '1', 'comments.out': '[]', 'runs.out': '[]' });
    const unsigned = await checkGitHub(repo.id);
    check(unsigned.outcome === 'failed' && unsigned.ranAt !== null && unsigned.error === 'HTTP 401: Bad credentials (https://api.github.com/graphql)'
      && /^gh is not signed in to github\.com, so octo\/app could not be read/.test(unsigned.reason ?? '') && /gh auth login/.test(unsigned.reason ?? '')
      && calls().some((c) => c[0] === 'auth' && c[2] === '--hostname=github.com'),
    'a read refused while gh is not signed in is recorded as ran and failed, classified by asking gh auth status for the host, with the fix named', JSON.stringify(unsigned));

    setIntakeReadTimeoutForTest(1_500);
    setScene({ 'issues.sleep': '5', 'comments.out': '[]', 'runs.out': '[]' });
    const hung = await checkGitHub(repo.id);
    check(hung.outcome === 'failed' && hung.ranAt !== null && hung.error === null && /within 2 seconds, so it was stopped/.test(hung.reason ?? '')
      && !calls().some((c) => c[0] === 'auth'),
    'a gh read that hangs is stopped at its timeout and recorded as ran and failed, with no words attributed to gh and no sign-in question asked', JSON.stringify(hung));
    setIntakeReadTimeoutForTest(null);

    gh.setGhSearchDirsForTest([emptyDir]);
    const missing = await checkGitHub(repo.id);
    check(missing.outcome === 'skipped' && missing.ranAt === null && missing.finishedAt !== null && missing.repo === 'github.com/octo/app'
      && /^gh is not installed, or not on your shell PATH, so GitHub was not read/.test(missing.reason ?? ''),
    'with no gh on the search path the press is recorded as fired, never ran, and skipped because gh is missing', JSON.stringify(missing));

    okScene();
    const notGitHub = await checkGitHub(gitlab.id);
    const noRemote = await checkGitHub(offline.id);
    check(notGitHub.outcome === 'skipped' && notGitHub.ranAt === null && /point at gitlab\.com/.test(notGitHub.reason ?? '')
      && noRemote.outcome === 'skipped' && noRemote.reason === 'This repository has no git remote, so there is no GitHub repository to watch.'
      && calls().length === 0,
    'a project whose remote is on gitlab.com, and one with no remote, are skipped with the reason named and without running gh', JSON.stringify([notGitHub.reason, noRemote.reason]));

    // ── the claim ─────────────────────────────────────────────────────────
    db().prepare('INSERT INTO intake_polls (id,project_id,fired_by,fired_at,ran_at) VALUES (?,?,?,?,?)').run('poll_smoke_live', repo.id, 'timer', Date.now(), Date.now());
    const busy = await checkGitHub(repo.id);
    check(busy.outcome === 'skipped' && busy.ranAt === null && busy.reason === 'Another check of this project was still running, so this one did not start.' && calls().length === 0,
      'a press while another poll of the project holds the claim is recorded as a skipped fire and runs no gh', JSON.stringify(busy));
    db().prepare('UPDATE intake_polls SET fired_at=? WHERE id=?').run(Date.now() - 11 * 60_000, 'poll_smoke_live');
    const recovered = await checkGitHub(repo.id);
    const stale = db().prepare('SELECT outcome, reason FROM intake_polls WHERE id=?').get('poll_smoke_live') as { outcome: string; reason: string };
    check(recovered.outcome === 'succeeded' && stale.outcome === 'failed'
      && stale.reason === 'Wanigan stopped while gh was reading — it quit or crashed — so nothing from this check was recorded.',
    'a poll a stopped process left running for over ten minutes is closed as failed with that reason, and releases the claim', JSON.stringify(stale));

    // ── the timer, turned on ──────────────────────────────────────────────
    const saved = setIntakeTimer({ enabled: true, intervalMinutes: 10 });
    db().prepare('UPDATE intake_polls SET fired_at=fired_at-? WHERE project_id IN (?,?,?)').run(11 * 60_000, repo.id, gitlab.id, offline.id);
    const gitlabRows = pollRows(gitlab.id);
    const polled = await tickIntake();
    const timed = db().prepare("SELECT id FROM intake_polls WHERE project_id=? AND fired_by='timer' ORDER BY fired_at DESC LIMIT 1").get(repo.id) as { id: string } | undefined;
    const timedPoll = timed ? (await intakeOverview()).projects.find((p) => p.projectId === repo.id)?.last : null;
    check(saved.enabled && saved.intervalMinutes === 10 && polled >= 1 && timedPoll?.trigger === 'timer' && timedPoll.id === timed?.id
      && timedPoll.outcome === 'succeeded' && ordered(timedPoll) && timedPoll.intervalMs === 10 * 60_000 && pollRows(gitlab.id) === gitlabRows,
    'with the timer on at ten minutes, a due tick polls the GitHub project and records fired, ran and succeeded for the timer, and writes nothing for a project with no GitHub remote',
    JSON.stringify({ polled, timedPoll, gitlabRows: pollRows(gitlab.id) }));
    const rowsBeforeSecondTick = pollRows(repo.id);
    await tickIntake();
    const newest = db().prepare('SELECT id FROM intake_polls WHERE project_id=? ORDER BY fired_at DESC LIMIT 1').get(repo.id) as { id: string };
    check(timed !== undefined && newest.id === timed.id && pollRows(repo.id) === rowsBeforeSecondTick,
      'a second tick inside the interval does not poll the project again', JSON.stringify({ newest: newest.id, timed: timed?.id }));

    // ── the gap ───────────────────────────────────────────────────────────
    setIntakeTimer({ enabled: true, intervalMinutes: 15 });
    const lastSuccess = db().prepare("SELECT id FROM intake_polls WHERE project_id=? AND outcome='succeeded' ORDER BY finished_at DESC LIMIT 1").get(repo.id) as { id: string };
    db().prepare('UPDATE intake_polls SET until_at=? WHERE id=?').run(Date.now() - 6 * 3_600_000, lastSuccess.id);
    const late = await checkGitHub(repo.id);
    const sentence = gapSentence(late) ?? '';
    check(late.outcome === 'succeeded' && late.intervalMs === 15 * 60_000 && late.gapMs !== null
      && late.gapMs >= 6 * 3_600_000 - 15 * 60_000 && late.gapMs < 6 * 3_600_000 - 15 * 60_000 + 60_000
      && sentence.startsWith('Nothing was watching for 5 h 45 min: the last successful check was 6 h before this one, and the timer asks every 15 minutes.')
      && sentence.includes('is not in this inbox.'),
    'a poll whose window starts six hours back with a fifteen-minute timer records a gap of five hours forty-five and says how long nothing was watching', sentence);
    const prompt = await checkGitHub(repo.id);
    check(prompt.outcome === 'succeeded' && prompt.gapMs === null && gapSentence(prompt) === null,
      'the poll right after it covers minutes, not hours, and says nothing about a gap', JSON.stringify({ gapMs: prompt.gapMs }));

    const everyCall = [...allCalls, ...calls()];
    check(everyCall.length >= 20
      && everyCall.every((c) => ['issue list', 'run list', 'auth status'].includes(`${c[0]} ${c[1]}`) || (c[0] === 'api' && c[1] === '--method=GET'))
      && !everyCall.flat().some((a) => /^(-f|-F|--field|--raw-field|--input|-X)$/.test(a) || /^--method=(?!GET$)/.test(a) || /^(comment|edit|close|create|delete|rerun)$/.test(a)),
    'every one of the gh calls this suite’s polls made was a read: issue list, run list, auth status, or api pinned to GET with no request body',
    `${everyCall.length} calls: ${JSON.stringify([...new Set(everyCall.map((c) => c.slice(0, 2).join(' ')))])}`);

    // ── what the Control view reads ─────────────────────────────────────
    const overview = await intakeOverview();
    const mine = overview.projects.find((p) => p.projectId === repo.id);
    const mirror = overview.projects.find((p) => p.projectId === gitlab.id);
    const linked = new Set(overview.events.map((e) => e.eventId));
    check(mine?.watch.kind === 'github' && mine.watch.repo === 'github.com/octo/app' && mine.watch.remote === 'origin'
      && mine.last?.id === prompt.id && mine.lastSucceeded?.id === prompt.id
      && mirror?.watch.kind === 'unwatched' && mirror.watch.detail.startsWith('This repository’s remotes point at gitlab.com. Intake watches')
      && keyed(repo.id).every((e) => linked.has(e.id)) && overview.timer.enabled && overview.timer.intervalMinutes === 15,
    'the overview names the watched repository and remote, the newest poll and success, why a GitLab project is unwatched, and a link for every GitHub event', JSON.stringify({ mine: mine?.watch, mirror: mirror?.watch }));
  } catch (e) {
    check(false, `issue intake smoke threw: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    try { setIntakeTimer({ enabled: false, intervalMinutes: 15 }); } catch { /* the check above reports a broken store */ }
    setIntakeReadTimeoutForTest(null);
    gh.setGhSearchDirsForTest(null);
    for (const id of projects) {
      db().prepare('DELETE FROM control_events WHERE project_id=? AND external_key IS NOT NULL').run(id);
      removeProject(id);
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
}
