export type ProviderId = 'claude' | 'codex' | 'glm';

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  bin: string;
  /** Resolved absolute path, or null when the CLI is not installed. */
  path: string | null;
  version: string | null;
  supports: { model: boolean; effort: boolean; permissionMode: boolean; resume: boolean };
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
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
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
 * What a Claude Code process reports about itself over OTLP. Foreman spawns
 * the CLI, so it sets the exporter env and receives this on loopback — no
 * wrapper, no proxy, no transcript parsing.
 */
export type SessionUsage = {
  sessionId: string;
  costUsd: number;
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
  costUsd: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
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
  'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied', 'Notification',
  'Stop', 'StopFailure', 'PreCompact', 'PostCompact', 'FileChanged',
  'SubagentStart', 'SubagentStop',
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];

/** The JSON a hook handler posts to Foreman's loopback listener. */
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
  /** Foreman's own session id, carried through the generated hook config. */
  foreman_session_id?: string;
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

/* ── P9 · worktrees ─────────────────────────────────────────────────── */

export type WorktreeInfo = {
  path: string;
  branch: string | null;
  head: string | null;
  /** The repo this worktree belongs to. */
  repoRoot: string;
  /** Null when Foreman has no session for it — an orphan from a crash. */
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

export type McpServerStatus = {
  id: string;
  name: string;
  connected: boolean;
  lastAt: number | null;
  lastError: string | null;
  toolCalls: number;
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
  /** What Foreman computed from its own pricing table. */
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
    detail: 'The agent can read and search. Writes, shell commands and network calls are denied.',
  },
  project: {
    label: 'Project',
    detail: 'Writes and commands are allowed inside the project directory. Anything outside it is denied.',
  },
  trusted: {
    label: 'Trusted',
    detail: 'Nothing is denied by Foreman. The OS sandbox and the agent’s own permission prompts are the only limits.',
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

export type ForemanSettings = {
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
};
