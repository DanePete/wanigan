/**
 * What a conversation was about, read out of a transcript.
 *
 * Recent showed the project name and nothing else for 97% of rows on the
 * machine this was written for — 154 conversations, 5 of them named — because
 * a session's `title` is only ever set by somebody renaming it by hand. Four
 * rows reading "vincent · claude-code · opus" describe four different pieces of
 * work identically.
 *
 * What tells them apart is already on disk. Claude Code writes an `ai-title`
 * record into its own transcript and keeps it current; both harnesses record
 * the prompt the person actually typed. So this is a read, not a write: no
 * model is asked anything, nothing is summarised, and a conversation that kept
 * neither record keeps its null rather than receiving a name Wanigan invented.
 *
 * Pure on purpose — the file handling, the head bound and the cache live in
 * `main/transcripts.ts`, and everything decidable from text is decided here so
 * it can be tested in a tenth of a second.
 */
import type { SessionTitleSource } from './types.ts';

/** The two a transcript can supply. `named` is the row's own and never read. */
export type TitleSource = Exclude<SessionTitleSource, 'named'>;
export type ReadTitle = { title: string; source: TitleSource } | null;

/** A name is a label, not a paragraph. */
export const TITLE_MAX_CHARS = 90;

/**
 * Text a CLI injects on the person's behalf, which is not what they typed.
 *
 * Codex replays the project's `AGENTS.md` into the rollout as a user message,
 * and either harness may open with an environment block or a resumed-session
 * caveat. A twelve-thousand-character instruction file is a perfectly valid
 * user turn and a uselessly wrong name for the work — and worse, an identical
 * one on every conversation in the same repository, which is the exact failure
 * this is meant to fix.
 */
export const INJECTED = [
  '# AGENTS.md instructions',
  '# CLAUDE.md instructions',
  '<environment_context',
  '<user_instructions',
  '<system-reminder',
  '<command-name',
  '<local-command-stdout',
  '<task-notification',
  'Caveat: The messages below were generated',
  'This session is being continued from a previous conversation',
];

/** One line, whitespace collapsed, bounded — the shape a hand-set name has. */
export function tidyTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (INJECTED.some((marker) => trimmed.startsWith(marker))) return null;
  const line = trimmed.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  const compact = line.replace(/\s+/g, ' ').trim();
  if (!compact) return null;
  return compact.length > TITLE_MAX_CHARS ? `${compact.slice(0, TITLE_MAX_CHARS - 1)}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The text of a user turn, in either harness's shape. */
function userText(raw: Record<string, unknown>): string | null {
  // Claude: {"type":"user","message":{"content":"…" | [{"type":"text","text":"…"}]}}
  // Codex:  {"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"…"}]}}
  const message = raw.type === 'user' ? raw.message
    : raw.type === 'response_item' && isRecord(raw.payload)
      && raw.payload.type === 'message' && raw.payload.role === 'user' ? raw.payload
      : null;
  if (!isRecord(message)) return null;
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (isRecord(part) && typeof part.text === 'string') return part.text;
  }
  return null;
}

/**
 * A name for one transcript, from its opening text.
 *
 * Both harnesses write JSONL and their records are disjoint, so one walker
 * reads either without having to be told which it was handed. The agent's own
 * title wins where there is one, because it is what that agent itself displays
 * and it stays current as the work moves on; otherwise the first real thing the
 * person typed, which is at least what they asked for.
 *
 * A partial trailing line is expected — the caller passes a bounded head, and a
 * live session is being appended to while this runs — so an unparseable line is
 * skipped rather than treated as the end of the data.
 */
export function titleFromTranscriptText(text: string): ReadTitle {
  let agent: string | null = null;
  let prompt: string | null = null;
  for (const line of text.split('\n')) {
    if (!line.startsWith('{')) continue;
    let row: unknown;
    try { row = JSON.parse(line) as unknown; } catch { continue; }
    if (!isRecord(row)) continue;
    // The agent rewrites its title as a conversation develops, so the last one
    // in hand is the one it currently stands behind.
    if (row.type === 'ai-title' && typeof row.aiTitle === 'string') {
      const named = tidyTitle(row.aiTitle);
      if (named) agent = named;
      continue;
    }
    if (!prompt) prompt = tidyTitle(userText(row));
  }
  if (agent) return { title: agent, source: 'agent' };
  return prompt ? { title: prompt, source: 'prompt' } : null;
}
