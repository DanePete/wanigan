import fs from 'node:fs';
import path from 'node:path';
import { runGit } from './git';
import { candidateRuleFiles, scopedRules, type ScopedRules } from '../shared/review-rules';
import { scratchReason } from '../shared/scratch-files';

/**
 * Reads the AGENTS.md and CLAUDE.md files on the path from a repository's root
 * to each changed file, for the scoped `Code Review Rules` in
 * shared/review-rules.ts. Read-only, bounded, and never following a symlink out
 * of the repository.
 */

const MAX_RULE_FILE_BYTES = 256 * 1024;
const MAX_CHANGED = 2_000;

async function toplevel(dir: string): Promise<string | null> {
  const top = await runGit(dir, ['rev-parse', '--show-toplevel'], { timeout: 8_000 });
  return top.ok && top.out.trim() ? top.out.trim() : null;
}

function readRuleFile(top: string, rel: string): string | null {
  const file = path.join(top, rel);
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_RULE_FILE_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** Rules covering changed paths given relative to `top`, the repository root. */
export function rulesAt(top: string, changed: readonly string[]): ScopedRules[] {
  const paths = changed.slice(0, MAX_CHANGED);
  const files = candidateRuleFiles(paths)
    .map((rel) => ({ path: rel, text: readRuleFile(top, rel) }))
    .filter((f): f is { path: string; text: string } => f.text !== null);
  return scopedRules(files, paths);
}

/** Rules for a checkout's changes, where `changed` is relative to the checkout (which may be a subdirectory of its repository). */
export async function rulesForCheckout(root: string, changed: readonly string[]): Promise<ScopedRules[]> {
  const top = await toplevel(root);
  if (!top) return [];
  const prefix = path.relative(fs.realpathSync(top), fs.realpathSync(root)).split(path.sep).join('/');
  return rulesAt(top, changed.map((p) => (prefix ? `${prefix}/${p}` : p)));
}

/**
 * Rules for everything an implementation worktree changed against a base
 * commit: tracked changes and untracked files, scratch paths left out.
 */
export async function rulesForWorktree(worktree: string, base: string | null): Promise<ScopedRules[]> {
  if (!worktree || !fs.existsSync(worktree)) return [];
  const top = await toplevel(worktree);
  if (!top) return [];
  const names = base && /^[0-9a-f]{7,64}$/i.test(base)
    ? await runGit(top, ['diff', '--name-only', '-z', '--no-renames', base, '--'], { timeout: 20_000 })
    : { ok: false, out: '' };
  const untracked = await runGit(top, ['ls-files', '--others', '--exclude-standard', '-z'], { timeout: 20_000 });
  const changed = [...new Set([...(names.ok ? names.out.split('\0') : []), ...(untracked.ok ? untracked.out.split('\0') : [])].filter(Boolean))]
    .filter((p) => scratchReason(p) === null);
  return rulesAt(top, changed);
}
