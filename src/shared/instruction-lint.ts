/**
 * Stale references in instruction files: a backticked path that no longer
 * exists, and a shell command whose program is not installed.
 *
 * An instruction that names `src/old/place.ts` or tells the agent to run
 * `yarn test` in a repository that moved to npm is worse than no instruction:
 * the agent obeys it, fails, and spends a turn finding out. This is the pure
 * half — pulling candidate references out of markdown. The main process checks
 * them against the disk, `git ls-files` and PATH.
 *
 * It is deliberately quiet. It stays silent on anything it cannot check
 * honestly: URLs, globs, home-relative paths (`~/`), variables (`$HOME`,
 * `${X}`), placeholders (`<name>`), and prose that merely contains a slash. A
 * lint that cries wolf on every `and/or` teaches people to ignore it.
 */

export type PathReference = { kind: 'path'; text: string; line: number };
export type CommandReference = { kind: 'command'; program: string; text: string; line: number };
export type InstructionReference = PathReference | CommandReference;

const SHELL_FENCES = new Set(['sh', 'bash', 'zsh', 'shell', 'console', 'terminal', 'shell-session']);

/** Built into the shell, or a keyword: never on PATH, never stale. */
const SHELL_BUILTINS = new Set([
  'cd', 'export', 'source', '.', 'echo', 'set', 'unset', 'alias', 'if', 'then', 'else', 'fi', 'for', 'do', 'done',
  'while', 'case', 'esac', 'function', 'return', 'exit', 'eval', 'exec', 'test', '[', '[[', 'true', 'false', 'read',
  'pushd', 'popd', 'type', 'command', 'builtin', 'local', 'shift', 'trap', 'wait', 'ulimit', 'umask', 'history',
  'time', 'env', 'sudo', 'nohup', '{', '}', '(', ')', '!', 'printf', 'pwd', 'let', 'declare', 'readonly', 'hash',
]);

const EXTENSION = /\.(?:[a-z0-9]{1,6})$/i;

/**
 * Whether a backticked span reads as a repository path worth checking. It must
 * contain a slash, carry no whitespace, and be none of the shapes this lint
 * promises to leave alone.
 */
export function looksLikeRepoPath(span: string): boolean {
  const s = span.trim();
  if (!s || s.length > 240 || /\s/.test(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || s.startsWith('www.')) return false;
  if (s.startsWith('~') || s.includes('$') || s.startsWith('@')) return false;
  if (/[*?[\]{}<>|;&()'"`,=]/.test(s)) return false;
  if (s.startsWith('/')) return false; // absolute: machine-specific, not a repository claim
  if (s.startsWith('-')) return false; // a flag
  if (/^\d/.test(s) && !s.includes('/')) return false; // a version like 22.23.2
  if (s.includes('...') || s === '.' || s === '..') return false;
  if (/^[a-z0-9-]+\/[a-z0-9-]+$/i.test(s) && !EXTENSION.test(s) && !s.startsWith('.')) {
    // `owner/repo`, `and/or`, `read/write`: two bare words and a slash are
    // prose far more often than a directory. Only a dotted segment or an
    // extension makes a two-word span a path claim.
    return false;
  }
  // A bare file name is not checked: `MEMORY.md` or `config.toml` in prose
  // names a kind of file far more often than a file at the repository root,
  // and there is no directory to look in that would make the claim checkable.
  if (!s.includes('/')) return false;
  return /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]*)*$/.test(s);
}

/** The program a shell line runs, skipping a prompt, env assignments and wrappers. */
export function programOf(line: string): string | null {
  let s = line.trim();
  if (!s || s.startsWith('#')) return null;
  s = s.replace(/^\$\s+/, '').replace(/^>\s+/, '');
  const words = s.split(/\s+/);
  let i = 0;
  const wrapper = (w: string) => w === 'sudo' || w === 'env' || w === 'nohup' || w === 'time';
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || wrapper(words[i]))) i++;
  const word = words[i];
  if (!word) return null;
  if (SHELL_BUILTINS.has(word)) return null;
  if (word.includes('$') || word.includes('`') || word.startsWith('~') || /[*?[\]{}<>|;&()'"]/.test(word)) return null;
  // ./scripts/x.sh and relative programs are paths, checked as paths elsewhere.
  if (word.includes('/')) return null;
  if (!/^[A-Za-z0-9_.+-]+$/.test(word)) return null;
  return word;
}

export function extractReferences(markdown: string): InstructionReference[] {
  const out: InstructionReference[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let fence: { marker: string; shell: boolean } | null = null;
  let inComment = false;
  let continued = false;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const lineNo = n + 1;
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    const fenceMatch = /^\s*(```+|~~~+)\s*([A-Za-z0-9_-]*)/.exec(line);
    if (fenceMatch) {
      if (!fence) {
        fence = { marker: fenceMatch[1], shell: SHELL_FENCES.has(fenceMatch[2].toLowerCase()) };
        continued = false;
      } else if (line.trim().startsWith(fence.marker[0].repeat(3))) {
        fence = null;
      }
      continue;
    }
    if (fence) {
      if (!fence.shell) continue;
      const wasContinued = continued;
      continued = /\\\s*$/.test(line);
      if (wasContinued) continue;
      // Every command in a && / || / ; chain runs its own program.
      for (const part of line.split(/&&|\|\||;/)) {
        const program = programOf(part);
        if (program) out.push({ kind: 'command', program, text: part.trim(), line: lineNo });
      }
      continue;
    }
    if (line.includes('<!--') && !line.includes('-->')) { inComment = true; continue; }
    const spans = line.match(/`[^`\n]+`/g) ?? [];
    for (const raw of spans) {
      const text = raw.slice(1, -1).trim();
      if (looksLikeRepoPath(text)) out.push({ kind: 'path', text: text.replace(/\/$/, ''), line: lineNo });
    }
  }
  return out;
}

/** Edit distance, bounded: a suggestion further than a few edits away is not a suggestion. */
export function editDistance(a: string, b: string, cap = 6): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * The tracked file most like a missing one: the same base name somewhere else
 * first (a file that moved), then the nearest path by edit distance. Null when
 * nothing is close enough to be worth printing.
 */
export function didYouMean(missing: string, tracked: readonly string[]): string | null {
  const base = missing.split('/').pop() ?? missing;
  const sameName = tracked.filter((p) => (p.split('/').pop() ?? p) === base);
  if (sameName.length) {
    return [...sameName].sort((a, b) => editDistance(missing, a, 64) - editDistance(missing, b, 64) || a.localeCompare(b))[0];
  }
  const threshold = Math.max(2, Math.floor(missing.length / 5));
  let best: string | null = null;
  let bestScore = threshold + 1;
  for (const p of tracked) {
    const d = editDistance(missing, p, threshold);
    if (d > threshold) continue;
    if (best === null || d < bestScore || (d === bestScore && p.localeCompare(best) < 0)) { best = p; bestScore = d; }
  }
  return best;
}
