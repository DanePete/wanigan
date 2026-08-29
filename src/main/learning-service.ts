import { app } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { learningSettings, setSetting } from './settings';
import { projectById } from './store';
import { listSessions } from './sessions';
import { providerById } from './providers';
import type {
  CandidateStatus, ForgedSkill, KnowledgeKind, LearningSettings, Session,
  SessionEvent, TeachWaniganInput, ReviewRun,
} from '../shared/types';
import {
  CLAUDE_ARTIFACT_COMPILER,
  CODEX_ARTIFACT_COMPILER,
  applyProjection,
  automationDecision,
  buildBriefing,
  classifySignal,
  compileCandidateProjection,
  completeExperiment,
  createCandidate,
  createExperiment,
  diagnoseKnowledge,
  doctorSkill,
  endExperiment,
  forgeSkill,
  getCandidate,
  getKnowledgeItem,
  getProjection,
  getSignal,
  listCandidates,
  listEvidence,
  listExperiments,
  listKnowledgeItems,
  listKnowledgeVersions,
  listProjections,
  listSignals,
  markSignalsProcessed,
  promoteCandidate,
  recordSignal,
  reviewCandidate,
  searchKnowledge,
  startExperiment,
  summarizeArtifactRoi,
  undoProjection,
  updateCandidate,
  type ArtifactScope,
  type CreateExperimentInput,
  type KnowledgeCandidate,
  type LearningSignal,
  type ProjectionSafety,
  type ProviderArtifactCompiler,
  type ReviewAction,
} from './learning';

const CONSOLIDATION_INTERVAL_MS = 5 * 60_000;
let consolidationTimer: NodeJS.Timeout | null = null;

const bool = (value: boolean) => value ? '1' : '0';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export function settings(): LearningSettings {
  return learningSettings();
}

export function updateSettings(patch: Partial<LearningSettings>): LearningSettings {
  if (patch.enabled !== undefined) setSetting('learning_enabled', bool(patch.enabled === true));
  if (patch.contentMode !== undefined) {
    if (patch.contentMode !== 'operational-only' && patch.contentMode !== 'local-same-provider') {
      throw new Error('Unknown learning content mode.');
    }
    setSetting('learning_content_mode', patch.contentMode);
  }
  if (patch.automation !== undefined) {
    if (patch.automation !== 'review-only' && patch.automation !== 'hybrid') {
      throw new Error('Unknown learning automation policy.');
    }
    setSetting('learning_automation', patch.automation);
  }
  if (patch.allowModelAssistance !== undefined) {
    if (patch.allowModelAssistance) {
      throw new Error('Model-assisted consolidation is not connected in this build; deterministic learning remains active.');
    }
    setSetting('learning_model_assistance', '0');
  }
  if (patch.monthlyBudgetUsd !== undefined) {
    const value = Number(patch.monthlyBudgetUsd);
    if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new Error('Learning budget must be between $0 and $10,000.');
    setSetting('learning_monthly_budget_usd', String(value));
  }
  if (patch.briefingMaxTokens !== undefined) {
    const value = Math.round(Number(patch.briefingMaxTokens));
    if (!Number.isFinite(value) || value < 200 || value > 8_000) throw new Error('Briefing ceiling must be 200–8,000 tokens.');
    setSetting('learning_briefing_max_tokens', String(value));
  }
  if (patch.consolidationEnabled !== undefined) {
    setSetting('learning_consolidation', bool(patch.consolidationEnabled === true));
  }
  return learningSettings();
}

function scopeSql(projectId?: string | null): { sql: string; args: unknown[] } {
  if (projectId === undefined) return { sql: '', args: [] };
  if (projectId === null) return { sql: ' AND project_id IS NULL', args: [] };
  return { sql: " AND (scope='personal' OR project_id=?)", args: [projectId] };
}

export function overview(projectId?: string | null) {
  const scoped = scopeSql(projectId);
  const one = (sql: string, args: unknown[] = []) => (db().prepare(sql).get(...args) as { n: number }).n;
  const pendingWhere = projectId === undefined ? '' : projectId === null
    ? ' AND project_id IS NULL' : ' AND (scope=\'personal\' OR project_id=?)';
  const pendingArgs = projectId !== undefined && projectId !== null ? [projectId] : [];
  const signalWhere = projectId === undefined ? '' : ' AND project_id IS ?';
  const signalArgs = projectId === undefined ? [] : [projectId];
  return {
    pending: one(`SELECT COUNT(*) n FROM knowledge_candidates WHERE status IN ('pending','approved','snoozed')${pendingWhere}`, pendingArgs),
    activeKnowledge: one(`SELECT COUNT(*) n FROM knowledge_items WHERE status='active'${scoped.sql}`, scoped.args),
    quarantined: one(`SELECT COUNT(*) n FROM knowledge_items WHERE status='quarantined'${scoped.sql}`, scoped.args),
    activeSkills: one(`SELECT COUNT(*) n FROM knowledge_items WHERE status='active' AND kind='skill'${scoped.sql}`, scoped.args),
    experiments: one(`SELECT COUNT(*) n FROM learning_experiments WHERE status IN ('draft','running')${projectId === undefined ? '' : ' AND project_id IS ?'}`, projectId === undefined ? [] : [projectId]),
    signals: one(`SELECT COUNT(*) n FROM learning_signals WHERE 1=1${signalWhere}`, signalArgs),
    projectedTokenDelta: one(`SELECT COALESCE(SUM(estimated_token_delta),0) n FROM knowledge_candidates WHERE status IN ('pending','approved')${pendingWhere}`, pendingArgs),
  };
}

function providerBackend(providerId: string | null | undefined): string | null {
  return providerId ? providerById(providerId)?.backendId ?? null : null;
}

type FrozenSessionAttribution = {
  providerId: string;
  backendId: string | null;
};

function boundedId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean && clean.length <= 300 ? clean : null;
}

function frozenBackendFromProfile(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const profile = parsed as Record<string, unknown>;
    const direct = boundedId(profile.backendId);
    if (direct) return direct;
    const backend = profile.backend;
    return backend && typeof backend === 'object' && !Array.isArray(backend)
      ? boundedId((backend as Record<string, unknown>).id)
      : null;
  } catch {
    return null;
  }
}

/**
 * Resolve attribution from the immutable session snapshot, never from today's
 * provider registry. A pack id can be upgraded or reused after this session;
 * looking it up now would silently relabel old semantic content.
 */
function frozenSessionAttribution(sessionId: string): FrozenSessionAttribution | null {
  const live = listSessions().find((session) => session.id === sessionId);
  const row = db().prepare(`
    SELECT provider_id, backend_id, provider_profile_json
    FROM session_log WHERE id=?
  `).get(sessionId) as {
    provider_id: string | null;
    backend_id: string | null;
    provider_profile_json: string | null;
  } | undefined;

  const liveProvider = boundedId(live?.providerId);
  const storedProvider = boundedId(row?.provider_id);
  if (liveProvider && storedProvider && liveProvider !== storedProvider) return null;
  const providerId = liveProvider ?? storedProvider;
  if (!providerId) return null;

  const backendId = boundedId(live?.backendId)
    ?? boundedId(row?.backend_id)
    ?? frozenBackendFromProfile(row?.provider_profile_json);
  return { providerId, backendId };
}

const COMMAND_TOOL_MARKERS = [
  'bash', 'shell', 'terminal', 'execcommand', 'executecommand', 'runcommand', 'commandexecution',
];

function isCommandEvent(event: SessionEvent): boolean {
  const compact = `${event.toolName ?? ''} ${event.event}`.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return COMMAND_TOOL_MARKERS.some((marker) => compact.includes(marker));
}

/**
 * Defense in depth for non-command event summaries. Command summaries are
 * discarded wholesale below; this catches credentials that surface in another
 * tool's human-facing message without trying to preserve the secret's shape.
 */
function redactCredentials(value: string): string {
  return value
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
    .replace(/\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\b(authorization|proxy-authorization)\s*:\s*(?:bearer|basic)?\s*[^\s,;]+/gi, '$1: [REDACTED]')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1=[REDACTED]')
    .replace(/(--(?:api[-_]?key|token|auth(?:entication)?[-_]?token|password|passwd|secret|credential|access[-_]?key)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(api\s*key|access\s*key|auth\s*token|token|secret|password|passwd|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1: [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED CREDENTIAL]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED TOKEN]');
}

function safeSessionEventSummary(event: SessionEvent): {
  summary: string;
  command: boolean;
  redacted: boolean;
} {
  const command = isCommandEvent(event);
  const outcome = event.ok === false ? 'failed' : event.ok === true ? 'completed' : 'observed';
  if (command) return { summary: `Shell command ${outcome}.`, command: true, redacted: true };
  const source = event.summary?.trim()
    || (event.toolName ? `${event.toolName} ${outcome}` : event.event);
  const summary = redactCredentials(source).trim().slice(0, 4 * 1024) || `Session event ${outcome}.`;
  return { summary, command: false, redacted: summary !== source };
}

/** Explicit teaching stores the user's conclusion and a source reference, never a transcript. */
export function teach(input: TeachWaniganInput): KnowledgeCandidate {
  if (!learningSettings().enabled) throw new Error('Learning is switched off in Optimize.');
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title || !text) throw new Error('Teach Wanigan needs a title and the knowledge to remember.');
  if (input.scope !== 'personal' && !input.projectId) throw new Error('Project and path teaching needs a selected project.');
  if (input.scope === 'path' && !input.pathScope?.trim()) throw new Error('Path-scoped teaching needs a path selector.');
  const cfg = learningSettings();
  const sessionId = boundedId(input.sessionId);
  if (input.sessionId !== undefined && input.sessionId !== null && !sessionId) {
    throw new Error('This session id is invalid; nothing was learned.');
  }
  let providerId = boundedId(input.providerId);
  let backendId = providerBackend(providerId);
  if (sessionId) {
    const frozen = frozenSessionAttribution(sessionId);
    if (!frozen) throw new Error('This session has no trustworthy frozen provider attribution; nothing was learned.');
    providerId = frozen.providerId;
    backendId = frozen.backendId;
    if (cfg.contentMode === 'local-same-provider' && !backendId) {
      throw new Error('This session has no frozen backend attribution; semantic teaching was not stored.');
    }
  }
  const signal = recordSignal({
    kind: input.outcome === 'corrected' ? 'correction' : input.outcome === 'failed' ? 'session-failure' : 'explicit-teach',
    providerId,
    backendId,
    sessionId,
    taskHash: sessionId ? hash(`teach:${sessionId}:${title}`) : hash(`teach:${Date.now()}:${title}`),
    projectId: input.projectId ?? null,
    projectPath: input.projectPath ?? (input.projectId ? projectById(input.projectId)?.path ?? null : null),
    pathScope: input.pathScope ?? null,
    summary: title,
    detail: { explicit: true, outcome: input.outcome ?? 'preference', text },
    // Unknown backends are never relabelled as provider-neutral semantic data.
    // Direct teaching and legacy sessions both fail this gate closed.
    semanticEligible: cfg.contentMode === 'local-same-provider' && providerId !== null && backendId !== null,
  });
  const classified = classifySignal(signal, {
    targetKind: input.kind ?? (input.outcome === 'failed' ? 'eval' : undefined),
    scope: input.scope,
    pathScope: input.pathScope ?? null,
    regression: input.outcome === 'failed',
  });
  const candidate = createCandidate({
    targetKind: classified.targetKind,
    scope: classified.scope,
    providerId,
    projectId: input.projectId ?? null,
    pathScope: classified.pathScope,
    title,
    proposedText: text,
    rationale: `Explicitly taught by the user. ${classified.reasons.join(' ')}`,
    confidence: Math.max(0.95, classified.confidence),
    signalIds: [signal.id],
  });
  markSignalsProcessed([signal.id]);
  return candidate;
}

function independentTasks(signals: LearningSignal[]): number {
  return new Set(signals.map((signal) => signal.taskHash ?? signal.sessionId).filter(Boolean)).size;
}

function groupKey(signal: LearningSignal): string {
  return JSON.stringify([
    signal.kind, signal.providerId, signal.backendId, signal.projectId, signal.pathScope,
    signal.summary.trim().toLowerCase(),
  ]);
}

/** Deterministic consolidation: repeated observations become reviewable candidates. */
export function consolidate(projectId?: string | null): { processed: number; candidates: number; autoApplied: number } {
  const cfg = learningSettings();
  if (!cfg.enabled || !cfg.consolidationEnabled) return { processed: 0, candidates: 0, autoApplied: 0 };
  const signals = listSignals({ projectId, processed: false, limit: 1_000 })
    .filter((signal) => signal.kind !== 'explicit-teach' && signal.kind !== 'correction')
    // A discarded shell command can still count as an operational observation,
    // but "Shell command completed" is not reusable knowledge and must never be
    // consolidated into a candidate.
    .filter((signal) => signal.detail.learningCandidateEligible !== false);
  const groups = new Map<string, LearningSignal[]>();
  for (const signal of signals) groups.set(groupKey(signal), [...(groups.get(groupKey(signal)) ?? []), signal]);
  let processed = 0;
  let candidates = 0;
  let autoApplied = 0;
  for (const group of groups.values()) {
    const taskCount = independentTasks(group);
    if (group.length < 2 || taskCount < 2) continue;
    const first = group[0];
    const classification = classifySignal(first, {
      repeatedProcedure: group.every((signal) => signal.kind === 'tool-success') && group.some((signal) => Array.isArray(signal.detail.steps)),
    });
    const candidate = createCandidate({
      targetKind: classification.targetKind,
      scope: classification.scope,
      providerId: first.providerId,
      projectId: first.projectId,
      pathScope: classification.pathScope,
      title: first.summary.slice(0, 180),
      proposedText: first.summary,
      rationale: `Observed ${group.length} times across ${taskCount} independent tasks. ${classification.reasons.join(' ')}`,
      confidence: Math.min(0.98, classification.confidence + Math.min(0.3, group.length * 0.06)),
      signalIds: group.map((signal) => signal.id),
    });
    candidates++;
    processed += markSignalsProcessed(group.map((signal) => signal.id));
    if (cfg.automation === 'hybrid' && automationDecision(candidate).decision === 'auto-apply') {
      promoteCandidate(candidate.id, {
        createdBy: 'automation',
        allowAutomatic: true,
        metadata: privacyMetadata(candidate),
      });
      autoApplied++;
    }
  }
  return { processed, candidates, autoApplied };
}

function privacyMetadata(candidate: KnowledgeCandidate, providerIds?: string[]): Record<string, unknown> {
  const sources = candidate.signalIds.map((id) => getSignal(id)).filter((value): value is LearningSignal => !!value);
  const semantic = sources.some((signal) => signal.semanticEligible);
  const allowed = providerIds?.length ? providerIds : semantic && candidate.providerId ? [candidate.providerId] : [];
  const backendIds = semantic
    ? [...new Set(sources.filter((signal) => signal.semanticEligible).map((signal) => signal.backendId).filter((value): value is string => !!value))]
    : [];
  return {
    providerIds: allowed,
    backendIds,
    semanticContent: semantic,
    privacyBoundary: semantic ? 'same-provider/backend only' : 'provider-neutral operational knowledge',
    sourceSignalIds: candidate.signalIds,
  };
}

export function candidates(filter: {
  projectId?: string | null; status?: string | string[]; scope?: string; limit?: number;
} = {}) {
  const statuses = filter.status
    ? (Array.isArray(filter.status) ? filter.status : [filter.status]) as CandidateStatus[]
    : undefined;
  const rows = filter.projectId
    ? [
        ...listCandidates({ projectId: filter.projectId, status: statuses, limit: filter.limit }),
        ...listCandidates({ projectId: null, status: statuses, limit: filter.limit }),
      ].filter((row, index, all) => all.findIndex((value) => value.id === row.id) === index)
    : listCandidates({ projectId: filter.projectId, status: statuses, limit: filter.limit });
  return filter.scope ? rows.filter((row) => row.scope === filter.scope) : rows;
}

export function promote(id: string) {
  const candidate = getCandidate(id);
  if (!candidate) throw new Error('Learning candidate not found.');
  return promoteCandidate(id, { createdBy: 'user', metadata: privacyMetadata(candidate) });
}

function compilerFor(providerId: string): { compiler: ProviderArtifactCompiler; homeRoots: string[] } {
  const runtime = providerById(providerId);
  if (!runtime) throw new Error(`Provider profile ${providerId} is not installed or enabled.`);
  const home = app.getPath('home');
  if (runtime.harness === 'claude-code') {
    return { compiler: CLAUDE_ARTIFACT_COMPILER, homeRoots: [path.join(home, '.claude')] };
  }
  if (runtime.harness === 'codex') {
    return {
      compiler: CODEX_ARTIFACT_COMPILER,
      homeRoots: [path.join(home, '.agents'), path.join(home, '.codex')],
    };
  }
  throw new Error(`${runtime.label} has no trusted artifact compiler. Its knowledge remains available through Wanigan briefings.`);
}

function projectRoot(candidate: KnowledgeCandidate): string | null {
  if (candidate.scope === 'personal') return null;
  const project = candidate.projectId ? projectById(candidate.projectId) : null;
  if (!project) throw new Error('The candidate project is no longer available.');
  return project.path;
}

function projectionSafety(candidate: KnowledgeCandidate, providerId: string, actor: 'user' | 'automation' = 'user'): ProjectionSafety {
  const { homeRoots } = compilerFor(providerId);
  const root = projectRoot(candidate);
  return { allowedRoots: root ? [root] : homeRoots, actor, maxBytes: 512 * 1024 };
}

export function applyCandidateToProvider(id: string, providerId: string) {
  let candidate = getCandidate(id);
  if (!candidate) throw new Error('Learning candidate not found.');
  if (candidate.status === 'approved') {
    promoteCandidate(id, { createdBy: 'user', metadata: privacyMetadata(candidate) });
    candidate = getCandidate(id)!;
  }
  if (candidate.status !== 'promoted' && candidate.status !== 'applied') {
    throw new Error('Approve and promote this candidate before applying a provider projection.');
  }
  const sourceSignals = candidate.signalIds.map((signalId) => getSignal(signalId)).filter((value): value is LearningSignal => !!value);
  const semanticSources = sourceSignals.filter((signal) => signal.semanticEligible);
  if (semanticSources.length) {
    const targetBackend = providerBackend(providerId);
    const sourceBackends = [...new Set(semanticSources.map((signal) => signal.backendId).filter((value): value is string => !!value))];
    if (sourceBackends.length) {
      if (!targetBackend || sourceBackends.some((backendId) => backendId !== targetBackend)) {
        throw new Error(
          `This candidate contains ${sourceBackends.join(', ')} backend-attributed semantic content. ` +
          `Cross-backend projection to ${targetBackend ?? 'an unknown backend'} is disabled.`
        );
      }
    } else if (candidate.providerId && candidate.providerId !== providerId) {
      throw new Error(
        `This legacy candidate contains ${candidate.providerId}-attributed semantic content. ` +
        `Cross-provider projection to ${providerId} is disabled.`
      );
    }
  }
  const { compiler } = compilerFor(providerId);
  const root = projectRoot(candidate);
  const safety = projectionSafety(candidate, providerId);
  const { compiled, projection } = compileCandidateProjection(id, compiler, {
    providerId,
    projectRoot: root,
    homeDir: app.getPath('home'),
  }, { allowedRoots: safety.allowedRoots, maxBytes: safety.maxBytes });
  if (!compiled.supported) throw new Error(compiled.reason);
  if (compiled.mode !== 'file' || !projection) {
    throw new Error(`${candidate.targetKind} is delivered through ${compiled.mode}; it does not write a provider-owned file.`);
  }
  const applied = applyProjection(projection.id, safety);
  const item = applied.itemId ? getKnowledgeItem(applied.itemId) : null;
  const versions = item ? listKnowledgeVersions(item.id) : [];
  if (!item || !versions[0]) throw new Error('Projection applied but canonical knowledge could not be reloaded.');
  return { item, version: versions[0], projection: applied };
}

export function undo(id: string) {
  const projection = getProjection(id);
  if (!projection) throw new Error('Knowledge projection not found.');
  const candidate = getCandidate(projection.candidateId);
  if (!candidate) throw new Error('The projection candidate no longer exists.');
  return undoProjection(id, projectionSafety(candidate, projection.providerId));
}

export function knowledge(filter: {
  projectId?: string | null; scope?: string; kind?: string; status?: string; limit?: number;
} = {}) {
  const query = (projectId: string | null | undefined, scope = filter.scope) => listKnowledgeItems({
    projectId,
    scope: scope as ArtifactScope | undefined,
    kinds: filter.kind ? [filter.kind as KnowledgeKind] : undefined,
    statuses: filter.status ? [filter.status as 'active' | 'quarantined' | 'retired'] : undefined,
    limit: filter.limit,
  });
  if (!filter.projectId || filter.scope) return query(filter.projectId);
  return [...query(filter.projectId), ...query(null, 'personal')]
    .filter((row, index, all) => all.findIndex((value) => value.id === row.id) === index)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function item(id: string) {
  const value = getKnowledgeItem(id);
  if (!value) throw new Error('Knowledge item not found.');
  return {
    item: value,
    versions: listKnowledgeVersions(id),
    evidence: listEvidence({ itemId: id }),
    projections: listProjections({ itemId: id, limit: 500 }),
    roi: summarizeArtifactRoi(id),
  };
}

export async function briefing(input: {
  query: string; providerId: string; projectId?: string | null; path?: string | null; maxTokens?: number;
}) {
  const cfg = learningSettings();
  if (!cfg.enabled) return { text: '', entries: [], estimatedTokens: 0, omitted: 0 };
  const project = input.projectId ? projectById(input.projectId) : null;
  return buildBriefing({
    ...input,
    backendId: providerBackend(input.providerId),
    maxTokens: input.maxTokens ?? cfg.briefingMaxTokens,
    projectRoot: project?.path ?? null,
    allowedEvidenceRoots: project ? [project.path] : [],
  });
}

export async function briefingForSession(sessionId: string): Promise<string | null> {
  const session = listSessions().find((value) => value.id === sessionId);
  if (!session || !learningSettings().enabled) return null;
  return briefingForContext({
    providerId: session.providerId, backendId: session.backendId ?? null,
    projectId: session.projectId, projectPath: session.projectPath,
  });
}

export async function briefingForContext(context: {
  providerId: string;
  backendId?: string | null;
  projectId: string | null;
  projectPath: string | null;
  query?: string;
  path?: string | null;
}): Promise<string | null> {
  if (!learningSettings().enabled) return null;
  const value = await buildBriefing({
    query: context.query ?? '',
    providerId: context.providerId,
    backendId: context.backendId ?? providerBackend(context.providerId),
    projectId: context.projectId,
    path: context.path ?? null,
    maxTokens: learningSettings().briefingMaxTokens,
    projectRoot: context.projectPath,
    allowedEvidenceRoots: context.projectPath ? [context.projectPath] : [],
  });
  return value.text || null;
}

export function observeSessionEvent(event: SessionEvent, session?: Session | null): LearningSignal | null {
  if (!learningSettings().enabled || !session) return null;
  const map: Record<string, string> = {
    PostToolUse: 'tool-success', PostToolUseFailure: 'tool-failure', PermissionDenied: 'permission-denied',
    Stop: 'session-success', StopFailure: 'session-failure', SessionEnd: 'session-success',
    PreCompact: 'compaction', PostCompact: 'compaction', FileChanged: 'file-change',
  };
  const kind = map[event.event];
  if (!kind) return null;
  const safe = safeSessionEventSummary(event);
  const safeToolName = safe.command ? 'shell' : event.toolName ? redactCredentials(event.toolName).slice(0, 200) : null;
  return recordSignal({
    kind,
    providerId: session.providerId,
    backendId: session.backendId ?? providerBackend(session.providerId),
    sessionId: session.id,
    taskHash: hash(`session:${session.id}`),
    projectId: session.projectId,
    projectPath: session.projectPath,
    // Touched files are evidence, not a path rule. Only an explicit teach or
    // classifier hint may broaden a concrete file into a reusable selector.
    pathScope: null,
    summary: safe.summary,
    detail: {
      event: redactCredentials(String(event.event)).slice(0, 200),
      toolName: safeToolName,
      durationMs: event.durationMs,
      ok: event.ok,
      // Shell path fields are provider payload too; discard them with the
      // command instead of assuming they cannot contain inline credentials.
      paths: safe.command
        ? []
        : event.paths.map((value) => redactCredentials(value).slice(0, 4 * 1024)),
      summaryRedacted: safe.redacted,
      learningCandidateEligible: !safe.command,
    },
    semanticEligible: false,
    createdAt: event.at,
  });
}

export function observeReviewResult(result: ReviewRun): LearningSignal | null {
  if (!learningSettings().enabled) return null;
  const project = projectById(result.projectId);
  return recordSignal({
    kind: result.status === 'passed' ? 'gate-passed' : 'gate-failed',
    projectId: result.projectId,
    projectPath: project?.path ?? null,
    taskHash: hash(`review:${result.id}`),
    summary: `Review gate ${result.status}`,
    detail: {
      reviewRunId: result.id,
      commands: result.results.map((entry) => ({
        command: entry.command, exitCode: entry.exitCode, durationMs: entry.durationMs,
      })),
    },
    semanticEligible: false,
    createdAt: result.endedAt ?? result.startedAt,
  });
}

export function installSkill(skill: ForgedSkill, providerIds: string[], projectId?: string | null) {
  const diagnostics = doctorSkill(skill.skillMd);
  const errors = diagnostics.filter((entry) => entry.severity === 'error');
  if (errors.length) throw new Error(`Skill Doctor refused installation: ${errors.map((entry) => entry.message).join(' ')}`);
  const targets = [...new Set(providerIds.filter(Boolean))];
  if (!targets.length) throw new Error('Choose at least one provider target.');
  if (skill.scope === 'project' && !projectId) throw new Error('A project skill needs a selected project.');
  const project = projectId ? projectById(projectId) : null;
  const signal = recordSignal({
    kind: 'explicit-teach', projectId: projectId ?? null, projectPath: project?.path ?? null,
    summary: `Skill: ${skill.name}`, detail: { explicit: true, skillName: skill.name }, semanticEligible: false,
    taskHash: hash(`skill:${skill.name}:${Date.now()}`),
  });
  const candidate = createCandidate({
    targetKind: 'skill', scope: skill.scope, projectId: projectId ?? null,
    title: skill.name, proposedText: skill.skillMd,
    rationale: 'User-forged and approved after deterministic Skill Doctor checks.',
    confidence: 1, signalIds: [signal.id],
  });
  reviewCandidate(candidate.id, 'approve');
  promoteCandidate(candidate.id, { createdBy: 'user', metadata: privacyMetadata(candidate, targets) });
  return targets.map((providerId) => applyCandidateToProvider(candidate.id, providerId).projection);
}

export function experimentList(filter: { projectId?: string | null; status?: string; limit?: number } = {}) {
  return listExperiments({
    projectId: filter.projectId,
    statuses: filter.status ? [filter.status as 'draft' | 'running' | 'completed' | 'cancelled' | 'failed'] : undefined,
    limit: filter.limit,
  });
}

export function setExperimentStatus(id: string, action: 'start' | 'cancel' | 'complete', outcome?: Record<string, unknown>) {
  if (action === 'start') return startExperiment(id);
  if (action === 'complete') return completeExperiment(id, outcome ?? {});
  return endExperiment(id, 'cancelled', typeof outcome?.detail === 'string' ? outcome.detail : undefined);
}

export function startConsolidator(): void {
  if (consolidationTimer) return;
  consolidationTimer = setInterval(() => {
    try { consolidate(); } catch (error) { console.warn('[wanigan] learning consolidation skipped:', error); }
  }, CONSOLIDATION_INTERVAL_MS);
  consolidationTimer.unref?.();
}

export function stopConsolidator(): void {
  if (consolidationTimer) clearInterval(consolidationTimer);
  consolidationTimer = null;
}

export {
  createExperiment, diagnoseKnowledge, doctorSkill, forgeSkill, listProjections,
  listSignals, reviewCandidate, searchKnowledge, updateCandidate,
};
export type { CreateExperimentInput, ReviewAction };
