import type { JevMode, JevRead } from './jev.ts';
import type { AccountUsage } from './usage.ts';

// The domain vocabulary every process shares. Plain data only: no I/O, no classes.

export const CARD_TYPES = ['task', 'bug', 'feature', 'idea'] as const;
export type CardType = (typeof CARD_TYPES)[number];

/** Board columns, in order. `archived` is a status but never a column. */
export const COLUMNS = ['inbox', 'ready', 'working', 'review', 'done'] as const;
export const CARD_STATUSES = [...COLUMNS, 'archived'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

/** P0 is most urgent. */
export const PRIORITIES = [0, 1, 2, 3] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PROVIDERS = ['claude', 'codex', 'gemini', 'shell'] as const;
export type Provider = (typeof PROVIDERS)[number];

/**
 * What a session is doing, as far as evidence shows. `running` is the only live
 * state a plain shell can have: without hooks there is nothing to tell working
 * from waiting, and guessing from output would be a false signal. `limited` is
 * an agent stopped by its account's usage limit: still running, but not a
 * finished turn.
 */
export const SESSION_STATES = [
  'starting', 'working', 'waiting', 'permission', 'running', 'ended', 'failed', 'interrupted', 'limited',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];
export const LIVE_STATES: ReadonlySet<SessionState> = new Set(['starting', 'working', 'waiting', 'permission', 'running', 'limited']);

/** `owner`, `session:<id>` or `system`. Stored verbatim in every record. */
export type Actor = string;
export const OWNER: Actor = 'owner';
export const SYSTEM: Actor = 'system';
export const sessionActor = (id: string): Actor => `session:${id}`;
export const actorSessionId = (actor: Actor): string | null =>
  actor.startsWith('session:') ? actor.slice('session:'.length) : null;

export interface Project {
  id: string;
  key: string;
  name: string;
  path: string;
  createdAt: number;
  archivedAt: number | null;
}

export interface ProjectSummary extends Project {
  /** When the owner paused the project; null when running normally. */
  pausedAt: number | null;
  /** The account each agent uses here by default (null: the global default). */
  accounts: Partial<Record<AccountProvider, string>>;
  /** Whether the folder is a git repository. */
  git: boolean;
  /** Card sessions work on their own branch, in their own worktree, by default. */
  isolate: boolean;
  /** Run in each new card worktree as a visible shell session ("npm install"); null for none. */
  setupCommand: string | null;
  /** What Jev does with new cards here. */
  jev: JevMode;
  /** The local model new sessions here start on ("local/lmstudio/<id>"), or null for the agent's own. */
  localModel: string | null;
  counts: Record<(typeof COLUMNS)[number], number>;
  liveSessions: number;
  needsYou: number;
  /** False when the folder is gone or unreadable. Shown, never hidden. */
  pathOk: boolean;
}

export interface Claim {
  sessionId: string;
  expiresAt: number;
  note: string | null;
}

export interface Card {
  id: string;
  projectId: string;
  key: string;
  type: CardType;
  title: string;
  body: string;
  status: CardStatus;
  priority: Priority;
  /** Reopened as "not fixed": the owner pulled it back out of Done. */
  reopened: boolean;
  /** Sent back from Review with changes requested. Cleared on the next submission. */
  sentBack: boolean;
  rank: number;
  createdBy: Actor;
  createdAt: number;
  updatedAt: number;
  /** When the card entered the column it is in. */
  statusAt: number;
  claim: Claim | null;
  /** The card's own branch and checkout, when its sessions work in one. */
  worktree: { path: string; branch: string; base: string } | null;
  /** The pull request opened for the card's branch, when the owner opened one. */
  pullRequest: string | null;
}

export interface CardSummary extends Card {
  progress: { done: number; total: number };
  commentCount: number;
  evidenceCount: number;
  /** The live session attached to this card, if any. */
  live: { sessionId: string; state: SessionState; provider: Provider } | null;
  /** Jev's latest read of the card, if it has one. */
  jev: JevRead | null;
  /** The session holding the claim, whether or not it is running. */
  holder: { sessionId: string; title: string; provider: Provider; state: SessionState } | null;
  /** Questions an agent asked on this card that the owner has not answered. */
  openQuestions: number;
  /** The newest AI review: running, or its verdict. */
  aiReview: 'running' | 'pass' | 'changes' | 'unsure' | 'failed' | null;
}

export interface Criterion {
  id: string;
  cardId: string;
  text: string;
  done: boolean;
  position: number;
}

export interface Comment {
  id: string;
  cardId: string;
  author: Actor;
  body: string;
  /** A question from an agent stays open until the owner replies on the card. */
  kind: 'comment' | 'question';
  resolved: boolean;
  createdAt: number;
}

export const EVIDENCE_KINDS = ['file', 'note', 'link'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface Evidence {
  id: string;
  cardId: string;
  kind: EvidenceKind;
  /** A path for `file`, a URL for `link`, the text for `note`. */
  value: string;
  /** Whether a `file` existed when it was offered. Recorded, not re-checked silently. */
  existed: boolean | null;
  addedBy: Actor;
  createdAt: number;
}

export interface Session {
  id: string;
  projectId: string;
  cardId: string | null;
  /** The key of the card it works on, for showing beside its title. */
  cardKey: string | null;
  provider: Provider;
  accountId: string | null;
  title: string;
  state: SessionState;
  /** What the latest evidence says the session is doing, e.g. "Edit src/app.ts". */
  activity: string | null;
  pid: number | null;
  exitCode: number | null;
  conversationId: string | null;
  /** The agent's own record of that conversation, when its hooks said where (a Codex rollout). */
  transcriptPath: string | null;
  /** The model and effort it was started with; null is the CLI's own default. */
  model: string | null;
  effort: string | null;
  /** Where the session runs: the project folder, or its card's worktree. */
  cwd: string | null;
  /** Started with Claude Code's Remote Control, because the owner asked: reachable from claude.ai and the Claude app. */
  remote: boolean;
  /**
   * The agent's own hooks have reported through Wanigan's relay in this
   * session, so it says itself when a message starts a turn. False for a Codex
   * session read only from its OSC 9 notifications, which say a turn ended but
   * never that one began.
   */
  relayed: boolean;
  /** While asking permission: exactly what, as its hook said. Absent when it did not say. */
  asks?: PermissionAsk[];
  startedAt: number;
  endedAt: number | null;
  lastEventAt: number | null;
  /** While `limited`: since when, and when the account's limit resets (null when unknown). */
  limit: { since: number; resetsAt: number | null } | null;
}

export interface SessionEvent {
  id: number;
  sessionId: string;
  at: number;
  event: string;
  tool: string | null;
  summary: string | null;
  /** The file a tool wrote, when it wrote one. */
  path: string | null;
}

export interface CardDetail extends CardSummary {
  reviews: AiReview[];
  criteria: Criterion[];
  comments: Comment[];
  evidence: Evidence[];
  sessions: Session[];
  activity: Activity[];
}

export interface Activity {
  id: number;
  projectId: string | null;
  cardId: string | null;
  sessionId: string | null;
  actor: Actor;
  verb: string;
  detail: string | null;
  at: number;
}

export interface Decision {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}

/** Ordered most urgent first. The order is the ranking. */
export const NEED_KINDS = ['permission', 'starting', 'overlap', 'limit', 'review', 'failed', 'interrupted', 'quiet', 'question', 'waiting'] as const;
export type NeedKind = (typeof NEED_KINDS)[number];

/**
 * Exactly what a permission request asks to do, from the hook's own payload:
 * the command it would run, the file it would touch. Shown to the owner, who
 * still answers in the terminal.
 */
export interface PermissionAsk {
  tool: string;
  /** What `text` is. */
  what: 'command' | 'path' | 'address' | 'search' | 'plan' | 'input';
  text: string;
  /** Longer than Wanigan keeps: the end was cut. */
  cut: boolean;
}

export interface Need {
  kind: NeedKind;
  projectId: string;
  projectName: string;
  projectKey: string;
  cardId: string | null;
  cardKey: string | null;
  sessionId: string | null;
  /** The agent of the session behind this need, when there is one. */
  provider: Provider | null;
  title: string;
  detail: string | null;
  since: number;
  /** The account the session behind a `limit` need runs as. */
  accountId?: string | null;
  /** A `permission` need's requests, oldest first, when the agent said exactly what it asks. */
  asks?: PermissionAsk[];
  /** A failed or interrupted session whose conversation Wanigan can resume. */
  resumable?: boolean;
}

/** Agents that sign in. A shell has no account. */
export const ACCOUNT_PROVIDERS = ['claude', 'codex'] as const;
export type AccountProvider = (typeof ACCOUNT_PROVIDERS)[number];

/**
 * An account is a configuration folder the agent CLI keeps its login in
 * (CLAUDE_CONFIG_DIR, CODEX_HOME). Wanigan never holds or reads a credential;
 * it asks the CLI who it is signed in as.
 */
export interface Account {
  id: string;
  provider: AccountProvider;
  label: string;
  /** Null for the CLI's own default folder (~/.claude, ~/.codex), which sets no variable. */
  configDir: string | null;
  /** The folder as the owner would type it, for display. */
  displayDir: string;
  isDefault: boolean;
  /** Found on disk rather than created here. Removing it never deletes the folder. */
  discovered: boolean;
  /** 'unknown' is never 'no': on macOS the login lives in the Keychain. */
  signedIn: 'yes' | 'no' | 'unknown';
  /** What the CLI reports: an email, or how it is signed in ("ChatGPT"). */
  identity: string | null;
  plan: string | null;
  checkedAt: number | null;
  /** Whether the agent's CLI is on the login shell's PATH. Every account of an agent shares one CLI. */
  installed: boolean;
  folderOk: boolean;
  /** What is left, as the CLI last reported it; null until read. */
  usage: AccountUsage | null;
  /**
   * Another account folder signed in as the same login, by label. Two folders
   * on one login share one set of limits; they are not two accounts' worth.
   */
  sameLoginAs: string | null;
}

/** A project folder's uncommitted changes, as git reports them. */
export interface ChangedFile {
  path: string;
  /** git's short status: M modified, A added, D deleted, R renamed, ? untracked, U conflicted. */
  status: 'M' | 'A' | 'D' | 'R' | '?' | 'U';
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface Changes {
  git: boolean;
  branch: string | null;
  head: string | null;
  files: ChangedFile[];
  additions: number;
  deletions: number;
  /** Untracked files past the listing cap: counted, not listed. */
  omitted: number;
}

/** Where a past conversation is known from: the CLI's own record, and which Wanigan ran it. */
export type HistorySource = 'claude' | 'codex' | 'wanigan2';

/**
 * One earlier agent conversation in a project's folder (or one of its card
 * worktrees), as the CLI recorded it. Read from disk, never copied.
 */
export interface HistoryItem {
  /** `claude:<conversation id>` or `codex:<thread id>`. */
  id: string;
  provider: AccountProvider;
  conversationId: string;
  /** The CLI's title. Null when it has none. */
  title: string | null;
  /** The first thing the owner typed, clipped. */
  firstPrompt: string | null;
  /** Reserved for compatibility; no external application notes are imported. */
  description: string | null;
  startedAt: number | null;
  updatedAt: number;
  branch: string | null;
  cwd: string | null;
  /** The card whose worktree it ran in, by key, when it ran in one. */
  cardKey: string | null;
  model: string | null;
  /** The account folder the conversation lives in. */
  accountId: string;
  accountLabel: string;
  /** How it was run, when that was not a terminal: "VS Code", "Desktop", "Headless". */
  via: string | null;
  sources: HistorySource[];
  /** The newest Wanigan 2 session that ran this conversation. */
  sessionId: string | null;
  /** A Wanigan 2 session is running it now. */
  live: boolean;
}

export interface HistoryTurn {
  role: 'user' | 'assistant' | 'tool';
  /** Text for a turn; a one-line summary for a tool call. Tool results are never included. */
  text: string;
  at: number | null;
}

export interface HistoryTranscript {
  /** Oldest first. */
  turns: HistoryTurn[];
  /** Older turns were left out to keep the transcript bounded. */
  truncated: boolean;
}

/** A folder the owner's agents have worked in lately, from the CLIs' own records. */
export interface AgentFolder {
  path: string;
  name: string;
  /** Conversations in it in the last `days` days, across every account Wanigan knows. */
  conversations: number;
  /** The newest of them, by when its record was last written. */
  lastAt: number;
  git: boolean;
  agents: AccountProvider[];
}

export interface AgentFolders {
  /** Most conversations first, then most recent. Folders already open, gone, or Wanigan's own are left out. */
  folders: AgentFolder[];
  days: number;
  /** Why the list may be incomplete, when the look was cut short; null when everything in the window was read. */
  cut: string | null;
}

export interface AiReviewCriterion {
  criterion: string;
  met: boolean | null;
  proof: string;
  file: string | null;
  quote: string | null;
  /** Whether Wanigan found the quote in the file; null when none was cited. */
  quoteFound: boolean | null;
}

/** A review Claude Code made of a card, on the owner's request. Advice; it never moves the card. */
export interface AiReview {
  id: string;
  cardId: string;
  accountId: string | null;
  state: 'running' | 'done' | 'failed';
  startedAt: number;
  finishedAt: number | null;
  result: {
    verdict: 'pass' | 'changes' | 'unsure';
    summary: string;
    /** Steps for the owner to see the work themselves. */
    check: string[];
    criteria: AiReviewCriterion[];
    /** Why Wanigan downgraded a pass, if it did. */
    notes: string[];
  } | null;
  /** What the CLI reported it cost; null when it reported nothing. */
  costUsd: number | null;
  error: string | null;
}

/** What opening a pull request for a card's branch would push, and where; `refusal` says why it cannot. */
export interface PullRequestPlan {
  branch: string;
  base: string;
  /** origin's address, or null when there is no origin. */
  remote: string | null;
  /** Commits on the branch that its base does not have. */
  ahead: number;
  title: string;
  refusal: string | null;
}

/** A card Claude Code proposed from a rough note, for the owner to edit before creating. */
export interface CardDraft {
  type: CardType;
  title: string;
  body: string;
  criteria: string[];
  priority: Priority;
  /** One sentence on the priority. */
  why: string;
}
