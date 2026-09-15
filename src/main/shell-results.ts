import { db } from './db';
import type { HookInput } from '../shared/types';

/**
 * What a Bash tool call came to: whether it succeeded, its exit code when the
 * CLI said, and — from Claude Code 2.1.269 with `bashEditDiffEnabled` on — the
 * files the command changed.
 *
 * The timeline row keeps the command and a boolean; this keeps the two facts a
 * review needs beside it. The exit code comes from the only place the CLI
 * states one: a failed Bash call's `error` begins "Exit code N" (read off the
 * 2.1.271 binary, where the Bash tool builds that string). A successful call
 * carries no number, and none is invented for it — "succeeded" is what the
 * record says.
 *
 * The changed-file list is `tool_response.bashEditDiff.changedFiles`: absolute
 * paths, at most 200, which the CLI's own schema describes as "every changed
 * file known, shown or not". The CLI computes it by snapshotting the git
 * working tree around the command, so it names changes the command made and
 * also anything else that changed the tree while it ran; the label that reads
 * this says "reported by Claude Code" for that reason. Nothing else from the
 * response is read: its hunks are file content, and Wanigan does not store it.
 */

const MAX_CHANGED = 200;
const MAX_PATH = 1_000;
const PRUNE_EVERY = 200;

export type ShellOutcome = 'succeeded' | 'failed' | 'interrupted';
export type ShellDiffState = 'reported' | 'unavailable' | 'skipped' | 'absent';

export type ShellResult = {
  eventId: number;
  sessionId: string;
  at: number;
  outcome: ShellOutcome;
  exitCode: number | null;
  changedPaths: string[];
  diffState: ShellDiffState;
};

let inserts = 0;

/** The changed-file report on a Bash response, or why there is not one. */
export function bashChangedFiles(response: unknown): { state: ShellDiffState; paths: string[] } {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return { state: 'absent', paths: [] };
  const diff = (response as Record<string, unknown>).bashEditDiff;
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return { state: 'absent', paths: [] };
  const record = diff as Record<string, unknown>;
  const listed = Array.isArray(record.changedFiles) ? record.changedFiles : [];
  const files = Array.isArray(record.files) ? record.files : [];
  const paths = new Set<string>();
  for (const p of listed) if (typeof p === 'string' && p && p.length <= MAX_PATH) paths.add(p);
  // Older builds of the field carried only `files`; each names a filePath.
  for (const f of files) {
    const p = f && typeof f === 'object' ? (f as Record<string, unknown>).filePath : null;
    if (typeof p === 'string' && p && p.length <= MAX_PATH) paths.add(p);
  }
  const capped = [...paths].slice(0, MAX_CHANGED);
  if (record.skipped === true) return { state: 'skipped', paths: capped };
  if (record.unavailable === true && capped.length === 0) return { state: 'unavailable', paths: [] };
  return { state: 'reported', paths: capped };
}

/** "Exit code 2" at the start of a failed call's error, and nothing else. */
export function exitCodeFromError(error: unknown): number | null {
  if (typeof error !== 'string') return null;
  const m = /^\s*Exit code (\d{1,3})\b/.exec(error);
  return m ? Number(m[1]) : null;
}

/**
 * Called by the hook store after the timeline row is written, for Bash results
 * only. Failure here must never fail the agent's tool call.
 */
export function recordShellResult(sessionId: string, eventId: number, event: string, input: HookInput, at: number): void {
  if (input.tool_name !== 'Bash') return;
  if (event !== 'PostToolUse' && event !== 'PostToolUseFailure') return;
  try {
    const raw = input as Record<string, unknown>;
    let outcome: ShellOutcome = 'succeeded';
    let exitCode: number | null = null;
    let diff: { state: ShellDiffState; paths: string[] } = { state: 'absent', paths: [] };
    if (event === 'PostToolUseFailure') {
      outcome = raw.is_interrupt === true ? 'interrupted' : 'failed';
      exitCode = exitCodeFromError(raw.error);
    } else {
      const response = input.tool_response;
      if (response && typeof response === 'object' && (response as Record<string, unknown>).interrupted === true) outcome = 'interrupted';
      diff = bashChangedFiles(response);
    }
    db().prepare(`INSERT OR REPLACE INTO session_shell_results (event_id, session_id, at, outcome, exit_code, changed_paths_json, diff_state)
      VALUES (?,?,?,?,?,?,?)`).run(eventId, sessionId, at, outcome, exitCode, diff.paths.length ? JSON.stringify(diff.paths) : null, diff.state);
    inserts += 1;
    if (inserts % PRUNE_EVERY === 0) pruneShellResults();
  } catch {
    // The timeline row stands; losing this detail costs a label, not a session.
  }
}

/** Rows whose timeline event has aged out go with it. */
export function pruneShellResults(): number {
  try {
    const oldest = db().prepare('SELECT MIN(at) AS at FROM session_events').get() as { at: number | null } | undefined;
    if (oldest?.at == null) return db().prepare('DELETE FROM session_shell_results').run().changes;
    return db().prepare('DELETE FROM session_shell_results WHERE at < ?').run(oldest.at).changes;
  } catch { return 0; }
}

/**
 * A session's Bash calls in the order they ran: the command as the timeline
 * summarised it (the first 160 characters), and the outcome recorded here when
 * there is one. A PostToolUse from before this table existed still counts as
 * succeeded, because the timeline's own `ok` says so.
 */
export function shellCommands(sessionId: string, limit = 500): { eventId: number; at: number; command: string; ok: boolean | null; exitCode: number | null; outcome: ShellOutcome | null }[] {
  const rows = db().prepare(`
    SELECT e.id, e.at, e.summary, e.ok, r.outcome, r.exit_code
      FROM session_events e LEFT JOIN session_shell_results r ON r.event_id = e.id
     WHERE e.session_id = ? AND e.tool_name = 'Bash' AND e.event IN ('PostToolUse','PostToolUseFailure')
     ORDER BY e.at, e.id LIMIT ?
  `).all(sessionId, Math.max(1, Math.min(5_000, limit))) as { id: number; at: number; summary: string | null; ok: number | null; outcome: string | null; exit_code: number | null }[];
  return rows.map((r) => ({
    eventId: r.id,
    at: r.at,
    command: r.summary ?? '',
    ok: r.outcome ? r.outcome === 'succeeded' : r.ok === null ? null : r.ok === 1,
    exitCode: r.exit_code,
    outcome: (r.outcome as ShellOutcome | null) ?? null,
  }));
}

/** Every path any Bash result of this session reported changing, absolute, de-duplicated. */
export function shellChangedPaths(sessionId: string): string[] {
  const rows = db().prepare('SELECT changed_paths_json FROM session_shell_results WHERE session_id = ? AND changed_paths_json IS NOT NULL')
    .all(sessionId) as { changed_paths_json: string }[];
  const out = new Set<string>();
  for (const r of rows) {
    try {
      const parsed: unknown = JSON.parse(r.changed_paths_json);
      if (Array.isArray(parsed)) for (const p of parsed) if (typeof p === 'string') out.add(p);
    } catch { /* a corrupt row costs its paths */ }
  }
  return [...out];
}

/** Whether any Bash result of this session carried the CLI's changed-file report at all. */
export function shellDiffReported(sessionId: string): boolean {
  const row = db().prepare("SELECT 1 FROM session_shell_results WHERE session_id = ? AND diff_state IN ('reported','skipped') LIMIT 1").get(sessionId);
  return !!row;
}
