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

/**
 * Sets `disable-model-invocation` in a SKILL.md's frontmatter, leaving every
 * other line exactly as it was. A file with no frontmatter gains one holding
 * only that key; a file whose frontmatter never closes is refused rather than
 * rewritten, because there is no telling where the author meant it to end.
 */
export function withDisableModelInvocation(markdown: string, disabled: boolean): string {
  const eol = markdown.includes('\r\n') ? '\r\n' : '\n';
  const line = `disable-model-invocation: ${disabled ? 'true' : 'false'}`;
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== '---') return ['---', line, '---', ...lines].join(eol);
  const close = lines.indexOf('---', 1);
  if (close < 0) throw new Error('This SKILL.md opens a frontmatter block that never closes, so Wanigan will not rewrite it.');
  const at = lines.slice(1, close).findIndex((l) => /^disable-model-invocation\s*:/.test(l));
  if (at >= 0) lines[at + 1] = line;
  else lines.splice(close, 0, line);
  return lines.join(eol);
}

/** One line of a model-facing skill listing, the shape both harnesses use: name, then description. */
export function claudeSkillListingLine(skill: { name: string; description: string }): string {
  return `- ${skill.name}: ${skill.description}\n`;
}
