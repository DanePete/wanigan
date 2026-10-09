// Agents seeing the live view, the core's side. A session's `wanigan mcp`
// tools call these methods as that session. The core holds the rules: only
// the session's own project, only pages of its local site, widths and sizes
// bounded, the helper's token never handed out. It has no browser, so it asks
// the app (a `liveAsk` event to the owner's connections, never to phones) and
// waits for `live.answer`, with a timeout, refusing at once when no app is
// connected to answer. Every call, answered or refused, is kept as evidence on
// the session's card. Nothing here edits anything.
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, relative } from 'node:path';
import {
  IMAGE_MAX, PART_ID, cleanDiff, cleanProblemsAnswer, cleanRendered, cleanStatus, explainAreas, liveWidth, sitePage,
  type LiveAsk, type LiveAskKind, type LiveCapture, type LiveLook, type LiveRendered, type LiveTool, type LiveToolResult,
} from '../shared/live-agent.ts';
import { diffText, findText, lookText, pageAt, partText, pathOf, problemsText, statusText, type TextContext } from '../shared/live-agent-text.ts';
import { isStylesheet } from '../shared/live.ts';
import type { Session } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import type { Live } from './live.ts';

/** How long the core waits for the app: a status is read at once; a page loads (up to 30 s), settles and is read. */
const WAIT_MS: Record<LiveAskKind, number> = { status: 5_000, render: 60_000, problems: 60_000, diff: 90_000 };
/** Pages a session may have the app reading at once, and all sessions together. */
const PER_SESSION = 2;
const IN_ALL = 8;
/** A session's newest calls are kept as evidence; older ones go. */
const KEEP_A_SESSION = 500;
const MAX_ASKED = 200;
const MAX_SAID = 400;
const MAX_QUERY = 200;

interface Waiting {
  sessionId: string;
  kind: LiveAskKind;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface LookRow {
  id: number; session_id: string; card_id: string | null; tool: string; page: string | null; width: number | null;
  asked: string; said: string; ok: number; at: number; edits_after: number; edits_before: number; provider: string; title: string;
}

export interface LiveAgentOptions {
  /** How many app connections say they answer (`live.host`). */
  hosts: () => number;
  /** Test seam: shorter waits for the app. */
  waitMs?: Partial<Record<LiveAskKind, number>>;
}

export class LiveAgent {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly live: Live;
  private readonly options: LiveAgentOptions;
  private readonly waiting = new Map<string, Waiting>();

  constructor(ctx: Ctx, board: Board, live: Live, options: LiveAgentOptions) {
    this.ctx = ctx;
    this.board = board;
    this.live = live;
    this.options = options;
  }

  /* ── the tools ───────────────────────────────────────────────────────── */

  status(session: Session): Promise<LiveToolResult> {
    return this.record(session, 'live_status', '', async () => {
      const site = this.live.site(session.projectId);
      const cardPage = this.cardPage(session);
      const app = site.url && this.options.hosts() ? cleanStatus(await this.ask('status', this.base(session, site.url, site.platform, { url: null }))) : null;
      const out = statusText({ site: { url: site.url, platform: site.platform, helper: !!site.helper }, cardPage, app });
      const view = app?.view?.showing ? app.view : null;
      return {
        result: { ...out, image: null },
        page: view ? pathOf(view.url) : null, width: view?.width ?? null,
        said: !site.url ? 'no site set' : !app ? 'the app is not running' : `${String(out.structured.liveView)}${view?.url ? `; the owner is on ${pageAt(view.url, view.width ?? 0)}` : ''}`,
      };
    });
  }

  look(session: Session, p: { path?: unknown; width?: unknown; image?: unknown; fullPage?: unknown; part?: unknown; all?: unknown }): Promise<LiveToolResult> {
    const named = typeof p.part === 'string' && p.part ? p.part.slice(0, 64) : null;
    const capture: LiveCapture = named ? 'part' : p.fullPage === true ? 'page' : p.image === true ? 'screen' : 'none';
    return this.record(session, 'live_look', named ? `pictured part ${named}` : capture === 'none' ? '' : capture === 'page' ? 'pictured the whole page' : 'pictured the first screen', async () => {
      const part = optionalPart(p.part);
      const { page, text } = await this.render(session, p.path, p.width, capture, part);
      const out = lookText(page, text, { all: p.all === true });
      return {
        result: { ...out, image: page.image },
        page: pathOf(page.url), width: page.width,
        said: `${String(out.structured.partsOnPage)} parts${page.image ? ', with a picture' : ''}${page.partFound === false ? '; that part was not on the page' : ''}`,
      };
    });
  }

  find(session: Session, p: { query?: unknown; path?: unknown; width?: unknown }): Promise<LiveToolResult> {
    const query = typeof p.query === 'string' ? p.query.replace(/\s+/g, ' ').trim().slice(0, MAX_QUERY) : '';
    return this.record(session, 'live_find', query ? `“${query}”` : '', async () => {
      if (!query) throw new CoreError('invalid', 'Say what to look for: a name, a template or component, or words on the page.');
      const { page, text } = await this.render(session, p.path, p.width, 'none', null);
      const out = findText(page, query, text);
      const n = (out.structured.parts as unknown[]).length;
      return { result: { ...out, image: null }, page: pathOf(page.url), width: page.width, said: n ? `${n === 1 ? 'one part' : `${n} parts`} found` : 'nothing matched' };
    });
  }

  part(session: Session, p: { id?: unknown; path?: unknown; width?: unknown; image?: unknown }): Promise<LiveToolResult> {
    return this.record(session, 'live_part', typeof p.id === 'string' ? p.id.slice(0, 64) : '', async () => {
      const id = optionalPart(p.id);
      if (!id) throw new CoreError('invalid', 'Which part? Pass the id live_look or live_find gave (like hero-3fa2).');
      const site = this.live.site(session.projectId);
      const { page, text } = await this.render(session, p.path, p.width, p.image === true ? 'part' : 'none', id);
      const out = partText(page, id, text, { helper: !!site.helper });
      if (!out) {
        throw new CoreError('not_found', `No part with the id ${id} is on ${pageAt(page.url, page.width)} now. Ids hold from one load to the next only while the page still has that part: live_look or live_find gives the ids it has now.`);
      }
      const made = out.structured.made as { template?: string; component?: { id: string } };
      return {
        result: { ...out, image: page.image },
        page: pathOf(page.url), width: page.width,
        said: `${String(out.structured.title)}${made.template ? ` · ${made.template.split('/').pop()}` : made.component ? ` · ${made.component.id}` : ''}${page.image ? ', with a picture' : ''}`,
      };
    });
  }

  problems(session: Session, p: { path?: unknown; width?: unknown; sinceTurn?: unknown }): Promise<LiveToolResult> {
    const since = p.sinceTurn === true ? this.turnStarted(session.id) : null;
    return this.record(session, 'live_problems', p.sinceTurn === true ? 'since its turn began' : '', async () => {
      const site = this.siteFor(session);
      const target = this.target(site.url, p.path);
      const width = this.width(p.width);
      const answer = cleanProblemsAnswer(await this.ask('problems', this.base(session, site.url, site.platform, { url: target, width, since })));
      const out = problemsText(answer, since);
      const all = [...answer.page, ...(out.structured.view as unknown[] | null ?? [])] as { level: string }[];
      const errors = all.filter((x) => x.level === 'error').length;
      const warnings = all.length - errors;
      return {
        result: { ...out, image: null }, page: pathOf(answer.url), width: answer.width,
        said: all.length ? [errors && `${errors} error${errors === 1 ? '' : 's'}`, warnings && `${warnings} warning${warnings === 1 ? '' : 's'}`].filter(Boolean).join(', ') : 'no problems',
      };
    });
  }

  diff(session: Session, p: { since?: unknown }): Promise<LiveToolResult> {
    if (p.since !== undefined && p.since !== null && p.since !== 'start' && p.since !== 'turn') throw new CoreError('invalid', 'since is "start" (this session’s first screenshot) or "turn" (its last turn that changed files).');
    const since = p.since === 'start' ? 'start' : 'turn';
    return this.record(session, 'live_diff', since === 'start' ? 'from before it began' : 'from its last turn', async () => {
      const site = this.siteFor(session);
      if (!session.cardId) throw new CoreError('refused', 'This session has no card, and before and after screenshots are kept per card, so there is nothing to compare with.');
      const shots = this.live.shots(session.cardId).filter((s) => s.sessionId === session.id);
      const before = shots.find((s) => s.kind === 'before') ?? null;
      const after = [...shots].reverse().find((s) => s.kind === 'after') ?? null;
      const base = since === 'turn' ? after ?? before : before;
      if (!base) {
        const app = this.options.hosts() ? cleanStatus(await this.ask('status', this.base(session, site.url, site.platform, { url: null })).catch(() => null)) : null;
        throw new CoreError('refused', app && !app.shots
          ? 'Screenshots are off in Settings › Live view, so there is no before to compare with. live_look shows the page as it is now.'
          : 'There is no screenshot of this card’s page from before this session worked: screenshots were switched on after it began, or the page could not be taken then. live_look shows the page as it is now.');
      }
      const answer = cleanDiff(await this.ask('diff', this.base(session, site.url, site.platform, { url: base.url, shot: { id: base.id, url: base.url } })));
      const fromAt = since === 'start' ? 0 : base.createdAt;
      const edited = (this.ctx.db.prepare('SELECT DISTINCT path FROM session_edits WHERE session_id = ? AND at >= ? ORDER BY at').all(session.id, fromAt) as { path: string }[]).map((r) => r.path);
      const { components } = this.textContext(session.projectId, site.url, site.platform);
      const explained = explainAreas(answer.areas, answer.regions, edited, components);
      const out = diffText(answer, explained, {
        since, base: base.kind, takenAt: base.createdAt, now: Date.now(), stylesheets: edited.filter(isStylesheet), edited: edited.length,
        local: (path) => this.local(session.projectId, path),
      });
      return { result: { text: out.text, structured: out.structured, image: null }, page: pathOf(answer.url), width: answer.width, said: out.summary };
    });
  }

  /* ── the app's side ──────────────────────────────────────────────────── */

  /** The app's answer to a question it was asked. */
  answer(params: { id?: unknown; result?: unknown; error?: unknown }): { ok: boolean } {
    const id = typeof params.id === 'string' ? params.id : '';
    const w = this.waiting.get(id);
    if (!w) return { ok: false };
    this.waiting.delete(id);
    clearTimeout(w.timer);
    if (typeof params.error === 'string' && params.error) w.reject(new CoreError('refused', params.error.slice(0, 800)));
    else w.resolve(params.result);
    return { ok: true };
  }

  /** What agents looked at, for a card (its sessions') or one session, newest first. */
  looks(params: { cardId?: unknown; sessionId?: unknown }): LiveLook[] {
    const cardId = typeof params.cardId === 'string' && params.cardId ? this.board.card(params.cardId).id : null;
    const sessionId = typeof params.sessionId === 'string' && params.sessionId ? params.sessionId : null;
    if (!cardId && !sessionId) throw new CoreError('invalid', 'Which card or session?');
    const rows = this.ctx.db.prepare(`
      SELECT l.*, s.provider, s.title,
        (SELECT count(DISTINCT e.path) FROM session_edits e WHERE e.session_id = l.session_id AND e.at > l.at) AS edits_after,
        (SELECT count(DISTINCT e.path) FROM session_edits e WHERE e.session_id = l.session_id AND e.at <= l.at) AS edits_before
      FROM live_looks l JOIN sessions s ON s.id = l.session_id
      WHERE ${cardId ? '(l.card_id = @card OR s.card_id = @card)' : 'l.session_id = @session'}
      ORDER BY l.at DESC, l.id DESC LIMIT 100`).all({ card: cardId, session: sessionId }) as LookRow[];
    return rows.map((r) => ({
      id: r.id, sessionId: r.session_id, cardId: r.card_id, tool: r.tool as LiveTool, page: r.page, width: r.width, asked: r.asked, said: r.said,
      ok: r.ok === 1, at: r.at, editsAfter: r.edits_after, editsBefore: r.edits_before, provider: r.provider, sessionTitle: r.title,
    }));
  }

  /** Nothing waits once the core stops. */
  stop(): void {
    for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.reject(new CoreError('refused', 'Wanigan’s core is stopping.')); this.waiting.delete(id); }
  }

  /* ── inside ──────────────────────────────────────────────────────────── */

  /** Run a tool, and keep what it asked and what came back (or why it was refused) as evidence. */
  private async record(session: Session, tool: LiveTool, asked: string,
    work: () => Promise<{ result: LiveToolResult; page: string | null; width: number | null; said: string }>): Promise<LiveToolResult> {
    try {
      const done = await work();
      this.keep(session, tool, asked, done.page, done.width, done.said, true);
      return done.result;
    } catch (error) {
      this.keep(session, tool, asked, null, null, (error as Error).message, false);
      throw error;
    }
  }

  private keep(session: Session, tool: LiveTool, asked: string, page: string | null, width: number | null, said: string, ok: boolean): void {
    const { db } = this.ctx;
    db.prepare('INSERT INTO live_looks (session_id, project_id, card_id, tool, page, width, asked, said, ok, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, session.projectId, session.cardId, tool, page?.slice(0, 500) ?? null, width, asked.slice(0, MAX_ASKED), said.slice(0, MAX_SAID), ok ? 1 : 0, this.ctx.now());
    db.prepare('DELETE FROM live_looks WHERE session_id = ? AND id NOT IN (SELECT id FROM live_looks WHERE session_id = ? ORDER BY id DESC LIMIT ?)')
      .run(session.id, session.id, KEEP_A_SESSION);
    this.ctx.emit('liveLooks', { projectId: session.projectId, cardId: session.cardId, sessionId: session.id });
  }

  /** Render a page in the app's hidden window, and what the core knows to describe it. */
  private async render(session: Session, rawPath: unknown, rawWidth: unknown, capture: LiveCapture, part: string | null): Promise<{ page: LiveRendered; text: TextContext }> {
    const site = this.siteFor(session);
    const url = this.target(site.url, rawPath);
    const width = this.width(rawWidth);
    const page = cleanRendered(await this.ask('render', this.base(session, site.url, site.platform, { url, width, capture, part })));
    if (page.image && (page.image.width > IMAGE_MAX.width || page.image.height > IMAGE_MAX.height)) page.image = null;
    return { page, text: this.textContext(session.projectId, site.url, site.platform).text };
  }

  /** The session's own project's site, or why there is none to read. */
  private siteFor(session: Session): { url: string; platform: LiveAsk['site']['platform'] } {
    const site = this.live.site(session.projectId);
    if (!site.url) throw new CoreError('refused', 'No local site is set for this project, so there is no live view to read. The owner chooses it in the project’s Live tab.');
    return { url: site.url, platform: site.platform };
  }

  private target(site: string, raw: unknown): string | null {
    if (raw === undefined || raw === null || raw === '') return null;
    const page = sitePage(raw, site);
    if ('refused' in page) throw new CoreError('refused', page.refused);
    return page.url;
  }

  private width(raw: unknown): number | null {
    const w = liveWidth(raw);
    if (w !== null && typeof w === 'object') throw new CoreError('invalid', w.refused);
    return w;
  }

  private cardPage(session: Session): string | null {
    return session.cardId ? this.live.page(session.cardId).url : null;
  }

  private base(session: Session, url: string, platform: LiveAsk['site']['platform'], more: Partial<LiveAsk>): Omit<LiveAsk, 'id' | 'kind' | 'deadline'> {
    return {
      projectId: session.projectId, sessionId: session.id, site: { url, platform }, url: null, cardPage: this.cardPage(session),
      width: null, capture: 'none', part: null, since: null, shot: null, ...more,
    };
  }

  /** The session's last turn began when it last said a prompt was sent; null before its first. */
  private turnStarted(sessionId: string): number | null {
    const row = this.ctx.db.prepare("SELECT max(at) AS at FROM session_events WHERE session_id = ? AND event = 'UserPromptSubmit'").get(sessionId) as { at: number | null };
    return row.at ?? null;
  }

  /** Paths as the project's own, the components the site defines, and how the site names its templates. */
  private textContext(projectId: string, site: string, platform: LiveAsk['site']['platform']): { text: TextContext; components: { id: string; dir: string; name: string }[] } {
    const roots = this.live.roots(projectId);
    let parts: ReturnType<Live['parts']> = { docroot: null, components: [] };
    try { parts = this.live.parts(projectId); } catch { /* a project folder that cannot be read names no components */ }
    const byId = new Map(parts.components.map((c) => [c.id, c]));
    return {
      text: {
        site, platform,
        where: (file) => this.local(projectId, roots.docroot ? join(roots.docroot, file.replace(/^\.?\/+/, '')) : file, roots.project),
        local: (path) => this.local(projectId, path, roots.project),
        component: (id) => byId.get(id) ?? null,
      },
      components: parts.components.map((c) => ({ id: c.id, dir: c.dir, name: c.name })),
    };
  }

  /** A path on this Mac as the project's own (relative to its folder) when it is inside it. */
  private local(projectId: string, path: string, root = this.live.roots(projectId).project): string {
    if (!isAbsolute(path)) return path;
    const inside = relative(root, path);
    return inside && !inside.startsWith('..') && !isAbsolute(inside) ? inside : path;
  }

  /** Ask the app, and wait for its answer. Refused at once when no app is connected to answer. */
  private ask(kind: LiveAskKind, base: Omit<LiveAsk, 'id' | 'kind' | 'deadline'>): Promise<unknown> {
    if (!this.options.hosts()) {
      return Promise.reject(new CoreError('refused', 'Wanigan’s app is not running, so the live view cannot be read now. The owner opens Wanigan to switch it back on.'));
    }
    const mine = [...this.waiting.values()].filter((w) => w.sessionId === base.sessionId).length;
    if (mine >= PER_SESSION || this.waiting.size >= IN_ALL) {
      return Promise.reject(new CoreError('refused', `The app is already reading ${mine >= PER_SESSION ? `${mine} pages for this session` : 'as many pages as it reads at once'}. Wait for those, then ask again.`));
    }
    const ms = this.options.waitMs?.[kind] ?? WAIT_MS[kind];
    const id = randomUUID();
    const ask: LiveAsk = { ...base, id, kind, deadline: Date.now() + ms };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new CoreError('refused', `Wanigan’s app did not answer within ${Math.round(ms / 1000)} seconds${kind === 'status' ? '' : ' (the page may be slow to load, or the app busy with another)'}. Try again.`));
      }, ms);
      timer.unref?.();
      this.waiting.set(id, { sessionId: base.sessionId, kind, resolve, reject, timer });
      this.ctx.emit('liveAsk', ask);
    });
  }
}

function optionalPart(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !PART_ID.test(raw)) throw new CoreError('invalid', 'A part id is the one live_look or live_find gave, like hero-3fa2.');
  return raw;
}
