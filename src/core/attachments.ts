// Files the owner hands an agent: pasted, dropped or picked in a composer.
// Each is judged by its bytes and saved under Wanigan's own data folder,
// `attachments/<session>/` or `attachments/chat/<thread>/` (folders 0700,
// files 0600), never in a project. A file waits in its composer until a
// message takes it; from then on it stays with that message, so what was sent
// can be seen afterward.
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ATTACH_MAX_BYTES, ATTACH_MAX_FILES, ATTACH_MAX_TOTAL, CHAT_TEXT_MAX_BYTES, PREVIEW_MAX_BYTES,
  displayName, formatBytes, savedName, sniff, type Attachment, type AttachmentKind,
} from '../shared/attachments.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Ctx } from './context.ts';
import { readBoundedFile } from './bounded-file.ts';
import { within } from './safe-fs.ts';

interface AttachmentRow {
  id: string; session_id: string | null; thread_id: string | null; n: number; name: string; path: string; kind: string;
  mime: string; size: number; created_at: number; sent_at: number | null; queued_id: number | null; turn_id: string | null;
}

/** Whose composer a file waits in, and the event key that says it changed. */
export interface Holder { column: 'session_id' | 'thread_id'; id: string; key: string; folder: string[]; chat: boolean }

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export class Attachments {
  private readonly ctx: Ctx;
  readonly root: string;

  constructor(ctx: Ctx, dataDir: string) {
    this.ctx = ctx;
    this.root = join(dataDir, 'attachments');
  }

  static session(sessionId: string): Holder {
    return { column: 'session_id', id: sessionId, key: `session:${sessionId}`, folder: [sessionId], chat: false };
  }

  static thread(threadId: string, projectId: string | null): Holder {
    return { column: 'thread_id', id: threadId, key: `chat:${projectId ?? '*'}`, folder: ['chat', threadId], chat: true };
  }

  /** Check one file and keep it for the holder's next message. */
  save(holder: Holder, rawName: unknown, data: unknown): Attachment {
    const name = displayName(rawName) || 'file';
    if (typeof data !== 'string' || !BASE64.test(data)) throw new CoreError('invalid', `${name} did not arrive whole. Try again.`);
    // Measured before decoding, so an oversized file is never held in memory twice.
    const size = Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (size > ATTACH_MAX_BYTES) throw new CoreError('refused', `${name} is ${formatBytes(size)}. A file can be at most ${formatBytes(ATTACH_MAX_BYTES)}.`);
    if (size === 0) throw new CoreError('refused', `${name} is empty.`);
    const bytes = Buffer.from(data, 'base64');
    const what = sniff(bytes);
    if (!what) throw new CoreError('refused', `${name} cannot be attached: only PNG, JPEG, GIF and WebP images, PDFs and text files can.`);
    if (holder.chat && what.kind === 'text' && bytes.length > CHAT_TEXT_MAX_BYTES) {
      throw new CoreError('refused', `${name} is ${formatBytes(bytes.length)}. Talk to Wanigan puts a text file into the message whole, so it can be at most ${formatBytes(CHAT_TEXT_MAX_BYTES)}.`);
    }
    const waiting = this.pending(holder);
    if (waiting.length >= ATTACH_MAX_FILES) throw new CoreError('refused', `A message can carry ${ATTACH_MAX_FILES} files at most.`);
    const total = waiting.reduce((sum, a) => sum + a.size, 0) + bytes.length;
    if (total > ATTACH_MAX_TOTAL) throw new CoreError('refused', `A message can carry ${formatBytes(ATTACH_MAX_TOTAL)} of files at most; this would make ${formatBytes(total)}.`);

    const n = ((this.ctx.db.prepare(`SELECT max(n) AS n FROM attachments WHERE ${holder.column} = ?`).get(holder.id) as { n: number | null }).n ?? 0) + 1;
    const dir = this.folder(holder);
    const path = join(dir, `${n}-${savedName(name, what)}`);
    if (!within(this.root, path)) throw new CoreError('internal', 'An attachment would land outside Wanigan’s attachments folder.');
    writeFileSync(path, bytes, { mode: 0o600, flag: 'wx' });
    chmodSync(path, 0o600);
    const row: AttachmentRow = {
      id: randomUUID(), session_id: holder.column === 'session_id' ? holder.id : null, thread_id: holder.column === 'thread_id' ? holder.id : null,
      n, name, path, kind: what.kind, mime: what.mime, size: bytes.length, created_at: this.ctx.now(), sent_at: null, queued_id: null, turn_id: null,
    };
    this.ctx.db.prepare(`INSERT INTO attachments (id, session_id, thread_id, n, name, path, kind, mime, size, created_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.session_id, row.thread_id, row.n, row.name, row.path, row.kind, row.mime, row.size, row.created_at);
    this.ctx.emit('attachments', { key: holder.key });
    return toAttachment(row);
  }

  /** The files waiting for the holder's next message, oldest first. */
  pending(holder: Holder): Attachment[] {
    return (this.ctx.db.prepare(`SELECT * FROM attachments WHERE ${holder.column} = ? AND queued_id IS NULL AND turn_id IS NULL ORDER BY n`)
      .all(holder.id) as AttachmentRow[]).map(toAttachment);
  }

  /** Take a waiting file out of its composer and delete it. A file a message took stays with that message. */
  remove(id: string): void {
    const row = this.row(id);
    if (row.queued_id !== null || row.turn_id !== null) throw new CoreError('refused', 'That file went with a message, so it stays with it.');
    rmSync(row.path, { force: true });
    this.ctx.db.prepare('DELETE FROM attachments WHERE id = ?').run(id);
    this.ctx.emit('attachments', { key: this.keyOf(row) });
  }

  /** An image as a data URL for its thumbnail; null for anything else, or one too large to show. */
  preview(id: string): string | null {
    const row = this.row(id);
    if (row.kind !== 'image' || row.size > PREVIEW_MAX_BYTES || !existsSync(row.path)) return null;
    try { return `data:${row.mime};base64,${readBoundedFile(row.path, Math.min(row.size, PREVIEW_MAX_BYTES)).toString('base64')}`; }
    catch { return null; }
  }

  /**
   * Hand waiting files to a message: each must be waiting in this holder's
   * composer. Run inside the transaction that records the message, so a
   * refusal records neither.
   */
  take(holder: Holder, ids: readonly string[], message: { queuedId: number } | { turnId: string }): Attachment[] {
    if (ids.length > ATTACH_MAX_FILES) throw new CoreError('invalid', `A message can carry ${ATTACH_MAX_FILES} files at most.`);
    const waiting = new Map(this.pending(holder).map((a) => [a.id, a]));
    const taken: Attachment[] = [];
    for (const id of new Set(ids)) {
      const file = typeof id === 'string' ? waiting.get(id) : undefined;
      if (!file) throw new CoreError('refused', 'One of the files is no longer waiting in this composer. Attach it again.');
      taken.push(file);
    }
    const now = this.ctx.now();
    const set = 'queuedId' in message
      ? this.ctx.db.prepare('UPDATE attachments SET queued_id = ?, sent_at = ? WHERE id = ?')
      : this.ctx.db.prepare('UPDATE attachments SET turn_id = ?, sent_at = ? WHERE id = ?');
    for (const file of taken) set.run('queuedId' in message ? message.queuedId : message.turnId, now, file.id);
    if (taken.length) this.ctx.emit('attachments', { key: holder.key });
    return taken.map((a) => ({ ...a, sentAt: now })).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** What went with a queued message, in the order it was attached. */
  ofMessage(queuedId: number): { path: string; kind: AttachmentKind; name: string }[] {
    return (this.ctx.db.prepare('SELECT * FROM attachments WHERE queued_id = ? ORDER BY n').all(queuedId) as AttachmentRow[])
      .map((r) => ({ path: r.path, kind: r.kind as AttachmentKind, name: r.name }));
  }

  /** What went with each chat turn. */
  ofTurns(turnIds: readonly string[]): Map<string, Attachment[]> {
    const out = new Map<string, Attachment[]>();
    if (!turnIds.length) return out;
    const rows = this.ctx.db.prepare(`SELECT * FROM attachments WHERE turn_id IN (${turnIds.map(() => '?').join(',')}) ORDER BY n`).all(...turnIds) as AttachmentRow[];
    for (const r of rows) out.set(r.turn_id as string, [...(out.get(r.turn_id as string) ?? []), toAttachment(r)]);
    return out;
  }

  /** A session that ended can take no more messages: what still waited in its composer was never sent, so it goes. */
  dropUnsent(holder: Holder): void {
    const rows = this.ctx.db.prepare(`SELECT * FROM attachments WHERE ${holder.column} = ? AND queued_id IS NULL AND turn_id IS NULL`).all(holder.id) as AttachmentRow[];
    if (!rows.length) return;
    const remove = this.ctx.db.prepare('DELETE FROM attachments WHERE id = ?');
    for (const r of rows) {
      rmSync(r.path, { force: true });
      remove.run(r.id);
    }
    this.ctx.emit('attachments', { key: holder.key });
  }

  /** A new chat conversation keeps what was waiting in the old one's composer. The files stay where they are. */
  moveUnsent(from: string, to: string): void {
    this.ctx.db.prepare('UPDATE attachments SET thread_id = ? WHERE thread_id = ? AND queued_id IS NULL AND turn_id IS NULL').run(to, from);
  }

  private keyOf(row: AttachmentRow): string {
    if (row.session_id) return `session:${row.session_id}`;
    const thread = this.ctx.db.prepare('SELECT project_id FROM chat_threads WHERE id = ?').get(row.thread_id) as { project_id: string | null } | undefined;
    return `chat:${thread?.project_id ?? '*'}`;
  }

  /** The holder's folder, made private on the way. */
  private folder(holder: Holder): string {
    let dir = this.root;
    for (const part of ['', ...holder.folder]) {
      dir = part ? join(dir, part) : dir;
      if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
      chmodSync(dir, 0o700);
    }
    return dir;
  }

  private row(id: string): AttachmentRow {
    const row = this.ctx.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as AttachmentRow | undefined;
    if (!row) throw new CoreError('not_found', 'No such attachment.');
    return row;
  }
}

function toAttachment(r: AttachmentRow): Attachment {
  return { id: r.id, name: r.name, path: r.path, kind: r.kind as AttachmentKind, mime: r.mime, size: r.size, createdAt: r.created_at, sentAt: r.sent_at };
}
