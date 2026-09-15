/**
 * The folder name Claude Code files a directory under, in `<config>/projects/`.
 *
 * Read out of the shipped CLI (2.1.271) rather than the docs, because the docs
 * give only the first rule. The path is normalised to NFC, every character
 * outside [a-zA-Z0-9] becomes '-', and a name longer than 200 characters keeps
 * its first 200 and gains '-' plus the base-36 absolute value of a 32-bit
 * Java-style string hash of the whole path. Wanigan had three copies of this
 * that stopped at the first rule, so a deep enough directory was looked for
 * under a name the CLI never writes, and reported as having no transcript.
 *
 * Pure on purpose: which path to slug is the caller's decision, and it differs.
 * Transcripts are filed under the directory the CLI was started in — a worktree
 * is its own folder — while auto-memory is filed under the repository root.
 * Resolving the path (and following symlinks, since a process's cwd is
 * physical) is the caller's job too.
 */

export const CLAUDE_SLUG_MAX = 200;

/** Java's String.hashCode, in JavaScript's arithmetic: 32-bit wraparound per step. */
export function javaStringHash(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  return hash;
}

export function claudeProjectSlug(absolutePath: string): string {
  const normalized = absolutePath.normalize('NFC');
  const slug = normalized.replace(/[^a-zA-Z0-9]/g, '-');
  if (slug.length <= CLAUDE_SLUG_MAX) return slug;
  // Math.abs in JavaScript, not Java: the minimum int stays positive here, and
  // the CLI is JavaScript.
  return `${slug.slice(0, CLAUDE_SLUG_MAX)}-${Math.abs(javaStringHash(normalized)).toString(36)}`;
}
