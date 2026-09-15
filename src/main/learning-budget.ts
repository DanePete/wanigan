import { app } from 'electron';
import path from 'node:path';
import { CODEX_ARTIFACT_COMPILER, compileCandidate, getCandidate } from './learning';
import { providerById } from './providers';
import { projectById } from './store';
import { codexHomeForProject, codexSkillRows, contextWindowFor, listingsFor, projectRootFor, readCodexConfig } from './context/codex-loader';
import { estimateTokens } from '../shared/tokens';
import {
  byteLength, codexSkillBudget, managedBlockEnd, projectionBudgetCheck, searchDirectories, skillListingLine,
  CODEX_BUDGET_WARN_SHARE,
} from '../shared/codex-loader';
import type { ProjectionBudgetView } from '../shared/cost-types';

/**
 * Codex's budgets, asked before the learning engine writes into them.
 *
 * A rule projected into AGENTS.md past `project_doc_max_bytes` is a rule the
 * operator approved and no Codex session ever reads — and nothing on screen
 * would say so. So the apply path refuses it with the byte it would have landed
 * at, and the review inbox shows the same verdict before anyone presses Apply.
 *
 * Skills are different in kind: Codex still lists every skill when the listing
 * is over budget, it shortens descriptions. That is a warning, never a refusal.
 */

export type ProjectionBudget = ProjectionBudgetView;

export function projectionBudgetFor(candidateId: string, providerId: string): ProjectionBudget {
  const runtime = providerById(providerId);
  if (!runtime || runtime.harness !== 'codex') return { applies: false, reason: 'Only Codex targets carry an AGENTS.md or skills budget.' };
  const candidate = getCandidate(candidateId);
  if (!candidate) throw new Error('Learning candidate not found.');
  const project = candidate.projectId ? projectById(candidate.projectId) : undefined;
  if (candidate.scope !== 'personal' && !project) return { applies: false, reason: 'The candidate’s project is no longer available.' };
  const compiled = compileCandidate(candidateId, CODEX_ARTIFACT_COMPILER, {
    providerId, projectRoot: project?.path ?? null, homeDir: app.getPath('home'),
  });
  if (!compiled.supported || compiled.mode !== 'file' || !compiled.targetPath || compiled.proposedContent == null) {
    return { applies: false, reason: compiled.reason };
  }
  return budgetForCompiled({
    projectId: candidate.projectId,
    targetPath: compiled.targetPath,
    targetFormat: compiled.targetFormat,
    proposedContent: compiled.proposedContent,
    homeDir: app.getPath('home'),
  });
}

export function budgetForCompiled(input: {
  projectId: string | null; targetPath: string; targetFormat: string | null; proposedContent: string; homeDir: string;
  /** A Codex home the caller already resolved; otherwise the one a launch in the project would use. */
  codexHome?: string;
}): ProjectionBudget {
  const home = input.codexHome ? { dir: input.codexHome } : codexHomeForProject(input.projectId);
  const config = readCodexConfig(home.dir);
  const target = path.resolve(input.targetPath);

  if (input.targetFormat === 'codex-agents') {
    // The personal file is the user's instructions: joined in front of the
    // project docs, and not what project_doc_max_bytes measures.
    if (path.dirname(target) === path.resolve(home.dir) || target.startsWith(path.join(input.homeDir, '.codex') + path.sep)) {
      return { applies: true, target, kind: 'user-instructions', verdict: 'ok', share: 0, reason: null };
    }
    const dir = path.dirname(target);
    const root = projectRootFor(dir, config.rootMarkers);
    const listings = listingsFor(searchDirectories(dir, root, path.sep), config.fallbacks);
    const bytes = byteLength(input.proposedContent);
    const verdict = projectionBudgetCheck({
      listings, fallbacks: config.fallbacks, maxBytes: config.maxBytes,
      targetPath: target, targetDir: dir, targetName: path.basename(target),
      proposedBytes: bytes, blockEnd: managedBlockEnd(input.proposedContent) ?? bytes,
    });
    return { applies: true, target, kind: 'agents-md', ...verdict };
  }

  if (input.targetFormat === 'agent-skill') {
    const rows = codexSkillRows(input.projectId, home.dir).filter((row) => path.resolve(row.path) !== target);
    const description = /^description:\s*(.*)$/m.exec(input.proposedContent)?.[1]?.replace(/^["']|["']$/g, '') ?? '';
    const name = /^name:\s*(.*)$/m.exec(input.proposedContent)?.[1]?.trim() ?? path.basename(path.dirname(target));
    const added = estimateTokens(skillListingLine({ name, description, path: target }));
    const tokens = rows.reduce((sum, row) => sum + row.estTokens, 0) + added;
    const window = config.contextWindowOverride ?? contextWindowFor(home.dir, config.model).tokens;
    const budget = codexSkillBudget({ explicit: config.skillsMaxTokens, contextWindow: window });
    if (budget.status === 'unknown') {
      return { applies: true, target, kind: 'skill', verdict: 'ok', share: 0, reason: null };
    }
    const share = budget.tokens > 0 ? tokens / budget.tokens : 0;
    if (share > 1) {
      return {
        applies: true, target, kind: 'skill', verdict: 'warn', share,
        reason: `With this skill the Codex skills listing is ~${tokens.toLocaleString('en-US')} tokens (estimate) against a ` +
          `${budget.tokens.toLocaleString('en-US')}-token budget, so Codex will shorten skill descriptions to fit. Every skill stays listed.`,
      };
    }
    if (share > CODEX_BUDGET_WARN_SHARE) {
      return {
        applies: true, target, kind: 'skill', verdict: 'warn', share,
        reason: `With this skill the Codex skills listing is ~${Math.round(share * 100)}% of its ${budget.tokens.toLocaleString('en-US')}-token budget (estimate).`,
      };
    }
    return { applies: true, target, kind: 'skill', verdict: 'ok', share, reason: null };
  }

  return { applies: false, reason: 'This projection does not write into a Codex budget.' };
}
