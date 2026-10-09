// A small TOML reader: enough of TOML 1.0 to read a Codex config.toml the way
// Codex writes it and the way people hand-edit it. Tables, dotted and quoted
// keys, inline tables, arrays, all four string forms, numbers, booleans and
// dates (kept as text). Anything it does not understand fails loudly with a
// line number rather than being guessed at: an unreadable config is reported,
// never half-read.

export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export interface TomlTable { [key: string]: TomlValue }

export class TomlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`line ${line}: ${message}`);
    this.line = line;
    this.name = 'TomlError';
  }
}

export function parseToml(source: string): TomlTable {
  const p = new Parser(source.replace(/^﻿/, '').replace(/\r\n/g, '\n'));
  return p.document();
}

const BARE = /[A-Za-z0-9_-]/;
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

class Parser {
  private readonly s: string;
  private i = 0;
  private readonly root: TomlTable = {};
  /** Tables made by a [header] or a dotted key, which a later [header] may not redefine. */
  private readonly defined = new Set<TomlTable>();

  constructor(s: string) {
    this.s = s;
  }

  document(): TomlTable {
    let current = this.root;
    for (;;) {
      this.skipBlankLines();
      if (this.i >= this.s.length) return this.root;
      if (this.s[this.i] === '[') {
        const array = this.s[this.i + 1] === '[';
        this.i += array ? 2 : 1;
        this.ws();
        const path = this.keyPath();
        this.ws();
        if (this.s[this.i] !== ']' || (array && this.s[this.i + 1] !== ']')) this.fail('Expected ] to close the table name.');
        this.i += array ? 2 : 1;
        current = array ? this.arrayTable(path) : this.table(path);
        this.endOfLine();
        continue;
      }
      this.keyValue(current);
      this.endOfLine();
    }
  }

  private table(path: string[]): TomlTable {
    let t = this.root;
    path.forEach((k, n) => {
      const existing = Object.hasOwn(t, k) ? t[k] : undefined;
      if (existing === undefined) {
        const next: TomlTable = {};
        t[k] = next;
        t = next;
      } else if (Array.isArray(existing)) {
        const last = existing[existing.length - 1];
        if (!last || typeof last !== 'object' || Array.isArray(last)) this.fail(`“${path.join('.')}” is not a table.`);
        t = last as TomlTable;
      } else if (typeof existing === 'object') {
        if (n === path.length - 1 && this.defined.has(existing)) this.fail(`The table “${path.join('.')}” is defined twice.`);
        t = existing;
      } else {
        this.fail(`“${path.join('.')}” is already a value.`);
      }
    });
    this.defined.add(t);
    return t;
  }

  private arrayTable(path: string[]): TomlTable {
    const parent = this.table(path.slice(0, -1));
    this.defined.delete(parent);
    const key = path[path.length - 1] as string;
    const existing = Object.hasOwn(parent, key) ? parent[key] : undefined;
    const next: TomlTable = {};
    if (existing === undefined) parent[key] = [next];
    else if (Array.isArray(existing)) existing.push(next);
    else this.fail(`“${path.join('.')}” is not an array of tables.`);
    return next;
  }

  private keyValue(into: TomlTable): void {
    const path = this.keyPath();
    this.ws();
    if (this.s[this.i] !== '=') this.fail('Expected = after the key.');
    this.i++;
    this.ws();
    const value = this.value();
    let t = into;
    for (const k of path.slice(0, -1)) {
      const existing = Object.hasOwn(t, k) ? t[k] : undefined;
      if (existing === undefined) { const next: TomlTable = {}; t[k] = next; t = next; }
      else if (typeof existing === 'object' && !Array.isArray(existing)) t = existing;
      else this.fail(`“${k}” is already a value.`);
    }
    const last = path[path.length - 1] as string;
    if (Object.hasOwn(t, last)) this.fail(`“${path.join('.')}” is set twice.`);
    t[last] = value;
  }

  private keyPath(): string[] {
    const path: string[] = [this.key()];
    for (;;) {
      this.ws();
      if (this.s[this.i] !== '.') return path;
      this.i++;
      this.ws();
      path.push(this.key());
    }
  }

  private key(): string {
    const c = this.s[this.i];
    let key: string;
    if (c === '"') key = this.basicString();
    else if (c === "'") key = this.literalString();
    else {
      const start = this.i;
      while (this.i < this.s.length && BARE.test(this.s[this.i] as string)) this.i++;
      if (start === this.i) this.fail('Expected a key.');
      key = this.s.slice(start, this.i);
    }
    // A project's config is written by whoever works there, agents included: a key
    // that names an object's own machinery would change every object in the core.
    if (UNSAFE_KEYS.has(key)) this.fail(`“${key}” is not allowed as a key.`);
    return key;
  }

  private value(): TomlValue {
    const c = this.s[this.i];
    if (c === '"') return this.s.startsWith('"""', this.i) ? this.multiline('"') : this.basicString();
    if (c === "'") return this.s.startsWith("'''", this.i) ? this.multiline("'") : this.literalString();
    if (c === '[') return this.array();
    if (c === '{') return this.inlineTable();
    if (this.s.startsWith('true', this.i) && !BARE.test(this.s[this.i + 4] ?? '')) { this.i += 4; return true; }
    if (this.s.startsWith('false', this.i) && !BARE.test(this.s[this.i + 5] ?? '')) { this.i += 5; return false; }
    const m = /^[0-9A-Za-z_+\-.:]+(?:[ T][0-9:.Z+-]+)?/.exec(this.s.slice(this.i, this.i + 64));
    if (!m) this.fail('Expected a value.');
    const raw = (m as RegExpExecArray)[0];
    this.i += raw.length;
    if (/^\d{4}-\d{2}-\d{2}|^\d{2}:\d{2}/.test(raw)) return raw;
    const clean = raw.replace(/_/g, '');
    if (/^[+-]?(inf|nan)$/.test(clean)) return clean.endsWith('inf') ? (clean.startsWith('-') ? -Infinity : Infinity) : NaN;
    if (/^[+-]?0x[0-9a-fA-F]+$/.test(clean)) return parseInt(clean, 16);
    if (/^[+-]?0o[0-7]+$/.test(clean)) return parseInt(clean.replace('0o', ''), 8);
    if (/^[+-]?0b[01]+$/.test(clean)) return parseInt(clean.replace('0b', ''), 2);
    if (/^[+-]?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(clean)) return Number(clean);
    this.fail(`Cannot read the value “${raw}”.`);
  }

  private array(): TomlValue[] {
    this.i++;
    const out: TomlValue[] = [];
    for (;;) {
      this.skipSpaceAndComments();
      if (this.s[this.i] === ']') { this.i++; return out; }
      out.push(this.value());
      this.skipSpaceAndComments();
      if (this.s[this.i] === ',') { this.i++; continue; }
      if (this.s[this.i] === ']') { this.i++; return out; }
      this.fail('Expected , or ] in the array.');
    }
  }

  private inlineTable(): TomlTable {
    this.i++;
    const out: TomlTable = {};
    this.skipSpaceAndComments();
    if (this.s[this.i] === '}') { this.i++; return out; }
    for (;;) {
      this.skipSpaceAndComments();
      this.keyValue(out);
      this.skipSpaceAndComments();
      if (this.s[this.i] === ',') { this.i++; this.skipSpaceAndComments(); if (this.s[this.i] === '}') { this.i++; return out; } continue; }
      if (this.s[this.i] === '}') { this.i++; return out; }
      this.fail('Expected , or } in the inline table.');
    }
  }

  private basicString(): string {
    this.i++;
    let out = '';
    for (;;) {
      const c = this.s[this.i];
      if (c === undefined || c === '\n') this.fail('A string is not closed.');
      if (c === '"') { this.i++; return out; }
      if (c === '\\') { out += this.escape(); continue; }
      out += c;
      this.i++;
    }
  }

  private literalString(): string {
    this.i++;
    const end = this.s.indexOf("'", this.i);
    if (end === -1 || this.s.slice(this.i, end).includes('\n')) this.fail('A string is not closed.');
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out;
  }

  private multiline(quote: '"' | "'"): string {
    const fence = quote.repeat(3);
    this.i += 3;
    if (this.s[this.i] === '\n') this.i++;
    let out = '';
    for (;;) {
      if (this.i >= this.s.length) this.fail('A multi-line string is not closed.');
      if (this.s.startsWith(fence, this.i)) {
        // Up to two quotes may sit just inside the closing fence.
        let extra = 0;
        while (extra < 2 && this.s[this.i + 3 + extra] === quote) extra++;
        out += quote.repeat(extra);
        this.i += 3 + extra;
        return out;
      }
      const c = this.s[this.i] as string;
      if (quote === '"' && c === '\\') {
        if (/^\\[ \t]*\n/.test(this.s.slice(this.i, this.i + 64))) {
          this.i++;
          while (/\s/.test(this.s[this.i] ?? '')) this.i++;
          continue;
        }
        out += this.escape();
        continue;
      }
      out += c;
      this.i++;
    }
  }

  private escape(): string {
    const c = this.s[this.i + 1];
    this.i += 2;
    switch (c) {
      case 'b': return '\b';
      case 't': return '\t';
      case 'n': return '\n';
      case 'f': return '\f';
      case 'r': return '\r';
      case 'e': return '\u001b';
      case '"': return '"';
      case '\\': return '\\';
      case 'u': case 'U': {
        const n = c === 'u' ? 4 : 8;
        const hex = this.s.slice(this.i, this.i + n);
        if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== n) this.fail('A \\u escape needs hex digits.');
        this.i += n;
        return String.fromCodePoint(parseInt(hex, 16));
      }
      default: this.fail(`Unknown escape \\${c ?? ''}.`);
    }
  }

  private ws(): void {
    while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++;
  }

  private skipSpaceAndComments(): void {
    for (;;) {
      while (/[ \t\n]/.test(this.s[this.i] ?? '')) this.i++;
      if (this.s[this.i] === '#') { while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++; continue; }
      return;
    }
  }

  private skipBlankLines(): void {
    this.skipSpaceAndComments();
  }

  private endOfLine(): void {
    this.ws();
    if (this.s[this.i] === '#') while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
    if (this.i < this.s.length && this.s[this.i] !== '\n') this.fail('Expected the end of the line.');
    this.i++;
  }

  private fail(message: string): never {
    throw new TomlError(message, this.s.slice(0, this.i).split('\n').length);
  }
}
