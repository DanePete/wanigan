/**
 * Two small readers for Claude Code agent definitions, kept pure so their
 * edges are tested without a process: the `omitClaudeMd` frontmatter value and
 * the CLI version gate it sits behind.
 */

/** The release that added `omitClaudeMd` (changelog 2.1.271; key read out of that binary). */
export const OMIT_CLAUDE_MD_SINCE = '2.1.271';

/** The frontmatter value the CLI reads: `true` or "true" is on, anything else it ignores. */
export function omitClaudeMdOf(text: string): boolean | 'unknown' {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return false;
  const line = m[1].split(/\r?\n/).find((l) => /^omitClaudeMd\s*:/.test(l));
  if (!line) return false;
  const value = line.replace(/^omitClaudeMd\s*:\s*/, '').replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '');
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  return 'unknown';
}


/** A dotted x.y.z version at or past another; null when the installed one cannot be read. */
export function versionAtLeast(installed: string | null | undefined, since: string): boolean | null {
  const parse = (v: string | null | undefined) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const have = parse(installed);
  const want = parse(since);
  if (!have || !want) return null;
  for (let i = 0; i < 3; i++) if (have[i] !== want[i]) return have[i] > want[i];
  return true;
}
