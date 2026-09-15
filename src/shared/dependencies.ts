/**
 * New dependencies as review items: what a diff added, changed or removed in a
 * manifest or lockfile, read from the file on each side.
 *
 * Agents pick packages from their priors — across 16,893 measured sessions,
 * three agents chose the same tool only 42% of the time — so a dependency a
 * session added is a decision the operator did not make and should see as one,
 * not as twelve lines of JSON in a diff.
 *
 * These are small readers, not full parsers of TOML, YAML or the lockfile
 * formats. Each reads the part of the format that names direct dependencies
 * and says plainly when a file is malformed or uses a shape it does not read,
 * rather than reporting an empty list that looks like "no dependencies". There
 * is no network lookup here and no claim that a package is safe.
 */

export type ManifestKind =
  | 'package.json' | 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock'
  | 'pyproject.toml' | 'requirements.txt' | 'go.mod' | 'Cargo.toml' | 'composer.json' | 'Gemfile';

/** One named dependency on one side. `section` is where the file declares it. */
export type DepEntry = { name: string; version: string | null; section: string };

export type ManifestRead =
  | { ok: true; entries: DepEntry[]; note: string | null }
  | { ok: false; reason: string };

export type DepChange = {
  name: string;
  section: string;
  change: 'added' | 'removed' | 'upgraded' | 'downgraded' | 'changed';
  before: string | null;
  after: string | null;
};

/** Which reader a path gets, by its file name, or null for a file that is not a manifest. */
export function manifestKind(path: string): ManifestKind | null {
  const name = path.split('/').pop() ?? '';
  switch (name) {
    case 'package.json': case 'package-lock.json': case 'pnpm-lock.yaml': case 'yarn.lock':
    case 'pyproject.toml': case 'go.mod': case 'Cargo.toml': case 'composer.json': case 'Gemfile':
      return name;
  }
  if (/^requirements[\w.-]*\.txt$/i.test(name)) return 'requirements.txt';
  return null;
}

/** An empty or absent side is an empty manifest, not a malformed one. */
export function readManifest(kind: ManifestKind, text: string | null): ManifestRead {
  if (text === null || !text.trim()) return { ok: true, entries: [], note: null };
  try {
    switch (kind) {
      case 'package.json': return readPackageJson(text);
      case 'package-lock.json': return readPackageLock(text);
      case 'pnpm-lock.yaml': return readPnpmLock(text);
      case 'yarn.lock': return readYarnLock(text);
      case 'pyproject.toml': return readPyproject(text);
      case 'requirements.txt': return readRequirements(text);
      case 'go.mod': return readGoMod(text);
      case 'Cargo.toml': return readCargo(text);
      case 'composer.json': return readComposer(text);
      case 'Gemfile': return readGemfile(text);
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ── JSON manifests ─────────────────────────────────────────────────── */

function parseJsonObject(text: string, what: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${what} is not valid JSON.`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${what} is not a JSON object.`);
  return value as Record<string, unknown>;
}

function sectionsOf(obj: Record<string, unknown>, sections: readonly string[]): DepEntry[] {
  const out: DepEntry[] = [];
  for (const section of sections) {
    const block = obj[section];
    if (!block || typeof block !== 'object' || Array.isArray(block)) continue;
    for (const [name, version] of Object.entries(block as Record<string, unknown>)) {
      out.push({ name, version: typeof version === 'string' ? version : null, section });
    }
  }
  return out;
}

function readPackageJson(text: string): ManifestRead {
  const obj = parseJsonObject(text, 'package.json');
  return { ok: true, entries: sectionsOf(obj, ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']), note: null };
}

function readComposer(text: string): ManifestRead {
  const obj = parseJsonObject(text, 'composer.json');
  return { ok: true, entries: sectionsOf(obj, ['require', 'require-dev']), note: null };
}

function readPackageLock(text: string): ManifestRead {
  const obj = parseJsonObject(text, 'package-lock.json');
  const packages = obj.packages;
  if (packages && typeof packages === 'object' && !Array.isArray(packages)) {
    const out: DepEntry[] = [];
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      // Top level only: `node_modules/a`, never `node_modules/a/node_modules/b`.
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (!m) continue;
      const row = (value ?? {}) as Record<string, unknown>;
      out.push({ name: m[1], version: typeof row.version === 'string' ? row.version : null, section: row.dev === true ? 'installed (dev)' : 'installed' });
    }
    return { ok: true, entries: out, note: 'Top-level installed packages from the lockfile.' };
  }
  const deps = obj.dependencies;
  if (deps && typeof deps === 'object' && !Array.isArray(deps)) {
    const out: DepEntry[] = Object.entries(deps as Record<string, unknown>).map(([name, value]) => {
      const row = (value ?? {}) as Record<string, unknown>;
      return { name, version: typeof row.version === 'string' ? row.version : null, section: 'installed' };
    });
    return { ok: true, entries: out, note: 'Top-level installed packages from a version 1 lockfile.' };
  }
  return { ok: true, entries: [], note: 'This lockfile lists no packages.' };
}

/* ── line-oriented readers ──────────────────────────────────────────── */

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const unquote = (s: string) => s.trim().replace(/^['"]|['"]$/g, '');

/**
 * pnpm-lock.yaml: the root importer's direct dependencies. Version 6 and later
 * write them under `importers: '.':`; version 5 wrote them at the top level.
 */
function readPnpmLock(text: string): ManifestRead {
  const all = lines(text);
  if (!/^lockfileVersion:/m.test(text)) throw new Error('pnpm-lock.yaml has no lockfileVersion line, so its shape is unknown.');
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies'];
  const out: DepEntry[] = [];
  const importers = all.findIndex((l) => /^importers:\s*$/.test(l));
  let start = 0, end = all.length, base = 0;
  if (importers >= 0) {
    const root = all.findIndex((l, i) => i > importers && /^\s+(?:'\.'|"\."|\.):\s*$/.test(l));
    if (root < 0) return { ok: true, entries: [], note: 'This lockfile has no root importer.' };
    base = indentOf(all[root]);
    start = root + 1;
    end = all.findIndex((l, i) => i > root && l.trim() && indentOf(l) <= base);
    if (end < 0) end = all.length;
  }
  for (let i = start; i < end; i++) {
    const header = all[i];
    const sm = /^(\s*)(dependencies|devDependencies|optionalDependencies):\s*$/.exec(header);
    if (!sm || indentOf(header) !== (importers >= 0 ? base + 2 : 0) || !sections.includes(sm[2])) continue;
    const depth = indentOf(header);
    for (let j = i + 1; j < end; j++) {
      const line = all[j];
      if (!line.trim()) continue;
      if (indentOf(line) <= depth) break;
      if (indentOf(line) !== depth + 2) continue;
      const m = /^\s*([^:\s][^:]*?):\s*(.*)$/.exec(line);
      if (!m) continue;
      let version: string | null = m[2].trim() ? unquote(m[2]) : null;
      if (version === null) {
        // v6+: the name opens a block holding specifier and version.
        for (let k = j + 1; k < end && indentOf(all[k]) > depth + 2; k++) {
          const v = /^\s*version:\s*(.+)$/.exec(all[k]);
          if (v) { version = unquote(v[1]).replace(/\(.*$/, ''); break; }
        }
      }
      out.push({ name: unquote(m[1]), version, section: sm[2] });
    }
  }
  return { ok: true, entries: out, note: 'Direct dependencies of the root project in the lockfile.' };
}

/**
 * yarn.lock has no notion of a direct dependency, so this lists every resolved
 * package, and says so. Classic and Berry both write `"name@range":` headers
 * followed by an indented version line.
 */
function readYarnLock(text: string): ManifestRead {
  const all = lines(text);
  const out = new Map<string, DepEntry>();
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    if (!line || line.startsWith('#') || line.startsWith(' ') || !line.trimEnd().endsWith(':')) continue;
    if (line.startsWith('__metadata')) continue;
    const first = unquote(line.slice(0, -1).split(',')[0]);
    const at = first.lastIndexOf('@');
    if (at <= 0) continue;
    const name = first.slice(0, at);
    let version: string | null = null;
    for (let j = i + 1; j < all.length && all[j].startsWith(' '); j++) {
      const v = /^\s+version:?\s+"?([^"\s]+)"?/.exec(all[j]);
      if (v) { version = v[1]; break; }
    }
    const key = `${name}@${version}`;
    if (!out.has(key)) out.set(key, { name, version, section: 'resolved' });
  }
  return { ok: true, entries: [...out.values()], note: 'Every package the lockfile resolves, not only direct dependencies.' };
}

/** A PEP 508 requirement's name and the rest, e.g. `requests[socks]>=2.31; python_version<"4"`. */
function pep508(spec: string): { name: string; version: string | null } | null {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(\[[^\]]*\])?\s*([^;]*)/.exec(spec);
  if (!m) return null;
  const version = m[3].trim();
  return { name: m[1].toLowerCase().replace(/_/g, '-'), version: version || null };
}

function readRequirements(text: string): ManifestRead {
  const out: DepEntry[] = [];
  let skipped = 0;
  for (const raw of lines(text)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('-')) { skipped += 1; continue; }
    const req = pep508(line);
    if (req) out.push({ ...req, section: 'requirements' });
    else skipped += 1;
  }
  return { ok: true, entries: out, note: skipped ? `${skipped} line${skipped === 1 ? '' : 's'} (options, includes or URLs) not read as packages.` : null };
}

/** A TOML string array that may span lines: `key = [ "a", "b" ]`. */
function tomlArray(all: string[], i: number): { values: string[]; next: number } {
  let text = all[i].slice(all[i].indexOf('=') + 1);
  let j = i;
  // The closing bracket is looked for outside strings: `"requests[socks]>=2"`
  // carries one of its own, and stopping there drops every later entry.
  const closed = (t: string) => t.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '').includes(']');
  while (!closed(text) && j + 1 < all.length) { j += 1; text += '\n' + all[j]; }
  const values = [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);
  return { values, next: j };
}

function readPyproject(text: string): ManifestRead {
  const all = lines(text);
  const out: DepEntry[] = [];
  let table = '';
  for (let i = 0; i < all.length; i++) {
    const line = all[i].replace(/\s+#.*$/, '');
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { table = header[1].trim(); continue; }
    const kv = /^\s*([A-Za-z0-9_.-]+|"[^"]+")\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = unquote(kv[1]);
    if (table === 'project' && key === 'dependencies') {
      const { values, next } = tomlArray(all, i); i = next;
      for (const v of values) { const r = pep508(v); if (r) out.push({ ...r, section: 'project.dependencies' }); }
    } else if (table === 'project.optional-dependencies' || table === 'dependency-groups') {
      const { values, next } = tomlArray(all, i); i = next;
      for (const v of values) { const r = pep508(v); if (r) out.push({ ...r, section: `${table}.${key}` }); }
    } else if (/^tool\.poetry(\.group\.[^.]+)?\.(dev-)?dependencies$/.test(table)) {
      if (key.toLowerCase() === 'python') continue;
      const value = kv[2].trim();
      const version = value.startsWith('{') ? (/version\s*=\s*"([^"]*)"/.exec(value)?.[1] ?? null) : unquote(value);
      out.push({ name: key.toLowerCase(), version: version || null, section: table });
    }
  }
  return { ok: true, entries: out, note: null };
}

function readGoMod(text: string): ManifestRead {
  if (!/^\s*module\s+\S+/m.test(text)) throw new Error('go.mod has no module line.');
  const out: DepEntry[] = [];
  let inBlock = false;
  for (const raw of lines(text)) {
    const line = raw.trim();
    if (inBlock) {
      if (line === ')') { inBlock = false; continue; }
      const m = /^(\S+)\s+(\S+)(.*)$/.exec(line);
      if (m && !line.startsWith('//')) out.push({ name: m[1], version: m[2], section: /\/\/\s*indirect/.test(m[3]) ? 'require (indirect)' : 'require' });
      continue;
    }
    if (/^require\s*\($/.test(line)) { inBlock = true; continue; }
    const one = /^require\s+(\S+)\s+(\S+)(.*)$/.exec(line);
    if (one) out.push({ name: one[1], version: one[2], section: /\/\/\s*indirect/.test(one[3]) ? 'require (indirect)' : 'require' });
  }
  return { ok: true, entries: out, note: null };
}

function readCargo(text: string): ManifestRead {
  const all = lines(text);
  const out: DepEntry[] = [];
  let table = '';
  for (const raw of all) {
    const line = raw.replace(/\s+#.*$/, '');
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) { table = header[1].trim(); continue; }
    const section = /^(?:target\.[^.]+(?:\.[^.]+)*\.)?((?:dev-|build-)?dependencies)$/.exec(table.replace(/'[^']*'|"[^"]*"/g, 'x'));
    if (!section) continue;
    const kv = /^\s*([A-Za-z0-9_-]+)(\.workspace)?\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = kv[3].trim();
    const version = kv[2] ? 'workspace' : value.startsWith('{')
      ? (/version\s*=\s*"([^"]*)"/.exec(value)?.[1] ?? (/workspace\s*=\s*true/.test(value) ? 'workspace' : null))
      : unquote(value);
    out.push({ name: kv[1], version: version || null, section: section[1] });
  }
  return { ok: true, entries: out, note: null };
}

function readGemfile(text: string): ManifestRead {
  const out: DepEntry[] = [];
  let group: string | null = null;
  for (const raw of lines(text)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    const g = /^group\s+(.+?)\s+do$/.exec(line);
    if (g) { group = g[1].replace(/[:'"]/g, ''); continue; }
    if (line === 'end') { group = null; continue; }
    const m = /^gem\s+['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]+)['"])?/.exec(line);
    if (m) out.push({ name: m[1], version: m[2] ?? null, section: group ? `group ${group}` : 'gems' });
  }
  return { ok: true, entries: out, note: null };
}

/* ── comparing the two sides ────────────────────────────────────────── */

/** The numbers of a version, for a direction only: `^1.2.3` → [1,2,3]. Null when there are none. */
function numbersOf(version: string | null): number[] | null {
  const m = version ? /(\d+(?:\.\d+)*)/.exec(version) : null;
  return m ? m[1].split('.').map(Number) : null;
}

function direction(before: string | null, after: string | null): DepChange['change'] {
  const a = numbersOf(before), b = numbersOf(after);
  if (!a || !b) return 'changed';
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    if (x !== y) return y > x ? 'upgraded' : 'downgraded';
  }
  return 'changed';
}

/** What changed between two reads of one manifest. Keyed by section and name. */
export function diffDependencies(before: readonly DepEntry[], after: readonly DepEntry[]): DepChange[] {
  const key = (e: DepEntry) => `${e.section}\x00${e.name}`;
  const was = new Map(before.map((e) => [key(e), e]));
  const now = new Map(after.map((e) => [key(e), e]));
  const out: DepChange[] = [];
  for (const [k, e] of now) {
    const old = was.get(k);
    if (!old) out.push({ name: e.name, section: e.section, change: 'added', before: null, after: e.version });
    else if (old.version !== e.version) out.push({ name: e.name, section: e.section, change: direction(old.version, e.version), before: old.version, after: e.version });
  }
  for (const [k, e] of was) {
    if (!now.has(k)) out.push({ name: e.name, section: e.section, change: 'removed', before: e.version, after: null });
  }
  const order = { added: 0, upgraded: 1, downgraded: 2, changed: 3, removed: 4 } as const;
  return out.sort((x, y) => order[x.change] - order[y.change] || x.name.localeCompare(y.name));
}

/** One line of a review message or a rail row: "added `left-pad` 1.3.0 (package.json dependencies)". */
export function describeDepChange(change: DepChange, file: string): string {
  const where = `${file} ${change.section}`;
  switch (change.change) {
    case 'added': return `added \`${change.name}\`${change.after ? ` ${change.after}` : ''} (${where})`;
    case 'removed': return `removed \`${change.name}\`${change.before ? ` ${change.before}` : ''} (${where})`;
    default: return `${change.change} \`${change.name}\` ${change.before ?? '?'} → ${change.after ?? '?'} (${where})`;
  }
}

/** Package-manager commands that install or change dependencies, by the shape of the command. */
const INSTALL = /(^|[;&|]\s*|\s)(npm\s+(i|install|add|ci|update|up)\b|pnpm\s+(i|install|add|update|up)\b|yarn(\s+(add|install|upgrade|up)\b|\s*($|[;&|]))|bun\s+(i|install|add)\b|pip3?\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+(add|sync|pip\s+install)\b|poetry\s+(add|install|update)\b|go\s+(get|mod\s+tidy)\b|cargo\s+(add|install|update)\b|composer\s+(require|install|update)\b|bundle(\s+(add|install|update)\b|\s*($|[;&|]))|gem\s+install\b)/;

export function isInstallCommand(command: string): boolean {
  return INSTALL.test(command.trim());
}
