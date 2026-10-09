// Files the owner picked in the Attach dialog, read here in main so the window
// is never handed a path to ask for: only what the dialog returned is read.
// The core checks the bytes again when they are attached.
import { statSync } from 'node:fs';
import { readBoundedFile } from '../core/bounded-file.ts';
import { basename } from 'node:path';
import { ATTACH_MAX_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL, formatBytes } from '../shared/attachments.ts';
import type { PickedFiles } from '../shared/bridge.ts';

export function readPicked(paths: readonly string[]): PickedFiles {
  const files: PickedFiles['files'] = [];
  const refused: string[] = [];
  let total = 0;
  for (const path of paths.slice(0, ATTACH_MAX_FILES)) {
    const name = basename(path);
    try {
      const stat = statSync(path);
      if (!stat.isFile()) { refused.push(`${name} is not a file.`); continue; }
      if (stat.size > ATTACH_MAX_BYTES) { refused.push(`${name} is ${formatBytes(stat.size)}. A file can be at most ${formatBytes(ATTACH_MAX_BYTES)}.`); continue; }
      if (total + stat.size > ATTACH_MAX_TOTAL) { refused.push(`${name} was left out: a message can carry ${formatBytes(ATTACH_MAX_TOTAL)} of files at most.`); continue; }
      const bytes = readBoundedFile(path, Math.min(ATTACH_MAX_BYTES, ATTACH_MAX_TOTAL - total), true);
      total += bytes.length;
      files.push({ name, data: bytes.toString('base64') });
    } catch {
      refused.push(`${name} could not be read.`);
    }
  }
  if (paths.length > ATTACH_MAX_FILES) refused.push(`A message can carry ${ATTACH_MAX_FILES} files at most; the rest were left out.`);
  return { files, refused };
}
