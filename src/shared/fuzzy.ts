// Quick open's matcher: the letters typed, in order, anywhere in a path, with
// the file's own name, the start of a folder or a word, and runs of letters
// together counting most. `hero tw` matches web/themes/acme/templates/hero.html.twig.
// Pure and bounded, so it is tested and runs on every key over tens of
// thousands of paths.

export interface FuzzyHit {
  path: string;
  score: number;
  /** Indexes into `path` of the letters that matched, for bolding them. */
  positions: number[];
}

/** What was typed: the words to find, and a line to go to (`hero.twig:12`). */
export function parseQuery(raw: string): { terms: string[]; line: number | null } {
  const m = /^(.*?)(?::(\d+))?\s*$/.exec(raw.trim());
  const text = (m?.[1] ?? '').toLowerCase();
  return { terms: text.split(/\s+/).filter(Boolean), line: m?.[2] ? Number(m[2]) : null };
}

const BOUNDARY = /[/\\._\- ]/;

const isStart = (lower: string, original: string, j: number): boolean =>
  j === 0 || BOUNDARY.test(lower[j - 1] as string) || (original[j] !== lower[j] && original[j - 1] === lower[j - 1]);

/** A term's letters in `lower`, the first at `first` and each next one at its first place after. */
function greedy(lower: string, original: string, term: string, first: number): { positions: number[]; score: number } | null {
  const positions = [first];
  for (let k = 1, i = first + 1; k < term.length; k++) {
    const found = lower.indexOf(term[k] as string, i);
    if (found < 0) return null;
    positions.push(found);
    i = found + 1;
  }
  let score = 0;
  for (let k = 0; k < positions.length; k++) {
    const p = positions[k] as number;
    score += 1;
    if (p === 0 || lower[p - 1] === '/') score += 8;
    else if (BOUNDARY.test(lower[p - 1] as string)) score += 5;
    else if (isStart(lower, original, p)) score += 4;
    if (k > 0 && positions[k - 1] === p - 1) score += 4;
  }
  return { positions, score };
}

/**
 * One term in `lower`: tried from each of the first few places its first
 * letter starts a word (and from its first place at all), keeping the best.
 */
function matchTerm(lower: string, original: string, term: string): { positions: number[]; score: number } | null {
  const first = term[0] as string;
  const at = lower.indexOf(first);
  // From the first place it fits at all, or not at all: a later start has fewer letters after it.
  let best = at < 0 ? null : greedy(lower, original, term, at);
  if (!best) return null;
  for (let j = lower.indexOf(first, at + 1), tries = 0; j >= 0 && tries < 10; j = lower.indexOf(first, j + 1)) {
    if (!isStart(lower, original, j)) continue;
    tries++;
    const m = greedy(lower, original, term, j);
    if (!m) break;
    if (m.score > best.score) best = m;
  }
  return best;
}

/** How well a path matches every term, or null when one is missing. */
export function fuzzyScore(path: string, terms: readonly string[]): FuzzyHit | null {
  if (!terms.length) return { path, score: 0, positions: [] };
  const lower = path.toLowerCase();
  const nameAt = lower.lastIndexOf('/') + 1;
  const name = lower.slice(nameAt);
  let score = 0;
  const positions: number[] = [];
  for (const term of terms) {
    // The file's own name first: that is what people type.
    const inName = term.includes('/') ? null : matchTerm(name, path.slice(nameAt), term);
    if (inName) {
      positions.push(...inName.positions.map((p) => p + nameAt));
      score += inName.score + 12 + (name.startsWith(term) ? 20 : 0) + (name === term || name.split('.')[0] === term ? 40 : 0);
      continue;
    }
    const anywhere = matchTerm(lower, path, term);
    if (!anywhere) return null;
    positions.push(...anywhere.positions);
    score += anywhere.score;
  }
  // Shorter paths win ties: the theme's file over the same name deep in a vendor folder.
  score -= path.length / 40;
  return { path, score, positions: [...new Set(positions)].sort((a, b) => a - b) };
}

/** The best matches, best first; ties keep the given order. */
export function fuzzyFind(query: string, paths: readonly string[], limit = 60): FuzzyHit[] {
  const { terms } = parseQuery(query);
  const hits: FuzzyHit[] = [];
  for (const p of paths) {
    const hit = fuzzyScore(p, terms);
    if (hit) hits.push(hit);
  }
  if (!terms.length) return hits.slice(0, limit);
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}
