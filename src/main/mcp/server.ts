import http from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { app } from 'electron';
import * as batch from '../batch';
import { addProject, listProjects, projectById } from '../store';
import { createSession, listSessions } from '../sessions';
import { findRepos } from '../browse';
import { trustFor } from '../policy';
import * as control from '../control';
import type { ProviderId, RunConfig, SourceConfig, SystemBlock } from '../../shared/types';

/**
 * The outbound half of MCP: Wanigan itself, as a server a running session can
 * call. The reason it exists is arithmetic — a session handed ten thousand rows
 * grinds through them one turn at a time at full sync price, when the same work
 * belongs in a batch at half. This gives the agent a way to hand the job over.
 *
 * Transport is Streamable HTTP against the 2026-07-28 spec, deliberately
 * STATELESS: every request is a self-contained POST, answered on its own
 * response. There is no always-open server-to-client SSE stream — that model
 * was replaced, and re-implementing it would mean holding a socket per session
 * for the lifetime of the app.
 */

export const MCP_PROTOCOL_VERSION = '2026-07-28';

/** Older clients negotiate down; anything else is a client we cannot answer. */
const SUPPORTED_PROTOCOLS = new Set([MCP_PROTOCOL_VERSION, '2025-11-25', '2025-06-18', '2025-03-26']);

/** A config with an inline dataset is legitimately large; a 500 MB POST is not. */
const MAX_BODY_BYTES = 16 * 1024 * 1024;

/** Rows returned by one fetch_results call. */
const MAX_PAGE_SIZE = 200;

/**
 * An unanswered confirmation must fail closed. Without this the tool call holds
 * its socket open forever when the window is gone or the user walked away, and
 * the agent sits blocked on a dialog nobody will ever see.
 */
const CONFIRM_TIMEOUT_MS = 5 * 60_000;

type ServerInfo = { port: number; token: string; url: string };
type ConfirmRequest = { tool: string; summary: string; costUsd: number };
type Pending = { id: string; tool: string; summary: string; costUsd: number; at: number };

let server: http.Server | null = null;
let info: ServerInfo | null = null;
let confirmHandler: ((req: ConfirmRequest) => Promise<boolean>) | null = null;
const sockets = new Set<Socket>();
const pending = new Map<string, Pending>();

/* ── JSON-RPC ────────────────────────────────────────────────────────── */

type JsonRpcId = string | number | null;
type JsonRpcMessage = { jsonrpc: '2.0'; id?: JsonRpcId; method: string; params?: unknown };
type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isMessage(v: unknown): v is JsonRpcMessage {
  return isRecord(v) && v.jsonrpc === '2.0' && typeof v.method === 'string';
}

function result(id: JsonRpcId, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function failure(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/* ── tool surface ────────────────────────────────────────────────────── */

const SYSTEM_BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text', 'cache'],
  properties: {
    text: { type: 'string', description: 'System prompt text.' },
    cache: {
      type: 'boolean',
      description:
        'Mark this block with cache_control. Cached blocks must come first and be byte-identical across every row, ' +
        'or nothing caches.',
    },
  },
} as const;

/**
 * The `command` source is missing on purpose: it shells out from Wanigan's own
 * process, which is outside the permission mode and trust level the session was
 * launched under. An agent that wants a command's output can run the command
 * itself and pass the result as csv or jsonl.
 */
const SOURCE_SCHEMA = {
  description: 'Where the rows come from — one row per request.',
  oneOf: [
    {
      type: 'object', additionalProperties: false, required: ['kind', 'text'],
      properties: {
        kind: { const: 'csv' },
        text: { type: 'string', description: 'CSV text including a header row.' },
        delimiter: { type: 'string', description: 'Defaults to a comma.' },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'text'],
      properties: {
        kind: { const: 'jsonl' },
        text: { type: 'string', description: 'One JSON object per line.' },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'root', 'pattern'],
      properties: {
        kind: { const: 'glob' },
        root: { type: 'string', description: 'Absolute directory to search.' },
        pattern: { type: 'string', description: 'Glob, e.g. "src/**/*.ts".' },
        maxBytes: { type: 'integer', description: 'Per-file read ceiling.' },
      },
    },
    {
      type: 'object', additionalProperties: false, required: ['kind', 'root', 'paths'],
      properties: {
        kind: { const: 'files' },
        root: { type: 'string', description: 'Absolute directory the paths are relative to.' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Explicit file list.' },
        maxBytes: { type: 'integer', description: 'Per-file read ceiling.' },
      },
    },
  ],
} as const;

const RUN_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'model', 'maxTokens', 'system', 'userTemplate', 'cacheTtl', 'source'],
  properties: {
    name: { type: 'string', description: 'Human label for the run.' },
    preset: { type: 'string' },
    projectId: { type: 'string', description: 'Wanigan project this run belongs to.' },
    model: { type: 'string', description: 'Model id, e.g. "claude-opus-5".' },
    maxTokens: { type: 'integer', minimum: 1, description: 'Per-request output ceiling.' },
    temperature: { type: 'number' },
    system: { type: 'array', items: SYSTEM_BLOCK_SCHEMA, description: 'System blocks, cached ones first.' },
    userTemplate: {
      type: 'string',
      description: 'Per-row user message. {{column}} slots are filled from the dataset columns.',
    },
    keyColumn: { type: 'string', description: 'Column used to make custom_ids readable. Results come back unordered.' },
    cacheTtl: { enum: ['5m', '1h'], description: 'Prompt cache lifetime.' },
    extendedOutput: { type: 'boolean' },
    effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'], description: 'The single biggest cost lever. Omit for the API default.' },
    thinking: { enum: ['off', 'adaptive'] },
    thinkingDisplay: { enum: ['omitted', 'summarized'] },
    schemaJson: { type: 'string', description: 'JSON Schema string for structured outputs.' },
    source: SOURCE_SCHEMA,
  },
} as const;

type ToolDef = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, boolean>;
  _meta?: Record<string, unknown>;
};

const TOOLS: ToolDef[] = [
  {
    name: 'wanigan_estimate_run',
    title: 'Estimate a batch run',
    description:
      'Price a batch before anything is spent. Counts tokens on a real sample of the dataset and returns a low/high ' +
      'cost band, the cached prefix size, and what the same work would cost on the synchronous API. Always call this first.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['config'],
      properties: {
        config: RUN_CONFIG_SCHEMA,
        observedOutputTokens: { type: 'integer', description: 'Measured output length from a dry run, to replace the 25%-of-max guess.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'wanigan_dry_run',
    title: 'Dry run one row',
    description:
      'Send exactly one row synchronously and return the response and its usage. Batch validation is asynchronous, so ' +
      'this is the only cheap way to find out that the params are malformed before committing the whole dataset. ' +
      'Costs one request.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['config'],
      properties: {
        config: RUN_CONFIG_SCHEMA,
        rowIndex: { type: 'integer', minimum: 0, description: 'Which row to send. Defaults to the first.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'wanigan_submit_run',
    title: 'Submit a batch run (spends money)',
    description:
      'Submit the whole dataset to the Message Batches API. This spends real money and a batch cannot be un-submitted. ' +
      'Wanigan estimates the cost, asks a human to approve that number, and only submits on an affirmative answer — ' +
      'expect this call to block while somebody decides, and to be refused.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['config'],
      properties: { config: RUN_CONFIG_SCHEMA },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  {
    name: 'wanigan_run_status',
    title: 'Run status',
    description: 'Progress, per-status counts, batch state and spend for one run. Prompts and config are not returned.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['runId'],
      properties: { runId: { type: 'string' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wanigan_fetch_results',
    title: 'Fetch results',
    description:
      'A page of finished rows: custom_id, status, output text and usage. Results come back unordered, so key on ' +
      'custom_id rather than position.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['runId'],
      properties: {
        runId: { type: 'string' },
        status: { type: 'string', description: '"all" (default), "failed", or an exact status such as "succeeded".' },
        q: { type: 'string', description: 'Substring filter.' },
        offset: { type: 'integer', minimum: 0 },
        pageSize: { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wanigan_list_runs',
    title: 'List runs',
    description: 'Every run Wanigan knows about, newest first, with status and spend.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },

  /* ── durable Goals ────────────────────────────────────────────────
     A Goal is the contract and evidence surrounding work, not a terminal.
     These tools deliberately expose that record without letting a model mark
     its own work approved or start another agent. ───────────────────── */
  {
    name: 'wanigan_list_goals',
    title: 'List Wanigan Goals',
    description: 'List durable Goals with their project, phase, risk and budget. Goals survive terminal exits and restarts.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { projectId: { type: 'string', description: 'Optional Wanigan project id.' }, limit: { type: 'integer', minimum: 1, maximum: 80 } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wanigan_get_goal',
    title: 'Inspect a Wanigan Goal',
    description: 'Read one Goal’s objective, acceptance checks, tasks, file claims, checkpoints and verification evidence.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['goalId'],
      properties: { goalId: { type: 'string', description: 'Goal id from wanigan_list_goals.' } },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: 'ui://wanigan/goal-inspector' } },
  },
  {
    name: 'wanigan_goal_checkpoint',
    title: 'Record a Goal checkpoint',
    description: 'Record a concise, durable progress checkpoint for the calling session’s own Goal task. It cannot complete, approve, or change another task.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['nodeId', 'note'],
      properties: { nodeId: { type: 'string' }, note: { type: 'string', maxLength: 4000 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: 'wanigan_goal_claim',
    title: 'Claim a Goal file path',
    description: 'Claim a relative project path for the calling session’s own Goal task. Overlapping active claims are refused before concurrent agents collide.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['nodeId', 'path'],
      properties: { nodeId: { type: 'string' }, path: { type: 'string', maxLength: 1000 } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },

  /* ── driving Wanigan itself ─────────────────────────────────────────
     Reading is free. Anything that adds state or starts an agent goes
     through the same human confirmation as spending money, because an
     agent that can spawn agents is a cost and a filesystem reach that
     nobody approved. ─────────────────────────────────────────────── */
  {
    name: 'wanigan_list_projects',
    title: 'List projects',
    description: 'The repositories Wanigan knows about, with their current branch.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wanigan_find_repos',
    title: 'Find a repository on this machine',
    description:
      'Search the usual project locations for a git repository whose folder name matches. ' +
      'Bounded by depth and by a cap on directories visited, and it says when it stopped early. ' +
      'Use this to turn "the polaris project" into a path before adding it.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: {
        query: { type: 'string', description: 'Part of the folder name, e.g. "polaris".' },
        limit: { type: 'integer', description: 'Maximum matches to return. Default 20.' },
        roots: { type: 'array', items: { type: 'string' }, description: 'Directories to search instead of the defaults.' },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wanigan_add_project',
    title: 'Add a project',
    description:
      'Add a directory to Wanigan\'s project list so sessions, batches and Context can target it. ' +
      'Requires a human to approve. Adding a project that already exists returns the existing one.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'],
      properties: { path: { type: 'string', description: 'Absolute path to the directory.' } },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: 'wanigan_list_sessions',
    title: 'List sessions',
    description: 'Agent sessions running right now, with provider, project, model and status.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'wanigan_start_session',
    title: 'Start an agent session',
    description:
      'Open a new agent session in a project. Requires a human to approve, because it spends tokens and ' +
      'gives an agent access to that repository. The session runs under the project\'s trust level, which ' +
      'this tool cannot raise.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['projectId'],
      properties: {
        projectId: { type: 'string', description: 'From wanigan_list_projects or wanigan_add_project.' },
        provider: { type: 'string', enum: ['claude', 'codex', 'glm'], description: 'Default claude.' },
        model: { type: 'string', description: 'Model alias, e.g. opus or sonnet. Omit for the CLI default.' },
        effort: { type: 'string', enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
        prompt: { type: 'string', description: 'Typed into the session once it is ready.' },
        isolate: { type: 'boolean', description: 'Run in a dedicated git worktree.' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
];

const INSTRUCTIONS =
  'Wanigan runs Message Batches over datasets at half the synchronous price. When you are facing more rows than you ' +
  'want to work through a turn at a time, hand them over instead: wanigan_estimate_run to price it, wanigan_dry_run ' +
  'to prove one row works, then wanigan_submit_run. Submitting spends real money and requires a human to approve the ' +
  'estimate — it will block, and it may be declined. Poll wanigan_run_status and collect with wanigan_fetch_results.';

/**
 * A deliberately dependency-free MCP App shell. Hosts that implement MCP Apps
 * may render it beside a Goal result; older hosts retain the structured/text
 * result unchanged. No network is declared, so the sandbox has no reason to
 * grant one.
 */
const GOAL_INSPECTOR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;padding:16px;background:#171714;color:#f2efe7;font:14px/1.45 system-ui,sans-serif}h2{margin:0 0 6px;font-size:18px}p{margin:0;color:#c5c1b8}.hint{margin-top:13px;padding:10px;border-left:2px solid #cfa35f;background:#20201b;color:#dfdacd}
</style></head><body><h2>Wanigan Goal</h2><p>This result is the durable contract for the work: objective, acceptance checks, evidence, claims, and review decision.</p><div class="hint">Use the structured Goal result in this conversation. Wanigan keeps approvals and final completion in Control.</div></body></html>`;

/* ── argument narrowing ──────────────────────────────────────────────── */

function str(v: unknown, label: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${label} is required and must be a non-empty string.`);
  return v;
}
function int(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`${label} is required and must be a whole number.`);
  return v;
}
function optStr(v: unknown, label: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${label} must be a string.`);
  return v;
}
function optNum(v: unknown, label: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${label} must be a number.`);
  return v;
}
function optBool(v: unknown, label: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${label} must be true or false.`);
  return v;
}
function oneOf<T extends string>(v: unknown, allowed: readonly T[], label: string): T | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new Error(`${label} must be one of: ${allowed.join(', ')}.`);
  }
  return v as T;
}

function systemFrom(v: unknown): SystemBlock[] {
  if (!Array.isArray(v)) throw new Error('config.system must be an array of { text, cache } blocks (use [] for none).');
  return v.map((b, i) => {
    if (!isRecord(b)) throw new Error(`config.system[${i}] must be an object with text and cache.`);
    return { text: str(b.text, `config.system[${i}].text`), cache: b.cache === true };
  });
}

function sourceFrom(v: unknown): SourceConfig {
  if (!isRecord(v)) throw new Error('config.source is required — say where the rows come from.');
  const kind = v.kind;
  if (kind === 'csv') return { kind, text: str(v.text, 'config.source.text'), delimiter: optStr(v.delimiter, 'config.source.delimiter') };
  if (kind === 'jsonl') return { kind, text: str(v.text, 'config.source.text') };
  if (kind === 'glob') {
    return { kind, root: str(v.root, 'config.source.root'), pattern: str(v.pattern, 'config.source.pattern'), maxBytes: optNum(v.maxBytes, 'config.source.maxBytes') };
  }
  if (kind === 'files') {
    if (!Array.isArray(v.paths) || v.paths.some((p) => typeof p !== 'string')) {
      throw new Error('config.source.paths must be an array of file paths.');
    }
    return { kind, root: str(v.root, 'config.source.root'), paths: v.paths as string[], maxBytes: optNum(v.maxBytes, 'config.source.maxBytes') };
  }
  if (kind === 'command') {
    // Refused, not unimplemented: this would run a shell command out of
    // Wanigan's process, which is not the process the session's permission mode
    // and trust level apply to. Say so, rather than letting it read as a bug.
    throw new Error(
      'The "command" source is not available over MCP — it would run a shell command outside the permission mode this ' +
      'session was launched under. Run the command yourself and pass its output as a csv or jsonl source.'
    );
  }
  throw new Error('config.source.kind must be one of: csv, jsonl, glob, files.');
}

function runConfigFrom(args: Record<string, unknown>): RunConfig {
  const c = args.config;
  if (!isRecord(c)) throw new Error('config is required — it describes the model, the prompt and the dataset.');
  const cfg: RunConfig = {
    name: str(c.name, 'config.name'),
    model: str(c.model, 'config.model'),
    maxTokens: int(c.maxTokens, 'config.maxTokens'),
    system: systemFrom(c.system),
    userTemplate: str(c.userTemplate, 'config.userTemplate'),
    cacheTtl: c.cacheTtl === '1h' ? '1h' : '5m',
    source: sourceFrom(c.source),
  };
  const preset = optStr(c.preset, 'config.preset');
  if (preset) cfg.preset = preset;
  const projectId = optStr(c.projectId, 'config.projectId');
  if (projectId) cfg.projectId = projectId;
  const temperature = optNum(c.temperature, 'config.temperature');
  if (temperature !== undefined) cfg.temperature = temperature;
  const keyColumn = optStr(c.keyColumn, 'config.keyColumn');
  if (keyColumn) cfg.keyColumn = keyColumn;
  const extendedOutput = optBool(c.extendedOutput, 'config.extendedOutput');
  if (extendedOutput !== undefined) cfg.extendedOutput = extendedOutput;
  const effort = oneOf(c.effort, ['low', 'medium', 'high', 'xhigh', 'max'] as const, 'config.effort');
  if (effort) cfg.effort = effort;
  const thinking = oneOf(c.thinking, ['off', 'adaptive'] as const, 'config.thinking');
  if (thinking) cfg.thinking = thinking;
  const thinkingDisplay = oneOf(c.thinkingDisplay, ['omitted', 'summarized'] as const, 'config.thinkingDisplay');
  if (thinkingDisplay) cfg.thinkingDisplay = thinkingDisplay;
  const schemaJson = optStr(c.schemaJson, 'config.schemaJson');
  if (schemaJson) cfg.schemaJson = schemaJson;
  return cfg;
}

function pick(row: unknown, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isRecord(row)) return out;
  for (const k of keys) if (k in row) out[k] = row[k];
  return out;
}

/* ── the money gate ──────────────────────────────────────────────────── */

/**
 * An agent that can spend money with no human in the loop is a budget incident
 * waiting for a bad prompt. Every path to createAndSubmitRun goes through here,
 * and every failure mode — no handler registered, a decline, a handler that
 * throws, a dialog nobody answers — resolves to "no".
 */
async function confirmSpend(tool: string, summary: string, costUsd: number): Promise<boolean> {
  const fn = confirmHandler;
  if (!fn) return false;
  const entry: Pending = { id: `cfm_${randomBytes(6).toString('hex')}`, tool, summary, costUsd, at: Date.now() };
  pending.set(entry.id, entry);
  let timer: NodeJS.Timeout | undefined;
  try {
    const answered = await Promise.race([
      fn({ tool, summary, costUsd }),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), CONFIRM_TIMEOUT_MS); }),
    ]);
    return answered === true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    pending.delete(entry.id);
  }
}

/* ── tools ───────────────────────────────────────────────────────────── */

type ToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(payload: Record<string, unknown>): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(name: string, args: Record<string, unknown>, callerSessionId: string | null): Promise<ToolResult> {
  switch (name) {
    case 'wanigan_estimate_run': {
      const cfg = runConfigFrom(args);
      const observed = optNum(args.observedOutputTokens, 'observedOutputTokens');
      const r = await batch.estimateRun(cfg, observed);
      if (!r.estimate) return toolError(`This run cannot be estimated: ${r.errors.join(' ')}`);
      return ok({ estimate: r.estimate, warnings: r.warnings, errors: r.errors, chunks: r.chunks ?? 1 });
    }

    case 'wanigan_dry_run': {
      const cfg = runConfigFrom(args);
      const rowIndex = optNum(args.rowIndex, 'rowIndex');
      const r = await batch.dryRunOne(cfg, rowIndex);
      if (!r.result) return toolError(`This run cannot be built: ${r.errors.join(' ')}`);
      // The rendered prompt is deliberately not echoed back: the caller wrote
      // it, and returning it only widens the set of places it can be logged.
      return ok({ rowIndex: r.rowIndex, result: r.result, errors: r.errors });
    }

    case 'wanigan_submit_run': {
      const cfg = runConfigFrom(args);

      // createAndSubmitRun only enforces the spend cap against an estimate it is
      // handed — submitting without one silently makes the cap a no-op. So the
      // estimate is not optional here, and the number the human approves is the
      // same number the cap is checked against.
      const est = await batch.estimateRun(cfg);
      if (!est.estimate) return toolError(`This run cannot be submitted: ${est.errors.join(' ')}`);
      const e = est.estimate;
      const summary =
        `${cfg.name}: ${e.requests.toLocaleString()} requests to ${cfg.model}, ` +
        `$${e.costLowUsd.toFixed(2)}–$${e.costHighUsd.toFixed(2)}. A batch cannot be un-submitted.`;

      const approved = await confirmSpend('wanigan_submit_run', summary, e.costHighUsd);
      if (!approved) {
        return toolError(
          confirmHandler
            ? `A human declined this submission (${summary}). Nothing was submitted and nothing was spent. ` +
              'Do not retry it — ask in the session for what to change.'
            : 'Confirmation is unavailable: no human can be asked to approve this spend right now, so nothing was ' +
              'submitted. The Wanigan window has to be open to approve a batch.'
        );
      }

      const sub = await batch.createAndSubmitRun(cfg, {
        // The cap is checked against the ceiling, not the optimistic band: a
        // human who approves "$2" and gets billed $9 was not asked the question.
        estimate: { input: e.totalInputTokens, output: e.worstCaseOutputTokens, cost: e.costHighUsd },
      });
      void batch.pollOnce().catch(() => { /* the main-process timer retries */ });
      return ok({ runId: sub.runId, batchIds: sub.batchIds, requests: sub.requests, approvedCostUsd: e.costHighUsd });
    }

    case 'wanigan_run_status': {
      const runId = str(args.runId, 'runId');
      const d = batch.runDetail(runId);
      // config and config_json carry the system prompt and the whole dataset
      // template. Any session could otherwise read every other run's prompts.
      return ok({
        run: pick(d.run, [
          'id', 'name', 'model', 'status', 'total_requests', 'in_tokens', 'out_tokens',
          'cache_read', 'cache_write', 'cost_usd', 'est_cost_usd', 'error',
          'created_at', 'submitted_at', 'ended_at', 'parent_run_id',
        ]),
        counts: d.counts,
        batches: d.batches.map((b) => pick(b, ['id', 'chunk_index', 'processing_status', 'request_count', 'expires_at', 'ended_at'])),
      });
    }

    case 'wanigan_fetch_results': {
      const runId = str(args.runId, 'runId');
      const status = optStr(args.status, 'status') ?? 'all';
      const q = optStr(args.q, 'q') ?? '';
      const offset = optNum(args.offset, 'offset') ?? 0;
      // A whole 10,000-row result set poured into a context window spends back
      // everything the batch just saved.
      const pageSize = Math.min(optNum(args.pageSize, 'pageSize') ?? 50, MAX_PAGE_SIZE);
      const r = batch.runResults(runId, status, q, offset, pageSize);
      return ok({
        total: r.total,
        offset: r.offset,
        pageSize: r.pageSize,
        rows: r.rows.map((row) => pick(row, [
          'custom_id', 'row_index', 'status', 'output_text', 'output_json', 'stop_reason',
          'error_type', 'error_message', 'in_tokens', 'out_tokens', 'cache_read', 'cache_write',
        ])),
      });
    }

    case 'wanigan_list_projects':
      return ok({ projects: listProjects().map((p) => ({ id: p.id, name: p.name, path: p.path, branch: p.branch })) });

    case 'wanigan_find_repos': {
      const q = str(args.query, 'query');
      const limit = typeof args.limit === 'number' ? Math.min(50, Math.max(1, args.limit)) : 20;
      const roots = Array.isArray(args.roots) ? args.roots.filter((r): r is string => typeof r === 'string') : undefined;
      const r = findRepos(q, { limit, roots });
      const known = new Set(listProjects().map((p) => p.path));
      return ok({
        repos: r.repos.map((x) => ({ name: x.name, path: x.path, alreadyAdded: known.has(x.path) })),
        searched: r.roots,
        directoriesVisited: r.visited,
        // Say it plainly rather than letting an empty result imply the repo
        // does not exist anywhere on the machine.
        truncated: r.truncated,
        note: r.truncated
          ? 'The search stopped at its ceiling, so this list may be incomplete. Narrow it with "roots".'
          : null,
      });
    }

    case 'wanigan_add_project': {
      const dir = str(args.path, 'path');
      const existing = listProjects().find((p) => p.path === dir);
      if (existing) return ok({ project: existing, alreadyExisted: true });

      const approved = await confirmSpend('wanigan_add_project', `Add ${dir} to Wanigan's projects.`, 0);
      if (!approved) {
        return toolError(
          confirmHandler
            ? `A human declined adding ${dir}. Nothing was changed.`
            : 'Confirmation is unavailable: the Wanigan window has to be open to approve this.'
        );
      }
      return ok({ project: await addProject(dir), alreadyExisted: false });
    }

    case 'wanigan_list_sessions':
      return ok({
        sessions: listSessions().map((x) => ({
          id: x.id, provider: x.providerId, project: x.projectName, path: x.projectPath,
          model: x.model ?? null, effort: x.effort ?? null, status: x.status,
          trust: x.trust ?? null, worktree: x.worktree ?? null,
        })),
      });

    case 'wanigan_start_session': {
      const projectId = str(args.projectId, 'projectId');
      const project = projectById(projectId);
      if (!project) return toolError(`No project ${projectId}. Call wanigan_list_projects for the current list.`);

      const provider = (typeof args.provider === 'string' ? args.provider : 'claude') as ProviderId;
      const trust = trustFor(projectId);
      const summary =
        `Start a ${provider} session in ${project.name} (${project.path}) at ${trust} trust` +
        `${typeof args.model === 'string' && args.model ? `, model ${args.model}` : ''}.`;

      const approved = await confirmSpend('wanigan_start_session', summary, 0);
      if (!approved) {
        return toolError(
          confirmHandler
            ? `A human declined starting that session. Nothing was launched. Do not retry it — ask what to change.`
            : 'Confirmation is unavailable: the Wanigan window has to be open to approve starting an agent.'
        );
      }

      const s = await createSession({
        providerId: provider,
        projectId,
        model: typeof args.model === 'string' ? args.model : undefined,
        effort: typeof args.effort === 'string' ? args.effort : undefined,
        initialPrompt: typeof args.prompt === 'string' ? args.prompt : undefined,
        isolate: args.isolate === true,
      });
      return ok({
        sessionId: s.id, project: s.projectName, provider: s.providerId,
        trust: s.trust ?? null, worktree: s.worktree ?? null,
        note: 'The session is open in Wanigan. It runs under the project trust level, which this tool cannot raise.',
      });
    }

    case 'wanigan_list_runs': {
      const runs = batch.listRuns().map((r) => pick(r, [
        'id', 'name', 'model', 'status', 'total_requests', 'succeeded', 'failed', 'pending',
        'cost_usd', 'est_cost_usd', 'project_name', 'created_at', 'submitted_at', 'ended_at',
      ]));
      return ok({ runs });
    }

    case 'wanigan_list_goals': {
      const projectId = optStr(args.projectId, 'projectId');
      const limit = optNum(args.limit, 'limit');
      return ok({ goals: control.listDockets(projectId, limit ?? 80) });
    }

    case 'wanigan_get_goal': {
      const goal = control.docket(str(args.goalId, 'goalId'));
      return ok({ goal });
    }

    case 'wanigan_goal_checkpoint': {
      if (!callerSessionId) return toolError('Goal checkpoints require a Wanigan-generated per-session MCP config. This caller can read Goals but cannot mutate them.');
      const checkpoint = control.checkpointForSession(callerSessionId, str(args.nodeId, 'nodeId'), str(args.note, 'note'));
      return ok({ checkpoint, note: 'Checkpoint recorded. Completing or approving a Goal remains an operator-controlled Control action.' });
    }

    case 'wanigan_goal_claim': {
      if (!callerSessionId) return toolError('Goal claims require a Wanigan-generated per-session MCP config. This caller can read Goals but cannot mutate them.');
      const claim = control.claimForSession(callerSessionId, str(args.nodeId, 'nodeId'), str(args.path, 'path'));
      return ok({ claim });
    }

    default:
      return toolError(`No such tool: ${name}. Call tools/list to see what this server offers.`);
  }
}

/* ── protocol ────────────────────────────────────────────────────────── */

async function dispatch(msg: JsonRpcMessage, callerSessionId: string | null): Promise<JsonRpcResponse | null> {
  const id: JsonRpcId = msg.id ?? null;

  // A message with no id is a notification: it gets no response, and it is not
  // executed either. A tools/call arriving as a notification would spend money
  // with nowhere to deliver the answer, which is the worst of both.
  if (msg.id === undefined || msg.id === null) return null;

  switch (msg.method) {
    case 'initialize':
      return result(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
        serverInfo: { name: 'wanigan', title: 'Wanigan', version: app.getVersion() },
        instructions: INSTRUCTIONS,
      });

    // Only reachable from a client that wrongly gave the notification an id;
    // an empty result is a kinder answer than "method not found".
    case 'notifications/initialized':
      return result(id, {});

    case 'ping':
      return result(id, {});

    case 'tools/list':
      return result(id, { tools: TOOLS });

    case 'resources/list':
      return result(id, { resources: [{ uri: 'ui://wanigan/goal-inspector', name: 'Wanigan Goal inspector', mimeType: 'text/html', description: 'A sandboxed, network-free companion view for durable Goal results.' }] });

    case 'resources/read': {
      const params = isRecord(msg.params) ? msg.params : {};
      if (params.uri !== 'ui://wanigan/goal-inspector') return failure(id, INVALID_PARAMS, 'Unknown Wanigan resource URI.');
      return result(id, { contents: [{ uri: 'ui://wanigan/goal-inspector', mimeType: 'text/html', text: GOAL_INSPECTOR_HTML }] });
    }

    case 'tools/call': {
      const params = isRecord(msg.params) ? msg.params : {};
      const name = typeof params.name === 'string' ? params.name : '';
      if (!name) return failure(id, INVALID_PARAMS, 'tools/call needs a "name".');
      const args = isRecord(params.arguments) ? params.arguments : {};
      try {
        return result(id, await callTool(name, args, callerSessionId));
      } catch (e) {
        // A bad argument or a rejected run is the tool's answer, not a
        // protocol failure — reported inside the result so the model reads it
        // and can correct itself, rather than as an error the client swallows.
        return result(id, toolError(e instanceof Error ? e.message : String(e)));
      }
    }

    default:
      return failure(id, METHOD_NOT_FOUND, `Unknown method "${msg.method}".`);
  }
}

/* ── transport ───────────────────────────────────────────────────────── */

function send(res: http.ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}) {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    ...extra,
  });
  res.end(text);
}

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a.startsWith('127.');
}

/**
 * A page in the user's browser can POST to a loopback port and, without an
 * Origin check, that request looks local. The bearer token already stops it,
 * but a listener that only has one lock is a listener one bug away from open.
 */
function originAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
  } catch {
    return false;
  }
}

function authorized(req: http.IncomingMessage): boolean {
  if (!info) return false;
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!m) return false;
  const given = Buffer.from(m[1]);
  const want = Buffer.from(info.token);
  return given.length === want.length && timingSafeEqual(given, want);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        // Paused, not destroyed. Destroying resets the connection before the
        // caller can write its 413, so the client sees a socket error instead
        // of the sentence explaining what was wrong with its request.
        req.pause();
        chunks.length = 0;
        reject(new Error(`Request body is larger than ${Math.round(MAX_BODY_BYTES / 1024 / 1024)} MB. Send a smaller message.`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!isLoopback(req.socket.remoteAddress)) {
    // The socket is bound to 127.0.0.1 already; this is the belt to that
    // braces, and it costs one string comparison.
    res.socket?.destroy();
    return;
  }
  if (!originAllowed(req)) {
    send(res, 403, failure(null, INVALID_REQUEST, 'Cross-origin requests are not accepted by this server.'));
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/' && url.pathname !== '/mcp') {
    send(res, 404, failure(null, INVALID_REQUEST, 'The MCP endpoint is /mcp.'));
    return;
  }

  if (!authorized(req)) {
    send(res, 401, failure(null, INVALID_REQUEST, 'Missing or invalid bearer token. Wanigan writes the token into the MCP config it generates for a session.'),
      { 'www-authenticate': 'Bearer realm="wanigan"' });
    return;
  }

  if (req.method !== 'POST') {
    // 2026-07-28 is stateless: there is no long-lived stream to open on GET and
    // no session to delete on DELETE. Saying 405 is how a client learns that.
    send(res, 405, failure(null, INVALID_REQUEST, 'This server is stateless: POST a JSON-RPC message. There is no SSE stream to open.'), { allow: 'POST' });
    return;
  }

  const version = req.headers['mcp-protocol-version'];
  if (typeof version === 'string' && !SUPPORTED_PROTOCOLS.has(version)) {
    send(res, 400, failure(null, INVALID_REQUEST, `Unsupported MCP-Protocol-Version "${version}". This server speaks ${MCP_PROTOCOL_VERSION}.`));
    return;
  }

  const type = (req.headers['content-type'] ?? '').toString().toLowerCase();
  if (!type.includes('application/json')) {
    send(res, 415, failure(null, INVALID_REQUEST, 'Send Content-Type: application/json.'));
    return;
  }

  let raw: string;
  try {
    raw = await readBody(req);
  } catch (e) {
    // The request was paused rather than destroyed, so the rest of the body is
    // still queued on the socket; closing after this answer is what actually
    // takes it down, once the status has flushed.
    send(res, 413, failure(null, INVALID_REQUEST, e instanceof Error ? e.message : 'Could not read the request body.'), { connection: 'close' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    send(res, 400, failure(null, PARSE_ERROR, 'Request body is not valid JSON.'));
    return;
  }

  if (Array.isArray(parsed)) {
    // JSON-RPC batching was removed from MCP; a client sending an array is
    // speaking an older dialect and should be told so plainly.
    send(res, 400, failure(null, INVALID_REQUEST, 'JSON-RPC batching is not part of this protocol version. Send one message per request.'));
    return;
  }
  if (!isMessage(parsed)) {
    send(res, 400, failure(null, INVALID_REQUEST, 'Expected a JSON-RPC 2.0 message with "jsonrpc" and "method".'));
    return;
  }

  try {
    const sessionHeader = req.headers['x-wanigan-session'];
    const callerSessionId = typeof sessionHeader === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(sessionHeader)
      ? sessionHeader : null;
    const answer = await dispatch(parsed, callerSessionId);
    // A notification has no reply: 202 with an empty body is the whole answer.
    if (!answer) { send(res, 202, null); return; }
    send(res, 200, answer);
  } catch (e) {
    send(res, 200, failure(parsed.id ?? null, INTERNAL_ERROR, e instanceof Error ? e.message : String(e)));
  }
}

/* ── lifecycle ───────────────────────────────────────────────────────── */

export async function startMcpServer(): Promise<ServerInfo> {
  if (info && server) return info;

  const token = randomBytes(32).toString('base64url');
  const s = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      // Nothing about a failed request is worth crashing the app for, and the
      // body may hold prompt text, so it is never logged.
      try { send(res, 500, failure(null, INTERNAL_ERROR, 'Wanigan failed to handle that request.')); } catch { /* socket gone */ }
    });
  });
  s.on('connection', (sock: Socket) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  // A fixed port would collide with a second Wanigan window or a leftover
  // process; the generated config is rewritten at session launch anyway, so an
  // ephemeral port costs nothing.
  const wanted = Number(process.env.WANIGAN_MCP_PORT) || 0;

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      reject(new Error(
        e.code === 'EADDRINUSE'
          ? `Port ${wanted} is already in use, so Wanigan's MCP server could not start. Free the port or unset WANIGAN_MCP_PORT to let the OS pick one.`
          : `Wanigan's MCP server could not start: ${e.message}`
      ));
    };
    s.once('error', onError);
    s.listen(wanted, '127.0.0.1', () => { s.off('error', onError); resolve(); });
  });

  const addr = s.address();
  if (!addr || typeof addr === 'string') {
    s.close();
    throw new Error('Wanigan\'s MCP server started without a usable address. Restart Wanigan.');
  }

  // Post-startup socket noise — an EMFILE on accept when the app is running a
  // dozen PTYs, an agent killed mid-post — is not a reason to tear the server
  // down. It used to call stopMcpServer(), and nothing ever restarts it:
  // startMcpServer runs once at boot, so one transient accept error left every
  // running session's wanigan_* tools failing and every later session with no
  // MCP config at all, until the app was quit. Bind errors are still surfaced,
  // by the `once('error')` above, before this handler is installed. Matches
  // hooks.ts and notify.ts, which both swallow post-listen errors deliberately.
  s.on('error', (e) => { console.warn('[wanigan] MCP server socket error (ignored):', e); });

  server = s;
  info = { port: addr.port, token, url: `http://127.0.0.1:${addr.port}/mcp` };
  return info;
}

export function stopMcpServer(): void {
  // Sockets are destroyed rather than drained: a keep-alive connection from a
  // still-running agent would otherwise hold the listener open past quit.
  for (const sock of sockets) sock.destroy();
  sockets.clear();
  pending.clear();
  server?.close();
  server = null;
  info = null;
}

export function mcpServerInfo(): ServerInfo | null {
  return info ? { ...info } : null;
}

export function setConfirmHandler(fn: ((req: ConfirmRequest) => Promise<boolean>) | null): void {
  confirmHandler = fn;
}

export function pendingConfirmations(): Pending[] {
  return [...pending.values()].sort((a, b) => a.at - b.at);
}
