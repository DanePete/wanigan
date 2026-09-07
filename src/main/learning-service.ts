import { app } from 'electron';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { learningSettings, setSetting } from './settings';
import { projectById } from './store';
import { listSessions } from './sessions';
import { providerById } from './providers';
import { redactCredentials } from './redact';
import * as modelAssist from './learning-model-assist';
import type {
  BriefingPreview, CandidateStatus, ForgedSkill, KnowledgeKind, LearningPhrasingOutcome,
  LearningSettings, Session, SessionEvent, TeachWaniganInput, ReviewRun,
} from '../shared/types';
import {
  ARTIFACT_SCOPES,
  CLAUDE_ARTIFACT_COMPILER,
  CODEX_ARTIFACT_COMPILER,
  DEFAULT_AUTOMATION_POLICY,
  KNOWLEDGE_KINDS,
  MACHINE_KNOWLEDGE_TTL_MS,
  NEVER_CONSOLIDATED_KINDS,
  SIGNAL_DETAIL_MAX_BYTES,
  applyProjection,
  automationDecision,
  buildBriefing,
  checkItemFreshness,
  classifySignal,
  explainCandidate,
  listRelations,
  pipelineStats,
  recordConsolidationRun,
  recordModelPhrasing,
  recordMetric,
  recordSessionBriefing,
  recordTranscriptCitations,
  refreshDeliveredKnowledgeTtl,
  sessionLearningLedger,
  compileCandidateProjection,
  completeExperiment,
  createCandidate,
  createExperiment,
  diagnoseKnowledge,
  doctorSkill,
  emptyBriefing,
  endExperiment,
  findSnoozedCandidate,
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
  markCandidateFailed,
  markSignalsProcessed,
  promoteCandidate,
  recordSignal,
  reviewCandidate,
  searchKnowledge,
  semanticExtractionEligibility,
  signalDetailBytes,
  startExperiment,
  summarizeArtifactRoi,
  undoProjection,
  updateCandidate,
  wakeSnoozedCandidate,
  type ArtifactScope,
  type ConsolidationOutcome,
  type CreateExperimentInput,
  type KnowledgeCandidate,
  type KnowledgeProjection,
  type LearningSignal,
  type ProjectionSafety,
  type ProviderArtifactCompiler,
  type ReviewAction,
} from './learning';
import { truncateUtf8Bytes } from './learning/util';

const CONSOLIDATION_INTERVAL_MS = 5 * 60_000;
let consolidationTimer: NodeJS.Timeout | null = null;

const bool = (value: boolean) => value ? '1' : '0';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * Background learning activity — a signal recorded from a live session, a
 * consolidation pass — happens while no renderer call is in flight, so views
 * would only discover it on their next manual refresh. The main process sets
 * the sink; notifications debounce because one tool call can emit several
 * signals in a burst.
 */
let changedNotifier: (() => void) | null = null;
let changedTimer: NodeJS.Timeout | null = null;

export function setLearningChangedNotifier(fn: (() => void) | null): void {
  changedNotifier = fn;
}

function emitLearningChanged(): void {
  if (!changedNotifier || changedTimer) return;
  changedTimer = setTimeout(() => {
    changedTimer = null;
    try { changedNotifier?.(); } catch { /* a closed window is not an error */ }
  }, 300);
  changedTimer.unref?.();
}

/**
 * The effective learning settings, which is what IPC and the renderer read.
 *
 * settings.ts can only return the stored intent for allowModelAssistance: the
 * router that decides whether a call is actually possible reads settings.ts, so
 * it cannot be read from there. The AND happens here. Reporting the switch as
 * on while consent, routing or metering refuses it is exactly the false control
 * the guardrails forbid, so the two values are reconciled in one place.
 */
export function settings(): LearningSettings {
  const stored = learningSettings();
  return {
    ...stored,
    allowModelAssistance: stored.allowModelAssistance
      && modelAssist.isEffective(stored.monthlyBudgetUsd),
  };
}

/** The full model-assist picture for the settings screen: consent, routing, spend. */
export function modelAssistStatus(): ReturnType<typeof modelAssist.status> {
  return modelAssist.status(learningSettings().monthlyBudgetUsd);
}

export function modelAssistConsentPreview(providerId: string, model?: string | null) {
  return modelAssist.consentPreview(providerId, model);
}

export function acceptModelAssistConsent(providerId: string, model?: string | null) {
  return modelAssist.acceptConsent(providerId, model);
}

export function withdrawModelAssistConsent(): void {
  modelAssist.withdrawConsent();
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
  if (patch.monthlyBudgetUsd !== undefined) {
    const value = Number(patch.monthlyBudgetUsd);
    if (!Number.isFinite(value) || value < 0 || value > 10_000) throw new Error('Learning budget must be between $0 and $10,000.');
    setSetting('learning_monthly_budget_usd', String(value));
  }
  // After the budget, deliberately: a caller that raises the ceiling and turns
  // the switch on in one patch must be judged against the ceiling it just set,
  // not the one it is replacing.
  if (patch.allowModelAssistance !== undefined) {
    if (patch.allowModelAssistance) {
      const consent = modelAssist.readConsent();
      // ignoreSwitch, because the switch is what this call is trying to set:
      // asking with it still off would report itself as the blocker.
      const verdict = modelAssist.assessRouting(
        consent?.providerId ?? null,
        consent?.backendId ?? null,
        learningSettings().monthlyBudgetUsd,
        { ignoreSwitch: true },
      );
      if (!verdict.ok) throw new Error(verdict.detail);
      setSetting('learning_model_assistance', '1');
    } else {
      setSetting('learning_model_assistance', '0');
    }
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
 * Command summaries are discarded wholesale below; the shared redactor is
 * defense in depth for every other tool's human-facing message, and it catches
 * credentials without trying to preserve the secret's shape.
 */
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
  // Renderer input, validated before any write: an oversized title used to
  // throw inside createCandidate after the signal row was already persisted,
  // orphaning an unprocessable signal for every future consolidation pass.
  if (!(ARTIFACT_SCOPES as readonly string[]).includes(input.scope)) {
    throw new Error(`Unknown teaching scope "${input.scope}".`);
  }
  if (input.kind !== undefined && !(KNOWLEDGE_KINDS as readonly string[]).includes(input.kind)) {
    throw new Error(`Unknown knowledge kind "${input.kind}".`);
  }
  if (Buffer.byteLength(title, 'utf8') > 500) {
    throw new Error('Teaching titles are limited to 500 bytes; move the detail into the knowledge text.');
  }
  // The ceiling this box states has to be the ceiling that applies. A teaching
  // between the 128 KiB once promised here and the 32 KB the signal row has
  // always enforced was accepted by this check and then refused inside
  // recordSignal, in a message naming 'Signal detail' — an object the user has
  // never seen — and a smaller number than the one they had just been given.
  // The detail is weighed serialised, exactly as it will be stored: JSON
  // escaping expands the text after any check on its raw bytes, so a pasted
  // procedure full of newlines and quotes is larger stored than typed.
  const detail = { explicit: true, outcome: input.outcome ?? 'preference', text };
  const detailBytes = signalDetailBytes(detail);
  if (detailBytes > SIGNAL_DETAIL_MAX_BYTES) {
    throw new Error(
      `Taught knowledge is limited to ${SIGNAL_DETAIL_MAX_BYTES / 1024} KB as stored, and this is about `
      + `${Math.ceil(detailBytes / 1024)} KB. Stored size counts escaped newlines and quotes, so it can `
      + 'exceed the text you typed; store a citation instead of raw content.',
    );
  }
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
    detail,
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

/**
 * Consolidation clusters structured detail, never prose. Grouping on the
 * summary string only ever collected text that repeated verbatim across
 * sessions — lifecycle event names and absolute file paths — which is exactly
 * what every candidate it produced turned out to say. These facets are the
 * observable properties a template can build a sentence out of.
 */
interface SignalFacets {
  toolName: string | null;
  outcome: 'ok' | 'failed' | 'unknown';
  /** Coarse deterministic bucket for a failure; null for anything else. */
  errorClass: string | null;
  /**
   * Containing directory relative to the project root, capped at
   * PATH_PREFIX_DEPTH segments: a concrete file never generalizes, its module
   * does. Null when nothing resolved inside the project.
   */
  pathPrefix: string | null;
  /** Executable of the first failing review-gate command, if any. */
  command: string | null;
}

interface SignalCluster {
  signals: LearningSignal[];
  facets: SignalFacets;
  observations: number;
  taskCount: number;
  /** A project-relative file every signal in the cluster touched, if any. */
  sharedFile: string | null;
  /**
   * The grouping key, stored on the candidate this cluster produces. A later
   * pass matches new observations of the same pattern back to a snoozed
   * candidate by this key, not by a title a person may have rewritten.
   */
  key: string;
}

const PATH_PREFIX_DEPTH = 3;
/** Drive letters included: a stored path is data, not this platform's syntax. */
const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[/\\])/;
const FAILURE_SIGNAL_KINDS = new Set(['tool-failure', 'permission-denied', 'gate-failed', 'session-failure']);

function projectRelativePath(value: string, projectPath: string | null): string | null {
  const clean = value.trim().replaceAll('\\', '/');
  if (!clean || clean.length > 1_000 || clean.split('/').includes('..')) return null;
  if (!ABSOLUTE_PATH.test(clean)) return clean.replace(/^\.\//, '') || null;
  // An absolute path outside the project names somebody's home directory or a
  // temp file. That is not a fact about this project and must never reach a
  // title, which is how the old pass filed whole paths as knowledge.
  const root = projectPath?.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  return root && clean.startsWith(`${root}/`) ? clean.slice(root.length + 1) || null : null;
}

function containingPrefix(relative: string): string | null {
  const segments = path.posix.dirname(relative).split('/').filter((part) => part && part !== '.');
  return segments.length ? segments.slice(0, PATH_PREFIX_DEPTH).join('/') : null;
}

function commonPrefix(values: string[]): string | null {
  if (!values.length) return null;
  let shared = values[0].split('/');
  for (const value of values.slice(1)) {
    const other = value.split('/');
    let index = 0;
    while (index < shared.length && index < other.length && shared[index] === other[index]) index++;
    shared = shared.slice(0, index);
    if (!shared.length) return null;
  }
  return shared.join('/') || null;
}

/**
 * A failure's class, not its wording. Two harnesses phrase one denial two
 * ways; that is the same operational fact and belongs in the same cluster,
 * while a denial and a timeout do not.
 */
const ERROR_CLASSES: { id: string; pattern: RegExp }[] = [
  { id: 'permission', pattern: /permission|denied|not allowed|forbidden|eacces|eperm/i },
  { id: 'missing', pattern: /no such file|not found|enoent|does not exist|cannot find/i },
  { id: 'timeout', pattern: /timed?[ -]?out|etimedout|deadline exceeded/i },
  { id: 'stale-edit', pattern: /conflict|has been modified|out of date|string not found|no changes to make/i },
  { id: 'syntax', pattern: /syntax error|parse error|unexpected token|type error|\bts\d{4}\b/i },
  { id: 'check-failed', pattern: /assertion|expected .+ (?:but )?(?:received|got)|tests? failed|\d+ failing/i },
  { id: 'network', pattern: /econnrefused|enotfound|socket hang up|network (?:error|unreachable)/i },
];

/**
 * Review-gate detail records every command with its exit code. A claim names
 * the failing command, so keep the executable and its first argument — enough
 * to recognize `npm test`, never enough to carry an inline secret onward.
 */
function failingCommand(detail: Record<string, unknown>): string | null {
  const commands = Array.isArray(detail.commands) ? detail.commands.slice(0, 50) : [];
  for (const entry of commands) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const row = entry as Record<string, unknown>;
    if (typeof row.command !== 'string' || row.exitCode === 0) continue;
    const label = redactCredentials(row.command).trim().split(/\s+/).slice(0, 2).join(' ');
    if (label) return label.slice(0, 120);
  }
  return null;
}

function facetsOf(signal: LearningSignal): { facets: SignalFacets; paths: string[] } {
  const detail = signal.detail;
  const toolName = typeof detail.toolName === 'string'
    ? detail.toolName.trim().toLowerCase().slice(0, 120) || null
    : null;
  const outcome = detail.ok === false ? 'failed' : detail.ok === true ? 'ok' : 'unknown';
  const paths = [...new Set((Array.isArray(detail.paths) ? detail.paths : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => projectRelativePath(value, signal.projectPath))
    .filter((value): value is string => !!value))].slice(0, 20);
  const prefixes = paths.map(containingPrefix).filter((value): value is string => !!value);
  // A class characterizes a failure only. A successful read whose summary
  // happens to contain "not found" must not be split off into its own cluster.
  const failed = outcome === 'failed' || FAILURE_SIGNAL_KINDS.has(String(signal.kind));
  return {
    facets: {
      toolName,
      outcome,
      errorClass: failed ? ERROR_CLASSES.find((entry) => entry.pattern.test(signal.summary))?.id ?? null : null,
      pathPrefix: prefixes.length ? commonPrefix(prefixes) : null,
      command: failingCommand(detail),
    },
    paths,
  };
}

/** The file every observation touched. Nothing weaker may be named as one. */
function sharedFileOf(paths: string[][]): string | null {
  if (!paths.length || paths.some((list) => !list.length)) return null;
  const shared = paths.reduce((acc, list) => acc.filter((value) => list.includes(value)));
  return shared.length ? [...shared].sort()[0] : null;
}

function clusterSignals(signals: LearningSignal[]): SignalCluster[] {
  const groups = new Map<string, { signals: LearningSignal[]; facets: SignalFacets; paths: string[][] }>();
  for (const signal of signals) {
    const { facets, paths } = facetsOf(signal);
    const key = JSON.stringify([
      signal.kind, signal.providerId, signal.backendId, signal.projectId, signal.pathScope,
      facets.toolName, facets.outcome, facets.errorClass, facets.pathPrefix, facets.command,
    ]);
    const existing = groups.get(key);
    if (existing) {
      existing.signals.push(signal);
      existing.paths.push(paths);
    } else {
      groups.set(key, { signals: [signal], facets, paths: [paths] });
    }
  }
  return [...groups.entries()].map(([key, group]) => ({
    signals: group.signals,
    facets: group.facets,
    observations: group.signals.length,
    taskCount: independentTasks(group.signals),
    sharedFile: sharedFileOf(group.paths),
    key,
  }));
}

const times = (count: number) => `${count} time${count === 1 ? '' : 's'}`;
const tasks = (count: number) => `${count} independent task${count === 1 ? '' : 's'}`;
const toolLike = (tool: string | null, markers: string[]) => !!tool && markers.some((marker) => tool.includes(marker));

const WRITE_TOOL_MARKERS = ['edit', 'write', 'patch', 'create'];
const READ_TOOL_MARKERS = ['read', 'view', 'open', 'cat'];

/**
 * The synthesis step this pipeline never had. Between "observe an event" and
 * "propose knowledge" nothing wrote anything: title and proposed text were
 * both the first signal's summary, so the only thing a candidate could say
 * was the name of the event that produced it.
 *
 * Each template owns its trigger and turns structured facets plus observed
 * counts into one specific claim. They are hand-authored on purpose — a
 * sentence a person wrote once is knowledge; a sentence assembled out of a
 * repetition counter is not. First match wins, so the more specific triggers
 * come first.
 */
interface KnowledgeTemplate {
  id: string;
  matches(cluster: SignalCluster): boolean;
  claim(cluster: SignalCluster): { title: string; text: string };
}

const KNOWLEDGE_TEMPLATES: KnowledgeTemplate[] = [
  {
    id: 'permission-denied-path',
    matches: (c) => c.signals[0].kind === 'permission-denied' && !!c.facets.pathPrefix,
    claim: (c) => ({
      title: `Permission prompts under ${c.facets.pathPrefix}`,
      text: `Agent access under \`${c.facets.pathPrefix}\` was denied ${times(c.observations)} across `
        + `${tasks(c.taskCount)}${c.facets.toolName ? ` (tool: ${c.facets.toolName})` : ''}. `
        + 'Settle the standing answer for that directory before working there again, rather than answering the same prompt once per session.',
    }),
  },
  {
    id: 'tool-failure-path',
    matches: (c) => c.signals[0].kind === 'tool-failure' && !!c.facets.toolName && !!c.facets.pathPrefix,
    claim: (c) => ({
      title: `${c.facets.toolName} fails under ${c.facets.pathPrefix}`,
      text: `\`${c.facets.toolName}\` failed ${times(c.observations)} under \`${c.facets.pathPrefix}\` across `
        + `${tasks(c.taskCount)}${c.facets.errorClass ? `, every time classed as ${c.facets.errorClass}` : ''}. `
        + `Check that before the next \`${c.facets.toolName}\` call in that directory.`,
    }),
  },
  {
    id: 'command-failure',
    matches: (c) => !!c.facets.command,
    claim: (c) => ({
      title: `\`${c.facets.command}\` keeps failing`,
      text: `\`${c.facets.command}\` exited non-zero ${times(c.observations)} across ${tasks(c.taskCount)} in this project. `
        + 'Run it and fix what it reports before handing work back, instead of discovering it at the gate.',
    }),
  },
  {
    id: 'review-gate-failure',
    matches: (c) => c.signals[0].kind === 'gate-failed',
    claim: (c) => ({
      title: 'The review gate fails repeatedly here',
      text: `The review gate failed ${times(c.observations)} across ${tasks(c.taskCount)} in this project. `
        + 'Run the project gate as part of the task, not after it.',
    }),
  },
  {
    id: 'repeated-reference-read',
    matches: (c) => toolLike(c.facets.toolName, READ_TOOL_MARKERS) && !!c.sharedFile && c.facets.outcome !== 'failed',
    claim: (c) => ({
      title: `${c.sharedFile} is re-read across tasks`,
      text: `\`${c.sharedFile}\` was read ${times(c.observations)} across ${tasks(c.taskCount)}. `
        + 'If the same passage is needed each time, quote that passage in project instructions instead of paying to re-read the file.',
    }),
  },
  {
    id: 'repeated-module-edit',
    matches: (c) => toolLike(c.facets.toolName, WRITE_TOOL_MARKERS) && !!c.facets.pathPrefix && c.facets.outcome !== 'failed',
    claim: (c) => ({
      title: `${c.facets.pathPrefix} is an active work area`,
      text: `Edits landed under \`${c.facets.pathPrefix}\` ${times(c.observations)} across ${tasks(c.taskCount)}`
        + `${c.sharedFile ? `, every one of them touching \`${c.sharedFile}\`` : ''}. `
        + 'Expect the next change in this project to reach it, and read its conventions before editing.',
    }),
  },
];

/**
 * A cluster no template covers is a real observation Wanigan cannot phrase.
 * It is nominated to the review inbox carrying the counts it can prove and
 * nothing more, so a person authors the claim in place or rejects it.
 *
 * createCandidate requires non-empty proposed text, so the nomination carries
 * this marker instead of an empty string and promote() refuses while the
 * marker is still present. Inventing a sentence here — or copying the
 * observation into both the title and the text, which is what this pass used
 * to do — manufactures knowledge out of a repetition count.
 */
const NOMINATION_MARKER = 'NEEDS AUTHORING —';

function describeFacets(cluster: SignalCluster): string {
  const facets = cluster.facets;
  return [
    `signal ${cluster.signals[0].kind}`,
    facets.toolName ? `tool \`${facets.toolName}\`` : null,
    `outcome ${facets.outcome}`,
    facets.errorClass ? `error class ${facets.errorClass}` : null,
    facets.command ? `command \`${facets.command}\`` : null,
    facets.pathPrefix ? `under \`${facets.pathPrefix}\`` : null,
    cluster.sharedFile ? `every observation touched \`${cluster.sharedFile}\`` : null,
  ].filter(Boolean).join(' · ');
}

function hasUsableFacets(cluster: SignalCluster): boolean {
  const { toolName, errorClass, pathPrefix, command } = cluster.facets;
  return !!(toolName || errorClass || pathPrefix || command || cluster.sharedFile);
}

/**
 * Wanigan's own observers stamp every row they write — detail.event for a
 * session lifecycle event, detail.reviewRunId for a gate result. When such a
 * row carries no tool, path, command or error class, the only thing that
 * repeated is a boundary: "sessions ended 40 times", "the gate passed again".
 * That is not a claim a person could author either, and it is exactly what
 * filled the inbox with Stop/SessionEnd/PreCompact titles, so the cluster is
 * consumed instead of nominated. A factless cluster from any other source
 * still reaches a person; Wanigan only discards rows it knows the shape of.
 */
function isBoundaryOnly(cluster: SignalCluster): boolean {
  return !hasUsableFacets(cluster) && cluster.signals.every((signal) =>
    typeof signal.detail.event === 'string' || typeof signal.detail.reviewRunId === 'string');
}

function nominate(cluster: SignalCluster): { title: string; text: string } {
  const what = cluster.facets.toolName ?? cluster.facets.command ?? String(cluster.signals[0].kind);
  const where = cluster.facets.pathPrefix
    ? ` under ${cluster.facets.pathPrefix}`
    : cluster.sharedFile ? ` around ${cluster.sharedFile}` : '';
  return {
    title: `Unexplained repetition: ${what}${where}`,
    text: `${NOMINATION_MARKER} Observed ${times(cluster.observations)} across ${tasks(cluster.taskCount)}, `
      + `and no template turns it into a claim. Observed facets: ${describeFacets(cluster)}. `
      + 'Replace this line with what it means, or reject the nomination — nothing is injected while the marker remains.',
  };
}

function isUnauthoredNomination(candidate: KnowledgeCandidate): boolean {
  return candidate.proposedText.trimStart().startsWith(NOMINATION_MARKER);
}

function refuseUnauthoredNomination(candidate: KnowledgeCandidate): void {
  if (!isUnauthoredNomination(candidate)) return;
  throw new Error('This candidate is a nomination, not a claim: Wanigan counted the observations but did not write what they mean. Edit its text before promoting it, or reject it.');
}

/**
 * Confidence is a statement about evidence breadth, so independent tasks drive
 * it alone. Observation count is a repetition counter — reading one file nine
 * times inside two sessions used to score 0.94, the app's second highest tier,
 * while the honest number sat next to it unused. The ceiling is derived from
 * the automation policy rather than written next to it, so no amount of
 * repetition can carry a machine-authored claim through the auto-apply gate.
 */
const MACHINE_CONFIDENCE_CEILING = Math.min(0.85, DEFAULT_AUTOMATION_POLICY.minConfidence - 0.05);

function ruleDerivedConfidence(taskCount: number): number {
  return Math.min(MACHINE_CONFIDENCE_CEILING, 0.45 + 0.1 * Math.max(0, taskCount - 1));
}

/**
 * Every consolidation-authored candidate opens its rationale with this, and
 * nothing else in the app writes it. Review can edit a candidate's title and
 * text but never its rationale, so this survives as the provenance record that
 * tells a derived claim from a taught one at promotion time.
 */
const MACHINE_DERIVED_RATIONALE = 'Rule-derived from repeated observations.';

/**
 * The provenance prefix a model-phrased candidate carries instead. It names the
 * profile that wrote the sentence, because "a model phrased this" is a fact a
 * reviewer needs and cannot recover from the text.
 *
 * A phrased candidate is still machine-derived — isMachineDerived below counts
 * both — so it inherits every existing lock unchanged: the confidence ceiling,
 * the TTL that expires a derived claim, and the automatic-promotion refusal.
 * Phrasing only ever replaces a nomination, and auto-apply requires a matched
 * template, so a phrased candidate cannot reach memory without a person.
 */
const MODEL_ASSISTED_RATIONALE = 'Model-assisted from repeated observations.';

/**
 * knowledge_items has carried expires_at, and staleness.ts has honoured it,
 * since the schema landed — but no production path ever set it, so a derived
 * claim stayed canonical no matter how stale the pattern behind it became.
 * Promotion stamps the clock here; the launch paths push it forward through
 * the ledger's refreshDeliveredKnowledgeTtl, which owns the length itself.
 */
function isMachineDerived(candidate: KnowledgeCandidate): boolean {
  return candidate.rationale.startsWith(MACHINE_DERIVED_RATIONALE)
    || candidate.rationale.startsWith(MODEL_ASSISTED_RATIONALE);
}

function machineExpiry(candidate: KnowledgeCandidate, at = Date.now()): number | null {
  return isMachineDerived(candidate) ? at + MACHINE_KNOWLEDGE_TTL_MS : null;
}

/**
 * NEVER_CONSOLIDATED_KINDS is declared in learning/types.ts so the ledger's
 * eligibleSignals count can apply the same two clauses this test does; the
 * ledger sits below this module and cannot import it back. Marking those kinds
 * processed as they arrive is what keeps the unprocessed queue a queue — the
 * oldest-first window filled with rows every pass filtered out and none ever
 * marked, so signals newer than one page were never examined at all.
 */
function permanentlyIneligible(signal: LearningSignal): boolean {
  return NEVER_CONSOLIDATED_KINDS.includes(String(signal.kind))
    || signal.detail.learningCandidateEligible === false;
}

/** Bookkeeping only: this must never turn an observation into a failure. */
function retireIneligibleSignal(signal: LearningSignal | null): void {
  if (!signal || signal.processedAt !== null || !permanentlyIneligible(signal)) return;
  try { markSignalsProcessed([signal.id]); }
  catch (error) { console.warn('[wanigan] ineligible learning signal not marked processed:', error); }
}

/**
 * The hybrid boundary — only reversible personal recall may skip review — is
 * closed today by a data property rather than an assertion: every session
 * signal carries a projectId, so the classifier always returns project scope.
 * One signal source that omitted projectId would open a path from
 * agent-produced text to auto-applied memory. Assert it instead of inheriting
 * it, and refuse the automatic promotion rather than quietly rescoping the
 * candidate: it stays in the inbox for a person.
 */
function automationScopeViolation(candidate: KnowledgeCandidate, signals: LearningSignal[]): string | null {
  const attributed = signals.filter((signal) => signal.projectId).length;
  if (!attributed) return null;
  if (candidate.scope === 'personal') {
    return `${attributed} source signal(s) carry a project id but the candidate resolved to personal scope.`;
  }
  if (!candidate.projectId) return 'Project-attributed evidence produced a candidate with no project id.';
  return null;
}

/**
 * Deterministic consolidation: repeated observations become reviewable
 * candidates, and new observations of a pattern a person snoozed wake that
 * candidate back into the inbox with a reason code.
 *
 * Returns `{ ran: false }` with a reason when the settings refuse the pass.
 * It used to return four zeros, which a caller cannot tell apart from a pass
 * that ran and found nothing — and the Consolidate button stays pressable
 * while consolidationEnabled is off, so a manual press reported a finished
 * pass that never started.
 */
export function consolidate(
  projectId?: string | null,
  trigger: 'timer' | 'manual' = 'manual',
): ConsolidationOutcome {
  const cfg = learningSettings();
  // A disabled engine records no heartbeat: the run did not happen, and the
  // caller is told which switch refused it rather than handed empty counts.
  if (!cfg.enabled) return { ran: false, reason: 'learning-disabled' };
  if (!cfg.consolidationEnabled) return { ran: false, reason: 'consolidation-disabled' };
  const startedAt = Date.now();
  // A signal that found no second independent observation in 45 days will not
  // find one later; age it out so the backlog fetch below is never saturated
  // by dead rows. Aged signals stay stored and queryable.
  const cutoff = startedAt - 45 * 24 * 60 * 60 * 1000;
  const ageSql = `UPDATE learning_signals SET processed_at=? WHERE processed_at IS NULL AND created_at < ?${projectId === undefined ? '' : ' AND project_id IS ?'}`;
  const aged = projectId === undefined
    ? db().prepare(ageSql).run(startedAt, cutoff)
    : db().prepare(ageSql).run(startedAt, cutoff, projectId);
  if (aged.changes > 0) {
    console.log(`[wanigan] ${aged.changes} learning signal(s) older than 45 days aged out of consolidation`);
  }
  // Ingest marks new ineligible signals immediately, but every row recorded
  // before it did is still sitting in the window this pass is about to read:
  // filtered out on arrival, never marked, permanently in the way of newer
  // signals. Drain them here so the backlog clears in one pass instead of
  // waiting 45 days for the aging cutoff to reach it.
  const neverKinds = [...NEVER_CONSOLIDATED_KINDS];
  const drained = db().prepare(`
    UPDATE learning_signals SET processed_at=? WHERE processed_at IS NULL
      AND (kind IN (${neverKinds.map(() => '?').join(',')})
        OR COALESCE(json_extract(detail_json,'$.learningCandidateEligible'), 1) = 0)
      ${projectId === undefined ? '' : 'AND project_id IS ?'}
  `).run(startedAt, ...neverKinds, ...(projectId === undefined ? [] : [projectId]));
  if (drained.changes > 0) {
    console.log(`[wanigan] ${drained.changes} learning signal(s) that can never consolidate left the queue`);
  }
  // Oldest first: a newest-first page of 1,000 would starve the oldest
  // unprocessed signals forever once the backlog exceeds one page.
  const signals = listSignals({ projectId, processed: false, limit: 1_000, order: 'asc' })
    // Ingest retires these now. The filter still runs for rows recorded before
    // it did, and for any future signal source that forgets to.
    .filter((signal) => !permanentlyIneligible(signal));
  let processed = 0;
  let candidates = 0;
  let autoApplied = 0;
  let woken = 0;
  let failedGroups = 0;
  let boundaries = 0;
  for (const cluster of clusterSignals(signals)) {
    const signalIds = cluster.signals.map((signal) => signal.id);
    // A snoozed candidate is a person's "not now, ask again when there is more".
    // Its pattern re-forming here is exactly that moment, and it must be checked
    // before the size gate below: the new observations are usually a single
    // signal, which on its own could never reach the threshold — that is why
    // the old pass silently dropped them and a snoozed candidate never woke.
    // Waking appends the evidence and recomputes the counts; the candidate
    // returns to pending with a reason code, never to auto-apply
    // (automationDecision refuses anything ever snoozed).
    try {
      const wakeTemplate = KNOWLEDGE_TEMPLATES.find((entry) => entry.matches(cluster));
      const snoozed = findSnoozedCandidate({
        clusterKey: cluster.key,
        title: wakeTemplate ? truncateUtf8Bytes(wakeTemplate.claim(cluster).title, 480) : null,
        projectId: cluster.signals[0].projectId,
        targetKind: classifySignal(cluster.signals[0]).targetKind,
      });
      if (snoozed) {
        const wokenCandidate = wakeSnoozedCandidate(snoozed.id, signalIds, startedAt);
        if (wokenCandidate) {
          processed += markSignalsProcessed(signalIds);
          woken++;
          continue;
        }
        // Same tasks seen again: not a reason to interrupt the person. The
        // signals stay unprocessed so a later independent observation can
        // cluster with them and wake the candidate with a real count.
        continue;
      }
    } catch (error) {
      console.warn(`[wanigan] snoozed-candidate wake check failed (${describeFacets(cluster)}):`, error);
    }
    if (cluster.observations < 2 || cluster.taskCount < 2) continue;
    // One poisoned cluster must not abort the pass: later clusters would never
    // consolidate and the heartbeat below would never record.
    let marked = false;
    try {
      const first = cluster.signals[0];
      const template = KNOWLEDGE_TEMPLATES.find((entry) => entry.matches(cluster));
      // Only a cluster no template claims can be consumed, and only when it is
      // a repeated boundary. Consumed, not lost: the rows stay stored and
      // queryable, they just stop occupying the window for the next 45 days.
      if (!template && isBoundaryOnly(cluster)) {
        processed += markSignalsProcessed(signalIds);
        boundaries++;
        continue;
      }
      const classification = classifySignal(first);
      const claim = template ? template.claim(cluster) : nominate(cluster);
      const candidate = createCandidate({
        targetKind: classification.targetKind,
        scope: classification.scope,
        providerId: first.providerId,
        projectId: first.projectId,
        pathScope: classification.pathScope,
        title: truncateUtf8Bytes(claim.title, 480),
        proposedText: claim.text,
        rationale: `${MACHINE_DERIVED_RATIONALE} ${template ? `Template ${template.id} phrased` : 'No template matched'} `
          + `${cluster.observations} observation(s) across ${cluster.taskCount} independent task(s); `
          + `confidence follows the independent-task count alone. ${classification.reasons.join(' ')}`,
        confidence: ruleDerivedConfidence(cluster.taskCount),
        signalIds,
        clusterKey: cluster.key,
      });
      candidates++;
      processed += markSignalsProcessed(signalIds);
      marked = true;
      // Three locks stand between a derived sentence and applied memory: a
      // nomination has no claim to apply, the confidence ceiling is below the
      // policy minimum by construction, and the scope assertion refuses rather
      // than rescopes. Removing any one of them must be a deliberate decision.
      if (cfg.automation === 'hybrid' && template && automationDecision(candidate).decision === 'auto-apply') {
        const violation = automationScopeViolation(candidate, cluster.signals);
        if (violation) {
          console.warn(`[wanigan] automatic promotion refused for ${candidate.id}; it stays in review: ${violation}`);
        } else {
          promoteCandidate(candidate.id, {
            createdBy: 'automation',
            allowAutomatic: true,
            metadata: privacyMetadata(candidate),
            expiresAt: machineExpiry(candidate),
          });
          autoApplied++;
        }
      }
    } catch (error) {
      failedGroups++;
      console.warn(`[wanigan] consolidation cluster failed (${describeFacets(cluster)}):`, error);
      if (!marked) {
        // A deterministically failing cluster must not retry every pass; its
        // signals leave the consolidation queue but stay stored and queryable.
        try { processed += markSignalsProcessed(signalIds); }
        catch (markError) { console.warn('[wanigan] failed consolidation cluster could not be marked processed:', markError); }
      }
    }
  }
  if (boundaries > 0) {
    console.log(`[wanigan] ${boundaries} consolidation cluster(s) repeated a session or gate boundary and nothing else; their signals were marked processed`);
  }
  if (woken > 0) {
    console.log(`[wanigan] ${woken} snoozed candidate(s) woke into review: their pattern was observed again in a new independent task`);
  }
  if (failedGroups > 0) {
    console.warn(`[wanigan] ${failedGroups} consolidation cluster(s) failed this pass; their signals were marked processed`);
  }
  // The run summary used to be discarded, which made the 5-minute automation
  // indistinguishable from automation that never ran. Persist every real pass.
  try {
    recordConsolidationRun({
      trigger, processed, candidates, autoApplied,
      durationMs: Date.now() - startedAt, at: startedAt,
    });
  } catch (error) {
    console.warn('[wanigan] consolidation heartbeat not recorded:', error);
  }
  if (candidates > 0 || autoApplied > 0 || woken > 0) emitLearningChanged();
  return { ran: true, processed, candidates, autoApplied, woken };
}

export type PhrasingOutcome = LearningPhrasingOutcome;

/**
 * Rebuilds the cluster facts for a candidate from its own evidence, using the
 * same helpers that derived them during consolidation. Reading them back from
 * the signals rather than parsing the stored cluster key means the payload
 * cannot drift from the key format, and the two counts stay the counts the
 * candidate was actually built from.
 */
export function factsFor(signals: LearningSignal[]): modelAssist.ClusterFacts {
  const derived = signals.map((signal) => facetsOf(signal));
  const facets = derived[0].facets;
  return {
    signalKind: String(signals[0].kind),
    toolName: facets.toolName ?? null,
    outcome: facets.outcome ?? null,
    errorClass: facets.errorClass ?? null,
    command: facets.command ?? null,
    pathPrefix: facets.pathPrefix ?? null,
    sharedFile: sharedFileOf(derived.map((entry) => entry.paths)),
    observations: signals.length,
    independentTasks: independentTasks(signals),
  };
}

export type PhrasingEligibility =
  | { ok: true }
  | { ok: false; reason: 'no-claim-possible' | 'mixed-attribution' | 'semantic-opt-out' };

/**
 * Whether a cluster is worth paying a model to phrase, and whether it may be
 * sent at all. Separate from the pass so both rules can be tested without a
 * database, a provider or a billed call.
 *
 * A repeated success is not a lesson, and no amount of phrasing makes it one.
 * Measured against a real database: every pending nomination in it was a
 * `tool-success` cluster, and phrasing three of them produced "the Read tool
 * succeeded 31 times across 2 independent tasks", "10 websearch invocations ...
 * suggests potential redundancy" and advice to batch file sends to "reduce
 * chattiness". Fluent, confident, and invented -- the counters cannot
 * distinguish a habit worth changing from normal work, so asking guarantees the
 * model fills the gap.
 *
 * That is strictly worse than the nomination it replaced: a NEEDS AUTHORING
 * marker is visibly unfinished and cannot be promoted, while a phrased claim
 * looks reviewed. So the money is only spent where a claim is possible --
 * something failed, was denied, or carries an error class. The nomination still
 * stands for a person either way; this only decides what Wanigan will pay a
 * model to attempt.
 */
export function phrasingEligibility(signals: LearningSignal[]): PhrasingEligibility {
  if (!signals.length) return { ok: false, reason: 'no-claim-possible' };
  const first = signals[0];

  // The payload is operational: the nine facets in PAYLOAD_FIELDS and two
  // counts, and a test asserts no signal summary rides along -- a summary is
  // prose the agent produced, and that is the line. "Cross-provider operational
  // counts are fine; cross-backend semantic content is not," so requiring every
  // signal to have opted into *semantic* learning was the wrong gate for this
  // payload: it refused every real cluster, because operational signals default
  // to semanticEligible = false and that is correct for them.
  //
  // What must still hold is that a cluster reaching one backend came from that
  // backend. Clustering already keys on provider and backend, so this is an
  // assertion rather than a filter -- and it is written down because a future
  // signal source that clustered more loosely would otherwise send one
  // provider's observations to another's model with nothing complaining.
  if (signals.some((signal) =>
    signal.providerId !== first.providerId || signal.backendId !== first.backendId)) {
    return { ok: false, reason: 'mixed-attribution' };
  }
  // Where a signal *did* opt into semantic learning, the designed gate still
  // applies: that signal's content may only be inspected through the backend
  // that first processed it.
  if (signals.some((signal) => signal.semanticEligible
    && !semanticExtractionEligibility(signal, {
      allowModelAssistance: true,
      extractionProviderId: first.providerId,
      extractionBackendId: first.backendId,
    }).eligible)) {
    return { ok: false, reason: 'semantic-opt-out' };
  }
  const errorClass = facetsOf(first).facets.errorClass;
  const claimPossible = !!errorClass
    || signals.some((signal) => FAILURE_SIGNAL_KINDS.has(String(signal.kind)));
  return claimPossible ? { ok: true } : { ok: false, reason: 'no-claim-possible' };
}

/**
 * The second consolidation pass, and the only one that can spend money.
 *
 * It runs after `consolidate()` rather than inside it for three reasons: the
 * deterministic pass is synchronous and stays that way, a phrasing call that
 * the budget refuses today should be retried tomorrow rather than lost, and a
 * candidate that is never phrased is still a perfectly good nomination — which
 * is exactly what this build produced before the pass existed.
 *
 * Every refusal is silent and costs nothing. The only thing that changes on
 * success is one candidate's title, text and rationale; its evidence, scope,
 * confidence and status are untouched, so a phrased candidate still faces the
 * same review a nominated one does.
 */
export async function phrasePendingNominations(
  opts: { projectId?: string | null; limit?: number } = {},
): Promise<PhrasingOutcome> {
  // The effective settings, not the stored ones: this is the accessor that
  // ANDs the switch with consent, routing and metering.
  const cfg = settings();
  if (!cfg.enabled) return { ran: false, reason: 'learning-disabled' };
  if (!cfg.allowModelAssistance) return { ran: false, reason: 'model-assist-unavailable' };

  const limit = Math.min(20, Math.max(1, Math.round(opts.limit ?? 5)));
  const nominations = listCandidates({ projectId: opts.projectId, status: ['pending'], limit: 200 })
    .filter(isUnauthoredNomination)
    .slice(0, limit);

  let phrased = 0;
  let refused = 0;
  let skipped = 0;

  for (const candidate of nominations) {
    const signals = candidate.signalIds
      .map((id) => getSignal(id))
      .filter((value): value is LearningSignal => !!value);
    // Evidence aged out from under the candidate. Phrasing it would describe
    // observations nobody can now cite, which is worse than leaving it.
    if (!signals.length) { skipped++; continue; }

    const facts = factsFor(signals);
    const eligible = phrasingEligibility(signals);
    if (!eligible.ok) {
      // "no-claim-possible" is a skip, not a refusal: nothing was wrong with the
      // cluster, there is simply no claim in it to buy.
      if (eligible.reason === 'no-claim-possible') skipped++; else refused++;
      continue;
    }
    const first = signals[0];

    let claim: Awaited<ReturnType<typeof modelAssist.phraseCluster>> = null;
    try {
      claim = await modelAssist.phraseCluster({
        providerId: first.providerId,
        backendId: first.backendId,
        clusterKey: candidate.clusterKey ?? null,
        facts,
        budgetUsd: cfg.monthlyBudgetUsd,
      });
    } catch (error) {
      // phraseCluster is written not to throw; if it ever does, one candidate
      // must not end the pass for the rest.
      console.warn(`[wanigan] phrasing failed for candidate ${candidate.id}:`, error);
    }
    if (!claim) { refused++; continue; }

    const updated = recordModelPhrasing(candidate.id, {
      title: truncateUtf8Bytes(claim.title, 480),
      proposedText: claim.text,
      rationale: `${MODEL_ASSISTED_RATIONALE} Phrased by ${claim.label} (${claim.providerId}) from `
        + `${signals.length} observation(s) across ${independentTasks(signals)} independent task(s). `
        + 'The observations are Wanigan\'s; the sentence is the model\'s, and neither is a review.',
      onlyIfTextStartsWith: NOMINATION_MARKER,
    });
    if (updated) phrased++; else skipped++;
  }

  if (phrased > 0) emitLearningChanged();
  return { ran: true, phrased, refused, skipped };
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
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : listCandidates({ projectId: filter.projectId, status: statuses, limit: filter.limit });
  return filter.scope ? rows.filter((row) => row.scope === filter.scope) : rows;
}

export function promote(id: string) {
  const candidate = getCandidate(id);
  if (!candidate) throw new Error('Learning candidate not found.');
  refuseUnauthoredNomination(candidate);
  // Provenance, not actor: a person approving a derived claim does not make
  // the claim human-taught, so it keeps the machine TTL either way.
  return promoteCandidate(id, {
    createdBy: 'user',
    metadata: privacyMetadata(candidate),
    expiresAt: machineExpiry(candidate),
  });
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
  refuseUnauthoredNomination(candidate);
  if (candidate.status === 'approved') {
    promoteCandidate(id, {
      createdBy: 'user',
      metadata: privacyMetadata(candidate),
      expiresAt: machineExpiry(candidate),
    });
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
  let safety: ProjectionSafety;
  try {
    const candidate = getCandidate(projection.candidateId);
    if (!candidate) throw new Error('The projection candidate no longer exists.');
    safety = projectionSafety(candidate, projection.providerId);
  } catch (error) {
    // Reversal must survive the provider profile or project registration
    // going away. The roots granted at preview time are recorded on the
    // projection for exactly this moment; undoProjection's applied-hash
    // guard still protects the file byte for byte.
    if (!projection.allowedRoots.length) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`This projection predates stored write roots, so undo needs its provider profile and project to still be available. ${reason}`);
    }
    safety = { allowedRoots: projection.allowedRoots, actor: 'user', maxBytes: 512 * 1024 };
  }
  return undoProjection(id, safety);
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
    versions: listKnowledgeVersions(id).slice(0, 50),
    evidence: listEvidence({ itemId: id }).slice(0, 200),
    // The detail pane renders projection metadata only. Each projection row
    // carries two whole-file snapshots; shipping hundreds of them in one IPC
    // response is unbounded, so the contents stay behind getProjection.
    projections: listProjections({ itemId: id, limit: 100 })
      .map((projection): KnowledgeProjection => ({ ...projection, proposedContent: '', previousContent: null })),
    roi: summarizeArtifactRoi(id),
  };
}

/**
 * The read-only preview: the same retrieval a launch runs, plus the state a
 * launch dialog needs to describe what would happen. A disabled engine used
 * to return an empty stub indistinguishable from "retrieval ran and matched
 * nothing"; it is now its own state with the full counter shape.
 */
export async function briefing(input: {
  query: string; providerId: string; projectId?: string | null; path?: string | null; maxTokens?: number;
}): Promise<BriefingPreview> {
  const cfg = learningSettings();
  const runtime = providerById(input.providerId);
  const harnessId = runtime?.harness ?? null;
  // Mirrors the launch site in sessions.ts: Claude Code takes the capsule on
  // --append-system-prompt, Codex on a developer_instructions config, and no
  // other harness receives one. A launch also requires the harness proof: a
  // built-in profile is reviewed, a local pack must pass its adapter probe.
  const launchDelivery: BriefingPreview['launchDelivery'] = harnessId === 'claude-code'
    ? 'append-system-prompt' : harnessId === 'codex' ? 'developer-instructions' : 'none';
  const harnessProof: BriefingPreview['harnessProof'] = runtime ? (runtime.source === 'builtin' ? 'builtin' : 'probe-required') : null;
  if (!cfg.enabled) {
    // Retrieval did not run. The counters are 0 because nothing was asked,
    // and queryProvided reflects only what the caller supplied.
    return {
      ...emptyBriefing(!!input.query.trim() || !!input.path),
      learningEnabled: false, harnessId, launchDelivery, harnessProof,
    };
  }
  const project = input.projectId ? projectById(input.projectId) : null;
  const value = await buildBriefing({
    ...input,
    backendId: providerBackend(input.providerId),
    maxTokens: input.maxTokens ?? cfg.briefingMaxTokens,
    projectRoot: project?.path ?? null,
    allowedEvidenceRoots: project ? [project.path] : [],
    // The inspector preview is a read; only launch paths may quarantine.
    quarantineStale: false,
  });
  return { ...value, learningEnabled: true, harnessId, launchDelivery, harnessProof };
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
}, record?: { sessionId: string; delivery: 'argv' | 'hook' }): Promise<string | null> {
  if (!learningSettings().enabled) return null;
  const maxTokens = learningSettings().briefingMaxTokens;
  const value = await buildBriefing({
    query: context.query ?? '',
    providerId: context.providerId,
    backendId: context.backendId ?? providerBackend(context.providerId),
    projectId: context.projectId,
    path: context.path ?? null,
    maxTokens,
    projectRoot: context.projectPath,
    allowedEvidenceRoots: context.projectPath ? [context.projectPath] : [],
  });
  // Delivery is use. The inspector preview in briefing() deliberately does not
  // call this: a read must not extend the life of what it reads.
  refreshDeliveredKnowledgeTtl(value.entries);
  if (record) {
    try {
      recordSessionBriefing({
        sessionId: record.sessionId,
        delivery: record.delivery,
        providerId: context.providerId,
        projectId: context.projectId,
        briefing: value,
        maxTokens,
      });
    } catch (error) {
      console.warn('[wanigan] briefing delivery not recorded:', error);
    }
  }
  return value.text || null;
}

/** Everything recorded about one session's learning: briefing, signals, reach. */
export function sessionLedger(sessionId: string) {
  const clean = boundedId(sessionId);
  if (!clean) throw new Error('A session ledger needs a valid session id.');
  return sessionLearningLedger(clean);
}

/** Observed pipeline throughput for the Overview funnel; counts, not scores. */
export function pipeline(input: { projectId?: string | null; windowDays?: number } = {}) {
  return pipelineStats(input);
}

/** The automation gate's checks for one candidate, decomposed for display. */
export function explain(id: string) {
  return explainCandidate(id);
}

/** The recorded signal rows behind one candidate — its evidence, pre-promotion. */
export function candidateSignals(id: string): LearningSignal[] {
  const candidate = getCandidate(id);
  if (!candidate) throw new Error('Learning candidate not found.');
  return candidate.signalIds
    .map((signalId) => getSignal(signalId))
    .filter((value): value is LearningSignal => !!value);
}

/** Contradiction/duplicate/supersede edges, with their stored reasons. */
export function relations(itemId?: string) {
  return listRelations(itemId ? boundedId(itemId) ?? undefined : undefined);
}

/**
 * Re-run the freshness check report-only: the caller wants to know why an
 * item is quarantined (or whether it still verifies), not to change state.
 */
export async function freshnessReport(itemId: string) {
  const value = getKnowledgeItem(itemId);
  if (!value) throw new Error('Knowledge item not found.');
  const project = value.projectId ? projectById(value.projectId) : null;
  return checkItemFreshness(itemId, {
    projectRoot: project?.path ?? null,
    allowedRoots: project ? [project.path] : [],
    quarantine: false,
  });
}

/** Formats the skill compilers write; their target path ends in <skill-name>/SKILL.md. */
const SKILL_PROJECTION_FORMATS = ['claude-skill', 'agent-skill'];

/**
 * The knowledge item behind a skill the agent's `Skill` tool ran, found
 * through the applied projection that wrote its SKILL.md — the directory name
 * is the skill's identity for both harnesses. A plugin-namespaced identifier
 * (`plugin:name`) matches on the name; the projection of the session's own
 * provider wins when several providers carry the same skill. Null when Wanigan
 * never installed a skill by that name: a built-in or hand-written skill is
 * not knowledge Wanigan can account for.
 */
function skillProjectionFor(identifier: string, providerId: string): { itemId: string; versionId: string | null; projectionId: string } | null {
  const name = identifier.split(':').pop()?.trim().toLowerCase();
  if (!name) return null;
  const rows = db().prepare(`
    SELECT id, item_id, version_id, provider_id, target_path FROM knowledge_projections
    WHERE status='applied' AND item_id IS NOT NULL AND target_format IN (${SKILL_PROJECTION_FORMATS.map(() => '?').join(',')})
    ORDER BY applied_at DESC LIMIT 500
  `).all(...SKILL_PROJECTION_FORMATS) as { id: string; item_id: string; version_id: string | null; provider_id: string; target_path: string }[];
  const matching = rows.filter((row) => path.basename(path.dirname(row.target_path)).toLowerCase() === name);
  const chosen = matching.find((row) => row.provider_id === providerId) ?? matching[0];
  return chosen ? { itemId: chosen.item_id, versionId: chosen.version_id, projectionId: chosen.id } : null;
}

/**
 * A hook-observed `Skill` tool call is the one observation of skill use
 * Wanigan has, and artifact_metrics is the table the optimizer's "no observed
 * use" rule reads — so without this row every installed skill looked unused
 * forever. Recorded only when the call resolves to a skill Wanigan installed;
 * the identifier is a name, never the arguments. Pre-filling `/name` in the
 * terminal (skills:send) is not an invocation and never reaches here.
 */
function recordSkillInvocation(event: SessionEvent, session: Session): void {
  if (event.event !== 'PostToolUse' || event.toolName !== 'Skill' || !event.summary) return;
  const identifier = redactCredentials(event.summary).trim().slice(0, 200);
  const resolved = skillProjectionFor(identifier, session.providerId);
  if (!resolved) return;
  try {
    recordMetric({
      itemId: resolved.itemId, versionId: resolved.versionId, projectionId: resolved.projectionId,
      sessionId: session.id, providerId: session.providerId,
      metric: 'invocation', value: 1,
      // Observed in a real session, attributed to nothing controlled.
      evidenceLevel: 'correlation',
      attrs: { source: 'hook', tool: 'Skill', skill: identifier, harness: session.harnessId ?? null, ok: event.ok },
      at: event.at,
    });
  } catch (error) {
    console.warn('[wanigan] skill invocation metric not recorded:', error);
  }
}

export function observeSessionEvent(event: SessionEvent, session?: Session | null): LearningSignal | null {
  if (!learningSettings().enabled || !session) return null;
  recordSkillInvocation(event, session);
  const map: Record<string, string> = {
    PostToolUse: 'tool-success', PostToolUseFailure: 'tool-failure', PermissionDenied: 'permission-denied',
    Stop: 'session-success', StopFailure: 'session-failure', SessionEnd: 'session-success',
    PreCompact: 'compaction', PostCompact: 'compaction', FileChanged: 'file-change',
  };
  const kind = map[event.event];
  if (!kind) return null;
  const safe = safeSessionEventSummary(event);
  const safeToolName = safe.command ? 'shell' : event.toolName ? redactCredentials(event.toolName).slice(0, 200) : null;
  emitLearningChanged();
  const signal = recordSignal({
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
  // A discarded shell command is still an operational observation, but
  // "Shell command completed" can never consolidate into anything. Retire it
  // now so it does not hold a place in the oldest-first window until it ages
  // out 45 days later.
  retireIneligibleSignal(signal);
  return signal;
}

export function observeReviewResult(result: ReviewRun): LearningSignal | null {
  if (!learningSettings().enabled) return null;
  const project = projectById(result.projectId);
  emitLearningChanged();
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
  // Its candidate is created below; consolidation must never see it again.
  retireIneligibleSignal(signal);
  // Reinstalling a same-named skill must version the existing item, not
  // collide with it: the itemId excludes it from the conflict check and
  // routes promotion through the in-place update branch.
  const existing = listKnowledgeItems({
    kinds: ['skill'], statuses: ['active'], scope: skill.scope, projectId: projectId ?? null,
  }).find((item) => item.title.toLowerCase() === skill.name.toLowerCase());
  const candidate = createCandidate({
    targetKind: 'skill', scope: skill.scope, projectId: projectId ?? null,
    itemId: existing?.id ?? null,
    title: skill.name, proposedText: skill.skillMd,
    rationale: 'User-forged and approved after deterministic Skill Doctor checks.',
    confidence: 1, signalIds: [signal.id],
  });
  try {
    reviewCandidate(candidate.id, 'approve');
    promoteCandidate(candidate.id, { createdBy: 'user', metadata: privacyMetadata(candidate, targets) });
  } catch (error) {
    // A candidate stranded 'pending' or 'approved' would pile up in the Inbox
    // and block every retry of the same skill name.
    try { markCandidateFailed(candidate.id, error instanceof Error ? error.message : String(error)); }
    catch { /* the original failure is the one worth surfacing */ }
    throw error;
  }
  // Per-provider isolation: one provider's failure must not hide another
  // provider's already-written file from the caller.
  return targets.map((providerId): { providerId: string; projection: KnowledgeProjection | null; error: string | null } => {
    try {
      return { providerId, projection: applyCandidateToProvider(candidate.id, providerId).projection, error: null };
    } catch (error) {
      return { providerId, projection: null, error: error instanceof Error ? error.message : String(error) };
    }
  });
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
    try { consolidate(undefined, 'timer'); } catch (error) { console.warn('[wanigan] learning consolidation skipped:', error); }
    // Phrasing follows the deterministic pass and never blocks it: it is async,
    // it may spend money, and it returns immediately when the switch, consent,
    // routing or metering refuses. A rejection here is a bug in a path written
    // not to throw, so it is logged rather than swallowed.
    void phrasePendingNominations().catch((error) => {
      console.warn('[wanigan] learning phrasing pass skipped:', error);
    });
  }, CONSOLIDATION_INTERVAL_MS);
  consolidationTimer.unref?.();
}

export function stopConsolidator(): void {
  if (consolidationTimer) clearInterval(consolidationTimer);
  consolidationTimer = null;
}

export {
  createExperiment, diagnoseKnowledge, doctorSkill, forgeSkill, listProjections,
  listSignals, recordTranscriptCitations, reviewCandidate, searchKnowledge, updateCandidate,
};
export type { CreateExperimentInput, ReviewAction };
