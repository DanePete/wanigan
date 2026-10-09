// One complete configuration request, or a fixed refusal. These are logical
// read/traversal limits, not a bound on parser heap, filesystem or SQLite work.
import { opendirSync } from 'node:fs';
import { CoreError } from '../shared/protocol.ts';
import { readBoundedFile } from './bounded-file.ts';

export interface ConfigReadLimits { files: number; bytes: number; items: number; entries: number }
const DEFAULTS: Readonly<ConfigReadLimits> = { files: 4_096, bytes: 128 * 1024 * 1024, items: 32_768, entries: 65_536 };

export class ConfigReadRefused extends CoreError {
  constructor(afterChange = false) {
    super('refused', afterChange
      ? 'Wanigan could not verify the MCP change because the configuration read limit was reached. The command may have changed the file. Check it before trying again.'
      : 'The skills or MCP configuration is too large to read completely. Reduce its sources or entries and try again.');
  }
}

/** Trusted constructor-only seam; callers cannot raise a shipped limit. */
export function configReadLimits(given: Partial<ConfigReadLimits> = {}): Readonly<ConfigReadLimits> {
  const limits = { ...DEFAULTS, ...given };
  for (const key of Object.keys(DEFAULTS) as (keyof ConfigReadLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > DEFAULTS[key]) throw new Error(`Invalid configuration ${key} limit.`);
  }
  return Object.freeze(limits);
}

export class ConfigReadBudget {
  private readonly used: ConfigReadLimits = { files: 0, bytes: 0, items: 0, entries: 0 };
  private readonly limits: Readonly<ConfigReadLimits>;
  constructor(limits: Readonly<ConfigReadLimits>) { this.limits = limits; }

  take(key: keyof ConfigReadLimits, count = 1): void {
    if (!Number.isSafeInteger(count) || count < 0 || count > this.limits[key] - this.used[key]) throw new ConfigReadRefused();
    this.used[key] += count;
  }

  read(file: string, max: number, followLinks = false): Buffer {
    // Failed/missing attempts consume work too. Descriptor admission runs before
    // allocation; the existing per-file cap and stable-read checks still apply.
    this.take('files');
    return readBoundedFile(file, max, followLinks, (size) => this.take('bytes', size));
  }

  /** Admit the parsed tree before any filtering, mapping or sorted entry array.
   * Parsing already occurred, within an admitted raw byte cap. Ignore no keys,
   * malformed rows or array values when counting; do not recurse on the JS stack. */
  value<T>(value: T, chargeStrings = false): T {
    function* children(object: object): Generator<unknown> {
      for (const key in object) if (Object.hasOwn(object, key)) yield (object as Record<string, unknown>)[key];
    }
    const stack: Iterator<unknown>[] = [[value][Symbol.iterator]()];
    while (stack.length) {
      const next = stack[stack.length - 1]!.next();
      if (next.done) { stack.pop(); continue; }
      this.take('items');
      if (chargeStrings && typeof next.value === 'string') this.take('bytes', Buffer.byteLength(next.value));
      if (next.value !== null && typeof next.value === 'object') stack.push(children(next.value));
    }
    return value;
  }

  /** Retain at most the admitted entries before sorting, including ignored ones.
   * Ordinary failures retain names()'s empty behavior unless a plugin needs its
   * existing scoped diagnostic. Refusal is never converted to an empty folder. */
  names(path: string, strict = false): string[] {
    try {
      const dir = opendirSync(path), names: string[] = [];
      let failed = false;
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
          this.take('entries'); names.push(entry.name);
        }
      } catch (error) { failed = true; throw error; }
      finally {
        try { dir.closeSync(); } catch (error) { if (!failed) throw error; }
      }
      return names.sort();
    } catch (error) {
      if (error instanceof ConfigReadRefused || strict) throw error;
      return [];
    }
  }
}
