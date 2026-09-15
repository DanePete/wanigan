/**
 * Merge readiness, the pure half. Unless a test says otherwise, every fixture
 * below is the exact JSON gh 2.94.0 printed on 14 September 2026 against public
 * pull requests in cli/cli — `pr list` and `pr checks` for #13788, the
 * review-thread query for #13788 and #14259 (comment bodies shortened, and the
 * capture also asked for startDiffSide, which the parser does not read) — and
 * the failed-log lines are the byte shape of `gh run view --job=… --log-failed`
 * for that pull request's failing ubuntu job, BOM included.
 *
 * The subject is "can it lie". An empty check list that was really a failed
 * read, an outdated thread given a current line number, or a log excerpt that
 * is mostly cleanup steps would each send an agent after the wrong thing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  actionsJobOf, excerptCaption, failedLogExcerpt, firstLineOf, hostOfRemote, httpsUrl, isGitHubHost, mergeability,
  MAX_CHECKS, MAX_COMMENT_CHARS, MAX_LOG_LINES, MAX_LOG_LINE_CHARS, parseChecks, parsePullRequestList, parseThreads,
  plainText, remoteHosts, repoOfPullUrl, REVIEW_THREADS_QUERY, threadCapNote,
  type PrReadiness,
} from './pr-readiness.ts';

const none = (text: string) => text;

const LIST_13788 = '[{"baseRefName":"trunk","headRefName":"fix-percent-encoded-url","headRefOid":"2537a3b6931a787d6b4b0ab686cd4cf7eda0dfda","isDraft":false,"mergeStateStatus":"BLOCKED","mergeable":"MERGEABLE","number":13788,"state":"OPEN","statusCheckRollup":[{"__typename":"CheckRun","completedAt":"2026-07-03T11:19:44Z","conclusion":"FAILURE","detailsUrl":"https://github.com/cli/cli/actions/runs/28656994029/job/84988385122","name":"build (ubuntu-latest)","startedAt":"2026-07-03T11:15:44Z","status":"COMPLETED","workflowName":"Unit and Integration Tests"},{"__typename":"CheckRun","completedAt":"2026-07-03T11:18:53Z","conclusion":"SUCCESS","detailsUrl":"https://github.com/cli/cli/actions/runs/28656994018/job/84988385114","name":"CodeQL-Build (go)","startedAt":"2026-07-03T11:15:44Z","status":"COMPLETED","workflowName":"Code Scanning"}],"title":"fix: preserve percent-encoded path in DisplayURL","updatedAt":"2026-07-21T04:26:13Z","url":"https://github.com/cli/cli/pull/13788"}]\n';

const CHECK_CODEQL = '{"bucket":"pass","completedAt":"2026-07-03T11:16:18Z","description":"","event":"","link":"https://github.com/cli/cli/runs/84988484163","name":"CodeQL","startedAt":"2026-07-03T11:16:16Z","state":"SUCCESS","workflow":""}';
const CHECK_UBUNTU = '{"bucket":"fail","completedAt":"2026-07-03T11:19:44Z","description":"","event":"pull_request","link":"https://github.com/cli/cli/actions/runs/28656994029/job/84988385122","name":"build (ubuntu-latest)","startedAt":"2026-07-03T11:15:44Z","state":"FAILURE","workflow":"Unit and Integration Tests"}';
const CHECK_LINT = '{"bucket":"pass","completedAt":"2026-07-03T11:17:50Z","description":"","event":"pull_request","link":"https://github.com/cli/cli/actions/runs/28656994013/job/84988385189","name":"lint","startedAt":"2026-07-03T11:15:44Z","state":"SUCCESS","workflow":"Lint"}';
// From #14447 on the same day: the shape of a skipped job.
const CHECK_SKIP = '{"bucket":"skipping","completedAt":"2026-09-14T14:06:32Z","description":"","link":"https://github.com/cli/cli/actions/runs/34853446344/job/104006937060","name":"check-requirements","startedAt":"2026-09-14T14:06:43Z","state":"SKIPPED","workflow":"PR Triaging"}';

const THREADS_13788 = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"totalCount":1,"pageInfo":{"hasNextPage":false},"nodes":[{"isResolved":false,"isOutdated":false,"path":"internal/text/text.go","line":84,"startLine":84,"originalLine":84,"originalStartLine":null,"diffSide":"RIGHT","startDiffSide":null,"subjectType":"LINE","comments":{"totalCount":1,"nodes":[{"author":{"login":"Sanjays2402"},"body":"u.RawPath is only populated when the raw path differs from the default escaping of u.Path, so this misses the common case.","createdAt":"2026-07-21T04:26:13Z","url":"https://github.com/cli/cli/pull/13788#discussion_r3619422472"}]}}]}}}}}\n';
const THREADS_14259 = '{"data":{"repository":{"pullRequest":{"reviewThreads":{"totalCount":3,"pageInfo":{"hasNextPage":false},"nodes":[{"isResolved":true,"isOutdated":true,"path":"pkg/cmd/skills/publish/publish.go","line":null,"startLine":null,"originalLine":108,"originalStartLine":107,"diffSide":"RIGHT","startDiffSide":"RIGHT","subjectType":"LINE","comments":{"totalCount":1,"nodes":[{"author":{"login":"copilot-pull-request-reviewer"},"body":"💭 Commentary: This overstates the new restriction. `git.Client.PathFromRoot` returns an e","createdAt":"2026-08-25T14:55:03Z","url":"https://github.com/cli/cli/pull/14259#discussion_r3854260108"}]}},{"isResolved":false,"isOutdated":false,"path":"pkg/cmd/skills/publish/publish_test.go","line":197,"startLine":193,"originalLine":197,"originalStartLine":193,"diffSide":"RIGHT","startDiffSide":"RIGHT","subjectType":"LINE","comments":{"totalCount":1,"nodes":[{"author":{"login":"copilot-pull-request-reviewer"},"body":"🛑 Requirement: Cover the preserved diagnostic contract and the false branch.\\n\\nThis test d","createdAt":"2026-08-31T17:15:25Z","url":"https://github.com/cli/cli/pull/14259#discussion_r3896708963"}]}}]}}}}}\n';

test('the list names the pull request, its head commit and GitHub’s two mergeability words', () => {
  const r = parsePullRequestList(LIST_13788, none);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.found, {
    pr: { number: 13788, url: 'https://github.com/cli/cli/pull/13788', title: 'fix: preserve percent-encoded path in DisplayURL',
      isDraft: false, state: 'open', baseRef: 'trunk', headRef: 'fix-percent-encoded-url',
      headSha: '2537a3b6931a787d6b4b0ab686cd4cf7eda0dfda' },
    mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', checkCount: 2,
  });
});

test('an empty list is "no pull request", and output that is not a list is a failed read', () => {
  assert.deepEqual(parsePullRequestList('[]\n', none), { ok: true, found: null });
  assert.deepEqual(parsePullRequestList('{"number":1}', none), { ok: false, detail: 'gh answered with something that was not a list of pull requests.' });
  assert.deepEqual(parsePullRequestList('To get started with GitHub CLI', none), { ok: false, detail: 'gh answered with something that was not JSON.' });
});

test('an open pull request outranks a newer merged one, and words GitHub did not use are not invented', () => {
  // Joined at run time: ESLint rightly refuses a script URL literal, and this is
  // the one place such a URL is the input under test.
  const scriptUrl = ['javascript', 'alert(1)'].join(':');
  const rows = JSON.stringify([
    { number: 3, state: 'MERGED', isDraft: false, updatedAt: '2026-09-01T00:00:00Z', mergeable: 'UNKNOWN', url: 'https://github.com/o/r/pull/3' },
    { number: 7, state: 'OPEN', isDraft: true, updatedAt: '2026-08-01T00:00:00Z', mergeable: 'SOMETHING_NEW', mergeStateStatus: 'DRAFT',
      headRefOid: 'not-a-sha', url: scriptUrl, statusCheckRollup: [] },
  ]);
  const r = parsePullRequestList(rows, none);
  assert(r.ok && r.found);
  assert.equal(r.found.pr.number, 7);
  assert.equal(r.found.pr.isDraft, true);
  assert.equal(r.found.mergeable, null, 'an unrecognised mergeable value is "not said", not UNKNOWN');
  assert.equal(r.found.mergeStateStatus, 'DRAFT');
  assert.equal(r.found.pr.headSha, null);
  assert.equal(r.found.pr.url, null, 'a link the operating system would run is never passed on');
  assert.equal(r.found.checkCount, 0);
});

test('checks keep gh’s buckets and state words, failures first, and only Actions links name a run', () => {
  const r = parseChecks(`[${CHECK_CODEQL},${CHECK_UBUNTU},${CHECK_LINT},${CHECK_SKIP}]\n`, none);
  assert.equal(r.read, 'ok');
  if (r.read !== 'ok') return;
  assert.deepEqual(r.items.map((c) => [c.bucket, c.name]),
    [['fail', 'build (ubuntu-latest)'], ['pass', 'CodeQL'], ['pass', 'lint'], ['skipping', 'check-requirements']]);
  const [ubuntu, codeql] = r.items;
  assert.deepEqual(ubuntu, {
    name: 'build (ubuntu-latest)', workflow: 'Unit and Integration Tests', bucket: 'fail', state: 'FAILURE',
    link: 'https://github.com/cli/cli/actions/runs/28656994029/job/84988385122',
    startedAt: Date.parse('2026-07-03T11:15:44Z'), completedAt: Date.parse('2026-07-03T11:19:44Z'), description: null,
    actions: { repo: 'github.com/cli/cli', runId: '28656994029', jobId: '84988385122' },
  });
  // CodeQL is a GitHub App's check run: its /runs/ number is not a workflow run.
  assert.equal(codeql.workflow, null);
  assert.equal(codeql.actions, null);
  assert.equal(r.omitted, 0);
});

test('a row without a bucket is sorted the way gh sorts it, and Go’s zero time is not a date', () => {
  const rows = JSON.stringify([
    { name: 'deploy', state: 'TIMED_OUT', link: '', startedAt: '2026-09-14T10:00:00Z', completedAt: '0001-01-01T00:00:00Z' },
    { name: 'legacy-ci', state: 'CANCELLED', description: 'Build was canceled' },
    { name: 'queued', state: 'QUEUED' },
    { name: 'neutral', state: 'NEUTRAL' },
  ]);
  const r = parseChecks(rows, none);
  assert(r.read === 'ok');
  assert.deepEqual(r.items.map((c) => [c.name, c.bucket]), [['deploy', 'fail'], ['legacy-ci', 'cancel'], ['queued', 'pending'], ['neutral', 'skipping']]);
  assert.equal(r.items[0].completedAt, null);
  assert.equal(r.items[0].link, null);
  assert.equal(r.items[1].description, 'Build was canceled');
});

test('a check list is bounded and says how many it left out', () => {
  const rows = JSON.stringify(Array.from({ length: MAX_CHECKS + 5 }, (_, i) => ({ name: `job ${i}`, bucket: 'pass', state: 'SUCCESS' })));
  const r = parseChecks(rows, none);
  assert(r.read === 'ok');
  assert.equal(r.items.length, MAX_CHECKS);
  assert.equal(r.omitted, 5);
  assert.equal(parseChecks('no checks reported', none).read, 'failed');
});

test('an Actions link yields only digits and a validated repository', () => {
  assert.deepEqual(actionsJobOf('https://ghe.example.com/octo_acme/my.repo/actions/runs/12/job/34'),
    { repo: 'ghe.example.com/octo_acme/my.repo', runId: '12', jobId: '34' });
  assert.deepEqual(actionsJobOf('https://github.com/o/r/actions/runs/99'), { repo: 'github.com/o/r', runId: '99', jobId: null });
  for (const bad of [
    'http://github.com/o/r/actions/runs/1/job/2',
    'https://github.com/o/r/runs/84988484163',
    'https://github.com/o/../actions/runs/1',
    'https://github.com/-o/r/actions/runs/1',
    'https://user:pw@github.com/o/r/actions/runs/1',
    'https://github.com:8443/o/r/actions/runs/1',
    'https://github.com/o/r/actions/runs/1/job/2/extra',
    'https://github.com/o/r/actions/runs/--repo=x',
  ]) assert.equal(actionsJobOf(bad), null, bad);
});

test('review threads keep their anchors, and an outdated thread gets no current line', () => {
  const r = parseThreads(THREADS_14259, none);
  assert.equal(r.read, 'ok');
  if (r.read !== 'ok') return;
  assert.equal(r.total, 3);
  // Two of the three nodes are in this shortened fixture; the count GitHub gave still stands.
  assert.equal(r.capped, true);
  const [outdated, current] = r.items;
  assert.deepEqual({ ...outdated, comments: [] }, {
    isResolved: true, isOutdated: true, path: 'pkg/cmd/skills/publish/publish.go', line: null, startLine: null,
    originalLine: 108, originalStartLine: 107, side: 'RIGHT', subject: 'line', comments: [], commentsOmitted: 0,
  });
  assert.deepEqual(current.comments, [{
    author: 'copilot-pull-request-reviewer',
    body: '🛑 Requirement: Cover the preserved diagnostic contract and the false branch.\n\nThis test d', bodyCut: 0,
    createdAt: Date.parse('2026-08-31T17:15:25Z'), url: 'https://github.com/cli/cli/pull/14259#discussion_r3896708963',
  }]);
  assert.deepEqual([current.startLine, current.line, current.isResolved], [193, 197, false]);
});

test('a single-line thread and its whole count read as complete', () => {
  const r = parseThreads(THREADS_13788, none);
  assert(r.read === 'ok');
  assert.deepEqual([r.total, r.capped, r.items[0].line, r.items[0].startLine], [1, false, 84, 84]);
  assert.equal(threadCapNote(r), null);
});

test('a capped read says how many threads GitHub holds and that later ones are not listed', () => {
  const node = { isResolved: false, isOutdated: false, path: 'a.ts', line: 1, diffSide: 'RIGHT', subjectType: 'LINE', comments: { totalCount: 0, nodes: [] } };
  const body = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
    totalCount: 137, pageInfo: { hasNextPage: true }, nodes: Array.from({ length: 100 }, () => node) } } } } });
  const r = parseThreads(body, none);
  assert(r.read === 'ok');
  assert.deepEqual([r.items.length, r.total, r.capped], [100, 137, true]);
  assert.equal(threadCapNote(r),
    'GitHub holds 137 review threads on this pull request and the first 100 were read, so an unresolved thread after those is not listed here.');
});

test('a GraphQL error is a failed read that carries GitHub’s own message, never zero threads', () => {
  const body = '{"data":{"repository":null},"errors":[{"type":"NOT_FOUND","path":["repository"],"locations":[{"line":1,"column":57}],"message":"Could not resolve to a Repository with the name \'cli/no-such-repo-wanigan\'."}]}';
  assert.deepEqual(parseThreads(body, none), { read: 'failed', detail: 'Could not resolve to a Repository with the name \'cli/no-such-repo-wanigan\'.' });
  assert.equal(parseThreads('', none).read, 'failed');
});

test('a thread body is bounded and counts what it cut; a deleted author and a file-level thread read as themselves', () => {
  const long = 'x'.repeat(MAX_COMMENT_CHARS + 25);
  const body = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{
    isResolved: false, isOutdated: false, path: 'README.md', line: null, subjectType: 'FILE',
    comments: { totalCount: 14, nodes: [{ author: null, body: long, createdAt: 'junk', url: 'https://github.com/o/r/pull/1#discussion_r1' }] },
  }] } } } } });
  const r = parseThreads(body, none);
  assert(r.read === 'ok');
  const [thread] = r.items;
  assert.deepEqual([thread.subject, thread.comments[0].author, thread.comments[0].bodyCut, thread.comments[0].createdAt, thread.commentsOmitted],
    ['file', null, 25, null, 13]);
  assert.equal(thread.comments[0].body.length, MAX_COMMENT_CHARS);
});

test('every string in a thread passes through the injected redactor', () => {
  const secret = ['hunter', '2', '-', 'planted'].join('');
  const body = JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount: 1, pageInfo: { hasNextPage: false }, nodes: [{
    isResolved: false, isOutdated: false, path: `src/${secret}.ts`, line: 3, diffSide: 'LEFT', subjectType: 'LINE',
    comments: { totalCount: 1, nodes: [{ author: { login: secret }, body: `use ${secret} here`, createdAt: null, url: null }] },
  }] } } } } });
  const r = parseThreads(body, (text) => text.split(secret).join('[R]'));
  assert(r.read === 'ok');
  assert(!JSON.stringify(r).includes(secret), JSON.stringify(r));
  assert.equal(r.items[0].comments[0].body, 'use [R] here');
  assert.equal(r.items[0].side, 'LEFT');
});

test('the query asks for every field the parser reads', () => {
  for (const field of ['totalCount', 'hasNextPage', 'isResolved', 'isOutdated', 'path', 'line', 'startLine', 'originalLine',
    'originalStartLine', 'diffSide', 'subjectType', 'author', 'login', 'body', 'createdAt', 'url']) {
    assert.match(REVIEW_THREADS_QUERY, new RegExp(`\\b${field}\\b`), field);
  }
  assert.match(REVIEW_THREADS_QUERY, /reviewThreads\(first: 100\)/);
});

// The byte shape of the failing ubuntu job's log: job, step and timestamp,
// tab-separated, a BOM on a step's first line, and cleanup after the error.
const logLine = (text: string, bom = false) => `build (ubuntu-latest)\tUNKNOWN STEP\t${bom ? '\uFEFF' : ''}2026-07-03T11:19:35.1943648Z ${text}`;

test('a failed log excerpt ends at GitHub’s last error marker and says what it left out either side', () => {
  const tail = [
    logLine('Current runner version: 2.325.0', true),
    ...Array.from({ length: 120 }, (_, i) => logLine(`ok  \tgithub.com/cli/cli/v2/pkg/cmd/${i}\t1.020s`)),
    logLine('--- FAIL: TestViewRun (0.02s)'),
    logLine('\x1b[31mFAIL\x1b[0m\tgithub.com/cli/cli/v2/pkg/cmd/workflow/view\t0.240s'),
    logLine('##[error]Process completed with exit code 1.'),
    ...Array.from({ length: 33 }, (_, i) => logLine(`[command]/usr/bin/git config --local --unset-all cleanup-${i}`)),
  ].join('\n') + '\n';
  const log = failedLogExcerpt(tail, 500, none);
  assert.equal(log.anchored, true);
  assert.equal(log.lines.length, MAX_LOG_LINES);
  assert.deepEqual(log.lines.slice(-3), [
    '--- FAIL: TestViewRun (0.02s)',
    'FAIL\tgithub.com/cli/cli/v2/pkg/cmd/workflow/view\t0.240s',
    '##[error]Process completed with exit code 1.',
  ]);
  assert.equal(log.after, 33);
  // 1 + 120 + 3 lines up to the marker; the excerpt keeps the last 80, and 500 were let go before the tail.
  assert.equal(log.before, 500 + (124 - MAX_LOG_LINES));
  assert.equal(excerptCaption(log), 'The last 80 lines of its failed-step log, up to GitHub’s last error marker (544 earlier and 33 later lines not shown)');
});

test('with no error marker the excerpt is the end of the log, and a blank log is no excerpt', () => {
  const log = failedLogExcerpt([logLine('first', true), logLine('second')].join('\n'), 0, none);
  assert.deepEqual(log, { lines: ['first', 'second'], anchored: false, before: 0, after: 0 });
  assert.equal(excerptCaption(log), 'The last 2 lines of its failed-step log');
  assert.deepEqual(failedLogExcerpt('\n\n', 0, none).lines, []);
});

test('a long log line is bounded, and redaction sees the whole tail so a key block split by the window is still one block', () => {
  const long = failedLogExcerpt(logLine('y'.repeat(MAX_LOG_LINE_CHARS + 50)), 0, none);
  assert.equal(long.lines[0], `${'y'.repeat(MAX_LOG_LINE_CHARS)} …`);
  const pem = ['-----BEGIN RSA PRIVATE KEY-----', ...Array.from({ length: 100 }, () => 'bodyline'), '-----END RSA PRIVATE KEY-----', '##[error]boom'];
  const seen: string[] = [];
  const out = failedLogExcerpt(pem.join('\n'), 0, (text) => { seen.push(text); return text.replace(/-----BEGIN[\s\S]*?END RSA PRIVATE KEY-----/, '[KEY]'); });
  assert.equal(seen.length, 1, 'the redactor ran once, over the whole tail');
  assert.deepEqual(out.lines, ['[KEY]', '##[error]boom']);
});

test('control characters, escape sequences and bidirectional overrides are removed from untrusted text', () => {
  assert.equal(plainText('a\x1b[1;31mred\x1b[0m\u202eevil\u2066 b\r\nc\x07'), 'aredevil b\nc');
  assert.equal(firstLineOf('\n  gh: Could not resolve\nsecond line', none), 'gh: Could not resolve');
});

test('a link survives only as https without a credential in it', () => {
  assert.equal(httpsUrl('https://github.com/o/r/pull/1', none), 'https://github.com/o/r/pull/1');
  assert.equal(httpsUrl('https://x:y@github.com/o/r', none), null);
  assert.equal(httpsUrl('file:///etc/passwd', none), null);
  assert.equal(httpsUrl('https://github.com/o/r?token=abc', (t) => t.replace(/token=\w+/, 'token=[R]')), null);
  assert.deepEqual(repoOfPullUrl('https://ghe.example.com/team/app/pull/42'), { host: 'ghe.example.com', owner: 'team', name: 'app' });
  assert.equal(repoOfPullUrl('https://github.com/team/app/issues/42'), null);
});

test('remote hosts come from https, ssh and scp-like URLs; local paths have none', () => {
  const verbose = [
    'origin\tgit@github.com:cli/cli.git (fetch)',
    'origin\tgit@github.com:cli/cli.git (push)',
    'mirror\thttps://GitLab.com/example/example.git (fetch)',
    'work\tssh://git@ghe.example.com:2222/team/app.git (fetch)',
    'alias\tgit@github-work:team/app.git (fetch)',
    'local\t/Users/me/src/app (fetch)',
    'drive\tC:/src/app (fetch)',
  ].join('\n');
  assert.deepEqual(remoteHosts(verbose), { remotes: 6, hosts: ['github.com', 'gitlab.com', 'ghe.example.com', 'github-work'] });
  assert.deepEqual(remoteHosts(''), { remotes: 0, hosts: [] });
  assert.equal(hostOfRemote('file:///tmp/repo.git'), null);
  assert.deepEqual([isGitHubHost('github.com'), isGitHubHost('octo.ghe.com'), isGitHubHost('gitlab.com')], [true, true, false]);
});

test('mergeability reads conflicts before blocks, and "not computed" apart from "not said"', () => {
  const pr: PrReadiness['pr'] = { number: 42, url: null, title: 't', isDraft: false, state: 'open', baseRef: 'main', headRef: 'feature-x', headSha: null };
  const read = (mergeable: PrReadiness['mergeable'], mergeStateStatus: PrReadiness['mergeStateStatus'], over: Partial<typeof pr> = {}) =>
    mergeability({ pr: { ...pr, ...over }, mergeable, mergeStateStatus }).outcome;
  assert.equal(read('CONFLICTING', 'DIRTY'), 'conflicts');
  assert.equal(read('UNKNOWN', 'DIRTY'), 'conflicts');
  assert.equal(read('UNKNOWN', 'UNKNOWN'), 'unknown');
  assert.equal(read(null, null), 'unread');
  assert.equal(read('MERGEABLE', 'BLOCKED'), 'blocked');
  assert.equal(read('MERGEABLE', 'BEHIND'), 'behind');
  assert.equal(read('MERGEABLE', 'UNSTABLE'), 'unstable');
  assert.equal(read('MERGEABLE', 'CLEAN'), 'clean');
  assert.equal(read('MERGEABLE', 'HAS_HOOKS'), 'clean');
  assert.equal(read('MERGEABLE', null), 'no-conflicts');
  assert.equal(read('MERGEABLE', 'CLEAN', { isDraft: true }), 'draft');
  assert.equal(read('UNKNOWN', 'UNKNOWN', { state: 'merged' }), 'merged');
  assert.equal(read('CONFLICTING', 'DIRTY', { state: 'closed' }), 'closed');
  assert.equal(mergeability({ pr, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }).sentence,
    'GitHub cannot merge feature-x into main: they conflict.');
});
