/** Provider/profile ids come from installable manifests, not a compiled enum. */
export type ProviderId = string;

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  bin: string;
  /** Resolved absolute path, or null when the CLI is not installed. */
  path: string | null;
  version: string | null;
  supports: { model: boolean; effort: boolean; permissionMode: boolean; resume: boolean };
  /** What this installed CLI can actually expose to Wanigan.  Unlike `supports`,
   * this is observation, not a promise made by a provider definition. */
  capabilities: ProviderCapabilities;
  /** Frozen manifest identity used to launch this profile, when pack-backed. */
  packId?: string;
  packVersion?: string;
  /** Exact active profile identity; launchers use it to reject async refresh races. */
  profileFingerprint?: string;
  harnessId?: string;
  backendId?: string;
  launchFields?: ProviderLaunchField[];
};

export type ProviderCapabilities = {
  /** Help text was successfully inspected for this installed binary. */
  probed: boolean;
  hooks: boolean;
  telemetry: boolean;
  mcp: boolean;
  policy: boolean;
  transcript: boolean;
  namedResume: boolean;
  headlessJson: boolean;
  note: string | null;
};

/** Serializable provider-pack records exposed to the renderer. */
export type ProviderPackInfo = {
  id: string;
  name?: string;
  label?: string;
  version: string | null;
  description?: string;
  source?: string;
  root?: string;
  builtIn?: boolean;
  enabled: boolean;
  state?: 'active' | 'enabled' | 'disabled' | 'needs-trust' | 'pending-removal' | 'removed' | 'invalid';
  status?: 'enabled' | 'disabled' | 'needs-trust' | 'pending-removal' | 'removed' | 'invalid';
  error?: string | null;
  errors?: string[];
  manifestSha256?: string | null;
  trustedManifestSha256?: string | null;
  adapterSha256?: string | null;
  trustedAdapterSha256?: string | null;
  pendingActiveProfileIds?: string[];
  removedAt?: number | null;
  recoverable?: boolean;
  adapter?: {
    path: string;
    sha256: string;
    trusted: boolean;
    executable: boolean;
  } | null;
  profiles?: ProviderProfileInfo[];
  [key: string]: unknown;
};

export type ProviderProfileInfo = {
  id: string;
  packId: string;
  packVersion?: string;
  label: string;
  description?: string;
  harness: string;
  backendId: string;
  bin: string;
  enabled: boolean;
  supports: { model: boolean; effort: boolean; permissionMode: boolean; resume: boolean };
  capabilities?: Record<string, boolean | string | null>;
  launchFields?: ProviderLaunchField[];
  [key: string]: unknown;
};

export type ProviderManifestInspection = {
  packId: string;
  label: string;
  version: string | null;
  sha256: string | null;
  publisher: string | null;
  adapter: { executable: string; args: string[]; sha256: string | null } | null;
  commands: Array<{
    profileId: string;
    profileLabel: string;
    harness: string;
    headless: string;
    declaredBackendId: string;
    backendId: string;
    bin: string;
    baseArgs: string[];
    versionArgs: string[];
    helpArgs: string[];
    launchFields: Array<{
      id: string;
      label: string;
      kind: string;
      argv: string[];
      trueArgv: string[];
      falseArgv: string[];
    }>;
    resume: { conversationArgs: string[]; continueArgs: string[] } | null;
    fallbackPaths: string[];
    editorExtensions: Array<{ prefix: string; executablePaths: string[] }>;
    environment: Array<{
      name: string;
      source: 'literal' | 'process' | 'credential';
      value: string | null;
      processName: string | null;
      fallback: string | null;
      credentialId: string | null;
    }>;
    credentialIds: string[];
  }>;
  warning: string;
};

/** One offerable model. `efforts` is null when nothing said which the model takes. */
export type LaunchModelRow = {
  value: string;
  label: string;
  description: string | null;
  efforts: string[] | null;
};

/**
 * What a model picker may honestly offer, and where it came from.
 *
 * `source` is the provenance of `rows`, and it is never rounded up:
 * `declared` — the profile's own manifest said so; `live` — the backend was
 * asked and answered; `published` — Wanigan's own list, because the backend
 * cannot be asked or would not answer, and `note` says so; `none` — nothing
 * could be established, which is not the same as "this profile has no models".
 */
export type LaunchModelCatalogue = {
  rows: LaunchModelRow[];
  source: 'declared' | 'live' | 'published' | 'none';
  /** Why this list is what it is, when that is not obvious. Shown to the operator. */
  note: string | null;
};

export type ProviderLaunchField = {
  id: string;
  label: string;
  kind: 'text' | 'select' | 'boolean' | 'secret';
  required?: boolean;
  description?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string | boolean;
  /**
   * Whether a select accepts a value it did not list. The manifest schema has
   * carried this since packs landed and the launch compiler already enforces
   * it; it simply never reached the renderer, so a picker had no way to tell a
   * closed set from a suggested one and rendered every select as closed.
   */
  allowCustom?: boolean;
};

/** Effort levels the Claude Code CLI accepts. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Permission modes the Claude Code CLI accepts. */
export const PERMISSION_MODES = ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;

export type Project = {
  id: string;
  path: string;
  name: string;
  /** Set when the directory is a git repo. */
  branch: string | null;
  addedAt: number;
};

export type SessionStatus = 'starting' | 'running' | 'exited';

export type Session = {
  id: string;
  providerId: ProviderId;
  projectId: string;
  projectPath: string;
  projectName: string;
  title: string;
  status: SessionStatus;
  pid: number | null;
  exitCode: number | null;
  createdAt: number;
  endedAt: number | null;
  /**
   * Owned by the main process. Incremented at most once a second while the
   * session is producing output and is not the one on screen — so it counts
   * SECONDS IN WHICH OUTPUT ARRIVED, not messages and not chunks. Zeroed when
   * the session becomes the focused one, and on `sessions:markRead`. The two
   * surfaces that render it say so in words, because a bare integer beside a
   * chat-shaped list is read as a message count.
   */
  unread: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /**
   * The account this session actually launched under, frozen at launch.
   *
   * Frozen rather than resolved on read: the project's default can change while
   * a session is running, and a badge that followed the current setting would
   * relabel a live session as an account it never authenticated with. Absent
   * when no account applied, such as a profile pointed at another vendor.
   */
  accountId?: string | null;
  accountLabel?: string | null;
  /**
   * A fact about the account decision the badge should say out loud — today,
   * that a resumed conversation was recorded before Wanigan tracked accounts,
   * so the account it was started under is unknown. Absent when nothing needs
   * saying.
   */
  accountNote?: string | null;
  /** How the docket goal capsule reached this session, when one was requested. */
  goalCapsule?: GoalCapsuleDelivery | null;
  /** Repo state at launch — lets the code panel show only this session's work. */
  baseline?: Baseline;
  /**
   * The launch snapshot as the session LIST carries it: the head commit and how
   * many paths were already dirty, never the paths themselves.
   *
   * `baseline.dirty` holds one string per file that was already modified when
   * the session started — 84 in this repository, thousands in a monorepo — and
   * three independent pollers re-serialise the whole session list every few
   * seconds. The list reports the count; `sessions:baseline` returns the paths
   * when the code panel actually needs them. Absent means no snapshot was
   * captured, exactly as an absent `baseline` does.
   */
  baselineSummary?: { head: string | null; dirtyCount: number; at: number };
  /** The agent's own conversation id, so this exact session can be resumed. */
  conversationId?: string | null;
  /** Set when the session runs in its own worktree rather than the repo itself. */
  worktree?: string | null;
  /** What this project's agents are permitted to do. */
  trust?: TrustLevel;
  /** Capability snapshot at launch, so history does not reinterpret an old
   * session through a newer CLI installation. */
  capabilities?: ProviderCapabilities;
  /** The user-facing name: renamed by hand, or derived from the launch prompt. */
  displayTitle?: string | null;
  /** Exact pack/profile snapshot; later pack upgrades do not reinterpret it. */
  providerPackId?: string | null;
  providerPackVersion?: string | null;
  providerProfile?: ProviderProfileInfo | null;
  backendId?: string | null;
  harnessId?: string | null;
};

export type LaunchOptions = {
  providerId: ProviderId;
  projectId: string;
  /** Model alias ('opus', 'sonnet', 'fable') or a full id. Empty = the CLI default. */
  model?: string;
  /** low | medium | high | xhigh | max. Empty = no --effort is passed, so the CLI's own default runs; Wanigan does not read what that default is. */
  effort?: string;
  /** acceptEdits | auto | bypassPermissions | manual | dontAsk | plan */
  permissionMode?: string;
  /** Extra CLI flags, split on whitespace. */
  extraArgs?: string;
  /** Values for manifest-defined launch fields. They become argv entries, never shell text. */
  providerOptions?: Record<string, string | boolean>;
  /** Initial prompt typed into the session once it is ready. */
  initialPrompt?: string;
  /** Resume a previous conversation instead of starting a new one. */
  resumeFrom?: { sessionId: string; conversationId: string | null };
  /** Run in a dedicated git worktree so parallel agents stop overwriting each other. */
  isolate?: boolean;
  /** Which agent account to launch as. Omitted uses the project's, then the default. */
  accountId?: string | null;
  /**
   * Set only by Control when the session runs a docket node. Delivered as
   * instructions, recorded as a work-trace row, never mutated by the renderer.
   */
  goalCapsule?: GoalCapsule;
};

/** A finished session, recoverable after a quit. */
export type PastSession = {
  id: string;
  conversationId: string | null;
  providerId: ProviderId;
  projectId: string | null;
  projectPath: string;
  projectName: string;
  /** Original isolated checkout, when this conversation has one. */
  worktree: string | null;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  /** Number of execution records folded into this one resumable conversation. */
  continuationCount: number;
  /** True when the project directory still exists. */
  live: boolean;
  /** Pinned to the top of Recent; the stamp orders the pinned section. */
  pinnedAt: number | null;
  /** Parked in the Settled shelf; history and evidence stay intact. */
  settledAt: number | null;
  /** The user-facing name; null falls back to the project name. */
  title: string | null;
};

/** What the repo looked like when a session started, so its own work is separable. */
export type Baseline = { head: string | null; dirty: string[]; at: number };

export type SessionOutput = { sessionId: string; data: string };
export type CacheTtl = '5m' | '1h';

export type SystemBlock = {
  text: string;
  /** Marks this block with cache_control. Cached prefix must be identical across every request. */
  cache: boolean;
};

export type SourceConfig =
  | { kind: 'csv'; text: string; delimiter?: string }
  | { kind: 'jsonl'; text: string }
  | { kind: 'glob'; root: string; pattern: string; maxBytes?: number }
  /** An explicit list of files — what a session hands over when it sends its changes. */
  | { kind: 'files'; root: string; paths: string[]; maxBytes?: number }
  | { kind: 'command'; cwd: string; command: string; format: 'csv' | 'jsonl' };

export type RunConfig = {
  name: string;
  preset?: string;
  /** The project this run targets — the same project list the Sessions view uses. */
  projectId?: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  system: SystemBlock[];
  userTemplate: string;
  /** Column used to make custom_ids human-readable. Results come back unordered. */
  keyColumn?: string;
  cacheTtl: CacheTtl;
  extendedOutput?: boolean;
  /** output_config.effort — the single biggest cost lever. Omit for the API default (high). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Adaptive thinking. `summarized` returns a readable summary of the reasoning. */
  thinking?: 'off' | 'adaptive';
  thinkingDisplay?: 'omitted' | 'summarized';
  /** JSON Schema string for structured outputs. */
  schemaJson?: string;
  source: SourceConfig;
};

export type RunRow = {
  id: string;
  name: string;
  preset: string | null;
  model: string;
  status: 'draft' | 'submitting' | 'in_progress' | 'canceling' | 'ended' | 'failed';
  config_json: string;
  total_requests: number;
  est_input_tokens: number;
  est_output_tokens: number;
  est_cost_usd: number;
  in_tokens: number;
  out_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
  parent_run_id: string | null;
  error: string | null;
  created_at: number;
  submitted_at: number | null;
  ended_at: number | null;
};

export type BatchRow = {
  id: string;
  run_id: string;
  chunk_index: number;
  processing_status: string;
  request_count: number;
  counts_json: string | null;
  results_url: string | null;
  results_ingested_at: number | null;
  created_at: number;
  expires_at: number | null;
  ended_at: number | null;
  cancel_initiated_at: number | null;
  last_polled_at: number | null;
  poll_interval_ms: number;
};

export type Counts = {
  processing: number; succeeded: number; errored: number; canceled: number; expired: number;
};

export const EMPTY_COUNTS: Counts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };

/** A model as reported by GET /v1/models, plus locally-held pricing. */
export type ModelInfo = {
  id: string;
  label: string;
  createdAt: string | null;
  maxInputTokens: number | null;
  maxTokens: number;
  supportsBatch: boolean;
  supportsStructuredOutputs: boolean;
  supportsCitations: boolean;
  /** Effort levels this model accepts, in order: low, medium, high, xhigh, max. */
  efforts: string[];
  thinkingAdaptive: boolean;
  thinkingEnabled: boolean;
  /** Batch rates, $/MTok. Null when the model is newer than our pricing table. */
  batchInput: number | null;
  batchOutput: number | null;
  extendedOutput: boolean;
  pricingKnown: boolean;
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/* ════════════════════════════════════════════════════════════════════════
   Phases 1–20. Everything below is the contract the feature modules
   implement against; the hot shared files (sessions, index, preload) are
   written once here rather than edited by each feature in turn.
   ════════════════════════════════════════════════════════════════════════ */

/* ── P1 · telemetry ─────────────────────────────────────────────────── */

/**
 * What a Claude Code process reports about itself over OTLP. Wanigan spawns
 * the CLI, so it sets the exporter env and receives this on loopback — no
 * wrapper, no proxy, no transcript parsing.
 */
export type SessionUsage = {
  sessionId: string;
  costUsd: number;
  /**
   * Whether `costUsd` is an amount the provider actually reported.  Codex on
   * a ChatGPT plan reports token counters but not a per-thread invoice, so a
   * zero there must render as "not reported", never "$0.00".
   */
  costStatus: 'reported' | 'unavailable';
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  linesAdded: number;
  linesRemoved: number;
  commits: number;
  pullRequests: number;
  activeSeconds: number;
  requests: number;
  errors: number;
  refusals: number;
  /** Wall-clock of the most recent datapoint, so staleness is visible. */
  lastAt: number | null;
  /** Models seen on this session's requests, most-used first. */
  models: string[];
};

export const EMPTY_USAGE: Omit<SessionUsage, 'sessionId'> = {
  costUsd: 0, costStatus: 'reported', inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
  linesAdded: 0, linesRemoved: 0, commits: 0, pullRequests: 0,
  activeSeconds: 0, requests: 0, errors: 0, refusals: 0, lastAt: null, models: [],
};

/** One `claude_code.api_request` event — the per-turn cost record. */
export type ApiEvent = {
  sessionId: string;
  at: number;
  model: string | null;
  costUsd: number;
  durationMs: number | null;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  effort: string | null;
  kind: 'request' | 'error' | 'refusal';
  detail: string | null;
};

/* ── P2 · hook bus ──────────────────────────────────────────────────── */

export const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PostToolUseFailure', 'PermissionRequest', 'PermissionResponse', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'FileChanged',
  'SubagentStart', 'SubagentStop',
  // Fires when a CLAUDE.md or .claude/rules/*.md file enters context (Claude
  // Code changelog 2.1.69; present in the 2.1.261 binary). hooks.ts asks for it
  // only from a CLI whose reported version is at least that, because the CLI
  // rejects a whole settings file over one unknown event name.
  'InstructionsLoaded',
  // Fires after the session's model changes, including a change Wanigan did not
  // ask for: an operator typing /model into the terminal, or the CLI falling
  // back on its own. Same version gate and the same reason as the line above.
  'PostModelSwitch',
  // Where the session is allowed to reach, changing under Wanigan: a cd, an
  // /add-dir, a settings file edited mid-run.
  'CwdChanged', 'DirectoryAdded', 'ConfigChange',
  // An MCP server asking the operator a question, and the answer. This is a
  // blocked session by any other name, which is why liveState treats the first
  // as an outstanding question and the second as what settles it.
  'Elicitation', 'ElicitationResult',
  // Agent teams and their task list.
  'TeammateIdle', 'TaskCreated', 'TaskCompleted',
  // Worktrees the CLI made for itself, which are not the ones worktrees.ts owns.
  'WorktreeCreate', 'WorktreeRemove',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** The documented `load_reason` values of an InstructionsLoaded hook (docs/en/hooks). */
export const INSTRUCTION_LOAD_REASONS = [
  'session_start', 'nested_traversal', 'path_glob_match', 'include', 'compact',
] as const;

/** The JSON a hook handler posts to Wanigan's loopback listener. */
export type HookInput = {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  duration_ms?: number;
  agent_id?: string;
  agent_type?: string;
  message?: string;
  /** InstructionsLoaded only: the instruction file that entered context. */
  file_path?: string;
  /** InstructionsLoaded only: which memory slot the file filled (user, project, …). */
  memory_type?: string;
  /** InstructionsLoaded only: why it loaded — one of INSTRUCTION_LOAD_REASONS, or a value a newer CLI adds. */
  load_reason?: string;
  /** PostModelSwitch only: the model the session was running before the change. */
  from_model?: string;
  /** PostModelSwitch only: the model it is running now. This is the observed fact. */
  to_model?: string;
  /**
   * Why something happened, spelled differently by each event that carries it:
   * PostModelSwitch uses command/picker/sdk/auto/resume, DirectoryAdded uses
   * slash_command/register_repo_root, and ConfigChange names the settings layer
   * that changed. One field because it is one string in every one of them.
   */
  source?: string;
  /** CwdChanged: where the session was, and where it is now. */
  old_cwd?: string;
  new_cwd?: string;
  /** DirectoryAdded: the absolute path added. The docs call this directory_path; the CLI sends `directory`. */
  directory?: string;
  /** Elicitation and ElicitationResult: which MCP server asked. */
  mcp_server_name?: string;
  /** ElicitationResult only: accept, decline or cancel. */
  action?: string;
  /** TeammateIdle, TaskCreated and TaskCompleted: which teammate. */
  teammate_name?: string;
  /** TaskCreated and TaskCompleted: the task's id and one-line subject. */
  task_id?: string;
  task_subject?: string;
  /** WorktreeCreate: the worktree's name — this event carries a name, not a path. */
  name?: string;
  /** WorktreeRemove: the path being removed. */
  worktree_path?: string;
  /** Wanigan's own session id, carried through the generated hook config. */
  wanigan_session_id?: string;
};

/**
 * One InstructionsLoaded row, read back from session_events. The path is the
 * stored fact; memory type and load reason are decoded from the row summary and
 * are null when the CLI omitted them.
 */
export type LoadedInstruction = {
  sessionId: string;
  at: number;
  path: string;
  memoryType: string | null;
  loadReason: string | null;
};

/**
 * The static CLAUDE.md prediction laid beside what one session's
 * InstructionsLoaded hooks reported. `observed` is null for a predicted file
 * no hook named; `predicted` is null for a file a hook named that the scan did
 * not foresee. Neither null is an error: the prediction is from disk now, the
 * observation is from a launch then.
 */
export type InstructionReconciliation = {
  sessionId: string;
  /** When the newest InstructionsLoaded row for this session arrived. */
  at: number;
  rows: {
    path: string;
    predicted: 'launch' | 'on-demand' | null;
    /** 'launch' for session_start, 'lazy' for every other load reason. */
    observed: 'launch' | 'lazy' | null;
    loadReason: string | null;
    memoryType: string | null;
  }[];
  predictedOnly: number;
  observedOnly: number;
};

/** A hook event as stored — the durable record behind the timeline. */
export type SessionEvent = {
  id: number;
  sessionId: string;
  at: number;
  event: HookEventName | string;
  toolName: string | null;
  /** Short human summary: the command, the file, the notification text. */
  summary: string | null;
  durationMs: number | null;
  ok: boolean | null;
  /** Files this event touched, when it touched any. */
  paths: string[];
};

/* ── per-turn checkpoints ───────────────────────────────────────────── */

export const CHECKPOINT_KINDS = ['session-start', 'turn-start', 'turn-end', 'session-end', 'pre-revert'] as const;
export type CheckpointKind = (typeof CHECKPOINT_KINDS)[number];

/**
 * One captured working-tree snapshot, stored as a hidden git commit reachable
 * from refs/wanigan/checkpoints/<session>. No prompt or model output is
 * stored here — a checkpoint is repo state plus when and why it was taken.
 */
export type SessionCheckpoint = {
  id: number;
  sessionId: string;
  /** 0 for the launch snapshot, then the 1-based turn the boundary belongs to. */
  turn: number;
  kind: CheckpointKind | string;
  at: number;
  repoRoot: string;
  commitHash: string | null;
  treeHash: string | null;
  /** Paths changed since the previous checkpoint; null when unknowable. */
  filesChanged: number | null;
  status: 'ok' | 'failed' | 'skipped-unchanged';
  detail: string | null;
};

export type CheckpointDiffFile = { path: string; status: string };
export type CheckpointDiff = {
  from: string;
  to: string;
  files: CheckpointDiffFile[];
  totalFiles: number;
  patch: string;
  truncated: boolean;
};

export type CheckpointRevertAction = { path: string; action: 'restore' | 'delete' };
export type CheckpointRevertPlan = {
  ok: boolean;
  checkpointId: number;
  commit: string | null;
  files: CheckpointRevertAction[];
  totalFiles: number;
  detail: string;
};
export type CheckpointRevertResult = {
  ok: boolean;
  reverted: number;
  deleted: number;
  failed: { path: string; detail: string }[];
  /** The safety snapshot taken before anything moved, so a revert is undoable. */
  preRevertCheckpointId: number | null;
  detail: string;
};

/* ── P3 · attention ─────────────────────────────────────────────────── */

/** Ordered worst-first; the queue sorts on this. */
export const ATTENTION_ORDER = ['permission', 'error', 'finished', 'idle', 'working'] as const;
export type AttentionKind = (typeof ATTENTION_ORDER)[number];

export type Attention = {
  sessionId: string;
  kind: AttentionKind;
  /** Stable identity for this exact state transition, used for notification dedupe. */
  transitionId: string;
  /** When the session entered this state. */
  since: number;
  /** Word — never hue alone. Pairs with a glyph in the UI. */
  label: string;
  detail: string | null;
  /** The tool currently in flight, if one is. */
  tool: string | null;
};

/* ── P4 · transcripts ───────────────────────────────────────────────── */

export type TranscriptHit = {
  sessionId: string;
  projectName: string;
  projectPath: string;
  providerId: ProviderId;
  startedAt: number;
  /** Matched excerpt with the query term in context. */
  snippet: string;
  role: 'user' | 'assistant';
  at: number;
};

export type TranscriptTurn = {
  at: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  toolName?: string;
};

/**
 * What the opt-in `wanigan_recall_transcripts` MCP tool returns to a session.
 *
 * Scoped to the caller's own project, frozen backend and frozen account, so a
 * GLM session cannot read Claude transcripts, and a work-account session cannot
 * read the personal account's. Snippets pass through credential redaction.
 */
export type TranscriptRecall =
  | {
    kind: 'ok';
    scope: { projectId: string; harnessId: string; backendId: string | null; accountId: string | null };
    /** Archived sessions inside the scope, before the query is applied. */
    archivedSessions: number;
    hits: { sessionId: string; title: string | null; startedAt: number; role: 'user' | 'assistant'; at: number; snippet: string }[];
    note: string | null;
  }
  | { kind: 'disabled'; note: string }
  | { kind: 'unsupported'; harnessId: string | null; note: string };

/* ── P7 · fleet ─────────────────────────────────────────────────────── */

export type FleetCard = {
  session: Session;
  usage: SessionUsage;
  attention: Attention;
  /** Token throughput samples for the sparkline, oldest first. */
  throughput: number[];
  worktree: string | null;
};

/* ── read-only phone monitor ────────────────────────────────────────── */

/** A fleet card with every local-control and content-bearing field removed. */
export type MobileFleetSession = {
  /** Opaque rendering key only; no remote action accepts it. */
  id: string;
  /**
   * Which login this session is signed in as, so an operator with a work and a
   * personal Claude account can tell them apart from the phone. An identity and
   * nothing more: `id` is opaque and `label` is the same word the desktop
   * prints. The account's config directory — the thing that actually selects
   * the login, and the only part worth stealing — deliberately never crosses.
   * `id: null` means no account applied, which is different from an account
   * that has since been removed.
   */
  account?: { id: string | null; label: string };
  projectName: string;
  title: string;
  providerId: ProviderId;
  model: string | null;
  status: SessionStatus;
  createdAt: number;
  endedAt: number | null;
  attention: Pick<Attention, 'kind' | 'label' | 'since'>;
  usage: Pick<SessionUsage,
    'costUsd' | 'costStatus' | 'inTokens' | 'outTokens' | 'linesAdded' | 'linesRemoved' |
    'requests' | 'errors' | 'lastAt'>;
};

export type MobileFleetSnapshot = {
  generatedAt: number;
  host: string;
  version: string;
  totals: {
    sessions: number;
    running: number;
    permission: number;
    error: number;
    finished: number;
    idle: number;
    working: number;
    costUsd: number;
    /** At least one live session supplied tokens but no billable dollar amount. */
    costUnavailable: boolean;
    inTokens: number;
    outTokens: number;
    linesAdded: number;
    linesRemoved: number;
    requests: number;
    errors: number;
  };
  sessions: MobileFleetSession[];
};

export type MobileMonitorConfig = {
  dashboardEnabled: boolean;
  /** Enables paired iPad controls; this is separate from the read-only dashboard. */
  remoteControlEnabled: boolean;
  port: number;
  /** Tailnet HTTPS URL (or another private reverse proxy) used for deep links. */
  dashboardUrl: string;
  pushEnabled: boolean;
  pushServer: string;
  /** A random ntfy topic acts as the subscription credential. */
  pushTopic: string;
};

export type MobileMonitorStatus = {
  config: MobileMonitorConfig;
  running: boolean;
  localUrl: string;
  pairingUrl: string;
  /** Time-limited code for pairing a Home Screen app without copying a bearer URL. */
  pairingCode: string;
  tokenFingerprint: string;
  error: string | null;
  lastPushAt: number | null;
  lastPushError: string | null;
};

/**
 * What Wanigan observed about Tailscale for the loopback port the phone monitor
 * listens on. Five states because each one is a different next action — install
 * Tailscale, sign in to Tailscale, start serving, open this URL, and read what
 * went wrong — and a boolean plus a message would let the panel offer the wrong
 * one. Nothing here is inferred from a path existing: every state is the result
 * of a probe that exited.
 */
export type TailnetStatus = { port: number; checkedAt: number } & (
  /** No tailscale CLI at any known location or on PATH. */
  | { state: 'absent' }
  /**
   * The CLI answered but the daemon is not connected, so Serve cannot run. The
   * raw BackendState travels with the sentence: 'waiting for admin approval' is
   * not 'not signed in', and sending one operator to the other's fix wastes the
   * only move they have.
   */
  | { state: 'logged-out'; backendState: string; message: string }
  /** Connected, with nothing serving our port yet. Wanigan can start it. */
  | { state: 'ready'; magicDnsName: string | null }
  | {
    state: 'serving';
    /** Read back from the serve configuration, never assembled from a hostname. */
    url: string;
    magicDnsName: string | null;
    /** True means Funnel is on for this mount: the URL is public, not tailnet-only. */
    funnel: boolean;
    /** False when a foreground `tailscale serve` owns it, which Wanigan cannot stop. */
    background: boolean;
  }
  /** The probe itself failed; the message is the CLI's, never a guess. */
  | { state: 'error'; message: string }
);

/**
 * Why Wanigan is holding this Mac awake. Both conditions can be true at once
 * and they stop being true independently, so 'both' is a state of its own: a
 * panel that collapsed it would announce a release when only half the reason
 * went away.
 */
export type AwakeReason = 'sessions' | 'dashboard' | 'both';

/**
 * What Wanigan is doing to this Mac's power management right now.
 *
 * Reported rather than assumed, because an app that quietly keeps a laptop
 * awake drains a battery its owner believes is idle. `held` is read back from
 * the blocker Electron actually holds, never set from the fact that one was
 * requested, and `reason` and `since` are null whenever `held` is false — so no
 * screen can describe a hold that did not happen. `error` carries why a wanted
 * hold could not be taken.
 *
 * `onBattery` is the one thing software cannot fix and the reason it travels
 * here at all. A power-save blocker stops the machine idling to sleep; it does
 * not stop a closed lid on battery from suspending. A screen that promises
 * overnight work has to say which of those two situations the operator is in.
 * False is also what an unreadable power source reports: warning someone about
 * a battery Wanigan could not actually ask about would be inventing the one
 * fact they are most likely to act on.
 */
export type AwakeState = {
  /** True only while Electron still reports the blocker started. */
  held: boolean;
  /** Non-null only while `held` — see the note above. */
  reason: AwakeReason | null;
  /** Live agents at the last reconcile: interactive PTYs plus headless rows. */
  sessions: number;
  /** When the current hold began, or null when nothing is held. */
  since: number | null;
  /** True only when Wanigan read the power source and it said battery. */
  onBattery: boolean;
  /** Bounded reason a wanted hold could not be taken, or null. */
  error: string | null;
};

/* ── P9 · worktrees ─────────────────────────────────────────────────── */

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  /** The repo this worktree belongs to. */
  repoRoot: string;
  /** Null when Wanigan has no session for it — an orphan from a crash. */
  sessionId: string | null;
  /** Uncommitted files, so "discard" can warn before destroying work. */
  dirty: number;
  ahead: number;
  /** Gitignored paths linked back to the main checkout — vendor, node_modules, .env. */
  linked?: { path: string; kind: 'dir' | 'file'; bytes: number | null }[];
};

/* ── P10 · headless runs ────────────────────────────────────────────── */

export type HeadlessConfig = {
  name: string;
  providerId: ProviderId;
  /** One agent per project — this is the fan-out. */
  projectIds: string[];
  prompt: string;
  model?: string;
  effort?: string;
  /** Values for manifest-defined launch fields. They become argv entries, never shell text. */
  providerOptions?: Record<string, string | boolean>;
  /** Passed to the CLI's own budget flag, not enforced by wrapping. */
  maxBudgetUsd: number;
  /** Wall-clock ceiling per repo. */
  timeoutMs: number;
  /** Worktree per repo, so a headless fleet never fights the working tree. */
  isolate: boolean;
};

/**
 * A fan-out request as it crosses IPC.
 *
 * `allProjects` is the operator saying "yes, every repository I have
 * registered" out loud. A payload that simply leaves the repository out arrives
 * at the runner looking identical to that choice, so headless.ts refuses a
 * selection covering the whole project list unless this is set. It is not a
 * size limit: naming three of twenty repositories needs nothing here.
 */
export type HeadlessStartRequest = HeadlessConfig & { allProjects?: boolean };

export type HeadlessRow = {
  runId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  status: 'pending' | 'running' | 'succeeded' | 'errored' | 'timeout' | 'canceled' | 'blocked';
  costUsd: number;
  /**
   * Whether the CLI named a cost at all. `costUsd` cannot answer this: a run
   * that reported nothing is stored as 0, exactly like one that reported
   * $0.00. `null` for rows written before the column existed — unknown, which
   * a total must treat as "not reported", never as reported.
   */
  costReported: boolean | null;
  durationMs: number | null;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  filesChanged: number;
  worktree: string | null;
  startedAt: number | null;
  endedAt: number | null;
};

/**
 * A fan-out row as the LIST channel sends it.
 *
 * Measured: `headless:rows` selects every column, maps the agent's full stdout
 * into each row, and the run view refires it every three seconds. Twenty
 * repositories at 50KB of output apiece is roughly 20MB a minute across IPC to
 * paint a status table that shows none of it. The text stays in SQLite until a
 * row is expanded and `headless:rowDetail` asks for that one row.
 */
export type HeadlessRowSummary = Omit<HeadlessRow, 'output' | 'error'> & {
  /** Never carried here; `headless:rowDetail` returns it. */
  output: null;
  /** Never carried here either — a stack trace is not list material. */
  error: null;
  /** So a row can offer the expander without shipping what is behind it. */
  hasOutput: boolean;
  hasError: boolean;
};

export type HeadlessRowDetail = {
  runId: string;
  projectId: string;
  output: string | null;
  error: string | null;
};

export type HeadlessRun = {
  id: string;
  name: string;
  model: string;
  status: 'submitting' | 'in_progress' | 'ended' | 'failed';
  costUsd: number;
  /** How complete `costUsd` is. Shares its vocabulary with the Usage screen. */
  costStatus: 'reported' | 'partial' | 'unreported';
  totalRequests: number;
  createdAt: number;
  submittedAt: number | null;
  endedAt: number | null;
  error: string | null;
  succeeded: number;
  failed: number;
  blocked: number;
  open: number;
  filesChanged: number;
};

export type ReviewRecipe = { projectId: string; commands: string[]; updatedAt: number | null };
export type ReviewRun = {
  id: string; projectId: string; startedAt: number; endedAt: number | null;
  status: 'running' | 'passed' | 'failed';
  results: { command: string; exitCode: number | null; output: string; durationMs: number }[];
};

/* ── P30 · durable agent control plane ─────────────────────────────── */

/** A Docket is the human-owned contract for a piece of agent work. */
export type DocketStatus = 'draft' | 'executing' | 'review' | 'accepted' | 'rejected' | 'blocked';
export type DocketRisk = 'low' | 'elevated' | 'high';
export type DocketNodeKind = 'plan' | 'implement' | 'verify' | 'review';
export type DocketNodeStatus = 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'canceled' | 'blocked';

export type WorkDocket = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  objective: string;
  acceptance: string[];
  risk: DocketRisk;
  budgetUsd: number | null;
  baseCommit: string | null;
  status: DocketStatus;
  createdAt: number;
  updatedAt: number;
  autopilot: DocketAutopilot;
};

/**
 * Unattended dispatch for one docket.
 *
 * `spendUsd` counts only what a provider actually reported. `spendStatus` says
 * how much of the docket that covers, because a cap enforced against a
 * partially reported total is a weaker promise than it looks, and the surface
 * has to be able to say which one it is showing.
 */
export type DocketAutopilot = {
  enabled: boolean;
  providerId: string | null;
  model: string | null;
  budgetUsd: number | null;
  spendUsd: number;
  spendStatus: 'reported' | 'partial' | 'unreported' | 'none';
  /**
   * Why the last automatic halt happened, with the halt prefix already
   * removed, or null if this docket has never stopped itself. It is a typed
   * field rather than a summary string so no surface has to parse a sentence
   * to find out whether the cap, a missing provider or a missing budget ended
   * the run. It outlives the halt on purpose: re-arming does not erase the
   * evidence, so `enabled` says what is running now and this says what last
   * stopped, which is the pair an operator needs to decide whether to re-arm.
   */
  haltedReason: string | null;
  /** When that halt was recorded, or null if there has never been one. */
  haltedAt: number | null;
};

/**
 * One node in a proposed task graph, before the docket exists.
 *
 * Dependencies are indices into the same array rather than ids, because the
 * ids do not exist yet. The main process validates the whole shape — range,
 * cycles, the terminal review node and claim overlap — before writing a row.
 */
export type DocketPlanNode = {
  kind: DocketNodeKind;
  title: string;
  instructions: string;
  /** Indices into the plan array this node waits on. */
  dependsOn?: number[];
  /** Project-relative path this node intends to own while it runs. */
  claimPath?: string | null;
};

/**
 * The four task kinds, as a runtime list beside the union.
 *
 * Validation in the main process interpolates this array straight into the
 * refusal a planner reads, so the order is part of the message. Anything that
 * offers the choice reads the same four words from here rather than retyping
 * them and quietly gaining a fifth.
 */
export const DOCKET_NODE_KINDS: readonly DocketNodeKind[] = ['plan', 'implement', 'verify', 'review'];

/** A docket is one reviewable contract. Past this, split it. */
export const MAX_DOCKET_PLAN_NODES = 40;
export const MAX_DOCKET_NODE_DEPENDENCIES = 16;

/**
 * The shape a docket gets when nobody proposed a graph.
 *
 * It is the same four phases Control always created, expressed as a plan so
 * there is exactly one code path that writes nodes. A planner that proposes
 * something richer is validated by the same rules this passes trivially.
 *
 * It sits in shared rather than in the main process because the renderer's
 * plan editor seeds a new graph from this same array. A second copy of the
 * instruction text would read as identical and then drift, and the operator
 * would be editing phases that are not the ones main would have written.
 */
export const DEFAULT_DOCKET_PLAN: readonly DocketPlanNode[] = [
  { kind: 'plan', title: 'Plan and identify risks', dependsOn: [],
    instructions: 'Produce an implementation plan, identify affected areas, unknowns, and evidence needed for acceptance. Do not make changes until the plan is accepted.' },
  { kind: 'implement', title: 'Implement in an isolated worktree', dependsOn: [0],
    instructions: 'Make the smallest changes that satisfy the accepted plan and the docket acceptance checks. Keep the worktree reviewable and report intentional trade-offs.' },
  { kind: 'verify', title: 'Verify the change', dependsOn: [1],
    instructions: 'Run the project review gate and targeted checks in the implementation worktree. Record failures as evidence; do not claim success without command results.' },
  { kind: 'review', title: 'Independent review and decision', dependsOn: [2],
    instructions: 'Review the diff, the acceptance checks, and the recorded evidence. Approve only with a passed verification proof; otherwise request changes or reject.' },
];

export type DocketNode = {
  id: string;
  docketId: string;
  kind: DocketNodeKind;
  title: string;
  instructions: string;
  dependsOn: string[];
  /** Declared at planning time; taken as a real claim when the node starts. */
  claimPath: string | null;
  status: DocketNodeStatus;
  providerId: string | null;
  model: string | null;
  sessionId: string | null;
  worktree: string | null;
  startedAt: number | null;
  endedAt: number | null;
  detail: string | null;
};

export type DocketClaim = {
  id: string;
  docketId: string;
  nodeId: string;
  path: string;
  createdAt: number;
  releasedAt: number | null;
};

/**
 * The facts a docket node's agent needs and cannot otherwise reach: which node
 * it is, what it may touch, what it waits on and what its siblings hold.
 *
 * A snapshot taken at launch, and every rendering says so — a sibling claim
 * released a minute later is not reflected, and a harness without Wanigan's
 * MCP tools (Codex today) cannot take or release a claim from inside the
 * session. The objective, instructions and acceptance checks travel in the
 * first prompt as before; this carries only what was missing there.
 */
export type GoalCapsule = {
  docketId: string;
  docketTitle: string;
  nodeId: string;
  nodeTitle: string;
  nodeKind: DocketNodeKind;
  /** The path this node holds while it runs, or null when it declared none. */
  claimPath: string | null;
  /** Prerequisites as they stood at launch. */
  dependsOn: { nodeId: string; title: string; status: DocketNodeStatus }[];
  /** Live claims held by other nodes in the same project at launch. */
  siblingClaims: { nodeId: string; title: string; path: string }[];
  /** Whether this harness can claim/checkpoint through Wanigan's MCP tools. */
  canClaimLive: boolean;
  recordedAt: number;
};

/** How (or whether) a goal capsule reached a session — a recorded fact, not a guess. */
export type GoalCapsuleDelivery = {
  channel: 'developer-instructions' | 'system-prompt' | 'none';
  /** Why nothing was delivered, when `channel` is 'none'. */
  reason: string | null;
};

export type DocketProof = {
  id: string;
  docketId: string;
  nodeId: string | null;
  kind: 'plan' | 'test' | 'diff' | 'review' | 'decision';
  status: 'recorded' | 'passed' | 'failed';
  summary: string;
  createdAt: number;
};

export type DocketCheckpoint = {
  id: string;
  docketId: string;
  nodeId: string | null;
  sessionId: string | null;
  conversationId: string | null;
  repoCommit: string | null;
  worktree: string | null;
  note: string;
  createdAt: number;
};

export type DocketDetail = WorkDocket & {
  nodes: DocketNode[];
  claims: DocketClaim[];
  proofs: DocketProof[];
  checkpoints: DocketCheckpoint[];
};

export type ModelOutcome = {
  providerId: string;
  model: string;
  taskKind: DocketNodeKind;
  samples: number;
  accepted: number;
  testsPassed: number;
  totalCostUsd: number;
  acceptedRate: number | null;
  testPassRate: number | null;
};

export type ControlEvent = {
  id: string;
  projectId: string | null;
  source: string;
  kind: string;
  summary: string;
  status: 'new' | 'triaged' | 'dismissed';
  docketId: string | null;
  createdAt: number;
};

export type McpTaskRecord = {
  id: string;
  docketId: string;
  nodeId: string;
  title: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  updatedAt: number;
};

/**
 * What `cancelMcpTask` actually did, so a surface can state it rather than
 * infer it.
 *
 * Cancel returned a bare boolean, and Control announced one sentence for every
 * path through the function: an id that names no record, a record that had
 * already closed, a record marked cancelled over a task that had already
 * ended, and a task really stopped mid-run. The four are separate branches in
 * control.ts, so they are separate outcomes here.
 *
 * `nodeStatus` is the task's stored status, not the status Control shows: the
 * graph presents a stored 'pending' as 'ready' or 'blocked' depending on what
 * it waits for, and neither of those words is ever written down.
 */
export type McpTaskCancelReceipt = {
  /**
   * 'not_found'      no record has that id; nothing was read or written.
   * 'already_closed' the record was completed, failed or cancelled already.
   * 'record_only'    the record is now cancelled; the task had already ended,
   *                  so no session was stopped and no claim was released.
   * 'task_canceled'  the record and the task are both cancelled.
   */
  outcome: 'not_found' | 'already_closed' | 'record_only' | 'task_canceled';
  /** The record's status when the call began, before any write. */
  recordStatus: McpTaskRecord['status'] | null;
  /** The task's stored status when the call began; null when none was read. */
  nodeStatus: 'pending' | 'running' | 'completed' | 'failed' | 'canceled' | null;
  /** True only when a session the main process still held was killed here. */
  sessionStopped: boolean;
  /** Claim rows this call moved to released — a count, not an intention. */
  claimsReleased: number;
};

/** A restart/recovery decision for a Goal task, based on durable facts only. */
export type GoalResumeReceipt = {
  nodeId: string;
  docketId: string;
  sessionId: string;
  conversationId: string | null;
  providerId: string;
  model: string | null;
  baseCommit: string | null;
  worktree: string | null;
  createdAt: number;
  updatedAt: number;
  state: 'exact' | 'writer_active' | 'identity_pending' | 'worktree_missing';
  detail: string;
};

/** Content-free operational evidence correlated to a durable Goal task. */
export type GoalTraceEvent = {
  id: string;
  docketId: string;
  nodeId: string;
  sessionId: string;
  /** 'launch' rows are written by Control itself when a node starts (the goal capsule). */
  source: 'hook' | 'telemetry' | 'launch';
  kind: string;
  status: 'recorded' | 'failed';
  toolName: string | null;
  summary: string | null;
  durationMs: number | null;
  costUsd: number;
  inTokens: number;
  outTokens: number;
  createdAt: number;
};

/* ── P32 · agent accounts ───────────────────────────────────────────── */

/**
 * A labelled config directory for one harness.
 *
 * Wanigan holds no credential here. Claude Code keys its stored login — the
 * macOS Keychain entry included — to `CLAUDE_CONFIG_DIR`, so pointing a session
 * at a different directory is what selects a different account. Wanigan cannot
 * perform the browser login; the operator signs in once inside each directory.
 */
export type AgentAccount = {
  id: string;
  /** Which harness this directory belongs to, e.g. 'claude-code'. */
  harness: string;
  label: string;
  configDir: string;
  /** False for a directory Wanigan created; true for one it adopted, like ~/.claude. */
  adopted: boolean;
  isDefault: boolean;
  /** Whether the directory is present on disk right now. */
  present: boolean;
  /**
   * Whether a login has ever been stored here, as far as Wanigan can tell from
   * the files it can read. On macOS the credential itself lives in the Keychain,
   * so this is evidence of use, never proof of a valid session.
   */
  signedIn: 'yes' | 'unknown';
  createdAt: number;
  updatedAt: number;
};

/**
 * Which account a launch will actually use, and why.
 *
 * `override` names an ambient environment credential that outranks the stored
 * login. Claude Code's own precedence puts `ANTHROPIC_AUTH_TOKEN` and
 * `ANTHROPIC_API_KEY` above the account's `/login`, so when one is exported the
 * account picker would otherwise be showing a choice the session ignores.
 */
export type AccountResolution = {
  account: AgentAccount | null;
  source: 'explicit' | 'project' | 'default' | 'none';
  /** Set when an inherited environment credential outranks the account's login. */
  override: string | null;
  /** Why no account applies, when `account` is null. */
  reason: string | null;
};

/**
 * Hook-observed writes into a harness's own auto-memory directory for one
 * session. Paths only — Wanigan never reads what the agent wrote there.
 * `count` is a COUNT over PostToolUse rows whose path sits inside one of
 * `memoryDirs`; it is not the number of memories that exist.
 */
export type NativeMemoryWrites = {
  harness: string | null;
  /** The directories checked, resolved from the session's frozen account. */
  memoryDirs: string[];
  /** False when the row predates account recording or the account was removed. */
  accountKnown: boolean;
  count: number;
  /** Basenames of the files touched, at most 50. */
  files: string[];
  note: string | null;
};

/**
 * The AGENTS.md files Wanigan's Codex compiler can write to for one project,
 * read from disk. Which of them Codex actually loads, and in what order, is
 * not predicted here: Codex's loader was not consulted.
 */
export type CodexAgentsChain = {
  projectRoot: string;
  /** The account directory whose AGENTS.md heads the list, or the ambient/default one. */
  codexHome: string;
  files: {
    path: string;
    scope: 'home' | 'project' | 'nested';
    exists: boolean;
    bytes: number | null;
    /** True when an applied Wanigan projection targets this exact path. */
    managed: boolean;
    projectionId: string | null;
  }[];
  note: string;
};

/* ── P33 · usage and limits ─────────────────────────────────────────── */

/**
 * One rolling limit window as the provider reported it.
 *
 * `resetsAtText` is the provider's own words when it gave any; it is null on a
 * window with nothing used yet, where the agent announces no reset at all.
 * `resetsAt` is an epoch only when that text parsed confidently. A countdown is
 * worth having, but not worth inventing — a surface with no epoch shows the
 * provider's own words, and one with neither says only the percentage.
 */
export type LimitWindow = {
  /** 'session', 'week', or whatever the provider called it. */
  kind: string;
  /** null for an all-models window; a model name such as 'Fable' otherwise. */
  scope: string | null;
  usedPercent: number;
  resetsAtText: string | null;
  resetsAt: number | null;
};

/**
 * A block of the provider's own explanation of what drove usage.
 *
 * Carried verbatim, including its caveat: Claude describes this as approximate
 * and local-only, and a surface that reformatted it into confident figures
 * would be making a claim the provider declined to make.
 */
export type UsageFactors = {
  label: string;
  requests: number | null;
  sessions: number | null;
  lines: string[];
};

/**
 * What is left on one account.
 *
 * Remaining quota is never derivable from the token counters on this machine —
 * compaction, cached input and plan-specific limits make every such
 * calculation a guess — so this is a live read or it is an honest absence.
 */
/** Who a configuration directory is signed in as, from the agent's own answer. */
export type AccountIdentity = {
  email: string | null;
  orgName: string | null;
  /** The subscription tier the agent reports, such as 'max'. */
  plan: string | null;
  authMethod: string | null;
};

export type AccountLimits = {
  accountId: string;
  accountLabel: string;
  harness: string;
  /** null when the agent could not be asked, or reported nobody signed in. */
  identity: AccountIdentity | null;
  state: 'ok' | 'signed-out' | 'unreadable' | 'unsupported' | 'stale';
  /** Why, when state is not 'ok'. */
  detail: string | null;
  fetchedAt: number | null;
  plan: string | null;
  windows: LimitWindow[];
  factors: UsageFactors[];
};

/** What was actually spent, per account and model, from Wanigan's own records. */
export type ModelConsumption = {
  accountId: string | null;
  accountLabel: string;
  model: string;
  requests: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  costUsd: number;
  /** 'reported' only when every row carried a provider cost. */
  costStatus: 'reported' | 'partial' | 'unreported';
};

export type ConsumptionPoint = {
  /** Local day, YYYY-MM-DD. */
  day: string;
  accountLabel: string;
  model: string;
  tokens: number;
  costUsd: number;
};

export type UsageSnapshot = {
  limits: AccountLimits[];
  consumption: ModelConsumption[];
  daily: ConsumptionPoint[];
  /** Days covered by `daily`. */
  days: number;
};

/* ── P11 · dispatcher ───────────────────────────────────────────────── */

export type QueueKind = 'session' | 'headless' | 'batch' | 'scout' | 'node';
export type QueueState = 'waiting' | 'running' | 'done' | 'failed' | 'canceled';

export type QueueItem = {
  id: string;
  kind: QueueKind;
  state: QueueState;
  /** Lower runs first. */
  priority: number;
  label: string;
  /** Why it is not running yet, in words. */
  blockedBy: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
};

export type QueueSlots = { session: number; headless: number; batch: number; scout: number; node: number };
/**
 * `node` is deliberately the narrowest terminal lane. Autopilot starts real
 * PTY sessions that spend real money without anyone watching, so its default
 * concurrency is below what a person driving sessions by hand would pick.
 */
export const DEFAULT_SLOTS: QueueSlots = { session: 4, headless: 3, batch: 2, scout: 1, node: 2 };

/* ── P12 · MCP ──────────────────────────────────────────────────────── */

export type McpServerConfig = {
  id: string;
  projectId: string | null;
  name: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string;
  url?: string;
  enabled: boolean;
};

/**
 * Use, not status — and the name is now the only thing left of the old shape.
 *
 * `connected` and `lastError` were fields nothing ever wrote: Wanigan hands an
 * MCP config to the CLI, which spawns the servers inside the session's own
 * process tree and reports nothing back, so there was never a source for them
 * and never could be. A permanently false "connected" beside a real server is
 * a false red, which is the same lie as a false green. What is knowable is what
 * the agents actually called: every MCP tool call arrives on the hook bus as
 * `mcp__<server>__<tool>` and is already in session_events.
 */
export type McpServerStatus = {
  id: string;
  name: string;
  /** When a tool from this server last completed, or null if none is on record. */
  lastUsedAt: number | null;
  /** Completed tool calls on record for this server. */
  toolCalls: number;
  /** How many of those came back an error. */
  failures: number;
};

/* ── P13 · uploaded rows ────────────────────────────────────────────── */

export type UploadedFile = {
  hash: string;
  fileId: string;
  path: string;
  bytes: number;
  mediaType: string;
  uploadedAt: number;
};

/* ── P16 · cache diagnosis ──────────────────────────────────────────── */

export type CacheDiagnosis = {
  willCache: boolean;
  prefixTokens: number;
  /** Model-dependent floor below which a prefix silently never caches. */
  minimumTokens: number;
  ttl: CacheTtl;
  /** Plain-language causes, worst first. */
  reasons: string[];
  /** Measured on completed runs; null before any results land. */
  observedHitRate: number | null;
};

/* ── P17 · evals ────────────────────────────────────────────────────── */

export type EvalPair = {
  id: string;
  name: string;
  runAId: string;
  runBId: string;
  /** The single field that differs — enforced, so a comparison is readable. */
  variable: string;
  createdAt: number;
};

export type EvalRowDiff = {
  customId: string;
  rowIndex: number;
  aText: string | null;
  bText: string | null;
  aStatus: string;
  bStatus: string;
  aCost: number;
  bCost: number;
  same: boolean;
  /** Judge verdict, when a judge run has scored this pair. */
  score: number | null;
  winner: 'a' | 'b' | 'tie' | null;
  rationale: string | null;
};

export type GoldenSet = {
  id: string;
  name: string;
  rows: number;
  createdAt: number;
  sourceRunId: string | null;
};

/* ── P18 · budgets ──────────────────────────────────────────────────── */

export type Budget = {
  /** null scopeId means the global budget. */
  scopeId: string | null;
  monthlyUsd: number;
  /** Fraction of the budget at which the warning fires. */
  warnAt: number;
};

export type BudgetState = {
  scopeId: string | null;
  scopeName: string;
  monthlyUsd: number;
  spentUsd: number;
  sessionUsd: number;
  batchUsd: number;
  warnAt: number;
  /** Projected month-end spend at the current rate. */
  projectedUsd: number;
  daysElapsed: number;
  daysInMonth: number;
};

export type Reconciliation = {
  /** What Wanigan computed from its own pricing table. */
  localUsd: number;
  /** What the organisation was actually billed, per the Admin API. */
  reportedUsd: number;
  deltaUsd: number;
  accuracy: number;
  byModel: { model: string; localUsd: number; reportedUsd: number }[];
  from: string;
  to: string;
  note: string | null;
};

/* ── P19 · trust & policy ───────────────────────────────────────────── */

/**
 * What an agent in this project is allowed to do. Deliberately coarse: a
 * setting nobody understands is a setting nobody sets correctly.
 */
export const TRUST_LEVELS = ['readonly', 'project', 'trusted'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const TRUST_COPY: Record<TrustLevel, { label: string; detail: string }> = {
  readonly: {
    label: 'Read only',
    // Not "network calls are denied". READ_TOOLS in policy.ts allows WebFetch
    // and WebSearch on purpose — a level that cannot look anything up is a
    // level nobody keeps switched on — so the old sentence promised a
    // containment the gate has never enforced. This string is what the user
    // reads before choosing a trust level for a repository, which makes it the
    // most expensive place in the app to be wrong.
    detail: 'The agent can read, search and look things up on the web. A file write, shell command or MCP call that is not a read is held for your approval.',
  },
  project: {
    label: 'Project',
    detail: 'Writes and commands are allowed inside the project directory. Anything outside it — including your credential folders — asks you first.',
  },
  trusted: {
    label: 'Trusted',
    detail: 'Nothing is denied by Wanigan. The OS sandbox and the agent’s own permission prompts are the only limits.',
  },
};

/**
 * The copy for a trust level, or an honest unknown.
 *
 * `TRUST_COPY[level]` was indexed directly in five places with a level that
 * came from a database row, a session record or a setting rather than from
 * TRUST_LEVELS. A value outside the three — an older row, a hand-edited
 * database, a level added later and read by an older build — made that
 * expression `undefined`, and the next `.label` took the whole view into its
 * error boundary. A blank screen is the worst possible answer to "what is this
 * repository allowed to do".
 *
 * This mirrors `markOf` in components/bits.tsx and mirrors it deliberately: an
 * unrecognised value is shown as itself, and the copy says plainly that Wanigan
 * does not know what it means, because the alternative is quietly relabelling
 * an unknown permission as one of the three the reader already trusts.
 */
export function trustCopy(level: string): { label: string; detail: string } {
  const known = (TRUST_COPY as Record<string, { label: string; detail: string }>)[level];
  if (known) return known;
  return {
    label: level || 'unknown',
    detail: `Wanigan does not recognise the trust level “${level || 'unknown'}”, so it cannot say what it allows. `
      + 'Set this project to Read only, Project or Trusted to get a level this build enforces.',
  };
}

/** The glyph for a trust level, or a neutral mark for one this build does not know. */
export function trustGlyph(level: string): string {
  return ({ readonly: '◇', project: '◈', trusted: '◆' } as Record<string, string>)[level] ?? '·';
}

/**
 * The words for a permission mode, and an honest label for one this build has
 * never seen.
 *
 * A permission mode is the same kind of value as a trust level: a nullable
 * string persisted on the session row and declarable by any provider pack, not
 * a member of a union the compiler checks. Indexing a copy table with it
 * directly is the bug `trustCopy` above exists to fix — `PERMISSION_MODE_COPY[
 * mode]` is `undefined` for a mode a pack declared or a later build added, and
 * the next `.label` takes the New session dialog into its error boundary.
 *
 * So the table stays module-private and this returns `known` instead. A caller
 * that cannot reach the table cannot quietly relabel a mode Wanigan has never
 * verified as one of the six the reader already trusts — which matters most
 * here, because this is the value that decides how much an agent may do without
 * asking. Prettifying an unrecognised `foo_bar` into "Foo bar" would invent a
 * meaning for a permission; the honest render names it as declared and says
 * Wanigan does not know what it allows.
 *
 * The table is split by what this repository can actually vouch for. `claude
 * --help` lists the six choices and describes none of them, so the three
 * sentences that state behaviour are sourced from Wanigan's own recorded
 * reasoning in headless.ts (`gateFor`), and the three with no source here say
 * plainly that Wanigan has not verified them rather than offering a plausible
 * description Wanigan cannot support.
 */
const PERMISSION_MODE_COPY: Record<string, { label: string; detail: string }> = {
  acceptEdits: {
    label: 'Accept edits',
    // headless.ts gateFor(): the mode chosen for 'project' trust, because it
    // auto-approves edits under the working directory and prompts for anything
    // outside it.
    detail: 'Edits under the working directory go ahead; anything outside it asks. This is the mode Wanigan itself uses to hold an unattended run to Project trust.',
  },
  bypassPermissions: {
    label: 'Ask for nothing',
    // headless.ts gateFor(): the mode chosen for 'trusted', where nothing is
    // denied and there is nothing to hold the CLI to.
    detail: 'Nothing is held for approval. This is the mode Wanigan uses only for a project set to Trusted.',
  },
  plan: {
    label: 'Plan first',
    // headless.ts gateFor() pairs 'plan' with --disallowedTools for read-only
    // runs, and records why: --allowedTools is a pre-approval list, not an
    // exclusive one. Saying "the agent cannot write in plan mode" would be a
    // claim this repository's own comment contradicts.
    detail: 'The agent proposes a plan before acting. Wanigan does not rely on this mode alone to prevent writes — its own read-only runs pair it with an explicit tool denial list.',
  },
  manual: {
    label: 'Ask every time',
    detail: 'Wanigan passes this through unchanged and has not verified what the CLI approves in it.',
  },
  auto: {
    label: 'Automatic',
    detail: 'Wanigan passes this through unchanged and has not verified what the CLI approves in it.',
  },
  dontAsk: {
    label: 'Stop asking',
    detail: 'Wanigan passes this through unchanged and has not verified what this still asks about. Treat it as unrestricted until you have checked.',
  },
};

/** The copy for a permission mode, or an honest unknown. See PERMISSION_MODE_COPY. */
export function permissionModeCopy(mode: string): { label: string; detail: string; known: boolean } {
  const known = PERMISSION_MODE_COPY[mode];
  if (known) return { ...known, known: true };
  return {
    label: mode || 'unknown',
    detail: `Wanigan does not recognise the permission mode “${mode || 'unknown'}”, so it cannot say `
      + 'what it allows. The agent CLI decides what it means.',
    known: false,
  };
}

/**
 * The name to print for a harness id.
 *
 * Once accounts from more than one agent share a surface, two rows both labelled
 * "Personal" are two different logins to two different products, and the label
 * is the operator's word for it rather than the agent's. An unknown harness
 * prints as itself: a pack can declare one this build has never heard of, and
 * inventing a friendly name for it would be a guess printed as a fact.
 */
export function harnessLabel(harness: string): string {
  return ({ 'claude-code': 'Claude Code', codex: 'Codex' } as Record<string, string>)[harness] ?? harness;
}

export type PolicyDecision = {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
  /** The rule that fired, for the ledger. */
  rule: string;
};

export type LedgerEntry = {
  id: number;
  at: number;
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  trust: TrustLevel;
  toolName: string;
  summary: string;
  decision: 'allow' | 'deny' | 'ask';
  rule: string;
  reason: string;
};

/* ── P6 · motion ────────────────────────────────────────────────────── */

/** Off honours the OS setting; the explicit values override it either way. */
export type MotionSetting = 'auto' | 'full' | 'off';

/**
 * Colour is a presentation preference, never a guess based on ambient light.
 * `system` follows macOS (and changes with it); the other values deliberately
 * win until the operator switches back.
 */
export type ThemeSetting = 'system' | 'light' | 'dark';

/* ── shell settings ─────────────────────────────────────────────────── */

export type WaniganSettings = {
  /** Explainer visibility flags, one flat key per guide the operator hid. */
  [explainer: `explainer.${string}`]: 'hidden' | 'shown';
  spendCapUsd: number;
  motion: MotionSetting;
  /** Whether the destination sidebar is showing. Persisted, not per-window. */
  navSidebar: 'open' | 'closed';
  theme: ThemeSetting;
  telemetry: boolean;
  hooks: boolean;
  /** Per-turn workspace snapshots for hook-capable sessions in git repos. */
  checkpoints: boolean;
  archiveTranscripts: boolean;
  notifications: boolean;
  slots: QueueSlots;
  eventRetentionDays: number;
  defaultTrust: TrustLevel;
  mcpServerEnabled: boolean;
  pet: boolean;
  /**
   * Whether a paired phone may read this Mac's working trees, run a project's
   * saved review gate, and commit what git already tracks. Off by default and
   * separate from every other mobile switch: it is the one setting that widens
   * the promise mobile/snapshot.ts states, because a changed-file list is made
   * of paths. See settings.ts's mobileRepositoryReview().
   */
  mobileRepositoryReview: boolean;
  learning: LearningSettings;
};

/* ── AI Improvement Scout ──────────────────────────────────────────── */

/**
 * The scout deliberately starts as an evidence/rules engine. `deterministic`
 * means no model saw the retrieved material; the UI must never imply a model
 * reviewed a release note unless a future analyzer records that fact.
 */
export type ImprovementScoutAnalysisMethod = 'deterministic-rules';
export type ImprovementScoutRunMode = 'manual' | 'preview' | 'scheduled';
export type ImprovementScoutRunStatus = 'running' | 'completed' | 'blocked' | 'failed';
export type ImprovementScoutSuggestionStatus = 'new' | 'reviewed' | 'snoozed' | 'dismissed' | 'goal-created';
export type ImprovementScoutEffort = 'small' | 'medium' | 'large';
export type ImprovementScoutRisk = 'low' | 'elevated' | 'high';
export type ImprovementScoutSourceKind = 'release-notes' | 'changelog' | 'documentation';

/** Explicit, bounded operator choices. A weekly run is not armed until both
 * `weeklyEnabled` and `networkEnabled` are true; manual one-off research has
 * its own explicit `allowNetwork` action. */
export type ImprovementScoutSettings = {
  enabled: boolean;
  weeklyEnabled: boolean;
  /** Local weekday, Sunday = 0. */
  weekday: number;
  /** Local 24-hour clock. */
  hour: number;
  cron: string;
  /** Permission for unattended, allow-listed official-source requests. */
  networkEnabled: boolean;
  /** Readable alias for the same persisted unattended-research permission. */
  onlineResearch: boolean;
  /** Reserved until a real provider-neutral analyzer is connected. */
  providerId: string | null;
  model: string | null;
  modelAssistanceEnabled: false;
  analysisMethod: ImprovementScoutAnalysisMethod;
};

export type ImprovementScoutSource = {
  id: string;
  label: string;
  description: string;
  url: string;
  publisher: string;
  kind: ImprovementScoutSourceKind;
  official: boolean;
  enabled: boolean;
  lastCheckedAt: number | null;
  lastStatus: 'never' | 'ok' | 'failed' | 'skipped';
  lastDetail: string | null;
};

export type ImprovementScoutEvidence = {
  id: string;
  runId: string;
  suggestionId: string | null;
  sourceId: string;
  title: string;
  url: string;
  publisher: string;
  excerpt: string;
  contentHash: string;
  publishedAt: number | null;
  retrievedAt: number;
};

export type ImprovementScoutSuggestion = {
  id: string;
  status: ImprovementScoutSuggestionStatus;
  category: string;
  title: string;
  summary: string;
  /** Why the currently stored evidence makes this worth a human look. */
  whyNow: string;
  /** A proposed objective only. It is never executed or applied automatically. */
  recommendation: string;
  score: number;
  confidence: number;
  effort: ImprovementScoutEffort;
  risk: ImprovementScoutRisk;
  analysisMethod: ImprovementScoutAnalysisMethod;
  evidence: ImprovementScoutEvidence[];
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
  note: string | null;
  goalId: string | null;
};

export type ImprovementScoutRun = {
  id: string;
  mode: ImprovementScoutRunMode;
  status: ImprovementScoutRunStatus;
  networkAllowed: boolean;
  sourceCount: number;
  evidenceCount: number;
  suggestionCount: number;
  analysisMethod: ImprovementScoutAnalysisMethod;
  startedAt: number;
  endedAt: number | null;
  detail: string | null;
  error: string | null;
};

export type ImprovementScoutOverview = {
  enabled: boolean;
  weeklyEnabled: boolean;
  networkEnabled: boolean;
  cadenceLabel: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  pendingSuggestions: number;
  sourceCount: number;
  enabledSourceCount: number;
  analysisMethod: ImprovementScoutAnalysisMethod;
  latestRun: ImprovementScoutRun | null;
};

export type ImprovementScoutGoal = {
  goalId: string;
  /** A local deep link that opens the durable Control Goal after Control is selected. */
  goalUrl: string;
};

/* ── Wanigan Compound · provider-neutral learning ───────────────────── */

export type KnowledgeKind =
  | 'instruction' | 'rule' | 'memory' | 'skill' | 'mission'
  | 'gate' | 'eval' | 'project-map';

/**
 * Only these kinds are instructions a session can act on, so only these ever
 * reach a briefing. An 'eval' is regression evidence and a 'project-map' is
 * topology; a 'skill' compiles to its own provider file and a 'gate' to a
 * Wanigan review gate. The briefing builder in the main process reads this
 * same list — one definition, so the Knowledge view and the injector cannot
 * disagree about which rows can be briefed.
 */
export const INJECTABLE_KINDS: readonly KnowledgeKind[] = ['mission', 'instruction', 'rule', 'memory'];
/** With no query and no path there is nothing to be relevant to; only a standing artifact qualifies. */
export const STANDING_KINDS: readonly KnowledgeKind[] = ['mission'];

/**
 * How a kind reaches an agent — a property of the kind, never a score. 'never'
 * carries what the kind compiles to instead, so a row can say "never briefed —
 * compiles to a Wanigan review gate" rather than looking like a broken item.
 */
export type KnowledgeKindDelivery =
  | { briefed: 'standing' }
  | { briefed: 'on-query' }
  | { briefed: 'never'; compilesTo: string };

const NEVER_BRIEFED_COMPILES_TO: Record<string, string> = {
  skill: 'a provider skill file (SKILL.md) per harness',
  gate: 'a Wanigan review gate',
  eval: 'a Wanigan evaluation case',
  'project-map': 'nothing yet — retrievable in Wanigan only, no provider file',
};

export function kindDelivery(kind: KnowledgeKind): KnowledgeKindDelivery {
  if (STANDING_KINDS.includes(kind)) return { briefed: 'standing' };
  if (INJECTABLE_KINDS.includes(kind)) return { briefed: 'on-query' };
  return { briefed: 'never', compilesTo: NEVER_BRIEFED_COMPILES_TO[kind] ?? 'no provider mapping' };
}

export type ArtifactScope = 'personal' | 'project' | 'path';
export type CandidateStatus =
  | 'pending' | 'approved' | 'rejected' | 'snoozed'
  | 'promoted' | 'applied' | 'failed' | 'superseded';
export type KnowledgeStatus = 'active' | 'quarantined' | 'retired';
export type ProjectionStatus = 'preview' | 'applied' | 'stale' | 'undone' | 'failed';
export type EvidenceLevel = 'estimate' | 'correlation' | 'causal';

export type LearningSettings = {
  enabled: boolean;
  contentMode: 'operational-only' | 'local-same-provider';
  automation: 'review-only' | 'hybrid';
  allowModelAssistance: boolean;
  monthlyBudgetUsd: number;
  briefingMaxTokens: number;
  consolidationEnabled: boolean;
};

/**
 * Model-assisted phrasing, as the renderer sees it.
 *
 * `LearningSettings.allowModelAssistance` is the *effective* value: the stored
 * switch ANDed with consent, routing and metering. These types carry the reason
 * it is off, so the settings screen can name the blocker rather than showing a
 * dead control. See src/main/learning-model-assist.ts.
 */
export type ModelAssistRefusal =
  | 'switched-off'
  | 'no-attribution'
  | 'unknown-provider'
  | 'profile-changed'
  | 'no-headless-protocol'
  | 'not-consented'
  | 'no-budget-set'
  | 'budget-exhausted'
  | 'unmetered-harness';

/** 'unproven' until a first call establishes whether the harness reports usage. */
export type ModelAssistMetering = 'unproven' | 'metered' | 'unmetered';

export type ModelAssistRouting =
  | {
      ok: true;
      providerId: string;
      backendId: string | null;
      label: string;
      protocol: string;
      fingerprint: string;
      metering: ModelAssistMetering;
    }
  | { ok: false; reason: ModelAssistRefusal; detail: string };

export type ModelAssistConsent = {
  providerId: string;
  backendId: string | null;
  fingerprint: string;
  acceptedAt: number;
  /**
   * The model the approved profile should phrase with, or null for whatever the
   * harness defaults to. Phrasing rewrites nine counters into two sentences, and
   * a profile's default is often its most expensive model — an observed 12.9¢ a
   * call on Claude Code — so this is the cost lever, and it is part of the
   * approval because it changes the argv a person agreed to.
   */
  model: string | null;
};

/** Everything a person approves, rendered from the definition that will run. */
export type ModelAssistConsentPreview = {
  providerId: string;
  backendId: string | null;
  label: string;
  protocol: string;
  fingerprint: string;
  /** The exact argv, with the per-cluster prompt body described rather than shown. */
  argv: string[];
  /** Destination names only, never values. */
  envDestinations: string[];
  payloadFields: readonly string[];
  deniedTools: string[];
  metering: ModelAssistMetering;
  probeRequired: boolean;
  /** False when the profile takes no model flag; the picker is hidden then. */
  supportsModel: boolean;
  model: string | null;
};

export type ModelAssistRun = {
  at: number;
  providerId: string;
  status: string;
  costUsd: number;
  /** False when the harness returned no usage figures; the cost is not a guess. */
  costReported: boolean;
};

export type ModelAssistStatus = {
  switchedOn: boolean;
  effective: boolean;
  consent: ModelAssistConsent | null;
  routing: ModelAssistRouting;
  monthToDateUsd: number;
  runs: ModelAssistRun[];
  /**
   * Mean cost of the priced calls on record, or null when none has been priced.
   * Observed, never modelled: it is the arithmetic mean of what harnesses
   * actually reported, so it is absent rather than zero before the first one.
   */
  averageCostUsd: number | null;
};

export type LearningPhrasingOutcome =
  | { ran: false; reason: 'learning-disabled' | 'model-assist-unavailable' }
  | { ran: true; phrased: number; refused: number; skipped: number };

export type LearningSignal = {
  id: string;
  kind: string;
  providerId: string | null;
  backendId: string | null;
  sessionId: string | null;
  taskHash: string | null;
  projectId: string | null;
  projectPath: string | null;
  pathScope: string | null;
  summary: string;
  detail: Record<string, unknown>;
  contentHash: string;
  semanticEligible: boolean;
  createdAt: number;
  processedAt: number | null;
};

export type CandidateConflict = {
  itemId: string;
  title: string;
  relation: 'possible-conflict' | 'duplicate';
  reason: string;
};

export type KnowledgeCandidate = {
  id: string;
  itemId: string | null;
  targetKind: KnowledgeKind;
  scope: ArtifactScope;
  providerId: string | null;
  projectId: string | null;
  pathScope: string | null;
  title: string;
  proposedText: string;
  rationale: string;
  confidence: number;
  status: CandidateStatus;
  evidenceCount: number;
  taskCount: number;
  estimatedTokenDelta: number;
  conflicts: CandidateConflict[];
  signalIds: string[];
  createdAt: number;
  updatedAt: number;
  reviewedAt: number | null;
  reviewerNote: string | null;
  /** Consolidation's cluster facet key; null for taught, forged or legacy rows. */
  clusterKey: string | null;
  /** First time a person snoozed it; never cleared. A snoozed candidate never auto-applies. */
  snoozedAt: number | null;
  /** Why a snoozed candidate came back to pending — a reason code, never the operator's note. */
  wake: CandidateWake | null;
};

/** The wake transition as a code with the counts behind it. */
export type CandidateWake = {
  code: 'observed-again';
  newSignals: number;
  newTasks: number;
  at: number;
};

export type CreateKnowledgeCandidate = {
  itemId?: string | null;
  targetKind: KnowledgeKind;
  scope: ArtifactScope;
  providerId?: string | null;
  projectId?: string | null;
  pathScope?: string | null;
  title: string;
  proposedText: string;
  rationale: string;
  confidence: number;
  signalIds: string[];
  estimatedTokenDelta?: number;
};

export type KnowledgeItem = {
  id: string;
  kind: KnowledgeKind;
  scope: ArtifactScope;
  projectId: string | null;
  pathScope: string | null;
  title: string;
  canonicalText: string;
  status: KnowledgeStatus;
  confidence: number;
  sourceCount: number;
  currentVersion: number;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  lastValidatedAt: number | null;
  expiresAt: number | null;
  supersededBy: string | null;
};

export type KnowledgeVersion = {
  id: string;
  itemId: string;
  version: number;
  canonicalText: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  createdBy: string;
  previousVersionId: string | null;
  createdAt: number;
};

export type KnowledgeEvidence = {
  id: string;
  itemId: string | null;
  versionId: string | null;
  candidateId: string | null;
  signalId: string | null;
  sourceType: string;
  sourceId: string;
  citation: string;
  contentHash: string | null;
  weight: number;
  observedAt: number;
};

export type KnowledgeProjection = {
  id: string;
  candidateId: string;
  itemId: string | null;
  versionId: string | null;
  providerId: string;
  adapterId: string;
  scope: ArtifactScope;
  projectId: string | null;
  targetPath: string;
  targetFormat: string;
  proposedContent: string;
  baseHash: string;
  appliedHash: string | null;
  previousContent: string | null;
  status: ProjectionStatus;
  error: string | null;
  createdAt: number;
  appliedAt: number | null;
  undoneAt: number | null;
  /** Roots granted at preview time; undo verifies against these even after the
   * provider profile or project registration is gone. Empty for legacy rows. */
  allowedRoots: string[];
};

/** Per-provider outcome of a skill install; a failed provider never hides the
 * ones that applied. */
export type SkillInstallResult = {
  providerId: string;
  projection: KnowledgeProjection | null;
  error: string | null;
};

export type KnowledgeBriefing = {
  text: string;
  entries: {
    itemId: string;
    versionId: string | null;
    kind: KnowledgeKind;
    title: string;
    text: string;
    citations: string[];
    estimatedTokens: number;
    /** File citations re-hashed at retrieval; 0 means the entry passed with nothing checkable. */
    checked: number;
    /** Citations carried with no checkable file (learning-signal rows) — never verified. */
    skipped: number;
  }[];
  estimatedTokens: number;
  /** Total items ranked but not admitted: the sum of the four counters below. */
  omitted: number;
  /** Quarantined at retrieval because a citation failed its freshness check. */
  omittedStale: number;
  /** Ranked but dropped because the token ceiling was already reached. */
  omittedBudget: number;
  /**
   * Refused because the entry was never synthesized into a claim: its text is
   * its own title, or a bare filesystem path. The fix is upstream in
   * consolidation, not a bigger budget.
   */
  omittedUnsynthesized: number;
  /**
   * Ranked and affordable, but the per-launch freshness-check quota was spent
   * before they could be verified. Unverified is not stale: raising the check
   * quota admits these, raising the token ceiling does not.
   */
  omittedUnverified: number;
  /**
   * False when the launch supplied neither a task query nor a path hint. Only
   * standing artifacts were eligible, so a short briefing is a consequence of
   * the request and not evidence that the store is empty.
   */
  queryProvided: boolean;
};

/**
 * What the read-only briefing preview returns. The same shape as a launch
 * briefing plus the state a launch dialog needs to say what would happen:
 * a disabled engine is a distinct state, not an empty briefing.
 */
export type BriefingPreview = KnowledgeBriefing & {
  /** False: retrieval did not run; every counter is 0 because nothing was asked, not because nothing matched. */
  learningEnabled: boolean;
  /** The provider profile's declared harness, or null for an unknown profile. */
  harnessId: string | null;
  /**
   * How a launch would deliver this text: Claude Code's --append-system-prompt,
   * Codex's developer_instructions config, or none for a harness Wanigan does
   * not brief. A launch also requires the harness proof below.
   */
  launchDelivery: 'append-system-prompt' | 'developer-instructions' | 'none';
  /** 'builtin': reviewed harness. 'probe-required': a local pack must pass its adapter probe at launch first. */
  harnessProof: 'builtin' | 'probe-required' | null;
};

/** One recorded briefing delivery — what a session was actually told. */
export type SessionBriefingRecord = {
  sessionId: string;
  at: number;
  delivery: 'argv' | 'hook';
  providerId: string | null;
  projectId: string | null;
  entries: {
    itemId: string;
    versionId: string | null;
    kind: KnowledgeKind;
    title: string;
    estimatedTokens: number;
    /** Null on rows recorded before per-entry citation counts were persisted: "not recorded", never 0. */
    checked: number | null;
    skipped: number | null;
  }[];
  estimatedTokens: number;
  maxTokens: number;
  omittedStale: number;
  omittedBudget: number;
  /** Null on rows recorded before these counters were persisted; render "not recorded", never 0. */
  omittedUnsynthesized: number | null;
  omittedUnverified: number | null;
  /** Hook deliveries only: the SessionStart event this capsule answered, paired by time. */
  sessionStartAt: number | null;
};

/** One persisted consolidation pass — the automation heartbeat. */
export type ConsolidationRun = {
  id: string;
  at: number;
  trigger: 'timer' | 'manual';
  processed: number;
  candidates: number;
  autoApplied: number;
  durationMs: number;
};

/** What one consolidation pass consumed and produced. */
export type ConsolidationCounts = {
  processed: number;
  candidates: number;
  autoApplied: number;
  woken: number;
  /**
   * How much of the queue this pass actually looked at.
   *
   * A pass takes whole cluster partitions until a memory budget is met, so
   * `examined < pending` is ordinary rather than a fault -- the ring resumes
   * where it stopped and reaches every partition within one lap. But a caller
   * that reports "nothing repeated across enough independent sessions yet"
   * from a partial read is asserting a conclusion about a queue it did not
   * finish, which is the lie the fixed 1,000-row window told for 1,189
   * consecutive passes. Anything phrasing a whole-queue verdict reads these
   * first.
   */
  examined: number;
  pending: number;
  partitionsRead: number;
  partitionsTotal: number;
};

/**
 * The result of asking for a consolidation pass. A refusal is a separate shape
 * from a finished pass, so no caller can read four zeros off a pass that never
 * started and report it as a run that found nothing: the counts do not exist
 * unless `ran` is true. Hand-mirrored with ConsolidationOutcome in
 * src/main/learning/types.ts.
 */
export type ConsolidationOutcome =
  | ({ ran: true } & ConsolidationCounts)
  | { ran: false; reason: 'learning-disabled' | 'consolidation-disabled' };

/** Everything recorded about one session's learning. All fields are stored rows. */
export type SessionLearningLedger = {
  sessionId: string;
  briefings: SessionBriefingRecord[];
  signals: LearningSignal[];
  contributions: { itemId: string; title: string; kind: KnowledgeKind; status: KnowledgeStatus; evidenceCount: number }[];
  candidates: { candidateId: string; title: string; status: CandidateStatus; targetKind: KnowledgeKind }[];
  /** Hook-observed `Skill` tool calls — tool calls, not "skills invoked"; a typed `/name` is unobservable. */
  skillToolCalls: SkillToolCalls;
  /** Counts of `wanigan:<id>` tags quoted in the archived transcript; never a claim about use. */
  transcriptCitations: TranscriptCitationSummary;
  /** Native auto-memory writes observed through hooks; absent until the ledger reads them. */
  nativeMemory?: NativeMemoryWrites | null;
};

export type SkillToolCalls = {
  observed: number;
  identifiers: string[];
  /** Calls whose identifier was not recorded (older hook rows carry a null summary). */
  unrecorded: number;
};

export type TranscriptCitationSummary = {
  status: 'scanned' | 'not-scanned' | 'unsupported';
  reason: string | null;
  total: number;
  truncated: boolean;
  items: { itemId: string; title: string; n: number }[];
};

/** The automation gate's checks, decomposed so a verdict is never magic. */
export type CandidateExplanation = {
  candidateId: string;
  decision: 'auto-apply' | 'review' | 'blocked';
  reason: string;
  checks: { label: string; ok: boolean; actual: string; required: string }[];
};

/** Observed pipeline throughput; every number is a COUNT over stored rows. */
export type LearningPipelineStats = {
  windowDays: number;
  signals: number;
  /** Same project scoping, no time window — lets "outside this window" be a fact. */
  signalsAllTime: number;
  eligibleSignals: number;
  candidatesCreated: number;
  /**
   * Candidates created in the window that nobody has decided on yet: a COUNT
   * over knowledge_candidates still sitting at 'pending' or 'snoozed'. It is
   * deliberately not candidatesCreated minus autoPromoted. autoPromoted counts
   * knowledge items rather than candidates, so that subtraction mixed units,
   * and nothing in it ever removed a candidate a person approved or rejected —
   * a fully reviewed Inbox still reported a backlog.
   */
  awaitingDecision: number;
  autoPromoted: number;
  /**
   * Candidates a person decided inside the window: a COUNT over the statuses
   * in DECIDED_CANDIDATE_STATUSES, timed by reviewed_at because that is when
   * the decision was taken. It is deliberately not "reviewed_at is set" — a
   * snooze stamps reviewed_at too, so that predicate counted a deferred
   * proposal here while awaitingDecision counted the same row as still open.
   * A candidate automation promoted without review has no reviewed_at and is
   * not counted here; autoPromoted is the figure for those.
   */
  reviewed: number;
  itemsPromoted: number;
  projectionsApplied: number;
  briefingsServed: number;
  signalsByDay: { day: string; total: number; failures: number; teachings: number }[];
  /**
   * The most recent passes only — a bounded page of 20, not the whole table.
   * Its length is a page size and must never be rendered as a total; retention
   * keeps 2,000 rows and a 5-minute timer writes about 288 a day.
   */
  consolidationRuns: ConsolidationRun[];
  /**
   * Every consolidation pass still stored, counted: a COUNT(*) over
   * consolidation_runs with no window predicate and no project predicate. A
   * project scope was never available — the table has no project_id column —
   * and what it counts is what retention has kept, the sweep in
   * recordConsolidationRun holding the table at the 2,000 most recent passes.
   */
  consolidationRunsTotal: number;
};

/** A stored relation edge between knowledge items, with its recorded reason. */
export type KnowledgeRelation = {
  fromItemId: string;
  toItemId: string;
  relation: 'supports' | 'contradicts' | 'supersedes' | 'duplicates';
  confidence: number;
  evidence: Record<string, unknown>;
  createdAt: number;
  resolvedAt: number | null;
};

/** A report-only freshness check: why an item is (or is not) trustworthy now. */
export type FreshnessReport = {
  itemId: string;
  fresh: boolean;
  checkedAt: number;
  /** File-backed citations actually re-hashed this pass. */
  checked: number;
  /** Citations with no checkable file — never verified, only carried. */
  skipped: number;
  issues: { evidenceId: string; sourceId: string; kind: 'missing' | 'changed' | 'outside-root' | 'unverifiable'; detail: string }[];
};

export type OptimizerDiagnostic = {
  kind: string;
  severity: 'info' | 'warning' | 'error';
  itemIds: string[];
  title: string;
  detail: string;
  estimatedTokenDelta: number;
};

export type ForgedSkill = {
  name: string;
  scope: 'personal' | 'project';
  skillMd: string;
  allowedTools: string[];
  providerIds: string[];
  estimatedTokens: number;
};

export type SkillDiagnostic = {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  line?: number;
};

/* ── skills catalogue ───────────────────────────────────────────────── */

/**
 * Where a skill was read from. The first four are Claude Code's own loader
 * roots; the `agents-*` pair is the `.agents/skills` family the Codex harness
 * reads, catalogued by Wanigan without consulting Codex's loader.
 */
export type SkillSource = 'user' | 'project' | 'plugin' | 'builtin' | 'agents-user' | 'agents-project';

/**
 * Glyph and word per source, shared by the Skills view and the composer's `$`
 * menu so the same source never wears two marks. Slot order is the
 * colourblind-safety mechanism in the renderer — never reordered to suit
 * meaning — so the renderer maps `id` to a colour token and this table stays
 * colour-free. `harness` names whose loader reads the root.
 */
export const SKILL_SOURCES: readonly {
  id: SkillSource; word: string; glyph: string; blurb: string; harness: 'claude-code' | 'codex';
}[] = [
  { id: 'user',           word: 'user',           glyph: '◆', blurb: 'yours, on this machine',              harness: 'claude-code' },
  { id: 'project',        word: 'project',        glyph: '■', blurb: 'checked into the repo',               harness: 'claude-code' },
  { id: 'plugin',         word: 'plugin',         glyph: '▲', blurb: 'installed by a plugin',               harness: 'claude-code' },
  { id: 'builtin',        word: 'built-in',       glyph: '○', blurb: 'bundled with Claude Code',            harness: 'claude-code' },
  { id: 'agents-user',    word: '.agents user',   glyph: '◇', blurb: 'in ~/.agents/skills, read by Codex',  harness: 'codex' },
  { id: 'agents-project', word: '.agents project', glyph: '□', blurb: 'in <repo>/.agents/skills, read by Codex', harness: 'codex' },
];

/**
 * Whether a skill can be invoked, predicted from disk: SKILL.md frontmatter
 * (`user-invocable`, `disable-model-invocation`) and the `skillOverrides`
 * settings key, resolved through the settings layers. 'unknown' is a real
 * answer — plugin and bundled skills are keyed differently and Wanigan has not
 * verified the form — and is never collapsed into true or false.
 */
export type SkillInvocability = {
  user: boolean | 'unknown';
  model: boolean | 'unknown';
  /** The effective skillOverrides value for this skill, null when none names it. */
  override: 'on' | 'name-only' | 'user-invocable-only' | 'off' | null;
  /** The file whose declaration decided `user` or `model`; null when both are defaults. */
  decidedBy: string | null;
  /** True when more than one settings layer names this skill in skillOverrides. */
  ambiguous: boolean;
};

/** A skill file Wanigan itself wrote, joined from knowledge_projections by target path. */
export type SkillProjectionLink = {
  projectionId: string;
  itemId: string | null;
  status: ProjectionStatus;
  providerId: string;
  appliedAt: number | null;
};

/** A skill that exists on disk but is not the file that runs for its command. */
export type ShadowedSkill = {
  invoke: string;
  source: SkillSource;
  path: string;
  shadowedBy: { source: SkillSource; path: string };
};

/** One `skillOverrides` entry after settings-layer resolution. */
export type SkillOverrideEntry = {
  skill: string;
  value: 'on' | 'name-only' | 'user-invocable-only' | 'off' | string;
  from: 'user' | 'project' | 'local' | 'managed';
  path: string;
  /** Other layers that also name this skill, highest precedence first. */
  shadowed: { from: 'user' | 'project' | 'local' | 'managed'; value: string; path: string }[];
};

/**
 * The main process's verdict on typing a skill into a live session. Only the
 * Claude Code harness has a verified `/name ` form; everything else is an
 * honest unsupported state, with the reason the button can mirror.
 */
export type SkillSendDecision =
  | { ok: true; invoke: string }
  | {
      ok: false;
      code: 'no-session' | 'session-exited' | 'unsupported-harness' | 'unknown-skill' | 'not-user-invocable' | 'no-invocation-form';
      reason: string;
    };

export type LearningExperiment = {
  id: string;
  name: string;
  projectId: string | null;
  itemId: string | null;
  candidateId: string | null;
  baselineVersionId: string | null;
  candidateVersionId: string | null;
  providerId: string;
  model: string;
  effort: string | null;
  commitHash: string;
  config: Record<string, unknown>;
  status: 'draft' | 'running' | 'completed' | 'cancelled' | 'failed';
  outcome: Record<string, unknown> | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
};

export type ArtifactRoiSummary = {
  itemId: string;
  evidenceLevel: EvidenceLevel;
  samples: number;
  tokensLoaded: number;
  tokensSaved: number;
  costUsd: number;
  successfulUses: number;
  failedUses: number;
  repairDelta: number;
  /** Rows behind each figure: 0 means "never measured", not a measured zero. */
  metricCounts: {
    tokensLoaded: number;
    tokensSaved: number;
    costUsd: number;
    uses: number;
    repairDelta: number;
  };
};

export type LearningOverview = {
  pending: number;
  activeKnowledge: number;
  quarantined: number;
  activeSkills: number;
  experiments: number;
  signals: number;
  projectedTokenDelta: number;
};

export type TeachWaniganInput = {
  projectId?: string | null;
  projectPath?: string | null;
  sessionId?: string | null;
  providerId?: string | null;
  kind?: KnowledgeKind;
  scope: ArtifactScope;
  pathScope?: string | null;
  title: string;
  text: string;
  outcome?: 'worked' | 'failed' | 'corrected' | 'preference';
};

/* ── P27 · observed sessions ─────────────────────────────────────────── */

/**
 * A Claude session running on this machine that Wanigan did not start.
 *
 * Every field here is something the CLI wrote about itself into
 * ~/.claude/sessions/<pid>.json, plus two things Wanigan worked out by looking:
 * which project the cwd belongs to, and whether the pid is really that session.
 * There is deliberately no cost, no status, no attention kind and no socket
 * path — Wanigan was not consulted when this session launched and receives no
 * hook events for it, so anything of that shape would be invented.
 */
export type ObservedSession = {
  /** The CLI's own session id — what its transcript is filed under. */
  sessionId: string;
  pid: number;
  cwd: string;
  /** Set when cwd resolves to a project Wanigan already knows. */
  projectId: string | null;
  /** The project's name, or the directory's, so a row always has a label. */
  projectName: string;
  /** The CLI's own derived name, e.g. "wanigan-dd". Null before it has one. */
  name: string | null;
  /** 'cli', 'claude-vscode', 'vscode-agent-host' — how it was launched. */
  entrypoint: string | null;
  kind: string | null;
  version: string | null;
  /** The editor holding this cwd open, when one is. */
  editor: string | null;
  startedAt: number | null;
  /** False when the process start time could not be checked, so the row means
   *  "that pid is alive", not "this session is". */
  verified: boolean;
  observedAt: number;
};

/**
 * What the surface needs before it has a list. "Switched off" and "nothing
 * running" are different answers and a UI that cannot tell them apart will
 * confidently print the wrong one.
 */
export type ObservedState = {
  enabled: boolean;
  /** The registry directory exists, so there is something to read. */
  available: boolean;
  registry: string;
  /** The observe-only sentence the UI must print. */
  notice: string;
  note: string | null;
};

/* ── P29 · what leaves this machine ──────────────────────────────────── */

/**
 * The egress report, assembled in the main process because that is the side
 * that knows. A host list typed into the renderer would go on saying what was
 * true the day it was typed, and would keep saying it after someone adds a
 * sixth fetch() to a file the view has never heard of — a privacy claim that
 * has quietly stopped being true is worse than no claim at all.
 */
export type EgressHost = {
  /** Host only, no scheme or path. */
  host: string;
  /** Paths under it Wanigan actually calls, for someone reading the source. */
  paths: string[];
  /** Who opens the socket. */
  by: 'wanigan' | 'agent';
  /** Why it is contacted, one sentence. */
  purpose: string;
  /** The condition under which it is contacted at all. */
  when: string;
  /** Whether that condition holds right now; null when Wanigan cannot tell. */
  activeNow: boolean | null;
  /** The variable that redirects it, when one exists. */
  overrideEnv: string | null;
};

export type EgressPin = { name: string; value: string; prevents: string };
export type EgressPath = { label: string; path: string; what: string; exists: boolean };

export type EgressReport = {
  hosts: EgressHost[];
  pins: EgressPin[];
  paths: EgressPath[];
  /** Traffic Wanigan cannot enumerate. Rendered verbatim, one line each. */
  unenumerated: string[];
  /** How the host list was produced, so the reader can weigh it. Verbatim. */
  provenance: string;
  /** safeStorage.isEncryptionAvailable(), so the keychain claim is measured. */
  keychainAvailable: boolean;
};

/* ── pull requests, read through the operator's own gh CLI ──────────── */

export type GhPrChecks = { pass: number; fail: number; pending: number; total: number };

export type GhPr = {
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** Validated https in main, or null when gh's answer did not validate. */
  url: string | null;
  base: string;
  head: string;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  /** Null when the PR reports no checks at all. */
  checks: GhPrChecks | null;
  updatedAt: number | null;
};

/**
 * Every arm is an honest state the Git view renders as itself — "gh is not
 * installed" and "gh is not signed in" are answers, never simulated away.
 */
export type GhPrStatus =
  | { kind: 'missing' }
  | { kind: 'unauthenticated'; detail: string }
  | { kind: 'no-branch'; detail: string }
  | { kind: 'none'; branch: string }
  | { kind: 'pr'; branch: string; pr: GhPr }
  | { kind: 'error'; detail: string };

export type GhStatusReport = {
  status: GhPrStatus;
  /** When this answer was produced — a cached answer keeps its original time. */
  checkedAt: number;
  gh: { path: string; version: string | null } | null;
};

export type GhCreateInput = { title: string; body?: string; draft?: boolean; base?: string };
export type GhCreateResult = { url: string | null; detail: string };

/* ── context occupancy, read from the Claude Code transcript ────────── */

/**
 * What the last recorded turn measured, or an honest reason there is no
 * measurement. `tokens` is observed (the API's own usage record); `window` is
 * an assumption stated as one, and absent for models Wanigan cannot map.
 */
export type ClaudeContextUsage =
  | {
    kind: 'ok';
    /** input + cache_read + cache_creation + output of the newest usage record. */
    tokens: number;
    window: number | null;
    percent: number | null;
    model: string | null;
    /** The record's own timestamp; null when the line carried none. */
    at: number | null;
    /**
     * Where `window` came from. 'assumed-…' is Wanigan's assumption from the
     * model id; 'cli-reported' is the figure the Claude CLI itself reported in
     * a headless run for the same model, backend and account — reported by the
     * CLI, still not measured. Absent means no window is claimed.
     */
    windowSource?: 'assumed-200k' | 'assumed-1m' | 'cli-reported' | null;
    /** A sentence the badge can show about the window, e.g. why none is claimed. */
    windowNote?: string | null;
  }
  | { kind: 'unsupported' }
  | { kind: 'no-transcript' }
  | { kind: 'no-usage'; detail: string };

/* ── the renderer bridge's own shapes ────────────────────────────────── */

/**
 * Where a clicked notification should land.
 *
 * The identity was known when the banner was built and thrown away one line
 * later, so every alert used to raise the window onto whichever tab happened
 * to be open — the operator still had to find the blocked agent themselves.
 * Main sends this on `notify:open` after focusing the window.
 */
export type NotificationRoute =
  | { kind: 'session'; sessionId: string }
  | { kind: 'run'; runId: string };

/**
 * What a macOS menu item asked for. The menu bar is built in the main process
 * from shared/routes.ts, but it changes nothing there: it names an intent and
 * the renderer, which owns the router and the dialogs, decides what that means.
 */
export type MenuRoute =
  | { kind: 'tab'; tab: import('./routes').Tab }
  | { kind: 'new-session' }
  | { kind: 'palette' }
  | { kind: 'shortcuts' }
  | { kind: 'sidebar' };

/** Where the Claude CLI installs a plugin. Validated in main, not just typed. */
export type PluginScope = 'user' | 'project' | 'local';

/**
 * What each dispatcher surface is using right now.
 *
 * Settings counted queue rows in state `running`, and an interactive session
 * never creates one — so the surface whose limit is actually enforced at launch
 * read "0 of N" forever. `limit` is the same number the launcher checks, read
 * in the same call, so the meter cannot disagree with the refusal.
 */
export type InteractiveSessionLoad = { live: number; limit: number };

/* ── backup and restore ──────────────────────────────────────────────── */

/**
 * The renderer's view of `src/main/backup.ts`.
 *
 * The main process annotates its backup handlers with these types, so a change
 * to the backup module's own shapes fails the node typecheck here instead of
 * quietly drifting away from what the UI renders.
 */
export type BackupSummary = {
  dir: string;
  manifestPath: string;
  createdAt: number;
  appVersion: string;
  database: { path: string; bytes: number; sha256: string };
  transcripts: { path: string; files: number; bytes: number };
  /** Observed total of the files written, manifest included. */
  totalBytes: number;
  latestEvidenceAt: number | null;
  /** What the backup deliberately does not carry. Rendered verbatim. */
  excluded: string[];
  durationMs: number;
};

export type BackupCheck = {
  dir: string;
  createdAt: number | null;
  appVersion: string | null;
  database: { bytes: number; sha256: string } | null;
  transcripts: { files: number; bytes: number };
  latestEvidenceAt: number | null;
  /** The same measure taken over the database currently in place. */
  currentLatestEvidenceAt: number | null;
  /** True when restoring this backup would drop work recorded since it was taken. */
  wouldDiscardNewer: boolean;
  /** Empty means the backup verified; anything here blocks a restore. */
  problems: { code: string; detail: string }[];
};

export type BackupRestoreSummary = {
  restoredFrom: string;
  createdAt: number;
  database: { bytes: number; sha256: string };
  transcripts: { files: number; bytes: number };
  /** Where the replaced database and transcripts were moved. Never deleted. */
  replacedDir: string;
  discardedNewer: boolean;
  /** Always true: the swap closed this process's database connection. */
  relaunchRequired: true;
};

/**
 * A finished run whose results stop being downloadable soon.
 *
 * The clock is 29 days from batch creation, not from when the run ended, so a
 * batch that took a day to run has already spent a day of it. Only runs with
 * something still to lose appear: once the .jsonl is archived locally the
 * server-side deadline cannot take anything away.
 */
export type ExpiringResults = {
  runId: string;
  runName: string;
  endedAt: number;
  downloadableUntil: number;
};
