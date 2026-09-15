/**
 * The shapes the review channels hand the renderer. Types only: the decisions
 * live in review-marks, edit-attribution, review-order, risk-tiers,
 * dependencies, claims, hunk-attribution and regression-proof, and the git in
 * src/main. Kept here so the preload bridge and the renderer read the same
 * declaration main returns, without either importing main.
 */
import type { FileReview, NeedsReviewVerdict, ReviewFile, TurnState } from './review-marks.ts';
import type { Attribution } from './edit-attribution.ts';
import type { FileKind, TestAlarm } from './review-order.ts';
import type { RiskTier } from './risk-tiers.ts';
import type { DepChange, ManifestKind } from './dependencies.ts';
import type { GradedClaim } from './claims.ts';
import type { ProofRun, ProofVerdict } from './regression-proof.ts';

export type ReviewWorkFile = ReviewFile & {
  review: FileReview;
  attribution: Attribution;
  attributionLabel: string;
  tier: RiskTier | null;
  kind: FileKind;
  alarms: TestAlarm[];
  image: boolean;
};

export type ReviewWork = {
  sessionId: string;
  root: string;
  base: string | null;
  anchor: string | null;
  turn: TurnState;
  files: ReviewWorkFile[];
  verdict: NeedsReviewVerdict;
  label: string;
  hooksRecorded: boolean;
  shellDiffReported: boolean;
  tiersConfigured: boolean;
  highTierUnapproved: string[];
  truncated: boolean;
  patchTruncated: boolean;
  unreadable: string | null;
  projectId: string | null;
};

export type ReviewSummary = {
  sessionId: string;
  needsReview: boolean;
  reason: NeedsReviewVerdict['reason'];
  because: string;
  label: string;
  counts: NeedsReviewVerdict['counts'];
  highTierUnapproved: number;
};

export type ReviewImageSide = { dataUrl: string | null; bytes: number | null; note: string | null };

export type ManifestReview = {
  path: string;
  kind: ManifestKind;
  changes: DepChange[];
  lines: string[];
  note: string | null;
  error: string | null;
};

export type DependencyReview = {
  manifests: ManifestReview[];
  installs: { command: string; ok: boolean | null; exitCode: number | null; at: number }[];
  hooksRecorded: boolean;
};

export type ClaimsReview =
  | { state: 'graded'; source: string; claims: GradedClaim[]; messageChars: number }
  | { state: 'unsupported' | 'working' | 'no-message' | 'no-base'; reason: string };

export type MergeCheck = { allowed: boolean; sessionId: string | null; highTier: string[]; detail: string | null };

export type StagePlanFile = {
  path: string;
  action: 'stage' | 'refuse' | 'already-staged';
  turns: number[];
  /** Also changed outside the turns, in hunks that stay unstaged. */
  mixed: boolean;
  reason: string | null;
  patch: string;
};

export type StagePlan = {
  ok: boolean;
  refusal: string | null;
  digest: string | null;
  root: string | null;
  files: StagePlanFile[];
  /** Changed in the working tree against the index, and produced by no turn. */
  untouched: string[];
  patch: string;
  turns: number;
};

export type RegressionProofRecord = {
  id: string;
  nodeId: string;
  command: string;
  verdict: ProofVerdict;
  label: string;
  because: string;
  before: ProofRun;
  after: ProofRun;
  linked: string[];
  createdAt: number;
};

export type PrDraft =
  | { kind: 'draft'; body: string; sessionId: string; goalTitle: string | null }
  | { kind: 'none'; reason: string };

export type TurnStat = { files: number; added: number; removed: number };
