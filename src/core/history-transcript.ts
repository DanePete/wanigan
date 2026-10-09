// Reading one CLI transcript: bounded disk reads, summaries and display turns.
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import type { AccountProvider, HistoryTranscript, HistoryTurn } from '../shared/model.ts';

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;
/** A read returns about this much text, newest kept, and looks no further back than READ_BYTES. */
const READ_CHARS = 300_000;
const READ_BYTES = 32 * 1024 * 1024;
const READ_TURNS = 2_000;
const TURN_CHARS = 12_000;
const TOOL_CHARS = 200;
const TITLE_CHARS = 90;
const PROMPT_CHARS = 280;

type Json = Record<string, unknown>;

/** Text a CLI puts into a user turn on the owner's behalf: not what they typed. */
const INJECTED = [
  '# AGENTS.md instructions', '# CLAUDE.md instructions', '<environment_context', '<user_instructions', '<system-reminder',
  '<command-name', '<command-message', '<local-command-stdout', '<local-command-caveat', '<task-notification', '[Request interrupted',
  'Caveat: The messages below were generated', 'This session is being continued from a previous conversation',
  '<bash-stdout', '<bash-stderr',
];

/** A command run with Claude Code's `!` shell mode, as the owner typed it: `! npm test`. */
function shellInput(text: string): string {
  const command = /^<bash-input>([\s\S]*?)<\/bash-input>$/.exec(text.trim())?.[1];
  return command === undefined ? text : `! ${command.trim()}`;
}

/**
 * A Talk to Wanigan message (core/chat.ts) as the owner asked it: the question,
 * without the state Wanigan sends before it. Null for any other message.
 */
function askedWanigan(text: string): string | null {
  const m = /^<wanigan-state>[\s\S]*?<\/wanigan-state>\s*(?:The owner attached [^\n]* to this message\.\s*)?The owner asks:\n?([\s\S]*)$/.exec(text.trim());
  return m ? (m[1] ?? '').trim() : null;
}

/** What the owner typed, as it reads: a Wanigan question without its state, a shell command with its `!`. */
const asTyped = (text: string): string => askedWanigan(text) ?? shellInput(text);

/** What a transcript or thread says about itself, cheaply read. */
export interface Summary {
  title: string | null;
  firstPrompt: string | null;
  startedAt: number | null;
  updatedAt: number;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  via: string | null;
  /** Copies of one Claude conversation share this. */
  lineage: string;
}

export function readTranscript(file: string, provider: AccountProvider): HistoryTranscript {
  return provider === 'claude' ? claudeTranscript(file) : codexTranscript(file);
}

/* ── reading transcripts ───────────────────────────────────────────────── */

/** Title, first prompt, folder, branch and times from the first 256 KiB and the last 64 KiB. */
export function transcriptSummary(file: string, size: number, mtimeMs: number, admitBytes?: (bytes: number) => void): Summary {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let head: Json[];
  let tail: Json[];
  try {
    if (!fstatSync(fd).isFile()) throw new Error('The transcript is not a regular file.');
    admitBytes?.(Math.min(size, HEAD_BYTES) + (size > HEAD_BYTES ? TAIL_BYTES : 0));
    head = jsonLines(readAt(fd, 0, Math.min(size, HEAD_BYTES)), false, size > HEAD_BYTES);
    tail = size > HEAD_BYTES ? jsonLines(readAt(fd, size - TAIL_BYTES, TAIL_BYTES), true, false) : [];
  } finally {
    closeSync(fd);
  }
  const s: Summary = { title: null, firstPrompt: null, startedAt: null, updatedAt: mtimeMs, cwd: null, branch: null, model: null, via: null, lineage: '' };
  let entrypoint: string | null = null;
  let wanigan = false;
  for (const l of head) {
    s.startedAt ??= time(l.timestamp);
    s.cwd ??= text(l.cwd);
    entrypoint ??= text(l.entrypoint);
    if (l.type === 'user' && !s.lineage) s.lineage = text(l.uuid) ?? '';
    if (s.firstPrompt === null && l.type === 'user') {
      const content = (l.message as Json | undefined)?.content;
      const said = typeof content === 'string' ? content : Array.isArray(content) ? (content as Json[]).find((b) => b?.type === 'text')?.text : null;
      if (typeof said === 'string' && askedWanigan(said) !== null) wanigan = true;
    }
    s.firstPrompt ??= historyText(typedPrompt(l), PROMPT_CHARS, true);
  }
  let aiTitle: string | null = null;
  let agentName: string | null = null;
  let last: number | null = null;
  for (const l of [...head, ...tail]) {
    if (l.type === 'ai-title') aiTitle = text(l.aiTitle) ?? aiTitle;
    if (l.type === 'agent-name') agentName = text(l.agentName) ?? agentName;
    s.branch = text(l.gitBranch) ?? s.branch;
    const model = l.type === 'assistant' ? text((l.message as Json | undefined)?.model) : null;
    if (model && model !== '<synthetic>') s.model = model;
    last = time(l.timestamp) ?? last;
  }
  s.title = historyText(aiTitle ?? agentName, TITLE_CHARS);
  s.updatedAt = last ?? mtimeMs;
  s.via = wanigan ? 'Talk to Wanigan'
    : entrypoint === 'claude-vscode' ? 'VS Code' : entrypoint?.startsWith('sdk') ? 'Headless' : entrypoint?.includes('desktop') ? 'Desktop' : null;
  return s;
}

/** The text of a user turn the owner typed, or null for tool results and injected context. */
function typedPrompt(l: Json): string | null {
  if (l.type !== 'user' || l.isMeta || l.isCompactSummary || l.isSidechain || l.toolUseResult) return null;
  const content = (l.message as Json | undefined)?.content;
  const value = typeof content === 'string' ? content
    : Array.isArray(content) ? (content as Json[]).find((b) => b?.type === 'text' && typeof b.text === 'string')?.text : null;
  return typeof value === 'string' && !injected(value) ? asTyped(value) : null;
}

function claudeTranscript(file: string): HistoryTranscript {
  return collect(file, (l) => {
    if (l.isSidechain || l.isMeta || l.isCompactSummary) return [];
    const at = time(l.timestamp);
    const message = l.message as Json | undefined;
    const content = message?.content;
    if (l.type === 'user' && !l.toolUseResult) {
      const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? (content as Json[]) : [];
      return blocks.flatMap((b): HistoryTurn[] => {
        if (b?.type === 'image') return [{ role: 'user', text: '[image]', at }];
        if (b?.type !== 'text' || typeof b.text !== 'string') return [];
        const command = /^<command-name>([^<]+)<\/command-name>/.exec(b.text.trim())?.[1];
        if (command) return [{ role: 'user', text: command.trim(), at }];
        return injected(b.text) || !b.text.trim() ? [] : [{ role: 'user', text: clip(asTyped(b.text).trim(), TURN_CHARS), at }];
      });
    }
    if (l.type === 'assistant' && message?.model !== '<synthetic>' && Array.isArray(content)) {
      return (content as Json[]).flatMap((b): HistoryTurn[] => {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) return [{ role: 'assistant', text: clip(b.text.trim(), TURN_CHARS), at }];
        if (b?.type === 'tool_use') return [{ role: 'tool', text: toolLine(b.name, b.input), at }];
        return [];
      });
    }
    return [];
  });
}

function codexTranscript(file: string): HistoryTranscript {
  return collect(file, (l) => {
    const p = l.payload as Json | undefined;
    const at = time(l.timestamp);
    if (l.type === 'event_msg' && p?.type === 'item_completed') {
      const item = p.item as Json | undefined;
      const role = item?.type === 'UserMessage' ? 'user' : item?.type === 'AgentMessage' ? 'assistant' : null;
      const body = role && Array.isArray(item?.content)
        ? (item.content as Json[]).map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim() : '';
      return role && body && !(role === 'user' && injected(body)) ? [{ role, text: clip(body, TURN_CHARS), at }] : [];
    }
    if (l.type === 'response_item' && (p?.type === 'function_call' || p?.type === 'custom_tool_call' || p?.type === 'local_shell_call')) {
      return [{ role: 'tool', text: toolLine(p.name ?? 'shell', p.arguments ?? p.input ?? (p.action as Json | undefined)?.command), at }];
    }
    return [];
  });
}

/** Turns from the end of a file back, until about READ_CHARS of text: the newest are what is kept. */
function collect(file: string, turnsOf: (line: Json) => HistoryTurn[]): HistoryTranscript {
  const newest: HistoryTurn[] = [];
  let chars = 0;
  const whole = eachLineFromEnd(file, READ_BYTES, (raw) => {
    const line = parse(raw);
    if (!line) return true;
    const turns = turnsOf(line);
    for (let i = turns.length - 1; i >= 0; i--) {
      const turn = turns[i] as HistoryTurn;
      const remaining = READ_CHARS - chars;
      newest.push(turn.text.length > remaining ? { ...turn, text: clip(turn.text, remaining) } : turn);
      chars += Math.min(turn.text.length, remaining);
      if (chars >= READ_CHARS || newest.length >= READ_TURNS) return false;
    }
    return chars < READ_CHARS;
  });
  return { turns: newest.reverse(), truncated: !whole };
}

/** One line per tool call: its name and the one argument that says what it did. Never its result. */
function toolLine(name: unknown, input: unknown): string {
  const args = typeof input === 'string' ? (parse(input) ?? input) : input;
  let detail = '';
  if (typeof args === 'string') detail = args;
  else if (Array.isArray(args)) detail = args.join(' ');
  else if (args && typeof args === 'object') {
    const a = args as Json;
    const value = ['command', 'cmd', 'file_path', 'path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt']
      .map((k) => a[k]).find((v) => typeof v === 'string' || Array.isArray(v));
    detail = Array.isArray(value) ? value.join(' ') : typeof value === 'string' ? value : '';
  }
  return clip(`${typeof name === 'string' ? name : 'tool'} ${detail}`.replace(/\s+/g, ' ').trim(), TOOL_CHARS);
}

/**
 * Hand each line of a file to `take`, newest first, reading back from the end
 * at most `budget` bytes. True when every line was seen.
 */
function eachLineFromEnd(file: string, budget: number, take: (line: string) => boolean): boolean {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error('The transcript is not a regular file.');
    let pos = stat.size;
    const stop = Math.max(0, pos - budget);
    // Keep a split line in reverse chunk order, joining it only once complete.
    // Rejoining (and rescanning) the growing suffix on every read is quadratic
    // for one long JSON line, even though the total disk read has a byte cap.
    let parts: Buffer[] = [];
    let length = 0;
    const takeLine = (first: Buffer): boolean => {
      if (!length) return !first.length || take(first.toString('utf8'));
      parts.push(first);
      const line = Buffer.concat(parts.reverse(), length + first.length);
      parts = [];
      length = 0;
      return take(line.toString('utf8'));
    };
    while (pos > stop) {
      const n = Math.min(1024 * 1024, pos - stop);
      pos -= n;
      const data = readAt(fd, pos, n);
      let end = data.length;
      while (end > 0) {
        const nl = data.lastIndexOf(0x0a, end - 1);
        if (nl < 0) break;
        if (!takeLine(data.subarray(nl + 1, end))) return false;
        end = nl;
      }
      if (end) {
        parts.push(data.subarray(0, end));
        length += end;
      }
    }
    if (pos > 0) return false;
    return !length || takeLine(Buffer.alloc(0));
  } finally {
    closeSync(fd);
  }
}

function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length);
  const read = readSync(fd, buffer, 0, length, position);
  return buffer.subarray(0, read);
}

/** Complete JSON lines of a chunk. A cut line at either end, or one still being written, is skipped. */
function jsonLines(chunk: Buffer, cutStart: boolean, cutEnd: boolean): Json[] {
  const lines = chunk.toString('utf8').split('\n');
  if (cutStart) lines.shift();
  if (cutEnd) lines.pop();
  return lines.map(parse).filter((l): l is Json => l !== null);
}

const injected = (value: string): boolean => {
  const t = value.trimStart();
  return INJECTED.some((m) => t.startsWith(m));
};

/** One line (or, for a prompt, all of it), whitespace collapsed, clipped. Null when empty or injected. */
export function historyText(value: unknown, max: number, whole = false): string | null {
  if (typeof value !== 'string' || injected(value)) return null;
  const line = whole ? value : value.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  const compact = line.replace(/\s+/g, ' ').trim();
  return compact ? clip(compact, max) : null;
}

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max - 1;
  const last = s.charCodeAt(end - 1);
  // A UTF-16 boundary may split a code point; leave the complete pair out.
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function time(v: unknown): number | null {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function parse(raw: string): Json | null {
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null;
  } catch {
    return null;
  }
}
