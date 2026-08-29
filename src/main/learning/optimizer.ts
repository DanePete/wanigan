import { db } from '../db';
import { listKnowledgeItems, listRelations } from './repository';
import type { OptimizerDiagnostic } from './types';
import { estimateTokens, sha256 } from './util';

export { estimateTokens } from './util';

export interface OptimizerOptions {
  projectId?: string | null;
  now?: number;
  weakEvidenceBelow?: number;
  oversizedTokens?: number;
  unusedDays?: number;
}

/** Deterministic diagnostics only; semantic consolidation remains a candidate. */
export function diagnoseKnowledge(options: OptimizerOptions = {}): OptimizerDiagnostic[] {
  const now = options.now ?? Date.now();
  const weakBelow = Math.max(1, options.weakEvidenceBelow ?? 2);
  const oversized = Math.max(100, options.oversizedTokens ?? 1_000);
  const unusedBefore = now - Math.max(1, options.unusedDays ?? 45) * 86_400_000;
  const items = options.projectId === undefined
    ? listKnowledgeItems({ statuses: ['active'], limit: 1_000 })
    : [
        ...listKnowledgeItems({ projectId: options.projectId, statuses: ['active'], limit: 1_000 }),
        ...listKnowledgeItems({ scope: 'personal', statuses: ['active'], limit: 1_000 }),
      ].filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index);
  const out: OptimizerDiagnostic[] = [];

  const duplicateGroups = new Map<string, typeof items>();
  for (const item of items) duplicateGroups.set(item.contentHash, [...(duplicateGroups.get(item.contentHash) ?? []), item]);
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    const extraTokens = group.slice(1).reduce((n, item) => n + estimateTokens(item.canonicalText), 0);
    out.push({
      kind: 'duplicate', severity: 'warning', itemIds: group.map((item) => item.id),
      title: 'Duplicate knowledge',
      detail: `${group.length} active artifacts contain identical canonical text. Keep one scoped source of truth.`,
      estimatedTokenDelta: -extraTokens,
    });
  }

  for (const relation of listRelations(undefined, true)) {
    if (relation.relation !== 'contradicts') continue;
    if (!items.some((item) => item.id === relation.fromItemId || item.id === relation.toItemId)) continue;
    out.push({
      kind: 'contradiction', severity: 'error', itemIds: [relation.fromItemId, relation.toItemId],
      title: 'Unresolved contradiction', detail: 'Conflicting artifacts must be resolved before either is retrieved.',
      estimatedTokenDelta: 0,
    });
  }

  const useStmt = db().prepare(`
    SELECT COUNT(*) AS n,MAX(at) AS last_at FROM artifact_metrics
    WHERE item_id=? AND metric IN ('invocation','use_success','use_failure')
  `);
  for (const item of items) {
    const tokens = estimateTokens(item.canonicalText);
    if (item.expiresAt != null && item.expiresAt <= now) {
      out.push({
        kind: 'expired', severity: 'warning', itemIds: [item.id], title: `Expired: ${item.title}`,
        detail: 'Revalidate or retire this artifact before it is used again.', estimatedTokenDelta: -tokens,
      });
    }
    if (item.sourceCount < weakBelow) {
      out.push({
        kind: 'weak-evidence', severity: 'info', itemIds: [item.id], title: `Weak evidence: ${item.title}`,
        detail: `${item.sourceCount} independent source(s); ${weakBelow} are expected before automatic personal recall.`,
        estimatedTokenDelta: 0,
      });
    }
    if (tokens > oversized && (item.kind === 'instruction' || item.kind === 'rule' || item.kind === 'memory')) {
      out.push({
        kind: 'oversized', severity: 'warning', itemIds: [item.id], title: `Large always-available artifact: ${item.title}`,
        detail: `About ${tokens.toLocaleString()} tokens. Split references or move ordered procedures into a lazy-loaded skill.`,
        estimatedTokenDelta: -Math.floor(tokens * 0.65),
      });
    }
    if ((item.kind === 'instruction' || item.kind === 'rule') && looksProcedural(item.canonicalText)) {
      out.push({
        kind: 'demote-to-skill', severity: 'info', itemIds: [item.id], title: `Procedure loaded as a rule: ${item.title}`,
        detail: 'This reads like an ordered workflow. A skill keeps the steps out of startup context until triggered.',
        estimatedTokenDelta: -Math.max(1, Math.floor(tokens * 0.8)),
      });
    }
    const use = useStmt.get(item.id) as { n: number; last_at: number | null };
    if (item.createdAt < unusedBefore && (!use.n || (use.last_at ?? 0) < unusedBefore)) {
      out.push({
        kind: 'unused', severity: 'info', itemIds: [item.id], title: `Unused knowledge: ${item.title}`,
        detail: `No observed use in the last ${options.unusedDays ?? 45} days. Propose retirement or narrower routing.`,
        estimatedTokenDelta: -tokens,
      });
    }
  }

  const drift = db().prepare(`
    SELECT id,item_id,target_path FROM knowledge_projections WHERE status='stale'
      ${options.projectId !== undefined ? 'AND project_id IS ?' : ''}
    ORDER BY created_at DESC LIMIT 200
  `).all(...(options.projectId !== undefined ? [options.projectId] : [])) as { id: string; item_id: string | null; target_path: string }[];
  for (const projection of drift) {
    out.push({
      kind: 'projection-drift', severity: 'warning', itemIds: projection.item_id ? [projection.item_id] : [],
      title: 'Projection changed after preview', detail: `${projection.target_path} must be recompiled before apply or undo.`,
      estimatedTokenDelta: 0,
    });
  }
  return out;
}

function looksProcedural(text: string): boolean {
  const ordered = text.match(/^\s*(?:\d+[.)]|[-*]\s+(?:run|open|check|create|update|verify|then)\b)/gim)?.length ?? 0;
  return ordered >= 3 || /\b(first|then|next|finally)\b[\s\S]{0,300}\b(then|next|finally)\b/i.test(text);
}

export interface ContextBlock {
  id: string;
  text: string;
  stable?: boolean;
}

/** Cache-prefix warnings are evidence, not provider-specific cache claims. */
export function diagnoseCacheShape(blocks: ContextBlock[]): OptimizerDiagnostic[] {
  const out: OptimizerDiagnostic[] = [];
  const byHash = new Map<string, string[]>();
  const volatile = /\b(?:20\d{2}-\d{2}-\d{2}(?:[T ][0-9:.+-Z]+)?|[0-9a-f]{8}-[0-9a-f-]{27,}|(?:session|request|run)[-_ ]?id\s*[:=]\s*\S+|\d{13})\b/i;
  for (const block of blocks) {
    const hash = sha256(block.text);
    byHash.set(hash, [...(byHash.get(hash) ?? []), block.id]);
    if (block.stable !== false && volatile.test(block.text)) {
      out.push({
        kind: 'volatile-prefix', severity: 'warning', itemIds: [block.id], title: 'Volatile value in a stable context block',
        detail: 'Move dates, generated ids, and session-specific values after stable instructions to preserve cacheable prefixes.',
        estimatedTokenDelta: 0,
      });
    }
  }
  for (const ids of byHash.values()) {
    if (ids.length < 2) continue;
    const first = blocks.find((block) => block.id === ids[0]);
    out.push({
      kind: 'repeated-prefix', severity: 'info', itemIds: ids, title: 'Repeated context block',
      detail: `${ids.length} blocks are byte-identical and can share one source.`,
      estimatedTokenDelta: -(ids.length - 1) * estimateTokens(first?.text ?? ''),
    });
  }
  return out;
}

export function contextBudget(items: { text: string; lazy?: boolean }[]): {
  alwaysLoadedTokens: number; lazyTokens: number; totalTokens: number;
} {
  let alwaysLoadedTokens = 0;
  let lazyTokens = 0;
  for (const item of items) {
    if (item.lazy) lazyTokens += estimateTokens(item.text);
    else alwaysLoadedTokens += estimateTokens(item.text);
  }
  return { alwaysLoadedTokens, lazyTokens, totalTokens: alwaysLoadedTokens + lazyTokens };
}
