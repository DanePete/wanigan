/**
 * Worktree bootstrap, the part that needs no process.
 *
 * `git worktree add` checks out tracked files and nothing else, so an agent
 * that lands in a new worktree finds no dependencies, no local env file, and
 * no way to tell its dev server's port from the next agent's. Wanigan closes
 * that gap four ways when it makes a worktree: dependency folders (link, clone
 * or skip), the repository's `.worktreeinclude`, a block of loopback ports, and
 * the project's own setup commands. src/main/worktrees.ts does the filesystem
 * and git work, src/main/worktree-setup.ts runs and records the commands, and
 * everything they decide or report without a process lives here — so it is
 * tested under `node --test` in a fraction of a second, and main and the
 * renderer describe one outcome in the same words.
 */

/* ── dependency folders ─────────────────────────────────────────────── */

/**
 * What a new worktree gets where the main checkout has a gitignored dependency
 * folder (node_modules, vendor, .venv, target and the rest of the list in
 * worktrees.ts).
 *
 *   link   a symlink back to the main checkout's folder. Instant and free, and
 *          shared: an `npm install` inside the worktree rewrites the main
 *          checkout's node_modules, which is the cross-talk a worktree exists
 *          to stop. It stays the default because it was the only behaviour
 *          before this choice existed, and a project relying on it must not
 *          change under it.
 *   clone  a copy-on-write copy made with macOS `cp -c`. Isolated, and free on
 *          disk until something writes to it, but not instant: cp clones one
 *          file at a time, measured at about fifteen seconds for 80,000 files.
 *   skip   nothing at all, for a project whose setup command installs them.
 */
export type DepsMode = 'link' | 'clone' | 'skip';

/**
 * The variables Wanigan gives a worktree's setup, teardown and agent. An agent
 * launched outside a worktree must not inherit them either: a Wanigan started
 * from inside a worktree session would otherwise hand that session's port
 * block to every agent it launched, as if the ports were theirs.
 */
export const WORKTREE_ENV_NAMES: readonly string[] = ['WANIGAN_PORT', 'WANIGAN_PORT_COUNT', 'WANIGAN_WORKTREE', 'WANIGAN_REPO_ROOT'];

export const DEPS_MODES: readonly DepsMode[] = ['link', 'clone', 'skip'];

export const DEFAULT_DEPS_MODE: DepsMode = 'link';

export function asDepsMode(value: unknown): DepsMode | null {
  return typeof value === 'string' && (DEPS_MODES as readonly string[]).includes(value) ? (value as DepsMode) : null;
}

/** The words for each choice, shared by the launch dialog and anything else that offers it. */
export const DEPS_MODE_COPY: Record<DepsMode, { label: string; hint: string }> = {
  link: {
    label: 'Link',
    // The second sentence is a write Wanigan makes, so it is said before the
    // choice: a pattern with a trailing slash matches directories only, a
    // symlink is not one, and the link would otherwise read as untracked work.
    hint: 'Shared with the main checkout: an install inside the worktree changes the main checkout’s copy. '
      + 'Wanigan names each link in the repository’s local git exclude file, so git does not list it as untracked work.',
  },
  clone: {
    label: 'Clone',
    hint: 'A copy-on-write clone per worktree, isolated from the main checkout. Large folders take seconds to clone; where the disk cannot clone, Wanigan links instead and says so.',
  },
  skip: {
    label: 'Skip',
    hint: 'Not made available in the worktree. Install them with a setup command.',
  },
};

/** One dependency folder, as it ended up in a new worktree. */
export type DepOutcome = {
  /** Repository-relative, as in the list worktrees.ts considers: node_modules, vendor, .venv… */
  path: string;
  /** What the project asked for when the worktree was made. */
  requested: DepsMode;
  /** What is actually there. `failed` means neither a clone nor a link could be put in place. */
  result: 'linked' | 'cloned' | 'skipped' | 'failed';
  /** Why the result is not what was requested, as a clause; null when it is. */
  detail: string | null;
  /** How long a clone took. Null for anything that was not cloned. */
  durationMs: number | null;
};

/* ── .worktreeinclude ───────────────────────────────────────────────── */

/**
 * The bound on one worktree's copies. A `.worktreeinclude` is meant for the
 * handful of gitignored files a checkout cannot run without — an env file, a
 * local key — and a pattern written wider than that must not turn creating a
 * worktree into copying a disk. Clones are nearly free on APFS; on a volume
 * that cannot clone every byte is a real copy.
 */
export const INCLUDE_LIMITS = { files: 5_000, bytes: 1024 ** 3 } as const;

export type IncludeLimits = { files: number; bytes: number };

export type IncludeOutcome =
  /** The repository root has no `.worktreeinclude`. */
  | { state: 'absent' }
  /** There is one and it could not be used; nothing was copied from it. */
  | { state: 'unreadable'; detail: string }
  | {
      state: 'read';
      patterns: number;
      copied: number;
      bytes: number;
      /** Matched and gitignored, but something already sits at that path in the worktree. */
      present: number;
      /**
       * Matched a pattern but git does not ignore them. An untracked file the
       * operator never ignored is work in progress, not machine-local config,
       * and copying it would put somebody's half-written file in front of an
       * agent as if it belonged there.
       */
      notIgnored: number;
      /** Never followed: a link can name a file anywhere on the machine. */
      symlinks: number;
      /** Refused because the destination would be reached through a link that leaves the worktree. */
      outside: number;
      /** Could not be copied — a nested repository, a socket, or a copy that errored. */
      failed: number;
      /** The first failure, in the words it arrived in; null when nothing failed. */
      failure: string | null;
      /** Where copying stopped short of every match, or null when all of them were examined. */
      stopped: { by: 'files' | 'bytes' | 'git'; limit: number | null; unexamined: number } | null;
      /** True when source and worktree share an APFS volume, so each copy was a clone rather than a full copy. */
      cloneable: boolean;
    };

/**
 * Patterns in a gitignore-syntax file: every line that is neither blank nor a
 * comment. git treats only a line that *starts* with `#` as a comment, so an
 * indented `#` and an escaped `\#` are both patterns, and are counted.
 */
export function includePatternCount(text: string): number {
  return text.split('\n').map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '' && !line.startsWith('#')).length;
}

/**
 * A path git listed that is safe to join onto a worktree: relative, no `..`
 * segment, not a directory entry. git never prints the first two for
 * `ls-files`, and this is the check that makes "git said so" not the only
 * thing standing between a pattern file and a write outside the worktree.
 */
export function isSafeRelative(rel: string): boolean {
  if (!rel || rel.includes('\0') || rel.endsWith('/') || rel.startsWith('/')) return false;
  return !rel.split('/').some((part) => part === '..' || part === '');
}

/* ── ports ──────────────────────────────────────────────────────────── */

/**
 * The loopback range worktree port blocks are cut from: 42000–48999 in blocks
 * of ten, 700 blocks in all. Chosen to sit below macOS's ephemeral range
 * (49152 and up), where the kernel hands out outgoing ports and a block would
 * collide with something nobody chose.
 */
export const PORT_FIRST = 42_000;
export const PORT_LAST = 48_999;
export const PORT_BLOCK_SIZE = 10;
export const PORT_BLOCKS = (PORT_LAST - PORT_FIRST + 1) / PORT_BLOCK_SIZE;
/** Blocks tried before giving up and handing out the path's own block anyway. */
export const PORT_ATTEMPTS = 32;

/** A uint32 from the first eight hex digits of a digest; 0 for anything that is not hex. */
export function seedFromHex(hex: string): number {
  const head = /^[0-9a-f]{8}/i.exec(hex)?.[0];
  return head ? Number.parseInt(head, 16) >>> 0 : 0;
}

/**
 * The first port of the block a seed lands on, `attempt` blocks further along.
 * It wraps past the top of the range rather than walking off it, so every
 * attempt names a real block and a path near the end of the range still gets
 * its full set of tries.
 */
export function portBlockBase(seed: number, attempt = 0): number {
  const s = Number.isFinite(seed) ? Math.floor(Math.abs(seed)) : 0;
  const step = Number.isFinite(attempt) ? Math.max(0, Math.floor(attempt)) : 0;
  const index = ((s % PORT_BLOCKS) + step) % PORT_BLOCKS;
  return PORT_FIRST + index * PORT_BLOCK_SIZE;
}

/** True for a number that is the first port of some block in the range. */
export function isPortBlockBase(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= PORT_FIRST && n <= PORT_LAST
    && (n - PORT_FIRST) % PORT_BLOCK_SIZE === 0;
}

export type PortBlock = {
  base: number;
  count: number;
  /**
   *   recorded  handed out when the worktree was made, and returned unprobed:
   *             the worktree's own dev server may be what is listening now,
   *             and re-probing would move it off its own ports.
   *   free      no port in the block answered on loopback, and no other live
   *             worktree holds it.
   *   busy      every block tried was taken, so this is the path's own block,
   *             handed out anyway. A convention nobody enforces cannot promise
   *             more than that, and says so.
   */
  state: 'recorded' | 'free' | 'busy';
  /** Blocks passed over on the way to this one. */
  skipped: number;
};

/* ── setup and teardown ─────────────────────────────────────────────── */

export type WorktreePhase = 'setup' | 'teardown';

/** The same bounds a review recipe has, for the same reason: this is command text a person approved line by line. */
export const WORKTREE_COMMAND_LIMIT = 20;
export const WORKTREE_COMMAND_MAX_CHARS = 2_000;
/** One phase's whole allowance, not a per-command one: setup stands between a launch and its agent. */
export const WORKTREE_PHASE_BUDGET_MS = 10 * 60_000;

export type WorktreeCommandLists = { setup: string[]; teardown: string[] };

/** The four variables both phases receive. */
export type WorktreeCommandEnv = {
  WANIGAN_WORKTREE: string;
  WANIGAN_REPO_ROOT: string;
  WANIGAN_PORT: string;
  WANIGAN_PORT_COUNT: string;
};

export type WorktreeCommandResult = { command: string; exitCode: number | null; output: string; durationMs: number };

export type WorktreeCommandRun = {
  id: string;
  projectId: string;
  worktree: string;
  phase: WorktreePhase;
  startedAt: number;
  endedAt: number | null;
  status: 'running' | 'passed' | 'failed';
  /** How many commands the stored list held when the run began, so a run that stopped early can say how far it got. */
  planned: number;
  results: WorktreeCommandResult[];
  /** What the commands were given, recorded before the first one ran. */
  env: WorktreeCommandEnv | null;
  /**
   * Why the run ended without its own commands deciding it — Wanigan quit while
   * it was running, or could not read the stored commands. Null otherwise. A
   * field rather than a fake command row: a row named "[Wanigan]" would be
   * summarised as the command that failed.
   */
  note: string | null;
};

/** What the Git view's panel reads: the stored commands, the dependency choice, and whether the repository has an include file. */
export type WorktreeSetupConfig = {
  projectId: string;
  depsMode: DepsMode;
  setup: string[];
  teardown: string[];
  updatedAt: number | null;
  include: { state: 'absent' } | { state: 'present'; patterns: number } | { state: 'unreadable'; detail: string };
};

function lines(value: unknown, phase: WorktreePhase): string[] | string {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((x) => typeof x !== 'string')) {
    return `The ${phase} commands must be a list of lines.`;
  }
  return (value as string[]).map((x) => x.trim()).filter(Boolean);
}

/**
 * The renderer's two lists, checked. A list longer than the limit is refused
 * rather than trimmed: review.ts quietly keeps the first twenty, and a save
 * that stores less than was typed reports success for commands that will
 * never run.
 */
export function parseCommandInput(value: unknown): WorktreeCommandLists | { problem: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { problem: 'Worktree commands arrive as a setup list and a teardown list.' };
  }
  const input = value as Record<string, unknown>;
  const setup = lines(input.setup, 'setup');
  if (typeof setup === 'string') return { problem: setup };
  const teardown = lines(input.teardown, 'teardown');
  if (typeof teardown === 'string') return { problem: teardown };
  for (const [phase, list] of [['setup', setup], ['teardown', teardown]] as const) {
    if (list.length > WORKTREE_COMMAND_LIMIT) {
      return { problem: `Use at most ${WORKTREE_COMMAND_LIMIT} ${phase} commands.` };
    }
    if (list.some((c) => c.length > WORKTREE_COMMAND_MAX_CHARS)) {
      return { problem: `A ${phase} command is too long (maximum ${WORKTREE_COMMAND_MAX_CHARS.toLocaleString('en-US')} characters).` };
    }
  }
  return { setup, teardown };
}

/**
 * Commands a save would add, per phase. A line moved from teardown to setup
 * counts as new: it would run at a different moment, against a worktree in a
 * different state, and that is a capability the person approved nothing about.
 * Dropping or reordering lines adds nothing.
 */
export function newCommands(stored: WorktreeCommandLists, next: WorktreeCommandLists): WorktreeCommandLists {
  return {
    setup: next.setup.filter((c) => !stored.setup.includes(c)),
    teardown: next.teardown.filter((c) => !stored.teardown.includes(c)),
  };
}

/* ── what a reader sees ─────────────────────────────────────────────── */

/** A run cut down for a list that is re-read every few seconds: the verdict, the command that ended it, and the end of the output. */
export type WorktreeRunSummary = {
  id: string;
  phase: WorktreePhase;
  status: WorktreeCommandRun['status'];
  startedAt: number;
  endedAt: number | null;
  planned: number;
  ran: number;
  /** The command that ended the run early — a non-zero exit, or one that never exited — or null. */
  stoppedAt: { command: string; exitCode: number | null } | null;
  /** The run's own note, when something other than its commands ended it. */
  note: string | null;
  tail: string;
  /** True when `tail` is not the whole recorded output. */
  tailCut: boolean;
};

/** What Wanigan put into a worktree when it made it, and the newest setup run there. */
export type WorktreeBootstrap = {
  /** Main requires private copies for mutable goal work; relink honors it. */
  privateDependencies?: boolean;
  /** Goal checkouts survive automatic session cleanup, including later resumes. */
  retainForReview?: boolean;
  depsMode: DepsMode;
  deps: DepOutcome[];
  include: IncludeOutcome;
  ports: { base: number; count: number } | null;
  setup: WorktreeRunSummary | null;
};

export const TAIL_LINES = 12;
export const TAIL_CHARS = 1_500;

/** The last lines of some output, bounded by line count and by characters, saying whether anything was left out. */
export function outputTail(text: string, maxLines = TAIL_LINES, maxChars = TAIL_CHARS): { tail: string; cut: boolean } {
  const trimmed = text.replace(/\s+$/, '');
  if (!trimmed) return { tail: '', cut: false };
  const all = trimmed.split('\n');
  let tail = all.slice(-maxLines).join('\n');
  let cut = all.length > maxLines;
  if (tail.length > maxChars) {
    tail = tail.slice(-maxChars);
    // Start on a line boundary where one exists, so the first line shown is a
    // whole line rather than the back half of one.
    const nl = tail.indexOf('\n');
    if (nl >= 0 && nl < tail.length - 1) tail = tail.slice(nl + 1);
    cut = true;
  }
  return { tail, cut };
}

export function summarizeRun(run: WorktreeCommandRun): WorktreeRunSummary {
  const last = run.results[run.results.length - 1];
  const stoppedAt = run.status === 'failed' && last && last.exitCode !== 0
    ? { command: last.command, exitCode: last.exitCode }
    : null;
  // Each command's output under its own `$ command` line, so a tail that spans
  // two commands still says which one printed what.
  const joined = [
    ...run.results.map((r) => `$ ${r.command}\n${r.output.replace(/\s+$/, '')}`),
    ...(run.note ? [run.note] : []),
  ].join('\n');
  const { tail, cut } = outputTail(joined);
  return {
    id: run.id, phase: run.phase, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
    planned: run.planned, ran: run.results.length, stoppedAt: run.note ? null : stoppedAt, note: run.note,
    tail, tailCut: cut,
  };
}

const plural = (n: number, word: string, many = `${word}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? word : many}`;

/** A byte count in one to three digits: "912 B", "4.1 KB", "12 MB". The renderer's size() says the same. */
export function bytesText(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** "840ms", "4.2s", "3m 05s". */
export function durationText(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** One clause per dependency folder, or null when there were none to place. */
export function describeDeps(deps: readonly DepOutcome[]): string | null {
  if (!deps.length) return null;
  return deps.map((d) => {
    if (d.result === 'cloned') return `${d.path} cloned${d.durationMs !== null ? ` in ${durationText(d.durationMs)}` : ''}`;
    if (d.result === 'skipped') return `${d.path} not made available`;
    if (d.result === 'failed') return `${d.path} missing: ${d.detail ?? 'neither a clone nor a link could be made'}`;
    return d.requested === 'link' || !d.detail
      ? `${d.path} linked to the main checkout`
      : `${d.path} linked instead of cloned: ${d.detail}`;
  }).join('; ');
}

/**
 * What the include file did, or null when there is none. A read that failed
 * never becomes "0 files copied": that sentence claims the patterns matched
 * nothing, which is a different fact from not having been able to ask.
 */
export function describeInclude(include: IncludeOutcome): string | null {
  if (include.state === 'absent') return null;
  if (include.state === 'unreadable') return `.worktreeinclude was not used: ${include.detail}. Nothing was copied from it`;
  if (include.patterns === 0) return '.worktreeinclude has no patterns, so nothing was copied from it';
  const parts = [
    `${plural(include.copied, 'file')}${include.copied ? ` (${bytesText(include.bytes)})` : ''} copied from .worktreeinclude`
      + (include.copied && !include.cloneable ? ' as full copies, because this disk cannot clone' : ''),
  ];
  if (include.present) parts.push(`${plural(include.present, 'match', 'matches')} already there`);
  if (include.notIgnored) parts.push(`${plural(include.notIgnored, 'match', 'matches')} left alone because git does not ignore ${include.notIgnored === 1 ? 'it' : 'them'}`);
  if (include.symlinks) parts.push(`${plural(include.symlinks, 'symlink')} not followed`);
  if (include.outside) parts.push(`${plural(include.outside, 'path')} refused for leading outside the worktree`);
  if (include.failed) parts.push(`${include.failed.toLocaleString('en-US')} not copied${include.failure ? ` (${include.failure})` : ''}`);
  if (include.stopped) {
    const rest = `${plural(include.stopped.unexamined, 'more match', 'more matches')} not examined`;
    parts.push(include.stopped.by === 'git'
      ? `stopped when git could not check the rest; ${rest}`
      : include.stopped.by === 'files'
        ? `stopped at the ${(include.stopped.limit ?? 0).toLocaleString('en-US')}-file limit; ${rest}`
        : `stopped at the ${bytesText(include.stopped.limit ?? 0)} limit; ${rest}`);
  }
  return parts.join('; ');
}

/** The ports as a reader writes them: "42310–42319". */
export function portsText(ports: { base: number; count: number }): string {
  return `${ports.base}–${ports.base + ports.count - 1}`;
}

/**
 * What a worktree's branch row says about how it was made, one clause each, in
 * the order a reader checks them: the ports that are its own, what became of
 * its dependency folders, what the include file copied, and — only when no
 * setup ran — that none did. A setup that did run is not in the list: it leads
 * the row with its own mark and output, and "no setup ran" next to it would
 * contradict it.
 */
export function bootstrapFacts(b: WorktreeBootstrap): string[] {
  return [
    b.ports ? `ports ${portsText(b.ports)}` : null,
    describeDeps(b.deps),
    describeInclude(b.include),
    b.setup ? null : 'no setup ran',
  ].filter((fact): fact is string => fact !== null);
}

/**
 * What starting a session in a new worktree will do beyond the checkout, for
 * the launch dialog, or null when it does nothing more. Said before the press
 * because setup stands between the button and the agent: a launch that waits
 * minutes on `npm ci` with no word about why reads as a hung launch.
 */
export function launchSetupNote(config: Pick<WorktreeSetupConfig, 'setup' | 'include'>): string | null {
  const parts: string[] = [];
  const n = config.setup.length;
  if (n) {
    parts.push(`${plural(n, 'setup command')} ${n === 1 ? 'runs' : 'run'} in it before the agent starts; `
      + 'if one fails, the worktree is kept and the session starts anyway.');
  }
  if (config.include.state === 'present' && config.include.patterns) {
    parts.push(`Gitignored files matching .worktreeinclude (${plural(config.include.patterns, 'pattern')}) are copied in.`);
  } else if (config.include.state === 'unreadable') {
    parts.push(`.worktreeinclude cannot be read right now (${config.include.detail}), so nothing would be copied from it.`);
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * The run in one clause, for a row that has little room: the verdict's facts,
 * never the verdict alone. A failed setup says what it did not do, because
 * "setup failed" next to a worktree reads like the reason the agent is missing.
 */
export function runFacts(run: WorktreeRunSummary): string {
  const took = run.endedAt !== null ? durationText(run.endedAt - run.startedAt) : null;
  if (run.status === 'running') return `${plural(run.planned, 'command')}, still running`;
  if (run.status === 'passed') return [plural(run.ran, 'command'), took].filter(Boolean).join(' · ');
  const which = run.stoppedAt
    ? run.stoppedAt.exitCode === null ? `${run.stoppedAt.command} did not finish` : `${run.stoppedAt.command} exited ${run.stoppedAt.exitCode}`
    : run.note ?? `${run.ran} of ${run.planned} ran`;
  const tail = run.phase === 'setup' ? 'the worktree was kept and the launch was not held back' : null;
  return [which, took, tail].filter(Boolean).join(' · ');
}
