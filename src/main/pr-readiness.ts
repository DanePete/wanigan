import path from 'node:path';
import { repoState, runGit, scopeOf } from './git';
import { ghVersion, resolveGh, runGh, runGhTail, type GhRun } from './gh';
import { projectById } from './store';
import { assertManagedRoot } from './roots';
import { redactCredentials } from './redact';
import {
  actionsJobOf, failedLogExcerpt, firstLineOf, httpsUrl, isGitHubHost, parseChecks, parsePullRequestList, parseThreads,
  remoteHosts, repoOfPullUrl, REVIEW_THREADS_QUERY,
  type ChecksRead, type FailedLogReport, type PrReadinessReport, type PrReadinessStatus, type ReadinessPr, type ThreadsRead,
} from '../shared/pr-readiness';

/**
 * Merge readiness for the branch a project has checked out, read through the
 * operator's own gh when the operator presses for it.
 *
 * Three questions, because GitHub answers none of them unprompted: whether the
 * pull request still merges (no webhook fires when a base moves and creates a
 * conflict), which checks failed, and which inline review threads are still
 * open (`gh pr view --comments` does not show them; the review-thread API
 * does). Then, on a second press per failing check, the end of that job's
 * failed-step log.
 *
 * Nothing is polled, cached or persisted. Each press asks GitHub again, and the
 * answer lives in the renderer until the next one. The single thing kept in
 * memory is which Actions jobs the last read of each project returned, so the
 * log channel fetches only a log this app was shown, rather than any log the
 * operator's token can reach. Nothing is ever written to GitHub from here.
 *
 * gh's stderr is never parsed for a fact. Whether a failed read means "not
 * signed in" or "not a GitHub repository" is asked as its own question — the
 * repository's remotes, and `gh auth status` for a host — and the answer is an
 * exit status. gh's own first line is kept beside the classification either way.
 */

const READ_TIMEOUT = 30_000;
const AUTH_TIMEOUT = 10_000;
const LOG_TIMEOUT = 90_000;
/** How much of a failed-step log is held while gh streams it; the excerpt comes from the end of this. */
const LOG_KEEP_BYTES = 1024 * 1024;
/** A pathological review-thread answer is refused as a failed read rather than held. */
const THREADS_MAX_BUFFER = 16 * 1024 * 1024;
const LIST_FIELDS = 'number,title,state,isDraft,url,baseRefName,headRefName,headRefOid,mergeable,mergeStateStatus,statusCheckRollup,updatedAt';
const CHECK_FIELDS = 'name,workflow,bucket,state,link,startedAt,completedAt,description';

const redact = redactCredentials;

/** Actions job links, by project, from the last read that reached the checks. In memory only. */
const lastJobs = new Map<string, Set<string>>();

function managedProject(projectId: unknown): { id: string; dir: string } {
  const project = typeof projectId === 'string' ? projectById(projectId) : undefined;
  if (!project) throw new Error('That project is not registered with Wanigan.');
  return { id: project.id, dir: assertManagedRoot(project.path, 'That project folder') };
}

/** What gh said when a read failed: its own first line, cleaned, or the timeout in words. */
function ghSaid(r: GhRun): string {
  if (r.killed) return 'gh did not answer in time.';
  return firstLineOf(r.err, redact) || (r.code === null ? 'gh could not be run.' : `gh exited ${r.code} without saying why.`);
}

/**
 * A failed list, classified by asking rather than by reading prose. No remote
 * at all, or remotes only on hosts that are neither GitHub's nor ones gh is
 * signed in to, is "not a GitHub repository". A GitHub host gh cannot use is
 * "not signed in". Anything else is gh's own first line.
 */
async function classifyFailedList(bin: string, repoRoot: string, list: GhRun): Promise<PrReadinessStatus> {
  if (list.killed) return { kind: 'error', detail: 'gh did not answer in time.' };
  const said = ghSaid(list);
  const remotes = await runGit(repoRoot, ['remote', '-v'], { timeout: 8_000, maxBuffer: 1024 * 1024 });
  const signedIn = async (host?: string) =>
    (await runGh(bin, repoRoot, host ? ['auth', 'status', `--hostname=${host}`] : ['auth', 'status'], { timeout: AUTH_TIMEOUT })).ok;
  if (remotes.ok) {
    const { remotes: count, hosts } = remoteHosts(remotes.out);
    if (count === 0) {
      return { kind: 'not-github', detail: `This repository has no git remote, so there is no pull request on GitHub to read. gh said: ${said}` };
    }
    const github = hosts.filter(isGitHubHost);
    if (!github.length) {
      // Sequential and capped: each is a sign-in check against one host.
      for (const host of hosts.slice(0, 4)) {
        if (await signedIn(host)) return { kind: 'error', detail: said };
      }
      const named = hosts.length ? hosts.slice(0, 4).join(', ') : 'no host Wanigan could read';
      return {
        kind: 'not-github',
        detail: `This repository’s remotes point at ${named}, and gh is signed in to none of them. ` +
          `If one is a GitHub Enterprise host, run \`gh auth login --hostname <host>\` in your terminal. gh said: ${said}`,
      };
    }
    if (!(await signedIn(github[0]))) {
      return { kind: 'unauthenticated', detail: `gh is installed but not signed in to ${github[0]}. Run \`gh auth login\` in your terminal, then check again.` };
    }
    return { kind: 'error', detail: said };
  }
  if (!(await signedIn())) {
    return { kind: 'unauthenticated', detail: 'gh is installed but not signed in. Run `gh auth login` in your terminal, then check again.' };
  }
  return { kind: 'error', detail: said };
}

async function readChecks(bin: string, repoRoot: string, pr: ReadinessPr, checkCount: number): Promise<ChecksRead> {
  // An empty status rollup is GitHub saying the head has no checks. `gh pr
  // checks` would say the same in stderr prose with exit 1, which is also what
  // a failed read looks like, so it is not asked.
  if (checkCount === 0) return { read: 'none' };
  const r = await runGh(bin, repoRoot, ['pr', 'checks', String(pr.number), '--json', CHECK_FIELDS], { timeout: READ_TIMEOUT });
  // gh documents exit 8 as "checks pending"; with --json it prints the rows
  // either way, so a pending exit with rows is an answer, not a failure.
  if (!r.ok && !(r.code === 8 && r.out.trim().startsWith('['))) return { read: 'failed', detail: ghSaid(r) };
  return parseChecks(r.out, redact);
}

async function readThreads(bin: string, repoRoot: string, pr: ReadinessPr): Promise<ThreadsRead> {
  const repo = repoOfPullUrl(pr.url);
  if (!repo) return { read: 'failed', detail: 'gh gave this pull request no GitHub link Wanigan could read, so its review threads could not be asked for.' };
  // One argv token per value. Raw fields carry no `@file` or placeholder
  // expansion; the number is typed and was validated as a positive integer.
  const r = await runGh(bin, repoRoot, [
    'api', 'graphql', `--hostname=${repo.host}`,
    `--raw-field=query=${REVIEW_THREADS_QUERY}`, `--raw-field=owner=${repo.owner}`, `--raw-field=name=${repo.name}`,
    `--field=number=${pr.number}`,
  ], { timeout: READ_TIMEOUT, maxBuffer: THREADS_MAX_BUFFER });
  if (!r.ok) return { read: 'failed', detail: ghSaid(r) };
  return parseThreads(r.out, redact);
}

export async function readinessReport(projectId: unknown): Promise<PrReadinessReport> {
  const project = managedProject(projectId);
  const fetchedAt = Date.now();
  const report = (status: PrReadinessStatus, gh: PrReadinessReport['gh'] = null): PrReadinessReport => ({ status, fetchedAt, gh });
  // A new read supersedes the last one's jobs whatever it finds: a log fetched
  // after this would be for checks the screen no longer shows.
  lastJobs.delete(project.id);

  const scope = await scopeOf(project.dir);
  if (!scope) return report({ kind: 'no-branch', detail: `${path.resolve(project.dir)} is not a git repository.` });
  const state = await repoState(scope.root);
  if (state.kind === 'absent') return report({ kind: 'no-branch', detail: 'This is not a git repository.' });
  if (state.kind === 'unreadable') return report({ kind: 'error', detail: state.reason });
  if (state.kind === 'unborn') return report({ kind: 'no-branch', detail: 'This repository has no commits yet, so there is no branch to have a pull request.' });
  if (state.kind === 'detached') return report({ kind: 'no-branch', detail: 'HEAD is detached, and a pull request belongs to a branch.' });

  const bin = await resolveGh();
  if (!bin) return report({ kind: 'missing' });
  const gh = { path: bin, version: await ghVersion(bin) };

  const list = await runGh(bin, scope.repoRoot, ['pr', 'list', `--head=${state.branch}`, '--state=all', '--limit=20', '--json', LIST_FIELDS],
    { timeout: READ_TIMEOUT });
  if (!list.ok) return report(await classifyFailedList(bin, scope.repoRoot, list), gh);
  const picked = parsePullRequestList(list.out, redact);
  if (!picked.ok) return report({ kind: 'error', detail: picked.detail }, gh);
  if (!picked.found) return report({ kind: 'no-pr', branch: state.branch }, gh);

  const { pr, mergeable, mergeStateStatus, checkCount } = picked.found;
  const [checks, threads, local] = await Promise.all([
    readChecks(bin, scope.repoRoot, pr, checkCount),
    readThreads(bin, scope.repoRoot, pr),
    runGit(scope.root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { timeout: 8_000, maxBuffer: 64 * 1024 }),
  ]);
  if (checks.read === 'ok') {
    lastJobs.set(project.id, new Set(checks.items.filter((c) => c.actions && c.link).map((c) => c.link as string)));
  }
  const localHead = local.ok && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(local.out.trim()) ? local.out.trim() : null;
  return report({ kind: 'ok', branch: state.branch, readiness: { pr, localHead, mergeable, mergeStateStatus, checks, threads } }, gh);
}

/**
 * The end of one failing check's failed-step log. Refused for a link the last
 * read of this project did not return: the renderer is not trusted to choose
 * which of the operator's repositories gh reads a log from.
 */
export async function failedCheckLog(projectId: unknown, link: unknown): Promise<FailedLogReport> {
  const project = managedProject(projectId);
  const normal = httpsUrl(link, redact);
  const job = actionsJobOf(normal);
  if (!normal || !job) {
    return { kind: 'not-actions', detail: 'This check is not a GitHub Actions job, so gh has no log to fetch for it. Its page on GitHub has the output.' };
  }
  if (!lastJobs.get(project.id)?.has(normal)) {
    throw new Error('That check is not in the last readiness read of this project. Check readiness again, then fetch its log.');
  }
  const bin = await resolveGh();
  if (!bin) return { kind: 'missing' };
  const target = job.jobId ? [`--job=${job.jobId}`] : [job.runId];
  const r = await runGhTail(bin, project.dir, ['run', 'view', ...target, `--repo=${job.repo}`, '--log-failed'],
    { timeout: LOG_TIMEOUT, keepBytes: LOG_KEEP_BYTES });
  const fetchedAt = Date.now();
  if (!r.ok) {
    return r.killed
      ? { kind: 'failed', code: null, detail: `gh did not finish within ${LOG_TIMEOUT / 1000} seconds, so it was stopped.` }
      : { kind: 'failed', code: r.code, detail: firstLineOf(r.err, redact) || `gh exited ${r.code ?? 'abnormally'} without saying why.` };
  }
  const log = failedLogExcerpt(r.tail, r.droppedLines, redact);
  return log.lines.length ? { kind: 'ok', log, fetchedAt } : { kind: 'empty', fetchedAt };
}

/** Test seam: forget every project's last read, as a restart would. */
export function resetReadinessForTest(): void {
  lastJobs.clear();
}
