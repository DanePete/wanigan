import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);

/**
 * Undoing one file, against the state the session started from.
 *
 * Claude Code's own /rewind is the right tool for a conversation, but it is
 * explicit about three things it cannot restore: files changed by a bash
 * command, edits made by a background subagent, and anything reached through a
 * symlink. Those are not edge cases — an agent that runs `mv` or delegates to a
 * subagent produces exactly them.
 *
 * Foreman's baseline is a git commit, and git sees all three. So this is not a
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

async function git(root: string, args: string[], timeout = 15_000) {
  try {
    const { stdout } = await exec('git', ['-C', root, ...args], { timeout, maxBuffer: 32 * 1024 * 1024 });
    return { ok: true as const, stdout };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false as const, stdout: '', error: (err.stderr || err.message || 'git failed').trim() };
  }
}

/** Contained: the path must resolve inside the repo, symlinks included. */
function inside(root: string, rel: string): string | null {
  const abs = path.resolve(root, rel);
  const realRoot = (() => { try { return fs.realpathSync(root); } catch { return path.resolve(root); } })();
  const realAbs = (() => { try { return fs.realpathSync(abs); } catch { return abs; } })();
  return realAbs === realRoot || realAbs.startsWith(realRoot + path.sep) ? abs : null;
}

/**
 * What would happen, without doing it. A revert that surprises you once is a
 * revert you never use again.
 */
export async function planRevert(root: string, file: string, baselineHead: string | null,
                                 preexisting: boolean): Promise<RevertPlan> {
  const abs = inside(root, file);
  if (!abs) {
    return { file, action: 'nothing', preexisting, safe: false,
             detail: `${file} resolves outside ${root}, so Foreman will not touch it.` };
  }
  if (!baselineHead) {
    return { file, action: 'nothing', preexisting, safe: false,
             detail: 'This session has no baseline commit, so there is nothing to revert to. It may not be a git repo.' };
  }
  const existed = await git(root, ['cat-file', '-e', `${baselineHead}:${file}`]);
  if (existed.ok) {
    return {
      file, action: 'restore', preexisting, safe: true,
      detail: preexisting
        ? `Restores ${file} to the commit this session started from — which also discards changes you made before it started.`
        : `Restores ${file} to the commit this session started from, discarding the agent's changes to it.`,
    };
  }
  return {
    file, action: 'delete', preexisting, safe: true,
    detail: `${file} did not exist when this session started, so reverting deletes it.`,
  };
}

export async function revertFile(root: string, file: string, baselineHead: string | null,
                                 preexisting = false): Promise<{ ok: boolean; detail: string }> {
  const plan = await planRevert(root, file, baselineHead, preexisting);
  if (plan.action === 'nothing' || !plan.safe) return { ok: false, detail: plan.detail };

  if (plan.action === 'delete') {
    const abs = inside(root, file);
    if (!abs) return { ok: false, detail: 'Refused: the path left the repository.' };
    try { fs.rmSync(abs, { force: true }); } catch (e) {
      return { ok: false, detail: `Could not delete ${file}: ${e instanceof Error ? e.message : String(e)}` };
    }
    return { ok: true, detail: `Deleted ${file}, which did not exist at the baseline.` };
  }

  // `--` so a file named like a flag cannot be read as one.
  const r = await git(root, ['checkout', baselineHead!, '--', file]);
  if (!r.ok) return { ok: false, detail: `git could not restore ${file}: ${r.error}` };
  return { ok: true, detail: `Restored ${file} to ${baselineHead!.slice(0, 8)}.` };
}

/** Everything this session touched, reverted together. Deliberately explicit. */
export async function revertAll(root: string, files: { path: string; preexisting?: boolean }[],
                                baselineHead: string | null): Promise<{ reverted: string[]; failed: { file: string; detail: string }[] }> {
  const reverted: string[] = [];
  const failed: { file: string; detail: string }[] = [];
  for (const f of files) {
    const r = await revertFile(root, f.path, baselineHead, f.preexisting === true);
    if (r.ok) reverted.push(f.path); else failed.push({ file: f.path, detail: r.detail });
  }
  return { reverted, failed };
}
