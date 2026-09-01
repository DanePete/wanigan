import { createHash, randomUUID } from 'node:crypto';
import { db } from './db';
import { redactCredentials } from './redact';
import { getSetting, setSetting } from './settings';
import { IMPROVEMENT_SCOUT_SCHEDULE_ID, nextFire, describeCron } from './schedule';
import * as control from './control';
import type {
  DocketDetail,
  ImprovementScoutAnalysisMethod,
  ImprovementScoutEffort,
  ImprovementScoutEvidence,
  ImprovementScoutGoal,
  ImprovementScoutOverview,
  ImprovementScoutRisk,
  ImprovementScoutRun,
  ImprovementScoutRunMode,
  ImprovementScoutRunStatus,
  ImprovementScoutSettings,
  ImprovementScoutSource,
  ImprovementScoutSourceKind,
  ImprovementScoutSuggestion,
  ImprovementScoutSuggestionStatus,
} from '../shared/types';

/**
 * The Scout is an operator-owned research inbox. It can collect only these
 * public, HTTPS, official pages; no renderer-provided URL is ever fetched.
 * This keeps a compromised page or a local database edit from turning a
 * background feature into a generic network client.
 */
type TrustedSource = {
  id: string;
  label: string;
  description: string;
  url: string;
  publisher: string;
  kind: ImprovementScoutSourceKind;
};

const TRUSTED_SOURCES: readonly TrustedSource[] = [
  {
    id: 'openai-release-notes',
    label: 'OpenAI developer changelog',
    description: 'Official OpenAI developer and product capability changes.',
    url: 'https://learn.chatgpt.com/docs/changelog',
    publisher: 'OpenAI',
    kind: 'changelog',
  },
  {
    id: 'claude-code-changelog',
    label: 'Claude Code changelog',
    description: 'Official Claude Code changes and developer-workflow additions.',
    url: 'https://code.claude.com/docs/en/changelog',
    publisher: 'Anthropic',
    kind: 'changelog',
  },
  {
    id: 'anthropic-platform-release-notes',
    label: 'Anthropic Platform release notes',
    description: 'Official API and platform changes relevant to agent integrations.',
    url: 'https://platform.claude.com/docs/en/release-notes/overview',
    publisher: 'Anthropic',
    kind: 'release-notes',
  },
  {
    id: 'github-changelog',
    label: 'GitHub changelog',
    description: 'Official GitHub platform and MCP ecosystem announcements.',
    url: 'https://github.blog/changelog/',
    publisher: 'GitHub',
    kind: 'changelog',
  },
  {
    id: 'github-releases-rest-docs',
    label: 'GitHub Releases REST API',
    description: 'Official release-discovery API reference and change context.',
    url: 'https://docs.github.com/en/rest/releases',
    publisher: 'GitHub',
    kind: 'documentation',
  },
];

const SOURCE_BY_ID = new Map(TRUSTED_SOURCES.map((value) => [value.id, value]));
const DEFAULT_WEEKDAY = 6; // Saturday, local time.
const DEFAULT_HOUR = 9;
const SCOUT_SCHEDULE_ID = IMPROVEMENT_SCOUT_SCHEDULE_ID;
const ANALYSIS_METHOD: ImprovementScoutAnalysisMethod = 'deterministic-rules';
// The largest current official default (Claude Code's changelog) is a little
// over 3 MiB decompressed. Four MiB remains a hard serial per-source ceiling
// while avoiding a known-good source failing before its text is reduced to the
// 96 KiB local analysis/persistence budget below.
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_SOURCE_TEXT = 96_000;
const MAX_EXCERPT = 900;
const MAX_NOTE = 4_000;

type SourceRow = {
  id: string;
  enabled: number;
  last_checked_at: number | null;
  last_status: string | null;
  last_detail: string | null;
};

type RunRow = {
  id: string;
  mode: string;
  status: string;
  network_allowed: number;
  source_count: number;
  evidence_count: number;
  suggestion_count: number;
  analysis_method: string;
  started_at: number;
  ended_at: number | null;
  detail: string | null;
  error: string | null;
};

type SuggestionRow = {
  id: string;
  status: string;
  category: string;
  title: string;
  summary: string;
  why_now: string;
  recommendation: string;
  score: number;
  confidence: number;
  effort: string;
  risk: string;
  analysis_method: string;
  created_at: number;
  updated_at: number;
  reviewed_at: number | null;
  note: string | null;
  docket_id: string | null;
};

type EvidenceRow = {
  id: string;
  run_id: string;
  suggestion_id: string | null;
  source_id: string;
  source_title: string;
  source_url: string;
  publisher: string;
  excerpt: string;
  content_hash: string;
  published_at: number | null;
  retrieved_at: number;
};

type LinkedEvidenceRow = EvidenceRow & { linked_suggestion_id?: string | null };

type CollectedSource = {
  title: string;
  text: string;
  excerpt: string;
  publishedAt: number | null;
};

type SourceFetcher = (source: TrustedSource) => Promise<CollectedSource>;

const uid = (prefix: string) => `${prefix}_${randomUUID().slice(0, 12)}`;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const bool = (value: boolean) => value ? '1' : '0';

function boundedInteger(value: unknown, floor: number, ceiling: number, label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < floor || n > ceiling) {
    throw new Error(`${label} must be a whole number from ${floor} to ${ceiling}.`);
  }
  return n;
}

function canonicalCron(weekday: number, hour: number): string {
  return `0 ${hour} * * ${weekday}`;
}

function cronParts(cron: string): { weekday: number; hour: number } | null {
  const m = /^0\s+(\d{1,2})\s+\*\s+\*\s+([0-7])$/.exec(cron.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const weekday = Number(m[2]) === 7 ? 0 : Number(m[2]);
  return hour >= 0 && hour <= 23 ? { weekday, hour } : null;
}

function settingBool(key: string, fallback: boolean): boolean {
  return getSetting(key, fallback ? '1' : '0') === '1';
}

/**
 * This returns settings only; it performs no network or scheduler work, so it
 * is also safe for the What leaves this machine report to call.
 */
export function settings(): ImprovementScoutSettings {
  const rawCron = getSetting('improvement_scout_cron', canonicalCron(DEFAULT_WEEKDAY, DEFAULT_HOUR));
  const parsed = cronParts(rawCron);
  const weekday = parsed?.weekday ?? DEFAULT_WEEKDAY;
  const hour = parsed?.hour ?? DEFAULT_HOUR;
  const provider = getSetting('improvement_scout_provider_id', '').trim();
  const model = getSetting('improvement_scout_model', '').trim();
  const onlineResearch = settingBool('improvement_scout_network_enabled', false);
  return {
    enabled: settingBool('improvement_scout_enabled', true),
    weeklyEnabled: settingBool('improvement_scout_weekly_enabled', false),
    weekday,
    hour,
    cron: canonicalCron(weekday, hour),
    // This is intentionally separate from manual `allowNetwork`: checking it
    // grants unattended egress, whereas a button grants one visible pass.
    networkEnabled: onlineResearch,
    onlineResearch,
    providerId: provider || null,
    model: model || null,
    modelAssistanceEnabled: false,
    analysisMethod: ANALYSIS_METHOD,
  };
}

/** Alias kept explicit for callers which need to describe egress policy. */
export const improvementScoutSettings = settings;

function validateProviderRef(value: unknown, label: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
  const text = value.trim();
  if (!text || text.length > 180) throw new Error(`${label} must be 1–180 characters.`);
  return text;
}

/**
 * Store only the settings this implementation can honour. Future model fields
 * are intentionally saved as a preference but never cause a model call; the
 * returned shape makes that limitation visible to every surface.
 */
export function updateSettings(patch: Partial<ImprovementScoutSettings>): ImprovementScoutSettings {
  if (patch.enabled !== undefined) setSetting('improvement_scout_enabled', bool(patch.enabled === true));
  if (patch.weeklyEnabled !== undefined) setSetting('improvement_scout_weekly_enabled', bool(patch.weeklyEnabled === true));
  if (patch.networkEnabled !== undefined && patch.onlineResearch !== undefined
    && patch.networkEnabled !== patch.onlineResearch) {
    throw new Error('Scout networkEnabled and onlineResearch describe the same permission and must agree.');
  }
  const requestedOnlineResearch = patch.onlineResearch ?? patch.networkEnabled;
  if (requestedOnlineResearch !== undefined) setSetting('improvement_scout_network_enabled', bool(requestedOnlineResearch === true));
  if (patch.modelAssistanceEnabled !== undefined && patch.modelAssistanceEnabled) {
    throw new Error('Model-assisted Scout analysis is not connected yet. This build labels every proposal as deterministic rules.');
  }
  if (patch.providerId !== undefined) setSetting('improvement_scout_provider_id', validateProviderRef(patch.providerId, 'Provider') ?? '');
  if (patch.model !== undefined) setSetting('improvement_scout_model', validateProviderRef(patch.model, 'Model') ?? '');

  const current = settings();
  let weekday = patch.weekday === undefined ? current.weekday : boundedInteger(patch.weekday, 0, 6, 'Scout weekday');
  let hour = patch.hour === undefined ? current.hour : boundedInteger(patch.hour, 0, 23, 'Scout hour');
  if (patch.cron !== undefined) {
    if (typeof patch.cron !== 'string') throw new Error('Scout cadence must be a weekly local-time schedule.');
    const parsed = cronParts(patch.cron);
    if (!parsed) throw new Error('Scout cadence must be weekly: minute 0, hour 0–23, and weekday 0–6.');
    weekday = parsed.weekday; hour = parsed.hour;
  }
  setSetting('improvement_scout_cron', canonicalCron(weekday, hour));
  const next = settings();
  syncWeeklySchedule(next);
  return next;
}

function validLastStatus(value: string | null): ImprovementScoutSource['lastStatus'] {
  return value === 'ok' || value === 'failed' || value === 'skipped' ? value : 'never';
}

/** Static source metadata comes from code, not a mutable database row. */
export function listSources(): ImprovementScoutSource[] {
  const rows = db().prepare(`SELECT id,enabled,last_checked_at,last_status,last_detail
    FROM improvement_scout_sources ORDER BY id`).all() as SourceRow[];
  const state = new Map(rows.map((row) => [row.id, row]));
  return TRUSTED_SOURCES.map((source) => {
    const row = state.get(source.id);
    return {
      id: source.id,
      label: source.label,
      description: source.description,
      url: source.url,
      publisher: source.publisher,
      kind: source.kind,
      official: true,
      enabled: row ? row.enabled === 1 : true,
      lastCheckedAt: row?.last_checked_at ?? null,
      lastStatus: validLastStatus(row?.last_status ?? null),
      lastDetail: row?.last_detail ?? null,
    };
  });
}

export const sources = listSources;

export function setSourceEnabled(id: string, enabled: boolean): ImprovementScoutSource[] {
  if (!SOURCE_BY_ID.has(id)) throw new Error('That source is not in Wanigan’s official Scout allow-list.');
  const result = db().prepare('UPDATE improvement_scout_sources SET enabled=?,updated_at=? WHERE id=?')
    .run(enabled ? 1 : 0, Date.now(), id);
  if (result.changes !== 1) throw new Error('The Scout source registry is unavailable. Restart Wanigan to repair its local schema.');
  return listSources();
}

function sourceRows(enabledOnly = false): Array<TrustedSource & { enabled: boolean }> {
  const states = new Map(listSources().map((source) => [source.id, source]));
  return TRUSTED_SOURCES
    .map((source) => ({ ...source, enabled: states.get(source.id)?.enabled ?? true }))
    .filter((source) => !enabledOnly || source.enabled);
}

function mapEvidence(row: LinkedEvidenceRow): ImprovementScoutEvidence {
  return {
    id: row.id,
    runId: row.run_id,
    suggestionId: row.linked_suggestion_id ?? row.suggestion_id,
    sourceId: row.source_id,
    title: row.source_title,
    url: row.source_url,
    publisher: row.publisher,
    excerpt: row.excerpt,
    contentHash: row.content_hash,
    publishedAt: row.published_at,
    retrievedAt: row.retrieved_at,
  };
}

function evidenceForSuggestion(id: string): ImprovementScoutEvidence[] {
  const rows = db().prepare(`SELECT e.*, se.suggestion_id AS linked_suggestion_id
    FROM improvement_scout_suggestion_evidence se
    JOIN improvement_scout_evidence e ON e.id=se.evidence_id
    WHERE se.suggestion_id=? ORDER BY e.retrieved_at DESC LIMIT 12`).all(id) as LinkedEvidenceRow[];
  return rows.map(mapEvidence);
}

function safeEffort(value: string): ImprovementScoutEffort {
  return value === 'small' || value === 'large' ? value : 'medium';
}
function safeRisk(value: string): ImprovementScoutRisk {
  return value === 'low' || value === 'high' ? value : 'elevated';
}
function safeSuggestionStatus(value: string): ImprovementScoutSuggestionStatus {
  return value === 'reviewed' || value === 'snoozed' || value === 'dismissed' || value === 'goal-created'
    ? value : 'new';
}
function mapSuggestion(row: SuggestionRow): ImprovementScoutSuggestion {
  return {
    id: row.id,
    status: safeSuggestionStatus(row.status),
    category: row.category,
    title: row.title,
    summary: row.summary,
    whyNow: row.why_now,
    recommendation: row.recommendation,
    score: Math.max(0, Math.min(100, Math.round(row.score))),
    confidence: Math.max(0, Math.min(1, row.confidence)),
    effort: safeEffort(row.effort),
    risk: safeRisk(row.risk),
    analysisMethod: ANALYSIS_METHOD,
    evidence: evidenceForSuggestion(row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    reviewedAt: row.reviewed_at,
    note: row.note,
    goalId: row.docket_id,
  };
}

export function listSuggestions(filter?: {
  status?: ImprovementScoutSuggestionStatus | ImprovementScoutSuggestionStatus[];
  limit?: number;
}): ImprovementScoutSuggestion[] {
  const statuses = filter?.status === undefined ? [] : (Array.isArray(filter.status) ? filter.status : [filter.status]);
  const allowed = statuses.filter((value): value is ImprovementScoutSuggestionStatus =>
    ['new', 'reviewed', 'snoozed', 'dismissed', 'goal-created'].includes(value));
  const limit = Math.max(1, Math.min(200, Math.round(filter?.limit ?? 80)));
  const where = allowed.length ? `WHERE status IN (${allowed.map(() => '?').join(',')})` : '';
  const rows = db().prepare(`SELECT * FROM improvement_scout_suggestions ${where}
    ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'reviewed' THEN 1 WHEN 'snoozed' THEN 2 ELSE 3 END,
      score DESC, updated_at DESC LIMIT ?`).all(...allowed, limit) as SuggestionRow[];
  return rows.map(mapSuggestion);
}

export const suggestions = listSuggestions;

export function suggestion(id: string): ImprovementScoutSuggestion {
  const row = db().prepare('SELECT * FROM improvement_scout_suggestions WHERE id=?').get(id) as SuggestionRow | undefined;
  if (!row) throw new Error('Scout suggestion not found.');
  return mapSuggestion(row);
}

function mapRun(row: RunRow): ImprovementScoutRun {
  const status: ImprovementScoutRunStatus = row.status === 'running' || row.status === 'blocked' || row.status === 'failed'
    ? row.status : 'completed';
  return {
    id: row.id,
    mode: row.mode === 'scheduled' ? 'scheduled' : row.mode === 'preview' ? 'preview' : 'manual',
    status,
    networkAllowed: row.network_allowed === 1,
    sourceCount: row.source_count,
    evidenceCount: row.evidence_count,
    suggestionCount: row.suggestion_count,
    analysisMethod: ANALYSIS_METHOD,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    detail: row.detail,
    error: row.error,
  };
}

export function listRuns(limit = 30): ImprovementScoutRun[] {
  const rows = db().prepare('SELECT * FROM improvement_scout_runs ORDER BY started_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(200, Math.round(limit)))) as RunRow[];
  return rows.map(mapRun);
}

export const runs = listRuns;

function scheduleRow(): { next_at: number | null; enabled: number } | undefined {
  return db().prepare('SELECT next_at,enabled FROM schedules WHERE id=?').get(SCOUT_SCHEDULE_ID) as
    { next_at: number | null; enabled: number } | undefined;
}

function cadenceLabel(config: ImprovementScoutSettings): string {
  return describeCron(config.cron).replace(/^every /i, 'Every ');
}

export function overview(): ImprovementScoutOverview {
  const config = settings();
  const latest = db().prepare('SELECT * FROM improvement_scout_runs ORDER BY started_at DESC LIMIT 1').get() as RunRow | undefined;
  const latestAt = latest?.started_at ?? null;
  const pending = db().prepare("SELECT COUNT(*) AS n FROM improvement_scout_suggestions WHERE status='new'").get() as { n: number };
  const sourceCounts = db().prepare('SELECT COUNT(*) AS n, COALESCE(SUM(enabled),0) AS enabled FROM improvement_scout_sources')
    .get() as { n: number; enabled: number };
  const schedule = scheduleRow();
  return {
    enabled: config.enabled,
    weeklyEnabled: config.weeklyEnabled,
    networkEnabled: config.networkEnabled,
    cadenceLabel: cadenceLabel(config),
    lastRunAt: latestAt,
    // An unarmed schedule is deliberately represented as null. A made-up next
    // time would make the UI promise background egress that is not permitted.
    nextRunAt: schedule?.enabled === 1 ? schedule.next_at : null,
    pendingSuggestions: pending.n,
    sourceCount: sourceCounts.n,
    enabledSourceCount: sourceCounts.enabled,
    analysisMethod: ANALYSIS_METHOD,
    latestRun: latest ? mapRun(latest) : null,
  };
}

/**
 * Creates exactly one durable weekly schedule. It is deliberately disabled
 * unless the operator enabled both the Scout and unattended online research.
 * The shared schedule CAS and Scout's single-running-row index together make
 * attended Wanigan and launchd safe to run at the same time.
 */
export function syncWeeklySchedule(config: ImprovementScoutSettings = settings()): void {
  const active = scheduledResearchAllowed(config);
  const next = active ? nextFire(config.cron) : null;
  const at = Date.now();
  db().prepare(`
    INSERT INTO schedules (id,name,cron,kind,payload_json,project_id,enabled,created_at,next_at)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      name=excluded.name, cron=excluded.cron, kind=excluded.kind,
      payload_json=excluded.payload_json, project_id=NULL, enabled=excluded.enabled,
      next_at=excluded.next_at
  `).run(
    SCOUT_SCHEDULE_ID, 'AI Improvement Scout', config.cron, 'scout',
    JSON.stringify({ scout: true, version: 1 }), null, active ? 1 : 0, at, next,
  );
}

/** A queue item may survive the few seconds between a schedule claim and a
 * user switching research off. Callers use this fresh persisted check so that
 * stale work completes as a harmless no-op instead of retrying five times. */
export function scheduledResearchAllowed(config: ImprovementScoutSettings = settings()): boolean {
  return config.enabled && config.weeklyEnabled && config.networkEnabled;
}

function localInventory(): Record<string, unknown> {
  // Deliberately no project files, terminal content, credentials, or paths.
  // The inventory tells deterministic rules what Wanigan itself lacks, not
  // what a source page says it should execute.
  return {
    schema: 1,
    capturedAt: Date.now(),
    capabilities: {
      officialSourceWatch: true,
      modelAssistedScoutAnalysis: false,
      lspDiagnosticBridge: false,
      mcpSpecCompatibilityAudit: false,
      releaseApiWatchAdapter: false,
      providerChangeEvaluationRecipes: false,
    },
  };
}

function sourceHostMatches(source: TrustedSource): boolean {
  try {
    const url = new URL(source.url);
    return url.protocol === 'https:' && url.hostname === new URL(SOURCE_BY_ID.get(source.id)!.url).hostname;
  } catch { return false; }
}

/**
 * Fetched remote HTML is exactly where a credential arrives without being a
 * secret of the user's: an "Authorization: Bearer …" example or a
 * postgres://user:pass@host connection string in somebody's documentation is
 * stored as Scout evidence and shown back in the app. The shared redactor
 * covers those header and connection-string shapes; the three rules this
 * module used to carry itself did not.
 */
function textFromDocument(value: string): string {
  return redactCredentials(value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim()
  ).slice(0, MAX_SOURCE_TEXT);
}

function sourceTitle(raw: string, fallback: string): string {
  const m = /<title\b[^>]*>([\s\S]{0,2_000}?)<\/title>/i.exec(raw);
  const text = m ? textFromDocument(m[1]) : fallback;
  return text.slice(0, 260) || fallback;
}

function maybePublishedAt(raw: string): number | null {
  const m = /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(raw)
    ?? /"(?:datePublished|publishedAt)"\s*:\s*"([^"\\]+)"/i.exec(raw);
  if (!m) return null;
  const at = Date.parse(m[1]);
  return Number.isFinite(at) ? at : null;
}

async function boundedText(response: Response): Promise<string> {
  const header = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(header) && header > MAX_SOURCE_BYTES) {
    throw new Error(`Source response exceeds the ${Math.round(MAX_SOURCE_BYTES / 1024)} KiB Scout limit.`);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_SOURCE_BYTES) {
        await reader.cancel();
        throw new Error(`Source response exceeds the ${Math.round(MAX_SOURCE_BYTES / 1024)} KiB Scout limit.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** GET-only and credential-free. Redirects are refused so the static host
 * allow-list cannot be bypassed by a source changing destination. */
async function fetchTrustedSource(source: TrustedSource): Promise<CollectedSource> {
  if (!sourceHostMatches(source)) throw new Error('Scout source failed its static HTTPS allow-list check.');
  const response = await fetch(source.url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(12_000),
    headers: {
      accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.1',
      'user-agent': 'Wanigan-Improvement-Scout/0.1 (+local; no-credentials)',
    },
  });
  if (!response.ok) throw new Error(`Official source returned HTTP ${response.status}.`);
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!/(?:text\/|application\/(?:json|xml|xhtml\+xml))/.test(contentType)) {
    throw new Error('Official source did not return text content.');
  }
  const raw = await boundedText(response);
  const text = textFromDocument(raw);
  if (!text) throw new Error('Official source returned no readable text.');
  return {
    title: sourceTitle(raw, source.label),
    text,
    excerpt: text.slice(0, MAX_EXCERPT),
    publishedAt: maybePublishedAt(raw),
  };
}

let sourceFetcher: SourceFetcher = fetchTrustedSource;

type GapRule = {
  id: string;
  category: string;
  title: string;
  summary: string;
  recommendation: string;
  keywords: string[];
  missingCapability: string;
  score: number;
  confidence: number;
  effort: ImprovementScoutEffort;
  risk: ImprovementScoutRisk;
  sources: string[];
};

/**
 * These are capability-gap rules, not an LLM. A rule becomes a proposal only
 * when fresh text from an official source contains its terms and Wanigan's
 * local inventory still says the related capability is absent.
 */
const GAP_RULES: readonly GapRule[] = [
  {
    id: 'lsp-diagnostic-bridge', category: 'developer workflow',
    title: 'Evaluate a language-server diagnostic bridge',
    summary: 'Expose live language diagnostics and code navigation alongside agent sessions when a supported provider announces LSP-style capabilities.',
    recommendation: 'Create a bounded design and prototype Goal for a provider-neutral LSP diagnostic bridge. Keep provider protocol parsing isolated and verify it against a sample workspace.',
    keywords: ['lsp', 'language server', 'diagnostic'], missingCapability: 'lspDiagnosticBridge',
    score: 76, confidence: 0.72, effort: 'large', risk: 'elevated', sources: ['claude-code-changelog'],
  },
  {
    id: 'mcp-spec-compatibility-audit', category: 'integrations',
    title: 'Evaluate newer MCP interoperability',
    summary: 'Assess current Model Context Protocol changes for a safe compatibility layer in Wanigan’s provider and task integrations.',
    recommendation: 'Create a research-and-design Goal for MCP compatibility. Pin the target specification, test only explicit transports, and retain the existing approval boundary for any write-capable tool.',
    keywords: ['mcp', 'model context protocol', 'tasks'], missingCapability: 'mcpSpecCompatibilityAudit',
    score: 81, confidence: 0.76, effort: 'medium', risk: 'elevated', sources: ['github-changelog', 'anthropic-platform-release-notes'],
  },
  {
    id: 'release-api-watch-adapter', category: 'release intelligence',
    title: 'Evaluate curated release-watch adapters',
    summary: 'Track selected upstream releases through versioned APIs instead of relying only on human reading of changelog pages.',
    recommendation: 'Create a Goal to design an opt-in, per-source release adapter with HTTPS allow-lists, ETags, bounded data retention, and no credentials by default.',
    keywords: ['release', 'latest release', 'releases api'], missingCapability: 'releaseApiWatchAdapter',
    score: 67, confidence: 0.68, effort: 'medium', risk: 'low', sources: ['github-releases-rest-docs'],
  },
  {
    id: 'provider-change-evaluation-recipes', category: 'model evaluation',
    title: 'Evaluate new provider capabilities before routing work to them',
    summary: 'Turn announced model or agent changes into a repeatable evaluation recipe before adopting them for real projects.',
    recommendation: 'Create a Goal for provider-change evaluation recipes: version the benchmark, capture provider/model/effort, run the existing review gate, and require a human routing decision.',
    keywords: ['model', 'agent', 'api'], missingCapability: 'providerChangeEvaluationRecipes',
    score: 73, confidence: 0.62, effort: 'medium', risk: 'low', sources: ['openai-release-notes', 'anthropic-platform-release-notes'],
  },
];

function hasTerm(text: string, term: string): boolean {
  return text.toLocaleLowerCase().includes(term.toLocaleLowerCase());
}

function capabilities(inventory: Record<string, unknown>): Record<string, boolean> {
  const raw = inventory.capabilities;
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, boolean> : {};
}

function rulesFor(source: TrustedSource, document: CollectedSource, inventory: Record<string, unknown>): GapRule[] {
  const local = capabilities(inventory);
  return GAP_RULES.filter((rule) => rule.sources.includes(source.id)
    && local[rule.missingCapability] !== true
    && rule.keywords.some((term) => hasTerm(document.text, term)));
}

function insertEvidence(runId: string, source: TrustedSource, document: CollectedSource): ImprovementScoutEvidence {
  const id = uid('scout_ev');
  const retrievedAt = Date.now();
  const contentHash = hash(document.text);
  db().prepare(`INSERT INTO improvement_scout_evidence
    (id,run_id,suggestion_id,source_id,source_title,source_url,publisher,excerpt,content_hash,published_at,retrieved_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, runId, null, source.id, document.title, source.url, source.publisher,
    document.excerpt, contentHash, document.publishedAt, retrievedAt,
  );
  return {
    id, runId, suggestionId: null, sourceId: source.id, title: document.title,
    url: source.url, publisher: source.publisher, excerpt: document.excerpt,
    contentHash, publishedAt: document.publishedAt, retrievedAt,
  };
}

function upsertSuggestion(runId: string, source: TrustedSource, evidence: ImprovementScoutEvidence, rule: GapRule): string {
  // A capability gap is one durable proposal, not one proposal per changed
  // changelog page. Fresh source snapshots attach new evidence to this stable
  // rule fingerprint while preserving any human dismissal, note, or Goal.
  const fingerprint = hash(rule.id);
  const existing = db().prepare('SELECT id FROM improvement_scout_suggestions WHERE fingerprint=?').get(fingerprint) as { id: string } | undefined;
  const now = Date.now();
  const id = existing?.id ?? uid('scout_idea');
  if (existing) {
    // Preserve a human dismissal, note and Goal link. New supporting evidence
    // should refresh a proposal, never override a decision.
    db().prepare(`UPDATE improvement_scout_suggestions SET run_id=?,updated_at=?,why_now=? WHERE id=?`).run(
      runId, now, `${source.publisher} source “${evidence.title}” currently matches the deterministic ${rule.id} rule.`, id,
    );
  } else {
    db().prepare(`INSERT INTO improvement_scout_suggestions
      (id,fingerprint,run_id,status,category,title,summary,why_now,recommendation,score,confidence,effort,risk,analysis_method,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, fingerprint, runId, 'new', rule.category, rule.title, rule.summary,
      `${source.publisher} source “${evidence.title}” matched the deterministic ${rule.id} rule.`,
      rule.recommendation, rule.score, rule.confidence, rule.effort, rule.risk,
      ANALYSIS_METHOD, now, now,
    );
  }
  // A single source can match more than one rule. Record every connection in
  // the join table instead of overwriting evidence.suggestion_id with the
  // last rule visited; existing direct links are migrated in db.ts.
  db().prepare(`INSERT OR IGNORE INTO improvement_scout_suggestion_evidence
    (suggestion_id,evidence_id,created_at) VALUES (?,?,?)`).run(id, evidence.id, now);
  return id;
}

function updateSourceStatus(id: string, status: 'ok' | 'failed' | 'skipped', detail: string | null): void {
  db().prepare(`UPDATE improvement_scout_sources
    SET last_checked_at=?,last_status=?,last_detail=?,updated_at=? WHERE id=?`).run(Date.now(), status, detail, Date.now(), id);
}

function runningRow(): RunRow | undefined {
  return db().prepare("SELECT * FROM improvement_scout_runs WHERE status='running' LIMIT 1").get() as RunRow | undefined;
}

/**
 * How long a 'running' row is believed before it is treated as abandoned.
 *
 * The running row is a durable cross-process claim shared with the launchd
 * daemon, and the schema carries no heartbeat or pid — so age is the only
 * liveness signal there is. A real pass is bounded by its sequential source
 * fetches, each capped at 12s, plus local database work: about a minute at the
 * outside. Fifteen leaves a slept laptop, a stalled socket and a slow disk far
 * more room than they need, while making a pass killed mid-flight self-healing
 * instead of jamming the feature forever with no UI path to clear it.
 */
const STALE_RUN_MS = 15 * 60_000;

/**
 * Releases a claim whose process is gone. Only ever rewrites the status of a
 * row that is already past the staleness window; the row itself is kept, along
 * with the evidence hanging off it, because a Scout run is a record of what
 * happened and deleting it would cascade that evidence away.
 *
 * A suspended pass that does wake up and finish lands its own UPDATE on the
 * same row and replaces this verdict with what actually happened. It never
 * writes 'running' again, so it cannot collide with the claim taken here.
 */
function reclaimStaleRun(now: number): void {
  db().prepare(`UPDATE improvement_scout_runs SET status='failed',ended_at=?,detail=?,error=?
    WHERE status='running' AND started_at < ?`).run(
    now,
    'Wanigan stopped before this pass finished, so nothing was proposed from it.',
    `The run was still marked running ${Math.round(STALE_RUN_MS / 60_000)} minutes after it started with no process left to finish it. The claim was released so the Scout can run again.`,
    now - STALE_RUN_MS,
  );
}

function createRun(mode: ImprovementScoutRunMode, networkAllowed: boolean, inventory: Record<string, unknown>): RunRow | null {
  // Before the claim is read, not after: a crash, quit or kill leaves the row
  // behind and only this releases it. A pass that is genuinely still running is
  // younger than the window and still blocks below.
  reclaimStaleRun(Date.now());
  const existing = runningRow();
  if (existing) return null;
  const row: RunRow = {
    id: uid('scout_run'), mode, status: 'running', network_allowed: networkAllowed ? 1 : 0,
    source_count: 0, evidence_count: 0, suggestion_count: 0, analysis_method: ANALYSIS_METHOD,
    started_at: Date.now(), ended_at: null, detail: null, error: null,
  };
  try {
    db().prepare(`INSERT INTO improvement_scout_runs
      (id,mode,status,network_allowed,source_count,evidence_count,suggestion_count,analysis_method,inventory_json,started_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      row.id, row.mode, row.status, row.network_allowed, 0, 0, 0, ANALYSIS_METHOD,
      JSON.stringify(inventory), row.started_at,
    );
    return row;
  } catch (error) {
    // A different process can win between the SELECT and INSERT. The partial
    // unique index is authoritative; re-read it rather than launching a second
    // scan or treating the race as a data-corruption failure.
    if (/UNIQUE constraint failed/i.test(error instanceof Error ? error.message : String(error))) return null;
    throw error;
  }
}

export type RunScoutInput = { mode?: ImprovementScoutRunMode; allowNetwork?: boolean };

/**
 * A manual click may permit one visible source pass; the stored network flag
 * is required only for unattended weekly runs. Neither path runs a provider
 * model, executes source content, or changes code.
 */
export async function run(input: RunScoutInput = {}): Promise<ImprovementScoutRun> {
  const config = settings();
  if (!config.enabled) throw new Error('AI Improvement Scout is disabled in Settings.');
  const mode: ImprovementScoutRunMode = input.mode === 'scheduled' ? 'scheduled'
    : input.mode === 'preview' ? 'preview' : 'manual';
  // Preview is a hard local-only path even if unattended research happens to
  // be enabled. It is useful for confirming the capability inventory without
  // turning a read-only UI affordance into surprise egress.
  const networkAllowed = mode === 'scheduled' ? config.networkEnabled
    : mode === 'preview' ? false : input.allowNetwork === true;
  const inventory = localInventory();
  const row = createRun(mode, networkAllowed, inventory);
  if (!row) {
    const active = runningRow();
    if (mode === 'scheduled' && active) return mapRun(active);
    throw new Error(`An AI Improvement Scout run is already in progress. It is shared safely between the desktop app and the local scheduler; a pass interrupted mid-flight releases its claim after ${Math.round(STALE_RUN_MS / 60_000)} minutes.`);
  }

  const finish = (status: ImprovementScoutRunStatus, patch: Partial<RunRow>): ImprovementScoutRun => {
    const endedAt = Date.now();
    db().prepare(`UPDATE improvement_scout_runs SET status=?,source_count=?,evidence_count=?,suggestion_count=?,ended_at=?,detail=?,error=? WHERE id=?`).run(
      status, patch.source_count ?? 0, patch.evidence_count ?? 0, patch.suggestion_count ?? 0,
      endedAt, patch.detail ?? null, patch.error ?? null, row.id,
    );
    return mapRun({ ...row, ...patch, status, ended_at: endedAt });
  };

  if (!networkAllowed) {
    return finish('completed', {
      detail: 'Local capability inventory refreshed. No official source was contacted; click Research now for one explicit online pass, or enable weekly online research.',
    });
  }

  const activeSources = sourceRows(true);
  if (!activeSources.length) {
    return finish('blocked', { detail: 'No official Scout sources are enabled. Enable at least one source before online research.' });
  }

  let evidenceCount = 0;
  let suggestionCount = 0;
  const failures: string[] = [];
  for (const source of activeSources) {
    try {
      // `source` comes from the static registry, never from the database nor
      // IPC. The DB only stores a local enabled/disabled preference.
      const document = await sourceFetcher(source);
      const evidence = insertEvidence(row.id, source, document);
      evidenceCount++;
      updateSourceStatus(source.id, 'ok', `Checked ${new Date(evidence.retrievedAt).toLocaleString()}.`);
      for (const rule of rulesFor(source, document, inventory)) {
        upsertSuggestion(row.id, source, evidence, rule);
        suggestionCount++;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      updateSourceStatus(source.id, 'failed', detail);
      failures.push(`${source.label}: ${detail}`);
    }
  }
  if (!evidenceCount) {
    return finish('failed', {
      source_count: activeSources.length,
      detail: 'No official source could be read. Nothing was proposed.',
      error: failures.join(' · ').slice(0, 1_500) || 'Official sources returned no readable content.',
    });
  }
  const failureNote = failures.length ? ` ${failures.length} source${failures.length === 1 ? '' : 's'} could not be read.` : '';
  return finish('completed', {
    source_count: activeSources.length,
    evidence_count: evidenceCount,
    suggestion_count: suggestionCount,
    detail: `Read ${evidenceCount} official source${evidenceCount === 1 ? '' : 's'}; deterministic rules surfaced ${suggestionCount} matching proposal${suggestionCount === 1 ? '' : 's'}.${failureNote}`,
  });
}

export async function runScheduled(): Promise<ImprovementScoutRun> {
  if (!scheduledResearchAllowed()) {
    // This is normally unreachable because syncWeeklySchedule disarms the
    // row. It covers a queue item already claimed by the other process while
    // the operator was changing settings; no egress and no retry follow.
    const inventory = localInventory();
    const row = createRun('scheduled', false, inventory);
    if (!row) {
      const active = runningRow();
      if (active) return mapRun(active);
      throw new Error('Could not record the paused Scout schedule run.');
    }
    const endedAt = Date.now();
    db().prepare(`UPDATE improvement_scout_runs
      SET status='blocked',ended_at=?,detail=?,error=NULL WHERE id=?`).run(
      endedAt, 'Weekly research was paused before this queued pass began. No official source was contacted.', row.id,
    );
    return mapRun({ ...row, status: 'blocked', ended_at: endedAt, detail: 'Weekly research was paused before this queued pass began. No official source was contacted.' });
  }
  return run({ mode: 'scheduled' });
}

export function updateSuggestion(id: string, patch: { status?: ImprovementScoutSuggestionStatus; note?: string | null }): ImprovementScoutSuggestion {
  const current = suggestion(id);
  if (current.goalId && patch.status !== undefined && patch.status !== 'goal-created') {
    throw new Error('This proposal already has a Control Goal. Its Goal link is the durable decision record.');
  }
  if (patch.status === 'goal-created') throw new Error('Use Create Goal to link a Scout proposal to Control.');
  if (patch.status !== undefined && !['new', 'reviewed', 'snoozed', 'dismissed'].includes(patch.status)) {
    throw new Error('Unknown Scout suggestion status.');
  }
  let note = current.note;
  if (patch.note !== undefined) {
    if (patch.note !== null && (typeof patch.note !== 'string' || patch.note.trim().length > MAX_NOTE)) {
      throw new Error(`Scout note must be at most ${MAX_NOTE.toLocaleString()} characters.`);
    }
    note = patch.note?.trim() || null;
  }
  const status = patch.status ?? current.status;
  db().prepare(`UPDATE improvement_scout_suggestions SET status=?,note=?,reviewed_at=?,updated_at=? WHERE id=?`).run(
    status, note, status === 'new' ? null : Date.now(), Date.now(), id,
  );
  return suggestion(id);
}

/**
 * A proposal becomes a Goal only at an explicit operator action. Its evidence
 * is copied into a Control proof record so the eventual agent/reviewer sees
 * where the idea came from without trusting an invisible Scout summary.
 */
export function createGoal(id: string, input: { projectId: string }): ImprovementScoutGoal {
  if (!input || typeof input.projectId !== 'string' || !input.projectId.trim()) {
    throw new Error('Choose a project before turning a Scout proposal into a Goal.');
  }
  const idea = suggestion(id);
  if (!idea.evidence.length) {
    throw new Error('This proposal has no retained official evidence. Run online research again before creating a Goal from it.');
  }
  if (idea.goalId) return { goalId: idea.goalId, goalUrl: `#goal=${encodeURIComponent(idea.goalId)}` };
  const citations = idea.evidence.map((evidence) => `- ${evidence.publisher}: ${evidence.title} (${evidence.url})`).join('\n');
  const acceptance = [
    'Confirm the upstream capability and applicability against the cited official source.',
    'Write a bounded design that preserves Wanigan’s approval and privacy boundaries.',
    'Run targeted verification and record a human review decision before adoption.',
  ];
  const objective = [idea.recommendation, '', 'Why now:', idea.whyNow, '', 'Official evidence:', citations || '- No evidence was retained. Re-run research before implementation.'].join('\n');
  const goal: DocketDetail = control.createDocket({
    projectId: input.projectId.trim(), title: idea.title, objective, acceptance,
    risk: idea.risk === 'high' ? 'high' : idea.risk === 'low' ? 'low' : 'elevated',
  });
  const proofId = uid('proof');
  db().prepare(`INSERT INTO work_proofs (id,docket_id,node_id,kind,status,summary,detail_json,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    proofId, goal.id, null, 'plan', 'recorded', `Scout evidence linked to “${idea.title}”.`,
    JSON.stringify(idea.evidence.map((evidence) => ({ publisher: evidence.publisher, title: evidence.title, url: evidence.url, retrievedAt: evidence.retrievedAt }))),
    Date.now(),
  );
  db().prepare(`UPDATE improvement_scout_suggestions
    SET status='goal-created',docket_id=?,reviewed_at=?,updated_at=? WHERE id=?`).run(goal.id, Date.now(), Date.now(), id);
  return { goalId: goal.id, goalUrl: `#goal=${encodeURIComponent(goal.id)}` };
}

/** Test-only hooks: no browser/renderer can reach these. They make source
 * collection and rule/dedup paths verifiable without real egress. */
export const __test = {
  trustedSources: () => TRUSTED_SOURCES.map((source) => ({ ...source })),
  normalizeDocument: (raw: string, fallback = 'Test source') => ({
    title: sourceTitle(raw, fallback), text: textFromDocument(raw), publishedAt: maybePublishedAt(raw),
  }),
  matchingRuleIds: (sourceId: string, text: string) => {
    const source = SOURCE_BY_ID.get(sourceId);
    return source ? rulesFor(source, { title: source.label, text, excerpt: text.slice(0, MAX_EXCERPT), publishedAt: null }, localInventory()).map((rule) => rule.id) : [];
  },
  setFetcher: (fetcher: SourceFetcher | null) => { sourceFetcher = fetcher ?? fetchTrustedSource; },
  resetFetcher: () => { sourceFetcher = fetchTrustedSource; },
  syncWeeklySchedule,
  scheduleId: SCOUT_SCHEDULE_ID,
};
