/**
 * The bytes a knowledge projection writes, computed without a filesystem.
 *
 * These are the content builders learning/compilers.ts uses for every provider
 * target — CLAUDE.md and AGENTS.md managed blocks, Claude path-rule
 * frontmatter, and SKILL.md bodies — moved here so the byte-stability contract
 * can be held by `npm run test:shared` rather than by a thirty-second smoke.
 *
 * The contract: the same inputs produce the same bytes, every time, on every
 * machine. A projection preserves its base hash and its applied hash; Undo
 * refuses when the file no longer hashes to what was applied, and staleness
 * compares the same hashes. An input that could render two ways — selectors in
 * a different order, a CRLF frontmatter that was not recognised, a description
 * cut through the middle of a character — is a projection that reads as
 * changed when nothing about the knowledge did.
 *
 * Nothing here reads a clock, a random source, a Map or Set iteration order, or
 * the platform's path separator.
 */

export type ManagedInput = { key: string; title: string; proposedText: string };
export type SkillInput = { title: string; rationale: string; proposedText: string };

export function slug(value: string): string {
  // Unchanged from the compiler it came from, including that a combining mark
  // becomes a hyphen ('résumé' -> 're-sume'). The slug is part of an applied
  // skill's path, so improving it would move files already on disk.
  const result = value.normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return result || 'wanigan-skill';
}

export function dominantEol(existing: string | null): '\n' | '\r\n' {
  if (!existing) return '\n';
  const crlf = (existing.match(/\r\n/g) ?? []).length;
  const lf = (existing.match(/\n/g) ?? []).length - crlf;
  return crlf > lf ? '\r\n' : '\n';
}

export function stripLeadingFrontmatter(existing: string | null): string | null {
  if (existing == null) return null;
  const match = /^---\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n)*/.exec(existing);
  return match ? existing.slice(match[0].length) : existing;
}

export function managedMarkdown(existing: string | null, input: ManagedInput): string {
  const begin = `<!-- wanigan:begin ${input.key} -->`;
  const end = `<!-- wanigan:end ${input.key} -->`;
  // Splicing LF into a CRLF file leaves mixed endings that trip whitespace
  // checks, so the block adopts the surrounding file's dominant ending.
  const eol = dominantEol(existing);
  const body = input.proposedText
    .replaceAll('<!-- wanigan:begin', '<!-- wanigan-user:begin')
    .replaceAll('<!-- wanigan:end', '<!-- wanigan-user:end')
    .trim().replace(/\r?\n/g, eol);
  const block = `${begin}${eol}## ${input.title}${eol}${eol}${body}${eol}${end}`;
  const source = (existing ?? '').trimEnd();
  const start = source.indexOf(begin);
  const finish = start === -1 ? -1 : source.indexOf(end, start + begin.length);
  if (start !== -1 && finish !== -1) {
    return `${source.slice(0, start)}${block}${source.slice(finish + end.length)}`.trimEnd() + eol;
  }
  return source ? `${source}${eol}${eol}${block}${eol}` : `${block}${eol}`;
}

/** At most `max` UTF-16 units, never ending on the first half of a surrogate pair. */
export function sliceWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

export function skillBody(input: SkillInput): string {
  const content = input.proposedText.trim();
  // A proposal that is already a SKILL.md is written as it is. CRLF counts: a
  // frontmatter opened with "---\r\n" used to be missed and given a second one.
  if (/^---\r?\n/.test(content)) return `${content}${content.includes('\r\n') ? '\r\n' : '\n'}`;
  return `---\nname: ${slug(input.title)}\ndescription: ${JSON.stringify(sliceWhole(input.rationale, 500))}\n---\n\n# ${input.title}\n\n${content}\n`;
}

/**
 * A path scope's selectors in one canonical order: trimmed, de-duplicated and
 * sorted. `src/a/**, src/b/**` and `src/b/**, src/a/**` scope the same files;
 * rendered in input order they produced two different rule files, and the
 * second read as a changed projection of unchanged knowledge.
 */
export function canonicalSelectors(scope: string | null | undefined): string[] {
  const seen = new Set<string>();
  for (const raw of (scope ?? '').split(/[\n,]/)) {
    const v = raw.trim();
    if (v) seen.add(v);
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function pathRuleFrontmatter(selectors: readonly string[], eol: '\n' | '\r\n'): string {
  return `---${eol}paths:${eol}${selectors.map((v) => `  - ${JSON.stringify(v)}`).join(eol)}${eol}---${eol}${eol}`;
}

function posixNormalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else out.push('..');
    } else out.push(part);
  }
  return out.join('/');
}

/** A Codex path scope reduced to the one directory a nested AGENTS.md can express, or null. */
export function codexDirectoryScope(scope: string): string | null {
  const selectors = scope.split(/[\n,]/).map((v) => v.trim().replace(/^\.\//, '')).filter(Boolean);
  if (selectors.length !== 1) return null;
  const selector = selectors[0].replaceAll('\\', '/');
  if (/[*?[]/.test(selector.replace(/\/\*\*\/?$/, ''))) return null;
  if (!selector.endsWith('/**')) return null;
  const dir = selector.slice(0, -3).replace(/\/$/, '');
  if (dir.startsWith('/')) return null;
  const normalized = posixNormalize(dir);
  return normalized && normalized !== '..' && !normalized.startsWith('../') ? normalized : null;
}
