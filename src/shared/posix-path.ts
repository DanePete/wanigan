/**
 * The four path operations the policy rules need, for POSIX paths only.
 *
 * `src/shared` is dependency-free by construction so that its tests answer in
 * under a second without a process, and the rules that decide whether a tool
 * call is allowed belong there. They cannot reach for `node:path`: the renderer
 * type-checks this directory too. Wanigan runs on macOS, every path a hook
 * carries is POSIX, and these mirror `path.posix` for the inputs the gate sees.
 */

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** Collapses `.`, `..` and repeated slashes. The root stays `/`. */
export function normalize(p: string): string {
  const absolute = isAbsolute(p);
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return absolute ? `/${joined}` : joined || '.';
}

/** `path.posix.resolve(base, p)` for a base that is already absolute. */
export function resolve(base: string, p: string): string {
  return normalize(isAbsolute(p) ? p : `${base}/${p}`);
}

export function dirname(p: string): string {
  const n = normalize(p);
  if (n === '/') return '/';
  const i = n.lastIndexOf('/');
  if (i === -1) return '.';
  return i === 0 ? '/' : n.slice(0, i);
}

export function basename(p: string): string {
  const n = normalize(p);
  if (n === '/') return '';
  const i = n.lastIndexOf('/');
  return i === -1 ? n : n.slice(i + 1);
}

/** True when `full` is `base` or sits below it. Both are compared as given. */
export function within(base: string, full: string): boolean {
  const b = normalize(base);
  const f = normalize(full);
  return f === b || f.startsWith(b === '/' ? '/' : `${b}/`);
}

/** `~`, `~/x`, `$HOME` and `${HOME}` against an explicit home directory. */
export function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return `${home}/${p.slice(2)}`;
  return p.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
}
