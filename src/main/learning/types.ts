/**
 * Provider-neutral contracts for Wanigan's learning engine.
 *
 * These types intentionally contain provider and backend ids as opaque strings.
 * A learning artifact must remain useful when a provider pack is removed, and a
 * provider pack must not have to teach the database a new enum before it can be
 * installed.
 */

export const KNOWLEDGE_KINDS = [
  'instruction', 'rule', 'memory', 'skill', 'mission', 'gate', 'eval', 'project-map',
] as const;
export type KnowledgeKind = (typeof KNOWLEDGE_KINDS)[number];

export const ARTIFACT_SCOPES = ['personal', 'project', 'path'] as const;
export type ArtifactScope = (typeof ARTIFACT_SCOPES)[number];

export const SIGNAL_KINDS = [
  'explicit-teach', 'correction', 'accepted-review', 'rejected-review',
  'gate-passed', 'gate-failed', 'tool-success', 'tool-failure',
  'permission-denied', 'repair', 'compaction', 'cache', 'revert',
  'session-success', 'session-failure', 'file-change',
] as const;
export type BuiltinSignalKind = (typeof SIGNAL_KINDS)[number];
/** Provider packs may add a namespaced signal without changing core. */
export type LearningSignalKind = BuiltinSignalKind | (string & {});

export type CandidateStatus =
  | 'pending' | 'approved' | 'rejected' | 'snoozed'
  | 'promoted' | 'applied' | 'failed' | 'superseded';
export type KnowledgeStatus = 'active' | 'quarantined' | 'retired';
export type ProjectionStatus = 'preview' | 'applied' | 'stale' | 'undone' | 'failed';
export type ExperimentStatus = 'draft' | 'running' | 'completed' | 'cancelled' | 'failed';
export type EvidenceLevel = 'estimate' | 'correlation' | 'causal';
export type RelationKind = 'supports' | 'contradicts' | 'supersedes' | 'duplicates';

export type JsonObject = Record<string, unknown>;

export interface LearningSignal {
  id: string;
  kind: LearningSignalKind;
  /** Harness/profile that observed the signal. */
  providerId: string | null;
  /** Data processor/model backend. This is the privacy boundary. */
  backendId: string | null;
  sessionId: string | null;
  taskHash: string | null;
  projectId: string | null;
  projectPath: string | null;
  pathScope: string | null;
  summary: string;
  detail: JsonObject;
  contentHash: string;
  /** False for external/MCP/web/attachment-derived or opted-out content. */
  semanticEligible: boolean;
  createdAt: number;
  processedAt: number | null;
}

export interface RecordSignalInput {
  kind: LearningSignalKind;
  providerId?: string | null;
  backendId?: string | null;
  sessionId?: string | null;
  taskHash?: string | null;
  projectId?: string | null;
  projectPath?: string | null;
  pathScope?: string | null;
  summary: string;
  detail?: JsonObject;
  semanticEligible?: boolean;
  createdAt?: number;
}

export interface KnowledgeItem {
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
}

export interface KnowledgeVersion {
  id: string;
  itemId: string;
  version: number;
  canonicalText: string;
  metadata: JsonObject;
  contentHash: string;
  createdBy: string;
  previousVersionId: string | null;
  createdAt: number;
}

export interface KnowledgeCandidate {
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
}

export interface CandidateConflict {
  itemId: string;
  title: string;
  relation: 'possible-conflict' | 'duplicate';
  reason: string;
}

export interface CreateCandidateInput {
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
}

export interface KnowledgeEvidence {
  id: string;
  itemId: string | null;
  versionId: string | null;
  candidateId: string | null;
  signalId: string | null;
  sourceType: string;
  sourceId: string;
  /** Human-readable file/commit/test/session citation. */
  citation: string;
  contentHash: string | null;
  weight: number;
  observedAt: number;
}

export interface AddEvidenceInput {
  itemId?: string | null;
  versionId?: string | null;
  candidateId?: string | null;
  signalId?: string | null;
  sourceType: string;
  sourceId: string;
  citation?: string;
  contentHash?: string | null;
  weight?: number;
  observedAt?: number;
}

export interface KnowledgeRelation {
  fromItemId: string;
  toItemId: string;
  relation: RelationKind;
  confidence: number;
  evidence: JsonObject;
  createdAt: number;
  resolvedAt: number | null;
}

export interface KnowledgeProjection {
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
  /** Roots granted at preview time; undo verifies against these when the
   * provider profile or project registration is gone. Empty for legacy rows. */
  allowedRoots: string[];
}

export interface ProjectionPreviewInput {
  candidateId: string;
  itemId?: string | null;
  versionId?: string | null;
  providerId: string;
  adapterId: string;
  scope: ArtifactScope;
  projectId?: string | null;
  targetPath: string;
  targetFormat: string;
  /** The complete desired file, never an untrusted shell patch. */
  proposedContent: string;
}

export interface ProjectionSafety {
  /** Explicit roots granted by the integration layer for this operation. */
  allowedRoots: string[];
  actor: 'user' | 'automation';
  maxBytes?: number;
}

export interface ProjectionValidation {
  safe: boolean;
  currentHash: string;
  stale: boolean;
  reason: string | null;
}

export type ArtifactDeliveryMode =
  | 'file' | 'briefing' | 'wanigan-gate' | 'wanigan-eval' | 'unsupported';

export interface ArtifactCompilation {
  supported: boolean;
  mode: ArtifactDeliveryMode;
  providerId: string;
  adapterId: string;
  reason: string;
  targetPath: string | null;
  targetFormat: string | null;
  proposedContent: string | null;
  /** Generated/native memory is provider-owned and never a projection target. */
  nativeMemoryAccess: 'none' | 'read-only';
}

export interface ArtifactCompilerContext {
  providerId: string;
  /** Required for project/path projections. */
  projectRoot?: string | null;
  /** The actual OS home; injectable so tests never touch a real profile. */
  homeDir: string;
  /** Optional bounded reader supplied by an adapter/test. */
  readExisting?: (absolutePath: string) => string | null;
}

export interface ProviderArtifactCompiler {
  adapterId: string;
  nativeMemoryAccess: 'none' | 'read-only';
  compile(candidate: KnowledgeCandidate, context: ArtifactCompilerContext): ArtifactCompilation;
}

export interface ClassificationHints {
  targetKind?: KnowledgeKind;
  scope?: ArtifactScope;
  pathScope?: string | null;
  repeatedProcedure?: boolean;
  hardSafetyRequirement?: boolean;
  regression?: boolean;
  alwaysOn?: boolean;
}

export interface ClassificationResult {
  targetKind: KnowledgeKind;
  scope: ArtifactScope;
  pathScope: string | null;
  confidence: number;
  reasons: string[];
}

export interface AutomationPolicy {
  minConfidence: number;
  minEvidence: number;
  minIndependentTasks: number;
}

export type AutomationDecision = {
  decision: 'auto-apply' | 'review' | 'blocked';
  reason: string;
};

export interface SemanticEligibilityInput {
  extractionProviderId?: string | null;
  extractionBackendId?: string | null;
  allowModelAssistance: boolean;
  excludedContent?: boolean;
}

export interface SemanticEligibility {
  eligible: boolean;
  reason: string;
}

export interface KnowledgeSearchInput {
  query: string;
  /** Interactive search requires every term; task retrieval may rank any relevant term. */
  match?: 'all' | 'any';
  projectId?: string | null;
  path?: string | null;
  kinds?: KnowledgeKind[];
  statuses?: KnowledgeStatus[];
  limit?: number;
}

export interface KnowledgeSearchResult {
  item: KnowledgeItem;
  rank: number;
  version: KnowledgeVersion | null;
}

export interface BriefingInput {
  query: string;
  providerId: string;
  /** Frozen model-backend identity; semantic privacy is keyed here, not to a mutable profile id. */
  backendId?: string | null;
  projectId?: string | null;
  path?: string | null;
  maxTokens?: number;
  kinds?: KnowledgeKind[];
  projectRoot?: string | null;
  allowedEvidenceRoots?: string[];
  /**
   * Default true: a launch is the last safe moment to pull a stale fact out of
   * circulation. A PREVIEW must pass false — a read that quarantines is not a
   * read, and an inspector must never mutate what it inspects.
   */
  quarantineStale?: boolean;
}

export interface BriefingEntry {
  itemId: string;
  versionId: string | null;
  kind: KnowledgeKind;
  title: string;
  text: string;
  citations: string[];
  estimatedTokens: number;
}

export interface KnowledgeBriefing {
  text: string;
  entries: BriefingEntry[];
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
}

/**
 * One recorded briefing delivery. The launch site used to compute the capsule
 * and throw everything but its text away; this row is what makes "this session
 * received briefing X" a recorded fact instead of a guess.
 */
export interface SessionBriefingRecord {
  sessionId: string;
  at: number;
  /** How the capsule reached the agent: launch argv or the SessionStart hook. */
  delivery: 'argv' | 'hook';
  providerId: string | null;
  projectId: string | null;
  entries: {
    itemId: string;
    versionId: string | null;
    kind: KnowledgeKind;
    title: string;
    estimatedTokens: number;
  }[];
  /** estimateTokens() output — a directional estimate, never a measurement. */
  estimatedTokens: number;
  maxTokens: number;
  omittedStale: number;
  omittedBudget: number;
}

/** One consolidation pass, persisted so automation stops being silent. */
export interface ConsolidationRun {
  id: string;
  at: number;
  trigger: 'timer' | 'manual';
  processed: number;
  candidates: number;
  autoApplied: number;
  durationMs: number;
}

/**
 * Everything the learning engine can honestly say about one session: the
 * briefing it received (recorded at injection), the signals it emitted, and
 * the knowledge its evidence reached. Every field is a query over stored rows.
 */
export interface SessionLearningLedger {
  sessionId: string;
  briefings: SessionBriefingRecord[];
  signals: LearningSignal[];
  /** Knowledge items citing this session's signals via knowledge_evidence. */
  contributions: { itemId: string; title: string; kind: KnowledgeKind; status: KnowledgeStatus; evidenceCount: number }[];
  /** Candidates whose signal lineage includes this session's signals. */
  candidates: { candidateId: string; title: string; status: CandidateStatus; targetKind: KnowledgeKind }[];
}

/**
 * The automation gate's checks, decomposed for display. Same deterministic
 * inputs as automationDecision — actual values against required thresholds,
 * so the Inbox can say why an item waits instead of presenting magic.
 */
export interface CandidateExplanation {
  candidateId: string;
  decision: AutomationDecision['decision'];
  reason: string;
  checks: { label: string; ok: boolean; actual: string; required: string }[];
}

/** Observed pipeline throughput; every number is a COUNT over stored rows. */
export interface LearningPipelineStats {
  windowDays: number;
  signals: number;
  /** Same project scoping, no time window — lets "outside this window" be a fact. */
  signalsAllTime: number;
  eligibleSignals: number;
  candidatesCreated: number;
  autoPromoted: number;
  reviewed: number;
  itemsPromoted: number;
  projectionsApplied: number;
  briefingsServed: number;
  /** Continuous local-midnight day series, oldest first, zero-filled. */
  signalsByDay: { day: string; total: number; failures: number; teachings: number }[];
  consolidationRuns: ConsolidationRun[];
}

export interface FreshnessIssue {
  evidenceId: string;
  sourceId: string;
  kind: 'missing' | 'changed' | 'outside-root' | 'unverifiable';
  detail: string;
}

export interface FreshnessResult {
  itemId: string;
  fresh: boolean;
  checkedAt: number;
  /** File-backed citations actually re-hashed this pass. */
  checked: number;
  /** Citations with no checkable file (e.g. learning-signal rows) — never verified. */
  skipped: number;
  issues: FreshnessIssue[];
}

export type OptimizerDiagnosticKind =
  | 'duplicate' | 'contradiction' | 'expired' | 'weak-evidence'
  | 'oversized' | 'unused' | 'projection-drift' | 'demote-to-skill'
  | 'volatile-prefix' | 'repeated-prefix';

export interface OptimizerDiagnostic {
  kind: OptimizerDiagnosticKind;
  severity: 'info' | 'warning' | 'error';
  itemIds: string[];
  title: string;
  detail: string;
  estimatedTokenDelta: number;
}

export interface SkillStep {
  title: string;
  instruction: string;
  tool?: string | null;
}

export interface ForgeSkillInput {
  name: string;
  description: string;
  trigger: string;
  scope: 'personal' | 'project';
  inputs?: string[];
  steps: SkillStep[];
  verification: string[];
  safety?: string[];
  allowedTools?: string[];
  providerIds?: string[];
}

export interface ForgedSkill {
  name: string;
  scope: 'personal' | 'project';
  skillMd: string;
  allowedTools: string[];
  providerIds: string[];
  estimatedTokens: number;
}

export interface SkillDiagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  line?: number;
}

export interface LearningExperiment {
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
  config: JsonObject;
  status: ExperimentStatus;
  outcome: JsonObject | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
}

export interface CreateExperimentInput {
  name: string;
  projectId?: string | null;
  itemId?: string | null;
  candidateId?: string | null;
  baselineVersionId?: string | null;
  candidateVersionId?: string | null;
  providerId: string;
  model: string;
  effort?: string | null;
  commitHash: string;
  config?: JsonObject;
}

export interface ArtifactMetric {
  id: string;
  itemId: string | null;
  versionId: string | null;
  projectionId: string | null;
  sessionId: string | null;
  providerId: string | null;
  /** The controlled run this measurement came from; required for a causal claim. */
  experimentId: string | null;
  metric: string;
  value: number;
  evidenceLevel: EvidenceLevel;
  attrs: JsonObject;
  at: number;
}

export interface RecordMetricInput {
  itemId?: string | null;
  versionId?: string | null;
  projectionId?: string | null;
  sessionId?: string | null;
  providerId?: string | null;
  experimentId?: string | null;
  metric: string;
  value: number;
  evidenceLevel: EvidenceLevel;
  attrs?: JsonObject;
  at?: number;
}

export interface ArtifactRoiSummary {
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
}
