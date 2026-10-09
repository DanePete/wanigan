// The app's settings file, in Electron's userData folder, written only by this
// process. Small, read once at start, replaced atomically on every change.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { patchSettings, readSettings, type AppSettings } from '../shared/settings.ts';

export class SettingsStore {
  private current: AppSettings;
  private readonly listeners = new Set<(s: AppSettings) => void>();
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    let raw: unknown = null;
    try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { /* missing or unreadable: the defaults */ }
    this.current = readSettings(raw);
  }

  get(): AppSettings {
    return this.current;
  }

  /** Apply a patch from the window (untrusted), save it, and tell whoever listens. */
  update(patch: unknown): AppSettings {
    const next = patchSettings(this.current, patch);
    if (JSON.stringify(next) === JSON.stringify(this.current)) return this.current;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.file);
    this.current = next;
    for (const l of this.listeners) l(next);
    return next;
  }

  onChange(listener: (s: AppSettings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
