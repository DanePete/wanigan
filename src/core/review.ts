// An AI review of a card, on request. Claude Code runs headless with read-only
// tools, checks each acceptance criterion against the code and the evidence,
// and cites a file and an exact quote for its proof. Wanigan then checks every
// quote against the real file. The review is advice for the owner, who still
// approves or sends back: it never moves the card.
//
// From the OnTour Production Hub, where "the hub checks the reviewer" was the
// rule that made AI review worth having: a pass whose proof cannot be found in
// the cited file is not a pass.
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AiReview, AiReviewCriterion, CardDetail } from '../shared/model.ts';
import { CoreError } from '../shared/protocol.ts';
import type { Accounts } from './accounts.ts';
import type { Board } from './board.ts';
import type { Ctx } from './context.ts';
import { toAiReview, type AiReviewRow as Row } from './records.ts';
import { killChild, runHeadless } from './headless.ts';

const TIMEOUT_MS = 12 * 60_000;
const MAX_QUOTED_FILE = 2 * 1024 * 1024;

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'changes', 'unsure'] },
    summary: { type: 'string' },
    check: { type: 'array', items: { type: 'string' } },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          criterion: { type: 'string' },
          met: { type: ['boolean', 'null'] },
          proof: { type: 'string' },
          file: { type: ['string', 'null'] },
          quote: { type: ['string', 'null'] },
        },
        required: ['criterion', 'met', 'proof'],
      },
    },
  },
  required: ['verdict', 'summary', 'check', 'criteria'],
} as const;


export class Reviews {
  private readonly ctx: Ctx;
  private readonly board: Board;
  private readonly accounts: Accounts;
  private readonly claudeBinary: string | null;
  private readonly running = new Map<string, ChildProcess>();
  /** Cards whose review is being started: a double click starts one review. */
  private readonly starting = new Set<string>();
  private stopped = false;

  constructor(ctx: Ctx, board: Board, accounts: Accounts, options: { claudeBinary?: string | null } = {}) {
    this.ctx = ctx;
    this.board = board;
    this.accounts = accounts;
    this.claudeBinary = options.claudeBinary ?? null;
  }

  /** A review in flight keeps the core from exiting while idle. */
  get busy(): boolean {
    return this.running.size > 0 || this.starting.size > 0;
  }

  /** Reviews the last core left running can never finish: say so. */
  recover(): void {
    this.ctx.db.prepare("UPDATE ai_reviews SET state = 'failed', finished_at = ?, error = ? WHERE state = 'running'")
      .run(this.ctx.now(), 'Wanigan’s core stopped before this review finished. Run it again.');
  }

  list(cardId: string): AiReview[] {
    const rows = this.ctx.db.prepare('SELECT * FROM ai_reviews WHERE card_id = ? ORDER BY started_at DESC LIMIT 10').all(cardId) as Row[];
    return rows.map((r) => this.map(r));
  }

  /** Start a review. Returns at once; the result arrives as a board event. */
  async start(cardId: string, accountId: string | null): Promise<AiReview> {
    const card = this.board.detail(cardId);
    if (this.starting.has(card.id) || this.list(card.id).some((r) => r.state === 'running')) {
      throw new CoreError('refused', 'A review of this card is already running.');
    }
    const project = this.board.project(card.projectId);
    const account = this.accounts.resolve(project.id, 'claude', accountId);
    const cwd = card.worktree?.path ?? project.path;
    this.starting.add(card.id);
    let run: Awaited<ReturnType<typeof runHeadless>>;
    try {
      run = await runHeadless({ binary: this.claudeBinary, prompt: prompt(card, cwd), schema: SCHEMA, cwd, account, timeoutMs: TIMEOUT_MS });
    } finally {
      this.starting.delete(card.id);
    }
    if (this.stopped) {
      killChild(run.child);
      throw new CoreError('refused', 'Wanigan’s core is stopping.');
    }

    const id = randomUUID();
    this.ctx.db.prepare('INSERT INTO ai_reviews (id, card_id, project_id, account_id, state, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, card.id, project.id, account?.id ?? null, 'running', this.ctx.now());
    this.board.log({ projectId: project.id, cardId: card.id, actor: 'owner', verb: 'asked Claude to review', detail: account ? `as ${account.label}` : null });
    this.ctx.emit('board', { projectId: project.id, cardId: card.id });
    this.running.set(id, run.child);
    void run.done.then((r) => {
      this.running.delete(id);
      if (this.stopped) return; // stopAll() has already recorded it
      let result: AiReview['result'] = null;
      let error = r.error;
      if (r.answer) {
        try { result = check(r.answer, card, cwd); } catch (e) { error = `Claude Code’s answer could not be read: ${(e as Error).message}`; }
      }
      this.finish(id, card, result, r.costUsd, error);
    });
    return this.map(this.row(id));
  }

  /** Stop any review still running, when the core shuts down. */
  stopAll(): void {
    this.stopped = true;
    for (const [id, child] of this.running) {
      killChild(child);
      this.ctx.db.prepare("UPDATE ai_reviews SET state = 'failed', finished_at = ?, error = ? WHERE id = ? AND state = 'running'")
        .run(this.ctx.now(), 'Wanigan’s core stopped before this review finished. Run it again.', id);
    }
    this.running.clear();
  }

  private finish(id: string, card: CardDetail, result: AiReview['result'], cost: number | null, error: string | null): void {
    if (this.row(id).state !== 'running') return;
    this.ctx.db.prepare('UPDATE ai_reviews SET state = ?, finished_at = ?, result_json = ?, cost_usd = ?, error = ? WHERE id = ?')
      .run(error ? 'failed' : 'done', this.ctx.now(), result ? JSON.stringify(result) : null, cost, error, id);
    this.board.log({
      projectId: card.projectId, cardId: card.id, actor: 'system',
      verb: error ? 'could not finish an AI review'
        : `got an AI review: ${result?.verdict === 'pass' ? 'looks done' : result?.verdict === 'changes' ? 'changes needed' : 'needs your judgment'}`,
      detail: error ?? result?.summary ?? null,
    });
    this.ctx.emit('board', { projectId: card.projectId, cardId: card.id });
  }

  private row(id: string): Row {
    const row = this.ctx.db.prepare('SELECT * FROM ai_reviews WHERE id = ?').get(id) as Row | undefined;
    if (!row) throw new CoreError('not_found', 'No such review.');
    return row;
  }

  private map(r: Row): AiReview {
    return toAiReview(r);
  }
}

/**
 * Check the reviewer. Every cited quote must be in the cited file, inside the
 * folder it was asked about or one of the files the card offers as evidence
 * (an agent's test output often lies outside the project). A pass that rests on
 * a quote that cannot be found, or that leaves a criterion unchecked, is
 * downgraded to "unsure".
 */
export function check(raw: Record<string, unknown>, card: Pick<CardDetail, 'criteria' | 'evidence'>, cwd: string): NonNullable<AiReview['result']> {
  const evidence = card.evidence.filter((e) => e.kind === 'file').map((e) => e.value);
  const items = Array.isArray(raw.criteria) ? raw.criteria as Record<string, unknown>[] : [];
  const criteria: AiReviewCriterion[] = items.map((c) => {
    const file = typeof c.file === 'string' && c.file.trim() ? c.file.trim() : null;
    const quote = typeof c.quote === 'string' && c.quote.trim() ? c.quote.trim() : null;
    return {
      criterion: String(c.criterion ?? ''),
      met: c.met === true ? true : c.met === false ? false : null,
      proof: String(c.proof ?? ''),
      file,
      quote,
      quoteFound: file && quote ? quoteIsInFile(cwd, file, quote, evidence) : null,
    };
  });
  let verdict: 'pass' | 'changes' | 'unsure' = raw.verdict === 'pass' || raw.verdict === 'changes' ? raw.verdict : 'unsure';
  const notes: string[] = [];
  if (verdict === 'pass') {
    if (criteria.some((c) => c.quoteFound === false)) { verdict = 'unsure'; notes.push('A quote it cited is not in the file it named.'); }
    if (criteria.some((c) => c.met !== true)) { verdict = 'unsure'; notes.push('It did not show every criterion met.'); }
    if (card.criteria.length > criteria.length) { verdict = 'unsure'; notes.push('It checked fewer criteria than the card has.'); }
  }
  const check = Array.isArray(raw.check) ? raw.check.map((c) => String(c).trim()).filter(Boolean).slice(0, 6) : [];
  return { verdict, summary: String(raw.summary ?? ''), check, criteria, notes };
}

function quoteIsInFile(cwd: string, file: string, quote: string, evidence: readonly string[]): boolean {
  try {
    const root = realpathSync(cwd);
    const full = realpathSync(isAbsolute(file) ? file : resolve(root, file));
    const rel = relative(root, full);
    const inside = !rel.startsWith('..') && !isAbsolute(rel);
    if (!inside && !evidence.some((e) => isAbsolute(e) && sameFile(e, full))) return false;
    // Check the opened file, not a path that can change between stat and read.
    // A pipe must never wait for a writer, and a file that grows stays bounded.
    const fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_QUOTED_FILE) return false;
      const bytes = Buffer.alloc(MAX_QUOTED_FILE + 1);
      let size = 0;
      while (size < bytes.length) {
        const n = readSync(fd, bytes, size, bytes.length - size, size);
        if (!n) break;
        size += n;
      }
      if (size > MAX_QUOTED_FILE) return false;
      const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();
      return squash(bytes.subarray(0, size).toString('utf8')).includes(squash(quote));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** Whether `path` is the file at the real path `real`. */
function sameFile(path: string, real: string): boolean {
  try { return realpathSync(path) === real; } catch { return false; }
}

function prompt(card: CardDetail, cwd: string): string {
  const lines = [
    `You are reviewing finished work for the owner of this repository (${cwd}). You can read files; you cannot change anything.`,
    '',
    `Card ${card.key}: ${card.title}`,
    card.body ? `Description:\n${card.body}` : '',
    card.criteria.length
      ? `Acceptance criteria:\n${card.criteria.map((c, i) => `${i + 1}. ${c.text}`).join('\n')}`
      : 'The card has no written criteria; judge the description as the promised outcome.',
    card.evidence.length ? `Evidence the agent offered:\n${card.evidence.map((e) => `- ${e.kind}: ${e.value}`).join('\n')}` : 'No evidence was offered.',
    '',
    'For each criterion: read the relevant code and evidence and decide whether it is met (true), not met (false), or cannot be judged from the files (null).',
    'Give your proof in one or two plain sentences. Where you can, name the file and copy an exact quote from it (one line, verbatim) that shows it; the quote will be checked against the file.',
    'Verdict: "pass" only if every criterion is met with proof; "changes" if any is not met; "unsure" if it needs a person (look and feel, product judgement, or proof only running it can give).',
    'Summary: two or three plain sentences for the owner, saying what you checked and what, if anything, is wrong.',
    'Check: two to four short steps the owner can follow to see the work for themselves (a command to run, a page to open, what to look for).',
  ];
  return lines.filter((l) => l !== '').join('\n');
}
