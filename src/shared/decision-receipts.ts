/** Bounded, main-owned decisions. A caller receives an opaque id, never authority to supply a decision. */
export class DecisionReceipts<T> {
  private readonly entries = new Map<string, { binding: string; expiresAt: number; value: T }>();
  private readonly ttlMs: number;
  private readonly maximum: number;
  constructor(ttlMs = 15 * 60_000, maximum = 32) { this.ttlMs = ttlMs; this.maximum = maximum; }

  put(id: string, binding: string, value: T, now: number): number {
    this.prune(now);
    this.entries.delete(id);
    while (this.entries.size >= this.maximum) this.entries.delete(this.entries.keys().next().value!);
    const expiresAt = now + this.ttlMs;
    this.entries.set(id, { binding, expiresAt, value: structuredClone(value) });
    return expiresAt;
  }

  read(id: unknown, binding: string, now: number): T {
    this.prune(now);
    if (typeof id !== 'string' || id.length > 100) throw new Error('Preview these choices again before creating the relay.');
    const entry = this.entries.get(id);
    if (!entry) throw new Error('This preview expired or was already used. Preview the choices again before creating the relay.');
    if (entry.binding !== binding) throw new Error('The prompt, choices or available models changed. Preview the choices again before creating the relay.');
    return structuredClone(entry.value);
  }

  remove(id: string): void { this.entries.delete(id); }
  private prune(now: number): void {
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}
