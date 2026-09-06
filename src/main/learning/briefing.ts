import fs from 'node:fs';
import path from 'node:path';
import { INJECTABLE_KINDS, STANDING_KINDS } from '../../shared/types';
import { checkItemFreshness } from './staleness';
import { listEvidence, searchKnowledge } from './repository';
import type {
  ArtifactScope, BriefingEntry, BriefingInput, KnowledgeBriefing, KnowledgeKind, KnowledgeSearchResult,
} from './types';
import { estimateTokens } from './util';

/**
 * Only these kinds are instructions a session can act on. An 'eval' is
 * regression evidence and a 'project-map' is topology; a 'skill' compiles to
 * its own provider file and a 'gate' compiles to a Wanigan policy/review gate.
 * None of them are sentences for a system prompt. Every kind stays retrievable
 * in the app; a caller may narrow this set but never widen it.
 *
 * The lists live in shared/types so the Knowledge view labels each row from
 * the same definition the injector reads; they are re-exported here for the
 * main-process callers that always imported them from the learning module.
 */
export { INJECTABLE_KINDS, STANDING_KINDS };

/**
 * The header is a short frame, not a blessing. The old literal called every
 * line "verified context", which claimed too much: [memory] can be
 * auto-promoted from repeated observation (classifier.ts), so only
 * [mission]/[instruction]/[rule] are approved instructions; and `wanigan:<id>`
 * is a provenance tag with no agent-facing resolver, which an agent otherwise
 * reads as a tool or a file to open. Each clause is emitted only when a line
 * of that kind is present, and the whole frame is costed against the budget
 * at its longest before any entry is admitted, so the estimate can only run
 * high. Kept terse on purpose: at the 64-token floor it must leave room for
 * one entry.
 */
const FRAME_LEAD = 'Wanigan context.';
const FRAME_PROVENANCE = 'wanigan:<id> is a provenance tag, not a tool or file.';
const APPROVED_KINDS: readonly KnowledgeKind[] = ['mission', 'instruction', 'rule'];

export function briefingFrame(kinds: readonly KnowledgeKind[]): string {
  const present = new Set(kinds);
  const clauses: string[] = [FRAME_LEAD];
  const approved = APPROVED_KINDS.filter((kind) => present.has(kind));
  if (approved.length) clauses.push(`${approved.map((kind) => `[${kind}]`).join(' ')}: approved instructions.`);
  if (present.has('memory')) clauses.push('[memory]: recorded observations, citations re-hashed at launch.');
  clauses.push(FRAME_PROVENANCE);
  return `${clauses.join(' ')}\n`;
}

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
  // A hint that cannot be verified against the working tree would silently
  // filter out path-scoped knowledge, so no project root means no hint.
  if (!projectRoot) return null;
  const root = projectRoot.replace(/\/$/, '');
  // Strip URLs before matching: the term pattern cannot match ':', so a
  // scheme test on a matched term could never fire.
  const stripped = query.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ');
  const matches = stripped.match(/(?:\.\.?\/)?[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@*?-]+)+/g) ?? [];
  for (const raw of matches.slice(0, 20)) {
    if (raw.includes('..')) continue;
    const normalized = raw.replace(/^\.\//, '').replace(/[),.;:'"`]+$/, '');
    if (!normalized || normalized.length > 1_000) continue;
    const relative = normalized.startsWith(root + '/')
      ? normalized.slice(root.length + 1)
      : normalized.startsWith('/') ? null : normalized;
    if (!relative) continue;
    // Only slash-joined text that names a real file or directory is a path;
    // 'I/O', 'and/or', or a date must not displace path-scoped knowledge.
    if (fs.existsSync(path.join(root, relative))) return relative;
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

/**
 * A candidate that was never synthesized into a claim. Consolidation that
 * copies a summary into both the title and the proposed text, or files a bare
 * path as knowledge, produces a row that looks canonical and says nothing.
 * Injecting it spends tokens and teaches noise, so retrieval refuses it and
 * says why rather than quietly ranking it low.
 */
function isUnsynthesized(title: string, text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (trimmed === title.trim()) return true;
  // A locator is not an instruction: rooted at a POSIX root, a home shortcut,
  // a Windows drive or a UNC share, and containing no whitespace at all.
  return /^(?:\/|~\/|[A-Za-z]:[\\/]|\\\\)\S*$/.test(trimmed);
}

/** A modest, deliberate boost — never a lexicographic sort key. */
const SCOPE_BOOST: Record<ArtifactScope, number> = { path: 10, project: 6, personal: 0 };

/**
 * Rank on the same 0-100 band for every term, so lexical relevance can
 * actually decide the order.
 *
 * FTS5 bm25 is lower-is-better and unbounded-negative, so `-rank` grows with
 * match quality; `s / (s + 4)` maps that onto 0-100 without inventing a
 * ceiling (a rank of -4 scores 50, -20 scores ~83). Confidence is already
 * 0-1 and scales to the same band. The weights are an ordering choice, not a
 * measurement: they are never shown to a user and never stored as a score.
 */
function priority(result: KnowledgeSearchResult): number {
  const strength = Math.max(0, -result.rank);
  const relevance = 100 * (strength / (strength + 4));
  // A stored scope outside the union is corrupt data, not a reason to sort by NaN.
  return relevance * 0.55 + result.item.confidence * 100 * 0.35 + (SCOPE_BOOST[result.item.scope] ?? 0);
}

/** Exported so a caller that did not run retrieval (learning switched off) can still return the full shape. */
export function emptyBriefing(queryProvided: boolean): KnowledgeBriefing {
  return {
    text: '', entries: [], estimatedTokens: 0, omitted: 0, omittedStale: 0,
    omittedBudget: 0, omittedUnsynthesized: 0, omittedUnverified: 0, queryProvided,
  };
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
  const queryProvided = !!retrievalQuery || !!scopedPath;
  // The caller may only narrow the injectable set. An empty intersection means
  // the caller asked exclusively for kinds this boundary never injects, which
  // is an empty briefing rather than an unfiltered one.
  const kinds = (input.kinds?.length ? input.kinds : INJECTABLE_KINDS)
    .filter((kind) => INJECTABLE_KINDS.includes(kind));
  if (!kinds.length) return emptyBriefing(queryProvided);
  let candidates = searchKnowledge({
    query: retrievalQuery,
    match: 'any',
    projectId: input.projectId,
    path: scopedPath,
    kinds: [...kinds],
    statuses: ['active'],
    limit: 100,
  }).filter((candidate) => providerCompatible(candidate, input.providerId, input.backendId))
    .sort((a, b) => priority(b) - priority(a));
  if (!queryProvided) {
    // With nothing to be relevant to, ranking is meaningless and the old
    // fallback dumped every project- and path-scoped item under a "verified"
    // header. A prompt-less launch gets explicitly standing artifacts only.
    candidates = candidates.filter((candidate) => STANDING_KINDS.includes(candidate.item.kind));
  }

  const entries: BriefingEntry[] = [];
  // Costed at its longest for this launch: the rendered frame names only the
  // kinds that shipped, a subset of the kinds ranked here, so the final
  // estimate is at most what was reserved. Ranked kinds rather than every
  // injectable kind, or a memory-only store would pay for clauses about
  // instructions it does not hold.
  let used = estimateTokens(briefingFrame(candidates.map((candidate) => candidate.item.kind)));
  // "Held because a citation went stale", "cut by the token ceiling", "never
  // synthesized into a claim" and "ran out of freshness checks" are four
  // different failures with four different fixes; one shared counter made all
  // of them invisible.
  let omittedStale = 0;
  let omittedBudget = 0;
  let omittedUnsynthesized = 0;
  let omittedUnverified = 0;
  // Launch latency must be bounded by what can actually ship, not by store
  // size: cost each candidate first, verify only the ones that fit, and stop
  // once the budget cannot hold another entry or the check quota is spent.
  const minUsefulTokens = 24;
  const maxFreshnessChecks = 25;
  let freshnessChecks = 0;
  for (let index = 0; index < candidates.length; index++) {
    const remaining = candidates.length - index;
    if (maxTokens - used < minUsefulTokens) { omittedBudget += remaining; break; }
    if (freshnessChecks >= maxFreshnessChecks) { omittedUnverified += remaining; break; }
    const candidate = candidates[index];
    const claim = candidate.item.canonicalText.trim();
    if (isUnsynthesized(candidate.item.title, claim)) { omittedUnsynthesized++; continue; }
    // Cost the entry without its citations first: evidence must never be
    // loaded for an entry that cannot fit even at its smallest.
    const bare = `- [${candidate.item.kind}] ${candidate.item.title}: ${claim} (wanigan:${candidate.item.id})`;
    if (used + estimateTokens(bare) > maxTokens) { omittedBudget++; continue; }
    const citations = listEvidence({ itemId: candidate.item.id })
      .map((e) => e.citation).filter(Boolean).slice(0, 3);
    const rendered = `- [${candidate.item.kind}] ${candidate.item.title}: ${claim} `
      + `(wanigan:${candidate.item.id}${citations.length ? `; ${citations.join('; ')}` : ''})`;
    const tokens = estimateTokens(rendered);
    if (used + tokens > maxTokens) { omittedBudget++; continue; }
    freshnessChecks++;
    const freshness = await checkItemFreshness(candidate.item.id, {
      projectRoot: input.projectRoot,
      allowedRoots: input.allowedEvidenceRoots,
      // A launch is the last safe moment to pull a stale fact out of
      // circulation; a preview passes quarantineStale=false because a read
      // must never mutate what it inspects.
      quarantine: input.quarantineStale ?? true,
    });
    if (!freshness.fresh) { omittedStale++; continue; }
    entries.push({
      itemId: candidate.item.id,
      versionId: candidate.version?.id ?? null,
      kind: candidate.item.kind,
      title: candidate.item.title,
      text: candidate.item.canonicalText,
      citations,
      estimatedTokens: tokens,
      // A clean pass over zero checkable citations is not a verification; the
      // ledger must be able to say "N re-hashed, M carried with nothing
      // checkable" per entry, so both counts travel with it.
      checked: freshness.checked,
      skipped: freshness.skipped,
    });
    used += tokens;
  }

  const text = entries.length
    ? `${briefingFrame(entries.map((entry) => entry.kind))}${entries.map((entry) => {
        const citations = entry.citations.length ? `; ${entry.citations.join('; ')}` : '';
        return `- [${entry.kind}] ${entry.title}: ${entry.text.trim()} (wanigan:${entry.itemId}${citations})`;
      }).join('\n')}`
    : '';
  return {
    text, entries, estimatedTokens: estimateTokens(text),
    omitted: omittedStale + omittedBudget + omittedUnsynthesized + omittedUnverified,
    omittedStale, omittedBudget, omittedUnsynthesized, omittedUnverified, queryProvided,
  };
}
