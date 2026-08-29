import type {
  ArtifactScope, AutomationDecision, AutomationPolicy, ClassificationHints,
  ClassificationResult, KnowledgeCandidate, KnowledgeKind, LearningSignal,
} from './types';
import { clamp } from './util';

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  minConfidence: 0.9,
  minEvidence: 2,
  minIndependentTasks: 2,
};

function hintedScope(signal: LearningSignal, hints: ClassificationHints): ArtifactScope {
  if (hints.scope) return hints.scope;
  if (hints.pathScope || signal.pathScope) return 'path';
  return signal.projectId ? 'project' : 'personal';
}

/** A deterministic first pass. A same-provider model may refine it later. */
export function classifySignal(signal: LearningSignal, hints: ClassificationHints = {}): ClassificationResult {
  const reasons: string[] = [];
  let targetKind: KnowledgeKind = 'memory';
  let confidence = 0.56;

  if (hints.targetKind) {
    targetKind = hints.targetKind;
    confidence = 0.95;
    reasons.push('An explicit target was supplied.');
  } else if (hints.hardSafetyRequirement || signal.kind === 'permission-denied') {
    targetKind = 'gate'; confidence = 0.83;
    reasons.push('Hard safety and permission requirements belong in an enforceable gate.');
  } else if (hints.regression || signal.kind === 'rejected-review' || signal.kind === 'revert') {
    targetKind = 'eval'; confidence = 0.78;
    reasons.push('A rejected or reverted outcome should become repeatable regression evidence.');
  } else if (hints.repeatedProcedure || signal.detail.repeatedProcedure === true) {
    targetKind = 'skill'; confidence = 0.86;
    reasons.push('A repeatable ordered workflow should be loaded as a skill on demand.');
  } else if (signal.kind === 'gate-failed' || signal.kind === 'tool-failure' || signal.kind === 'session-failure') {
    targetKind = 'eval'; confidence = 0.7;
    reasons.push('A failure is preserved as an evaluation until a stable rule is demonstrated.');
  } else if (signal.kind === 'file-change') {
    targetKind = 'project-map'; confidence = 0.72;
    reasons.push('File topology belongs in the incrementally refreshed project map.');
  } else if (hints.alwaysOn) {
    targetKind = signal.pathScope || hints.pathScope ? 'rule' : 'instruction'; confidence = 0.84;
    reasons.push('An always-on invariant is routed to scoped instructions.');
  } else if (signal.kind === 'correction' || signal.kind === 'accepted-review' || signal.kind === 'explicit-teach') {
    targetKind = signal.pathScope || hints.pathScope ? 'rule' : 'memory'; confidence = 0.75;
    reasons.push('Human teaching starts as recall unless it is explicitly path-scoped.');
  } else if (signal.kind === 'tool-success' || signal.kind === 'session-success' || signal.kind === 'gate-passed') {
    targetKind = 'memory'; confidence = 0.64;
    reasons.push('A successful observation needs repetition before promotion to a procedure.');
  } else {
    reasons.push('Unknown signals use conservative memory routing and require review.');
  }

  const scope = hintedScope(signal, hints);
  const pathScope = scope === 'path' ? (hints.pathScope ?? signal.pathScope) : null;
  if (scope === 'path' && !pathScope) {
    // Never fabricate a broad path selector. Fall back to the discoverable
    // project boundary and make the ambiguity visible in confidence.
    reasons.push('No usable path selector was present; routing fell back to project scope.');
    return { targetKind, scope: signal.projectId ? 'project' : 'personal', pathScope: null, confidence: clamp(confidence - 0.15), reasons };
  }
  return { targetKind, scope, pathScope, confidence: clamp(confidence), reasons };
}

/**
 * Locked hybrid policy: only proven, reversible personal recall can skip the
 * inbox. Personal/global skills still require review because they execute a
 * procedure everywhere.
 */
export function automationDecision(
  candidate: KnowledgeCandidate,
  policy: Partial<AutomationPolicy> = {},
): AutomationDecision {
  const p = { ...DEFAULT_AUTOMATION_POLICY, ...policy };
  if (candidate.status === 'rejected' || candidate.status === 'superseded') {
    return { decision: 'blocked', reason: `Candidate is ${candidate.status}.` };
  }
  if (candidate.conflicts.length) {
    return { decision: 'blocked', reason: 'Candidate conflicts with existing knowledge.' };
  }
  if (candidate.scope !== 'personal') {
    return { decision: 'review', reason: 'Project and path-scoped artifacts always require approval.' };
  }
  if (candidate.targetKind !== 'memory') {
    return { decision: 'review', reason: 'Instructions, skills, gates, missions, maps, and evals always require approval.' };
  }
  if (candidate.confidence < p.minConfidence) {
    return { decision: 'review', reason: `Confidence ${candidate.confidence.toFixed(2)} is below ${p.minConfidence.toFixed(2)}.` };
  }
  if (candidate.evidenceCount < p.minEvidence) {
    return { decision: 'review', reason: `${candidate.evidenceCount} evidence source(s); ${p.minEvidence} required.` };
  }
  if (candidate.taskCount < p.minIndependentTasks) {
    return { decision: 'review', reason: `${candidate.taskCount} independent task(s); ${p.minIndependentTasks} required.` };
  }
  return { decision: 'auto-apply', reason: 'High-confidence personal recall is supported by repeated independent evidence.' };
}
