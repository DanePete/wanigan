/**
 * What this machine has, and what a new operator still has to do about it.
 *
 * Pure data and one pure function, like routes.ts and palette.ts, so the
 * main-process smoke suite can hold the derivation to account directly. The
 * three states below are the only ones the checklist can render, and the rules
 * that decide them are the whole point of this file: a first-run surface that
 * reports something it cannot observe is worse than one that says nothing,
 * because it sends somebody to fix what was never broken.
 */

/**
 * Evidence of a stored login, and the reason this is not a boolean.
 *
 * `accounts.ts` can find a credential file on Linux, and on macOS it usually
 * cannot: the credential lives in the Keychain, keyed to the configuration
 * directory, and Wanigan neither holds it nor reads it. So `unknown` means
 * exactly "no evidence here", never "not signed in", and nothing downstream may
 * promote it to a failure.
 */
export type SignedIn = 'yes' | 'unknown';

/**
 * Where this profile's credential comes from, which decides whether the
 * harness's login says anything about it at all.
 *
 * GLM, DeepSeek and xAI are the reviewed Claude Code harness pointed at an
 * Anthropic-compatible endpoint: same binary, same configuration directory,
 * entirely different credential. Reading `~/.claude`'s stored login and
 * reporting *them* as signed in is a false claim — a runtime probe caught this
 * surface making exactly that one — so a provider-key profile never inherits
 * the harness login and never appears in the first-run agent count. Its key
 * belongs in Settings, and is deliberately not part of this flow.
 */
export type CredentialSource = 'harness-login' | 'provider-key' | 'unknown';

export type PreflightAgent = {
  /** Provider id, e.g. 'claude'. Opaque: a local pack coins ids this build has never seen. */
  id: string;
  label: string;
  /** The harness whose configuration directory carries the login, when there is one. */
  harnessId: string | null;
  /** The CLI resolved to a path. This is the one thing here that is certain. */
  found: boolean;
  path: string | null;
  /** Null when the binary resolved but would not answer `--version`. Never invented. */
  version: string | null;
  signedIn: SignedIn;
  credential: CredentialSource;
};

/**
 * The agents this surface speaks for: everything except a profile whose
 * credential is a pasted key. Deduplicated by resolved path, because several
 * profiles legitimately share one binary and a newcomer should be told about
 * one Claude Code, not three.
 */
export function countedAgents(agents: readonly PreflightAgent[]): PreflightAgent[] {
  const byPath = new Map<string, PreflightAgent>();
  const out: PreflightAgent[] = [];
  for (const agent of agents) {
    if (agent.credential === 'provider-key') continue;
    const key = agent.path ?? `unresolved:${agent.harnessId ?? agent.id}`;
    if (byPath.has(key)) continue;
    byPath.set(key, agent);
    out.push(agent);
  }
  return out;
}

export type Preflight = {
  agents: readonly PreflightAgent[];
  /**
   * Where Wanigan actually looked. A "not found" that cannot say what it
   * searched is an accusation rather than a report — and these CLIs ship inside
   * editor extensions, so `which claude` returning nothing is expected.
   */
  searched: readonly string[];
  projects: number;
  /** Sessions Wanigan has ever started, from session_log. Derived, never stored. */
  sessionsStarted: number;
};

export type ChecklistItemId = 'agent' | 'project' | 'session';

export type ChecklistItem = {
  id: ChecklistItemId;
  title: string;
  /** Satisfied on observed evidence only. Absence of evidence never sets this. */
  done: boolean;
  /** One sentence stating what was observed, not what is assumed. */
  detail: string;
};

export type InstallHint = {
  /**
   * The vendor's own standalone installer. Deliberately not the npm line: a
   * person who installed Wanigan from a signed app bundle has no reason to own
   * Node, and an install command that fails on `npm: command not found` turns
   * "you need an agent" into "you need a toolchain first".
   */
  command: string;
  /** Homebrew, for a machine that already has it. Null where no cask exists. */
  alternative: string | null;
  url: string;
};

/**
 * Install guidance, transcribed from each vendor's own page and verified live
 * on 10 Sep 2026 — both installer URLs answered 200 with a real shell script,
 * and both casks resolve on formulae.brew.sh. Kept here rather than in the
 * component so there is one place to correct when it goes stale.
 *
 * These commands pipe a downloaded script into a shell, which is the form both
 * vendors document. That is safe to *show* precisely because Wanigan never runs
 * one: the surface copies it to the clipboard and the operator decides. Nothing
 * in this module executes anything, and the smoke suite holds it to that.
 */
export const AGENT_INSTALL: Readonly<Record<string, InstallHint>> = {
  'claude-code': {
    command: 'curl -fsSL https://claude.ai/install.sh | bash',
    alternative: 'brew install --cask claude-code',
    url: 'https://docs.claude.com/en/docs/claude-code/setup',
  },
  codex: {
    command: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    alternative: 'brew install --cask codex',
    url: 'https://developers.openai.com/codex/cli/',
  },
};

/** The install hint for an agent, or null when Wanigan has none to offer. */
export function installFor(agent: PreflightAgent): InstallHint | null {
  return (agent.harnessId && AGENT_INSTALL[agent.harnessId]) || null;
}

/**
 * How to describe one agent in a sentence.
 *
 * A found agent whose login cannot be read still reads as found, because it is:
 * the operator can start a session with it, and the session is what proves the
 * login. Only `found` decides readiness anywhere in this file.
 */
export function agentPhrase(agent: PreflightAgent): string {
  if (!agent.found) return 'not installed';
  const version = agent.version ? ` ${agent.version}` : '';
  const login = agent.signedIn === 'yes' ? 'signed in' : 'sign-in not readable from here';
  return `found${version} · ${login}`;
}

function agentDetail(counted: readonly PreflightAgent[], searched: readonly string[]): string {
  const found = counted.filter((agent) => agent.found);
  // Semicolons between agents: a label can itself contain the middle dot that
  // separates an agent's own facts, and "GLM · Z.ai found … · signed in" read
  // as four fields rather than two.
  if (found.length > 0) return found.map((agent) => `${agent.label} ${agentPhrase(agent)}`).join('; ');
  if (searched.length === 0) return 'No agent CLI found.';
  return `No agent CLI found. Wanigan looked in ${searched.length} `
    + `${searched.length === 1 ? 'place' : 'places'}, including your PATH and editor extensions.`;
}

function projectDetail(count: number): string {
  if (count === 0) return 'Choose a folder to bring your first repository in.';
  return `${count} ${count === 1 ? 'project' : 'projects'} registered.`;
}

/**
 * The precondition is stated here, in text, rather than in a `title` on the
 * disabled button. A native tooltip is unreachable by keyboard and invisible to
 * a finger — this repository says so in five separate comments and then had one
 * anyway, on the one control a first run turns on.
 */
function sessionDetail(count: number, anyAgent: boolean, anyProject: boolean): string {
  if (count > 0) return `${count} ${count === 1 ? 'session' : 'sessions'} started.`;
  if (!anyAgent) return 'Needs an agent first.';
  if (!anyProject) return 'Needs a project first.';
  return 'The only thing that proves the whole path works.';
}

/**
 * The three items, in the order each unblocks the next.
 *
 * Pure and total: every field is a function of the record passed in, so the
 * suite can drive the full cross-product of inputs through it without a window,
 * a clock or a database.
 */
export function checklistFrom(preflight: Preflight): ChecklistItem[] {
  // Only counted agents decide readiness. A machine with a Z.ai key and no
  // Claude Code binary has nothing to run, and must not read as ready.
  const counted = countedAgents(preflight.agents);
  const anyAgent = counted.some((agent) => agent.found);
  return [
    { id: 'agent', title: 'An agent Wanigan can drive', done: anyAgent, detail: agentDetail(counted, preflight.searched) },
    { id: 'project', title: 'A project to work in', done: preflight.projects > 0, detail: projectDetail(preflight.projects) },
    { id: 'session', title: 'A first session', done: preflight.sessionsStarted > 0, detail: sessionDetail(preflight.sessionsStarted, anyAgent, preflight.projects > 0) },
  ];
}

/** True once every item is satisfied, which is when the checklist stops being shown. */
export function preflightComplete(items: readonly ChecklistItem[]): boolean {
  return items.length > 0 && items.every((item) => item.done);
}
