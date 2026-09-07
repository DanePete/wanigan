import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { getSetting, setSetting } from './settings';
import {
  PAYLOAD_FIELDS, assessRouting, averageCostUsd, meteringVerdict, monthToDateUsd,
  parseClaimReply, readConsent,
} from './learning-model-assist';
import { addProject } from './store';
import {
  REQUIRED_LEARNING_TABLES,
  CLAUDE_ARTIFACT_COMPILER,
  CODEX_ARTIFACT_COMPILER,
  DEFAULT_AUTOMATION_POLICY,
  INJECTABLE_KINDS,
  KNOWLEDGE_KINDS,
  addEvidence,
  briefingFrame,
  estimateTokens,
  applyProjection,
  automationDecision,
  buildBriefing,
  classifySignal,
  compileCandidate,
  compileCandidateProjection,
  completeExperiment,
  createCandidate,
  createExperiment,
  doctorSkill,
  explainCandidate,
  forgeSkill,
  getSignal,
  getKnowledgeItem,
  getProjection,
  listConsolidationRuns,
  listEvidence,
  listMetrics,
  listSessionBriefings,
  listSignals,
  pipelineStats,
  promoteCandidate,
  getCandidate,
  recordConsolidationRun,
  recordModelPhrasing,
  recordMetric,
  recordSessionBriefing,
  recordSignal,
  reviewCandidate,
  sessionLearningLedger,
  searchKnowledge,
  semanticExtractionEligibility,
  startExperiment,
  summarizeArtifactRoi,
  undoProjection,
  validateProjection,
} from './learning';
import {
  BUILTIN_PROVIDER_PACKS,
  ProviderPackRegistry,
  validateProviderPackManifest,
  type ProviderPackManifest,
} from './provider-packs';
import type { ConsolidationCounts, ConsolidationOutcome } from './learning/types';
import { probeProviderAdapter } from './provider-adapter';
import { headlessArgs, headlessEnv, headlessRows, headlessRuns, parseCliOutput, resolveBin, runOneRepo } from './headless';
import { stripAmbientAnthropicCredentials } from './sessions';
import { effectiveProviderBackendId, type ProviderDef } from './providers';
import { kindDelivery, type Session } from '../shared/types';
import * as compound from './learning-service';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function thrown(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Wanigan Compound verification. Everything here is local and deterministic:
 * no provider CLI or model is launched, and every filesystem projection is
 * constrained to a temporary root. The provider-adapter test executes only a
 * tiny, exact-digest fixture inside that root.
 */
/**
 * The counts of a consolidation pass, or null if it refused to run.
 *
 * consolidate() answers a union: a pass that ran, with its counts, or a refusal
 * naming which switch was off. Every call in this suite runs with learning and
 * consolidation on, so a refusal here is a broken fixture rather than a state
 * worth asserting about — and reading it as null makes the assertion that asked
 * fail with the refusal in its detail, rather than crashing the run or letting
 * an absent count read as a zero the pass never reported.
 */
function ranCounts(outcome: ConsolidationOutcome): ConsolidationCounts | null {
  return outcome.ran ? outcome : null;
}

export async function runLearningSmoke(check: Check, say: Say): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-learning-'));
  const projectRoot = path.join(tmp, 'project');
  const fakeHome = path.join(tmp, 'home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(fakeHome, { recursive: true });

  try {
    say('── compound · schema and provider-neutral signals');
    const schemaRows = db().prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as unknown as { name: string }[];
    const schema = new Set(schemaRows.map((row) => row.name));
    for (const table of REQUIRED_LEARNING_TABLES) {
      check(schema.has(table), `learning schema includes ${table}`);
    }
    const sessionColumnRows = db().prepare('PRAGMA table_info(session_log)').all() as { name: string }[];
    const sessionColumns = new Set(sessionColumnRows.map((row) => row.name));
    for (const column of ['provider_pack_id', 'provider_pack_version', 'provider_profile_json', 'backend_id', 'harness_id']) {
      check(sessionColumns.has(column), `session history freezes ${column}`);
    }

    const project = await addProject(projectRoot);
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const firstInput = {
      kind: 'explicit-teach' as const,
      providerId: 'orbit.profile-v9',
      backendId: 'orbit.backend-v9',
      sessionId: `session-a-${tag}`,
      taskHash: `task-a-${tag}`,
      summary: `Mooncalf protocol ${tag}: verify the lock before launch.`,
      detail: { outcome: 'worked', source: 'explicit-user-teach' },
      semanticEligible: true,
    };
    const first = recordSignal(firstInput);
    const duplicate = recordSignal(firstInput);
    const second = recordSignal({
      ...firstInput,
      sessionId: `session-b-${tag}`,
      taskHash: `task-b-${tag}`,
      summary: `Mooncalf protocol ${tag}: a second independent success.`,
    });
    check(first.id === duplicate.id, 'identical signals are content-deduplicated');
    check(first.providerId === 'orbit.profile-v9' && first.backendId === 'orbit.backend-v9',
      'provider and backend ids remain opaque strings');

    const sameBackend = semanticExtractionEligibility(first, {
      extractionProviderId: 'different-harness',
      extractionBackendId: 'orbit.backend-v9',
      allowModelAssistance: true,
    });
    const crossBackend = semanticExtractionEligibility(first, {
      extractionProviderId: first.providerId,
      extractionBackendId: 'some-other-backend',
      allowModelAssistance: true,
    });
    const excluded = semanticExtractionEligibility(first, {
      extractionBackendId: first.backendId,
      allowModelAssistance: true,
      excludedContent: true,
    });
    check(sameBackend.eligible, 'semantic learning permits the same model backend, independent of harness label');
    check(!crossBackend.eligible && /Cross-backend/.test(crossBackend.reason),
      'semantic learning refuses cross-backend content transfer', crossBackend.reason);
    check(!excluded.eligible, 'excluded external content is never semantically learned');

    say('── compound · model-assisted phrasing: consent, routing, metering');
    // The three gates the guardrails require, exercised in the order the router
    // checks them. None of this spawns a CLI: every refusal below is reached
    // before a process would be, which is the property being asserted.
    const priorSwitch = getSetting('learning_model_assistance', '0');
    const priorConsent = getSetting('learning_model_assist_consent', 'null');
    const priorBudget = getSetting('learning_monthly_budget_usd', '0');
    try {
      setSetting('learning_model_assistance', '0');
      setSetting('learning_model_assist_consent', 'null');
      const off = assessRouting('orbit.profile-v9', 'orbit.backend-v9', 5);
      check(!off.ok && off.reason === 'switched-off',
        'with the switch off nothing is routed, and the refusal names the switch rather than a missing approval',
        off);

      setSetting('learning_model_assistance', '1');
      const unattributed = assessRouting(null, null, 5);
      check(!unattributed.ok && unattributed.reason === 'no-attribution',
        'observations with no provider attribution have no backend to be routed back to, so they are refused rather than sent somewhere plausible',
        unattributed);

      const unconsented = assessRouting('orbit.profile-v9', 'orbit.backend-v9', 5);
      check(!unconsented.ok && unconsented.reason === 'not-consented',
        'the switch alone does not authorise a call: with no approval on file the router still refuses',
        unconsented);

      // Approval for one profile is not approval for another. This is the
      // cross-backend rule at the routing layer: content stays with the backend
      // that produced it, so a different provider's observations are refused
      // even though a valid approval exists.
      setSetting('learning_model_assist_consent', JSON.stringify({
        providerId: 'orbit.profile-v9', backendId: 'orbit.backend-v9',
        fingerprint: 'orbit:v9', acceptedAt: Date.now(),
      }));
      const wrongProvider = assessRouting('other.profile', 'other.backend', 5);
      check(!wrongProvider.ok && wrongProvider.reason === 'not-consented'
        && /stays inside the backend/.test(wrongProvider.detail),
        'observations from a provider nobody approved are never phrased by the one that was approved',
        wrongProvider);

      const gone = assessRouting('orbit.profile-v9', 'orbit.backend-v9', 5);
      check(!gone.ok && gone.reason === 'unknown-provider',
        'an approval that names a profile this machine does not have refuses on the missing profile, not on consent',
        gone);

      // Metering, from recorded runs rather than a table of provider names.
      check(meteringVerdict('metering.probe') === 'unproven',
        'a harness nobody has called yet is unproven, never assumed priced');
      const priced = (providerId: string, costReported: 0 | 1) => db().prepare(`
        INSERT INTO learning_model_runs
          (id, at, provider_id, backend_id, cluster_key, status, cost_usd, cost_reported,
           in_tokens, out_tokens, duration_ms, error)
        VALUES (?,?,?,?,?,'ok',?,?,0,0,0,NULL)
      `).run(`mrun-${tag}-${providerId}-${costReported}-${Math.random()}`, Date.now(),
        providerId, null, null, costReported ? 0.25 : 0, costReported);

      priced('metering.silent', 0);
      check(meteringVerdict('metering.silent') === 'unmetered',
        'a harness that ran and reported no usage is proven unmetered by its own call rather than by a hardcoded list');
      priced('metering.loud', 1);
      check(meteringVerdict('metering.loud') === 'metered',
        'a harness that returned a usage figure is metered');

      // An unpriced call contributes nothing to spend: the ledger records that
      // it happened without inventing what it cost.
      const before = monthToDateUsd();
      priced('metering.silent', 0);
      check(monthToDateUsd() === before,
        'a call the harness did not price adds nothing to recorded spend, so an unmetered run can never be presented as a dollar figure');
      priced('metering.loud', 1);
      check(Math.abs(monthToDateUsd() - (before + 0.25)) < 1e-9,
        'and a priced call adds exactly what it reported');

      // The cost lever. A profile's default model is often its most expensive:
      // an observed 12.9c a call on Claude Code against 3.8c for a small model
      // on the same profile. What matters to the ledger is that the figure
      // shown is the observed mean of priced calls, never a modelled one.
      const meanNow = averageCostUsd();
      check(meanNow !== null && Math.abs(meanNow - 0.25) < 1e-9,
        'the average is the mean of what harnesses actually reported',
        meanNow);
      priced('metering.silent', 0);
      check(averageCostUsd() !== null && Math.abs((averageCostUsd() ?? 0) - 0.25) < 1e-9,
        'and an unpriced call does not drag that average toward zero — it is excluded, not counted as free');

      // The approved model rides on the consent record, because it changes the
      // argv a person agreed to. A record written before it existed reads null.
      setSetting('learning_model_assist_consent', JSON.stringify({
        providerId: 'orbit.profile-v9', backendId: 'orbit.backend-v9',
        fingerprint: 'orbit:v9', acceptedAt: Date.now(), model: '  small-fast  ',
      }));
      check(readConsent()?.model === 'small-fast',
        'the approved model is carried on the consent record and trimmed');
      setSetting('learning_model_assist_consent', JSON.stringify({
        providerId: 'orbit.profile-v9', backendId: 'orbit.backend-v9',
        fingerprint: 'orbit:v9', acceptedAt: Date.now(),
      }));
      check(readConsent()?.model === null,
        'and an approval recorded before the model lever existed reads as the harness default rather than throwing');

      // The payload itself. factsFor rebuilds it from the candidate's own
      // evidence rather than parsing the stored cluster key, so the fields sent
      // cannot drift from the key format and the two counts stay the counts the
      // candidate was actually built from. This is the glue between a stored
      // candidate and the nine fields PAYLOAD_FIELDS promises, and it is the
      // one place a transcript could leak into a prompt if it grew a field.
      const facts = compound.factsFor([first, second]);
      check(Object.keys(facts).length === PAYLOAD_FIELDS.length
        && PAYLOAD_FIELDS.every((field) => field in facts),
        'the payload carries exactly the fields the consent screen names — no more, and none missing',
        Object.keys(facts));
      check(facts.observations === 2 && facts.independentTasks === 2,
        'the counts are the observations and independent tasks the candidate was built from');
      check(!Object.values(facts).some((value) =>
        typeof value === 'string' && /Mooncalf protocol|second independent success/.test(value)),
        'and no signal summary rides along in the payload: a summary is prose the agent produced, and the contract is counters and identifiers');

      // What is worth paying for. Measured against a real database: all 39 of
      // its pending nominations were tool-success clusters, and phrasing three
      // produced confident invention ("the Read tool succeeded 31 times ...",
      // advice to batch file sends to "reduce chattiness"). A phrased non-claim
      // is worse than the nomination it replaced, because a NEEDS AUTHORING
      // marker is visibly unfinished and a phrased sentence looks reviewed.
      const success = compound.phrasingEligibility([first, second]);
      check(!success.ok && success.reason === 'no-claim-possible',
        'a repeated success is skipped rather than phrased: the counters cannot tell a habit worth changing from normal work, so asking would only buy invention',
        success);

      const failureInput = {
        kind: 'tool-failure' as const, providerId: 'orbit.profile-v9', backendId: 'orbit.backend-v9',
        summary: `Edit refused ${tag}`,
        detail: { toolName: 'Edit', outcome: 'denied', errorClass: 'permission', pathPrefix: 'src/main' },
      };
      const failA = recordSignal({ ...failureInput, sessionId: `fail-a-${tag}`, taskHash: `ftask-a-${tag}` });
      const failB = recordSignal({ ...failureInput, sessionId: `fail-b-${tag}`, taskHash: `ftask-b-${tag}`,
        summary: `Edit refused again ${tag}` });
      check(compound.phrasingEligibility([failA, failB]).ok,
        'and something that failed, was denied, or carries an error class is worth phrasing — that is the shape a claim can exist in');

      // Clustering keys on provider and backend, so a mixed cluster should be
      // impossible. Asserted rather than assumed: a looser future signal source
      // would otherwise send one provider's observations to another's model.
      const foreign = recordSignal({ ...failureInput, providerId: 'other.profile', backendId: 'other.backend',
        sessionId: `fail-c-${tag}`, taskHash: `ftask-c-${tag}`, summary: `Edit refused elsewhere ${tag}` });
      const mixed = compound.phrasingEligibility([failA, foreign]);
      check(!mixed.ok && mixed.reason === 'mixed-attribution',
        'a cluster whose signals disagree about provider or backend is refused outright rather than routed to whichever one happened to be first',
        mixed);

      // The same predicate governs what a person is interrupted for. An inbox
      // row nobody can action is the same defect as a billed call nobody can
      // use, so they must not be able to drift apart.
      const claimless = createCandidate({
        targetKind: 'memory', scope: 'personal', providerId: first.providerId,
        title: `Unexplained repetition: mooncalf read ${tag}`,
        proposedText: `NEEDS AUTHORING — Observed 2 times across 2 independent tasks ${tag}.`,
        rationale: 'Rule-derived from repeated observations. No template matched.',
        confidence: 0.5, signalIds: [first.id, second.id],
      });
      const authored = createCandidate({
        targetKind: 'memory', scope: 'personal', providerId: first.providerId,
        title: `A person wrote this one ${tag}`,
        proposedText: 'This sentence was authored, so no sweep may touch it.',
        rationale: 'Taught explicitly.', confidence: 0.9, signalIds: [first.id, second.id],
      });
      const actionable = createCandidate({
        targetKind: 'memory', scope: 'personal', providerId: 'orbit.profile-v9',
        title: `Unexplained repetition: Edit denied ${tag}`,
        proposedText: `NEEDS AUTHORING — Observed 2 times across 2 independent tasks ${tag}.`,
        rationale: 'Rule-derived from repeated observations. No template matched.',
        confidence: 0.5, signalIds: [failA.id, failB.id],
      });
      const sweepable = compound.unactionableCount();
      check(sweepable >= 1, 'the sweep counts the nominations a repeated success can never resolve', sweepable);
      const { swept } = compound.sweepUnactionable();
      check(swept >= 1, 'and clears them in one action', swept);
      check(getCandidate(claimless.id)?.status === 'rejected',
        'a repeated-success nomination is swept');
      check(/^Swept:/.test(getCandidate(claimless.id)?.reviewerNote ?? ''),
        'and keeps a reason on the row, so a swept nomination is never mistaken for one a person judged');
      check(getCandidate(authored.id)?.status === 'pending',
        'a candidate a person authored is never swept, whatever its evidence looks like');
      check(getCandidate(actionable.id)?.status === 'pending',
        'and a nomination carrying a real failure stays for a person: the sweep clears what cannot be decided, not what has not been');
    } finally {
      setSetting('learning_model_assistance', priorSwitch);
      setSetting('learning_model_assist_consent', priorConsent);
      setSetting('learning_monthly_budget_usd', priorBudget);
    }

    // The reply validator. A model that declines, rambles, or hands back the
    // marker must leave a nomination standing rather than produce a claim.
    check(parseClaimReply('{"title":"Retry storms on flaky fetch","text":"Two sentences. Do the thing."}')?.title
      === 'Retry storms on flaky fetch',
      'a well-formed reply becomes a claim');
    check(parseClaimReply('Sure! Here is the JSON: {"title":"A","text":"B"} Hope that helps.')?.text === 'B',
      'a claim wrapped in chat prose is still read, because the JSON is found rather than assumed to be the whole reply');
    check(parseClaimReply('{"title":null,"text":null}') === null,
      'a model declining to claim anything produces no claim, which leaves the nomination for a person');
    check(parseClaimReply('the counters do not support a claim') === null,
      'a reply that is not JSON at all produces no claim');
    check(parseClaimReply('{"title":"NEEDS AUTHORING — x","text":"y"}') === null,
      'a reply containing the nomination marker is refused: it would either make an authored claim unpromotable or make an unreviewed one look reviewed');
    check(parseClaimReply(`{"title":"${'x'.repeat(600)}","text":"y"}`) === null,
      'an over-long title is refused rather than silently truncated into a claim nobody wrote');

    // The provenance write. It is deliberately not updateCandidate — that is
    // the review edit, and it cannot touch a rationale — so its own guard is
    // what stops it overwriting anything but the placeholder it wrote.
    const nominated = createCandidate({
      targetKind: 'memory', scope: 'personal', providerId: first.providerId,
      title: `Unexplained repetition: mooncalf ${tag}`,
      proposedText: `NEEDS AUTHORING — Observed 2 times across 2 independent tasks ${tag}.`,
      rationale: 'Rule-derived from repeated observations. No template matched.',
      confidence: 0.55, signalIds: [first.id, second.id],
    });
    const phrasedRow = recordModelPhrasing(nominated.id, {
      title: `Mooncalf retries mask a stale lock ${tag}`,
      proposedText: 'The retry is masking a stale launch lock. Clear the lock before retrying.',
      rationale: 'Model-assisted from repeated observations. Phrased by Orbit (orbit.profile-v9).',
      onlyIfTextStartsWith: 'NEEDS AUTHORING —',
    });
    check(!!phrasedRow && /stale lock/.test(phrasedRow.title)
      && /^Model-assisted from repeated observations\./.test(phrasedRow.rationale),
      'phrasing replaces the placeholder and rewrites the rationale to say a model wrote the sentence');
    check(!/NEEDS AUTHORING/.test(phrasedRow?.proposedText ?? 'NEEDS AUTHORING'),
      'and the marker is gone, so the candidate is promotable by a person for the first time');

    const secondPass = recordModelPhrasing(nominated.id, {
      title: 'A different sentence entirely',
      proposedText: 'Something else again.',
      rationale: 'Model-assisted from repeated observations. Phrased twice.',
      onlyIfTextStartsWith: 'NEEDS AUTHORING —',
    });
    check(secondPass === null,
      'a candidate that is no longer a nomination is never re-phrased, so a second pass cannot overwrite the first — or a person’s own edit');

    const authored = createCandidate({
      targetKind: 'memory', scope: 'personal', providerId: first.providerId,
      title: `Hand-authored mooncalf ${tag}`,
      proposedText: 'A person wrote this sentence themselves.',
      rationale: 'Taught explicitly.',
      confidence: 0.9, signalIds: [first.id],
    });
    check(recordModelPhrasing(authored.id, {
      title: 'Overwritten by a model',
      proposedText: 'Replaced.',
      rationale: 'Model-assisted from repeated observations.',
      onlyIfTextStartsWith: 'NEEDS AUTHORING —',
    }) === null && getCandidate(authored.id)?.proposedText === 'A person wrote this sentence themselves.',
      'and a claim a person authored is never touched by the phrasing pass, whatever else is on file');

    say('── compound · candidate, review, evidence, and FTS lifecycle');
    const memoryCandidate = createCandidate({
      targetKind: 'memory',
      scope: 'personal',
      providerId: first.providerId,
      title: `Mooncalf lock ${tag}`,
      proposedText: `The mooncalf launch lock ${tag} must be verified before starting work.`,
      rationale: 'Two independent explicit observations establish durable personal recall.',
      confidence: 0.98,
      signalIds: [first.id, second.id],
    });
    check(memoryCandidate.evidenceCount === 2 && memoryCandidate.taskCount === 2,
      'candidate counts independent evidence and tasks', `${memoryCandidate.evidenceCount}/${memoryCandidate.taskCount}`);
    check(automationDecision(memoryCandidate).decision === 'auto-apply',
      'only repeated high-confidence personal recall is eligible for automatic promotion');

    const reviewOnly = createCandidate({
      targetKind: 'skill',
      scope: 'project',
      providerId: first.providerId,
      projectId: project.id,
      title: `Mooncalf release ${tag}`,
      proposedText: '1. Inspect the lock.\n2. Run the release.\n3. Verify the artifact.',
      rationale: 'Repeated project workflow.',
      confidence: 0.99,
      signalIds: [first.id, second.id],
    });
    check(automationDecision(reviewOnly).decision === 'review',
      'project skills remain review-only even with strong evidence');

    reviewCandidate(memoryCandidate.id, 'approve', 'Smoke verification');
    const promotedMemory = promoteCandidate(memoryCandidate.id, { createdBy: 'smoke' });
    check(promotedMemory.item.status === 'active' && promotedMemory.item.currentVersion === 1,
      'approved candidate becomes versioned canonical knowledge');
    check(listEvidence({ itemId: promotedMemory.item.id }).length === 2,
      'promotion preserves citations to both source signals');
    const mooncalfHits = searchKnowledge({ query: 'mooncalf', limit: 20 });
    check(mooncalfHits.some((hit) => hit.item.id === promotedMemory.item.id),
      'canonical knowledge is immediately searchable through FTS5');

    say('── compound · honest provider compilers and reversible projections');
    const forged = forgeSkill({
      name: `release-lock-${tag}`.replace(/[^a-z0-9-]/g, '-').slice(0, 64),
      description: 'Use when a project release must verify its launch lock before publishing.',
      trigger: 'Use for a release after code review and before publishing an artifact.',
      scope: 'project',
      inputs: ['The release identifier'],
      steps: [
        { title: 'Inspect', instruction: 'Inspect the launch lock.' },
        { title: 'Release', instruction: 'Run the documented release command.' },
        { title: 'Verify', instruction: 'Verify the resulting artifact.' },
      ],
      verification: ['The artifact exists and the verification command succeeds.'],
      safety: ['Do not publish when the lock check fails.'],
      providerIds: ['claude', 'codex'],
    });
    check(!doctorSkill(forged.skillMd).some((diagnostic) => diagnostic.severity === 'error'),
      'Skill Forge output passes Skill Doctor');
    // The trigger has to reach the frontmatter, not only the body. `when_to_use`
    // is appended to `description` in the skill listing, which is the text an
    // agent reads while deciding whether to load the skill at all; a trigger
    // that lives only under "## When to use" is read after that decision, which
    // is too late to have informed it.
    const forgedFm = forged.skillMd.slice(0, forged.skillMd.indexOf('\n---', 3));
    check(/\nwhen_to_use: "/.test(forgedFm) && forgedFm.includes('after code review'),
      'a forged skill carries its trigger as when_to_use frontmatter, where it can be read before the skill is loaded',
      forgedFm.split('\n').filter((l) => l.startsWith('when_to_use')).join(''));
    check(forged.skillMd.includes('## When to use'),
      'and still as prose in the body, for whoever opens the file');
    // Only name/description/when_to_use — every one of them a documented field.
    // A key the CLI does not know is a key that teaches people this tool writes
    // files their agent cannot read.
    const fmKeys = forgedFm.split('\n').slice(1).map((l) => l.split(':')[0]).filter(Boolean);
    check(fmKeys.every((k) => ['name', 'description', 'when_to_use'].includes(k)),
      'and no frontmatter key outside the published Agent Skills spec', JSON.stringify(fmKeys));
    // description + when_to_use are truncated together at 1,536 characters in
    // the listing, so the pair must be written inside that budget rather than
    // discovering the cut on the far side of it.
    const longTrigger = forgeSkill({
      name: 'listing-budget-smoke',
      description: 'x'.repeat(1_000),
      trigger: 'y'.repeat(1_000),
      scope: 'project',
      steps: [{ title: 'Step', instruction: 'Do the thing.' }],
      verification: ['It worked.'],
    });
    const listed = /\ndescription: "([^"]*)"[\s\S]*?\nwhen_to_use: "([^"]*)"/.exec(longTrigger.skillMd);
    check(!!listed && listed[1].length + listed[2].length <= 1_536,
      'a long description leaves the trigger only the room the listing budget has left, rather than being cut where nobody can see it',
      JSON.stringify({ description: listed?.[1].length, whenToUse: listed?.[2].length }));
    const unsafeSkill = [
      '---', 'name: unsafe-smoke', 'description: Use when testing unsafe instructions.', '---', '',
      '# Unsafe', '', 'sudo rm -rf /tmp/example', '', '## Verification', '', '- Hope it worked.', '',
    ].join('\n');
    check(doctorSkill(unsafeSkill).some((diagnostic) => diagnostic.code === 'dangerous-command'),
      'Skill Doctor identifies destructive or privileged commands');

    const skillCandidate = createCandidate({
      targetKind: 'skill',
      scope: 'project',
      providerId: 'claude',
      projectId: project.id,
      title: `Release Lock ${tag}`,
      proposedText: forged.skillMd,
      rationale: 'Use when the verified release workflow recurs.',
      confidence: 0.96,
      signalIds: [first.id, second.id],
    });
    reviewCandidate(skillCandidate.id, 'approve');
    const promotedSkill = promoteCandidate(skillCandidate.id, { createdBy: 'smoke' });
    const claudeSkill = compileCandidate(skillCandidate.id, CLAUDE_ARTIFACT_COMPILER, {
      providerId: 'claude', projectRoot, homeDir: fakeHome,
    });
    const codexSkill = compileCandidate(skillCandidate.id, CODEX_ARTIFACT_COMPILER, {
      providerId: 'codex', projectRoot, homeDir: fakeHome,
    });
    check(claudeSkill.targetPath?.includes(`${path.sep}.claude${path.sep}skills${path.sep}`) === true,
      'Claude project skills compile to .claude/skills');
    check(codexSkill.targetPath?.includes(`${path.sep}.agents${path.sep}skills${path.sep}`) === true,
      'Codex project skills compile to .agents/skills');

    const personalSkillCandidate = createCandidate({
      targetKind: 'skill', scope: 'personal', providerId: null,
      title: `Personal Release Lock ${tag}`, proposedText: forged.skillMd,
      rationale: 'Personal workflow still needs explicit review.', confidence: 0.99,
      signalIds: [first.id, second.id],
    });
    check(automationDecision(personalSkillCandidate).decision === 'review',
      'personal skills never bypass review');
    const personalClaude = compileCandidate(personalSkillCandidate.id, CLAUDE_ARTIFACT_COMPILER, {
      providerId: 'claude', homeDir: fakeHome,
    });
    const personalCodex = compileCandidate(personalSkillCandidate.id, CODEX_ARTIFACT_COMPILER, {
      providerId: 'codex', homeDir: fakeHome,
    });
    check(personalClaude.targetPath?.startsWith(path.join(fakeHome, '.claude', 'skills')) === true,
      'Claude personal skills have a first-class personal target');
    check(personalCodex.targetPath?.startsWith(path.join(fakeHome, '.agents', 'skills')) === true,
      'Codex personal skills have a first-class personal target');

    const pathCandidate = createCandidate({
      targetKind: 'rule', scope: 'path', providerId: null, projectId: project.id,
      pathScope: 'src/**/*.ts', title: `TypeScript boundary ${tag}`,
      proposedText: 'Keep privileged Electron work in the main process.',
      rationale: 'A path-specific invariant.', confidence: 0.95, signalIds: [first.id, second.id],
    });
    const claudePathRule = compileCandidate(pathCandidate.id, CLAUDE_ARTIFACT_COMPILER, {
      providerId: 'claude', projectRoot, homeDir: fakeHome,
    });
    const codexPathRule = compileCandidate(pathCandidate.id, CODEX_ARTIFACT_COMPILER, {
      providerId: 'codex', projectRoot, homeDir: fakeHome,
    });
    check(claudePathRule.supported && claudePathRule.targetPath?.includes(`${path.sep}.claude${path.sep}rules${path.sep}`) === true,
      'Claude glob-scoped rules compile to native path rules');
    check(!codexPathRule.supported && /not this file glob/.test(codexPathRule.reason),
      'Codex compiler reports unsupported glob scope instead of silently broadening it', codexPathRule.reason);
    const internalMemory = compileCandidate(memoryCandidate.id, CODEX_ARTIFACT_COMPILER, {
      providerId: 'codex', homeDir: fakeHome,
    });
    check(internalMemory.mode === 'briefing' && internalMemory.nativeMemoryAccess === 'read-only',
      'provider-generated memory is read-only; canonical memory is delivered by Wanigan briefing');

    const preview = compileCandidateProjection(skillCandidate.id, CLAUDE_ARTIFACT_COMPILER, {
      providerId: 'claude', projectRoot, homeDir: fakeHome,
    }, { allowedRoots: [projectRoot] });
    check(preview.projection?.status === 'preview', 'compiler produces a read-only projection preview');
    if (preview.projection) {
      const applied = applyProjection(preview.projection.id, { allowedRoots: [projectRoot], actor: 'user' });
      check(applied.status === 'applied' && fs.readFileSync(applied.targetPath, 'utf8') === applied.proposedContent,
        'approved projection applies the exact previewed bytes');
      const undone = undoProjection(applied.id, { allowedRoots: [projectRoot], actor: 'user' });
      check(undone.status === 'undone' && !fs.existsSync(undone.targetPath),
        'undo restores the exact missing-file snapshot');
    }

    const stalePreview = compileCandidateProjection(skillCandidate.id, CLAUDE_ARTIFACT_COMPILER, {
      providerId: 'claude', projectRoot, homeDir: fakeHome,
    }, { allowedRoots: [projectRoot] }).projection;
    if (stalePreview) {
      fs.mkdirSync(path.dirname(stalePreview.targetPath), { recursive: true });
      fs.writeFileSync(stalePreview.targetPath, 'a human changed this after preview\n');
      const staleReason = thrown(() => applyProjection(stalePreview.id, { allowedRoots: [projectRoot], actor: 'user' }));
      const validation = validateProjection(stalePreview.id, { allowedRoots: [projectRoot], actor: 'user' });
      check(staleReason !== null && getProjection(stalePreview.id)?.status === 'stale',
        'apply refuses a target changed after preview', staleReason);
      check(validation.stale, 'projection validation exposes snapshot drift');
      check(fs.readFileSync(stalePreview.targetPath, 'utf8').startsWith('a human changed'),
        'stale apply leaves the human edit untouched');
    }

    say('── compound · staleness quarantine and bounded briefing');
    const citedSignal = recordSignal({
      kind: 'explicit-teach', providerId: 'claude', backendId: 'anthropic',
      sessionId: `session-cited-${tag}`, taskHash: `task-cited-${tag}`, projectId: project.id,
      projectPath: projectRoot, summary: `Citadel zaffre ${tag} is documented in facts.txt.`, semanticEligible: true,
    });
    const citedCandidate = createCandidate({
      targetKind: 'memory', scope: 'project', providerId: 'claude', projectId: project.id,
      title: `Citadel zaffre ${tag}`, proposedText: `The citadel zaffre ${tag} value is alpha.`,
      rationale: 'Project fact with a file citation.', confidence: 0.94, signalIds: [citedSignal.id],
    });
    reviewCandidate(citedCandidate.id, 'approve');
    const cited = promoteCandidate(citedCandidate.id, { createdBy: 'smoke' });
    const factPath = path.join(projectRoot, 'facts.txt');
    fs.writeFileSync(factPath, 'alpha\n');
    addEvidence({
      itemId: cited.item.id, versionId: cited.version.id, sourceType: 'file', sourceId: 'facts.txt',
      citation: 'facts.txt:1', contentHash: hash('alpha\n'),
    });
    const freshBrief = await buildBriefing({
      query: 'citadel zaffre', providerId: 'claude', projectId: project.id,
      projectRoot, allowedEvidenceRoots: [projectRoot], maxTokens: 256,
    });
    check(freshBrief.entries.some((entry) => entry.itemId === cited.item.id),
      'fresh cited knowledge enters the session briefing');
    check(getKnowledgeItem(cited.item.id)?.lastValidatedAt != null
      && freshBrief.entries.find((entry) => entry.itemId === cited.item.id)?.checked === 1,
      'a re-hashed file citation stamps last_validated_at and the entry reports one citation checked');
    fs.writeFileSync(factPath, 'beta\n');
    const staleBrief = await buildBriefing({
      query: 'citadel zaffre', providerId: 'claude', projectId: project.id,
      projectRoot, allowedEvidenceRoots: [projectRoot], maxTokens: 256,
    });
    check(!staleBrief.entries.some((entry) => entry.itemId === cited.item.id),
      'changed evidence is omitted before briefing construction');
    check(getKnowledgeItem(cited.item.id)?.status === 'quarantined',
      'changed evidence quarantines canonical knowledge for repair and audit');

    const budgetSignal = recordSignal({
      kind: 'explicit-teach', providerId: 'codex', backendId: 'openai',
      sessionId: `session-budget-${tag}`, taskHash: `task-budget-${tag}`,
      summary: `Budgetbeacon ${tag} keeps briefing context small.`, semanticEligible: true,
    });
    const budgetCandidate = createCandidate({
      targetKind: 'memory', scope: 'personal', providerId: 'codex',
      title: `Budgetbeacon ${tag}`, proposedText: `Budgetbeacon ${tag}: load only the useful fact.`,
      rationale: 'Compact personal recall.', confidence: 0.91, signalIds: [budgetSignal.id],
    });
    reviewCandidate(budgetCandidate.id, 'approve');
    const budgetItem = promoteCandidate(budgetCandidate.id, { createdBy: 'smoke' });
    const bounded = await buildBriefing({ query: 'budgetbeacon', providerId: 'codex', maxTokens: 128 });
    check(bounded.entries.some((entry) => entry.itemId === budgetItem.item.id),
      'relevant canonical knowledge is retrieved just in time');
    check(bounded.estimatedTokens <= 128, 'briefing stays inside its explicit token budget', bounded.estimatedTokens);
    check(bounded.omitted === bounded.omittedStale + bounded.omittedBudget,
      'briefing omissions split stale from over-budget and still sum');
    // The header frames what each line is — approved instruction, recorded
    // observation, provenance tag — and names only the kinds present. The old
    // literal called everything "verified context", which memory is not.
    check(bounded.text.startsWith('Wanigan context.') && !bounded.text.includes('verified context')
      && bounded.text.includes('[memory]:') && !bounded.text.includes('[instruction]')
      && bounded.text.includes('wanigan:<id> is a provenance tag, not a tool or file'),
    'the briefing frame names only the kinds present and calls wanigan:<id> a provenance tag, not a tool or file',
    bounded.text.split('\n')[0]);
    check(estimateTokens(briefingFrame(['memory'])) <= 40 && estimateTokens(briefingFrame(INJECTABLE_KINDS)) <= 60
      && briefingFrame(['memory']).length < briefingFrame(INJECTABLE_KINDS).length,
    'the frame is costed at its longest for the kinds ranked and stays short', {
      memory: estimateTokens(briefingFrame(['memory'])), all: estimateTokens(briefingFrame(INJECTABLE_KINDS)),
    });
    check(bounded.entries.some((entry) => entry.itemId === budgetItem.item.id && entry.checked === 0 && entry.skipped >= 1),
      'an entry says how many citations were re-hashed and how many were carried with nothing checkable');
    check(getKnowledgeItem(budgetItem.item.id)?.lastValidatedAt === null,
      'an item that passed with zero checkable citations is not stamped as validated');
    say('── compound · a delivered artifact keeps its place, a held-back one does not');
    const ttlPromote = (title: string, text: string, slug: string): string => {
      const signal = recordSignal({
        kind: 'explicit-teach', providerId: 'claude', backendId: 'anthropic',
        sessionId: `session-ttl-${slug}-${tag}`, taskHash: `task-ttl-${slug}-${tag}`,
        summary: `Ttlkeeper ${slug} ${tag}.`, semanticEligible: true,
      });
      const candidate = createCandidate({
        targetKind: 'memory', scope: 'personal', providerId: 'claude',
        title, proposedText: text, confidence: 0.9, signalIds: [signal.id],
        rationale: 'Rule-derived from repeated observations.',
      });
      reviewCandidate(candidate.id, 'approve');
      return promoteCandidate(candidate.id, { createdBy: 'smoke' }).item.id;
    };
    // The held-back one is a nomination: its text is its title, so retrieval
    // ranks it for the same query and then refuses it as unsynthesized.
    const ttlServed = ttlPromote(`Ttlkeeper served ${tag}`,
      `Ttlkeeper served ${tag}: this claim is worth its tokens on every launch.`, 'served');
    const ttlHeld = ttlPromote(`Ttlkeeper heldback ${tag}`, `Ttlkeeper heldback ${tag}`, 'heldback');
    const ttlPrior = compound.settings().enabled;
    try {
      compound.updateSettings({ enabled: true });
      const ttlContext = {
        providerId: 'claude', projectId: project.id, projectPath: projectRoot, query: 'ttlkeeper',
      };
      const ttlFirst = await compound.briefingForContext(ttlContext);
      check(!!ttlFirst?.includes(ttlServed) && !ttlFirst?.includes(ttlHeld),
        'the fixture delivers one derived item and holds the unsynthesized one back', ttlFirst);
      check(getKnowledgeItem(ttlServed)?.expiresAt == null,
        'delivery does not invent an expiry for an item that carries none');
      const ttlNear = Date.now() + 60_000;
      db().prepare('UPDATE knowledge_items SET expires_at=? WHERE id IN (?,?)').run(ttlNear, ttlServed, ttlHeld);
      await compound.briefingForContext(ttlContext);
      check((getKnowledgeItem(ttlServed)?.expiresAt ?? 0) > ttlNear + 30 * 24 * 60 * 60 * 1000,
        'a derived item a launch briefed has its expiry pushed forward instead of ageing out while in use',
        getKnowledgeItem(ttlServed)?.expiresAt);
      check(getKnowledgeItem(ttlHeld)?.expiresAt === ttlNear,
        'an item retrieval held back keeps the expiry it had; being considered earns nothing',
        getKnowledgeItem(ttlHeld)?.expiresAt);
    } finally {
      compound.updateSettings({ enabled: ttlPrior });
    }
    check(KNOWLEDGE_KINDS.every((kind) => (kindDelivery(kind).briefed === 'never') === !INJECTABLE_KINDS.includes(kind))
      && kindDelivery('mission').briefed === 'standing' && kindDelivery('project-map').briefed === 'never',
    'the shared kind-delivery table agrees with the injector about which kinds can be briefed');

    say('── compound · legibility ledger');
    const ledgerSessionId = `session-ledger-${tag}`;
    recordSessionBriefing({
      sessionId: ledgerSessionId, delivery: 'argv', providerId: 'codex',
      projectId: null, briefing: bounded, maxTokens: 128,
    });
    const ledgerBriefings = listSessionBriefings(ledgerSessionId);
    check(ledgerBriefings.length === 1 && ledgerBriefings[0].entries.length === bounded.entries.length,
      'briefing delivery is recorded per session with its served entries');
    check(ledgerBriefings[0].omittedUnsynthesized === bounded.omittedUnsynthesized
      && ledgerBriefings[0].omittedUnverified === bounded.omittedUnverified
      && ledgerBriefings[0].entries.every((entry) => typeof entry.checked === 'number' && typeof entry.skipped === 'number'),
    'all four held-back counters and the per-entry citation counts persist with the delivery');
    // A row written before the two newer columns existed reads "not recorded",
    // never 0: a session held for the check quota must not read as "nothing matched".
    const legacySessionId = `session-legacy-${tag}`;
    db().prepare(`
      INSERT INTO session_briefings
        (session_id,at,delivery,provider_id,project_id,entries_json,estimated_tokens,max_tokens,omitted_stale,omitted_budget)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(legacySessionId, Date.now(), 'argv', 'codex', null,
      JSON.stringify([{ itemId: budgetItem.item.id, versionId: null, kind: 'memory', title: 'legacy', estimatedTokens: 12 }]), 12, 128, 0, 0);
    const legacyBriefing = listSessionBriefings(legacySessionId)[0];
    check(legacyBriefing?.omittedUnsynthesized === null && legacyBriefing.omittedUnverified === null
      && legacyBriefing.entries[0]?.checked === null && legacyBriefing.entries[0]?.skipped === null,
    'a legacy briefing row reads its unrecorded counters as null, not as zero');
    // A hook delivery answers a SessionStart; the ledger pairs them by time so
    // the timeline can place the recorded capsule without a row of its own.
    const hookSessionId = `session-hook-${tag}`;
    const hookAt = Date.now();
    db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(hookSessionId, hookAt - 3_000, 'SessionStart', null, null, null, null, null);
    db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(hookSessionId, hookAt + 1_000, 'PostToolUse', 'Skill', 'release-lock', 40, 1, null);
    db().prepare('INSERT INTO session_events (session_id, at, event, tool_name, summary, duration_ms, ok, paths_json) VALUES (?,?,?,?,?,?,?,?)')
      .run(hookSessionId, hookAt + 2_000, 'PostToolUse', 'Skill', null, 40, 1, null);
    recordSessionBriefing({
      sessionId: hookSessionId, delivery: 'hook', providerId: 'claude',
      projectId: null, briefing: bounded, maxTokens: 128, at: hookAt,
    });
    const hookLedger = sessionLearningLedger(hookSessionId);
    check(hookLedger.briefings[0]?.sessionStartAt === hookAt - 3_000 && ledgerBriefings[0].sessionStartAt === null,
      'a hook-delivered briefing is paired to its SessionStart by time; an argv delivery stays unpaired');
    check(hookLedger.skillToolCalls.observed === 2 && hookLedger.skillToolCalls.unrecorded === 1
      && hookLedger.skillToolCalls.identifiers.join() === 'release-lock',
    'the ledger counts hook-observed Skill tool calls and keeps unrecorded identifiers as a count, not a drop',
    JSON.stringify(hookLedger.skillToolCalls));
    const loadedMetrics = listMetrics({ sessionId: ledgerSessionId, metric: 'tokens_loaded' });
    check(loadedMetrics.length === bounded.entries.length
      && loadedMetrics.every((metric) => metric.evidenceLevel === 'estimate'),
      'served briefing entries record estimate-level tokens_loaded metrics');

    const ledgerSignal = recordSignal({
      kind: 'tool-success', providerId: 'codex', sessionId: ledgerSessionId,
      taskHash: `task-ledger-${tag}`, summary: `Ledgerline ${tag} observation.`, semanticEligible: false,
    });
    const ledgerCandidate = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Ledgerline ${tag}`,
      proposedText: `Ledgerline ${tag}: observed once so far.`,
      rationale: 'Legibility ledger test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    const preLedger = sessionLearningLedger(ledgerSessionId);
    check(preLedger.signals.some((signal) => signal.id === ledgerSignal.id)
      && preLedger.candidates.some((candidate) => candidate.candidateId === ledgerCandidate.id)
      && preLedger.briefings.length === 1,
      'session ledger joins recorded briefings, signals, and candidate lineage');
    const explanation = explainCandidate(ledgerCandidate.id);
    check(explanation.decision === 'review'
      && explanation.checks.some((entry) => entry.label === 'Distinct observations' && !entry.ok),
      'automation gate explanation decomposes exactly which checks fail', JSON.stringify(explanation));
    reviewCandidate(ledgerCandidate.id, 'approve');
    const ledgerPromoted = promoteCandidate(ledgerCandidate.id, { createdBy: 'smoke' });
    check(sessionLearningLedger(ledgerSessionId).contributions
      .some((entry) => entry.itemId === ledgerPromoted.item.id),
      'promotion makes the session→knowledge contribution chain queryable');

    const heartbeat = recordConsolidationRun({
      trigger: 'manual', processed: 0, candidates: 0, autoApplied: 0, durationMs: 5,
    });
    check(listConsolidationRuns(5).some((run) => run.id === heartbeat.id),
      'consolidation passes persist as an automation heartbeat');
    const stats = pipelineStats({ windowDays: 7 });
    check(stats.signals > 0 && stats.briefingsServed >= 1 && stats.signalsByDay.length === 7,
      'pipeline stats count observed rows over a zero-filled local day series', JSON.stringify({
        signals: stats.signals, briefingsServed: stats.briefingsServed, days: stats.signalsByDay.length,
      }));

    // The Inbox figure used to be candidatesCreated - autoPromoted, which never
    // fell for a decided row. Measured as a delta because this suite has already
    // created a dozen candidates by now, and an absolute would pin the suite's
    // own history rather than the arithmetic.
    const openBefore = pipelineStats({ windowDays: 7, projectId: project.id }).awaitingDecision;
    const toDecide = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Decideline ${tag}`,
      proposedText: `Decideline ${tag}: a proposal somebody rejects.`,
      rationale: 'Awaiting-decision counting test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    const toLeaveOpen = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Openline ${tag}`,
      proposedText: `Openline ${tag}: a proposal nobody has touched.`,
      rationale: 'Awaiting-decision counting test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    const openAfterCreate = pipelineStats({ windowDays: 7, projectId: project.id }).awaitingDecision;
    reviewCandidate(toDecide.id, 'reject');
    const afterReject = pipelineStats({ windowDays: 7, projectId: project.id });
    check(openAfterCreate === openBefore + 2
      && afterReject.awaitingDecision === openBefore + 1
      && afterReject.awaitingDecision < afterReject.candidatesCreated,
      'awaiting-a-decision counts open candidates directly, so rejecting a proposal removes it from the figure and the count stays below the candidates created in the same window',
      JSON.stringify({ openBefore, openAfterCreate, afterReject: afterReject.awaitingDecision, created: afterReject.candidatesCreated }));

    // A snooze defers a decision rather than making one, and reviewCandidate
    // accepts 'snooze' only from 'pending' — so this has to run on the candidate
    // left untouched above.
    reviewCandidate(toLeaveOpen.id, 'snooze');
    const afterSnooze = pipelineStats({ windowDays: 7, projectId: project.id });
    check(afterSnooze.awaitingDecision === openBefore + 1,
      'a snoozed candidate is still awaiting a decision, because deferring a decision is not making one',
      JSON.stringify({ expected: openBefore + 1, actual: afterSnooze.awaitingDecision }));

    // Negative: the figure is not the arithmetic it replaced. autoPromoted is a
    // COUNT(DISTINCT item_id) over knowledge_versions, so the old expression
    // subtracted knowledge items from candidates and never removed a decided row.
    check(afterSnooze.candidatesCreated - afterSnooze.autoPromoted !== afterSnooze.awaitingDecision,
      'the awaiting-a-decision figure is a count of open candidate rows and not candidatesCreated minus autoPromoted, which subtracted a count of knowledge items from a count of candidates',
      JSON.stringify({ candidatesCreated: afterSnooze.candidatesCreated, autoPromoted: afterSnooze.autoPromoted, awaitingDecision: afterSnooze.awaitingDecision }));

    // Negative: the window is real. Backdating the row past the window has to
    // drop it, or "last 7d" is decoration on a store-wide count.
    const aged = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Agedline ${tag}`,
      proposedText: `Agedline ${tag}: created before the window opened.`,
      rationale: 'Awaiting-decision window test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    const insideWindow = pipelineStats({ windowDays: 7, projectId: project.id }).awaitingDecision;
    db().prepare('UPDATE knowledge_candidates SET created_at=? WHERE id=?')
      .run(Date.now() - 40 * 24 * 3600 * 1000, aged.id);
    const outsideWindow = pipelineStats({ windowDays: 7, projectId: project.id }).awaitingDecision;
    check(insideWindow === openBefore + 2 && outsideWindow === openBefore + 1,
      'an open candidate created before the window opened is not counted as awaiting a decision in that window, so the figure means what its "last 7d" label says',
      JSON.stringify({ insideWindow, outsideWindow }));

    // Scope travels with the count the same way it does for every sibling figure.
    check(pipelineStats({ windowDays: 7, projectId: null }).awaitingDecision <= pipelineStats({ windowDays: 7 }).awaitingDecision,
      'the awaiting-a-decision count is scoped like every other pipeline figure, so a project-scoped read can never exceed the unscoped one',
      JSON.stringify({ scoped: pipelineStats({ windowDays: 7, projectId: null }).awaitingDecision, all: pipelineStats({ windowDays: 7 }).awaitingDecision }));

    // ── the decided figure ──────────────────────────────────────────────
    // 'decided' used to be `reviewed_at IS NOT NULL`, and reviewCandidate
    // stamps reviewed_at for a snooze as well as for an approve or a reject,
    // so one snoozed row was counted as decided here while awaitingDecision
    // counted the same row as still open. Deltas again, for the same reason
    // the block above uses them.
    const beforeDecide = pipelineStats({ windowDays: 7, projectId: project.id });
    const toDefer = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Deferline ${tag}`,
      proposedText: `Deferline ${tag}: a proposal somebody puts off.`,
      rationale: 'Decided-figure counting test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    reviewCandidate(toDefer.id, 'snooze');
    const afterDefer = pipelineStats({ windowDays: 7, projectId: project.id });
    check(afterDefer.reviewed === beforeDecide.reviewed
      && afterDefer.awaitingDecision === beforeDecide.awaitingDecision + 1,
      'snoozing a proposal moves it into the awaiting-a-decision figure and leaves the decided figure alone, so the two counts never both claim the same row — reviewCandidate stamps reviewed_at for a snooze too, and a figure keyed on that timestamp read a deferral as a decision',
      JSON.stringify({ decidedBefore: beforeDecide.reviewed, decidedAfter: afterDefer.reviewed, openBefore: beforeDecide.awaitingDecision, openAfter: afterDefer.awaitingDecision }));

    const toRefuse = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Refuseline ${tag}`,
      proposedText: `Refuseline ${tag}: a proposal somebody turns down.`,
      rationale: 'Decided-figure counting test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    reviewCandidate(toRefuse.id, 'reject');
    check(pipelineStats({ windowDays: 7, projectId: project.id }).reviewed === beforeDecide.reviewed + 1,
      'rejecting a proposal is a decision and lands in the decided figure, so the figure counts a refusal and not only an acceptance',
      JSON.stringify({ before: beforeDecide.reviewed, after: pipelineStats({ windowDays: 7, projectId: project.id }).reviewed }));

    // The load-bearing one. Approving in the app runs approve and then
    // promote, and applying a projection moves that row on to 'applied', so a
    // candidate a person approved almost never rests at status 'approved'. A
    // decided figure counting only ('approved','rejected') would report zero
    // approvals on a store full of them.
    const toAccept = createCandidate({
      targetKind: 'memory', scope: 'personal', title: `Acceptline ${tag}`,
      proposedText: `Acceptline ${tag}: a proposal somebody approves and promotes.`,
      rationale: 'Decided-figure counting test.', confidence: 0.9, signalIds: [ledgerSignal.id],
    });
    reviewCandidate(toAccept.id, 'approve');
    promoteCandidate(toAccept.id, { createdBy: 'user' });
    const afterAccept = pipelineStats({ windowDays: 7, projectId: project.id });
    check(afterAccept.reviewed === beforeDecide.reviewed + 2,
      'a proposal a person approved and then promoted still counts as decided, because approving in the app promotes in the same breath and a projection moves the row on again — the decided figure follows the whole set of statuses that carry a decision rather than the two a candidate passes through on its way out of them',
      JSON.stringify({ before: beforeDecide.reviewed, after: afterAccept.reviewed, status: 'promoted' }));

    // Negative: the deferral is not counted late either. Approving the row
    // snoozed above adds exactly one, so the snooze contributed nothing at the
    // time and nothing retroactively.
    reviewCandidate(toDefer.id, 'approve');
    const afterUndefer = pipelineStats({ windowDays: 7, projectId: project.id });
    check(afterUndefer.reviewed === beforeDecide.reviewed + 3
      && afterUndefer.awaitingDecision === beforeDecide.awaitingDecision,
      'a proposal that was snoozed and later approved is counted once, at the approval, so the earlier deferral neither counted as a decision when it happened nor was counted a second time when the real decision arrived',
      JSON.stringify({ before: beforeDecide.reviewed, after: afterUndefer.reviewed, openAfter: afterUndefer.awaitingDecision }));

    // Negative: the window is the decision's clock, not the candidate's.
    // Backdating reviewed_at past the window has to drop the row while its
    // created_at, and so candidatesCreated, stays inside it.
    const createdStill = afterUndefer.candidatesCreated;
    db().prepare('UPDATE knowledge_candidates SET reviewed_at=? WHERE id=?')
      .run(Date.now() - 40 * 24 * 3600 * 1000, toRefuse.id);
    const afterAging = pipelineStats({ windowDays: 7, projectId: project.id });
    check(afterAging.reviewed === afterUndefer.reviewed - 1
      && afterAging.candidatesCreated === createdStill,
      'a proposal decided before the window opened drops out of the decided figure while the same row stays inside candidates-created, so "last 7d" on that figure means the window the decision was taken in and not the window the candidate was written in',
      JSON.stringify({ decided: afterAging.reviewed, was: afterUndefer.reviewed, created: afterAging.candidatesCreated }));

    say('── compound · sweep hardening');
    // Failure-shaped on purpose. Consolidation no longer nominates a repeated
    // success -- there is no claim in one, and a nomination nobody can action
    // is inbox noise -- so a fixture that wants to reach a candidate has to
    // carry what a candidate can be made of.
    const mkHardSig = (summary: string, session: string, task: string, at: number) => recordSignal({
      kind: 'tool-failure', providerId: 'claude', backendId: 'anthropic',
      sessionId: session, taskHash: task, projectId: project.id, projectPath: projectRoot,
      summary, semanticEligible: false, createdAt: at,
      detail: { outcome: 'failed', errorClass: 'lint' },
    });
    const hardBase = Date.now() - 60_000;
    const ancient = recordSignal({
      kind: 'tool-success', providerId: 'claude', summary: `Ancientline ${tag}`,
      taskHash: `t-old-${tag}`, projectId: project.id, semanticEligible: false,
      createdAt: Date.now() - 50 * 24 * 3600 * 1000,
    });
    const poisonSummary = `毒${'学'.repeat(220)} ${tag}`;
    const healthySummary = `Hardenline ${tag} lint passes with the pinned config.`;
    const poisonA = mkHardSig(poisonSummary, `s-poison-a-${tag}`, `t-poison-a-${tag}`, hardBase);
    const poisonB = mkHardSig(poisonSummary, `s-poison-b-${tag}`, `t-poison-b-${tag}`, hardBase + 1);
    const healthyA = mkHardSig(healthySummary, `s-healthy-a-${tag}`, `t-healthy-a-${tag}`, hardBase + 2);
    const healthyB = mkHardSig(healthySummary, `s-healthy-b-${tag}`, `t-healthy-b-${tag}`, hardBase + 3);
    const hardPass = compound.consolidate(project.id);
    const hardCandidates = compound.candidates({ projectId: project.id, limit: 500 });
    const poisonCandidate = hardCandidates.find((c) => c.signalIds.includes(poisonA.id) && c.signalIds.includes(poisonB.id));
    const healthyCandidate = hardCandidates.find((c) => c.signalIds.includes(healthyA.id) && c.signalIds.includes(healthyB.id));
    check(!!poisonCandidate && Buffer.byteLength(poisonCandidate.title, 'utf8') <= 500,
      'multibyte summaries consolidate with byte-safe candidate titles', JSON.stringify(hardPass));
    check(!!healthyCandidate, 'every qualifying group in a pass consolidates independently');
    // Snooze, then observe the pattern again. The same task seen twice is not
    // a reason to interrupt the person; a new independent task is, and it
    // wakes the candidate into review with a reason code — never past it.
    check(!!healthyCandidate && healthyCandidate.clusterKey !== null && healthyCandidate.snoozedAt === null,
      'a consolidation candidate stores the cluster key it was derived from');
    if (healthyCandidate) {
      reviewCandidate(healthyCandidate.id, 'snooze', 'Ask me again later.');
      const snoozedRow = compound.candidates({ projectId: project.id, limit: 500 }).find((c) => c.id === healthyCandidate.id);
      check(snoozedRow?.status === 'snoozed' && snoozedRow.snoozedAt !== null,
        'snoozing records when a person deferred the candidate');
      const sameTask = mkHardSig(`${healthySummary} again`, `s-healthy-a-${tag}`, `t-healthy-a-${tag}`, hardBase + 4);
      const sameTaskPass = compound.consolidate(project.id);
      const stillSnoozed = compound.candidates({ projectId: project.id, limit: 500 }).find((c) => c.id === healthyCandidate.id);
      check(ranCounts(sameTaskPass)?.woken === 0 && stillSnoozed?.status === 'snoozed' && getSignal(sameTask.id)?.processedAt === null,
        'the same task observed again does not wake a snoozed candidate, and the signal waits for a real second task',
        JSON.stringify(sameTaskPass));
      const newTask = mkHardSig(healthySummary, `s-healthy-c-${tag}`, `t-healthy-c-${tag}`, hardBase + 5);
      const wakePass = compound.consolidate(project.id);
      const woken = compound.candidates({ projectId: project.id, limit: 500 }).find((c) => c.id === healthyCandidate.id);
      check((ranCounts(wakePass)?.woken ?? 0) >= 1 && woken?.status === 'pending' && woken.wake?.code === 'observed-again'
        && woken.wake.newTasks === 1 && woken.wake.newSignals === 2
        && woken.signalIds.includes(newTask.id) && woken.signalIds.includes(sameTask.id)
        && woken.taskCount === (snoozedRow?.taskCount ?? 0) + 1
        && woken.reviewerNote === 'Ask me again later.' && woken.snoozedAt === snoozedRow?.snoozedAt,
      'a new independent observation wakes the snoozed candidate into review with a reason code and leaves the operator note untouched',
      woken && { status: woken.status, wake: woken.wake, tasks: woken.taskCount, note: woken.reviewerNote });
      check(!compound.candidates({ projectId: project.id, limit: 500 })
        .some((c) => c.id !== healthyCandidate.id && c.signalIds.includes(newTask.id)),
      'the new observation joined the woken candidate instead of filing a duplicate');
      if (woken) {
        const strong = automationDecision({ ...woken, scope: 'personal', targetKind: 'memory', confidence: 0.99, evidenceCount: 9, taskCount: 9, conflicts: [] });
        check(strong.decision === 'review' && /snoozed/.test(strong.reason),
          'a candidate that was ever snoozed never auto-applies, whatever its counts', strong);
        check(explainCandidate(woken.id).checks.some((entry) => entry.label === 'Never snoozed by a person' && !entry.ok),
          'and the gate explanation names the snooze as the failing check');
      }
    }
    check(getSignal(ancient.id)?.processedAt != null,
      'never-consolidated signals age out after 45 days instead of growing the backlog forever');
    const oversizeTeach = thrown(() => compound.teach({
      scope: 'personal', title: '学'.repeat(400), text: 'Too-long title must fail before any write.',
    }));
    check(oversizeTeach !== null
      && !listSignals({ processed: false, limit: 1000 }).some((s) => s.summary.startsWith('学学学')),
      'teach validates byte budgets up front and never strands an orphaned signal', oversizeTeach);

    // JSON escaping expands the text after any check on its raw byte length, so
    // a newline-heavy teaching that fits the 32 KB cap as typed does not fit it
    // as stored. teach has to weigh the serialised detail and refuse it in the
    // words of the box it was typed into: accepted here and refused inside
    // recordSignal, the operator read an error naming 'Signal detail' — an
    // object they have never seen — at a smaller number than teach promised.
    const escapeTitle = `Escape-heavy teaching ${tag}`;
    const escapeHeavy = 'a\n'.repeat(16_000);
    const escapeTeach = thrown(() => compound.teach({
      scope: 'personal', title: escapeTitle, text: escapeHeavy,
    }));
    check(Buffer.byteLength(escapeHeavy, 'utf8') <= 32 * 1024 && escapeTeach !== null
      && /32 KB/.test(escapeTeach) && /knowledge/i.test(escapeTeach) && !/Signal detail/.test(escapeTeach)
      && !listSignals({ processed: false, limit: 1000 }).some((s) => s.summary === escapeTitle),
    'teach weighs the serialised teaching rather than the raw text, and refuses it in the words of the box the user typed into',
    escapeTeach);
    const fittingTitle = `Fits once stored ${tag}`;
    const fitting = compound.teach({ scope: 'personal', title: fittingTitle, text: 'b'.repeat(20_000) });
    check(fitting.title === fittingTitle && fitting.proposedText.length === 20_000,
      'and a long teaching that still fits the stored ceiling is accepted whole, so the guard is a limit and not a wall');

    // A below-threshold cluster is deliberately left unprocessed so tomorrow's
    // repeat can still join it, which means the head of the unprocessed queue
    // never drains. A fixed oldest-first row window anchored there therefore
    // stops moving: measured on a real database, 2,864 unprocessed signals
    // whose oldest 1,000 ended four days in the past, and 1,189 consecutive
    // passes recording processed=0 while the five-minute heartbeat kept
    // writing. The pass now takes whole cluster partitions, so a queue longer
    // than one window cannot hide a newer signal -- and a lone observation
    // still waits in the queue for its repeat.
    const starveRoot = path.join(tmp, 'starve');
    fs.mkdirSync(starveRoot, { recursive: true });
    const starveProject = await addProject(starveRoot);
    const starveBase = Date.now() - 7 * 24 * 3600 * 1000;
    const filler: string[] = [];
    db().transaction(() => {
      for (let i = 0; i < 1_050; i++) {
        filler.push(recordSignal({
          kind: 'tool-success', providerId: 'claude', backendId: 'anthropic',
          sessionId: `s-filler-${i}-${tag}`, taskHash: `t-filler-${i}-${tag}`,
          projectId: starveProject.id, projectPath: starveRoot,
          summary: `Filler ${i} ${tag}`, semanticEligible: false,
          createdAt: starveBase + i,
          // A distinct tool name per row is a distinct cluster key, so each of
          // these is a singleton the pass must read past without consuming.
          detail: { toolName: `filler-tool-${i}-${tag}`, ok: true },
        }).id);
      }
    })();
    const mkBuried = (session: string, task: string, at: number) => recordSignal({
      kind: 'tool-failure', providerId: 'claude', backendId: 'anthropic',
      sessionId: `${session}-${tag}`, taskHash: `${task}-${tag}`,
      projectId: starveProject.id, projectPath: starveRoot,
      summary: `Buriedline ${tag} lint passes with the pinned config.`,
      semanticEligible: false, createdAt: at,
      detail: { outcome: 'failed', errorClass: 'lint' },
    });
    const buriedA = mkBuried('s-buried-a', 't-buried-a', starveBase + 2_000);
    const buriedB = mkBuried('s-buried-b', 't-buried-b', starveBase + 2_001);
    const starvePass = compound.consolidate(starveProject.id);
    const buriedCandidate = compound.candidates({ projectId: starveProject.id, limit: 500 })
      .find((c) => c.signalIds.includes(buriedA.id) && c.signalIds.includes(buriedB.id));
    check(!!buriedCandidate,
      'a qualifying pair recorded behind more than one window of below-threshold signals is reached by the same pass, so a backlog longer than one window cannot freeze consolidation on an old one',
      JSON.stringify(starvePass));
    check(filler.every((id) => getSignal(id)?.processedAt === null),
      'and every below-threshold signal it read past is still unprocessed, so making the pass move was not paid for by marking them consumed');
    // The slow-forming case, stated as a test: one observation, then a repeat
    // in a new independent task days later. The first was never consumed, so
    // the second clusters with it and the pair leaves the queue together.
    const slowRepeat = recordSignal({
      kind: 'tool-success', providerId: 'claude', backendId: 'anthropic',
      sessionId: `s-slow-${tag}`, taskHash: `t-slow-${tag}`,
      projectId: starveProject.id, projectPath: starveRoot,
      summary: `Filler 0 ${tag}`, semanticEligible: false,
      detail: { toolName: `filler-tool-0-${tag}`, ok: true },
    });
    compound.consolidate(starveProject.id);
    check(getSignal(filler[0])?.processedAt !== null && getSignal(slowRepeat.id)?.processedAt !== null,
      'a signal that was the only one of its kind for days consolidates with its repeat when that repeat finally arrives, three days of passes later');

    const dupTitle = `Conflictline ${tag}`;
    const confSigA = recordSignal({ kind: 'explicit-teach', summary: dupTitle, taskHash: `t-conf-a-${tag}`, semanticEligible: false });
    const confSigB = recordSignal({ kind: 'explicit-teach', summary: dupTitle, taskHash: `t-conf-b-${tag}`, semanticEligible: false });
    const confA = createCandidate({
      targetKind: 'memory', scope: 'personal', title: dupTitle,
      proposedText: `Conflictline ${tag}: the same fact twice.`, rationale: 'first of a pair',
      confidence: 0.9, signalIds: [confSigA.id],
    });
    const confB = createCandidate({
      targetKind: 'memory', scope: 'personal', title: dupTitle,
      proposedText: `Conflictline ${tag}: the same fact twice.`, rationale: 'second of a pair',
      confidence: 0.9, signalIds: [confSigB.id],
    });
    check(confA.conflicts.length === 0 && confB.conflicts.length === 0,
      'identical pending candidates see no conflict while nothing is active yet');
    reviewCandidate(confA.id, 'approve');
    promoteCandidate(confA.id, { createdBy: 'smoke' });
    reviewCandidate(confB.id, 'approve');
    const promoteRecheck = thrown(() => promoteCandidate(confB.id, { createdBy: 'smoke' }));
    check(promoteRecheck !== null,
      'promotion re-checks conflicts against knowledge created after the candidate', promoteRecheck);

    const reSkill = forgeSkill({
      name: `hardline-skill-${tag}`, description: 'Reinstall coverage for versioned skill updates.',
      trigger: 'When the smoke suite reinstalls the same skill name.', scope: 'project',
      steps: [{ title: 'Step 1', instruction: 'Inspect the relevant files before changing them' }],
      verification: ['Review the final diff'], providerIds: ['claude'],
    });
    const firstInstall = compound.installSkill(reSkill, ['claude'], project.id);
    const secondInstall = compound.installSkill(reSkill, ['claude'], project.id);
    const firstProj = firstInstall[0]?.projection;
    const secondProj = secondInstall[0]?.projection;
    check(!!firstProj && !!secondProj && firstInstall[0].error === null && secondInstall[0].error === null,
      'reinstalling a same-named skill succeeds instead of dead-ending on its own conflict',
      JSON.stringify(secondInstall.map((r) => ({ providerId: r.providerId, error: r.error }))));
    check(!!firstProj && !!secondProj && secondProj.itemId === firstProj.itemId
      && (secondProj.itemId ? getKnowledgeItem(secondProj.itemId)?.currentVersion ?? 0 : 0) >= 2,
      'a skill reinstall writes version N+1 of the same knowledge item');

    const outsideSignal = recordSignal({
      kind: 'explicit-teach', providerId: 'claude', summary: `Outsideline ${tag}`,
      taskHash: `t-outside-${tag}`, projectId: project.id, semanticEligible: false,
    });
    const outsideCand = createCandidate({
      targetKind: 'memory', scope: 'project', providerId: 'claude', projectId: project.id,
      title: `Outsideline ${tag}`, proposedText: `Outsideline ${tag}: cited beyond the root.`,
      rationale: 'outside-root coverage', confidence: 0.9, signalIds: [outsideSignal.id],
    });
    reviewCandidate(outsideCand.id, 'approve');
    const outsideItem = promoteCandidate(outsideCand.id, { createdBy: 'smoke' });
    addEvidence({
      itemId: outsideItem.item.id, versionId: outsideItem.version.id, sourceType: 'file',
      sourceId: '/etc/hosts', citation: 'outside the project root', contentHash: hash('irrelevant'),
    });
    const outsideBrief = await buildBriefing({
      query: 'outsideline', providerId: 'claude', projectId: project.id,
      projectRoot, allowedEvidenceRoots: [projectRoot], maxTokens: 256,
    });
    check(!outsideBrief.entries.some((entry) => entry.itemId === outsideItem.item.id)
      && getKnowledgeItem(outsideItem.item.id)?.status === 'active',
      'an unverifiable-here citation withholds the item without quarantining it');

    const previewSignal = recordSignal({
      kind: 'explicit-teach', providerId: 'claude', summary: `Previewline ${tag}`,
      taskHash: `t-preview-${tag}`, projectId: project.id, semanticEligible: false,
    });
    const previewCand = createCandidate({
      targetKind: 'memory', scope: 'project', providerId: 'claude', projectId: project.id,
      title: `Previewline ${tag}`, proposedText: `Previewline ${tag}: cited and then edited.`,
      rationale: 'preview purity coverage', confidence: 0.9, signalIds: [previewSignal.id],
    });
    reviewCandidate(previewCand.id, 'approve');
    const previewItem = promoteCandidate(previewCand.id, { createdBy: 'smoke' });
    const previewPath = path.join(projectRoot, 'preview.txt');
    fs.writeFileSync(previewPath, 'one\n');
    addEvidence({
      itemId: previewItem.item.id, versionId: previewItem.version.id, sourceType: 'file',
      sourceId: 'preview.txt', citation: 'preview.txt:1', contentHash: hash('one\n'),
    });
    fs.writeFileSync(previewPath, 'two\n');
    const previewBrief = await buildBriefing({
      query: 'previewline', providerId: 'claude', projectId: project.id,
      projectRoot, allowedEvidenceRoots: [projectRoot], maxTokens: 256, quarantineStale: false,
    });
    check(!previewBrief.entries.some((entry) => entry.itemId === previewItem.item.id)
      && previewBrief.omittedStale >= 1
      && getKnowledgeItem(previewItem.item.id)?.status === 'active',
      'a briefing preview reports staleness without quarantining the item');

    const punctHits = searchKnowledge({ query: 'budgetbeacon .', match: 'all', limit: 10 });
    check(punctHits.some((hit) => hit.item.id === budgetItem.item.id),
      'punctuation-only search tokens are dropped instead of blanking results');

    say('── compound · what a briefing refuses to inject');
    // The exact signature of the junk rows found in a live store: a summary
    // copied into both the title and the claim, and a bare locator filed as
    // knowledge. Both look canonical and say nothing, so injecting one spends
    // tokens to teach noise.
    const junkSignal = recordSignal({
      kind: 'explicit-teach', providerId: 'codex', backendId: 'openai',
      sessionId: `session-junk-${tag}`, taskHash: `task-junk-${tag}`,
      summary: `Junkline ${tag} was filed without ever being synthesized.`, semanticEligible: true,
    });
    const echoTitle = `Junkline echo ${tag}`;
    const echoCandidate = createCandidate({
      targetKind: 'memory', scope: 'personal', providerId: 'codex',
      title: echoTitle, proposedText: echoTitle,
      rationale: 'The proposed text is the title again.', confidence: 0.9, signalIds: [junkSignal.id],
    });
    reviewCandidate(echoCandidate.id, 'approve');
    const echoItem = promoteCandidate(echoCandidate.id, { createdBy: 'smoke' });
    const locatorCandidate = createCandidate({
      targetKind: 'memory', scope: 'personal', providerId: 'codex',
      title: `Junkline locator ${tag}`, proposedText: '/srv/app/src/main/db.ts',
      rationale: 'A bare absolute path is a locator, not an instruction.',
      confidence: 0.9, signalIds: [junkSignal.id],
    });
    reviewCandidate(locatorCandidate.id, 'approve');
    const locatorItem = promoteCandidate(locatorCandidate.id, { createdBy: 'smoke' });
    const junkBrief = await buildBriefing({ query: 'junkline', providerId: 'codex', maxTokens: 512 });
    check(!junkBrief.entries.some((entry) => entry.itemId === echoItem.item.id)
      && !junkBrief.entries.some((entry) => entry.itemId === locatorItem.item.id)
      && junkBrief.omittedUnsynthesized >= 2,
    'an unsynthesized item is refused by name rather than quietly ranked low', JSON.stringify({
      entries: junkBrief.entries.length, omittedUnsynthesized: junkBrief.omittedUnsynthesized,
    }));
    check(searchKnowledge({ query: 'junkline', limit: 20 }).length >= 2,
      'while both stay retrievable in the app — refusing to inject is not deleting');

    // A briefing is a system prompt, and an eval is regression evidence while a
    // project map is topology. Neither is a sentence an agent can act on.
    const kindSignal = recordSignal({
      kind: 'rejected-review', providerId: 'codex', backendId: 'openai',
      sessionId: `session-kind-${tag}`, taskHash: `task-kind-${tag}`, projectId: project.id,
      projectPath: projectRoot, summary: `Kindline ${tag} regression evidence.`, semanticEligible: true,
    });
    const evalCandidate = createCandidate({
      targetKind: 'eval', scope: 'personal', providerId: 'codex',
      title: `Kindline eval ${tag}`, proposedText: `Kindline ${tag}: keep the case that caught the bad merge.`,
      rationale: 'Regression evidence.', confidence: 0.95, signalIds: [kindSignal.id],
    });
    reviewCandidate(evalCandidate.id, 'approve');
    const evalItem = promoteCandidate(evalCandidate.id, { createdBy: 'smoke' });
    const mapCandidate = createCandidate({
      targetKind: 'project-map', scope: 'project', providerId: 'codex', projectId: project.id,
      title: `Kindline map ${tag}`, proposedText: `Kindline ${tag}: the launch path lives under src/main.`,
      rationale: 'File topology.', confidence: 0.95, signalIds: [kindSignal.id],
    });
    reviewCandidate(mapCandidate.id, 'approve');
    const mapItem = promoteCandidate(mapCandidate.id, { createdBy: 'smoke' });
    const kindBrief = await buildBriefing({
      query: 'kindline', providerId: 'codex', projectId: project.id,
      projectRoot, allowedEvidenceRoots: [projectRoot], maxTokens: 512,
    });
    check(!kindBrief.entries.some((entry) => entry.itemId === evalItem.item.id)
      && !kindBrief.entries.some((entry) => entry.itemId === mapItem.item.id),
    'an eval and a project map never reach a briefing, whatever they rank', JSON.stringify(kindBrief.entries.map((e) => e.kind)));
    const widened = await buildBriefing({
      query: 'kindline', providerId: 'codex', projectId: project.id, kinds: ['eval', 'project-map'], maxTokens: 512,
    });
    check(widened.entries.length === 0,
      'and a caller asking exclusively for those kinds gets an empty briefing, never an unfiltered one');
    const mapCompile = compileCandidate(mapCandidate.id, CODEX_ARTIFACT_COMPILER, {
      providerId: 'codex', projectRoot, homeDir: fakeHome,
    });
    check(!mapCompile.supported && mapCompile.mode === 'unsupported' && /never briefed/.test(mapCompile.reason),
      'a project map reports no delivery at all instead of a briefing that never happens', mapCompile.reason);
    check(searchKnowledge({ query: 'kindline', kinds: ['eval', 'project-map'], projectId: project.id, limit: 20 })
      .length === 2,
    'both remain retrievable and inspectable through the app’s own search');

    say('── compound · the auto-promotion boundary');
    // Only reversible personal recall may skip the review inbox. That held as a
    // data property — every session signal carries a project id, so the
    // classifier always returned project scope — and a single signal source
    // that forgot the project id would have opened a path from agent-produced
    // text straight into applied memory. Hybrid is switched on here because a
    // review-only engine proves nothing about the gate.
    const priorAutomation = compound.settings().automation;
    try {
      compound.updateSettings({ automation: 'hybrid' });
      const autoBase = Date.now() - 30_000;
      const autoPaths = [path.join(projectRoot, 'src', 'gate', 'rules.ts')];
      const mkAutoSig = (session: string, task: string, at: number) => recordSignal({
        kind: 'permission-denied', providerId: 'claude', backendId: 'anthropic',
        sessionId: session, taskHash: task, projectId: project.id, projectPath: projectRoot,
        summary: `Autoline ${tag}: an agent write under src/gate was denied.`,
        detail: { toolName: 'Write', ok: false, paths: autoPaths },
        semanticEligible: false, createdAt: at,
      });
      const autoA = mkAutoSig(`s-auto-a-${tag}`, `t-auto-a-${tag}`, autoBase);
      mkAutoSig(`s-auto-b-${tag}`, `t-auto-b-${tag}`, autoBase + 1);
      mkAutoSig(`s-auto-c-${tag}`, `t-auto-c-${tag}`, autoBase + 2);
      const unattributed = recordSignal({
        kind: 'tool-success', providerId: 'claude', summary: `Autoline unattributed ${tag}`,
        taskHash: `t-auto-personal-${tag}`, semanticEligible: false,
      });
      check(classifySignal(autoA).scope === 'project' && classifySignal(unattributed).scope === 'personal',
        'a signal carrying a project id classifies to project scope, and only an unattributed one stays personal');

      const autoPass = compound.consolidate(project.id);
      const autoCandidate = compound.candidates({ projectId: project.id, limit: 500 })
        .find((candidate) => candidate.signalIds.includes(autoA.id));
      const autoDecision = autoCandidate ? automationDecision(autoCandidate) : null;
      check(!!autoCandidate && autoCandidate.scope === 'project' && autoCandidate.projectId === project.id,
        'consolidating project-attributed evidence produces a project-scoped candidate, never a personal one',
        autoCandidate && { scope: autoCandidate.scope, projectId: autoCandidate.projectId });
      check(autoDecision?.decision === 'review' && /Project and path-scoped/.test(autoDecision.reason),
        'and the automation gate refuses it on scope, so the invariant is asserted rather than inherited',
        autoDecision);
      check(!!autoCandidate && autoCandidate.confidence < DEFAULT_AUTOMATION_POLICY.minConfidence,
        'a rule-derived confidence stays under the auto-apply floor however often the observation repeats',
        autoCandidate?.confidence);
      check(ranCounts(autoPass)?.autoApplied === 0 && (ranCounts(autoPass)?.candidates ?? 0) >= 1,
        'so a hybrid pass over agent-derived evidence files candidates and auto-applies none', JSON.stringify(autoPass));
      check(!!autoCandidate && autoCandidate.status === 'pending',
        'the candidate waits in the review inbox for a person', autoCandidate?.status);
    } finally {
      compound.updateSettings({ automation: priorAutomation });
    }

    say('── compound · controlled experiments and honest ROI');
    const experiment = createExperiment({
      name: `Skill comparison ${tag}`, projectId: project.id, itemId: promotedSkill.item.id,
      candidateId: skillCandidate.id, candidateVersionId: promotedSkill.version.id,
      providerId: 'codex', model: 'gpt-5.6-terra', effort: 'high', commitHash: `commit-${tag}`,
      config: {
        baseline: { providerId: 'codex', model: 'gpt-5.6-terra', effort: 'high', commitHash: `commit-${tag}`, artifact: false },
        candidate: { providerId: 'codex', model: 'gpt-5.6-terra', effort: 'high', commitHash: `commit-${tag}`, artifact: true },
      },
    });
    check(startExperiment(experiment.id).status === 'running', 'experiment records an attributed running state');
    const completed = completeExperiment(experiment.id, { winner: 'candidate', sampleCount: 12 });
    check(completed.status === 'completed' && completed.outcome?.winner === 'candidate',
      'experiment outcome remains attached to fixed controls');
    const invalidExperiment = thrown(() => createExperiment({
      name: `Invalid comparison ${tag}`, candidateId: skillCandidate.id,
      providerId: 'codex', model: 'gpt-5.6-terra', effort: 'high', commitHash: `commit-${tag}`,
      config: { baseline: { model: 'gpt-5.6-terra' }, candidate: { model: 'another-model' } },
    }));
    check(invalidExperiment !== null && /model must remain fixed/.test(invalidExperiment),
      'experiment refuses a model change that would confound attribution', invalidExperiment);

    // "Causal" is the one label that claims a controlled comparison produced the
    // number, so it is the one label a caller must not be able to assert on its
    // own. These metrics name the completed experiment above, which fixed
    // provider, model, effort and commit — so the claim is attributable.
    for (const [metric, value] of [['tokens_saved', 211], ['tokens_loaded', 37], ['use_success', 1]] as const) {
      recordMetric({ itemId: promotedSkill.item.id, versionId: promotedSkill.version.id,
        providerId: 'codex', metric, value, evidenceLevel: 'causal', experimentId: experiment.id });
    }
    const causalRoi = summarizeArtifactRoi(promotedSkill.item.id);
    check(causalRoi.evidenceLevel === 'causal' && causalRoi.tokensSaved === 211 && causalRoi.samples === 3,
      'metrics attributed to a completed experiment with fixed controls report causal savings',
      JSON.stringify(causalRoi));

    // The negative half, and the reason this check exists at all: before the
    // experiment link, recordMetric wrote whatever level the caller asserted, so
    // this suite claimed causal savings that nothing had attributed. An
    // unattached causal claim must now degrade rather than be taken on trust.
    const unattachedCandidate = createCandidate({
      targetKind: 'memory',
      scope: 'project',
      providerId: 'claude',
      projectId: project.id,
      title: `Unattributed saving ${tag}`,
      proposedText: 'A claim nobody ran a controlled comparison for.',
      rationale: 'Exists only to prove an unattached causal claim degrades.',
      confidence: 0.9,
      signalIds: [first.id, second.id],
    });
    reviewCandidate(unattachedCandidate.id, 'approve');
    const unattached = promoteCandidate(unattachedCandidate.id, { createdBy: 'smoke' });
    recordMetric({ itemId: unattached.item.id, versionId: unattached.version.id,
      providerId: 'codex', metric: 'tokens_saved', value: 500, evidenceLevel: 'causal' });
    const unattributedRoi = summarizeArtifactRoi(unattached.item.id);
    check(unattributedRoi.evidenceLevel !== 'causal',
      'a causal claim with no experiment behind it degrades instead of being taken on trust',
      JSON.stringify(unattributedRoi));
    recordMetric({ itemId: promotedSkill.item.id, versionId: promotedSkill.version.id,
      providerId: 'codex', metric: 'cost_usd', value: 0.01, evidenceLevel: 'estimate' });
    check(summarizeArtifactRoi(promotedSkill.item.id).evidenceLevel === 'estimate',
      'mixed evidence downgrades the whole ROI claim to its weakest evidence level');

    say('── compound · live service integration');
    const frozenSessionId = `session-frozen-${tag}`;
    const frozenProviderId = `retired-profile-${tag}`;
    const frozenBackendId = `retired-backend-${tag}`;
    db().prepare(`
      INSERT INTO session_log
        (id,provider_id,project_id,project_path,project_name,started_at,backend_id,provider_profile_json)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(
      frozenSessionId, frozenProviderId, project.id, projectRoot, project.name, Date.now(),
      frozenBackendId, JSON.stringify({ id: frozenProviderId, backendId: frozenBackendId }),
    );
    const frozenCandidate = compound.teach({
      sessionId: frozenSessionId,
      // Deliberately wrong: renderer input must not be able to rewrite history.
      providerId: 'claude',
      projectId: project.id,
      projectPath: projectRoot,
      kind: 'memory',
      scope: 'project',
      title: `Frozen attribution ${tag}`,
      text: `Frozen attribution ${tag} remains attached to the backend that produced it.`,
      outcome: 'worked',
    });
    const frozenSignal = getSignal(frozenCandidate.signalIds[0]);
    check(
      frozenSignal?.providerId === frozenProviderId
        && frozenSignal.backendId === frozenBackendId
        && frozenSignal.semanticEligible,
      'Teach from session uses frozen provider/backend history, not mutable renderer or registry input',
      frozenSignal,
    );

    const unattributedSessionId = `session-unattributed-${tag}`;
    db().prepare(`
      INSERT INTO session_log
        (id,provider_id,project_id,project_path,project_name,started_at,backend_id,provider_profile_json)
      VALUES (?,?,?,?,?,?,NULL,NULL)
    `).run(unattributedSessionId, `legacy-profile-${tag}`, project.id, projectRoot, project.name, Date.now());
    const unattributedError = thrown(() => compound.teach({
      sessionId: unattributedSessionId,
      providerId: 'claude',
      projectId: project.id,
      projectPath: projectRoot,
      kind: 'memory',
      scope: 'project',
      title: `Unattributed teaching ${tag}`,
      text: 'This must not be relabelled through the current provider registry.',
      outcome: 'worked',
    }));
    check(
      unattributedError !== null && listSignals({ sessionId: unattributedSessionId }).length === 0,
      'Teach from a session with no frozen backend fails semantic attribution closed',
      unattributedError,
    );

    const shellSecret = `sk-learning-${tag}`;
    const rawCommand = `ANTHROPIC_AUTH_TOKEN=${shellSecret} provider-cli --api-key ${shellSecret} status`;
    const learningSession: Session = {
      id: `session-shell-a-${tag}`,
      providerId: 'claude',
      projectId: project.id,
      projectPath: projectRoot,
      projectName: project.name,
      title: 'Learning sanitizer fixture',
      status: 'running',
      pid: null,
      exitCode: null,
      createdAt: Date.now(),
      endedAt: null,
      unread: 0,
      backendId: 'anthropic',
    };
    const shellSignalA = compound.observeSessionEvent({
      id: 1,
      sessionId: learningSession.id,
      at: Date.now(),
      event: 'PostToolUse',
      toolName: 'Bash',
      summary: rawCommand,
      durationMs: 12,
      ok: true,
      paths: [],
    }, learningSession);
    const secondLearningSession = { ...learningSession, id: `session-shell-b-${tag}` };
    const shellSignalB = compound.observeSessionEvent({
      id: 2,
      sessionId: secondLearningSession.id,
      at: Date.now() + 1,
      event: 'PostToolUse',
      toolName: 'Terminal',
      summary: rawCommand,
      durationMs: 15,
      ok: true,
      paths: [],
    }, secondLearningSession);
    const redactedSignal = compound.observeSessionEvent({
      id: 3,
      sessionId: learningSession.id,
      at: Date.now() + 2,
      event: 'PostToolUse',
      toolName: 'Read',
      summary: `Authorization: Bearer ${shellSecret}`,
      durationMs: 2,
      ok: true,
      paths: [`credentials/${shellSecret}`],
    }, learningSession);
    const storedLearningEvents = JSON.stringify([shellSignalA, shellSignalB, redactedSignal]);
    check(
      shellSignalA?.summary === 'Shell command completed.'
        && shellSignalB?.summary === 'Shell command completed.'
        && !storedLearningEvents.includes(rawCommand)
        && !storedLearningEvents.includes(shellSecret),
      'learning signals discard shell command text and redact credentials before persistence',
      storedLearningEvents,
    );
    compound.consolidate(project.id);
    const shellCandidate = compound.candidates({ projectId: project.id, limit: 500 })
      .find((candidate) => candidate.signalIds.some((id) => id === shellSignalA?.id || id === shellSignalB?.id));
    check(!shellCandidate, 'redacted shell outcomes cannot become reusable learning candidates');

    const connSignal = compound.observeSessionEvent({
      id: 4,
      sessionId: learningSession.id,
      at: Date.now() + 3,
      event: 'PostToolUse',
      toolName: 'Read',
      summary: 'Connected postgres://smokeuser:sm0kepass@db.local/app and API_KEY: smokesecret9 plus whsec_smokeabcdef123456',
      durationMs: 3,
      ok: true,
      paths: [],
    }, learningSession);
    check(!!connSignal
      && !connSignal.summary.includes('sm0kepass')
      && !connSignal.summary.includes('smokesecret9')
      && !connSignal.summary.includes('abcdef123456'),
      'redaction covers non-http connection strings, colon-form env names, and underscore token shapes',
      connSignal?.summary);

    // A hook-observed Skill call resolves through the applied SKILL.md
    // projection to its knowledge item; that row is what the optimizer's
    // "no observed use" rule reads. A skill Wanigan never installed is nothing
    // it can account for, and a typed `/name` never arrives here at all.
    const installedSkillItem = secondInstall[0]?.projection?.itemId ?? null;
    const skillEvent = {
      id: 5, sessionId: learningSession.id, at: Date.now() + 4, event: 'PostToolUse',
      toolName: 'Skill', summary: reSkill.name, durationMs: 40, ok: true, paths: [],
    };
    compound.observeSessionEvent(skillEvent, learningSession);
    compound.observeSessionEvent({ ...skillEvent, id: 6, at: Date.now() + 5, summary: `not-installed-${tag}` }, learningSession);
    const invocations = listMetrics({ sessionId: learningSession.id, metric: 'invocation' });
    check(installedSkillItem !== null && invocations.length === 1 && invocations[0].itemId === installedSkillItem
      && invocations[0].evidenceLevel === 'correlation' && invocations[0].attrs.skill === reSkill.name,
    'a hook-observed Skill tool call resolves through its applied projection and records one observed invocation; an uninstalled skill records nothing',
    JSON.stringify(invocations.map((metric) => ({ item: metric.itemId, level: metric.evidenceLevel, attrs: metric.attrs }))));

    // Transcript citations: counts of `wanigan:<id>` in archived assistant
    // turns, Claude harness only, correlation-level, replaced on rescan. Zero
    // is a count and never evidence of disuse.
    const citeSessionId = `session-cite-${tag}`;
    db().prepare(`
      INSERT INTO session_log (id,provider_id,project_id,project_path,project_name,started_at,backend_id,harness_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(citeSessionId, 'claude', project.id, projectRoot, project.name, Date.now(), 'anthropic', 'claude-code');
    db().prepare(`
      INSERT INTO transcripts (session_id, source_path, stored_path, bytes, turns, parsed, archived_at, note)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(citeSessionId, '/dev/null', '/dev/null', 10, 2, 1, Date.now(), 'Archived 10 bytes.');
    const citedItemId = promotedMemory.item.id;
    const ftsInsert = db().prepare('INSERT INTO transcript_fts (session_id, role, at, text) VALUES (?,?,?,?)');
    ftsInsert.run(citeSessionId, 'assistant', Date.now(),
      `Per wanigan:${citedItemId} I verified the lock; wanigan:${citedItemId} again, and wanigan:know_00000000000000000000 is unknown.`);
    ftsInsert.run(citeSessionId, 'user', Date.now(), `please follow wanigan:${citedItemId}`);
    const scan = compound.recordTranscriptCitations(citeSessionId);
    const citedMetrics = listMetrics({ sessionId: citeSessionId, metric: 'cited' });
    check(scan.status === 'scanned' && scan.total === 2 && !scan.truncated
      && scan.items.length === 1 && scan.items[0].itemId === citedItemId && scan.items[0].n === 2
      && citedMetrics.length === 1 && citedMetrics[0].evidenceLevel === 'correlation',
    'a transcript scan counts wanigan:<id> tags in assistant turns only, resolves them to items, and records correlation-level counts',
    JSON.stringify(scan));
    compound.recordTranscriptCitations(citeSessionId);
    check(listMetrics({ sessionId: citeSessionId, metric: 'cited' }).length === 1
      && listMetrics({ sessionId: citeSessionId, metric: 'transcript_scan' }).length === 1,
    'rescanning a session replaces its previous scan instead of appending to it');
    const citeLedger = sessionLearningLedger(citeSessionId).transcriptCitations;
    check(citeLedger.status === 'scanned' && citeLedger.total === 2 && citeLedger.items[0]?.itemId === citedItemId,
      'the session ledger reports the recorded scan', JSON.stringify(citeLedger));
    const codexCiteSessionId = `session-cite-codex-${tag}`;
    db().prepare(`
      INSERT INTO session_log (id,provider_id,project_id,project_path,project_name,started_at,backend_id,harness_id)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(codexCiteSessionId, 'codex', project.id, projectRoot, project.name, Date.now(), 'openai', 'codex');
    check(compound.recordTranscriptCitations(codexCiteSessionId).status === 'unsupported'
      && sessionLearningLedger(codexCiteSessionId).transcriptCitations.status === 'unsupported'
      && sessionLearningLedger(learningSession.id).transcriptCitations.status === 'not-scanned',
    'a Codex-harness session reports no transcript archive, and an unscanned session reports not-scanned — neither reads as zero');

    const serviceCandidate = compound.teach({
      providerId: 'claude', projectId: project.id, projectPath: projectRoot,
      kind: 'instruction', scope: 'project', title: `Service boundary ${tag}`,
      text: `Servicebound ${tag}: run the deterministic review gate before completion.`,
      outcome: 'preference',
    });
    compound.reviewCandidate(serviceCandidate.id, 'approve');
    const serviceApply = compound.applyCandidateToProvider(serviceCandidate.id, 'claude');
    check(serviceApply.projection.status === 'applied' && fs.existsSync(serviceApply.projection.targetPath),
      'service promotes and safely applies an approved provider projection');
    const crossProvider = thrown(() => compound.applyCandidateToProvider(serviceCandidate.id, 'codex'));
    check(crossProvider !== null && /Cross-(?:provider|backend) projection/.test(crossProvider),
      'service refuses cross-backend projection of backend-attributed semantic content', crossProvider);
    const claudeServiceBrief = await compound.briefing({
      query: 'servicebound', providerId: 'claude', projectId: project.id, maxTokens: 256,
    });
    const codexServiceBrief = await compound.briefing({
      query: 'servicebound', providerId: 'codex', projectId: project.id, maxTokens: 256,
    });
    check(claudeServiceBrief.entries.some((entry) => entry.itemId === serviceApply.item.id)
      && !codexServiceBrief.entries.some((entry) => entry.itemId === serviceApply.item.id),
    'service briefing enforces the same-backend semantic boundary');
    check(claudeServiceBrief.learningEnabled && claudeServiceBrief.launchDelivery === 'append-system-prompt'
      && codexServiceBrief.launchDelivery === 'developer-instructions' && claudeServiceBrief.harnessProof === 'builtin',
    'the preview says how a launch would deliver the capsule for each harness and what proof the launch requires');
    // A disabled engine is its own state with the full counter shape, not an
    // empty stub a dialog would read as "retrieval ran and matched nothing".
    const priorEnabled = compound.settings().enabled;
    try {
      compound.updateSettings({ enabled: false });
      const offBrief = await compound.briefing({ query: 'servicebound', providerId: 'claude', projectId: project.id });
      check(!offBrief.learningEnabled && offBrief.entries.length === 0 && offBrief.omitted === 0
        && offBrief.omittedUnverified === 0 && offBrief.omittedUnsynthesized === 0 && offBrief.queryProvided
        && offBrief.launchDelivery === 'append-system-prompt',
      'a preview with learning off is a distinct state carrying every counter, never an indistinguishable empty stub');
    } finally {
      compound.updateSettings({ enabled: priorEnabled });
    }
    const serviceUndo = compound.undo(serviceApply.projection.id);
    check(serviceUndo.status === 'undone' && !fs.existsSync(serviceUndo.targetPath),
      'service undo restores the exact project-file snapshot');
    check(compound.overview(project.id).activeKnowledge >= 1,
      'Learning overview is backed by the canonical store');
  } catch (error) {
    check(false, `compound learning suite threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    say('── provider packs · validation, trust, dynamic ids, and removal');
    const packsRoot = path.join(tmp, 'provider-packs');
    const packDir = path.join(packsRoot, 'orbit.pack');
    fs.mkdirSync(packDir, { recursive: true });
    const adapterFile = path.join(packDir, 'adapter.bin');
    fs.writeFileSync(adapterFile, [
      '#!/bin/sh',
      'IFS= read -r request',
      `printf '%s\\n' '{"protocolVersion":1,"id":"probe","ok":true,"result":{"capabilities":{"telemetry":true,"hooks":true,"namedResume":true,"headlessJson":true},"note":"bounded fixture probe"}}'`,
      '',
    ].join('\n'));
    fs.chmodSync(adapterFile, 0o700);
    const manifest: ProviderPackManifest = {
      schemaVersion: 1,
      id: 'orbit.pack',
      label: 'Orbit Pack',
      version: '9.4.1',
      adapter: { kind: 'process', protocolVersion: 1, executable: 'adapter.bin' },
      profiles: [{
        id: 'orbit-vortex-v9',
        label: 'Orbit Vortex',
        harness: 'generic-cli',
        backend: { id: 'orbit-backend-v9', label: 'Orbit Backend' },
        command: { bin: 'orbit', baseArgs: ['serve'], versionArgs: ['version'] },
        launchFields: [
          { id: 'model', label: 'Model', kind: 'text', argv: ['--model', '{value}'] },
          {
            id: 'region', label: 'Region', kind: 'select', required: true, allowCustom: false,
            choices: [{ value: 'north', label: 'North' }, { value: 'south', label: 'South' }],
            argv: ['--region', '{value}'],
          },
        ],
        capabilities: { hooks: 'probe', telemetry: 'probe', skills: 'probe' },
        headless: 'none',
      }],
    };
    const valid = validateProviderPackManifest(manifest);
    const invalid = validateProviderPackManifest({ ...manifest, id: '../../escape' });
    const shellManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.shell',
      profiles: [{ ...manifest.profiles[0], id: 'orbit-shell', command: { bin: '/bin/sh', baseArgs: ['-c', 'echo unsafe'] } }],
    });
    const interpreterManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.interpreter',
      profiles: [{ ...manifest.profiles[0], id: 'orbit-interpreter', command: { bin: 'python3.12', baseArgs: ['agent.py'] } }],
    });
    const preloadManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.preload',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-preload',
        environment: { NODE_OPTIONS: { source: 'literal', value: '--require=/tmp/unsigned-provider-code.js' } },
      }],
    });
    const nativeLoaderManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.native-loader',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-native-loader',
        environment: { LD_AUDIT: { source: 'literal', value: '/tmp/unsigned-audit-library.so' } },
      }],
    });
    check(valid.ok, 'provider manifest accepts a new opaque profile/backend without a core enum');
    check(!invalid.ok, 'provider manifest rejects an escaping pack id');
    check(!shellManifest.ok, 'data-only manifests cannot smuggle executable code through a shell command');
    check(!interpreterManifest.ok, 'versioned general-purpose interpreters are refused as defense in depth');
    check(!preloadManifest.ok, 'provider environment cannot inject runtime loaders or override privacy controls');
    check(!nativeLoaderManifest.ok, 'native loader and profiler environment families are refused');
    // `source: 'process'` is the one place a data-only manifest reaches into
    // Wanigan's own environment. The agent already inherits that environment,
    // so the leak is not the presence of the operator's key — it is the
    // rename: a pack that reads ANTHROPIC_API_KEY into a destination of its
    // choosing hands that key to whatever host the pack points at, and the
    // launch-time strip in sessions.ts only covers Anthropic keys on a profile
    // that redirects the Anthropic API.
    const ambientCredentialManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.ambient-credential',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-ambient-credential',
        environment: {
          ORBIT_BASE_URL: { source: 'literal', value: 'https://orbit.example/api' },
          ORBIT_AUTH: { source: 'process', name: 'ANTHROPIC_API_KEY' },
        },
      }],
    });
    const secretShapedSourceManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.secret-shaped-source',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-secret-shaped-source',
        environment: { ORBIT_AUTH: { source: 'process', name: 'WANIGAN_ORBIT_API_KEY' } },
      }],
    });
    const configSourceManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.config-source',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-config-source',
        environment: {
          ORBIT_BASE_URL: {
            source: 'process', name: 'WANIGAN_ORBIT_BASE_URL', fallback: 'https://orbit.example/api',
          },
        },
      }],
    });
    check(
      !ambientCredentialManifest.ok
        && ambientCredentialManifest.errors.some((error) => /ANTHROPIC_API_KEY/.test(error)),
      'a manifest cannot read an ambient provider credential out of Wanigan’s own environment',
      ambientCredentialManifest.ok ? null : ambientCredentialManifest.errors,
    );
    check(!secretShapedSourceManifest.ok,
      'a key-shaped WANIGAN_ process source is refused even though the prefix stays readable',
      secretShapedSourceManifest.ok ? null : secretShapedSourceManifest.errors);
    check(configSourceManifest.ok,
      'a process source that reads configuration rather than a credential is still accepted',
      configSourceManifest.ok ? null : configSourceManifest.errors);

    const borrowedCredentialManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.borrowed-credential',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-borrowed-credential',
        environment: { ANTHROPIC_AUTH_TOKEN: { source: 'credential', id: 'glm' } },
      }],
    });
    check(!borrowedCredentialManifest.ok
      && borrowedCredentialManifest.errors.some((error) => /not a profile in this pack/.test(error)),
      'a manifest that names a credential id it does not own is refused at validation with that id quoted, because the provider key store has no pack namespace and "glm" declared in any manifest at all reads the operator’s Z.ai token and hands it to that pack’s own command',
      borrowedCredentialManifest.ok ? null : borrowedCredentialManifest.errors);

    const ownCredentialManifest = validateProviderPackManifest({
      ...manifest,
      id: 'orbit.own-credential',
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-own-credential',
        environment: { ORBIT_TOKEN: { source: 'credential', id: 'orbit-own-credential' } },
      }],
    });
    check(ownCredentialManifest.ok,
      'a pack that names one of its own profile ids as the credential to spend is still accepted, which is the shape both shipped packs use and the only shape the ownership rule is meant to leave standing',
      ownCredentialManifest.ok ? null : ownCredentialManifest.errors);
    check(
      effectiveProviderBackendId({ source: 'local', packId: 'orbit.pack', backend: { id: 'anthropic' } })
        === 'orbit.pack:anthropic',
      'a local pack cannot inherit built-in semantic memory by reusing its backend id',
    );

    const compatibilityRoot = path.join(tmp, 'provider-packs-compatibility');
    const compatibilityDir = path.join(compatibilityRoot, 'orbit.compat');
    fs.mkdirSync(compatibilityDir, { recursive: true });
    const compatibilityManifest: ProviderPackManifest = {
      ...manifest,
      id: 'orbit.compat',
      label: 'Orbit Compatibility Claim',
      adapter: undefined,
      profiles: [{
        ...manifest.profiles[0],
        id: 'orbit-compat-claude',
        harness: 'claude-code',
        headless: 'claude-json',
      }],
    };
    fs.writeFileSync(
      path.join(compatibilityDir, 'provider-pack.json'),
      `${JSON.stringify(compatibilityManifest, null, 2)}\n`,
    );
    const compatibilityRegistry = new ProviderPackRegistry({
      rootDir: compatibilityRoot, builtins: [], homeDir: fakeHome,
    });
    check(
      compatibilityRegistry.listPacks()[0]?.status === 'invalid'
        && compatibilityRegistry.listPacks()[0]?.errors.some((error) => /capability-probe adapter/.test(error)),
      'a local manifest cannot claim Claude/Codex harness wiring without a separate adapter',
      compatibilityRegistry.listPacks()[0]?.errors,
    );
    fs.writeFileSync(path.join(packDir, 'provider-pack.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    const registry = new ProviderPackRegistry({ rootDir: packsRoot, builtins: [], homeDir: fakeHome });
    check(registry.listPacks()[0]?.status === 'needs-trust' && registry.runtimeById('orbit-vortex-v9') === undefined,
      'new local pack stays unavailable until its exact digests are trusted');
    const refused = thrown(() => registry.setEnabled('orbit.pack', true));
    check(refused !== null && /Trust.*manifest digest/i.test(refused),
      'enabling cannot silently approve a provider manifest', refused);
    const inspected = registry.inspectAdapter('orbit.pack');
    check(!!inspected && inspected.executable.startsWith(packDir) && inspected.sha256.length === 64,
      'adapter inspection exposes its contained path and SHA-256 digest');
    if (inspected) registry.trustAdapter('orbit.pack', inspected.sha256);
    check(registry.listPacks()[0]?.status === 'needs-trust',
      'adapter trust does not silently approve the separate provider manifest');
    const inspectedManifest = registry.listPacks()[0]?.manifestSha256;
    const wrongManifest = thrown(() => registry.trustManifest('orbit.pack', '0'.repeat(64)));
    check(wrongManifest !== null && /changed after inspection/i.test(wrongManifest),
      'manifest trust is bound to the exact inspected digest', wrongManifest);
    if (inspectedManifest) registry.trustManifest('orbit.pack', inspectedManifest);
    check(registry.listPacks()[0]?.status === 'disabled',
      'manifest trust records approval without enabling a provider');
    registry.revokeAdapterTrust('orbit.pack');
    const adapterRefused = thrown(() => registry.setEnabled('orbit.pack', true));
    check(adapterRefused !== null && /Trust.*executable adapter/i.test(adapterRefused),
      'manifest approval cannot silently approve executable adapter code', adapterRefused);

    const foldRoot = path.join(tmp, 'provider-packs-credential-fold');
    const foldDir = path.join(foldRoot, 'fold.pack');
    fs.mkdirSync(foldDir, { recursive: true });
    fs.writeFileSync(path.join(foldDir, 'provider-pack.json'), `${JSON.stringify({
      ...manifest,
      id: 'fold.pack',
      adapter: undefined,
      profiles: [{
        ...manifest.profiles[0],
        id: 'g.l.m',
        environment: { ANTHROPIC_AUTH_TOKEN: { source: 'credential' } },
      }],
    }, null, 2)}\n`);
    const spentCredentialIds: string[] = [];
    const foldRegistry = new ProviderPackRegistry({
      rootDir: foldRoot,
      builtins: BUILTIN_PROVIDER_PACKS,
      homeDir: fakeHome,
      credentialResolver: (id: string) => { spentCredentialIds.push(id); return `token-for-${id}`; },
    });
    const foldPack = foldRegistry.listPacks().find((pack) => pack.id === 'fold.pack');
    check(foldPack?.status === 'invalid'
      && foldPack.errors.some((error) => /reads the credential stored for provider pack "wanigan\.glm"/.test(error))
      && foldRegistry.runtimeById('g.l.m') === undefined
      && spentCredentialIds.length === 0,
      'ownership by profile id is only a boundary because two ids cannot name one stored credential: keys.ts deletes `.` and `_` out of the id (a `-` survives), so a pack whose only profile is "g.l.m" owns the id it declares and would still read the file written for "glm" — that pack is invalid, contributes no profile, compiles to no runtime, and never asks the key store for anything',
      { status: foldPack?.status, errors: foldPack?.errors, spentCredentialIds });

    const builtInRevoke = thrown(() => foldRegistry.revokeAdapterTrust('wanigan.claude'));
    const claudeAfterRevoke = foldRegistry.listPacks().find((pack) => pack.id === 'wanigan.claude');
    check(builtInRevoke !== null
      && /no trusted adapter digest to revoke/.test(builtInRevoke)
      && claudeAfterRevoke?.enabled === true
      && claudeAfterRevoke.status === 'enabled',
      'revoking adapter trust resolves the pack before it writes anything, so an id that never held adapter trust is refused by name instead of having enabled:false written under it — the call that used to disable the built-in Claude pack now leaves it enabled',
      { builtInRevoke, status: claudeAfterRevoke?.status, enabled: claudeAfterRevoke?.enabled });

    const junkRevoke = thrown(() => foldRegistry.revokeAdapterTrust('x'.repeat(300_000)));
    const foldStateFile = path.join(foldRoot, '.provider-packs-state.json');
    const foldStateSize = fs.existsSync(foldStateFile) ? fs.statSync(foldStateFile).size : 0;
    const afterJunkRevoke = new ProviderPackRegistry({
      rootDir: foldRoot, builtins: BUILTIN_PROVIDER_PACKS, homeDir: fakeHome,
    });
    check(junkRevoke !== null
      && foldStateSize <= 256 * 1024
      && afterJunkRevoke.snapshot().diagnostics.every((line) => !/state was invalid/.test(line)),
      'a 300 KB pack id cannot become a key in .provider-packs-state.json: that write pushed the file past MAX_MANIFEST_BYTES, after which readState ignores the whole file and every manifest and adapter trust decision the operator had recorded is gone',
      { junkRevoke: junkRevoke?.slice(0, 48) ?? null, foldStateSize, diagnostics: afterJunkRevoke.snapshot().diagnostics });
    if (inspected) registry.trustAdapter('orbit.pack', inspected.sha256);
    registry.setEnabled('orbit.pack', true);
    const runtime = registry.runtimeById('orbit-vortex-v9');
    check(runtime?.id === 'orbit-vortex-v9' && runtime.harness === 'generic-cli' && runtime.headless === 'none',
      'enabled dynamic profile compiles to its declared harness and honest headless capability');
    const adapter = registry.trustedAdapterForProfile('orbit-vortex-v9');
    const adapterProfile = registry.profileById('orbit-vortex-v9');
    const proof = adapter && adapterProfile ? await probeProviderAdapter(adapter, adapterProfile) : null;
    check(proof?.capabilities.telemetry === true
      && proof.capabilities.hooks === undefined
      && proof.capabilities.headlessJson === undefined
      && proof.capabilities.namedResume === undefined,
    'trusted adapter cannot invent wiring absent from the harness or frozen headless/resume profile contract');
    let driftRefused = false;
    if (adapter && adapterProfile) {
      try { await probeProviderAdapter({ ...adapter, sha256: '0'.repeat(64) }, adapterProfile); }
      catch { driftRefused = true; }
    }
    check(driftRefused, 'adapter digest is rechecked immediately before every process spawn');
    const hostileValue = 'v9; touch /tmp/wanigan-must-not-exist';
    const argv = runtime?.args(['--tail'], { model: hostileValue, region: 'north' }) ?? [];
    check(argv.includes(hostileValue) && argv.filter((entry) => entry === hostileValue).length === 1,
      'launch field remains one argv value rather than becoming a shell command', JSON.stringify(argv));

    if (runtime) {
      const executable = path.join(tmp, 'absolute-headless-cli');
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(executable, 0o700);
      const def: ProviderDef = {
        ...runtime,
        id: `orbit-headless-${Date.now()}`,
        source: 'local',
        profileFingerprint: `smoke:${manifest.id}:${manifest.version}`,
        bin: executable,
        headless: 'claude-json',
        packVersion: manifest.version,
        backendId: manifest.profiles[0].backend.id,
        declaredCapabilities: runtime.capabilities,
        launchArgs: runtime.args,
      };
      const cfg = {
        name: 'provider pack headless smoke', providerId: def.id, projectIds: ['unused'],
        prompt: 'inspect this repository', providerOptions: { region: 'north' },
        maxBudgetUsd: 1, timeoutMs: 30_000, isolate: false,
      };
      const headlessArgv = headlessArgs(def, cfg, { mode: 'bypassPermissions', clampArgs: [] }, null);
      check(headlessArgv.includes('--region') && headlessArgv.includes('north'),
        'headless compilation includes manifest-defined provider options', JSON.stringify(headlessArgv));
      const claudeLearnedArgv = headlessArgs(
        def, cfg, { mode: 'bypassPermissions', clampArgs: [] }, null, 'task-scoped capsule'
      );
      check(claudeLearnedArgv.some((entry, i) => entry === '--append-system-prompt'
        && claudeLearnedArgv[i + 1] === 'task-scoped capsule'),
      'headless Claude has an invocation-scoped learning fallback when no SessionStart hook is available');
      const codexLearnedArgv = headlessArgs(
        { ...def, harness: 'codex', cli: 'codex', headless: 'codex-json' },
        cfg, { mode: 'bypassPermissions', clampArgs: [] }, null, 'task-scoped capsule'
      );
      check(codexLearnedArgv.includes(`developer_instructions=${JSON.stringify('task-scoped capsule')}`),
        'headless Codex receives its capsule through the official developer_instructions config');
      const missingOption = thrown(() => headlessArgs(
        def, { ...cfg, providerOptions: {} }, { mode: 'bypassPermissions', clampArgs: [] }, null
      ));
      check(!!missingOption && /Region is required/.test(missingOption),
        'headless compilation rejects a missing required provider option before spawn', missingOption);
      const resolvedAbsolute = await resolveBin(def);
      check(resolvedAbsolute === executable,
        'headless resolution accepts an executable absolute command path', resolvedAbsolute);
      const replacementExecutable = path.join(tmp, 'absolute-headless-cli-next');
      fs.writeFileSync(replacementExecutable, '#!/bin/sh\nexit 0\n');
      fs.chmodSync(replacementExecutable, 0o700);
      const resolvedReplacement = await resolveBin({
        ...def,
        bin: replacementExecutable,
        profileFingerprint: `${def.profileFingerprint}:next`,
      });
      check(resolvedReplacement === replacementExecutable,
        'headless binary cache is isolated by frozen profile fingerprint and command', resolvedReplacement);
      const mergedEnv = headlessEnv('/smoke/path', {
        WANIGAN_PROVIDER_ENV_SMOKE: 'from-provider', NO_COLOR: 'provider-tried-to-enable-colour',
      });
      check(mergedEnv.WANIGAN_PROVIDER_ENV_SMOKE === 'from-provider'
        && mergedEnv.NO_COLOR === '1' && mergedEnv.TERM === 'dumb',
      'headless provider environment is merged while JSON-safe terminal controls remain enforced');
      const accountEnv = headlessEnv('/smoke/path', { CLAUDE_CONFIG_DIR: '/pack/chosen' }, { CLAUDE_CONFIG_DIR: '/account/chosen' });
      check(accountEnv.CLAUDE_CONFIG_DIR === '/account/chosen',
        'the account’s config directory is applied after the provider pack, so a manifest cannot redirect a run’s login');
      // The CLI's own statement of each model's window travels out of the
      // result; a zero placeholder and a malformed entry are not windows.
      const reported = parseCliOutput(JSON.stringify({
        type: 'result', total_cost_usd: 0.42, usage: { input_tokens: 10, output_tokens: 5 },
        modelUsage: {
          'claude-opus-5[1m]': { inputTokens: 10, outputTokens: 5, costUSD: 0.42, contextWindow: 1_000_000 },
          'claude-haiku-4-5': { inputTokens: 1, outputTokens: 1, costUSD: 0, contextWindow: 0 },
          'not-a-record': 'nope',
        },
      }));
      check(reported.costUsd === 0.42 && reported.modelUsage.length === 1
        && reported.modelUsage[0].model === 'claude-opus-5[1m]' && reported.modelUsage[0].contextWindow === 1_000_000,
      'a headless result yields the CLI-reported context window per model, dropping zero placeholders and malformed entries', reported);
      check(parseCliOutput('{"type":"result","total_cost_usd":0.1}').modelUsage.length === 0,
        'a result without modelUsage reports no window rather than inventing one');
    }

    const headlessProject = await addProject(projectRoot);
    const frozenRunId = `headless-fingerprint-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const frozenConfig = {
      name: 'stale provider fingerprint smoke',
      providerId: 'claude',
      projectIds: [headlessProject.id],
      prompt: 'must not launch',
      maxBudgetUsd: 1,
      timeoutMs: 30_000,
      isolate: false,
      providerProfileFingerprint: `deliberately-stale-${frozenRunId}`,
    };
    db().prepare(`
      INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind,
                        total_requests, created_at)
      VALUES (?, ?, NULL, NULL, ?, 'in_progress', ?, 'headless', 1, ?)
    `).run(
      frozenRunId,
      frozenConfig.name,
      frozenConfig.providerId,
      JSON.stringify(frozenConfig),
      Date.now(),
    );
    db().prepare(`
      INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status)
      VALUES (?, ?, ?, ?, 'pending')
    `).run(
      frozenRunId,
      headlessProject.id,
      headlessProject.name,
      headlessProject.path,
    );
    await runOneRepo(frozenRunId, headlessProject.id);
    const frozenRow = db().prepare(
      'SELECT status, error FROM headless_rows WHERE run_id=? AND project_id=?'
    ).get(frozenRunId, headlessProject.id) as { status: string; error: string | null } | undefined;
    check(
      frozenRow?.status === 'errored' && /changed after this fan-out was queued/i.test(frozenRow.error ?? ''),
      'queued headless rows refuse a different provider fingerprint before launch',
      frozenRow?.error,
    );

    /* ── a cost of zero is not the same as no cost ────────────────────
     * The Runs screen used to print the sum of both under the words
     * "CLI-reported; never estimated", so a fan-out over a provider that
     * reports nothing read as a free run. cost_usd cannot tell them apart —
     * both are 0 — which is why cost_reported is written beside it. */
    const costRunId = `${frozenRunId}-cost`;
    db().prepare(`
      INSERT INTO runs (id, name, preset, project_id, model, status, config_json, kind,
                        total_requests, created_at)
      VALUES (?, 'cost provenance', NULL, NULL, 'test', 'ended', '{}', 'headless', 3, ?)
    `).run(costRunId, Date.now());
    const seedCostRow = db().prepare(`
      INSERT INTO headless_rows (run_id, project_id, project_name, project_path, status,
                                 cost_usd, cost_reported)
      VALUES (?, ?, ?, '/tmp/x', ?, ?, ?)
    `);
    // Priced at zero, unpriced, and priced — plus a blocked row, which never
    // had an agent to report anything and must not count as a gap.
    seedCostRow.run(costRunId, 'p-free', 'free', 'succeeded', 0, 1);
    seedCostRow.run(costRunId, 'p-silent', 'silent', 'succeeded', 0, 0);
    seedCostRow.run(costRunId, 'p-priced', 'priced', 'succeeded', 0.25, 1);
    seedCostRow.run(costRunId, 'p-blocked', 'blocked', 'blocked', 0, null);
    const costRows = headlessRows(costRunId);
    const byProject = new Map(costRows.map((r) => [r.projectId, r]));
    check(byProject.get('p-free')?.costReported === true
      && byProject.get('p-silent')?.costReported === false
      && byProject.get('p-priced')?.costReported === true,
      'a row that reported $0.00 and a row that reported nothing both store 0 and stay distinguishable');
    const costRun = headlessRuns(50).find((r) => r.id === costRunId);
    check(costRun?.costStatus === 'partial',
      'one silent repository among priced ones makes the run total a floor, not a measurement',
      costRun?.costStatus);
    db().prepare('UPDATE headless_rows SET cost_reported=1 WHERE run_id=? AND project_id=?')
      .run(costRunId, 'p-silent');
    check(headlessRuns(50).find((r) => r.id === costRunId)?.costStatus === 'reported',
      'and once every repository that ran has named a figure, the total is reported outright');
    db().prepare('UPDATE headless_rows SET cost_reported=NULL WHERE run_id=?').run(costRunId);
    check(headlessRuns(50).find((r) => r.id === costRunId)?.costStatus === 'unreported'
      && headlessRows(costRunId).every((r) => r.costReported === null),
      'rows written before the column existed read as unknown, never as reported');
    db().prepare('DELETE FROM headless_rows WHERE run_id=?').run(costRunId);
    db().prepare('DELETE FROM runs WHERE id=?').run(costRunId);

    registry.requestUninstall('orbit.pack', ['orbit-vortex-v9']);
    check(registry.listPacks()[0]?.status === 'pending-removal' && fs.existsSync(packDir),
      'uninstall waits while a frozen session still uses the profile');
    registry.finalizePendingRemovals([]);
    const removed = registry.listPacks({ includeRemoved: true }).find((pack) => pack.id === 'orbit.pack');
    check(removed?.status === 'removed' && removed.recoverable && !fs.existsSync(packDir),
      'inactive pack moves to Wanigan trash as a recoverable removal');
    registry.restore('orbit.pack');
    check(fs.existsSync(packDir) && registry.listPacks()[0]?.status === 'disabled',
      'removed pack can be restored without implicitly launching or enabling it');

    /* ── a picker may only offer what the profile declares ────────────
     * The New session dialog offered Codex the reasoning level 'ultra'
     * because its own static model table listed one; the shipped Codex
     * profile declares low…max and its launch compiler refuses anything
     * else, so the extra pill only ever bought a failed launch.
     * launchFieldChoices is the renderer's half of that rule, and pure,
     * so the offer can be checked here without a window. */
    const { launchFieldChoices, intersectChoices } = await import('../shared/launch-fields');
    const codexShaped = {
      supports: { model: true, effort: true, permissionMode: false, resume: true },
      launchFields: [
        { id: 'model', label: 'Model', kind: 'text' as const },
        {
          id: 'effort', label: 'Reasoning effort', kind: 'select' as const, allowCustom: false,
          options: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value, label: value })),
        },
      ],
    };
    const effortOffer = launchFieldChoices(codexShaped, 'effort');
    check(effortOffer.supported && effortOffer.declared && effortOffer.label === 'Reasoning effort'
      && effortOffer.choices.map((choice) => choice.value).join() === 'low,medium,high,xhigh,max',
      'a launch picker offers exactly the efforts the profile declares, under the profile’s own label',
      effortOffer.choices);
    check(intersectChoices(effortOffer.choices, ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
      .every((choice) => choice.value !== 'ultra'),
      'an effort a CLI catalog reports but the profile never declared is not offered');
    check(intersectChoices(effortOffer.choices, ['low', 'medium']).map((choice) => choice.value).join() === 'low,medium',
      'and a model with a narrower reasoning range narrows the offer to the overlap');
    const legacyShaped = {
      supports: { model: true, effort: true, permissionMode: true, resume: true },
      launchFields: [],
    };
    const legacyEffort = launchFieldChoices(legacyShaped, 'effort');
    const legacyModes = launchFieldChoices(legacyShaped, 'permissionMode');
    check(!legacyEffort.declared && legacyEffort.choices.length === 5 && !legacyModes.declared
      && legacyModes.choices.some((choice) => choice.value === 'bypassPermissions'),
      'a definition that declares no launch fields still falls back to Wanigan’s own lists',
      [legacyEffort.choices.length, legacyModes.choices.length]);
    check(launchFieldChoices({
      supports: { model: false, effort: false, permissionMode: false, resume: false }, launchFields: [],
    }, 'effort').supported === false,
      'and a profile that does not take the field at all reports it unsupported rather than offering a list');
    const openShaped = {
      supports: { model: true, effort: false, permissionMode: false, resume: false },
      launchFields: [{
        id: 'model', label: 'Model', kind: 'select' as const, allowCustom: true, defaultValue: 'orbit-2',
        options: [{ value: 'orbit-1', label: 'Orbit 1' }, { value: 'orbit-2', label: 'Orbit 2' }],
      }],
    };
    const openOffer = launchFieldChoices(openShaped, 'model');
    check(openOffer.custom && openOffer.declared && openOffer.defaultValue === 'orbit-2'
      && openOffer.choices.length === 2 && !effortOffer.custom && effortOffer.defaultValue === '',
      'a select the manifest opened with allowCustom keeps free text and its declared default; a closed one keeps neither',
      openOffer);

    const requiredEffortShaped = {
      supports: { model: false, effort: true, permissionMode: false, resume: false },
      launchFields: [{
        id: 'effort', label: 'Effort', kind: 'select' as const, allowCustom: false, required: true,
        options: [{ value: 'slow', label: 'Slow' }, { value: 'fast', label: 'Fast' }],
      }],
    };
    const requiredEffort = launchFieldChoices(requiredEffortShaped, 'effort');
    check(requiredEffort.required && requiredEffort.declared
      && !requiredEffort.choices.some((choice) => choice.value === ''),
      'a profile that declares its effort required never names the empty value among its choices, so a picker that prepends a "default" row of its own is offering the one value fieldArgs refuses with "Effort is required." — the same defect as an undeclared reasoning level, one field over',
      requiredEffort.choices.map((choice) => choice.value).join());

    const codexManifestProfile = BUILTIN_PROVIDER_PACKS
      .flatMap((pack) => pack.profiles).find((profile) => profile.id === 'codex');
    const codexManifestFields = (codexManifestProfile?.launchFields ?? []).map((field) => field.id);
    check(codexManifestProfile?.harness === 'codex'
      && codexManifestFields.includes('effort') && !codexManifestFields.includes('permissionMode'),
      'the shipped Codex profile declares a reasoning effort and declares no permission mode, which is the pair of facts the dialog’s Codex explainer states — so a manifest edit that adds or drops one of them fails here rather than quietly making that sentence false',
      codexManifestFields.join());

    // Behavioural, on the pure helper, beside legacyShaped.
    // Wanigan's fallback list is five levels deep for ANY profile that
    // declares none, so a picker that guarded its slider on choices.length
    // would draw a five-notch scale for a profile that takes no effort flag.
    // `supported` is the only field that answers the question.
    const glmShaped = {
      supports: { model: true, effort: false, permissionMode: true, resume: true },
      launchFields: [
        { id: 'model', label: 'Model', kind: 'text' as const },
        {
          id: 'permissionMode', label: 'Permission mode', kind: 'select' as const, allowCustom: false,
          options: ['manual', 'acceptEdits'].map((value) => ({ value, label: value })),
        },
      ],
    };
    const glmEffort = launchFieldChoices(glmShaped, 'effort');
    const glmModel = launchFieldChoices(glmShaped, 'model');
    check(glmEffort.supported === false && glmEffort.choices.length === 5
      && glmModel.supported && !glmModel.declared && glmModel.choices.length === 0 && glmModel.custom,
      'a profile shaped like the shipped GLM one — a model field and no effort field — is unsupported for effort while Wanigan’s fallback still hands back five levels, so a running-session bar may only hide its slider on `supported`, and its model field declares nothing of its own and takes whatever the backend catalogue reports',
      { effort: [glmEffort.supported, glmEffort.choices.length], model: [glmModel.declared, glmModel.choices.length] });

    /* ── and the phone makes the same offer, not a second weaker one ─
     * The launch form on the phone used to answer this question for itself:
     * one flat array of efforts per provider, captioned 'Reasoning effort'
     * whoever was launching. So it offered the shipped Codex profile the level
     * only the CLI catalog named, drew a disabled picker for a profile that
     * takes no effort at all, and could not narrow the list when the chosen
     * model accepts fewer. mobile/launch-options.ts is the phone's half of the
     * rule checked above, and pure for the same reason: no spawn, no fetch, so
     * the offer can be driven from the very fixtures the window's half used. */
    const { launchOffer } = await import('./mobile/launch-options');
    const codexCatalog = [
      { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], isDefault: true },
      { value: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium'] },
    ];
    const phoneCodex = launchOffer(codexShaped, codexCatalog);
    // '' is the CLI's own default model, and the efforts it leaves standing are
    // the default model's; the empty value is dropped from the comparison
    // because it is the "pass no flag" row rather than a level.
    const phoneEfforts = (model: string) =>
      (phoneCodex.model.choices.find((choice) => choice.value === model)?.efforts ?? phoneCodex.effort.choices)
        .map((choice) => choice.value).filter(Boolean).join();
    check(phoneCodex.effort.supported && phoneCodex.effort.label === 'Reasoning effort'
      && phoneEfforts('') === 'low,medium,high,xhigh,max',
      'the phone offers exactly the efforts the Codex profile declares, under the profile’s own label, with the level only the CLI catalog named dropped',
      phoneCodex.effort.choices);
    check(phoneEfforts('gpt-5.5') === intersectChoices(
      launchFieldChoices(codexShaped, 'effort').choices, ['low', 'medium'],
    ).map((choice) => choice.value).join(),
      'and a model with a narrower reasoning range narrows the phone to exactly the list the window computes for the same profile',
      phoneEfforts('gpt-5.5'));
    const phoneLegacy = launchOffer(legacyShaped, []);
    check(phoneLegacy.effort.supported && !phoneLegacy.effort.open
      && phoneLegacy.effort.choices.filter((choice) => choice.value).length === 5,
      'a definition that declares no launch fields falls back to Wanigan’s own effort list on the phone too, rather than to an empty picker',
      phoneLegacy.effort.choices);
    const phoneOpen = launchOffer(openShaped, []);
    check(phoneOpen.model.open && phoneOpen.model.defaultValue === 'orbit-2'
      && phoneOpen.model.choices.length === 2
      && !phoneOpen.effort.supported && phoneOpen.effort.choices.length === 0,
      'a select the manifest opened with allowCustom keeps free text on the phone, and a field the profile does not take is offered no choices at all',
      phoneOpen.model);
  } catch (error) {
    check(false, `provider pack suite threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
