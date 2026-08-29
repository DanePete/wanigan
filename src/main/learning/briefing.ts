import { checkItemFreshness } from './staleness';
import { listEvidence, searchKnowledge } from './repository';
import type { BriefingEntry, BriefingInput, KnowledgeBriefing, KnowledgeSearchResult } from './types';
import { estimateTokens } from './util';

const TASK_STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'and', 'before', 'build', 'can', 'change',
  'code', 'continue', 'do', 'for', 'from', 'have', 'help', 'into', 'just', 'make',
  'need', 'please', 'project', 'that', 'the', 'then', 'this', 'use', 'want', 'with',
]);

function taskRetrievalQuery(query: string): string {
  const terms = query.normalize('NFKC').match(/[\p{L}\p{N}_./-]+/gu) ?? [];
  const useful = terms.filter((term) => term.length >= 3 && !TASK_STOP_WORDS.has(term.toLowerCase()));
  return [...new Set(useful)].slice(0, 12).join(' ');
}

/** Extract one conservative project-relative path hint from a task prompt. */
export function inferBriefingPath(query: string, projectRoot?: string | null): string | null {
  const matches = query.match(/(?:\.\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*?-]+)+/g) ?? [];
  for (const raw of matches.slice(0, 20)) {
    if (/^[a-z]+:\/\//i.test(raw) || raw.includes('..')) continue;
    const normalized = raw.replace(/^\.\//, '').replace(/[),.;:'"`]+$/, '');
    if (!normalized || normalized.length > 1_000) continue;
    if (projectRoot && normalized.startsWith(projectRoot.replace(/\/$/, '') + '/')) {
      return normalized.slice(projectRoot.replace(/\/$/, '').length + 1);
    }
    if (!normalized.startsWith('/')) return normalized;
  }
  return null;
}

function providerCompatible(result: KnowledgeSearchResult, providerId: string, backendId?: string | null): boolean {
  const metadata = result.version?.metadata ?? {};
  const denied = Array.isArray(metadata.unsupportedProviderIds)
    ? metadata.unsupportedProviderIds.filter((v): v is string => typeof v === 'string') : [];
  if (denied.includes(providerId)) return false;
  const deniedBackends = Array.isArray(metadata.unsupportedBackendIds)
    ? metadata.unsupportedBackendIds.filter((v): v is string => typeof v === 'string') : [];
  if (backendId && deniedBackends.includes(backendId)) return false;
  const allowedBackends = Array.isArray(metadata.backendIds)
    ? metadata.backendIds.filter((v): v is string => typeof v === 'string') : [];
  if (allowedBackends.length) return !!backendId && allowedBackends.includes(backendId);
  const allowed = Array.isArray(metadata.providerIds)
    ? metadata.providerIds.filter((v): v is string => typeof v === 'string') : [];
  return !allowed.length || allowed.includes(providerId);
}

function priority(result: KnowledgeSearchResult): number {
  const scope = result.item.scope === 'path' ? 3 : result.item.scope === 'project' ? 2 : 1;
  // FTS bm25 is lower-is-better and commonly negative; confidence and scope
  // are deliberately stronger than tiny rank differences.
  return scope * 100 + result.item.confidence * 50 - result.rank;
}

/**
 * Returns a bounded, verified capsule. It references canonical items rather
 * than copying past transcripts, so a fresh session pays only for relevant
 * conclusions and their compact citations.
 */
export async function buildBriefing(input: BriefingInput): Promise<KnowledgeBriefing> {
  const maxTokens = Math.max(64, Math.min(8_000, input.maxTokens ?? 1_200));
  const scopedPath = input.path ?? inferBriefingPath(input.query, input.projectRoot);
  const retrievalQuery = taskRetrievalQuery(input.query);
  const candidates = searchKnowledge({
    query: retrievalQuery,
    match: 'any',
    projectId: input.projectId,
    path: scopedPath,
    kinds: input.kinds,
    statuses: ['active'],
    limit: 100,
  }).filter((candidate) => providerCompatible(candidate, input.providerId, input.backendId))
    .sort((a, b) => priority(b) - priority(a));

  const entries: BriefingEntry[] = [];
  let used = estimateTokens('Wanigan verified context:\n');
  let omitted = 0;
  for (const candidate of candidates) {
    const freshness = await checkItemFreshness(candidate.item.id, {
      projectRoot: input.projectRoot,
      allowedRoots: input.allowedEvidenceRoots,
      // Retrieval is the last safe moment to validate citations. A stale fact
      // is quarantined before it can enter another provider's context; it stays
      // visible in Knowledge for repair and audit instead of vanishing.
      quarantine: true,
    });
    if (!freshness.fresh) { omitted++; continue; }
    const citations = listEvidence({ itemId: candidate.item.id })
      .map((e) => e.citation).filter(Boolean).slice(0, 3);
    const rendered = `- [${candidate.item.kind}] ${candidate.item.title}: ${candidate.item.canonicalText.trim()} `
      + `(wanigan:${candidate.item.id}${citations.length ? `; ${citations.join('; ')}` : ''})`;
    const tokens = estimateTokens(rendered);
    if (used + tokens > maxTokens) { omitted++; continue; }
    entries.push({
      itemId: candidate.item.id,
      versionId: candidate.version?.id ?? null,
      kind: candidate.item.kind,
      title: candidate.item.title,
      text: candidate.item.canonicalText,
      citations,
      estimatedTokens: tokens,
    });
    used += tokens;
  }

  const text = entries.length
    ? `Wanigan verified context:\n${entries.map((entry) => {
        const citations = entry.citations.length ? `; ${entry.citations.join('; ')}` : '';
        return `- [${entry.kind}] ${entry.title}: ${entry.text.trim()} (wanigan:${entry.itemId}${citations})`;
      }).join('\n')}`
    : '';
  return { text, entries, estimatedTokens: estimateTokens(text), omitted };
}
