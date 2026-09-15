/**
 * Git history rewrites: the commands that perform them, and the ref moves that
 * prove one happened.
 *
 * An agent that force-pushes rewritten history can erase the evidence of what
 * it did (AISI incident report, via The Hacker News, 5 Aug 2026;
 * a-claude-articles.md §1.15). Wanigan's per-turn checkpoints record the tree,
 * not the refs. This module is the pure half of the ref record: it recognises
 * the commands that rewrite history, and, given two snapshots of a repository's
 * refs and an ancestry answer from git, says which refs were deleted or moved
 * somewhere that does not contain where they were. The main process pins each
 * orphaned commit under refs/wanigan/evidence/ so `git gc` cannot collect it.
 */

import { parseShell, programOf } from './shell-parse.ts';

export type RewriteKind =
  | 'force-push' | 'reset-hard' | 'rebase' | 'amend' | 'branch-delete' | 'tag-delete'
  | 'filter-branch' | 'filter-repo' | 'update-ref-delete';

export type RewriteCommand = { kind: RewriteKind; text: string };

/** git's global options that take a value before the subcommand. */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** Every history-rewriting git command on a line, including inside wrappers and substitutions. */
export function rewriteCommandsIn(command: string): RewriteCommand[] {
  const out: RewriteCommand[] = [];
  for (const seg of parseShell(command).segments) {
    const program = programOf(seg);
    if (program === 'git-filter-repo') { out.push({ kind: 'filter-repo', text: seg.text }); continue; }
    if (program !== 'git') continue;
    const words = seg.argv.slice(1).map((w) => w.text);
    let i = 0;
    while (i < words.length && words[i].startsWith('-')) {
      i += GLOBAL_WITH_VALUE.has(words[i]) ? 2 : 1;
    }
    const verb = words[i];
    const rest = words.slice(i + 1);
    const has = (...xs: string[]) => rest.some((w) => xs.includes(w));
    const shortFlag = (letter: string) => rest.some((w) => /^-[a-zA-Z]+$/.test(w) && w.includes(letter));
    let kind: RewriteKind | null = null;
    switch (verb) {
      case 'push':
        if (has('--force', '--force-with-lease', '--force-if-includes', '--mirror') || rest.some((w) => w.startsWith('--force-with-lease=')) || shortFlag('f')
          || rest.some((w) => /^\+[^\s]/.test(w)) || (has('--delete') || shortFlag('d'))) kind = 'force-push';
        break;
      case 'reset':
        if (has('--hard')) kind = 'reset-hard';
        break;
      case 'rebase':
        kind = 'rebase';
        break;
      case 'commit':
        if (has('--amend')) kind = 'amend';
        break;
      case 'branch':
        if (rest.includes('-D') || ((has('--delete') || shortFlag('d')) && (has('--force') || shortFlag('f')))) kind = 'branch-delete';
        break;
      case 'tag':
        if (has('--delete') || shortFlag('d')) kind = 'tag-delete';
        break;
      case 'filter-branch':
        kind = 'filter-branch';
        break;
      case 'filter-repo':
        kind = 'filter-repo';
        break;
      case 'update-ref':
        if (has('-d', '--stdin')) kind = 'update-ref-delete';
        break;
    }
    if (kind) out.push({ kind, text: seg.text });
  }
  return out;
}

export type RefSnapshot = { refs: Record<string, string> };

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * `git for-each-ref --format='%(objectname) %(refname)'` output, plus the
 * detached HEAD when there is one. Wanigan's own refs/wanigan/ namespace is
 * never part of a snapshot: pinning evidence must not look like a rewrite.
 */
export function parseRefSnapshot(forEachRef: string, detachedHead: string | null): RefSnapshot {
  const refs: Record<string, string> = {};
  for (const line of forEachRef.split('\n')) {
    const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?)\s+(refs\/\S+)$/.exec(line.trim());
    if (!m || m[2].startsWith('refs/wanigan/')) continue;
    refs[m[2]] = m[1];
  }
  const head = detachedHead?.trim() ?? '';
  if (SHA.test(head)) refs.HEAD = head;
  return { refs };
}

export type RefMove = { ref: string; from: string; to: string | null };

/** Refs that were deleted, or now point somewhere else. New refs are not moves. */
export function refMoves(prev: RefSnapshot, next: RefSnapshot): RefMove[] {
  const out: RefMove[] = [];
  for (const [ref, from] of Object.entries(prev.refs)) {
    const to = next.refs[ref];
    if (to === undefined) out.push({ ref, from, to: null });
    else if (to !== from) out.push({ ref, from, to });
  }
  return out;
}

export type Rewrite = RefMove & {
  kind: 'deleted' | 'non-fast-forward' | 'cannot confirm';
};

/**
 * Which moves orphaned a commit. `isAncestor(from, to)` is git's
 * `merge-base --is-ancestor`: true for a fast-forward, false for a rewrite, and
 * null when git could not answer — which is recorded as exactly that rather
 * than dropped, because an unanswered question about a moved ref is not a
 * fast-forward.
 */
export function classifyMoves(moves: RefMove[], isAncestor: (from: string, to: string) => boolean | null): Rewrite[] {
  const out: Rewrite[] = [];
  for (const m of moves) {
    if (m.to === null) { out.push({ ...m, kind: 'deleted' }); continue; }
    const ff = isAncestor(m.from, m.to);
    if (ff === true) continue;
    out.push({ ...m, kind: ff === false ? 'non-fast-forward' : 'cannot confirm' });
  }
  return out;
}
