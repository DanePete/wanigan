// Tokens a session's conversation used, read from the agent's own record:
// Claude Code's transcript and its subagents' (`<transcript dir>/<id>/subagents/
// agent-*.jsonl`, 2.1.292), or the Codex thread's rollout. Read-only. A record
// normally grows, so reads are incremental. Replacement, shrinkage, or changed
// metadata at the same size resets the cache. A same-stamp rewrite or a changed
// prefix that also grows cannot be distinguished from append by this metadata.
//
// A Codex session is counted once its own hook has said which thread it is on
// (sessions.ts). Guessing a thread by folder and time would be a guess.
//
// A Gemini CLI session is counted from the chat file its own BeforeAgent hook
// named (`transcript_path`), and only when that file is inside Wanigan's Gemini
// home: a hook names a path, and Wanigan reads no other. Its subagents' chats
// sit in a folder named for the conversation beside it.
import { realpathSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
import type { Account, Session } from '../shared/model.ts';
import type { CardTokens, SessionTokens } from '../shared/protocol.ts';
import { CodexTally, GeminiTally, mergeUsage, UsageTally, type ConversationUsage } from '../shared/tokens.ts';
import { rolloutIn, transcriptPath, type Accounts } from './accounts.ts';

type Json = Record<string, unknown>;

/** How far a transcript has been read: always to the end of a whole line. */
interface Seen { offset: number; kept: Json[]; size: number; dev: number; ino: number; mtimeMs: number; ctimeMs: number }

const CHUNK = 4 * 1024 * 1024;
const MAX_SUBAGENTS = 200;
/** Transcripts kept in memory: a core runs for weeks, and every session's would otherwise stay. */
export const MAX_FILES = 256;

export const CODEX_UNCOUNTED = 'Codex hasn’t said which thread this session is on, so its tokens aren’t counted.';
export const GEMINI_UNCOUNTED = 'Gemini CLI named a chat file outside Wanigan’s Gemini home, so its tokens aren’t counted.';

export class Tokens {
  private readonly files = new Map<string, Seen>();
  /** The read of each file under way, so the next waits for it. */
  private readonly reading = new Map<string, Promise<Json[]>>();
  private readonly accounts: Accounts;
  /** Wanigan's Gemini home (GEMINI_CLI_HOME): the only place a Gemini chat is read from. */
  private readonly geminiHome: string | null;

  constructor(accounts: Accounts, geminiHome: string | null = null) {
    this.accounts = accounts;
    this.geminiHome = geminiHome;
  }

  async ofSession(session: Session): Promise<SessionTokens> {
    if (session.provider === 'shell') return { usage: null, note: null };
    if (session.provider === 'codex') {
      if (!session.conversationId) return { usage: null, note: CODEX_UNCOUNTED };
      const rollout = await this.rollout(session);
      return { usage: rollout ? await this.codexUsage(rollout) : null, note: null };
    }
    if (session.provider === 'gemini') {
      // Before its first prompt Gemini has spent nothing and named no file.
      if (!session.transcriptPath) return { usage: null, note: null };
      const chats = await this.geminiChats(session);
      if (chats === 'outside') return { usage: null, note: GEMINI_UNCOUNTED };
      return { usage: chats ? await this.geminiUsage(chats) : null, note: null };
    }
    const files = await this.transcripts(session);
    // Nothing saved yet is nothing to count, not a failure to count.
    if (!files) return { usage: null, note: null };
    const tally = new UsageTally();
    await this.feed(tally, files);
    return { usage: tally.total(), note: null };
  }

  /** Every conversation run on a card, each Claude reply and each Codex rollout once however many sessions shared it. */
  async ofCard(sessions: Session[]): Promise<CardTokens> {
    const tally = new UsageTally();
    const read = new Set<string>();
    let codex: ConversationUsage | null = null;
    let claude = false;
    let counted = 0;
    let uncounted = 0;
    let gemini: ConversationUsage | null = null;
    const geminiTally = new GeminiTally();
    for (const s of sessions) {
      if (s.provider === 'shell') continue;
      if (s.provider === 'gemini') {
        const chats = await this.geminiChats(s);
        if (!chats || chats === 'outside') { uncounted++; continue; }
        counted++;
        // A resumed conversation writes on in the same file: each reply once, by id.
        await this.feedGemini(geminiTally, { main: read.has(chats.main) ? null : chats.main, subagents: chats.subagents.filter((f) => !read.has(f)) });
        for (const f of [chats.main, ...chats.subagents]) read.add(f);
        gemini = geminiTally.total();
        continue;
      }
      if (s.provider === 'codex') {
        const rollout = await this.rollout(s);
        if (!rollout) { uncounted++; continue; }
        counted++;
        if (!read.has(rollout)) codex = mergeUsage(codex, await this.codexUsage(rollout));
        read.add(rollout);
        continue;
      }
      const files = await this.transcripts(s);
      if (!files) { uncounted++; continue; }
      counted++;
      claude = true;
      const fresh = { main: read.has(files.main) ? null : files.main, subagents: files.subagents.filter((f) => !read.has(f)) };
      for (const f of [files.main, ...files.subagents]) read.add(f);
      await this.feed(tally, fresh);
    }
    return { usage: counted ? mergeUsage(mergeUsage(claude ? tally.total() : null, codex), gemini) : null, sessions: counted, uncounted };
  }

  /**
   * The chat file a Gemini session's hook named, and its subagents' chats.
   * Null while it does not exist (nothing saved, nothing spent); 'outside'
   * when it is not a chat file inside Wanigan's Gemini home, which is never read.
   */
  private async geminiChats(s: Session): Promise<{ main: string; subagents: string[] } | 'outside' | null> {
    if (!this.geminiHome || !s.transcriptPath) return null;
    let main: string;
    try { main = realpathSync(s.transcriptPath); } catch { return null; }
    let tmp: string;
    try { tmp = realpathSync(join(this.geminiHome, '.gemini', 'tmp')); } catch { return 'outside'; }
    if (!main.endsWith('.jsonl') || !main.startsWith(tmp + sep) || !(await stat(main).then((f) => f.isFile(), () => false))) return 'outside';
    const dir = s.conversationId ? join(dirname(main), s.conversationId) : null;
    const names = dir ? await readdir(dir).catch(() => [] as string[]) : [];
    const subagents = names.filter((n) => n.endsWith('.jsonl')).sort().slice(0, MAX_SUBAGENTS).map((n) => join(dir as string, n));
    return { main, subagents };
  }

  private async geminiUsage(chats: { main: string; subagents: string[] }): Promise<ConversationUsage> {
    const tally = new GeminiTally();
    await this.feedGemini(tally, chats);
    return tally.total();
  }

  private async feedGemini(tally: GeminiTally, files: { main: string | null; subagents: string[] }): Promise<void> {
    if (files.main) for (const l of await this.lines(files.main, geminiLine)) tally.add(l, true);
    for (const f of files.subagents) {
      const replies = await this.lines(f, geminiLine);
      if (replies.length) tally.subagents++;
      for (const l of replies) tally.add(l, false);
    }
  }

  /** The rollout of the Codex thread a session is on, inside its account's CODEX_HOME, once it exists. */
  private async rollout(s: Session): Promise<string | null> {
    if (!s.conversationId) return null;
    const file = rolloutIn(this.accounts.folder('codex', this.account(s)), s.conversationId, s.transcriptPath);
    return file && await stat(file).then((f) => f.isFile(), () => false) ? file : null;
  }

  private async codexUsage(rollout: string): Promise<ConversationUsage> {
    const tally = new CodexTally();
    for (const l of await this.lines(rollout, codexLine)) tally.add(l);
    return tally.total();
  }

  private account(s: Session): Account | null {
    return s.accountId ? this.accounts.list().find((a) => a.id === s.accountId) ?? null : null;
  }

  private async transcripts(s: Session): Promise<{ main: string; subagents: string[] } | null> {
    if (!s.conversationId || !s.cwd) return null;
    const main = transcriptPath(this.accounts.folder('claude', this.account(s)), s.cwd, s.conversationId);
    if (!main) return null;
    const dir = join(dirname(main), s.conversationId, 'subagents');
    const names = await readdir(dir).catch(() => [] as string[]);
    const subagents = names.filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl')).sort().slice(0, MAX_SUBAGENTS).map((n) => join(dir, n));
    return { main, subagents };
  }

  private async feed(tally: UsageTally, files: { main: string | null; subagents: string[] }): Promise<void> {
    if (files.main) for (const l of await this.lines(files.main, usageLine)) tally.add(l, true);
    for (const f of files.subagents) {
      const replies = await this.lines(f, usageLine);
      if (replies.length) tally.subagents++;
      for (const l of replies) tally.add(l, false);
    }
  }

  /**
   * The lines of one record that `pick` keeps, reading only what was added
   * since last time. Reads of one file take turns: two at once would both add
   * the new lines to the cache, and Codex's repeated running total would then
   * read as a restart and be counted twice.
   */
  private lines(file: string, pick: (line: string) => Json | null): Promise<Json[]> {
    const read = (this.reading.get(file) ?? Promise.resolve([])).catch(() => []).then(() => this.readLines(file, pick));
    this.reading.set(file, read);
    void read.finally(() => { if (this.reading.get(file) === read) this.reading.delete(file); }).catch(() => {});
    return read;
  }

  private async readLines(file: string, pick: (line: string) => Json | null): Promise<Json[]> {
    const info = await stat(file).catch(() => null);
    if (!info) { this.files.delete(file); return []; }
    const { size, dev, ino, mtimeMs, ctimeMs } = info;
    const observed = { size, dev, ino, mtimeMs, ctimeMs };
    let seen = this.files.get(file);
    if (!seen || dev !== seen.dev || ino !== seen.ino || size < seen.size
      || (size === seen.size && (mtimeMs !== seen.mtimeMs || ctimeMs !== seen.ctimeMs))) {
      seen = { offset: 0, kept: [], ...observed };
    }
    if (size > seen.offset) {
      const fd = await open(file, 'r');
      try {
        // Only whole lines are taken; a line still being written is read next
        // time. Splitting on the newline byte never cuts a UTF-8 character.
        let carry = Buffer.alloc(0);
        let at = seen.offset;
        while (at < size) {
          const chunk = Buffer.alloc(Math.min(CHUNK, size - at));
          const { bytesRead } = await fd.read(chunk, 0, chunk.length, at);
          if (!bytesRead) break;
          at += bytesRead;
          const bytes = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
          const end = bytes.lastIndexOf(0x0a);
          if (end < 0) { carry = bytes; continue; }
          for (const line of bytes.toString('utf8', 0, end).split('\n')) {
            const kept = pick(line);
            if (kept) seen.kept.push(kept);
          }
          seen.offset = at - (bytes.length - end - 1);
          carry = bytes.subarray(end + 1);
        }
      } finally {
        await fd.close();
      }
    }
    // Keep the observed size as well as the whole-line offset: a partial tail can shrink.
    Object.assign(seen, observed);
    // Most recently read last; past the cap the longest unread goes, and is read whole again if asked for.
    this.files.delete(file);
    this.files.set(file, seen);
    while (this.files.size > MAX_FILES) this.files.delete(this.files.keys().next().value as string);
    return seen.kept;
  }
}

/** Just what counting needs from a Codex rollout line (see CodexTally), so the cache stays small. */
function codexLine(line: string): Json | null {
  if (!/"(token_count|session_meta|turn_context|task_started)"/.test(line)) return null;
  let l: Json;
  try { l = JSON.parse(line) as Json; } catch { return null; }
  const p = l.payload && typeof l.payload === 'object' ? l.payload as Json : null;
  if (!p) return null;
  if (l.type === 'session_meta') return { type: l.type, payload: { id: p.id, session_id: p.session_id, forked_from_id: p.forked_from_id } };
  if (l.type === 'turn_context') return { type: l.type, payload: { model: p.model } };
  if (l.type === 'event_msg' && p.type === 'task_started') return { type: l.type, payload: { type: p.type, turn_id: p.turn_id } };
  if (l.type === 'event_msg' && p.type === 'token_count' && p.info) return { type: l.type, payload: { type: p.type, info: p.info } };
  return null;
}

/** Just what counting needs from a Gemini chat line (see GeminiTally), so the cache stays small. */
function geminiLine(line: string): Json | null {
  if (!line.includes('"tokens"')) return null;
  let l: Json;
  try { l = JSON.parse(line) as Json; } catch { return null; }
  const keep = (m: unknown): Json | null => {
    const r = m && typeof m === 'object' ? m as Json : null;
    return r && r.type === 'gemini' && r.tokens && typeof r.tokens === 'object' ? { id: r.id, type: r.type, model: r.model, tokens: r.tokens } : null;
  };
  const set = l.$set && typeof l.$set === 'object' ? l.$set as Json : null;
  const messages = Array.isArray(set?.messages) ? set.messages : Array.isArray(l.messages) ? l.messages : null;
  if (messages) {
    const kept = messages.map(keep).filter((m): m is Json => m !== null);
    return kept.length ? { $set: { messages: kept } } : null;
  }
  return keep(l);
}

/** Just what counting needs from an assistant line, so the cache stays small. */
function usageLine(line: string): Json | null {
  if (!line.includes('"usage"')) return null;
  let l: Json;
  try { l = JSON.parse(line) as Json; } catch { return null; }
  const message = l.message as Json | undefined;
  if (l.type !== 'assistant' || !message?.usage) return null;
  return {
    type: 'assistant', isSidechain: l.isSidechain, requestId: l.requestId, uuid: l.uuid,
    message: { id: message.id, model: message.model, usage: message.usage },
  };
}
