import fs from 'node:fs';
import { db } from './db';
import { exactTranscriptPath } from './transcripts';
import { boundaryOf, compactionMarks, type CompactionMark, type TranscriptBoundary } from '../shared/compaction';

/**
 * Compaction dividers for one session's Timeline: its PreCompact/PostCompact
 * hook rows, joined to the compact_boundary lines in its Claude Code transcript
 * for the token counts only the transcript records.
 *
 * The transcript is read, never written, and only lines that contain the
 * literal `"compact_boundary"` are parsed, so a long conversation costs a
 * substring scan rather than a JSON parse per line. The archived copy is used
 * when the CLI's own file is gone.
 */

const CHUNK = 1024 * 1024;
const MAX_SCAN_BYTES = 512 * 1024 * 1024;
const NEEDLE = '"compact_boundary"';

function scanBoundaries(file: string): TranscriptBoundary[] {
  let fd: number;
  try { fd = fs.openSync(file, 'r'); } catch { return []; }
  const out: TranscriptBoundary[] = [];
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - MAX_SCAN_BYTES);
    const buf = Buffer.alloc(CHUNK);
    let carry = '';
    for (let pos = start; pos < size;) {
      const read = fs.readSync(fd, buf, 0, CHUNK, pos);
      if (read <= 0) break;
      pos += read;
      const text = carry + buf.subarray(0, read).toString('utf8');
      const lines = text.split('\n');
      carry = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes(NEEDLE)) continue;
        try { const b = boundaryOf(JSON.parse(line)); if (b) out.push(b); } catch { /* a damaged line is not a boundary */ }
      }
    }
    if (carry.includes(NEEDLE)) { try { const b = boundaryOf(JSON.parse(carry)); if (b) out.push(b); } catch { /* partial line */ } }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

function sessionIdArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('That is not a session id Wanigan knows.');
  return value;
}

export function compactionsFor(sessionIdIn: unknown): { marks: CompactionMark[]; transcript: 'live' | 'archived' | 'none' } {
  const sessionId = sessionIdArg(sessionIdIn);
  const d = db();
  const events = d.prepare(`SELECT id, at, event, summary FROM session_events WHERE session_id = ? AND event IN ('PreCompact','PostCompact') ORDER BY at ASC LIMIT 2000`)
    .all(sessionId) as { id: number; at: number; event: string; summary: string | null }[];
  const row = d.prepare('SELECT conversation_id, project_path, worktree FROM session_log WHERE id = ?').get(sessionId) as
    { conversation_id: string | null; project_path: string; worktree: string | null } | undefined;
  let transcript: 'live' | 'archived' | 'none' = 'none';
  let boundaries: TranscriptBoundary[] = [];
  const live = row ? exactTranscriptPath(row.worktree ?? row.project_path, row.conversation_id) : null;
  if (live) { boundaries = scanBoundaries(live); transcript = 'live'; }
  else {
    const archived = d.prepare('SELECT stored_path FROM transcripts WHERE session_id = ?').get(sessionId) as { stored_path: string } | undefined;
    if (archived?.stored_path && fs.existsSync(archived.stored_path)) { boundaries = scanBoundaries(archived.stored_path); transcript = 'archived'; }
  }
  return { marks: compactionMarks(events, boundaries), transcript };
}
