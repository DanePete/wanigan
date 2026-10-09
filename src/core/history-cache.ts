// History caches are optional accelerators, never an inventory of conversations.
// These budgets bound retained entries/rows and accounted string/binary payload,
// not exact VM heap size, discovery work, transient results or SQLite snapshots.

/** Strings are charged as UTF-16; binary views charge their entire backing
 * store, even when a small slice would otherwise keep a larger buffer alive.
 * Unknown value shapes bypass caching rather than changing a History result. */
export function historyPayloadBytes(values: Iterable<unknown>): number {
  let bytes = 0;
  for (const value of values) {
    if (typeof value === 'string') bytes += value.length * 2;
    else if (ArrayBuffer.isView(value)) bytes += value.buffer.byteLength;
    else if (value !== null && value !== undefined && typeof value !== 'number' && typeof value !== 'boolean') return Infinity;
  }
  return bytes;
}

/** Least-recently-used retention. An oversized replacement drops the old value
 * and is simply not retained; the caller still uses its freshly read value. */
export class HistoryCache<T> {
  private readonly entries = new Map<string, { value: T; units: number; bytes: number }>();
  private units = 0;
  private bytes = 0;
  private readonly limits: { entries: number; units: number; bytes: number };

  constructor(limits: { entries: number; units: number; bytes: number }) { this.limits = limits; }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, units: number, payloadBytes: number): void {
    this.delete(key);
    const bytes = key.length * 2 + payloadBytes;
    if (!Number.isSafeInteger(units) || units < 0 || !Number.isSafeInteger(bytes) || bytes < 0
      || units > this.limits.units || bytes > this.limits.bytes) return;
    while (this.entries.size >= this.limits.entries || this.units + units > this.limits.units || this.bytes + bytes > this.limits.bytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, units, bytes });
    this.units += units; this.bytes += bytes;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.units -= entry.units; this.bytes -= entry.bytes;
  }

  prune(keep: (key: string, value: T) => boolean): void {
    for (const [key, entry] of this.entries) if (!keep(key, entry.value)) this.delete(key);
  }
}
