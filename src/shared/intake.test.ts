/**
 * Issue intake's pure half. The issue and run fixtures are the exact bytes gh
 * 2.94.0 printed for this module's own argv against the public cli/cli
 * repository on 2026-09-15; the comment fixture keeps the REST endpoint's key
 * order and values from the same read, with bodies shortened. The pull-request
 * comment is real too: that endpoint returns one with `/pull/` in html_url and
 * `/issues/` in issue_url, which is the difference the parser keys on.
 *
 * The subject is "can it lie": a fact recorded twice, a pull request passed off
 * as an issue, a label given a time GitHub never stated, an interval quietly
 * clamped, or a gap nobody is told about.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chooseGitHubRemote, commentArgs, gapSentence, ghResolvedBase, githubRepoOfUrl, issueArgs, lookbackSentence, parseComments,
  parseIssues, parseRuns, pollWindow, runArgs, spanWords, timerInput, unwatchedMs,
  COMMENT_LIMIT, EVENT_SUMMARY_MAX, FIRST_LOOKBACK_MS, ISSUE_LIMIT, RUN_LIMIT, type GitHubRepo,
} from './intake.ts';

const none = (text: string) => text;
const CLI: GitHubRepo = { host: 'github.com', owner: 'cli', name: 'cli', remote: 'origin' };
const at = (iso: string) => Date.parse(iso);

const ISSUES = '[{"author":{"id":"MDQ6VXNlcjM2NzI4OTMx","is_bot":false,"login":"babakks","name":"Babak K. Shandiz"},"createdAt":"2026-09-15T01:25:33Z","labels":[{"id":"MDU6TGFiZWwxNjk4MDc2MTcz","name":"enhancement","description":"a request to improve CLI","color":"0dd8ac"},{"id":"LA_kwDODKw3uc8AAAABZ6mEGQ","name":"gh-auth","description":"relating to the gh auth command","color":"9A3D69"}],"number":14449,"title":"Refreshable (short-lived) OAuth token support","updatedAt":"2026-09-15T01:53:31Z","url":"https://github.com/cli/cli/issues/14449"},{"author":{"id":"MDQ6VXNlcjU4MjQwNA==","is_bot":false,"login":"jpalomaki","name":"Jukka Palomäki"},"createdAt":"2026-09-14T09:42:40Z","labels":[{"id":"LA_kwDODKw3uc7QD3p7","name":"needs-triage","description":"needs to be reviewed","color":"D6393F"}],"number":14439,"title":"Allow for [skip ci] in gh repo create --template","updatedAt":"2026-09-14T11:54:22Z","url":"https://github.com/cli/cli/issues/14439"}]\n';

const comment = (id: number, kind: 'issues' | 'pull', number: number, login: string, created: string, updated: string, body: string) =>
  `{"url":"https://api.github.com/repos/cli/cli/issues/comments/${id}","html_url":"https://github.com/cli/cli/${kind}/${number}#issuecomment-${id}","issue_url":"https://api.github.com/repos/cli/cli/issues/${number}","id":${id},"node_id":"IC_kwDODKw3uc8AAAABUjJ4qg","user":{"login":"${login}","type":"User"},"created_at":"${created}","updated_at":"${updated}","body":${JSON.stringify(body)},"author_association":"NONE"}`;
const COMMENTS = `[${[
  comment(5674221994, 'issues', 14394, 'LucasLeao18', '2026-09-15T03:26:56Z', '2026-09-15T03:26:56Z', 'For visibility: #263 fixed the write side in go-gh (atomic publish), but entries'),
  comment(5673288899, 'issues', 14449, 'cli-triage[bot]', '2026-09-15T01:29:59Z', '2026-09-15T01:31:02Z', 'This looks like a maintainer-authored design/envelope issue (assignee `babakks`,'),
  comment(5666741214, 'pull', 14443, 'cli-triage[bot]', '2026-09-14T15:51:41Z', '2026-09-14T15:51:41Z', 'Thanks for the pull request.'),
].join(',')}]\n`;

const RUNS = '[{"attempt":1,"conclusion":"failure","createdAt":"2026-08-18T10:50:38Z","databaseId":32128760676,"displayTitle":"Dependabot PR Triage (skills-driven)","event":"schedule","headBranch":"trunk","name":"Dependabot PR Triage (skills-driven)","number":422,"updatedAt":"2026-08-18T10:51:04Z","url":"https://github.com/cli/cli/actions/runs/32128760676","workflowName":"Dependabot PR Triage (skills-driven)"},{"attempt":1,"conclusion":"failure","createdAt":"2026-08-18T09:51:35Z","databaseId":32123793136,"displayTitle":"Dependabot PR Triage (skills-driven)","event":"schedule","headBranch":"trunk","name":"Dependabot PR Triage (skills-driven)","number":421,"updatedAt":"2026-08-18T09:52:00Z","url":"https://github.com/cli/cli/actions/runs/32123793136","workflowName":"Dependabot PR Triage (skills-driven)"}]\n';

/* ── which repository ── */

test('https, ssh and scp remotes on github.com and *.ghe.com name their owner and repository', () => {
  assert.deepEqual(githubRepoOfUrl('https://github.com/cli/cli.git'), { host: 'github.com', owner: 'cli', name: 'cli' });
  assert.deepEqual(githubRepoOfUrl('https://github.com/octo/app/'), { host: 'github.com', owner: 'octo', name: 'app' });
  assert.deepEqual(githubRepoOfUrl('ssh://git@github.com:22/octo/app.git'), { host: 'github.com', owner: 'octo', name: 'app' });
  assert.deepEqual(githubRepoOfUrl('git@github.com:octo/app.git'), { host: 'github.com', owner: 'octo', name: 'app' });
  assert.deepEqual(githubRepoOfUrl('https://acme.ghe.com/platform/api.v2'), { host: 'acme.ghe.com', owner: 'platform', name: 'api.v2' });
});

test('a remote carrying a credential still names the repository, and the credential is not part of what is kept', () => {
  const secret = ['hunter', '2'].join('');
  const repo = githubRepoOfUrl(`https://octo:${secret}@github.com/octo/app.git`);
  assert.deepEqual(repo, { host: 'github.com', owner: 'octo', name: 'app' });
  assert(!JSON.stringify(repo).includes(secret));
});

test('other hosts, other path shapes and names that could escape an API path are not GitHub repositories', () => {
  assert.equal(githubRepoOfUrl('https://gitlab.com/octo/app.git'), null);
  assert.equal(githubRepoOfUrl('https://github.com/octo'), null);
  assert.equal(githubRepoOfUrl('https://github.com/octo/app/issues'), null);
  assert.equal(githubRepoOfUrl('https://github.com/octo/..'), null);
  assert.equal(githubRepoOfUrl('git@github.com:-octo/app.git'), null);
  assert.equal(githubRepoOfUrl('https://github.com/octo/app%3Fx'), null);
  assert.equal(githubRepoOfUrl('/Users/someone/app'), null);
});

test('with several GitHub remotes, the one gh set-default marked wins, then upstream, github and origin in gh’s own order', () => {
  const remotes = 'origin\tgit@github.com:me/app.git (fetch)\norigin\tgit@github.com:me/app.git (push)\nupstream\thttps://github.com/octo/app.git (fetch)\nupstream\thttps://github.com/octo/app.git (push)\n';
  const upstream = chooseGitHubRemote(remotes, null);
  assert(upstream.ok);
  assert.deepEqual(upstream.repo, { host: 'github.com', owner: 'octo', name: 'app', remote: 'upstream' });
  const marked = chooseGitHubRemote(remotes, ghResolvedBase('remote.origin.gh-resolved base\n'));
  assert(marked.ok);
  assert.equal(marked.repo.owner, 'me');
  assert.equal(ghResolvedBase(''), null);
});

test('no remote and remotes on other hosts each say why nothing is watched, naming the hosts', () => {
  const empty = chooseGitHubRemote('', null);
  assert(!empty.ok);
  assert.equal(empty.detail, 'This repository has no git remote, so there is no GitHub repository to watch.');
  const gitlab = chooseGitHubRemote('origin\thttps://gitlab.com/octo/mirror.git (fetch)\norigin\thttps://gitlab.com/octo/mirror.git (push)\n', null);
  assert(!gitlab.ok);
  assert.equal(gitlab.detail, 'This repository’s remotes point at gitlab.com. Intake watches repositories on github.com and GitHub Enterprise Cloud (*.ghe.com) only, so nothing is watched.');
});

/* ── the timer ── */

test('an interval under ten minutes is refused rather than clamped, and so are fractions, strings and more than a day', () => {
  assert.throws(() => timerInput({ enabled: true, intervalMinutes: 9 }), /at least 10 minutes; 9 would ask GitHub more often/);
  assert.throws(() => timerInput({ enabled: false, intervalMinutes: 9 }), /at least 10 minutes/);
  assert.throws(() => timerInput({ enabled: true, intervalMinutes: 10.5 }), /whole number of minutes/);
  assert.throws(() => timerInput({ enabled: true, intervalMinutes: '15' }), /whole number of minutes/);
  assert.throws(() => timerInput({ enabled: true, intervalMinutes: 1441 }), /at most 1440 minutes/);
  assert.throws(() => timerInput({ enabled: 'yes', intervalMinutes: 15 }), /either on or off/);
  assert.deepEqual(timerInput({ enabled: true, intervalMinutes: 10 }), { enabled: true, intervalMinutes: 10 });
});

/* ── the window and the gap ── */

test('the first check looks back a day and says so; later checks start where the last success ended', () => {
  const until = at('2026-09-15T12:00:00Z');
  assert.deepEqual(pollWindow(null, until), { since: until - FIRST_LOOKBACK_MS, lookback: true });
  assert.deepEqual(pollWindow(until - 900_000, until), { since: until - 900_000, lookback: false });
  assert.deepEqual(pollWindow(until + 60_000, until), { since: until, lookback: false }, 'a clock that went backwards leaves an empty window');
  assert.equal(lookbackSentence({ lookback: true, repo: 'github.com/octo/app' }),
    'This was the first successful check of octo/app, so it read the 24 h before it; anything older is not in this inbox.');
  assert.equal(lookbackSentence({ lookback: false, repo: 'github.com/octo/app' }), null);
});

test('a window no longer than the timer’s interval is not a gap; a longer one counts only the time beyond it', () => {
  const until = at('2026-09-15T12:00:00Z');
  const quarter = 15 * 60_000;
  assert.equal(unwatchedMs({ since: until - 16 * 60_000, until, lookback: false, intervalMs: quarter }), null);
  assert.equal(unwatchedMs({ since: until - 6 * 3_600_000, until, lookback: false, intervalMs: quarter }), 6 * 3_600_000 - quarter);
  assert.equal(unwatchedMs({ since: until - 6 * 3_600_000, until, lookback: true, intervalMs: quarter }), null);
});

test('with the timer off only presses watch, so a long window is unwatched from end to end', () => {
  const until = at('2026-09-15T12:00:00Z');
  assert.equal(unwatchedMs({ since: until - 5 * 60_000, until, lookback: false, intervalMs: null }), null);
  assert.equal(unwatchedMs({ since: until - 3 * 3_600_000, until, lookback: false, intervalMs: null }), 3 * 3_600_000);
});

test('the gap sentence says how long nothing was watching, why that can happen, and what it costs', () => {
  const until = at('2026-09-15T12:00:00Z');
  const since = until - 6 * 3_600_000;
  assert.equal(gapSentence({ since, until, intervalMs: 15 * 60_000, gapMs: 6 * 3_600_000 - 15 * 60_000 }),
    'Nothing was watching for 5 h 45 min: the last successful check was 6 h before this one, and the timer asks every 15 minutes. '
    + 'Wanigan was closed, this Mac was asleep, the timer was off, or checks failed in between. '
    + 'An issue opened and closed, a label added and removed, or a run that failed and was re-run, in that time is not in this inbox.');
  assert.match(gapSentence({ since, until, intervalMs: null, gapMs: 6 * 3_600_000 }) ?? '',
    /^Nothing was watching for 6 h: the timer is off, so GitHub is read only when someone presses, and the last successful check was 6 h before this one\. An issue opened and closed/);
  assert.equal(gapSentence({ since, until, intervalMs: 15 * 60_000, gapMs: null }), null);
});

test('spans read in minutes, hours and days, rounded down so a gap is never overstated', () => {
  assert.equal(spanWords(59_999), 'less than a minute');
  assert.equal(spanWords(12 * 60_000 + 59_000), '12 min');
  assert.equal(spanWords(5 * 3_600_000 + 45 * 60_000 + 30_000), '5 h 45 min');
  assert.equal(spanWords(2 * 3_600_000), '2 h');
  assert.equal(spanWords(3 * 86_400_000 + 2 * 3_600_000 + 59 * 60_000), '3 days 2 h');
});

/* ── the reads ── */

test('each read is one argv array of single tokens, and the comment read is pinned to GET', () => {
  const from = at('2026-09-15T01:00:00.250Z');
  assert.deepEqual(issueArgs(CLI, from), ['issue', 'list', '--repo=github.com/cli/cli', '--state=open', '--search=updated:>=2026-09-15T01:00:00Z',
    `--limit=${ISSUE_LIMIT}`, '--json', 'number,title,labels,author,url,createdAt,updatedAt']);
  assert.deepEqual(commentArgs(CLI, from), ['api', '--method=GET', '--hostname=github.com',
    `repos/cli/cli/issues/comments?since=2026-09-15T01:00:00Z&sort=updated&direction=desc&per_page=${COMMENT_LIMIT}`]);
  assert.deepEqual(runArgs(CLI), ['run', 'list', '--repo=github.com/cli/cli', '--status=failure', `--limit=${RUN_LIMIT}`,
    '--json', 'databaseId,attempt,number,name,displayTitle,workflowName,headBranch,event,conclusion,createdAt,updatedAt,url']);
  for (const argv of [issueArgs(CLI, from), commentArgs(CLI, from), runArgs(CLI)]) {
    assert(!argv.some((a) => /^(-f|-F|--field|--raw-field|--input|-X)$/.test(a) || /^--method=(?!GET$)/.test(a)), JSON.stringify(argv));
  }
});

test('an issue created inside the window is opened, and each label on an updated issue is its own labelled fact with no invented time', () => {
  const r = parseIssues(ISSUES, CLI, at('2026-09-14T12:00:00Z'), none);
  assert(r.read === 'ok');
  assert.deepEqual(r.facts.map((f) => [f.kind, f.key, f.at]), [
    ['opened', 'github.com/cli/cli:issue:14449:opened', at('2026-09-15T01:25:33Z')],
    ['labelled', 'github.com/cli/cli:issue:14449:label:enhancement', null],
    ['labelled', 'github.com/cli/cli:issue:14449:label:gh-auth', null],
    ['labelled', 'github.com/cli/cli:issue:14439:label:needs-triage', null],
  ]);
  assert.equal(r.facts[0].summary, 'Issue #14449 opened by babakks in cli/cli: “Refreshable (short-lived) OAuth token support” — https://github.com/cli/cli/issues/14449');
  assert.equal(r.facts[3].summary, 'Issue #14439 in cli/cli carries the label “needs-triage”: “Allow for [skip ci] in gh repo create --template” — https://github.com/cli/cli/issues/14439');
  assert.equal(r.facts[0].url, 'https://github.com/cli/cli/issues/14449');
  assert.equal(r.capped, null);
});

test('a comment on an issue inside the window is commented; a pull request’s comment from the same endpoint is not an issue', () => {
  const r = parseComments(COMMENTS, CLI, at('2026-09-14T12:00:00Z'), none);
  assert(r.read === 'ok');
  assert.deepEqual(r.facts.map((f) => f.key), ['github.com/cli/cli:comment:5674221994', 'github.com/cli/cli:comment:5673288899']);
  assert.equal(r.facts[1].summary, 'cli-triage[bot] commented on issue #14449 in cli/cli: “This looks like a maintainer-authored design/envelope issue (assignee `babakks`,” — https://github.com/cli/cli/issues/14449#issuecomment-5673288899');
  const late = parseComments(COMMENTS, CLI, at('2026-09-15T02:00:00Z'), none);
  assert(late.read === 'ok');
  assert.deepEqual(late.facts.map((f) => f.key), ['github.com/cli/cli:comment:5674221994'], 'a comment created before the window and edited inside it is not a new comment');
});

test('a failed run is keyed by run and attempt, and only when it last changed inside the window', () => {
  const r = parseRuns(RUNS, CLI, at('2026-08-18T10:00:00Z'), none);
  assert(r.read === 'ok');
  assert.deepEqual(r.facts.map((f) => [f.key, f.at]), [['github.com/cli/cli:run:32128760676:attempt:1', at('2026-08-18T10:51:04Z')]]);
  assert.equal(r.facts[0].summary, 'CI failed in cli/cli: Dependabot PR Triage (skills-driven) on trunk (schedule), run #422: “Dependabot PR Triage (skills-driven)” — https://github.com/cli/cli/actions/runs/32128760676');
  const rerun = parseRuns(RUNS.replace('"attempt":1,"conclusion":"failure","createdAt":"2026-08-18T10:50:38Z"', '"attempt":2,"conclusion":"failure","createdAt":"2026-08-18T10:50:38Z"'), CLI, at('2026-08-18T10:00:00Z'), none);
  assert(rerun.read === 'ok');
  assert.deepEqual(rerun.facts.map((f) => f.key), ['github.com/cli/cli:run:32128760676:attempt:2'], 'a second failed attempt is a second fact');
  const passing = parseRuns(RUNS.replace('"conclusion":"failure"', '"conclusion":"success"'), CLI, at('2026-08-18T10:00:00Z'), none);
  assert(passing.read === 'ok');
  assert.equal(passing.facts.length, 0, 'a row that did not fail is not recorded as a failure, whatever gh was asked for');
});

test('every string from GitHub passes through the injected redactor, and escapes, controls and bidi overrides are removed', () => {
  const secret = ['gh', 'p_', 'planted', 'Secret', '0123'].join('');
  const title = `Leaked ${secret} \u202Eevil\u202C \u001b[31mred\u001b[0m`;
  const body = JSON.stringify([{ author: { login: secret }, createdAt: '2026-09-15T01:00:00Z', labels: [{ name: `label-${secret}` }], number: 7, title, updatedAt: '2026-09-15T01:00:00Z', url: 'https://github.com/cli/cli/issues/7' }]);
  const r = parseIssues(body, CLI, at('2026-09-14T00:00:00Z'), (text) => text.split(secret).join('[R]'));
  assert(r.read === 'ok');
  assert(!JSON.stringify(r).includes(secret), JSON.stringify(r));
  assert.equal(r.facts[0].summary, 'Issue #7 opened by [R] in cli/cli: “Leaked [R] evil red” — https://github.com/cli/cli/issues/7');
  assert.equal(r.facts[1].key, 'github.com/cli/cli:issue:7:label:label-[r]');
});

test('a read that is not JSON or not a list fails with the read named, and a malformed row is skipped rather than invented', () => {
  const bad = parseIssues('Welcome to GitHub CLI!\n', CLI, 0, none);
  assert(bad.read === 'failed');
  assert.match(bad.detail, /^gh answered the read of open issues with something that was not JSON/);
  const object = parseRuns('{"message":"Not Found"}', CLI, 0, none);
  assert(object.read === 'failed');
  assert.match(object.detail, /not a list/);
  const odd = parseComments('[{"id":"12","html_url":"https://github.com/cli/cli/issues/1#issuecomment-12","created_at":"2026-09-15T01:00:00Z"},{"id":13,"html_url":"javascript:alert(1)","created_at":"2026-09-15T01:00:00Z"}]', CLI, 0, none);
  assert(odd.read === 'ok');
  assert.equal(odd.facts.length, 0);
});

test('a full list says it may have stopped short, and a long title cannot push a summary past what an event holds', () => {
  const many = JSON.stringify(Array.from({ length: ISSUE_LIMIT }, (_, i) => ({ number: i + 1, title: 'x'.repeat(5_000), createdAt: '2026-09-15T01:00:00Z', labels: [], url: `https://github.com/cli/cli/issues/${i + 1}` })));
  const r = parseIssues(many, CLI, 0, none);
  assert(r.read === 'ok');
  assert.equal(r.capped, `GitHub had at least ${ISSUE_LIMIT} open issues updated in this window and one check reads ${ISSUE_LIMIT}, so some may not be here.`);
  assert(r.facts.every((f) => f.summary.length <= EVENT_SUMMARY_MAX));
  const runs = JSON.stringify(Array.from({ length: RUN_LIMIT }, (_, i) => ({ databaseId: i + 1, attempt: 1, conclusion: 'failure', updatedAt: '2026-09-15T01:00:00Z', url: null })));
  const full = parseRuns(runs, CLI, 0, none);
  assert(full.read === 'ok');
  assert.match(full.capped ?? '', /^gh listed 50 failed runs and every one was in this window/);
  const older = parseRuns(runs.replace(/("databaseId":50,"attempt":1,"conclusion":"failure","updatedAt":)"2026-09-15T01:00:00Z"/, '$1"2026-01-01T00:00:00Z"'), CLI, at('2026-09-01T00:00:00Z'), none);
  assert(older.read === 'ok');
  assert.equal(older.capped, null, 'a full list whose last run is older than the window reached back past it');
});
