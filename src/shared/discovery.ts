/**
 * Projects you already work in, found rather than browsed for.
 *
 * Claude Code and Codex both keep a per-session transcript on disk, and each
 * records the directory the session ran in. Reading those values gives the set
 * of directories worth offering during onboarding without asking anyone to
 * walk a folder picker one repository at a time. The approach is adapted from
 * T3 Code's AgentSessionScanner (MIT, pingdotgg/t3code), including its
 * exclusion list — the traps it documents are real and were worth inheriting
 * rather than rediscovering.
 *
 * Pure data and pure functions, like routes.ts and preflight.ts, so the smoke
 * suite can hold the ranking and the default selection to account without a
 * filesystem. Everything that touches disk lives in main/discovery.ts.
 */

/** Which agent's history a candidate was seen in. Opaque ids, not a closed set. */
export type DiscoverySource = 'claude' | 'codex';

export type DiscoveredProject = {
  /** Absolute, symlink-resolved. The identity a candidate is deduplicated on. */
  path: string;
  /** `owner/name` when a recognised remote says so, else the directory name. */
  name: string;
  /** Null when the directory is not a git repository — offered, but ranked below those that are. */
  remote: string | null;
  /** Transcripts seen for this directory. A proxy for "do you actually work here". */
  conversations: number;
  /** Newest transcript timestamp, ms since epoch. */
  lastActiveAt: number;
  /** Already a Wanigan project: shown, never offered for import again. */
  known: boolean;
  sources: readonly DiscoverySource[];
};

export type DiscoveryResult = {
  projects: readonly DiscoveredProject[];
  /** Transcripts actually read. */
  scanned: number;
  /**
   * True when a bound stopped the scan early. The surface must say so: a list
   * that silently omits half a machine's repositories reads as a complete
   * answer, and the operator would never know to look for the rest.
   */
  truncated: boolean;
};

/** A candidate is stale past this, and is not selected for you. */
export const ACTIVE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Below this, one stray session in a directory would preselect it. */
export const MIN_CONVERSATIONS_FOR_DEFAULT = 3;

/**
 * Git repositories first, then newest activity.
 *
 * Not a composite score. Two independent facts decide the order and each is
 * shown beside the row, so a reader can see why something sits where it does —
 * a single blended number would be unexplainable and, per this project's
 * learning-UX rules, is exactly what not to print.
 */
export function rankDiscovered(projects: readonly DiscoveredProject[]): DiscoveredProject[] {
  return [...projects].sort((a, b) => {
    if ((a.remote !== null) !== (b.remote !== null)) return a.remote === null ? 1 : -1;
    if (a.lastActiveAt !== b.lastActiveAt) return b.lastActiveAt - a.lastActiveAt;
    return a.path.localeCompare(b.path);
  });
}

/**
 * What is ticked before anyone touches the list.
 *
 * A default selection is a proposal about somebody's machine, so it stays
 * conservative: a git repository, worked in recently, with enough history to
 * mean it. Everything else is offered unticked rather than hidden — the
 * operator can see it and decide.
 */
export function defaultSelection(
  projects: readonly DiscoveredProject[],
  now: number,
): string[] {
  return projects
    .filter((project) => !project.known
      && project.remote !== null
      && project.conversations >= MIN_CONVERSATIONS_FOR_DEFAULT
      && now - project.lastActiveAt <= ACTIVE_WINDOW_MS)
    .map((project) => project.path);
}

/** How a row explains itself: two observed facts, never a score. */
export function discoveryDetail(project: DiscoveredProject, now: number): string {
  const days = Math.max(0, Math.floor((now - project.lastActiveAt) / (24 * 60 * 60 * 1000)));
  // No "last" prefix: it reads correctly before "today" and then produces
  // "last 2 days ago" for every other row, which a probe caught on screen.
  const when = days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const count = `${project.conversations} ${project.conversations === 1 ? 'conversation' : 'conversations'}`;
  return `${count} · ${when}`;
}

/**
 * `owner/name` from a remote URL, or null when the remote carries no identity.
 *
 * Only a forge-shaped remote names a repository. A managed host often writes a
 * server-side filesystem path instead: Pantheon's is
 * `ssh://…@….drush.in:2222/~/repository.git`, whose last two segments are
 * `~/repository` — which is not a name, and is the *same* non-name for every
 * site on the account. A probe over this machine produced four rows called
 * `~/repository`, so a segment that is a home shorthand or a path traversal
 * disqualifies the slug and the directory name is used instead.
 */
export function repoSlug(remote: string | null): string | null {
  if (!remote) return null;
  const cleaned = remote.replace(/\.git$/, '');
  const scp = /^[^@]+@[^:]+:(.+)$/.exec(cleaned)?.[1];
  const url = /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(cleaned)?.[1];
  const parts = (scp ?? url ?? '').split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const slug = parts.slice(-2);
  if (slug.some((part) => part === '~' || part === '.' || part === '..')) return null;
  return slug.join('/');
}

