/**
 * Copying text out of a session, and quoting it back in: the pure half.
 *
 * Nothing here reads a disk or a clipboard. Main reads the transcript or the
 * rollout and hands the text in; the renderer hands in a selection. What is
 * decided here is which words are "the last response", what a transcript looks
 * like as Markdown, and what a quote looks like in a message box — each a rule
 * a person would notice being wrong.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function jsonLines(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a cut first line or a damaged record is skipped */ }
  }
  return out;
}

/**
 * The last thing Claude said, from a Claude Code transcript.
 *
 * Claude Code writes one JSONL line per content block, and the blocks of one
 * API message share `message.id`. The last response is the text blocks of the
 * newest assistant message that has any text, joined in the order written —
 * not the whole turn, which would glue a "Let me check" from before a tool
 * call onto the answer after it. Sidechain lines are a subagent talking in its
 * own context and are skipped. Thinking and tool blocks carry no response text.
 */
export function lastResponseFromClaudeJsonl(text: string): string | null {
  const lines = jsonLines(text);
  let targetId: string | null = null;
  const parts: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!isRecord(raw) || raw.isSidechain === true) continue;
    const msg = raw.message;
    if (!isRecord(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const id = typeof msg.id === 'string' ? msg.id : `line-${i}`;
    const texts = msg.content
      .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'text' && typeof b.text === 'string' && !!b.text.trim())
      .map((b) => String(b.text));
    if (targetId === null) {
      if (!texts.length) continue;
      targetId = id;
    } else if (id !== targetId) {
      break;
    }
    parts.unshift(...texts);
  }
  const joined = parts.join('\n\n').trim();
  return joined || null;
}

/**
 * The last thing Codex said, from a Codex rollout.
 *
 * Read off the rollouts on this machine (Codex 0.153.4): an assistant reply is
 * a `response_item` whose payload is a `message` with role `assistant` and
 * `output_text` blocks, and each finished turn also writes an `event_msg`
 * `task_complete` carrying `last_agent_message`. Whichever is newer in the
 * file answers; a rollout with neither answers null.
 */
export function lastResponseFromCodexRollout(text: string): string | null {
  const lines = jsonLines(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (!isRecord(raw) || !isRecord(raw.payload)) continue;
    const payload = raw.payload;
    if (raw.type === 'response_item' && payload.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
      const joined = payload.content
        .filter((b): b is Record<string, unknown> => isRecord(b) && b.type === 'output_text' && typeof b.text === 'string')
        .map((b) => String(b.text)).join('\n\n').trim();
      if (joined) return joined;
    }
    if (raw.type === 'event_msg' && payload.type === 'task_complete' && typeof payload.last_agent_message === 'string'
      && payload.last_agent_message.trim()) {
      return payload.last_agent_message.trim();
    }
  }
  return null;
}

/* ── a transcript as Markdown ─────────────────────────────────────────── */

export type MarkdownTurn = { at: number; role: 'user' | 'assistant' | 'system' | 'tool'; text: string; toolName?: string };

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * An archived conversation as Markdown: who spoke, what they said, and each
 * tool step collapsed to one line. Tool results are counted, not pasted — a
 * 200 KB file dump is not something a person copying a conversation wants in
 * their clipboard, and it is the likeliest place for a secret to be. The
 * caller redacts the whole document after this, so nothing here is trusted to
 * catch a credential.
 */
export function transcriptToMarkdown(turns: readonly MarkdownTurn[], meta: { title: string; note?: string | null }): string {
  const out: string[] = [`# ${oneLine(meta.title, 200)}`, ''];
  if (meta.note) out.push(`> ${oneLine(meta.note, 400)}`, '');
  let lastWasTool = false;
  for (const turn of turns) {
    if (turn.role === 'tool') {
      const line = turn.toolName
        ? `- Tool call: \`${oneLine(turn.toolName, 60)}\``
        : `- Tool result: ${turn.text.trim() ? `${turn.text.length.toLocaleString('en-US')} characters, omitted` : 'empty'}`;
      if (!lastWasTool) out.push('');
      out.push(line);
      lastWasTool = true;
      continue;
    }
    if (lastWasTool) out.push('');
    lastWasTool = false;
    const who = turn.role === 'user' ? 'You' : turn.role === 'assistant' ? 'Agent' : 'System';
    const when = Number.isFinite(turn.at) && turn.at > 0 ? ` · ${new Date(turn.at).toISOString().replace('T', ' ').slice(0, 16)} UTC` : '';
    out.push(`## ${who}${when}`, '', turn.text.trim(), '');
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/* ── a quote in a message box ─────────────────────────────────────────── */

/** Longest quote put into a draft. A composer holds 100,000 characters; a quote should not take all of them. */
export const QUOTE_MAX_CHARS = 20_000;

/**
 * Selected text as a Markdown blockquote. Terminal selections carry the padding
 * of every cell to the right edge, so trailing spaces go; leading and trailing
 * blank lines go; an empty line inside the quote stays a quote line (`>`), so
 * the quote does not split into two. Control characters are removed — a
 * selection copied off a TUI can carry them, and a message box is the wrong
 * place to hand one back to an agent.
 */
export function quoteAsMarkdown(selection: string): { text: string; truncated: boolean } | null {
  const cleaned = selection
    .replace(/\r\n?/g, '\n')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const lines = cleaned.split('\n').map((l) => l.replace(/\s+$/, ''));
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return null;
  let body = lines.join('\n');
  const truncated = body.length > QUOTE_MAX_CHARS;
  if (truncated) body = `${body.slice(0, QUOTE_MAX_CHARS)}…`;
  return { text: body.split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n'), truncated };
}

/* ── fenced mermaid blocks ────────────────────────────────────────────── */

export type TextSegment = { kind: 'text'; text: string } | { kind: 'mermaid'; source: string; closed: boolean };

/**
 * Split a message into prose and fenced ```mermaid blocks, in order. Only
 * mermaid fences are pulled out; every other fence stays in the prose exactly
 * as written. An unclosed fence runs to the end and says so, because a block
 * that was cut off is not a diagram anyone can trust.
 */
export function splitMermaid(text: string): TextSegment[] {
  const out: TextSegment[] = [];
  const lines = text.split('\n');
  let prose: string[] = [];
  let i = 0;
  const flush = () => { if (prose.length) out.push({ kind: 'text', text: prose.join('\n') }); prose = []; };
  while (i < lines.length) {
    const open = /^\s{0,3}(`{3,}|~{3,})\s*mermaid\s*$/i.exec(lines[i]);
    if (!open) { prose.push(lines[i]); i++; continue; }
    const fence = open[1];
    const body: string[] = [];
    let closed = false;
    i++;
    while (i < lines.length) {
      const close = new RegExp(`^\\s{0,3}${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).exec(lines[i]);
      if (close) { closed = true; i++; break; }
      body.push(lines[i]);
      i++;
    }
    flush();
    out.push({ kind: 'mermaid', source: body.join('\n'), closed });
  }
  flush();
  return out;
}
