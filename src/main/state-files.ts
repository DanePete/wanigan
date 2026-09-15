import fs from 'node:fs';
import path from 'node:path';
import { mergeUnknownKeys, parseStateText } from '../shared/state-file';

/**
 * Writing Wanigan's own state and config files so that a crash, a hand edit or
 * a newer build can never cost the operator what the file held. See
 * shared/state-file.ts for the rules.
 */

/** Thrown instead of overwriting a file that does not parse. The file is untouched. */
export class StateFileRefusedError extends Error {
  readonly path: string;
  constructor(file: string, reason: string) {
    super(`Wanigan will not overwrite ${file}: it does not parse (${reason}). The file is untouched; fix or move it, then try again.`);
    this.name = 'StateFileRefusedError';
    this.path = file;
  }
}

/**
 * Write through a sibling temporary file and a rename, so a reader never sees
 * half a file and a crash leaves either the old bytes or the new ones.
 */
export function atomicWriteFile(file: string, content: string, mode = 0o600): void {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
  fs.writeFileSync(temp, content, { mode, flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* the rename is what failed */ }
    throw error;
  }
  try { fs.chmodSync(file, mode); } catch { /* the write succeeded; mode is hardening */ }
}

/**
 * Rewrite a JSON state file: refuse when the file on disk does not parse or is
 * not an object, carry forward keys this build does not know (top level and
 * inside each entry of `mapKey`), then write atomically.
 */
export function guardedStateWrite(file: string, next: Record<string, unknown>, mapKey: string, maxBytes: number): void {
  let existing: Record<string, unknown> | null = null;
  let stat: fs.Stats | null = null;
  try { stat = fs.lstatSync(file); } catch { stat = null; }
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink()) throw new StateFileRefusedError(file, 'it is not a regular file');
    if (stat.size > maxBytes) throw new StateFileRefusedError(file, `it is larger than ${maxBytes} bytes`);
    const parsed = parseStateText(fs.readFileSync(file, 'utf8'));
    if (!parsed.ok) throw new StateFileRefusedError(file, parsed.error);
    existing = parsed.value;
  }
  const merged = existing ? mergeUnknownKeys(existing, next, mapKey) : next;
  atomicWriteFile(file, `${JSON.stringify(merged, null, 2)}\n`);
}
