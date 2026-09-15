/**
 * A deliberately small TOML reader: enough to answer "what does this Codex
 * config.toml set for these few keys", and nothing more.
 *
 * Wanigan does not ship a TOML dependency, and the questions it asks of
 * `config.toml` are a handful of scalars and string arrays: the AGENTS.md byte
 * budget, the fallback filenames, the root markers, the skills budget and the
 * model. A full parser would be a new supply-chain surface to answer those.
 *
 * What it reads:
 *  - `[table]` and `[table.sub]` headers (quoted segments included), and the
 *    dotted path they put in front of each key;
 *  - bare and quoted keys, with dotted keys (`skills.max_context_tokens = 1`);
 *  - basic and literal strings, integers (underscores allowed), floats,
 *    booleans, and arrays of those, on one line or across several.
 *
 * What it refuses rather than guesses: inline tables, `[[array tables]]`,
 * multi-line strings and dates. A key whose value it cannot read is reported
 * in `unreadable` by path, so a caller can say "config.toml sets this but
 * Wanigan could not read it" instead of silently using a default.
 */

export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | TomlScalar[];

export type TomlKeys = {
  values: Record<string, TomlValue>;
  unreadable: string[];
};

function stripComment(line: string): string {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inBasic) {
      if (c === '\\') { i++; continue; }
      if (c === '"') inBasic = false;
    } else if (inLiteral) {
      if (c === "'") inLiteral = false;
    } else if (c === '"') inBasic = true;
    else if (c === "'") inLiteral = true;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

function splitKeyPath(raw: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = raw.trim();
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (s[i] === '"' || s[i] === "'") {
      const quote = s[i];
      const end = s.indexOf(quote, i + 1);
      if (end < 0) return null;
      parts.push(s.slice(i + 1, end));
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      parts.push(m[0]);
      i += m[0].length;
    }
    while (s[i] === ' ' || s[i] === '\t') i++;
    if (i < s.length) {
      if (s[i] !== '.') return null;
      i++;
    }
  }
  return parts.length ? parts : null;
}

function readBasicString(s: string): string | null {
  let out = '';
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') return i === s.length - 1 ? out : null;
    if (c === '\\') {
      const n = s[++i];
      const map: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', r: '\r' };
      if (n in map) out += map[n];
      else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(s.slice(i + 1, i + 5))) { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
      else return null;
    } else out += c;
  }
  return null;
}

function readScalar(raw: string): TomlScalar | undefined {
  const s = raw.trim();
  if (s.startsWith('"""') || s.startsWith("'''")) return undefined;
  if (s.startsWith('"')) return readBasicString(s) ?? undefined;
  if (s.startsWith("'")) return s.length >= 2 && s.endsWith("'") && !s.slice(1, -1).includes("'") ? s.slice(1, -1) : undefined;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(s)) return Number(s.replace(/_/g, ''));
  if (/^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9]+)?$/.test(s)) return Number(s.replace(/_/g, ''));
  return undefined;
}

function splitArrayItems(body: string): string[] | null {
  const items: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\' && quote === '"') { cur += body[++i] ?? ''; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '[' || c === '{') return null;
    if (c === ',') { items.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (quote) return null;
  if (cur.trim()) items.push(cur);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function readValue(raw: string): TomlValue | undefined {
  const s = raw.trim();
  if (s.startsWith('[')) {
    if (!s.endsWith(']')) return undefined;
    const items = splitArrayItems(s.slice(1, -1));
    if (!items) return undefined;
    const out: TomlScalar[] = [];
    for (const item of items) {
      const v = readScalar(item);
      if (v === undefined) return undefined;
      out.push(v);
    }
    return out;
  }
  if (s.startsWith('{')) return undefined;
  return readScalar(s);
}

/** Counts brackets outside strings, so a multi-line array knows when it has closed. */
function bracketDepth(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue; }
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[') depth++;
    else if (c === ']') depth--;
  }
  return depth;
}

export function readTomlKeys(text: string): TomlKeys {
  const values: Record<string, TomlValue> = {};
  const unreadable: string[] = [];
  let table: string[] = [];
  let tableReadable = true;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = stripComment(lines[n]).trim();
    if (!line) continue;
    if (line.startsWith('[[')) { table = []; tableReadable = false; continue; }
    if (line.startsWith('[')) {
      const close = line.lastIndexOf(']');
      const path = close > 0 ? splitKeyPath(line.slice(1, close)) : null;
      table = path ?? [];
      tableReadable = path !== null;
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const keyPath = splitKeyPath(line.slice(0, eq));
    if (!keyPath || !tableReadable) continue;
    let rawValue = line.slice(eq + 1).trim();
    // A multi-line array: keep reading until its brackets balance.
    if (rawValue.startsWith('[')) {
      while (bracketDepth(rawValue) > 0 && n + 1 < lines.length) {
        rawValue += ' ' + stripComment(lines[++n]).trim();
      }
    }
    const full = [...table, ...keyPath].join('.');
    const value = readValue(rawValue);
    if (value === undefined) unreadable.push(full);
    else values[full] = value;
  }
  return { values, unreadable };
}

export function tomlInteger(keys: TomlKeys, path: string): number | null {
  const v = keys.values[path];
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

export function tomlString(keys: TomlKeys, path: string): string | null {
  const v = keys.values[path];
  return typeof v === 'string' ? v : null;
}

export function tomlStrings(keys: TomlKeys, path: string): string[] | null {
  const v = keys.values[path];
  return Array.isArray(v) && v.every((item) => typeof item === 'string') ? v as string[] : null;
}
