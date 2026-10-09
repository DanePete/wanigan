// Shipping an approved card: push its branch to origin and open a pull request
// with the owner's own `gh`. No model is asked anything; the title and body are
// the card's own words. Known preconditions are checked before pushing; a
// later GitHub failure may leave the branch pushed. Nothing is forced.
import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { relative } from 'node:path';
import type { CardDetail, PullRequestPlan } from '../shared/model.ts';
import { notInstalledMessage } from '../shared/clis.ts';
import { reviewOf, summarizeChecks, type BranchPullRequest } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { loginPath, which } from './environment.ts';
import { gitEnvironment } from './git.ts';
import { requireAcknowledged } from './git-secrets.ts';
import type { Worktree } from './worktrees.ts';

const MAX_BODY = 60_000;
const MAX_TITLE = 240;

interface Ran { ok: boolean; stdout: string; stderr: string }

/** The title a card's pull request gets: its key and title. */
export const pullRequestTitle = (card: Pick<CardDetail, 'key' | 'title'>): string => `${card.key} ${card.title}`.slice(0, MAX_TITLE);

/** The card's description, its criteria and its evidence, as the pull request's body. */
export function pullRequestBody(card: CardDetail, projectPath: string): string {
  const parts = [card.body.trim()];
  if (card.criteria.length) parts.push(['## Acceptance criteria', ...card.criteria.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`)].join('\n'));
  if (card.evidence.length) {
    const shown = (e: CardDetail['evidence'][number]): string => {
      if (e.kind === 'file') return `- File: \`${e.value.startsWith(`${projectPath}/`) ? relative(projectPath, e.value) : e.value}\``;
      if (e.kind === 'link') return `- Link: ${e.value}`;
      return `- Note: ${e.value.replace(/\s*\n\s*/g, ' ')}`;
    };
    parts.push(['## Evidence', ...card.evidence.map(shown)].join('\n'));
  }
  const body = parts.filter(Boolean).join('\n\n');
  return body.length > MAX_BODY ? `${body.slice(0, MAX_BODY - 1)}…` : body;
}

/** Where `gh` is: the given one (a test seam), else the login shell's. Null when it is not installed. */
export async function findGh(given: string | null | undefined): Promise<string | null> {
  if (given !== undefined) return given && executable(given) ? given : null;
  return which('gh', await loginPath());
}

/**
 * What opening a pull request would do, read from git alone: the branch, how
 * many commits it has that its base lacks, and where origin is. `refusal` is
 * the first reason it cannot be done, checked again when it is.
 */
export async function planPullRequest(repo: string, worktree: Worktree, title: string, gh: string | null): Promise<PullRequestPlan> {
  const env = await toolEnv();
  const remote = await run('git', ['remote', 'get-url', '--push', '--all', 'origin'], repo, env);
  const ahead = await run('git', ['rev-list', '--count', `${worktree.base}..${worktree.branch}`], repo, env);
  const dirty = await run('git', ['status', '--porcelain'], worktree.path, env);
  const plan: PullRequestPlan = {
    branch: worktree.branch, base: worktree.base, title,
    remote: remote.ok ? remote.stdout.trim() || null : null,
    ahead: ahead.ok ? Number(ahead.stdout.trim()) || 0 : 0,
    refusal: null,
  };
  plan.refusal = !plan.remote ? 'This project has no origin remote, so there is nowhere to push.'
    : !ahead.ok ? `Git could not compare ${worktree.branch} with ${worktree.base}: ${firstLine(ahead.stderr)}`
      : plan.ahead === 0 ? `${worktree.branch} has nothing that is not already in ${worktree.base}.`
        : dirty.ok && dirty.stdout.trim() ? 'The card’s worktree has uncommitted changes. Commit them first: only commits are pushed.'
          : !gh ? `${notInstalledMessage('gh')} Then sign in with \`gh auth login\`.`
            : null;
  return plan;
}

/** Push the card's branch to origin, then open its pull request. Returns the pull request's address. */
export async function openPullRequest(repo: string, worktree: Worktree, card: CardDetail, projectPath: string, gh: string | null): Promise<{ url: string }> {
  const title = pullRequestTitle(card);
  const plan = await planPullRequest(repo, worktree, title, gh);
  if (plan.refusal || !gh) throw new CoreError('refused', plan.refusal ?? notInstalledMessage('gh'));
  const env = { ...(await toolEnv()), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  const auth = await run(gh, ['auth', 'status'], repo, env, 30_000);
  if (!auth.ok) throw new CoreError('refused', 'gh is not signed in to GitHub. Run `gh auth login` in a terminal, then try again.');
  // This path publishes directly, without the workbench's push handler. Check
  // origin and the card's branch, even if its checkout follows another remote.
  await requireAcknowledged(repo, { action: 'push' }, null, { remote: 'origin', branch: worktree.branch, ref: `refs/heads/${worktree.branch}` });
  // The card's branch is the publication; local config cannot add other refs or repositories.
  const push = await run('git', ['push', '--no-follow-tags', '--recurse-submodules=no', '-u', 'origin', worktree.branch], repo, env, 180_000);
  if (!push.ok) throw new CoreError('refused', `git push did not go through, so no pull request was opened: ${firstLine(push.stderr)}`);
  const pr = await run(gh, ['pr', 'create', '--head', worktree.branch, '--base', worktree.base, '--title', title, '--body', pullRequestBody(card, projectPath)], repo, env, 90_000);
  const url = lastUrl(pr.stdout) ?? (/already exists/i.test(pr.stderr) ? lastUrl(pr.stderr) : null);
  if (!url) throw new CoreError('refused', `The branch was pushed, but gh did not open a pull request: ${firstLine(pr.stderr || pr.stdout)}`);
  return { url };
}

/* ── the checked-out branch's pull request (the git workbench) ───────────── */

const ghEnv = async (): Promise<Record<string, string>> => ({
  ...(await toolEnv()), GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GH_PAGER: 'cat', GH_FORCE_TTY: '', CLICOLOR: '0',
});

const nothing = (state: BranchPullRequest['state'], message: string | null): BranchPullRequest => ({
  state, number: null, title: null, url: null, base: null, review: null, checks: null, message, checkedAt: Date.now(),
});

/**
 * The pull request for `branch`, as the owner's own gh reports it: its state,
 * its checks and its review. Asked only when the owner opens the view or asks;
 * nothing is kept.
 */
export async function branchPullRequest(repo: string, branch: string | null, gh: string | null): Promise<BranchPullRequest> {
  if (!branch) return nothing('no-branch', 'HEAD is detached, so there is no branch to have a pull request.');
  if (!gh) return nothing('no-gh', `${notInstalledMessage('gh')} Then sign in with \`gh auth login\` to see pull requests here.`);
  const env = await ghEnv();
  const auth = await run(gh, ['auth', 'status'], repo, env, 30_000);
  if (!auth.ok) return nothing('signed-out', 'gh is not signed in to GitHub. Run `gh auth login` in a terminal.');
  const view = await run(gh, ['pr', 'view', branch, '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,baseRefName'], repo, env, 30_000);
  if (!view.ok) {
    if (/no (?:open )?pull requests? found|could not find any pull requests/i.test(view.stderr)) {
      // Said with the branch a pull request would go into, so the default branch itself is not offered one.
      return { ...nothing('none', `${branch} has no pull request yet.`), base: await defaultBase(repo, 'origin') };
    }
    return nothing('error', `gh could not say: ${firstLine(view.stderr)}`);
  }
  try {
    const pr = JSON.parse(view.stdout) as Record<string, unknown>;
    const state = String(pr.state ?? '').toUpperCase();
    return {
      state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : pr.isDraft ? 'draft' : 'open',
      number: typeof pr.number === 'number' ? pr.number : null,
      title: typeof pr.title === 'string' ? pr.title.slice(0, 300) : null,
      url: typeof pr.url === 'string' && /^https:\/\//.test(pr.url) ? pr.url : null,
      base: typeof pr.baseRefName === 'string' ? pr.baseRefName : null,
      review: reviewOf(pr.reviewDecision), checks: summarizeChecks(pr.statusCheckRollup), message: null, checkedAt: Date.now(),
    };
  } catch {
    return nothing('error', 'gh answered with something Wanigan could not read.');
  }
}

/** The branch a pull request goes into by default: the remote's own HEAD, else main, master or trunk if the remote has one. */
export async function defaultBase(repo: string, remote: string): Promise<string | null> {
  const env = await toolEnv();
  const head = await run('git', ['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`], repo, env);
  if (head.ok && head.stdout.trim()) return head.stdout.trim().replace(`${remote}/`, '');
  for (const name of ['main', 'master', 'trunk']) {
    if ((await run('git', ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${name}`], repo, env)).ok) return name;
  }
  return null;
}

/**
 * Open a pull request for a branch already on its remote, with the owner's gh.
 * The window shows the title and body first; nothing is pushed here.
 */
export async function openBranchPullRequest(repo: string, input: { branch: string; base: string; title: string; body: string }, gh: string | null): Promise<{ url: string }> {
  if (!gh) throw new CoreError('refused', `${notInstalledMessage('gh')} Then sign in with \`gh auth login\`.`);
  const env = await ghEnv();
  const auth = await run(gh, ['auth', 'status'], repo, env, 30_000);
  if (!auth.ok) throw new CoreError('refused', 'gh is not signed in to GitHub. Run `gh auth login` in a terminal, then try again.');
  const title = input.title.trim().slice(0, MAX_TITLE);
  const body = input.body.length > MAX_BODY ? `${input.body.slice(0, MAX_BODY - 1)}…` : input.body;
  const pr = await run(gh, ['pr', 'create', '--head', input.branch, '--base', input.base, '--title', title, '--body', body], repo, env, 90_000);
  const url = lastUrl(pr.stdout) ?? (/already exists/i.test(pr.stderr) ? lastUrl(pr.stderr) : null);
  if (!url) throw new CoreError('refused', `gh did not open a pull request: ${firstLine(pr.stderr || pr.stdout)}`);
  return { url };
}

/** The environment git runs in everywhere in the core (git.ts): the login PATH, and never a prompt nobody can see. */
function toolEnv(): Promise<Record<string, string>> {
  return gitEnvironment();
}

function run(file: string, args: string[], cwd: string, env: Record<string, string>, timeout = 15_000): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, env, timeout, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (error ? error.message : '') });
    });
  });
}

const lastUrl = (text: string): string | null => text.match(/https?:\/\/\S+/g)?.at(-1) ?? null;

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) ?? 'no reason given';
}

function executable(path: string): boolean {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}
