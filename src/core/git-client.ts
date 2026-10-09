// The git workbench's operations on one checkout: the project folder or a
// card's worktree, its root already checked. Every call goes through runGit
// (git.ts) with an argument array; every ref from the window is checked before
// it becomes an argument, and paths and refs sit after `--` (or are literal
// pathspecs), so neither can be read as an option. Nothing here forces
// anything: a push is never --force, a pull only fast-forwards, a branch that
// holds unmerged work is deleted only when the owner said "delete anyway".
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { diffHash } from '../shared/diff.ts';
import { gitSaid, parseStatus, refProblem, splitMessage, type DiffArea, type GitOperation, type LastCommit, type ParsedStatus, type PullResult, type PushPlan, type StashEntry, type StashFile } from '../shared/git.ts';
import type { ChangedFile } from '../shared/model.ts';
import { buildPatch, newFileDiff, partProblem, plainPath, splitPatch, type LinePick } from '../shared/patch.ts';
import { CoreError } from '../shared/protocol.ts';
import { changedFiles, countUntracked, readUntracked, runGit } from './git.ts';
import { DIFF_CONFIG, MAX_TOTAL_DIFF, PLAIN, SAFE, SEP, commitsIn, count, failed, filePath, hasHook, literal, must, ref, refused, remotesContaining, resolves } from './git-commands.ts';
import { merge } from './git-branches.ts';

export { ref, filePath, hasHook } from './git-commands.ts';
export { log, cardCommits, cardMerges, showCommit } from './git-history.ts';
export { branches, switchBranch, createBranch, deleteBranch, mergePreview, merge, abort, continueOperation } from './git-branches.ts';
export { conflictFile, conflictHunks, resolveConflict, type Resolution } from './git-conflicts.ts';

const MAX_DIFF = 400_000;
/** Untracked files listed; past this the rest are counted, not listed. */
const MAX_LISTED = 2_000;
const MAX_COUNTED = 300;

/** Counts per path from `--numstat -z`, renames under their new name. */
function numstatCounts(out: string): Map<string, { add: number | null; del: number | null; binary: boolean }> {
  const counts = new Map<string, { add: number | null; del: number | null; binary: boolean }>();
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const [add = '', del = '', path = ''] = entry.split('\t');
    const target = path || (i += 2, parts[i] ?? '');
    const binary = add === '-' && del === '-';
    counts.set(target, { add: binary ? null : Number(add), del: binary ? null : Number(del), binary });
  }
  return counts;
}

/* ── status ──────────────────────────────────────────────────────────────── */

export interface StatusRead extends ParsedStatus {
  operation: GitOperation | null;
  operationOf: string | null;
  operationMessage: string | null;
  remotes: string[];
  counts: { staged: ReturnType<typeof numstatCounts>; changed: ReturnType<typeof numstatCounts>; untracked: Map<string, { add: number | null; del: number | null; binary: boolean } | null> };
  omitted: number;
}

/** The checkout's git state: branch, upstream, what is staged, changed, untracked and conflicted, and any operation in progress. */
export async function readStatus(cwd: string): Promise<StatusRead> {
  const [st, staged, changed, op, remotes] = await Promise.all([
    runGit(cwd, [...SAFE, 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--show-stash'], { timeout: 30_000 }),
    runGit(cwd, [...DIFF_CONFIG, 'diff', '--cached', '--numstat', '-z', '-M', ...PLAIN]),
    runGit(cwd, [...DIFF_CONFIG, 'diff', '--numstat', '-z', ...PLAIN]),
    operation(cwd),
    runGit(cwd, ['remote']),
  ]);
  if (!st.ok) refused(failed(st, 'reading the status').message);
  const parsed = parseStatus(st.out);
  const listed = parsed.untracked.slice(0, MAX_LISTED);
  const counted = new Map<string, { add: number | null; del: number | null; binary: boolean } | null>();
  for (let i = 0; i < Math.min(listed.length, MAX_COUNTED); i += 16) {
    const batch = listed.slice(i, Math.min(i + 16, MAX_COUNTED));
    const done = await Promise.all(batch.map((p) => countUntracked(join(cwd, p))));
    batch.forEach((p, k) => counted.set(p, done[k] ?? null));
  }
  return {
    ...parsed,
    untracked: listed,
    omitted: parsed.untracked.length - listed.length,
    ...op,
    remotes: remotes.ok ? remotes.out.split('\n').map((r) => r.trim()).filter(Boolean) : [],
    counts: { staged: staged.ok ? numstatCounts(staged.out) : new Map(), changed: changed.ok ? numstatCounts(changed.out) : new Map(), untracked: counted },
  };
}

/** A merge, rebase, cherry-pick or revert git started and has not finished, and what it brings in. */
async function operation(cwd: string): Promise<{ operation: GitOperation | null; operationOf: string | null; operationMessage: string | null }> {
  const r = await runGit(cwd, ['rev-parse', '--absolute-git-dir'], { timeout: 8_000 });
  const none = { operation: null, operationOf: null, operationMessage: null };
  if (!r.ok) return none;
  const dir = r.out.trim();
  const read = (name: string): string | null => { try { return readFileSync(join(dir, name), 'utf8'); } catch { return null; } };
  const message = read('MERGE_MSG');
  const short = (sha: string | null): string | null => (sha ? sha.trim().slice(0, 7) : null);
  if (existsSync(join(dir, 'MERGE_HEAD'))) {
    const first = message?.split('\n')[0] ?? '';
    const named = first.match(/^Merge (?:(?:remote-tracking )?branch(?:es)? )?'?([^'\s]+)'?/)?.[1] ?? null;
    return { operation: 'merge', operationOf: named ?? short(read('MERGE_HEAD')), operationMessage: message };
  }
  for (const d of ['rebase-merge', 'rebase-apply']) {
    if (existsSync(join(dir, d))) {
      const onto = read(join(d, 'head-name'))?.trim().replace(/^refs\/heads\//, '') ?? null;
      return { operation: 'rebase', operationOf: onto, operationMessage: null };
    }
  }
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return { operation: 'cherry-pick', operationOf: short(read('CHERRY_PICK_HEAD')), operationMessage: message };
  if (existsSync(join(dir, 'REVERT_HEAD'))) return { operation: 'revert', operationOf: short(read('REVERT_HEAD')), operationMessage: message };
  return none;
}

/* ── diffs ───────────────────────────────────────────────────────────────── */

/** One file's diff in one area: what is staged, what is not, a new file, a conflict, or a card's commits since `base`. */
export async function areaDiff(cwd: string, file: string, area: DiffArea, options: { from?: string | null; base?: string | null } = {}): Promise<{ path: string; diff: string; truncated: boolean }> {
  filePath(cwd, file);
  const paths = [literal(file), ...(options.from ? [literal(filePath(cwd, options.from))] : [])];
  let text: string;
  if (area === 'untracked') {
    const listed = await must(cwd, [...SAFE, 'ls-files', '--others', '--exclude-standard', '-z', '--', literal(file)], 'the untracked file');
    if (!listed.split('\0').includes(file)) {
      // A staging event can refresh this diff before status moves the file to its new area.
      // Like an empty staged/changed diff, a now-indexed file has nothing untracked to show.
      const indexed = await must(cwd, [...SAFE, 'ls-files', '--cached', '-z', '--', literal(file)], 'the indexed file');
      if (indexed.split('\0').includes(file)) return { path: file, diff: '', truncated: false };
      throw new CoreError('not_found', 'That is not an untracked file in this project.');
    }
    // O_NOFOLLOW in readUntracked protects the final file, not its parents.
    const [parent, root] = await Promise.all([realpath(dirname(join(cwd, file))), realpath(cwd)]);
    if (parent !== root && !parent.startsWith(`${root}/`)) throw new CoreError('forbidden', 'That path is outside the project.');
    text = await untrackedFileDiff(cwd, file);
  } else if (area === 'staged') text = await must(cwd, [...DIFF_CONFIG, 'diff', '--cached', '-M', ...PLAIN, '--', ...paths], 'the diff');
  else if (area === 'changed') text = await must(cwd, [...DIFF_CONFIG, 'diff', ...PLAIN, '--', ...paths], 'the diff');
  else if (area === 'conflicted') {
    // Ours against the file as it is: the markers git wrote, and their side between them.
    const ours = await runGit(cwd, [...DIFF_CONFIG, 'diff', '--ours', ...PLAIN, '--', ...paths]);
    const at = ours.out.indexOf('diff --git ');
    text = ours.ok && at >= 0 ? ours.out.slice(at) : await untrackedFileDiff(cwd, file);
  } else {
    if (!options.base) throw new CoreError('invalid', 'A card’s committed changes need the point its branch forked from.');
    text = await must(cwd, [...DIFF_CONFIG, 'diff', '-M', ...PLAIN, ref(options.base), 'HEAD', '--', ...paths], 'the diff');
  }
  const truncated = text.length > MAX_DIFF;
  return { path: file, diff: truncated ? text.slice(0, MAX_DIFF) : text, truncated };
}

async function untrackedFileDiff(cwd: string, file: string): Promise<string> {
  const full = join(cwd, file);
  const read = await readUntracked(full).catch(() => refused('Wanigan could not read this file’s diff. Check the file and try again.'));
  if ('note' in read) {
    if (read.binary) return `diff --git a/${file} b/${file}\nnew file mode 100644\nBinary files /dev/null and b/${file} differ\n`;
    return refused(`Wanigan cannot show this file’s diff: ${read.note}`);
  }
  let executable = false;
  try { accessSync(full, constants.X_OK); executable = true; } catch { /* a plain file */ }
  return newFileDiff(file, read.text, executable);
}

/** What the commits since `fork` changed, file by file: a card's own work on its branch. */
export async function committedSince(cwd: string, fork: string): Promise<(ChangedFile & { from?: string })[]> {
  const [names, numstat] = await Promise.all([
    runGit(cwd, [...DIFF_CONFIG, 'diff', '--name-status', '-z', '-M', ...PLAIN, fork, 'HEAD', '--']),
    runGit(cwd, [...DIFF_CONFIG, 'diff', '--numstat', '-z', '-M', ...PLAIN, fork, 'HEAD', '--']),
  ]);
  return names.ok && numstat.ok ? changedFiles(names.out, numstat.out) : [];
}

/* ── staging ─────────────────────────────────────────────────────────────── */

export async function stage(cwd: string, files: string[]): Promise<void> {
  if (!files.length) return;
  await must(cwd, ['add', '-A', '--', ...files.map((f) => literal(filePath(cwd, f)))], 'staging');
}

export async function unstage(cwd: string, files: string[]): Promise<void> {
  if (!files.length) return;
  const specs = files.map((f) => literal(filePath(cwd, f)));
  // Before the first commit there is no HEAD to restore from: the files leave the index instead.
  const unborn = !(await resolves(cwd, 'HEAD'));
  await must(cwd, unborn ? ['rm', '--cached', '-r', '-q', '--', ...specs] : ['restore', '--staged', '--', ...specs], 'unstaging');
}

/**
 * Put tracked files back as the index has them, and delete untracked ones.
 * They are separate lists, because they are separate acts: a deleted untracked
 * file was never saved anywhere, and is gone.
 */
export async function discard(cwd: string, tracked: string[], untracked: string[]): Promise<void> {
  if (tracked.length) await must(cwd, ['restore', '--worktree', '--', ...tracked.map((f) => literal(filePath(cwd, f)))], 'discarding');
  if (untracked.length) {
    // Only what git itself lists as untracked is deleted; anything else in the list is left alone.
    const listed = new Set((await must(cwd, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...untracked.map((f) => literal(filePath(cwd, f)))], 'listing untracked files')).split('\0').filter(Boolean));
    const gone = untracked.filter((f) => listed.has(f));
    if (gone.length) await must(cwd, ['clean', '-f', '-q', '--', ...gone.map(literal)], 'deleting untracked files');
  }
}

export type PartAction = 'stage' | 'unstage' | 'discard';

/**
 * Stage, unstage or discard part of a file: one hunk, or picked lines. The
 * diff is read again here and must be the one the owner was shown (its digest),
 * or nothing is done; the patch is built from it and applied with git apply,
 * which changes all of it or none.
 */
export async function applyPart(cwd: string, input: { file: string; area: DiffArea; action: PartAction; pick: LinePick; digest: string }): Promise<{ lines: number }> {
  const { file, area, action } = input;
  const allowed = (area === 'changed' && (action === 'stage' || action === 'discard')) || (area === 'staged' && action === 'unstage') || (area === 'untracked' && action === 'stage');
  if (!allowed) throw new CoreError('invalid', `Part of a file can be ${area === 'staged' ? 'unstaged' : area === 'untracked' ? 'staged' : 'staged or discarded'} here, not ${action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : 'discarded'}.`);
  if (!plainPath(filePath(cwd, file))) refused('Wanigan cannot name that file in a patch (its name has a quote, a backslash or a control character); stage it whole.');
  const { diff, truncated } = await areaDiff(cwd, file, area);
  if (truncated) refused('This file’s diff is too long to stage in parts; stage it whole.');
  if (diffHash(diff) !== input.digest) throw new CoreError('conflict', `${file} changed since its diff was shown, so nothing was ${action === 'stage' ? 'staged' : action === 'unstage' ? 'unstaged' : 'discarded'}. Look at it again.`);
  const problem = partProblem(diff);
  if (problem) refused(problem);
  const patch = buildPatch(diff, input.pick, action === 'stage' ? 'forward' : 'reverse');
  if (!patch) throw new CoreError('invalid', 'Pick at least one added or removed line.');
  const args = action === 'stage' ? ['apply', '--cached'] : action === 'unstage' ? ['apply', '--cached', '--reverse'] : ['apply', '--reverse'];
  const r = await runGit(cwd, [...args, '--whitespace=nowarn', '-'], { input: patch });
  if (!r.ok) refused(`Git could not apply that part cleanly, so nothing changed. ${gitSaid(r.err)}`);
  return { lines: patch.split('\n').filter((l) => /^[+-](?![+-]{2} )/.test(l)).length };
}

/* ── commit ──────────────────────────────────────────────────────────────── */

export async function lastCommit(cwd: string): Promise<LastCommit | null> {
  const head = await resolves(cwd, 'HEAD');
  if (!head) return null;
  const out = await must(cwd, ['log', '-1', `--format=%H${SEP}%h${SEP}%P${SEP}%B`, head, '--'], 'the last commit');
  const [hash = '', short = '', parents = '', message = ''] = out.split(SEP);
  const { subject, body } = splitMessage(message);
  const pushedTo = await remotesContaining(cwd, hash);
  return {
    hash, short, subject, body, merge: parents.trim().split(' ').length > 1,
    pushedTo,
  };
}

/** Make the commit. An empty message is allowed only to amend, which keeps the last one. */
export async function commit(cwd: string, message: string, amend: boolean): Promise<{ hash: string; short: string; subject: string }> {
  const hooks = await hasHook(cwd, ['pre-commit', 'prepare-commit-msg', 'commit-msg']);
  const args = amend && !message.trim() ? ['commit', '--amend', '--no-edit'] : ['commit', '-F', '-', ...(amend ? ['--amend'] : [])];
  const r = await runGit(cwd, args, { input: message, timeout: 120_000 });
  if (!r.ok) refused(failed(r, amend ? 'the amended commit' : 'the commit', hooks).message);
  const out = await must(cwd, ['log', '-1', `--format=%H${SEP}%h${SEP}%s`, 'HEAD', '--'], 'the new commit');
  const [hash = '', short = '', subject = ''] = out.trim().split(SEP);
  return { hash, short, subject };
}

/** The staged diff, bounded, for writing a message from. */
export async function stagedDiff(cwd: string, limit: number): Promise<{ diff: string; cut: boolean; files: number }> {
  const r = await runGit(cwd, [...DIFF_CONFIG, 'diff', '--cached', '-M', '--stat=120', '-p', ...PLAIN], { maxBuffer: limit * 4 });
  // Only a deliberately bounded stdout prefix can be sent to a model after a
  // failed read. Stderr overflow, termination and partial failures are refusals.
  if (!r.ok && !r.stdoutTruncated) refused(failed(r, 'the staged changes').message);
  const text = r.out;
  const names = await runGit(cwd, ['diff', '--cached', '--name-only', '-z']);
  if (!names.ok) refused(failed(names, 'the staged file list').message);
  return { diff: text.slice(0, limit), cut: text.length > limit || r.stdoutTruncated, files: names.out.split('\0').filter(Boolean).length };
}

/** Recent subjects, for writing a message in the repository's own style. */
export async function recentSubjects(cwd: string, n: number): Promise<string[]> {
  const r = await runGit(cwd, ['log', `--max-count=${n}`, '--no-merges', '--format=%s', 'HEAD', '--']);
  return r.ok ? r.out.split('\n').filter(Boolean) : [];
}

/* ── stash ───────────────────────────────────────────────────────────────── */

export async function stashes(cwd: string): Promise<StashEntry[]> {
  const r = await runGit(cwd, ['stash', 'list', `--format=%gd${SEP}%H${SEP}%ct${SEP}%gs`]);
  if (!r.ok) refused(failed(r, 'the stash list').message);
  return r.out.split('\n').filter(Boolean).map((l, i) => {
    const [, sha = '', at = '0', subject = ''] = l.split(SEP);
    const m = subject.match(/^(?:WIP on|On) ([^:]+): (.*)$/s);
    return { index: i, sha, at: Number(at) * 1000, branch: m?.[1] ?? null, message: m?.[2] ?? subject };
  });
}

/** A stash the owner picked, by its place in the list and its commit: the list is shared, and may have moved. */
async function stashRef(cwd: string, index: unknown, sha: unknown): Promise<string> {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || typeof sha !== 'string') throw new CoreError('invalid', 'Which stash?');
  const at = `stash@{${index}}`;
  const now = await runGit(cwd, ['rev-parse', '--verify', '--quiet', at]);
  if (!now.ok || now.out.trim() !== sha) throw new CoreError('conflict', 'The stash list changed since it was shown (another stash was saved or taken). Look again.');
  return at;
}

export async function stashFiles(cwd: string, index: unknown, sha: unknown): Promise<{ files: StashFile[]; cut: boolean }> {
  const at = await stashRef(cwd, index, sha);
  const r = await runGit(cwd, [...DIFF_CONFIG, 'stash', 'show', '-p', '--include-untracked', '-M', ...PLAIN, at], { maxBuffer: MAX_TOTAL_DIFF * 2 });
  if (!r.ok && !r.truncated) refused(failed(r, 'reading the stash').message);
  const text = r.out.length > MAX_TOTAL_DIFF ? r.out.slice(0, r.out.lastIndexOf('\ndiff --git ', MAX_TOTAL_DIFF) + 1) : r.out;
  return { files: splitPatch(text), cut: text.length < r.out.length || r.truncated };
}

export async function stashSave(cwd: string, message: string, untracked: boolean): Promise<void> {
  const r = await runGit(cwd, ['stash', 'push', ...(untracked ? ['--include-untracked'] : []), ...(message.trim() ? ['-m', message.trim()] : []), '--'], { timeout: 60_000 });
  if (!r.ok) refused(failed(r, 'saving the stash').message);
  if (/No local changes to save/i.test(r.out + r.err)) refused(untracked ? 'There are no changes to put aside.' : 'There are no changes to tracked files to put aside. Include untracked files to stash new ones.');
}

export async function stashApply(cwd: string, index: unknown, sha: unknown, pop: boolean): Promise<{ conflicts: string[]; kept: boolean }> {
  const at = await stashRef(cwd, index, sha);
  const r = await runGit(cwd, ['stash', pop ? 'pop' : 'apply', at], { timeout: 60_000 });
  const conflicts = parseStatus((await runGit(cwd, ['status', '--porcelain=v2', '-z'])).out).conflicted.map((c) => c.path);
  if (r.ok) return { conflicts: [], kept: !pop };
  if (conflicts.length) return { conflicts, kept: true };
  return refused(failed(r, pop ? 'popping the stash' : 'applying the stash').message);
}

export async function stashDrop(cwd: string, index: unknown, sha: unknown): Promise<void> {
  const at = await stashRef(cwd, index, sha);
  await must(cwd, ['stash', 'drop', at], 'dropping the stash');
}

/* ── remotes ─────────────────────────────────────────────────────────────── */

export async function fetch(cwd: string): Promise<{ remotes: string[] }> {
  const remotes = (await must(cwd, ['remote'], 'listing remotes')).split('\n').map((r) => r.trim()).filter(Boolean);
  if (!remotes.length) refused('This repository has no remote to fetch from.');
  const r = await runGit(cwd, ['fetch', '--all', '--prune', '--no-write-fetch-head'], { timeout: 180_000 });
  if (!r.ok) refused(failed(r, 'the fetch').message);
  return { remotes };
}

/** Where the checked-out branch's upstream lives: its remote, and the branch there. */
async function upstreamOf(cwd: string, branch: string): Promise<{ remote: string; branch: string; ref: string } | null> {
  const [remote, mergeRef] = await Promise.all([
    runGit(cwd, ['config', '--get', `branch.${branch}.remote`]),
    runGit(cwd, ['config', '--get', `branch.${branch}.merge`]),
  ]);
  const r = remote.out.trim();
  const m = mergeRef.out.trim().replace(/^refs\/heads\//, '');
  if (!remote.ok || !mergeRef.ok || !r || !m || r === '.') return null;
  return { remote: r, branch: m, ref: `refs/remotes/${r}/${m}` };
}

/**
 * Pull, fast-forward only: fetch the upstream's remote, then move the branch
 * up to it if nothing here is missing there. When it cannot, it says exactly
 * why, with the counts. With `merge`, which the owner chose after being told
 * the branches diverged, the upstream is merged in instead; a conflict is left
 * for the owner to resolve.
 */
export async function pull(cwd: string, merging = false): Promise<PullResult> {
  const branch = (await must(cwd, ['branch', '--show-current'], 'the branch')).trim();
  if (!branch) refused('HEAD is detached, so there is no branch to pull into. Switch to a branch first.');
  const up = await upstreamOf(cwd, branch);
  if (!up) refused(`${branch} has no upstream, so there is nothing to pull from. Push it with “set upstream” first, or pull in a terminal from a branch you name.`);
  const upstream = up as NonNullable<typeof up>;
  const fetched = await runGit(cwd, ['fetch', '--prune', '--no-write-fetch-head', '--', upstream.remote], { timeout: 180_000 });
  if (!fetched.ok) refused(failed(fetched, 'the pull').message);
  const name = `${upstream.remote}/${upstream.branch}`;
  if (!(await resolves(cwd, upstream.ref))) refused(`${name} is gone from ${upstream.remote}, so there is nothing to pull.`);
  const [behind, ahead] = await Promise.all([count(cwd, [`HEAD..${upstream.ref}`]), count(cwd, [`${upstream.ref}..HEAD`])]);
  if (!behind) return { pulled: 0, from: name, outcome: 'up-to-date', conflicts: [] };
  if (ahead && !merging) {
    refused(`${branch} and ${name} have diverged: ${ahead} commit${ahead === 1 ? '' : 's'} here ${ahead === 1 ? 'is' : 'are'} not on ${name}, and ${behind} there ${behind === 1 ? 'is' : 'are'} not here. A pull here only fast-forwards, so nothing changed. Merge ${name} into ${branch} instead, or rebase in a terminal.`);
  }
  if (ahead) {
    // By its short name, so git's message (and the banner) say "origin/main".
    const merged = await merge(cwd, name);
    return { pulled: behind, from: name, outcome: merged.outcome === 'conflict' ? 'conflict' : 'merged', conflicts: merged.conflicts };
  }
  const r = await runGit(cwd, ['merge', '--ff-only', upstream.ref, '--'], { timeout: 120_000 });
  if (!r.ok) refused(failed(r, 'the pull').message);
  return { pulled: behind, from: name, outcome: 'fast-forward', conflicts: [] };
}

/** Exactly what a push would send, where, read from git; `refusal` is why it cannot be done. */
export async function pushPlan(cwd: string): Promise<PushPlan> {
  const tracking = (): Promise<string> => must(cwd, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/remotes'], 'the push history');
  const before = await tracking();
  const plan = await planPush(cwd);
  if (before !== await tracking()) throw new CoreError('conflict', 'Remote history changed while the push was being planned. Review the plan again.');
  const digest = createHash('sha256').update(JSON.stringify([plan.head, plan.branch, plan.remote, plan.remoteBranch, plan.url, plan.setUpstream, before])).digest('hex');
  return { ...plan, digest };
}

async function planPush(cwd: string): Promise<Omit<PushPlan, 'digest'>> {
  const plan: Omit<PushPlan, 'digest'> = { branch: null, remote: null, remoteBranch: null, url: null, upstream: null, setUpstream: false, commits: [], total: 0, head: null, refusal: null };
  plan.head = await resolves(cwd, 'HEAD');
  plan.branch = (await runGit(cwd, ['branch', '--show-current'])).out.trim() || null;
  if (!plan.head) return { ...plan, refusal: 'There are no commits yet to push.' };
  if (!plan.branch) return { ...plan, refusal: 'HEAD is detached. Switch to a branch to push.' };
  const remotes = (await runGit(cwd, ['remote'])).out.split('\n').map((r) => r.trim()).filter(Boolean);
  if (!remotes.length) return { ...plan, refusal: 'This repository has no remote. Add one (git remote add origin <address>) to push.' };
  const up = await upstreamOf(cwd, plan.branch);
  plan.remote = up?.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0] ?? null);
  plan.remoteBranch = up?.branch ?? plan.branch;
  plan.setUpstream = !up;
  plan.upstream = up ? `${up.remote}/${up.branch}` : null;
  if (!plan.remote || refProblem(plan.remote) || refProblem(plan.remoteBranch)) return { ...plan, refusal: 'Wanigan could not tell where this branch pushes to.' };
  plan.url = (await runGit(cwd, ['remote', 'get-url', '--push', '--all', '--', plan.remote])).out.trim() || null;
  const tracking = `refs/remotes/${plan.remote}/${plan.remoteBranch}`;
  const there = await resolves(cwd, tracking);
  const range = there ? [`${tracking}..HEAD`] : ['HEAD', '--not', `--remotes=${plan.remote}`];
  [plan.total, plan.commits] = await Promise.all([count(cwd, range), commitsIn(cwd, range, 50)]);
  const target = `${plan.remote}/${plan.remoteBranch}`;
  if (there) {
    const behind = await count(cwd, [`HEAD..${tracking}`]);
    if (behind) return { ...plan, refusal: `${target} has ${behind} commit${behind === 1 ? '' : 's'} ${plan.branch} does not. Pull first; Wanigan never force-pushes.` };
  }
  if (!plan.total && there) return { ...plan, refusal: `Nothing to push: ${plan.branch} matches ${target}.` };
  return plan;
}

/** Push what the plan said, to where it said, never forced. Refuses if HEAD moved since the plan was shown. */
export async function push(cwd: string, expectedHead: unknown, expectedPlan: unknown): Promise<{ pushed: number; to: string }> {
  const plan = await pushPlan(cwd);
  if (plan.refusal) refused(plan.refusal);
  if (typeof expectedHead !== 'string' || expectedHead !== plan.head) throw new CoreError('conflict', 'The branch moved since the push was shown (a new commit, or a switch), so nothing was pushed. Look again.');
  if (typeof expectedPlan !== 'string' || expectedPlan !== plan.digest) throw new CoreError('conflict', 'The push plan or destination changed after it was shown, so nothing was pushed. Review the destination again.');
  const hooks = await hasHook(cwd, ['pre-push']);
  const refspec = `refs/heads/${plan.branch}:refs/heads/${plan.remoteBranch}`;
  // The plan approves one branch, never implicit tags or pushes in submodules.
  const r = await runGit(cwd, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', ...(plan.setUpstream ? ['--set-upstream'] : []), '--', plan.remote as string, refspec], { timeout: 180_000 });
  if (!r.ok) refused(failed(r, 'the push', hooks).message);
  return { pushed: plan.total, to: `${plan.remote}/${plan.remoteBranch}` };
}
