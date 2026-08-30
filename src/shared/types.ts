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

export type ProviderLaunchField = {
  id: string;
  label: string;
  kind: 'text' | 'select' | 'boolean' | 'secret';
  required?: boolean;
  description?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string | boolean;
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
  /** Bumped on output while the session is not focused. */
  unread: number;
  model?: string;
  effort?: string;
  permissionMode?: string;
  /** Repo state at launch — lets the code panel show only this session's work. */
  baseline?: Baseline;
  /** The agent's own conversation id, so this exact session can be resumed. */
  conversationId?: string | null;
  /** Set when the session runs in its own worktree rather than the repo itself. */
  worktree?: string | null;
  /** What this project's agents are permitted to do. */
  trust?: TrustLevel;
  /** Capability snapshot at launch, so history does not reinterpret an old
   * session through a newer CLI installation. */
  capabilities?: ProviderCapabilities;
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
  /** low | medium | high | xhigh | max. Empty = the CLI default (high). */
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
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

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
  /** Wanigan's own session id, carried through the generated hook config. */
  wanigan_session_id?: string;
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

export type HeadlessRow = {
  runId: string;
  projectId: string;
  projectName: string;
  projectPath: string;
  status: 'pending' | 'running' | 'succeeded' | 'errored' | 'timeout' | 'canceled' | 'blocked';
  costUsd: number;
  durationMs: number | null;
  exitCode: number | null;
  output: string | null;
  error: string | null;
  filesChanged: number;
  worktree: string | null;
  startedAt: number | null;
  endedAt: number | null;
};

export type HeadlessRun = {
  id: string;
  name: string;
  model: string;
  status: 'submitting' | 'in_progress' | 'ended' | 'failed';
  costUsd: number;
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
};

export type DocketNode = {
  id: string;
  docketId: string;
  kind: DocketNodeKind;
  title: string;
  instructions: string;
  dependsOn: string[];
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
  source: 'hook' | 'telemetry';
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

/* ── P11 · dispatcher ───────────────────────────────────────────────── */

export type QueueKind = 'session' | 'headless' | 'batch';
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

export type QueueSlots = { session: number; headless: number; batch: number };
export const DEFAULT_SLOTS: QueueSlots = { session: 4, headless: 3, batch: 2 };

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
    detail: 'The agent can read, search and look things up on the web. File writes, shell commands and any MCP call that is not a read are denied.',
  },
  project: {
    label: 'Project',
    detail: 'Writes and commands are allowed inside the project directory. Anything outside it is denied.',
  },
  trusted: {
    label: 'Trusted',
    detail: 'Nothing is denied by Wanigan. The OS sandbox and the agent’s own permission prompts are the only limits.',
  },
};

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

/* ── shell settings ─────────────────────────────────────────────────── */

export type WaniganSettings = {
  spendCapUsd: number;
  motion: MotionSetting;
  telemetry: boolean;
  hooks: boolean;
  archiveTranscripts: boolean;
  notifications: boolean;
  slots: QueueSlots;
  eventRetentionDays: number;
  defaultTrust: TrustLevel;
  mcpServerEnabled: boolean;
  pet: boolean;
  learning: LearningSettings;
};

/* ── Wanigan Compound · provider-neutral learning ───────────────────── */

export type KnowledgeKind =
  | 'instruction' | 'rule' | 'memory' | 'skill' | 'mission'
  | 'gate' | 'eval' | 'project-map';
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
  }[];
  estimatedTokens: number;
  omitted: number;
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
