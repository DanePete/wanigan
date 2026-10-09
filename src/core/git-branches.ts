// Branch discovery and mutations, including merge and operation recovery.
import { branchNameProblem, cardKeyOfBranch, parseStatus, type Branches, type BranchInfo, type GitOperation, type MergePreview, type MergeResult } from '../shared/git.ts';
import { CoreError } from '../shared/protocol.ts';
import { runGit } from './git.ts';
import { SEP, commitsIn, count, failed, hasHook, must, ref, refused, resolves, same } from './git-commands.ts';

/* ── branches ────────────────────────────────────────────────────────────── */

export async function branches(cwd: string, here: string): Promise<Branches> {
  const fmt = ['%(refname)', '%(HEAD)', '%(upstream:short)', '%(upstream:track)', '%(committerdate:unix)', '%(contents:subject)', '%(authorname)', '%(objectname)', '%(worktreepath)'].join(SEP);
  const [refs, mergedLocal, mergedRemote, current] = await Promise.all([
    must(cwd, ['for-each-ref', `--format=${fmt}`, 'refs/heads', 'refs/remotes'], 'the branches'),
    runGit(cwd, ['branch', '--merged', 'HEAD', '--format=%(refname)']),
    runGit(cwd, ['branch', '-r', '--merged', 'HEAD', '--format=%(refname)']),
    runGit(cwd, ['branch', '--show-current']),
  ]);
  const merged = new Set([mergedLocal, mergedRemote].flatMap((r) => (r.ok ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : [])));
  const out: Branches = { current: current.ok ? current.out.trim() || null : null, local: [], remote: [] };
  for (const line of refs.split('\n')) {
    if (!line.trim()) continue;
    const [full = '', head = '', up = '', track = '', date = '', subject = '', author = '', sha = '', worktree = ''] = line.split(SEP);
    if (full.endsWith('/HEAD')) continue;
    const isRemote = full.startsWith('refs/remotes/');
    const name = isRemote ? full.slice('refs/remotes/'.length) : full.slice('refs/heads/'.length);
    const info: BranchInfo = {
      name, remote: isRemote ? name.split('/')[0] ?? null : null, current: head.trim() === '*',
      upstream: up || null, upstreamGone: /gone/.test(track),
      ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
      merged: merged.has(full), at: date ? Number(date) * 1000 : null, subject: subject || null, author: author || null, head: sha,
      worktree: worktree && !same(worktree, here) ? worktree : null, cardKey: cardKeyOfBranch(name),
    };
    (isRemote ? out.remote : out.local).push(info);
  }
  out.local.sort((a, b) => Number(b.current) - Number(a.current) || (b.at ?? 0) - (a.at ?? 0));
  out.remote.sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
  return out;
}

const localExists = (cwd: string, name: string): Promise<boolean> => resolves(cwd, `refs/heads/${name}`).then(Boolean);

/** Switch to a local branch, or make a local branch tracking a remote one and switch to it. */
export async function switchBranch(cwd: string, name: string, remote: boolean): Promise<{ branch: string }> {
  ref(name);
  if (remote) {
    if (!(await resolves(cwd, `refs/remotes/${name}`))) refused(`There is no remote branch ${name}. Fetch, then look again.`);
    const local = name.split('/').slice(1).join('/');
    if (!local) refused(`${name} is not a branch on a remote.`);
    if (await localExists(cwd, local)) {
      const up = await runGit(cwd, ['rev-parse', '--abbrev-ref', `${local}@{upstream}`]);
      if (!up.ok || up.out.trim() !== name) refused(`A local branch named ${local} already exists and does not follow ${name}. Switch to it instead.`);
      return switchBranch(cwd, local, false);
    }
    const r = await runGit(cwd, ['switch', '-c', local, '--track', '--', name], { timeout: 60_000 });
    if (!r.ok) refused(failed(r, `switching to ${local}`).message);
    return { branch: local };
  }
  if (!(await localExists(cwd, name))) refused(`There is no local branch ${name}.`);
  const r = await runGit(cwd, ['switch', '--', name], { timeout: 60_000 });
  if (!r.ok) {
    if (/already (?:checked out|used by worktree) at '([^']+)'/.test(r.err)) {
      refused(`${name} is checked out in another worktree (${r.err.match(/at '([^']+)'/)?.[1]}). A branch can be checked out in one place at a time.`);
    }
    refused(failed(r, `switching to ${name}`).message);
  }
  return { branch: name };
}

export async function createBranch(cwd: string, name: string, from: string | null, checkout: boolean): Promise<{ branch: string }> {
  const problem = branchNameProblem(name);
  if (problem) throw new CoreError('invalid', problem);
  const valid = await runGit(cwd, ['check-ref-format', '--branch', name]);
  if (!valid.ok) throw new CoreError('invalid', `Git will not take ${name} as a branch name.`);
  if (await localExists(cwd, name)) refused(`A branch named ${name} already exists.`);
  const start = from ? ref(from) : 'HEAD';
  if (!(await resolves(cwd, start))) refused(from ? `There is no branch or commit ${from} to start from.` : 'There is no commit yet to start a branch from.');
  if (checkout) {
    const r = await runGit(cwd, ['switch', '-c', name, '--', start], { timeout: 60_000 });
    if (!r.ok) refused(failed(r, `making ${name}`).message);
  } else await must(cwd, ['branch', '--', name, start], `making ${name}`);
  return { branch: name };
}

/** Delete a local branch. Without `force`, git refuses one whose commits are not merged anywhere it knows of. */
export async function deleteBranch(cwd: string, name: string, force: boolean): Promise<{ lost: number }> {
  ref(name);
  const head = await resolves(cwd, `refs/heads/${name}`);
  if (!head) refused(`There is no local branch ${name}.`);
  const lost = force ? await count(cwd, [`refs/heads/${name}`, '--not', `--exclude=${name}`, '--branches', '--remotes', '--tags']) : 0;
  const r = await runGit(cwd, ['branch', force ? '-D' : '-d', '--', name]);
  if (!r.ok) {
    if (/not fully merged/i.test(r.err)) refused(`${name} has commits that are not merged into the branch checked out here, so it was kept. Delete it anyway only if you are sure you do not need them.`);
    const at = r.err.match(/(?:checked out|used by worktree) at '([^']+)'/)?.[1];
    if (at && same(at, cwd)) refused(`${name} is the branch checked out here. Switch to another branch first.`);
    if (at) refused(`${name} is checked out in another worktree (${at}), so it was kept. Remove that worktree first.`);
    refused(failed(r, `deleting ${name}`).message);
  }
  return { lost };
}

export async function mergePreview(cwd: string, name: string): Promise<MergePreview> {
  ref(name);
  if (!(await resolves(cwd, name))) refused(`There is no branch ${name}.`);
  const [incoming, outgoing, commits, current] = await Promise.all([
    count(cwd, [`HEAD..${name}`]), count(cwd, [`${name}..HEAD`]), commitsIn(cwd, [`HEAD..${name}`], 20),
    runGit(cwd, ['branch', '--show-current']),
  ]);
  return { branch: name, into: current.out.trim() || null, incoming, outgoing, commits };
}

/**
 * Merge a branch into the one checked out. A conflict is left in progress for
 * the owner to resolve or abort, and is an outcome, not an error. Any other
 * failure leaves nothing half-done and says what it was.
 */
export async function merge(cwd: string, name: string): Promise<MergeResult> {
  ref(name);
  if (!(await resolves(cwd, name))) refused(`There is no branch ${name}.`);
  const hooks = await hasHook(cwd, ['pre-merge-commit', 'prepare-commit-msg', 'commit-msg']);
  const r = await runGit(cwd, ['merge', '--no-edit', name, '--'], { timeout: 120_000 });
  const conflicts = parseStatus((await runGit(cwd, ['status', '--porcelain=v2', '-z'])).out).conflicted.map((c) => c.path);
  if (r.ok) {
    const outcome = /Already up to date/i.test(r.out) ? 'up-to-date' : /Fast-forward/i.test(r.out) ? 'fast-forward' : 'merged';
    return { outcome, commit: (await resolves(cwd, 'HEAD'))?.slice(0, 7) ?? null, conflicts: [] };
  }
  if (conflicts.length) return { outcome: 'conflict', commit: null, conflicts };
  const failure = failed(r, 'the merge', hooks);
  if (await resolves(cwd, 'MERGE_HEAD')) await runGit(cwd, ['merge', '--abort']);
  return refused(`${failure.message}${failure.kind === 'hook' ? ' The merge was undone.' : ''}`);
}

/** Abandon the operation in progress, back to where it started. */
export async function abort(cwd: string, op: GitOperation): Promise<void> {
  const args: Record<GitOperation, string[]> = {
    merge: ['merge', '--abort'], rebase: ['rebase', '--abort'], 'cherry-pick': ['cherry-pick', '--abort'], revert: ['revert', '--abort'],
  };
  await must(cwd, args[op], `abandoning the ${op}`, { timeout: 60_000 });
}

/** Carry on with a rebase, cherry-pick or revert once its conflicts are resolved, with git's prepared message. */
export async function continueOperation(cwd: string, op: Exclude<GitOperation, 'merge'>): Promise<void> {
  const hooks = await hasHook(cwd, ['pre-commit', 'commit-msg', 'prepare-commit-msg']);
  const r = await runGit(cwd, [op, '--continue'], { timeout: 120_000 });
  if (!r.ok && !parseStatus((await runGit(cwd, ['status', '--porcelain=v2', '-z'])).out).conflicted.length) refused(failed(r, `continuing the ${op}`, hooks).message);
}
