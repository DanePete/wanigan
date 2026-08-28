import { contextBridge, ipcRenderer } from 'electron';
import type {
  LaunchOptions, PastSession, Project, ProviderInfo, Session, RunConfig, SourceConfig,
  SessionUsage, ApiEvent, SessionEvent, Attention, TranscriptHit, TranscriptTurn,
  WorktreeInfo, HeadlessConfig, HeadlessRow, QueueItem, QueueKind, QueueSlots, QueueState,
  McpServerConfig, McpServerStatus, BudgetState, Reconciliation, TrustLevel, LedgerEntry,
  WaniganSettings, UploadedFile, EvalPair, GoldenSet,
} from '../shared/types';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/** Unwraps the main process envelope so callers see values or thrown errors. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const res = (await ipcRenderer.invoke(channel, ...args)) as Result<T>;
  if (!res.ok) throw new Error(res.error);
  return res.data;
}

const api = {
  providers: {
    list: () => call<ProviderInfo[]>('providers:list'),
  },
  projects: {
    list: () => call<Project[]>('projects:list'),
    refresh: () => call<Project[]>('projects:refresh'),
    add: (dir: string) => call<Project>('projects:add', dir),
    pick: () => call<Project | null>('projects:pick'),
    remove: (id: string) => call<Project[]>('projects:remove', id),
  },
  sessions: {
    list: () => call<Session[]>('sessions:list'),
    create: (opts: LaunchOptions) => call<Session>('sessions:create', opts),
    scrollback: (id: string) => call<string>('sessions:scrollback', id),
    interrupt: (id: string, force?: boolean) => call<boolean>('sessions:interrupt', id, force),
    kill: (id: string) => call<boolean>('sessions:kill', id),
    close: (id: string) => call<boolean>('sessions:close', id),
    markRead: (id: string) => call<boolean>('sessions:markRead', id),
    reveal: (p: string) => call<boolean>('sessions:reveal', p),
    baseline: (id: string) => call<{ head: string | null; dirty: string[]; at: number } | null>('sessions:baseline', id),
    past: () => call<PastSession[]>('sessions:past'),
    forget: (id: string) => call<PastSession[]>('sessions:forget', id),
    write: (id: string, data: string) => ipcRenderer.send('sessions:write', id, data),
    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send('sessions:resize', id, cols, rows),
  },
  batch: {
    presets: (projectId?: string) => call<any>('batch:presets', projectId),
    refreshModels: () => call<{ models: unknown[]; fetchedAt: number; source: string }>('batch:refreshModels'),
    insights: () => call<any>('batch:insights'),
    preview: (source: SourceConfig, userTemplate: string) => call<any>('batch:preview', source, userTemplate),
    estimate: (config: RunConfig, observed?: number) => call<any>('batch:estimate', config, observed),
    dryRun: (config: RunConfig, rowIndex?: number) => call<any>('batch:dryRun', config, rowIndex),
    runs: () => call<any[]>('batch:runs'),
    run: (id: string) => call<any>('batch:run', id),
    results: (id: string, status: string, q: string, offset: number) =>
      call<any>('batch:results', id, status, q, offset),
    submit: (config: RunConfig, est?: { input: number; output: number; cost: number }) =>
      call<{ runId: string; batchIds: string[]; requests: number }>('batch:submit', config, est),
    cancel: (id: string) => call<any>('batch:cancel', id),
    retry: (id: string) => call<{ runId: string }>('batch:retry', id),
    remove: (id: string) => call<boolean>('batch:delete', id),
    poll: () => call<any>('batch:poll'),
    exportTo: (id: string, format: 'jsonl' | 'csv') => call<string | null>('batch:export', id, format),
  },
  code: {
    editors: () => call<{ id: string; label: string; path: string }[]>('code:editors'),
    open: (editorPath: string | null, target: string, line?: number) =>
      call<{ opened: string }>('code:open', editorPath, target, line),
    changes: (root: string, sessionId?: string) => call<{
      isRepo: boolean; branch: string | null; headMoved: boolean; commits: number;
      files: { path: string; index: string; work: string; staged: boolean; untracked: boolean;
               preexisting?: boolean; committed?: boolean }[];
    }>('code:changes', root, sessionId),
    diff: (root: string, file: string) => call<string>('code:diff', root, file),
    list: (root: string, rel: string) =>
      call<{ name: string; rel: string; dir: boolean; size: number }[]>('code:list', root, rel),
    read: (root: string, rel: string) =>
      call<{ text: string; truncated: boolean; size: number; binary: boolean }>('code:read', root, rel),
  },
  settings: {
    get: () => call<{ spendCapUsd: number }>('settings:get'),
    setSpendCap: (v: number) => call<number>('settings:setSpendCap', v),
  },
  key: {
    status: () => call<{ present: boolean; fingerprint: string | null; encryptionAvailable: boolean; fromEnv: boolean; workspaceId: string | null }>('key:status'),
    set: (k: string, workspaceId?: string) =>
      call<{ detail: string; batches: boolean; fingerprint: string | null }>('key:set', k, workspaceId),
    verify: () => call<{ ok: boolean; detail: string; batches: boolean }>('key:verify'),
    provider: (id: string) => call<{ present: boolean; fingerprint: string | null }>('key:provider', id),
    setProvider: (id: string, key: string) =>
      call<{ present: boolean; fingerprint: string | null }>('key:setProvider', id, key),
    clearProvider: (id: string) => call<boolean>('key:clearProvider', id),
    glmModels: (force?: boolean) =>
      call<{ models: { id: string; label: string; source: string }[]; note: string | null; fetchedAt: number | null }>('glm:models', force),
    clear: () => call<boolean>('key:clear'),
  },

  // ── phase 1 · telemetry ──────────────────────────────────────────────
  usage: {
    session: (id: string) => call<SessionUsage>('usage:session', id),
    many: (ids: string[]) => call<Record<string, SessionUsage>>('usage:many', ids),
    events: (id: string, limit?: number) => call<ApiEvent[]>('usage:events', id, limit),
    throughput: (id: string, buckets?: number) => call<number[]>('usage:throughput', id, buckets),
    collector: () => call<{ port: number | null }>('usage:collector'),
  },
  // ── phases 2/3/8 · events, attention, timeline ───────────────────────
  events: {
    session: (id: string, limit?: number) => call<SessionEvent[]>('events:session', id, limit),
    live: (id: string) => call<{ tool: string | null; since: number; blocked: boolean; lastAt: number | null }>('events:live', id),
    tools: (id: string) => call<{ toolName: string; calls: number; totalMs: number; failures: number }[]>('events:tools', id),
  },
  attention: {
    list: () => call<Attention[]>('attention:list'),
  },
  // ── phase 4 · transcripts ────────────────────────────────────────────
  transcripts: {
    search: (q: string, limit?: number) => call<TranscriptHit[]>('transcripts:search', q, limit),
    get: (id: string) => call<{ turns: TranscriptTurn[]; note: string | null; bytes: number }>('transcripts:get', id),
    list: () => call<{ sessionId: string; bytes: number; turns: number; archivedAt: number }[]>('transcripts:list'),
    forget: (id: string) => call<boolean>('transcripts:forget', id),
  },
  // ── phase 9 · worktrees ──────────────────────────────────────────────
  worktrees: {
    list: (repoRoot: string) => call<WorktreeInfo[]>('worktrees:list', repoRoot),
    status: (p: string) => call<WorktreeInfo | null>('worktrees:status', p),
    remove: (p: string, force: boolean) => call<{ removed: boolean; detail: string }>('worktrees:remove', p, force),
    orphans: () => call<WorktreeInfo[]>('worktrees:orphans'),
    relink: (p: string) => call<{ path: string; kind: string; bytes: number | null }[]>('worktrees:relink', p),
    forSession: (id: string) => call<string | null>('worktrees:forSession', id),
  },
  // ── phase 10 · headless fan-out ──────────────────────────────────────
  headless: {
    start: (cfg: HeadlessConfig) => call<{ runId: string; rows: number }>('headless:start', cfg),
    rows: (runId: string) => call<HeadlessRow[]>('headless:rows', runId),
    runs: (limit?: number) => call<unknown[]>('headless:runs', limit),
    cancel: (runId: string) => call<number>('headless:cancel', runId),
  },
  // ── phase 11 · dispatcher ────────────────────────────────────────────
  queue: {
    list: (limit?: number) => call<QueueItem[]>('queue:list', limit),
    counts: () => call<Record<QueueState, number>>('queue:counts'),
    cancel: (id: string) => call<boolean>('queue:cancel', id),
    slots: () => call<QueueSlots>('queue:slots'),
    setSlots: (next: Partial<QueueSlots>) => call<QueueSlots>('queue:setSlots', next),
    enqueue: (kind: QueueKind, label: string, payload: unknown, priority?: number) =>
      call<QueueItem>('queue:enqueue', kind, label, payload, priority),
  },
  // ── phase 12 · MCP ───────────────────────────────────────────────────
  mcp: {
    servers: (projectId?: string | null) => call<McpServerConfig[]>('mcp:servers', projectId),
    upsert: (cfg: Omit<McpServerConfig, 'id'> & { id?: string }) => call<McpServerConfig>('mcp:upsert', cfg),
    remove: (id: string) => call<boolean>('mcp:remove', id),
    status: () => call<McpServerStatus[]>('mcp:status'),
    server: () => call<{ port: number; token: string; url: string } | null>('mcp:server'),
    pending: () => call<{ id: string; tool: string; summary: string; costUsd: number; at: number }[]>('mcp:pending'),
  },
  // ── phases 5/18 · spend and budgets ──────────────────────────────────
  spend: {
    byProject: (days?: number) => call<unknown[]>('spend:byProject', days),
    cache: () => call<{ surface: string; read: number; write: number; input: number; rate: number; note: string }[]>('spend:cache'),
    sync: (days?: number) => call<{ day: string; actualUsd: number; syncUsd: number }[]>('spend:sync'),
    effort: () => call<{ effort: string; requests: number; costUsd: number }[]>('spend:effort'),
    byDay: (days: number) => call<{ day: string; sessionUsd: number }[]>('spend:byDay', days),
  },
  budgets: {
    list: () => call<BudgetState[]>('budgets:list'),
    set: (scopeId: string | null, monthly: number, warnAt?: number) => call<BudgetState[]>('budgets:set', scopeId, monthly, warnAt),
    breached: () => call<BudgetState[]>('budgets:breached'),
    reconcile: (from: string, to: string) => call<Reconciliation>('budgets:reconcile', from, to),
    accuracy: () => call<{ model: string; runs: number; estUsd: number; actualUsd: number; ratio: number }[]>('budgets:accuracy'),
  },
  // ── phase 14 · notifications ─────────────────────────────────────────
  notify: {
    expiring: () => call<unknown[]>('notify:expiring'),
    resultsExpiring: () => call<unknown[]>('notify:resultsExpiring'),
    enabled: () => call<boolean>('notify:enabled'),
    setEnabled: (on: boolean) => call<boolean>('notify:setEnabled', on),
  },
  // ── phase 19 · trust and the ledger ──────────────────────────────────
  policy: {
    trust: (projectId: string | null) => call<TrustLevel>('policy:trust', projectId),
    setTrust: (projectId: string, level: TrustLevel) => call<TrustLevel>('policy:setTrust', projectId, level),
    defaultTrust: () => call<TrustLevel>('policy:defaultTrust'),
    setDefaultTrust: (level: TrustLevel) => call<TrustLevel>('policy:setDefaultTrust', level),
    ledger: (limit?: number, deniedOnly?: boolean) => call<LedgerEntry[]>('policy:ledger', limit, deniedOnly),
    summary: () => call<{ denied: number; asked: number; allowed: number; since: number | null }>('policy:summary'),
    exportTo: () => call<{ path: string; rows: number } | null>('policy:export'),
  },
  // ── phase 22 · skills ────────────────────────────────────────────────
  skills: {
    list: (projectId?: string) => call<any>('skills:list', projectId),
    refresh: () => call<boolean>('skills:refresh'),
    body: (p: string) => call<{ text: string; truncated: boolean; bytes: number }>('skills:body', p),
    send: (sessionId: string, invoke: string) => call<boolean>('skills:send', sessionId, invoke),
  },
  demo: {
    state: () => call<{ on: boolean; map: { real: string; fake: string }[] }>('demo:state'),
    set: (on: boolean) => call<{ on: boolean; map: { real: string; fake: string }[] }>('demo:set', on),
  },
  // ── phase 28 · git ───────────────────────────────────────────────────
  git: {
    status: (root: string) => call<any>('git:status', root),
    log: (root: string, opts?: { limit?: number; all?: boolean }) => call<any[]>('git:log', root, opts),
    branches: (root: string) => call<any[]>('git:branches', root),
    stashes: (root: string) => call<any[]>('git:stashes', root),
    commitDiff: (root: string, hash: string) => call<any>('git:commitDiff', root, hash),
    fileDiff: (root: string, file: string, staged: boolean) => call<string>('git:fileDiff', root, file, staged),
    stage: (root: string, files: string[]) => call<boolean>('git:stage', root, files),
    unstage: (root: string, files: string[]) => call<boolean>('git:unstage', root, files),
    discard: (root: string, tracked: string[], untracked: string[]) => call<boolean>('git:discard', root, tracked, untracked),
    commit: (root: string, msg: string, opts?: { amend?: boolean; all?: boolean }) => call<string>('git:commit', root, msg, opts),
    checkout: (root: string, ref: string, create?: boolean) => call<boolean>('git:checkout', root, ref, create),
    deleteBranch: (root: string, name: string, force?: boolean) => call<boolean>('git:deleteBranch', root, name, force),
    merge: (root: string, ref: string) => call<string>('git:merge', root, ref),
    fetch: (root: string) => call<string>('git:fetch', root),
    pull: (root: string) => call<string>('git:pull', root),
    push: (root: string, opts?: { setUpstream?: boolean; branch?: string }) => call<string>('git:push', root, opts),
    stashSave: (root: string, msg: string) => call<string>('git:stashSave', root, msg),
    stashApply: (root: string, i: number, drop: boolean) => call<string>('git:stashApply', root, i, drop),
    stashDrop: (root: string, i: number) => call<boolean>('git:stashDrop', root, i),
  },
  // ── phase 25 · durable schedules ─────────────────────────────────────
  schedule: {
    list: () => call<any[]>('schedule:list'),
    create: (input: { name: string; cron: string; kind: 'headless' | 'session' | 'batch'; payload: unknown; projectId?: string | null }) =>
      call<any>('schedule:create', input),
    setEnabled: (id: string, on: boolean) => call<any>('schedule:setEnabled', id, on),
    remove: (id: string) => call<boolean>('schedule:delete', id),
    history: (id: string, limit?: number) => call<{ at: number; status: string; detail: string | null }[]>('schedule:history', id, limit),
    preview: (cron: string) => call<{ fires: number[]; describe: string }>('schedule:preview', cron),
    tick: () => call<number>('schedule:tick'),
  },
  // ── phase 26 · agent teams ───────────────────────────────────────────
  teams: {
    read: () => call<any>('teams:read'),
  },
  // ── phase 27 · revert against the baseline ───────────────────────────
  revert: {
    plan: (root: string, file: string, head: string | null, pre: boolean) => call<any>('revert:plan', root, file, head, pre),
    file: (root: string, file: string, head: string | null, pre: boolean) =>
      call<{ ok: boolean; detail: string }>('revert:file', root, file, head, pre),
    all: (root: string, files: { path: string; preexisting?: boolean }[], head: string | null) =>
      call<{ reverted: string[]; failed: { file: string; detail: string }[] }>('revert:all', root, files, head),
  },
  // ── plugins ──────────────────────────────────────────────────────────
  plugins: {
    list: () => call<any>('plugins:list'),
    refresh: () => call<any>('plugins:refresh'),
    file: (p: string) => call<{ text: string; truncated: boolean; bytes: number }>('plugins:file', p),
    catalog: () => call<{ plugins: any[]; note: string | null }>('plugins:catalog'),
    details: (name: string) => call<{ text: string; alwaysOnTokens: number | null; error: string | null }>('plugins:details', name),
    install: (id: string, scope?: 'user' | 'project' | 'local') =>
      call<{ ok: boolean; output: string; error: string | null }>('plugins:install', id, scope),
    setEnabled: (id: string, on: boolean) =>
      call<{ ok: boolean; output: string; error: string | null }>('plugins:setEnabled', id, on),
    marketUpdate: (name?: string) => call<{ ok: boolean; output: string; error: string | null }>('plugins:marketUpdate', name),
    marketAdd: (source: string) => call<{ ok: boolean; output: string; error: string | null }>('plugins:marketAdd', source),
    marketRemove: (name: string) => call<{ ok: boolean; output: string; error: string | null }>('plugins:marketRemove', name),
  },
  // ── file explorer ────────────────────────────────────────────────────
  browse: {
    pick: (multi?: boolean, startIn?: string) => call<string[]>('browse:pick', multi, startIn),
    pickDir: (title?: string) => call<string | null>('browse:pickDir', title),
    list: (dir: string, showHidden?: boolean) => call<any>('browse:list', dir, showHidden),
    places: () => call<{ label: string; path: string; kind: string }[]>('browse:places'),
    reveal: (p: string) => call<boolean>('browse:reveal', p),
    open: (p: string) => call<string | null>('browse:open', p),
  },
  // ── phase 21 · attachments ───────────────────────────────────────────
  attach: {
    inspect: (p: string) => call<any>('attach:inspect', p),
    add: (sessionId: string, p: string) => call<any>('attach:add', sessionId, p),
    paste: (sessionId: string, data: ArrayBuffer, name: string) => call<any>('attach:paste', sessionId, data, name),
    list: (sessionId: string) => call<any[]>('attach:list', sessionId),
    remove: (id: string) => call<boolean>('attach:remove', id),
    type: (sessionId: string) => call<boolean>('attach:type', sessionId),
  },
  // ── phases 13/15/16/17 · batch depth ─────────────────────────────────
  uploads: {
    list: () => call<UploadedFile[]>('uploads:list'),
    remove: (hash: string) => call<boolean>('uploads:delete', hash),
    prune: () => call<number>('uploads:prune'),
  },
  refusal: {
    rows: (runId: string) => call<any[]>('refusal:rows', runId),
    summary: (runId: string) => call<any>('refusal:summary', runId),
    rescue: (runId: string, model: string) => call<{ runId: string; rows: number }>('refusal:rescue', runId, model),
    merge: (childRunId: string) => call<{ merged: number; parentRunId: string }>('refusal:merge', childRunId),
    children: (runId: string) => call<any[]>('refusal:children', runId),
  },
  cache: {
    hitRate: (runId: string) => call<number | null>('cache:hitRate', runId),
    minimum: (modelId: string) => call<number>('cache:minimum', modelId),
    ttl: (cfg: RunConfig, requests: number) => call<{ ttl: string; why: string }>('cache:ttl', cfg, requests),
  },
  evals: {
    pairs: () => call<EvalPair[]>('evals:pairs'),
    createPair: (name: string, a: string, b: string) => call<EvalPair>('evals:createPair', name, a, b),
    diff: (pairId: string) => call<any>('evals:diff', pairId),
    summary: (pairId: string) => call<any>('evals:summary', pairId),
    ingest: (judgeRunId: string) => call<{ scored: number; pairId: string }>('evals:ingest', judgeRunId),
    golden: () => call<GoldenSet[]>('evals:golden'),
    saveGolden: (name: string, runId: string) => call<GoldenSet>('evals:saveGolden', name, runId),
    goldenSource: (id: string) => call<SourceConfig>('evals:goldenSource', id),
  },
  // ── phase 23 · project context ───────────────────────────────────────
  context: {
    instructions: (projectPath: string) => call<any>('context:instructions', projectPath),
    memory: (projectPath: string) => call<any>('context:memory', projectPath),
    config: (projectPath: string) => call<any>('context:config', projectPath),
    budget: (projectPath: string, files: { path: string; label: string }[], model?: string) =>
      call<any>('context:budget', projectPath, files, model),
    read: (p: string) => call<{ text: string; truncated: boolean; bytes: number }>('context:read', p),
    memoryBody: (p: string) => call<{ text: string; truncated: boolean; bytes: number }>('context:memoryBody', p),
    agentsMd: (projectPath: string) => call<{ present: boolean; imported: boolean; symlinked: boolean; note: string }>('context:agentsMd', projectPath),
    refresh: (projectPath: string) => call<any>('context:refresh', projectPath),
  },
  prefs: {
    all: () => call<WaniganSettings>('settings:all'),
    set: (k: string, v: string) => call<WaniganSettings>('settings:set', k, v),
  },
  on: {
    batchChanged: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('batch:changed', h);
      return () => ipcRenderer.removeListener('batch:changed', h);
    },
    data: (cb: (p: { sessionId: string; data: string }) => void) => {
      const h = (_e: unknown, p: { sessionId: string; data: string }) => cb(p);
      ipcRenderer.on('session:data', h);
      return () => ipcRenderer.removeListener('session:data', h);
    },
    exit: (cb: (p: { sessionId: string; exitCode: number }) => void) => {
      const h = (_e: unknown, p: { sessionId: string; exitCode: number }) => cb(p);
      ipcRenderer.on('session:exit', h);
      return () => ipcRenderer.removeListener('session:exit', h);
    },
    sessionEvent: (cb: (e: SessionEvent) => void) => {
      const h = (_e: unknown, p: SessionEvent) => cb(p);
      ipcRenderer.on('session:event', h);
      return () => ipcRenderer.removeListener('session:event', h);
    },
    queueChanged: (cb: () => void) => {
      const h = () => cb();
      ipcRenderer.on('queue:changed', h);
      return () => ipcRenderer.removeListener('queue:changed', h);
    },
    sessions: (cb: (s: Session[]) => void) => {
      const h = (_e: unknown, s: Session[]) => cb(s);
      ipcRenderer.on('session:list', h);
      return () => ipcRenderer.removeListener('session:list', h);
    },
  },
};

contextBridge.exposeInMainWorld('wanigan', api);
export type WaniganApi = typeof api;
