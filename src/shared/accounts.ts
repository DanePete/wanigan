/**
 * Naming a second account, so nobody has to think about a path.
 *
 * Adding an account used to ask for a label *and* a configuration directory,
 * which meant knowing that Codex reads `CODEX_HOME` and that `~/.codex_personal`
 * is a reasonable thing to type. The directory is derivable: every harness that
 * supports accounts already has one on disk — the adopted account Wanigan seeded
 * from `~/.claude` or `~/.codex` — so a new one is that path with the new name
 * on the end.
 *
 * Pure, so the derivation is tested in a tenth of a second rather than through
 * a settings panel. Main still validates every path it is handed: `cleanDir()`
 * in accounts.ts decides what is actually allowed, and this only proposes.
 */

/** Characters a directory name keeps. Everything else becomes one underscore. */
const SLUG_STRIP = /[^a-z0-9]+/g;

/**
 * A label as a directory suffix.
 *
 * Lower-cased and reduced to alphanumerics: an account called "Työ" or
 * "Client / ACME" must not put a slash, a space or an accent into a path that
 * a shell will later see in `CODEX_HOME`. An empty result is possible — a label
 * of "---" reduces to nothing — and the caller decides what to do about it
 * rather than getting a directory ending in a bare underscore.
 */
export function accountSlug(label: string): string {
  return label.normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(SLUG_STRIP, '_').replace(/^_+|_+$/g, '');
}

/**
 * Where a new account's directory should go, given one that already exists.
 *
 * `~/.codex` plus "Personal" is `~/.codex_personal`, which is the name the
 * vendor's own documentation uses for exactly this. Siblings rather than
 * children: a directory *inside* `~/.codex` would be scanned by the harness as
 * part of its own configuration.
 *
 * `taken` is every directory already spoken for, in any harness. A collision
 * appends a counter instead of silently proposing a path that main will refuse
 * — two accounts sharing one directory share one login, and accounts.ts rejects
 * that with its own message.
 */
export function proposeAccountDir(baseDir: string, label: string, taken: readonly string[]): string {
  const slug = accountSlug(label);
  if (!baseDir || !slug) return '';
  // Trailing separators would produce `~/.codex/_personal`, a child rather
  // than a sibling.
  const base = baseDir.replace(/[/\\]+$/, '');
  const used = new Set(taken.map((dir) => dir.replace(/[/\\]+$/, '')));
  const first = `${base}_${slug}`;
  if (!used.has(first)) return first;
  for (let n = 2; n < 100; n += 1) {
    const next = `${first}_${n}`;
    if (!used.has(next)) return next;
  }
  return '';
}

/**
 * What to run in a session started under a new account to sign it in.
 *
 * The harness decides: Codex has a subcommand, Claude Code has a slash command
 * its terminal understands. Returned as text to be typed rather than executed —
 * the session types it and stops, because pressing Enter on somebody's behalf
 * is how a half-finished command gets run.
 */
export function signInCommand(harness: string): string | null {
  if (harness === 'codex') return 'codex login';
  if (harness === 'claude-code') return '/login';
  return null;
}

/** The human name for a harness, for a panel that groups by it. */
export function harnessLabel(harness: string, fallbackLabels: readonly string[] = []): string {
  if (harness === 'codex') return 'Codex';
  if (harness === 'claude-code') return 'Claude Code';
  // A pack's harness has no name of its own here; the providers that run on it
  // do, so the caller passes those and the first is close enough to a name.
  return fallbackLabels[0] ?? harness;
}
