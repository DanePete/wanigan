import { db } from './db';
import { filesIn } from '../shared/ask-items';
import { bashReads, rollupSessionFiles, toolHits, type FileRefKind, type SessionFiles } from '../shared/session-files';
import { resolve, isAbsolute } from '../shared/posix-path';
import type { HookInput, SessionEvent } from '../shared/types';

/**
 * The stored half of a session's file panel: paths a session referenced or
 * read without an edit tool, derived from the hook body while it is in memory.
 *
 * Only paths are kept. A Grep or Glob result is a list of filenames and those
 * are read; a content-mode Grep result is file content and is not. A submitted
 * prompt is scanned for path-like tokens and only the tokens are kept — the
 * prompt itself is not, the same as the timeline row, which keeps nothing of it.
 * A Bash command is read for the files cat, head or sed -n certainly read.
 *
 * Rows are keyed on the timeline event they came from and deleted on the same
 * retention window as the events (depth-retention.ts).
 */

const MAX_PROMPT_PATHS = 20;

function insert(eventId: number, sessionId: string, at: number, kind: FileRefKind, paths: string[]): void {
  if (!paths.length) return;
  const stmt = db().prepare('INSERT INTO session_file_refs (event_id, session_id, at, kind, path) VALUES (?,?,?,?,?)');
  const tx = db().transaction(() => { for (const p of paths) stmt.run(eventId, sessionId, at, kind, p.slice(0, 1000)); });
  tx();
}

/** Fed every stored hook event with its body. Never throws into the hook path. */
export function observeFileRefs(stored: SessionEvent, input: HookInput, cwd: string | null): void {
  try {
    if (stored.event === 'PostToolUse' && (stored.toolName === 'Grep' || stored.toolName === 'Glob')) {
      insert(stored.id, stored.sessionId, stored.at, stored.toolName === 'Grep' ? 'grep-hit' : 'glob-hit', toolHits(stored.toolName, input.tool_input, input.tool_response, cwd));
    } else if (stored.event === 'PostToolUse' && stored.toolName === 'Bash') {
      const command = typeof input.tool_input?.command === 'string' ? input.tool_input.command : '';
      insert(stored.id, stored.sessionId, stored.at, 'bash-read', bashReads(command, cwd));
    } else if (stored.event === 'UserPromptSubmit') {
      const prompt = (input as Record<string, unknown>).prompt;
      if (typeof prompt !== 'string') return;
      const named = filesIn(prompt).slice(0, MAX_PROMPT_PATHS)
        .map((p) => (isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null))
        .filter((p): p is string => !!p);
      insert(stored.id, stored.sessionId, stored.at, 'prompt-path', named);
    }
  } catch { /* the timeline row stands; the panel loses one reference */ }
}

function sessionIdArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('That is not a session id Wanigan knows.');
  return value;
}

export function sessionFiles(sessionIdIn: unknown): SessionFiles & { root: string | null } {
  const sessionId = sessionIdArg(sessionIdIn);
  const d = db();
  const row = d.prepare('SELECT project_path, worktree FROM session_log WHERE id = ?').get(sessionId) as { project_path: string; worktree: string | null } | undefined;
  const root = row ? row.worktree ?? row.project_path : null;
  const events = (d.prepare(`SELECT at, event, tool_name, ok, paths_json FROM session_events
    WHERE session_id = ? AND event = 'PostToolUse' AND paths_json IS NOT NULL
      AND tool_name IN ('Read','Write','Edit','MultiEdit','NotebookEdit')
    ORDER BY at ASC LIMIT 20000`).all(sessionId) as { at: number; event: string; tool_name: string; ok: number | null; paths_json: string }[])
    .map((r) => {
      let paths: string[] = [];
      try { const v: unknown = JSON.parse(r.paths_json); if (Array.isArray(v)) paths = v.filter((p): p is string => typeof p === 'string'); } catch { /* no paths */ }
      return { at: r.at, event: r.event, toolName: r.tool_name, ok: r.ok === null ? null : r.ok === 1, paths };
    });
  const refs = d.prepare('SELECT at, kind, path FROM session_file_refs WHERE session_id = ? ORDER BY at ASC LIMIT 20000').all(sessionId) as { at: number; kind: FileRefKind; path: string }[];
  return { ...rollupSessionFiles(events, refs, root), root };
}

export function pruneFileRefs(olderThanMs: number, now: number = Date.now()): number {
  const cutoff = now - Math.max(0, Number.isFinite(olderThanMs) ? olderThanMs : 0);
  return db().prepare('DELETE FROM session_file_refs WHERE at < ?').run(cutoff).changes;
}
