import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db } from './db';
import { addProject } from './store';
import {
  REQUIRED_LEARNING_TABLES,
  CLAUDE_ARTIFACT_COMPILER,
  CODEX_ARTIFACT_COMPILER,
  addEvidence,
  applyProjection,
  automationDecision,
  buildBriefing,
  compileCandidate,
  compileCandidateProjection,
  completeExperiment,
  createCandidate,
  createExperiment,
  doctorSkill,
  forgeSkill,
  getSignal,
  getKnowledgeItem,
  getProjection,
  listEvidence,
  listSignals,
  promoteCandidate,
  recordMetric,
  recordSignal,
  reviewCandidate,
  searchKnowledge,
  semanticExtractionEligibility,
  startExperiment,
  summarizeArtifactRoi,
  undoProjection,
  validateProjection,
} from './learning';
import {
  ProviderPackRegistry,
  validateProviderPackManifest,
  type ProviderPackManifest,
} from './provider-packs';
import { probeProviderAdapter } from './provider-adapter';
import { headlessArgs, headlessEnv, resolveBin, runOneRepo } from './headless';
import { effectiveProviderBackendId, type ProviderDef } from './providers';
import type { Session } from '../shared/types';
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

    recordMetric({ itemId: promotedSkill.item.id, versionId: promotedSkill.version.id,
      providerId: 'codex', metric: 'tokens_saved', value: 211, evidenceLevel: 'causal' });
    recordMetric({ itemId: promotedSkill.item.id, versionId: promotedSkill.version.id,
      providerId: 'codex', metric: 'tokens_loaded', value: 37, evidenceLevel: 'causal' });
    recordMetric({ itemId: promotedSkill.item.id, versionId: promotedSkill.version.id,
      providerId: 'codex', metric: 'use_success', value: 1, evidenceLevel: 'causal' });
    const causalRoi = summarizeArtifactRoi(promotedSkill.item.id);
    check(causalRoi.evidenceLevel === 'causal' && causalRoi.tokensSaved === 211 && causalRoi.samples === 3,
      'A/B-attributed metrics report causal savings', JSON.stringify(causalRoi));
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
  } catch (error) {
    check(false, `provider pack suite threw: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
