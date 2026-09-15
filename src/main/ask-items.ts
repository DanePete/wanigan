import { db } from './db';
import {
  earnsChecklist, hintsFor, splitAsks,
  type AskItem, type AskMessage, type AskSource, type AskTurnState, type RecordedCommand,
} from '../shared/ask-items';

/**
 * Did every ask get answered: the stored half.
 *
 * When the operator sends a message through Wanigan's composer or the phone,
 * the message is split into items (shared/ask-items.ts) and the items are kept
 * here, one row per item, against the session and the moment it was sent. At
 * the turn's Stop the Timeline shows them as a checklist with hints from the
 * recorded evidence beside each, and a tick the operator sets.
 *
 * Why keeping these items is acceptable when this app otherwise keeps no prompt
 * text (hooks.ts summarises UserPromptSubmit as nothing at all):
 *   · the operator wrote them. They are the operator's own words about what
 *     they want, not model output and not file content — the same kind of
 *     text `session_log.initial_prompt` already holds for a launch prompt;
 *   · they never leave the machine. Nothing here is sent anywhere, exported,
 *     or put in front of a model; the one path back into a session is a draft
 *     the operator reads and sends themselves;
 *   · they are pruned with events. The retention pass that deletes hook events
 *     older than `event_retention_days` deletes these on the same window
 *     (pruneAsks, called from queue.ts), so they cannot outlive the timeline
 *     they are read against.
 *
 * A message that splits into one item stores nothing: one ask is the message
 * itself, and the checklist would say nothing the turn's outcome does not.
 */

const MAX_TEXT = 20_000;
const LIST_MESSAGES = 12;
/** A UserPromptSubmit this long before the send was stamped still belongs to it: clocks, not causality. */
const PROMPT_SKEW_MS = 2_000;
/** A send with no prompt after it for this long is not waiting on one. */
const PROMPT_WAIT_MS = 10 * 60_000;
const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

function sessionIdArg(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('That is not a session id Wanigan knows.');
  return value;
}

/**
 * Record one sent message. Returns how many items were stored — zero for a
 * message that does not earn a checklist, or for a session Wanigan has no
 * record of. The text is split here and only the items are written; the
 * message as a whole is not.
 */
export function recordAsks(sessionIdIn: unknown, textIn: unknown, sourceIn: unknown, at: number = Date.now()): number {
  const sessionId = sessionIdArg(sessionIdIn);
  if (typeof textIn !== 'string' || !textIn.trim()) return 0;
  const source: AskSource = sourceIn === 'phone' ? 'phone' : 'composer';
  const items = splitAsks(textIn.slice(0, MAX_TEXT));
  if (!earnsChecklist(items)) return 0;
  const d = db();
  const known = d.prepare('SELECT 1 FROM session_log WHERE id = ?').get(sessionId);
  if (!known) return 0;
  const write = d.transaction(() => {
    const msg = d.prepare('INSERT INTO session_ask_messages (session_id, sent_at, source, item_count) VALUES (?,?,?,?)')
      .run(sessionId, at, source, items.length);
    const messageId = Number(msg.lastInsertRowid);
    const insert = d.prepare(`INSERT INTO session_ask_items (message_id, session_id, idx, text, kind, files_json, commands_json)
      VALUES (?,?,?,?,?,?,?)`);
    for (const item of items) {
      insert.run(messageId, sessionId, item.index, item.text, item.kind,
        item.files.length ? JSON.stringify(item.files) : null,
        item.commands.length ? JSON.stringify(item.commands) : null);
    }
  });
  write();
  return items.length;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

type TurnWindow = { state: AskTurnState; promptAt: number | null; stopAt: number | null; stopFailed: boolean };

/**
 * The turn a send opened: the first UserPromptSubmit at or after it (less a
 * little clock skew) and before the next send, and the first Stop after that
 * prompt and before the next prompt.
 */
function turnFor(sessionId: string, sentAt: number, nextSentAt: number | null, now: number): TurnWindow {
  const d = db();
  const until = nextSentAt ?? Number.MAX_SAFE_INTEGER;
  const prompt = d.prepare(`SELECT at FROM session_events WHERE session_id = ? AND event = 'UserPromptSubmit'
    AND at >= ? AND at < ? ORDER BY at ASC, id ASC LIMIT 1`).get(sessionId, sentAt - PROMPT_SKEW_MS, until) as { at: number } | undefined;
  if (!prompt) {
    const any = d.prepare('SELECT 1 FROM session_events WHERE session_id = ? LIMIT 1').get(sessionId);
    const gaveUp = !any || now - sentAt > PROMPT_WAIT_MS || nextSentAt !== null;
    return { state: gaveUp ? 'unobserved' : 'waiting', promptAt: null, stopAt: null, stopFailed: false };
  }
  const nextPrompt = d.prepare(`SELECT at FROM session_events WHERE session_id = ? AND event = 'UserPromptSubmit'
    AND at > ? ORDER BY at ASC, id ASC LIMIT 1`).get(sessionId, prompt.at) as { at: number } | undefined;
  const stop = d.prepare(`SELECT at, event FROM session_events WHERE session_id = ? AND event IN ('Stop','StopFailure')
    AND at >= ? AND at < ? ORDER BY at ASC, id ASC LIMIT 1`).get(sessionId, prompt.at, nextPrompt?.at ?? Number.MAX_SAFE_INTEGER) as { at: number; event: string } | undefined;
  if (!stop) return { state: 'running', promptAt: prompt.at, stopAt: null, stopFailed: false };
  return { state: 'ended', promptAt: prompt.at, stopAt: stop.at, stopFailed: stop.event === 'StopFailure' };
}

/** What the turn touched and ran, for the hints. */
function turnEvidence(sessionId: string, from: number, to: number): { touched: { path: string; via: string }[]; commands: RecordedCommand[] } {
  const d = db();
  const touched: { path: string; via: string }[] = [];
  const edits = d.prepare(`SELECT tool_name, paths_json FROM session_events WHERE session_id = ? AND at >= ? AND at <= ?
    AND event = 'PostToolUse' AND paths_json IS NOT NULL AND tool_name IN (${EDIT_TOOLS.map(() => '?').join(',')}, 'Read')
    ORDER BY at ASC, id ASC LIMIT 2000`).all(sessionId, from, to, ...EDIT_TOOLS) as { tool_name: string; paths_json: string }[];
  // Changed before read: a file both read and edited is reported as edited.
  for (const r of edits.filter((e) => e.tool_name !== 'Read')) for (const p of parseList(r.paths_json)) touched.push({ path: p, via: `changed by ${r.tool_name}` });
  for (const r of edits.filter((e) => e.tool_name === 'Read')) for (const p of parseList(r.paths_json)) touched.push({ path: p, via: 'read' });
  const shell = d.prepare(`SELECT changed_paths_json FROM session_shell_results WHERE session_id = ? AND at >= ? AND at <= ? AND changed_paths_json IS NOT NULL`)
    .all(sessionId, from, to) as { changed_paths_json: string }[];
  for (const r of shell) for (const p of parseList(r.changed_paths_json)) touched.push({ path: p, via: 'changed by a shell command (reported by Claude Code)' });
  const cmds = d.prepare(`
    SELECT e.id, e.at, e.summary, e.ok, r.outcome, r.exit_code
      FROM session_events e LEFT JOIN session_shell_results r ON r.event_id = e.id
     WHERE e.session_id = ? AND e.at >= ? AND e.at <= ? AND e.tool_name = 'Bash' AND e.event IN ('PostToolUse','PostToolUseFailure')
     ORDER BY e.at, e.id LIMIT 2000
  `).all(sessionId, from, to) as { id: number; at: number; summary: string | null; ok: number | null; outcome: string | null; exit_code: number | null }[];
  const commands = cmds.map((r) => ({
    eventId: r.id,
    at: r.at,
    command: r.summary ?? '',
    ok: r.outcome ? r.outcome === 'succeeded' : r.ok === null ? null : r.ok === 1,
    exitCode: r.exit_code,
  }));
  return { touched, commands };
}

/** A session's recorded messages with their items, newest first, each with its turn and hints. */
export function asksFor(sessionIdIn: unknown, now: number = Date.now()): AskMessage[] {
  const sessionId = sessionIdArg(sessionIdIn);
  const d = db();
  const messages = d.prepare('SELECT id, sent_at, source FROM session_ask_messages WHERE session_id = ? ORDER BY sent_at DESC, id DESC LIMIT ?')
    .all(sessionId, LIST_MESSAGES) as { id: number; sent_at: number; source: string }[];
  const out: AskMessage[] = [];
  let newer: number | null = null;
  for (const m of messages) {
    const turn = turnFor(sessionId, m.sent_at, newer, now);
    newer = m.sent_at;
    const rows = d.prepare('SELECT id, idx, text, kind, files_json, commands_json, ticked_at FROM session_ask_items WHERE message_id = ? ORDER BY idx ASC')
      .all(m.id) as { id: number; idx: number; text: string; kind: string; files_json: string | null; commands_json: string | null; ticked_at: number | null }[];
    // Hints are read only once the turn has a window to read them from.
    const evidence = turn.promptAt !== null ? turnEvidence(sessionId, turn.promptAt, turn.stopAt ?? now) : null;
    out.push({
      id: m.id,
      sessionId,
      sentAt: m.sent_at,
      source: m.source === 'phone' ? 'phone' : 'composer',
      ...turn,
      items: rows.map((r) => {
        const item: AskItem = {
          index: r.idx, text: r.text,
          kind: r.kind === 'list' || r.kind === 'question' ? r.kind : 'clause',
          files: parseList(r.files_json), commands: parseList(r.commands_json),
        };
        return { ...item, id: r.id, tickedAt: r.ticked_at, hints: evidence ? hintsFor(item, evidence.touched, evidence.commands) : null };
      }),
    });
  }
  return out;
}

/** The operator's tick. Nothing else ever sets or clears it. */
export function tickAsk(itemIdIn: unknown, tickedIn: unknown): { id: number; tickedAt: number | null } {
  const id = typeof itemIdIn === 'number' && Number.isInteger(itemIdIn) && itemIdIn > 0 ? itemIdIn : null;
  if (id === null) throw new Error('That is not an item Wanigan recorded.');
  const at = tickedIn === true ? Date.now() : null;
  const res = db().prepare('UPDATE session_ask_items SET ticked_at = ? WHERE id = ?').run(at, id);
  if (res.changes === 0) throw new Error('That item is gone; its session may have aged out of retention.');
  return { id, tickedAt: at };
}

/** Retention: items go on the same window as the hook events they are read against. */
export function pruneAsks(olderThanMs: number, now: number = Date.now()): number {
  const cutoff = now - Math.max(0, Number.isFinite(olderThanMs) ? olderThanMs : 0);
  const d = db();
  const tx = d.transaction(() => {
    const items = d.prepare('DELETE FROM session_ask_items WHERE message_id IN (SELECT id FROM session_ask_messages WHERE sent_at < ?)').run(cutoff).changes;
    d.prepare('DELETE FROM session_ask_messages WHERE sent_at < ?').run(cutoff);
    return items;
  });
  return tx();
}
