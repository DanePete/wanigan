import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git';
import { assertManagedRoot } from './roots';

/**
 * Undoing one file, against the state the session started from.
 *
 * Claude Code's own /rewind is the right tool for a conversation, but it is
 * explicit about three things it cannot restore: files changed by a bash
 * command, edits made by a background subagent, and anything reached through a
 * symlink. Those are not edge cases — an agent that runs `mv` or delegates to a
 * subagent produces exactly them.
 *
 * Wanigan's baseline is a git commit, and git sees all three. So this is not a
 * second checkpointing system; it is the revert the first one cannot offer.
 */

export type RevertPlan = {
  file: string;
  /** What reverting would do, in words, before it does it. */
  action: 'restore' | 'delete' | 'nothing';
  detail: string;
  /** True when the file was already dirty before the session started. */
  preexisting: boolean;
  safe: boolean;
};

/**
 * Through git.ts, so the credential-prompt hardening is not something this
 * module has to remember: reverting runs `checkout` against a repo that may
 * have a remote, and a git that blocks asking for a password nobody can type
 * takes the main process with it.
 */
async function git(root: string, args: string[], timeout = 15_000) {
  const r = await runGit(root, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.ok, stdout: r.out, error: r.err };
}

/**
 * Contained: the path must resolve inside the repo, symlinks included — and
 * the repo itself must be one Wanigan manages. Revert deletes and checks out
 * files; a renderer-named root would make that a write-anywhere primitive no
 * matter how carefully the relative path is confined inside it.
 */
function inside(root: string, rel: string): string | null {
  try { assertManagedRoot(root, 'That folder'); } catch { return null; }
  const abs = path.resolve(root, rel);
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  const realAbs = (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
  return realAbs === realRoot || realAbs.startsWith(realRoot + path.sep) ? abs : null;
}

/**
 * The baseline must be a real commit before anything is read out of it. A
 * rebased-away or garbage-collected head makes every later question fail, and
 * a failed question must never be mistaken for an answer.
 */
async function baselineResolves(root: string, baselineHead: string): Promise<boolean> {
  const resolved = await git(root, ['rev-parse', '--verify', '--quiet', `${baselineHead}^{commit}`]);
  return resolved.ok && resolved.stdout.trim() !== '';
}

const noBaseline = (file: string, preexisting: boolean, baselineHead: string): RevertPlan => ({
  file, action: 'nothing', preexisting, safe: false,
  detail: `Wanigan cannot resolve the baseline commit ${baselineHead.slice(0, 8)} in this repository, so it cannot tell what ${file} looked like when the session started. Nothing was changed.`,
});

/**
 * What would happen, without doing it. A revert that surprises you once is a
 * revert you never use again.
 *
 * `verified` is for the batch: one baseline check for the whole set instead of
 * one per file, which is the difference between a fast refusal and the same
 * sentence printed five hundred times.
 */
async function planFor(root: string, file: string, baselineHead: string | null,
                       preexisting: boolean, verified: boolean): Promise<RevertPlan> {
  const abs = inside(root, file);
  if (!abs) {
    return { file, action: 'nothing', preexisting, safe: false,
             detail: `${file} does not resolve inside a project Wanigan manages, so it will not be touched.` };
  }
  if (!baselineHead) {
    return { file, action: 'nothing', preexisting, safe: false,
             detail: 'This session has no baseline commit, so there is nothing to revert to. It may not be a git repo.' };
  }
  if (!verified && !(await baselineResolves(root, baselineHead))) {
    return noBaseline(file, preexisting, baselineHead);
  }

  // ls-tree separates the two answers cat-file conflates: it exits cleanly and
  // prints nothing when the path is genuinely absent from the tree, and fails
  // only when git could not answer at all. That distinction is the difference
  // between deleting a file the session created and deleting one it did not.
  const listed = await git(root, ['ls-tree', '--name-only', baselineHead, '--', file]);
  if (!listed.ok) {
    return {
      file, action: 'nothing', preexisting, safe: false,
      detail: `git could not report whether ${file} existed at the baseline (${listed.error}), so Wanigan will not guess. Nothing was changed.`,
    };
  }
  if (listed.stdout.trim()) {
    return {
      file, action: 'restore', preexisting, safe: true,
      detail: preexisting
        ? `Restores ${file} to the commit this session started from — which also discards changes you made before it started.`
        : `Restores ${file} to the commit this session started from, discarding the agent's changes to it.`,
    };
  }
  return {
    file, action: 'delete', preexisting, safe: true,
    detail: preexisting
      ? `${file} was not in the commit this session started from, so reverting deletes it — including if you created it yourself before the session started.`
      : `${file} did not exist when this session started, so reverting deletes it.`,
  };
}

export function planRevert(root: string, file: string, baselineHead: string | null,
                           preexisting: boolean): Promise<RevertPlan> {
  return planFor(root, file, baselineHead, preexisting, false);
}

/** Carries out a plan that has already been made. Nothing is decided here. */
async function apply(root: string, plan: RevertPlan, baselineHead: string): Promise<{ ok: boolean; detail: string }> {
  if (plan.action === 'delete') {
    const abs = inside(root, plan.file);
    if (!abs) return { ok: false, detail: 'Refused: the path left the repository.' };
    // No `recursive`: a directory that reached this point is a plan Wanigan
    // does not understand, and the error is the right outcome.
    try { fs.rmSync(abs, { force: true }); } catch (e) {
      return { ok: false, detail: `Could not delete ${plan.file}: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, detail: `Deleted ${plan.file}, which did not exist at the baseline.` };
  }

  // `--` so a file named like a flag cannot be read as one. `checkout` rather
  // than `restore --worktree` on purpose: it puts the baseline content in the
  // index as well, so a file the agent had staged comes back fully undone
  // instead of reverted on disk and still staged as changed.
  const r = await git(root, ['checkout', baselineHead, '--', plan.file]);
  if (!r.ok) return { ok: false, detail: `git could not restore ${plan.file}: ${r.error}` };
  return { ok: true, detail: `Restored ${plan.file} to ${baselineHead.slice(0, 8)}.` };
}

export async function revertFile(root: string, file: string, baselineHead: string | null,
                                 preexisting = false): Promise<{ ok: boolean; detail: string }> {
  const plan = await planRevert(root, file, baselineHead, preexisting);
  if (plan.action === 'nothing' || !plan.safe) return { ok: false, detail: plan.detail };
  return apply(root, plan, baselineHead!);
}

/**
 * One revert can be a mistake; five hundred is a different act, so the batch
 * is bounded rather than trusted. The list arrives over IPC, which makes every
 * entry in it renderer input: a non-string, an embedded NUL or a repeat of the
 * same path all have to be answered here, not by git.
 */
const MAX_BATCH = 2_000;
const MAX_PATH_CHARS = 4_096;

type BatchEntry = { path: string; preexisting?: boolean };

export async function revertAll(root: string, files: BatchEntry[],
                                baselineHead: string | null): Promise<{ reverted: string[]; failed: { file: string; detail: string }[] }> {
  const reverted: string[] = [];
  const failed: { file: string; detail: string }[] = [];
  const record = (file: string, detail: string) => failed.push({ file, detail });

  if (!Array.isArray(files)) {
    return { reverted, failed: [{ file: '', detail: 'Wanigan was not given a list of files to revert, so nothing was changed.' }] };
  }

  const wanted: BatchEntry[] = [];
  const seen = new Set<string>();
  for (const entry of files) {
    const file = (entry as BatchEntry | null)?.path;
    if (typeof file !== 'string' || !file.trim() || file.length > MAX_PATH_CHARS || file.includes('\0')) {
      record(typeof file === 'string' ? file.slice(0, 120) : '', 'That is not a file path Wanigan will act on, so it was skipped.');
      continue;
    }
    // A path listed twice is one revert, not two: the second pass would plan
    // against a file the first one already restored or deleted.
    if (seen.has(file)) continue;
    seen.add(file);
    if (wanted.length >= MAX_BATCH) {
      record(file, `Wanigan reverts at most ${MAX_BATCH.toLocaleString()} files at a time; this one was not touched. Revert the rest in a second pass.`);
      continue;
    }
    wanted.push({ path: file, preexisting: entry.preexisting === true });
  }
  if (!wanted.length) return { reverted, failed };

  // The baseline is checked once for the whole batch. Per file it was the same
  // question with the same answer, and repeating a refusal 500 times buries
  // the one sentence that explains it.
  if (!baselineHead) {
    for (const f of wanted) {
      record(f.path, 'This session has no baseline commit, so there is nothing to revert to. It may not be a git repo.');
    }
    return { reverted, failed };
  }
  try { assertManagedRoot(root, 'That folder'); } catch (e) {
    return { reverted, failed: [{ file: '', detail: e instanceof Error ? e.message : String(e) }] };
  }
  if (!(await baselineResolves(root, baselineHead))) {
    for (const f of wanted) record(f.path, noBaseline(f.path, f.preexisting === true, baselineHead).detail);
    return { reverted, failed };
  }

  // Sequential on purpose. Two concurrent `git checkout` calls contend for the
  // index lock, and a lost race would be reported as "could not restore" for a
  // file that was never the problem.
  for (const f of wanted) {
    const plan = await planFor(root, f.path, baselineHead, f.preexisting === true, true);
    if (plan.action === 'nothing' || !plan.safe) { record(f.path, plan.detail); continue; }
    const r = await apply(root, plan, baselineHead);
    if (r.ok) reverted.push(f.path); else record(f.path, r.detail);
  }
  return { reverted, failed };
}
