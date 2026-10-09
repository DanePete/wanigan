// The git workbench's vocabulary, and the parts of it that need no process:
// reading `git status --porcelain=v2`, laying out a commit graph, naming refs,
// checking a branch name, and saying in words why git refused something. Pure,
// so each rule is tested without a repository.
import type { ChangedFile, Provider, SessionState } from './model.ts';
import type { ConflictCode } from './conflict.ts';

/** An operation git has started and not finished. */
export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** Why a folder has no workbench: each is a different answer, and each is said. */
export type RepoProblem =
  | { kind: 'no-git' }
  | { kind: 'missing' }
  | { kind: 'not-repo' }
  | { kind: 'bare' }
  | { kind: 'subfolder'; top: string; prefix: string }
  | { kind: 'unreadable'; reason: string };

/** Who changed a file, where Wanigan knows: a session's turns that touched it since the last commit. */
export interface Attribution {
  sessionId: string;
  title: string;
  provider: Provider;
  cardKey: string | null;
  live: boolean;
  /** The turns whose checkpoints show the file changed; empty when only the agent's own tool calls said so. */
  turns: number[];
  /** Another session was live in the same folder during one of those turns. */
  shared: boolean;
}

export interface StatusEntry extends ChangedFile {
  /** Where a rename or copy came from. */
  from?: string;
  /** For a conflicted file: how the two sides disagree ("both modified"). */
  conflict?: string;
  /** For a conflicted file: git's two letters for it (UU, AA, DU…). */
  code?: ConflictCode;
  /** For a conflicted file: how many conflicts its text still holds; null when it has no text to hold them. */
  hunks?: number | null;
  /** Sessions that changed it since the last commit, as checkpoints and tool calls record. */
  who: Attribution[];
}

/** An agent session running in a checkout right now. */
export interface CheckoutAgent {
  sessionId: string;
  title: string;
  provider: Provider;
  state: SessionState;
  cardKey: string | null;
}

/** A checkout as git sees it: the project folder, or a card's worktree. */
export interface GitStatus {
  problem: RepoProblem | null;
  path: string;
  /** The card whose worktree this is; null for the project folder. */
  cardKey: string | null;
  branch: string | null;
  /** The commit checked out, in full; null on an unborn branch. */
  head: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  /** The upstream is configured but its branch is gone from the remote. */
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  operation: GitOperation | null;
  /** What the operation brings in, in words: a branch name or a short commit. */
  operationOf: string | null;
  /** The message git prepared for the commit that finishes the operation. */
  operationMessage: string | null;
  conflicted: StatusEntry[];
  staged: StatusEntry[];
  changed: StatusEntry[];
  untracked: StatusEntry[];
  /** Untracked files past the listing cap: counted, not listed. */
  omitted: number;
  /** In a card's worktree: what its commits changed since it forked from its base. Empty for the project folder. */
  committed: StatusEntry[];
  /** The branch a card's worktree forked from, when this is one. */
  forkedFrom: string | null;
  remotes: string[];
  stashes: number;
  /** Agent sessions live in this checkout now. */
  agents: CheckoutAgent[];
}

/** Which of a file's diffs: what is staged, what is not, a new file, a conflict, or a card's commits. */
export type DiffArea = 'staged' | 'changed' | 'untracked' | 'conflicted' | 'branch';

export const DIFF_AREAS: readonly DiffArea[] = ['staged', 'changed', 'untracked', 'conflicted', 'branch'];

/* ── status ──────────────────────────────────────────────────────────────── */

export interface ParsedStatus {
  head: string | null;
  branch: string | null;
  detached: boolean;
  unborn: boolean;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  stashes: number;
  conflicted: { path: string; code: string; conflict: string }[];
  staged: { path: string; from?: string; status: ChangedFile['status'] }[];
  changed: { path: string; status: ChangedFile['status'] }[];
  untracked: string[];
}

const CONFLICTS: Record<string, string> = {
  DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them',
  DU: 'deleted by us', AA: 'both added', UU: 'both modified',
};

/** git's letter for one side of a change, as the workbench shows it. */
function letter(code: string): ChangedFile['status'] {
  if (code === 'A' || code === 'C') return 'A';
  if (code === 'D') return 'D';
  if (code === 'R') return 'R';
  return 'M';
}

/** The text after the first `n` space-separated fields: a path may hold spaces of its own. */
function after(line: string, n: number): string {
  let at = 0;
  for (let i = 0; i < n; i++) {
    at = line.indexOf(' ', at) + 1;
    if (at === 0) return '';
  }
  return line.slice(at);
}

/** `git status --porcelain=v2 --branch -z --show-stash`, read. */
export function parseStatus(out: string): ParsedStatus {
  const s: ParsedStatus = {
    head: null, branch: null, detached: false, unborn: false, upstream: null, upstreamGone: false,
    ahead: 0, behind: 0, stashes: 0, conflicted: [], staged: [], changed: [], untracked: [],
  };
  let ab = false;
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const line = fields[i] as string;
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key = '', value = ''] = line.match(/^# (\S+) ?(.*)$/) ?? [];
      if (key === 'branch.oid') { s.unborn = value === '(initial)'; s.head = s.unborn ? null : value; }
      else if (key === 'branch.head') { s.detached = value === '(detached)'; s.branch = s.detached ? null : value; }
      else if (key === 'branch.upstream') s.upstream = value;
      else if (key === 'branch.ab') {
        ab = true;
        const m = value.match(/^\+(\d+) -(\d+)$/);
        s.ahead = Number(m?.[1] ?? 0);
        s.behind = Number(m?.[2] ?? 0);
      } else if (key === 'stash') s.stashes = Number(value) || 0;
      continue;
    }
    const kind = line[0];
    if (kind === '?') { s.untracked.push(line.slice(2)); continue; }
    if (kind === 'u') {
      const code = line.slice(2, 4);
      s.conflicted.push({ path: after(line, 10), code, conflict: CONFLICTS[code] ?? 'conflicted' });
      continue;
    }
    if (kind !== '1' && kind !== '2') continue;
    const x = line[2] ?? '.';
    const y = line[3] ?? '.';
    const path = after(line, kind === '1' ? 8 : 9);
    // A rename or copy carries where it came from as the next field.
    const from = kind === '2' ? fields[++i] : undefined;
    if (x !== '.') s.staged.push({ path, status: letter(x), ...(from ? { from } : {}) });
    if (y !== '.') s.changed.push({ path, status: letter(y) });
  }
  // An upstream with no ahead/behind line is one whose branch is gone from the remote.
  s.upstreamGone = s.upstream !== null && !ab;
  return s;
}

/* ── refs and names ──────────────────────────────────────────────────────── */

export const REF_MAX = 250;

/**
 * Why a ref from the window cannot be passed to git, or null when it can. The
 * rule is narrow on purpose — a leading dash, whitespace, a control character,
 * a length — because git checks the rest itself. A ref beginning with a dash
 * is the hole: `git checkout -f` is an option, not a branch, and discards work.
 */
export function refProblem(ref: unknown): string | null {
  if (typeof ref !== 'string' || !ref.trim()) return 'That needs a branch or commit name.';
  const shown = ref.slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, '');
  if (ref.startsWith('-')) return `“${shown}” begins with a dash, which git would read as an option, so Wanigan will not pass it. A branch really named that has to be renamed in a terminal.`;
  if (/[\s\u0000-\u001f\u007f]/.test(ref)) return `“${shown}” contains a space or a control character, which a git ref cannot.`;
  if (ref.length > REF_MAX) return `That name is ${ref.length} characters; ${REF_MAX} is the most Wanigan passes to git.`;
  return null;
}

/**
 * Why a new branch name would be refused, before git is asked: git's own rules
 * (git check-ref-format), the ones a person runs into, said in words.
 */
export function branchNameProblem(name: string): string | null {
  const ref = refProblem(name);
  if (ref) return ref;
  if (name === 'HEAD' || name === '@') return `“${name}” is a name git keeps for itself.`;
  if (/\.\.|@\{|[~^:?*[\\]/.test(name)) return 'A branch name cannot contain .., @{, ~, ^, :, ?, *, [ or a backslash.';
  if (name.endsWith('/') || name.startsWith('/') || name.includes('//')) return 'A branch name cannot start or end with /, or have two together.';
  if (name.endsWith('.') || name.endsWith('.lock') || name.split('/').some((p) => p.startsWith('.'))) return 'A branch name cannot end with . or .lock, and no part of it can start with a dot.';
  return null;
}

/** A card's own branch, `wanigan/ns-3`, is the card NS-3. Null for any other branch. */
export function cardKeyOfBranch(branch: string | null | undefined): string | null {
  const m = branch?.match(/^(?:refs\/heads\/|refs\/remotes\/[^/]+\/|[^/]+\/)?wanigan\/([a-z][a-z0-9]*-\d+)$/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

/** The card a merge commit brought in, from git's own subject: "Merge wanigan/ns-3", "Merge branch 'wanigan/ns-3' into main". */
export function cardKeyOfMerge(subject: string): string | null {
  const m = subject.match(/^Merge (?:(?:remote-tracking )?branch )?'?(?:[^\s/']+\/)?wanigan\/([a-z][a-z0-9]*-\d+)'?/i);
  return m?.[1] ? m[1].toUpperCase() : null;
}

export interface RefName {
  kind: 'head' | 'branch' | 'remote' | 'tag';
  name: string;
  /** For `head`: the branch HEAD points at, when it points at one. */
  current?: boolean;
}

/** `%D` with `--decorate=full`, read into refs: "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1". */
export function parseRefs(decoration: string): RefName[] {
  const out: RefName[] = [];
  for (const raw of decoration.split(', ').map((p) => p.trim()).filter(Boolean)) {
    if (raw === 'HEAD') { out.push({ kind: 'head', name: 'HEAD' }); continue; }
    const pointed = raw.match(/^HEAD -> (.+)$/);
    const ref = pointed ? pointed[1] as string : raw.replace(/^tag: /, '');
    if (ref.startsWith('refs/heads/')) out.push({ kind: 'branch', name: ref.slice(11), ...(pointed ? { current: true } : {}) });
    else if (ref.startsWith('refs/remotes/')) {
      if (!ref.endsWith('/HEAD')) out.push({ kind: 'remote', name: ref.slice(13) });
    } else if (ref.startsWith('refs/tags/')) out.push({ kind: 'tag', name: ref.slice(10) });
  }
  return out;
}

/* ── commit messages ─────────────────────────────────────────────────────── */

/** Past this a summary is cut off in most tools; past the soft limit it is merely long. */
export const SUBJECT_SOFT = 50;
export const SUBJECT_HARD = 72;

/** The message git is given: the summary, a blank line, the description. */
export function commitMessage(subject: string, body: string): string {
  const s = subject.trim();
  const b = body.replace(/\s+$/, '');
  return b.trim() ? `${s}\n\n${b}` : s;
}

/** A message split back into its summary and description. */
export function splitMessage(message: string): { subject: string; body: string } {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  // git's own prepared messages carry comment lines; they are not part of the message.
  const kept = lines.filter((l) => !l.startsWith('#'));
  const subject = (kept.shift() ?? '').trim();
  while (kept.length && !kept[0]?.trim()) kept.shift();
  return { subject, body: kept.join('\n').replace(/\s+$/, '') };
}

/* ── history ─────────────────────────────────────────────────────────────── */

export interface LogCommit {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  at: number;
  subject: string;
  refs: RefName[];
  /** The card this commit was made for, when it is on (or was merged from) a card's branch. */
  cardKey: string | null;
}

export interface GitLog {
  commits: LogCommit[];
  /** More commits than the limit match. */
  more: boolean;
  /** When filtering: how many commits were read, and whether that was all of them. */
  searched: { read: number; all: boolean } | null;
}

export interface CommitFile extends ChangedFile {
  from?: string;
  /** The file's diff against the commit's first parent; null when too much to send, or binary. */
  diff: string | null;
  truncated: boolean;
}

export interface CommitDetail {
  hash: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  at: number;
  committer: string;
  committedAt: number;
  subject: string;
  body: string;
  refs: RefName[];
  cardKey: string | null;
  files: CommitFile[];
  additions: number;
  deletions: number;
  /** Remote branches that have it; empty when it has not been pushed. */
  pushedTo: string[];
}

export interface LastCommit {
  hash: string;
  short: string;
  subject: string;
  body: string;
  /** Remote branches that already have it: amending it then would need a force push, which Wanigan never does. */
  pushedTo: string[];
  merge: boolean;
}

export interface BranchInfo {
  name: string;
  /** For a remote branch: its remote ("origin"). */
  remote: string | null;
  current: boolean;
  upstream: string | null;
  upstreamGone: boolean;
  ahead: number;
  behind: number;
  /** Everything on it is already in the branch checked out here. */
  merged: boolean;
  at: number | null;
  subject: string | null;
  author: string | null;
  head: string;
  /** Checked out in another worktree (a card's): where. */
  worktree: string | null;
  cardKey: string | null;
}

export interface Branches {
  current: string | null;
  local: BranchInfo[];
  remote: BranchInfo[];
}

export interface CommitLine {
  hash: string;
  short: string;
  subject: string;
  author: string;
  at: number;
}

export interface MergePreview {
  branch: string;
  into: string | null;
  /** Commits it brings in. */
  incoming: number;
  /** Commits here it does not have: with none, git fast-forwards. */
  outgoing: number;
  commits: CommitLine[];
}

export interface MergeResult {
  outcome: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict';
  commit: string | null;
  /** The files left conflicted, when it conflicted. */
  conflicts: string[];
}

export interface StashEntry {
  index: number;
  sha: string;
  message: string;
  branch: string | null;
  at: number;
}

export interface StashFile extends ChangedFile {
  from?: string;
  diff: string;
}

/** A conflicted file as the resolver reads it: git's own versions of it, merged three ways. */
export interface ConflictFile {
  path: string;
  /** The working file and conflict stages when shown; required before replacing or deleting it. */
  digest: string;
  code: ConflictCode;
  /** Which of git's versions exist: what both came from, ours, theirs. */
  stages: { base: boolean; ours: boolean; theirs: boolean };
  oursLabel: string;
  theirsLabel: string;
  binary: boolean;
  /** Too large to merge here: take a side, or resolve it in an editor. */
  tooLarge: boolean;
  /** Ours, the base and theirs merged with diff3 markers; null when there are not two texts to merge. */
  merged: string | null;
  /** The file as it is now, when it has text: how many conflicts it still holds. */
  inFile: number | null;
  /** The file was edited after git marked it (its markers differ from the three-way merge). */
  edited: boolean;
}

/** What a pull did: moved up, merged (when asked to), or left a conflict to resolve. */
export interface PullResult {
  pulled: number;
  from: string;
  outcome: 'up-to-date' | 'fast-forward' | 'merged' | 'conflict';
  conflicts: string[];
}

export interface PushPlan {
  /** Binds the displayed branch, commit and destination to the push confirmation. */
  digest: string;
  branch: string | null;
  remote: string | null;
  remoteBranch: string | null;
  url: string | null;
  /** The upstream it pushes to now; null when this push sets one. */
  upstream: string | null;
  setUpstream: boolean;
  /** The commits that go, newest first (at most 50), and how many in all. */
  commits: CommitLine[];
  total: number;
  /** The commit HEAD was on when this was planned: the push refuses if it moved. */
  head: string | null;
  refusal: string | null;
}

/** One row of the graph: where the commit's dot is, and the lines through its cell. */
export interface GraphRow {
  lane: number;
  color: number;
  /** Lines in the cell, in lane units; y 0 is the top, 1 the dot, 2 the bottom. */
  lines: { x1: number; y1: 0 | 1; x2: number; y2: 1 | 2; color: number }[];
  /** Lanes the cell spans, for its width. */
  width: number;
}

export const GRAPH_COLORS = 6;

/**
 * Lanes for a commit graph, newest first, as every git client converges on:
 * walk the commits holding one slot per open line of history, each waiting for
 * a commit. A commit takes the slot waiting for it (the leftmost, when several
 * children wait), its first parent inherits that slot and its colour, and each
 * other parent opens one of its own. Lines that pass a row stay in their slot,
 * so they are drawn straight.
 */
export function layoutGraph(commits: readonly Pick<LogCommit, 'hash' | 'parents'>[]): GraphRow[] {
  const known = new Set(commits.map((c) => c.hash));
  const slots: ({ hash: string; color: number } | null)[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  for (const c of commits) {
    const before = slots.map((s) => s && { ...s });
    let lane = slots.findIndex((s) => s?.hash === c.hash);
    let color: number;
    if (lane === -1) {
      lane = slots.indexOf(null);
      if (lane === -1) { lane = slots.length; slots.push(null); }
      color = nextColor++ % GRAPH_COLORS;
    } else color = (slots[lane] as { color: number }).color;
    // Every other slot waiting for this commit ends here: its line joins the dot.
    for (let i = 0; i < slots.length; i++) if (i !== lane && slots[i]?.hash === c.hash) slots[i] = null;
    const first = c.parents[0] && known.has(c.parents[0]) ? c.parents[0] : null;
    const others = c.parents.slice(1).filter((p) => known.has(p));
    // Held while the other parents find lanes, so a branch merged in never takes the commit's own.
    slots[lane] = first ? { hash: first, color } : { hash: '', color };
    const outs: { to: number; color: number }[] = first ? [{ to: lane, color }] : [];
    for (const p of others) {
      let at = slots.findIndex((s) => s?.hash === p);
      if (at === -1) {
        at = slots.indexOf(null);
        const opened = { hash: p, color: nextColor++ % GRAPH_COLORS };
        if (at === -1) { at = slots.length; slots.push(opened); } else slots[at] = opened;
      }
      outs.push({ to: at, color: (slots[at] as { color: number }).color });
    }
    if (!first) slots[lane] = null;
    while (slots.length && slots[slots.length - 1] === null) slots.pop();

    const lines: GraphRow['lines'] = [];
    before.forEach((s, i) => {
      if (!s) return;
      if (s.hash === c.hash) lines.push({ x1: i, y1: 0, x2: lane, y2: 1, color: s.color });
      else {
        // A line keeps its own slot; two slots can wait for one commit (two branches from one fork).
        const to = slots[i]?.hash === s.hash ? i : slots.findIndex((t) => t?.hash === s.hash);
        if (to >= 0) {
          lines.push({ x1: i, y1: 0, x2: i, y2: 1, color: s.color });
          lines.push({ x1: i, y1: 1, x2: to, y2: 2, color: s.color });
        }
      }
    });
    for (const o of outs) lines.push({ x1: lane, y1: 1, x2: o.to, y2: 2, color: o.color });
    const width = Math.max(lane + 1, before.length, slots.length, ...lines.map((l) => Math.max(l.x1, l.x2) + 1));
    rows.push({ lane, color, lines, width });
  }
  return rows;
}

/* ── pull requests ───────────────────────────────────────────────────────── */

export interface ChecksSummary {
  passed: number;
  failed: number;
  pending: number;
  /** Skipped and neutral runs: not a pass, not a failure. */
  other: number;
}

/** The checked-out branch's pull request, as the owner's own `gh` reports it. */
export interface BranchPullRequest {
  state: 'none' | 'open' | 'draft' | 'merged' | 'closed' | 'no-gh' | 'signed-out' | 'error' | 'no-branch';
  number: number | null;
  title: string | null;
  url: string | null;
  base: string | null;
  review: 'approved' | 'changes' | 'required' | null;
  checks: ChecksSummary | null;
  /** Why there is nothing to show, in words; null when there is a pull request. */
  message: string | null;
  checkedAt: number;
}

/** gh's `statusCheckRollup`, counted: check runs by conclusion, status contexts by state. */
export function summarizeChecks(rollup: unknown): ChecksSummary | null {
  if (!Array.isArray(rollup) || !rollup.length) return null;
  const s: ChecksSummary = { passed: 0, failed: 0, pending: 0, other: 0 };
  for (const item of rollup) {
    const c = (item ?? {}) as Record<string, unknown>;
    const state = String(c.conclusion || c.state || '').toUpperCase();
    const status = String(c.status ?? '').toUpperCase();
    if (status && status !== 'COMPLETED') s.pending++;
    else if (state === 'SUCCESS') s.passed++;
    else if (['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(state)) s.failed++;
    else if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', ''].includes(state)) s.pending++;
    else s.other++;
  }
  return s;
}

/** gh's `reviewDecision`, in Wanigan's words. */
export function reviewOf(decision: unknown): BranchPullRequest['review'] {
  if (decision === 'APPROVED') return 'approved';
  if (decision === 'CHANGES_REQUESTED') return 'changes';
  if (decision === 'REVIEW_REQUIRED') return 'required';
  return null;
}

/* ── why git refused ─────────────────────────────────────────────────────── */

export type GitFailureKind =
  | 'conflict' | 'hook' | 'signing' | 'identity' | 'timeout' | 'no-git' | 'auth' | 'network'
  | 'non-fast-forward' | 'overwrite' | 'nothing' | 'locked' | 'other';

export interface GitFailure {
  kind: GitFailureKind;
  /** In words, for the owner: what happened, and what to do about it. */
  message: string;
  /** git's own last useful line, for the curious. */
  detail: string;
}

/** The first lines git printed that say something, without its `error:`/`fatal:` prefixes. */
export function gitSaid(text: string, lines = 2): string {
  return text.split('\n').filter((l) => !/^\s*hint:/i.test(l)).map((l) => l.trim().replace(/^(?:error|fatal|remote): ?/i, ''))
    // git's own advice about finishing by hand is not what went wrong.
    .filter((l) => l && !/^Command failed|^Not committing merge|^use 'git commit'|^Automatic merge went well|^\(use "git /.test(l))
    .slice(0, lines).join(' ').slice(0, 400);
}

/**
 * Why a git command failed, in words, from what it printed. `what` is the act
 * ("the merge", "the commit"); `hooks` says the repository has a hook that runs
 * for it, because a hook that refuses prints only its own words, never "hook".
 */
export function explainFailure(input: { stderr: string; stdout?: string; killed?: boolean; missing?: boolean; what: string; hooks?: boolean }): GitFailure {
  const text = `${input.stderr}\n${input.stdout ?? ''}`;
  const detail = gitSaid(input.stderr || input.stdout || '');
  const what = input.what;
  const said = detail ? ` Git said: ${detail}` : '';
  const f = (kind: GitFailureKind, message: string): GitFailure => ({ kind, message, detail });
  if (input.missing) return f('no-git', 'Git is not installed, or not on your login shell’s PATH. Install it (xcode-select --install, or brew install git) and try again.');
  if (input.killed) return f('timeout', `Git took too long, so ${what} was stopped. Nothing was forced; check the repository and try again.`);
  if (/Please tell me who you are|Author identity unknown|Committer identity unknown|empty ident name|unable to auto-detect email address|no email was given/i.test(text)) {
    return f('identity', `Git does not know who you are, so ${what} was not made. Set your name and email (git config --global user.name and user.email) and try again.`);
  }
  if (/gpg failed to sign|failed to sign the data|cannot run gpg|error: gpg|ssh-keygen.*sign|Couldn't (?:load|find) (?:public )?key|signing failed|failed to write commit object/i.test(text)) {
    return f('signing', `Git could not sign ${what}, so it was not made. Your git config asks for signed commits; check your signing key (gpg or ssh) works in a terminal.${said}`);
  }
  if (/CONFLICT \(|Automatic merge failed|Merge conflict in|could not apply|after resolving the conflicts/i.test(text)) {
    return f('conflict', `${capital(what)} conflicted: both sides changed the same lines.`);
  }
  if (/hook declined|pre-receive hook declined|hook .*(?:failed|exited)|husky|lint-staged/i.test(text) || (input.hooks && !/nothing to commit|no changes added/i.test(text))) {
    return f('hook', `A git hook in this repository stopped ${what}.${said}`);
  }
  if (/Your local changes to the following files would be overwritten|untracked working tree files would be overwritten|would be overwritten by/i.test(text)) {
    return f('overwrite', `Git stopped ${what}, because it would overwrite uncommitted changes. Commit or stash them first.${said}`);
  }
  if (/non-fast-forward|\[rejected\]|fetch first|Updates were rejected|Not possible to fast-forward|have diverged|cannot fast-forward/i.test(text)) {
    return f('non-fast-forward', `The remote has commits this branch does not, so ${what} was refused. Pull (or merge) first; Wanigan never forces.${said}`);
  }
  if (/could not read Username|Authentication failed|Permission denied \(publickey|terminal prompts disabled|Host key verification failed|could not read Password|403|401 Unauthorized|Repository not found/i.test(text)) {
    return f('auth', `Git could not sign in to the remote, so ${what} did not happen. Wanigan never waits on a password prompt; set up an SSH key or a credential helper in a terminal first.${said}`);
  }
  if (/Could not resolve host|Connection refused|Connection timed out|Network is unreachable|unable to access/i.test(text)) {
    return f('network', `Git could not reach the remote, so ${what} did not happen.${said}`);
  }
  if (/index\.lock|Unable to create .*\.lock|another git process/i.test(text)) {
    return f('locked', `Another git command is running in this repository (its lock file is there), so ${what} was not started. Try again in a moment.`);
  }
  if (/nothing to commit|no changes added to commit|nothing added to commit/i.test(text)) {
    return f('nothing', 'There is nothing staged to commit.');
  }
  return f('other', `Git refused ${what}.${said}`);
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
