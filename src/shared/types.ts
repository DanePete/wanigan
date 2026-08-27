export type ProviderId = 'claude' | 'codex';

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  bin: string;
  /** Resolved absolute path, or null when the CLI is not installed. */
  path: string | null;
  version: string | null;
  supports: { model: boolean; effort: boolean; permissionMode: boolean };
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
