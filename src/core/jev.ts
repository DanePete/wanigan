// Jev in the core: the HTTP call, the key, the record of every call, and the
// read of each new card. Ported from the Hub's Tools/hub/jev.py.
//
// Card reads send the card's key, type, title, description (clipped), priority
// and criteria, the project's name, and up to five similar cards' keys, titles
// and statuses. Entered fields may contain code. Building this request does
// not open project files or transcripts or read session output.
// Card reads require a configured key and a project mode other than off.
// The owner's connection test also requires a key, independently of that mode.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  JEV_MODEL, JEV_PRICE_PER_M_INPUT, JEV_URL, duplicateCandidates, jevAccepts, jevQuestions, readAnswers,
  type JevCandidate, type JevCardState, type JevQuestion, type JevRead, type JevStatus,
} from '../shared/jev.ts';
import { PRIORITY_LABEL } from '../shared/board.ts';
import { CoreError } from '../shared/protocol.ts';
import { readHttpBody } from '../shared/http-body.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import { loginVariable } from './environment.ts';

const TIMEOUT_MS = 30_000;
const PARALLEL = 2;
const MAX_KEY = 400;
const MAX_REPLY = 1024 * 1024;

export interface JevOptions {
  dataDir: string;
  /** Test seam: where System One is. */
  url?: string;
  /** Test seam: the key the environment provides (null for none). Default: TYPESAFE_API_KEY from the login shell. */
  envKey?: string | null;
  /** Test seam: retry waits. */
  backoffMs?: number;
  /** The demo's stand-in: answers locally instead of calling TypeSafe. */
  answer?: (state: unknown, questions: Record<string, JevQuestion>) => Record<string, unknown>;
}

export class JevError extends Error {}
class JevOffError extends JevError {}

interface PrunedCalls { calls: number; errors: number; tokens: number; unknownUsageCalls: number; today: number; day: number }


export class Jev {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly options: JevOptions;
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;

  constructor(ctx: Ctx, board: Board, options: JevOptions) {
    this.ctx = ctx;
    this.board = board;
    this.options = options;
    board.created.add((card) => {
      if (this.board.jevMode(card.projectId) !== 'off') void this.read(card.id);
    });
  }

  private get keyFile(): string {
    return join(this.options.dataDir, 'jev.key');
  }

  /** The key and where it came from. The environment wins over a saved key. */
  private async key(): Promise<{ key: string; source: 'env' | 'saved' } | null> {
    const env = this.options.envKey !== undefined ? this.options.envKey : await loginVariable('TYPESAFE_API_KEY');
    if (env) return { key: env, source: 'env' };
    try {
      const saved = readFileSync(this.keyFile, 'utf8').trim();
      return saved ? { key: saved, source: 'saved' } : null;
    } catch {
      return null;
    }
  }

  /** Save a key for the core only: a file readable by this user alone. It is never sent back. */
  setKey(key: string): void {
    const k = typeof key === 'string' ? key.trim() : '';
    if (!k || k.length > MAX_KEY || /\s/.test(k)) throw new CoreError('invalid', 'That does not look like a TypeSafe API key.');
    writeFileSync(this.keyFile, k, { mode: 0o600 });
    this.ctx.emit('projects', {});
  }

  forgetKey(): void {
    if (existsSync(this.keyFile)) rmSync(this.keyFile);
    this.ctx.emit('projects', {});
  }

  /** One System One request. Retries 429 and 529 with backoff, as TypeSafe asks; records every call. */
  async ask(state: unknown, questions: Record<string, JevQuestion>, purpose: string, allowed: () => boolean = () => true): Promise<{ answers: Record<string, unknown>; model: string | null; latencyMs: number }> {
    const found = await this.key();
    if (!found) throw new JevError('Jev has no key. Add a TypeSafe API key in Settings.');
    if (!allowed()) throw new JevOffError('Jev is off for this project.');
    if (this.options.answer) {
      const answers = this.options.answer(state, questions);
      // The demo shows the answer time the real Jev was measured at.
      this.record(true, 300, 0, 'jev-demo', null, purpose);
      return { answers, model: 'jev-demo', latencyMs: 300 };
    }
    const body = JSON.stringify({ model: JEV_MODEL, state, questions });
    let last = 'Jev did not answer.';
    for (let attempt = 0; attempt < 4; attempt++) {
      if (!allowed()) throw new JevOffError('Jev is off for this project.');
      const started = Date.now();
      try {
        const response = await fetch(this.options.url ?? JEV_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${found.key}`, 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const latencyMs = Date.now() - started;
        const bytes = await readHttpBody(response, MAX_REPLY, () => new JevError('TypeSafe’s answer was too large.'));
        const text = new TextDecoder().decode(bytes);
        if (response.ok) {
          const data = JSON.parse(text) as { answers?: Record<string, unknown>; model?: string; usage?: { input_tokens?: unknown } };
          const model = typeof data.model === 'string' ? data.model : null;
          const tokens = data.usage?.input_tokens;
          this.record(true, latencyMs, typeof tokens === 'number' && Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : null, model, null, purpose);
          return { answers: data.answers && typeof data.answers === 'object' ? data.answers : {}, model, latencyMs };
        }
        const detail = text.replace(/\s+/g, ' ').slice(0, 200);
        last = response.status === 401 ? 'TypeSafe refused the key (401). Check it in Settings.' : `TypeSafe answered ${response.status}${detail ? `: ${detail}` : ''}`;
        this.record(false, latencyMs, 0, null, last, purpose);
        if ((response.status === 429 || response.status === 529) && attempt < 3) {
          await sleep((this.options.backoffMs ?? 1000) * 2 ** attempt);
          continue;
        }
        break;
      } catch (error) {
        last = `Could not reach TypeSafe: ${(error as Error).message}`;
        this.record(false, Date.now() - started, 0, null, last, purpose);
        if (attempt < 1) { await sleep(this.options.backoffMs ?? 1000); continue; }
        break;
      }
    }
    throw new JevError(last);
  }

  /** Ask Jev something trivial, to show whether the key works. Only on the owner's click. */
  async test(): Promise<JevStatus> {
    await this.ask('Wanigan checks that Jev answers.', { ok: { type: 'noul', instructions: 'Is this a check?' } }, 'test').catch(() => {});
    return this.status();
  }

  async status(): Promise<JevStatus> {
    const { db } = this.ctx;
    const found = await this.key();
    const lastOk = db.prepare('SELECT id, at, model FROM jev_calls WHERE ok = 1 ORDER BY id DESC LIMIT 1').get() as { id: number; at: number; model: string | null } | undefined;
    const lastBad = db.prepare('SELECT id, at, error FROM jev_calls WHERE ok = 0 ORDER BY id DESC LIMIT 1').get() as { id: number; at: number; error: string | null } | undefined;
    const latencies = (db.prepare('SELECT latency_ms AS ms FROM jev_calls WHERE ok = 1 ORDER BY at DESC, id DESC LIMIT 50').all() as { ms: number }[])
      .map((r) => r.ms).sort((a, b) => a - b);
    const dayStart = new Date(this.ctx.now()).setHours(0, 0, 0, 0);
    const totals = db.prepare(`SELECT count(*) AS calls, coalesce(sum(1 - ok), 0) AS errors,
      total(CASE WHEN ok = 1 AND usage_known = 1 THEN input_tokens ELSE 0 END) AS tokens,
      coalesce(sum(CASE WHEN ok = 1 AND usage_known = 0 THEN 1 ELSE 0 END), 0) AS unknownUsageCalls FROM jev_calls`).get() as
      Pick<PrunedCalls, 'calls' | 'errors' | 'tokens' | 'unknownUsageCalls'>;
    const today = (db.prepare('SELECT count(*) AS n FROM jev_calls WHERE at >= ?').get(dayStart) as { n: number }).n;
    const pruned = this.prunedCalls();
    const legacy = this.prunedCalls('jev.pruned');
    const unknownUsageCalls = totals.unknownUsageCalls + pruned.unknownUsageCalls + legacy.unknownUsageCalls;
    const estimate = Math.round((totals.tokens + pruned.tokens) * JEV_PRICE_PER_M_INPUT / 1e6 * 10_000) / 10_000;
    const knownCostUsd = Number.isFinite(estimate) && estimate >= 0 ? estimate : null;
    const online = Boolean(found && lastOk && (!lastBad || lastOk.id > lastBad.id));
    return {
      configured: found?.source ?? null,
      online,
      model: lastOk?.model ?? null,
      lastOkAt: lastOk?.at ?? null,
      lastError: !online && lastBad ? lastBad.error : null,
      latencyP50: latencies.length ? latencies[Math.floor(latencies.length / 2)] as number : null,
      callsToday: today + (pruned.day === dayStart ? pruned.today : 0) + (legacy.day === dayStart ? legacy.today : 0),
      calls: totals.calls + pruned.calls + legacy.calls,
      errors: totals.errors + pruned.errors + legacy.errors,
      costUsd: unknownUsageCalls ? null : knownCostUsd,
      knownCostUsd,
      unknownUsageCalls,
    };
  }

  /** Queue a card for Jev's read. Returns at once; the read arrives as a board event. */
  async read(cardId: string): Promise<void> {
    if (this.queued.has(cardId)) return;
    // Reserve before the first await: duplicate reads and idle core replacement
    // must see work whose key lookup has not finished yet.
    this.queued.add(cardId);
    try {
      if (!(await this.key())) { this.queued.delete(cardId); return; }
      this.queue.push(cardId);
      this.drain();
    } catch (error) {
      this.queued.delete(cardId);
      throw error;
    }
  }

  /** Every open card in a project that Jev has not read. Returns how many were queued. */
  async readAll(projectId: string): Promise<number> {
    if (!(await this.key())) throw new CoreError('refused', 'Jev has no key. Add a TypeSafe API key in Settings.');
    if (this.board.jevMode(projectId) === 'off') throw new CoreError('refused', 'Jev is off for this project. Turn it on in the project’s settings.');
    const ids = (this.ctx.db.prepare(
      `SELECT c.id FROM cards c LEFT JOIN jev_reads j ON j.card_id = c.id
       WHERE c.project_id = ? AND c.status NOT IN ('archived') AND (j.card_id IS NULL OR j.read_json LIKE '%"outcome":"failed"%')
       ORDER BY c.created_at DESC LIMIT 500`,
    ).all(projectId) as { id: string }[]).map((r) => r.id);
    for (const id of ids) await this.read(id);
    return ids.length;
  }

  /** A queue being drained keeps an idle core alive. */
  get busy(): boolean {
    return this.running > 0 || this.queued.size > 0;
  }

  private drain(): void {
    while (this.running < PARALLEL && this.queue.length) {
      const id = this.queue.shift() as string;
      this.running++;
      void this.readCard(id).catch((error: Error) => {
        // This project's consent was withdrawn, not an outage for other projects.
        if (error instanceof JevOffError) return;
        // Jev is down, out of credit or refusing the key: stop asking for now,
        // and say so on the card rather than leaving it looking unread.
        this.store(id, failed(this.ctx.now(), error.message));
        for (const rest of this.queue.splice(0)) this.queued.delete(rest);
      }).finally(() => {
        this.running--;
        this.queued.delete(id);
        this.drain();
      });
    }
  }

  private async readCard(cardId: string): Promise<void> {
    const card = this.board.detail(cardId);
    if (card.status === 'archived' || this.board.jevMode(card.projectId) === 'off') return;
    const project = this.board.project(card.projectId);
    const triage = card.status === 'inbox';
    const open = triage
      ? this.board.listCards(card.projectId)
        .filter((c) => c.id !== card.id && c.status !== 'archived')
        .map((c): JevCandidate => ({ key: c.key, title: c.title, status: c.status, body: c.body }))
      : [];
    const candidates = duplicateCandidates(card, open);
    const state: JevCardState = {
      project: project.name,
      card: {
        key: card.key, type: card.type, title: card.title, priority: PRIORITY_LABEL[card.priority],
        ...(card.body ? { description: card.body.slice(0, 1200) } : {}),
        ...(card.criteria.length ? { criteria: card.criteria.slice(0, 8).map((c) => c.text) } : {}),
      },
      ...(candidates.length ? { candidates: candidates.map(({ key, title, status }) => ({ key, title, status })) } : {}),
    };
    const result = await this.ask(state, jevQuestions(triage, candidates), triage ? 'triage' : 'score',
      () => this.board.jevMode(card.projectId) !== 'off');
    const read = readAnswers(result.answers as Parameters<typeof readAnswers>[0], candidates, { at: this.ctx.now(), model: result.model, latencyMs: result.latencyMs });
    // Apply an acceptance only to the card Jev actually read. The owner may
    // have changed its text or criteria while the request was in flight.
    const now = this.board.detail(card.id);
    const unchanged = now.type === card.type && now.title === card.title && now.body === card.body && now.priority === card.priority
      && now.criteria.length === card.criteria.length && now.criteria.every((c, i) => c.text === card.criteria[i]?.text);
    if (unchanged && now.status === 'inbox' && this.board.jevMode(card.projectId) === 'accept' && jevAccepts(read, now.criteria.length)) {
      read.outcome = 'accepted';
      this.store(card.id, read);
      this.board.acceptByJev(card.id, `Jev: ready (${Math.round((read.confidence ?? 0) * 100)}%), and it already has acceptance criteria`);
      return;
    }
    this.store(card.id, read);
  }

  private store(cardId: string, read: JevRead): void {
    this.ctx.db.prepare('INSERT INTO jev_reads (card_id, at, read_json) VALUES (?, ?, ?) ON CONFLICT(card_id) DO UPDATE SET at = excluded.at, read_json = excluded.read_json')
      .run(cardId, read.at, JSON.stringify(read));
    const row = this.ctx.db.prepare('SELECT project_id FROM cards WHERE id = ?').get(cardId) as { project_id: string } | undefined;
    if (row) this.ctx.emit('board', { projectId: row.project_id, cardId });
  }

  /** Totals survive pruning without retaining card contents or unbounded per-day rows. */
  private prunedCalls(key = 'jev.pruned.v2'): PrunedCalls {
    const row = this.ctx.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    if (!row) return { calls: 0, errors: 0, tokens: 0, unknownUsageCalls: 0, today: 0, day: 0 };
    const stored = JSON.parse(row.value) as PrunedCalls;
    // Leave the old aggregate intact: its successes may include missing, negative
    // or coerced usage, and the original responses can no longer establish which.
    if (key === 'jev.pruned') return { ...stored, tokens: 0, unknownUsageCalls: Math.max(0, stored.calls - stored.errors) };
    return { ...stored, tokens: typeof stored.tokens === 'number' && Number.isFinite(stored.tokens) && stored.tokens >= 0 ? stored.tokens : NaN };
  }

  private record(ok: boolean, latencyMs: number | null, inputTokens: number | null, model: string | null, error: string | null, purpose: string): void {
    const { db } = this.ctx;
    db.transaction(() => {
      db.prepare('INSERT INTO jev_calls (at, ok, latency_ms, input_tokens, usage_known, model, error, purpose) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(this.ctx.now(), ok ? 1 : 0, latencyMs, inputTokens ?? 0, inputTokens === null ? 0 : 1, model, error, purpose);
      const cutoff = db.prepare('SELECT id FROM jev_calls ORDER BY id DESC LIMIT 1 OFFSET 5000').get() as { id: number } | undefined;
      if (!cutoff) return;
      const day = new Date(this.ctx.now()).setHours(0, 0, 0, 0);
      const removed = db.prepare(`SELECT count(*) AS calls, sum(1 - ok) AS errors,
        total(CASE WHEN ok = 1 AND usage_known = 1 THEN input_tokens ELSE 0 END) AS tokens,
        sum(CASE WHEN ok = 1 AND usage_known = 0 THEN 1 ELSE 0 END) AS unknownUsageCalls,
        sum(CASE WHEN at >= ? THEN 1 ELSE 0 END) AS today FROM jev_calls WHERE id <= ?`).get(day, cutoff.id) as Omit<PrunedCalls, 'day'>;
      const prior = this.prunedCalls();
      const kept: PrunedCalls = {
        calls: prior.calls + removed.calls, errors: prior.errors + removed.errors, tokens: prior.tokens + removed.tokens,
        unknownUsageCalls: prior.unknownUsageCalls + removed.unknownUsageCalls,
        today: (prior.day === day ? prior.today : 0) + removed.today, day,
      };
      db.prepare("INSERT INTO meta (key, value) VALUES ('jev.pruned.v2', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(kept));
      // Detailed calls are bounded; the aggregate and deletion are one transaction.
      db.prepare('DELETE FROM jev_calls WHERE id <= ?').run(cutoff.id);
    })();
  }

}

function failed(at: number, error: string): JevRead {
  return {
    at, model: null, latencyMs: null, action: null, confidence: null, probabilities: null, severity: null,
    duplicateOf: null, duplicateP: null, outcome: 'failed', error: error.slice(0, 300),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
