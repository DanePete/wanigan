/**
 * Review someone else's change: the pure half of "Review PR #N" and of review
 * sessions with no command tools.
 *
 * A pull request's head is fetched by its forge's own ref — GitHub publishes
 * `refs/pull/<n>/head`, GitLab `refs/merge-requests/<n>/head` — the way Claude
 * Code's `--worktree "#1234"` does. Only an origin that is recognisably GitLab
 * gets the GitLab ref; everything else gets GitHub's, and git's own refusal is
 * reported word for word when the ref does not exist.
 *
 * `--restricted` was verified in Claude Code 2.1.271's `--help`: it removes the
 * built-in tools that run commands or code and WebFetch, confines file tools to
 * the working directories, ignores user/project/local settings (managed
 * settings and `--settings` still apply) and refuses bypassPermissions. Wanigan
 * calls that "no command tools" and never "sandboxed": the agent can still read
 * every file it is given and write where its permission mode allows.
 */

export const REVIEW_ONLY_LABEL = 'no command tools';
export const RESTRICTED_FLAG = '--restricted';

/** A PR number as typed: `12`, `#12`, `!12`. Anything else is refused. */
export function parsePrNumber(input: unknown): number | null {
  if (typeof input === 'number') return Number.isInteger(input) && input > 0 && input < 10_000_000 ? input : null;
  if (typeof input !== 'string') return null;
  const m = /^\s*[#!]?(\d{1,7})\s*$/.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

export type Forge = 'github' | 'gitlab' | 'other';

/** Which forge an origin URL points at, from its host. */
export function forgeOf(remoteUrl: string): Forge {
  const url = remoteUrl.trim();
  let host = '';
  const scp = /^[^@\s]+@([^:\s]+):/.exec(url);
  if (scp) host = scp[1];
  else {
    try { host = new URL(url).hostname; } catch { host = ''; }
  }
  host = host.toLowerCase();
  if (!host) return 'other';
  if (host === 'github.com' || host.endsWith('.github.com') || host.startsWith('github.')) return 'github';
  if (host === 'gitlab.com' || host.endsWith('.gitlab.com') || host.startsWith('gitlab.') || host.includes('gitlab')) return 'gitlab';
  return 'other';
}

/** The refs to try, in order. GitLab's only when origin is GitLab. */
export function prRefs(forge: Forge, n: number): string[] {
  return forge === 'gitlab' ? [`merge-requests/${n}/head`] : [`pull/${n}/head`];
}

export function prNoun(forge: Forge): string {
  return forge === 'gitlab' ? 'merge request' : 'pull request';
}

/** The first prompt a review session opens with. The operator edits it before launching. */
export function reviewPromptStub(n: number, forge: Forge, branch: string): string {
  const noun = forge === 'gitlab' ? `merge request !${n}` : `pull request #${n}`;
  return [
    `Review ${noun}. Its head is checked out in this worktree on branch ${branch}.`,
    'Read the change against its merge base, and report correctness problems, risky changes and missing tests, each with the file and line.',
    'You have no command tools in this session, so do not claim that anything was run.',
  ].join(' ');
}

/** A fetch refspec into Wanigan's own ref namespace, so no user branch is touched. */
export function prFetchSpec(ref: string, n: number): string {
  return `+refs/${ref}:refs/wanigan/review/${n}`;
}

/** Claude Code release that first shipped --restricted (W35 digest, 24–28 Aug 2026). */
export const RESTRICTED_SINCE = '2.1.248';

/** Compare dotted versions numerically; a missing or odd version is never "at least". */
export function versionAtLeast(version: string | null | undefined, floor: string): boolean {
  const pick = (v: string) => (/(\d+)\.(\d+)\.(\d+)/.exec(v) ?? []).slice(1).map(Number);
  if (!version) return false;
  const a = pick(version);
  const b = pick(floor);
  if (a.length !== 3 || b.length !== 3) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}
