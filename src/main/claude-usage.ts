import fs from 'node:fs';
import path from 'node:path';
import { db } from './db';
import * as accounts from './accounts';
import { isPricedModel, syncCostOf } from './batch/pricing';

/**
 * Claude Code's own transcripts, read as a meter.
 *
 * otel.ts can only see sessions Wanigan launched: it works by owning the
 * spawned CLI's environment and aiming the exporter at itself. Everything else
 * a person runs — a plain terminal, the VS Code extension, another machine's
 * work synced into the same home, and every session that happened before
 * Wanigan was installed — is invisible to it, and the Insights empty state
 * ("Nothing has been billed yet") can therefore be false. On the machine this
 * was written against, 15,054 of 19,705 recorded turns came from the VS Code
 * entrypoint and none of them had ever reached the collector.
 *
 * The transcripts under `<config dir>/projects/**\/*.jsonl` are written whether
 * or not telemetry was ever switched on, and they are append-only. So this is
 * both a backfill and a second instrument to reconcile the first against —
 * exactly what spend.ts already does with the Admin API, one level closer to
 * home.
 *
 * WHAT KIND OF METER THIS IS. It is a token meter, not a cost meter. No
 * `costUSD` field exists anywhere in this corpus (5,135 files were checked),
 * so a dollar figure derived from it is Wanigan's arithmetic over the pricing
 * table and must be labelled as such. The token counts themselves are Claude's
 * own and are exact.
 *
 * THE DEDUPLICATION RULE, which is the whole difficulty. Claude Code writes one
 * assistant entry per content block, and each entry carries a *copy* of the
 * turn's cumulative `usage` object. Summing the file naively multiplies a
 * multi-block turn by its block count — measured here at 5,127 identical
 * duplicates in an 8,886-key sample, so the naive total runs several times
 * high. Entries are therefore folded by `requestId|message.id`.
 *
 * Which copy wins matters. ccusage — the tool this reader is modelled on —
 * keeps the FIRST entry for a key, and that is a real defect (ccusage#888):
 * 1,168 of those 8,886 keys carried *differing* usage across their copies,
 * because the earlier writes are mid-stream snapshots. First-wins banks the
 * snapshot and undercounts output tokens. Last-wins fixes almost all of it —
 * the last copy equalled the field-wise maximum in 1,167 of those 1,168 cases —
 * but not the last one, so this takes the FIELD-WISE MAXIMUM instead. Max is
 * correct whether the copies are identical, monotonically accumulating, or
 * reordered by a partial write, and it costs nothing extra to compute.
 *
 * The same fold runs across files, not just within one, because resuming a
 * session copies the earlier turns into the new transcript. That is why the
 * winning row is stored keyed by request rather than aggregated at read time.
 */

/** Claude Code's placeholder model on turns it generated without an API call. Never billed. */
const SYNTHETIC_MODEL = '<synthetic>';

/**
 * How much of a file to hold in memory at once while catching up.
 *
 * The corpus this was written against is 3.0 GB across 5,135 files. Reading a
 * whole transcript to parse it would be the wrong trade in an Electron main
 * process that also has to paint; reading a bounded slice and remembering the
 * byte offset makes the first pass resumable and every later pass nearly free,
 * since the only new bytes are the ones appended since.
 */
const SLICE_BYTES = 4 * 1024 * 1024;

/**
 * Wall-clock ceiling for one ingest call.
 *
 * An ingest is never all-or-nothing: it persists per-file progress as it goes
 * and returns `done: false` when there is more to do. A caller on the UI path
 * passes a small budget and shows what has landed so far; the background timer
 * passes a larger one. Neither can wedge the process on a first run.
 */
const DEFAULT_BUDGET_MS = 400;

type FileRow = { path: string; size: number; mtime_ms: number; byte_offset: number };

export type ClaudeUsageRow = {
  requestKey: string;
  at: number;
  model: string;
  cwd: string | null;
  sessionId: string | null;
  effort: string | null;
  entrypoint: string | null;
  sidechain: boolean;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
};

/** Progress a caller can show, and the reason to call again. */
export type IngestResult = {
  /** Files whose bytes were fully consumed this call. */
  filesRead: number;
  /** Files stat-ed and skipped because neither size nor mtime had moved. */
  filesSkipped: number;
  /** Distinct request keys written or merged. */
  rowsWritten: number;
  bytesRead: number;
  ms: number;
  /** False when the budget ran out with files still behind. Call again. */
  done: boolean;
  /** Files known to be behind, at the moment this returned. */
  pending: number;
};

/* ── locating the transcripts ─────────────────────────────────────────── */

/**
 * Every `projects` root Claude Code might be writing into.
 *
 * accounts.readRoots() is the one answer to this question in the codebase —
 * transcripts.ts resolves the context meter's files through it — and it is
 * already the right one: every adopted account's directory, plus the ambient
 * CLAUDE_CONFIG_DIR, which is what a person's own hand-run CLI uses and
 * therefore exactly the lane this reader exists to see.
 */
function projectRoots(): string[] {
  const roots = accounts.readRoots('claude-code').map((dir) => path.join(dir, 'projects'));
  return roots.filter((dir) => {
    try { return fs.statSync(dir).isDirectory(); } catch { return false; }
  });
}

/**
 * How deep under a `projects` root a transcript can sit.
 *
 * Not a guess. A session's own transcript is one level down
 * (`projects/<slug>/<uuid>.jsonl`), but a subagent writes into
 * `<uuid>/subagents/agent-*.jsonl` and a subagent that spawns another nests
 * again from there. On the corpus this was measured against, 4,618 of 5,135
 * transcripts were subagent files and only 286 sat at the shallow depth — a
 * one-level walk found 6% of the work and would have reported the other 94% as
 * having never happened. Eight is roomy enough for nesting nobody has reached
 * and still bounded, so a symlink loop or an unrelated deep tree under the
 * config directory cannot turn this into an unbounded crawl.
 */
const MAX_WALK_DEPTH = 8;

/**
 * Directories under a root that never hold transcripts.
 *
 * `memory` is Claude Code's own auto-memory store — markdown, not turns. It is
 * skipped by name rather than by extension because accounts.ts already treats
 * that path as a distinct thing, and walking it would put a person's memory
 * files in the way of an accounting read for no gain.
 */
const SKIP_DIRS = new Set(['memory']);

/**
 * Every transcript under a root, subagents included.
 *
 * Symlinked directories are not followed: `withFileTypes` reports the link
 * itself, and `isDirectory()` is false for one, so a link out of the config
 * directory is simply not a place this walks. Unreadable entries are skipped
 * rather than thrown — one bad directory must not stop the other five thousand
 * files.
 */
function transcriptFiles(roots?: string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth >= MAX_WALK_DEPTH || SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(dir, entry.name), depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        out.push(path.join(dir, entry.name));
      }
    }
  };
  for (const root of roots ?? projectRoots()) walk(root, 0);
  return out;
}

/* ── parsing ──────────────────────────────────────────────────────────── */

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : 0;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

type Entry = {
  type?: unknown;
  requestId?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  effort?: unknown;
  entrypoint?: unknown;
  cwd?: unknown;
  sessionId?: unknown;
  isSidechain?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: Record<string, unknown>;
  };
};

/**
 * One transcript line as a usage row, or null for the great majority of lines
 * that carry no usage at all.
 *
 * A line without a request identity is dropped rather than given a synthetic
 * key: the key is the only thing that makes the fold idempotent, and a row that
 * cannot be folded would be re-added on every pass over the same bytes.
 * `<synthetic>` turns are dropped for a different reason — they are Claude
 * Code's own local messages, never an API call, and pricing them would invent
 * money that was never spent.
 */
export function rowOf(line: string): ClaudeUsageRow | null {
  let raw: Entry;
  try { raw = JSON.parse(line) as Entry; } catch { return null; }
  const usage = raw.message?.usage;
  if (!usage) return null;

  const model = text(raw.message?.model);
  if (!model || model === SYNTHETIC_MODEL) return null;

  const requestId = text(raw.requestId);
  const messageId = text(raw.message?.id);
  if (!requestId && !messageId) return null;

  const at = Date.parse(String(raw.timestamp ?? ''));
  if (!Number.isFinite(at)) return null;

  // The 5m and 1h halves are billed at different multipliers (1.25x and 2.0x
  // of base input), so they are stored apart. `cache_creation_input_tokens` is
  // their sum and is the only field older transcripts carry; it is attributed
  // to the 5-minute rate, which is the cheaper of the two — an unknown split
  // should not quietly bill at the dearer one.
  const creation = usage.cache_creation as Record<string, unknown> | undefined;
  const split5m = finite(creation?.ephemeral_5m_input_tokens);
  const split1h = finite(creation?.ephemeral_1h_input_tokens);
  const creationTotal = finite(usage.cache_creation_input_tokens);
  const has = split5m > 0 || split1h > 0;

  return {
    requestKey: `${requestId ?? ''}|${messageId ?? ''}`,
    at,
    model,
    cwd: text(raw.cwd),
    sessionId: text(raw.sessionId),
    effort: text(raw.effort),
    entrypoint: text(raw.entrypoint),
    sidechain: raw.isSidechain === true,
    inTokens: finite(usage.input_tokens),
    outTokens: finite(usage.output_tokens),
    cacheRead: finite(usage.cache_read_input_tokens),
    cacheWrite5m: has ? split5m : creationTotal,
    cacheWrite1h: has ? split1h : 0,
  };
}

/* ── ingest ───────────────────────────────────────────────────────────── */

/**
 * Fold one row into the store.
 *
 * MAX on every token column is what makes this safe to run repeatedly over the
 * same bytes and across the copies of a turn that a resumed session leaves in
 * two files. The descriptive columns take the incoming value only when the
 * stored one is null, so a later copy stripped of its `cwd` cannot erase the
 * attribution an earlier one carried.
 */
const UPSERT = `
  INSERT INTO claude_usage_events
    (request_key, at, model, cwd, session_id, effort, entrypoint, sidechain,
     in_tokens, out_tokens, cache_read, cache_write_5m, cache_write_1h)
  VALUES (@requestKey, @at, @model, @cwd, @sessionId, @effort, @entrypoint, @sidechain,
          @inTokens, @outTokens, @cacheRead, @cacheWrite5m, @cacheWrite1h)
  ON CONFLICT(request_key) DO UPDATE SET
    at             = MIN(claude_usage_events.at, excluded.at),
    cwd            = COALESCE(claude_usage_events.cwd, excluded.cwd),
    session_id     = COALESCE(claude_usage_events.session_id, excluded.session_id),
    effort         = COALESCE(claude_usage_events.effort, excluded.effort),
    entrypoint     = COALESCE(claude_usage_events.entrypoint, excluded.entrypoint),
    in_tokens      = MAX(claude_usage_events.in_tokens, excluded.in_tokens),
    out_tokens     = MAX(claude_usage_events.out_tokens, excluded.out_tokens),
    cache_read     = MAX(claude_usage_events.cache_read, excluded.cache_read),
    cache_write_5m = MAX(claude_usage_events.cache_write_5m, excluded.cache_write_5m),
    cache_write_1h = MAX(claude_usage_events.cache_write_1h, excluded.cache_write_1h)
`;

/**
 * Read the bytes of one file that have not been read before.
 *
 * Returns the number of bytes consumed, which is deliberately not the number
 * read: a slice almost always ends mid-line, and the remainder after the last
 * newline is left unconsumed so the next pass sees that line whole. A file that
 * has shrunk since it was last seen is not a transcript that lost turns — it is
 * a different file at the same path — so its offset resets rather than being
 * trusted into the middle of unrelated bytes.
 */
function readSlice(file: string, from: number, upTo: number): { rows: ClaudeUsageRow[]; consumed: number } {
  const length = Math.min(SLICE_BYTES, upTo - from);
  if (length <= 0) return { rows: [], consumed: 0 };

  let fd: number | null = null;
  let buffer: Buffer;
  let read = 0;
  try {
    fd = fs.openSync(file, 'r');
    buffer = Buffer.alloc(length);
    read = fs.readSync(fd, buffer, 0, length, from);
  } catch {
    return { rows: [], consumed: 0 };
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* already closed */ }
  }

  const atEnd = from + read >= upTo;
  const slice = buffer.subarray(0, read);
  // Only bytes up to and including the final newline are safe to consume. At
  // the end of the file there may be no trailing newline, and the tail is then
  // a complete line rather than a partial one.
  const lastBreak = slice.lastIndexOf(0x0a);
  const usable = atEnd ? slice : lastBreak >= 0 ? slice.subarray(0, lastBreak + 1) : null;
  if (!usable) {
    // A single line longer than the slice. Skipping the slice would lose the
    // rest of the file's offsets, so consume it and accept the one lost line;
    // a transcript line this large is not a usage entry.
    return { rows: [], consumed: read };
  }

  const rows: ClaudeUsageRow[] = [];
  for (const line of usable.toString('utf8').split('\n')) {
    if (!line) continue;
    const row = rowOf(line);
    if (row) rows.push(row);
  }
  return { rows, consumed: usable.length };
}

/**
 * Catch the store up to the transcripts, within a time budget.
 *
 * Files are taken newest-first so a caller that runs out of budget on a first
 * pass has still banked the days a person is most likely to be looking at. The
 * whole call is one transaction per file rather than one for the run: a budget
 * that expires must leave the work done so far committed, or a first pass over
 * three gigabytes could never finish in a series of short calls.
 */
export function ingest(input?: { budgetMs?: number; roots?: string[] }): IngestResult {
  const started = Date.now();
  const budget = Math.max(1, Math.min(60_000, Math.floor(input?.budgetMs ?? DEFAULT_BUDGET_MS)));
  const d = db();

  const known = new Map<string, FileRow>();
  for (const row of d.prepare('SELECT path, size, mtime_ms, byte_offset FROM claude_usage_files').all() as FileRow[]) {
    known.set(row.path, row);
  }

  type Candidate = { file: string; size: number; mtimeMs: number; from: number };
  const behind: Candidate[] = [];
  let filesSkipped = 0;

  for (const file of transcriptFiles(input?.roots)) {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { continue; }
    const seen = known.get(file);
    if (seen && seen.size === stat.size && seen.mtime_ms === stat.mtimeMs && seen.byte_offset >= stat.size) {
      filesSkipped += 1;
      continue;
    }
    // Truncated or replaced: the stored offset points into bytes that are no
    // longer the same bytes. Re-read from the start; the fold makes that free.
    const from = seen && stat.size >= seen.size ? seen.byte_offset : 0;
    if (from >= stat.size) { filesSkipped += 1; continue; }
    behind.push({ file, size: stat.size, mtimeMs: stat.mtimeMs, from });
  }
  behind.sort((a, b) => b.mtimeMs - a.mtimeMs);

  const upsert = d.prepare(UPSERT);
  const mark = d.prepare(`
    INSERT INTO claude_usage_files (path, size, mtime_ms, byte_offset, scanned_at)
    VALUES (?,?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET
      size = excluded.size, mtime_ms = excluded.mtime_ms,
      byte_offset = excluded.byte_offset, scanned_at = excluded.scanned_at
  `);

  let filesRead = 0;
  let rowsWritten = 0;
  let bytesRead = 0;
  let index = 0;

  const step = d.transaction((c: Candidate, offset: number) => {
    const { rows, consumed } = readSlice(c.file, offset, c.size);
    for (const row of rows) {
      upsert.run({ ...row, sidechain: row.sidechain ? 1 : 0 });
    }
    const next = offset + consumed;
    // The recorded size and mtime are the ones this pass observed. Storing the
    // live stat instead would claim to have read bytes appended while it ran.
    mark.run(c.file, c.size, c.mtimeMs, next, Date.now());
    return { rows: rows.length, consumed, next };
  });

  for (; index < behind.length; index += 1) {
    const c = behind[index];
    let offset = c.from;
    while (offset < c.size) {
      const out = step(c, offset) as { rows: number; consumed: number; next: number };
      rowsWritten += out.rows;
      bytesRead += out.consumed;
      offset = out.next;
      if (out.consumed === 0) break;
      if (Date.now() - started >= budget) break;
    }
    if (offset >= c.size) filesRead += 1;
    if (Date.now() - started >= budget) { index += 1; break; }
  }

  const pending = Math.max(0, behind.length - index);
  return {
    filesRead,
    filesSkipped,
    rowsWritten,
    bytesRead,
    ms: Date.now() - started,
    done: pending === 0,
    pending,
  };
}

/* ── reading ──────────────────────────────────────────────────────────── */

/** Nothing has been ingested yet, so a surface can say so instead of "zero spend". */
export function isEmpty(): boolean {
  const row = db().prepare('SELECT 1 AS one FROM claude_usage_events LIMIT 1').get() as { one: number } | undefined;
  return row === undefined;
}

export type ClaudeCoverage = {
  /** Distinct API turns folded out of the transcripts. */
  requests: number;
  /** Of those, how many came from an entrypoint Wanigan did not launch. */
  outsideWanigan: number;
  firstAt: number | null;
  lastAt: number | null;
  files: number;
  /** Files with bytes still unread. Non-zero means the figures are still growing. */
  filesBehind: number;
};

/**
 * How much of the record this meter is currently speaking for.
 *
 * `outsideWanigan` is the number the page exists to show: it is exactly the
 * work otel.ts can never have seen, and it is the honest answer to "why is this
 * bigger than the other chart".
 */
export function coverage(): ClaudeCoverage {
  const d = db();
  const totals = d.prepare(`
    SELECT COUNT(*) AS requests,
           COALESCE(SUM(CASE WHEN entrypoint IS NOT NULL AND entrypoint <> 'cli' THEN 1 ELSE 0 END), 0) AS outside,
           MIN(at) AS first_at, MAX(at) AS last_at
    FROM claude_usage_events
  `).get() as { requests: number; outside: number; first_at: number | null; last_at: number | null };

  const files = d.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN byte_offset < size THEN 1 ELSE 0 END), 0) AS behind
    FROM claude_usage_files
  `).get() as { n: number; behind: number };

  return {
    requests: totals.requests ?? 0,
    outsideWanigan: totals.outside ?? 0,
    firstAt: totals.first_at,
    lastAt: totals.last_at,
    files: files.n ?? 0,
    filesBehind: files.behind ?? 0,
  };
}

export type ClaudeUsageTotals = {
  requests: number;
  inTokens: number;
  outTokens: number;
  cacheRead: number;
  cacheWrite: number;
  /** Wanigan's arithmetic over the pricing table, at the rate in force on each turn. */
  costUsd: number;
  /** Turns whose model has no published rate, so `costUsd` does not speak for them. */
  unpricedRequests: number;
};

type TokenRow = {
  model: string; at: number; requests: number;
  in_tokens: number; out_tokens: number; cache_read: number;
  cache_write_5m: number; cache_write_1h: number;
};

/**
 * Priced totals over a window.
 *
 * Grouping by model AND day before pricing is what makes the rate schedule in
 * pricing.ts mean anything: a window that spans a rate change has to be priced
 * on both sides of it, and one lump sum per model could only ever be priced at
 * one of the two.
 */
function pricedRows(sinceMs: number | null): TokenRow[] {
  const where = sinceMs === null ? '' : 'WHERE at >= ?';
  const sql = `
    SELECT model,
           MIN(at) AS at,
           COUNT(*) AS requests,
           COALESCE(SUM(in_tokens), 0) AS in_tokens,
           COALESCE(SUM(out_tokens), 0) AS out_tokens,
           COALESCE(SUM(cache_read), 0) AS cache_read,
           COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
           COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h
    FROM claude_usage_events ${where}
    GROUP BY model, date(at / 1000, 'unixepoch', 'localtime')
  `;
  const statement = db().prepare(sql);
  return (sinceMs === null ? statement.all() : statement.all(sinceMs)) as TokenRow[];
}

export function totals(sinceMs: number | null): ClaudeUsageTotals {
  const out: ClaudeUsageTotals = {
    requests: 0, inTokens: 0, outTokens: 0, cacheRead: 0, cacheWrite: 0,
    costUsd: 0, unpricedRequests: 0,
  };

  for (const row of pricedRows(sinceMs)) {
    out.requests += row.requests;
    out.inTokens += row.in_tokens;
    out.outTokens += row.out_tokens;
    out.cacheRead += row.cache_read;
    out.cacheWrite += row.cache_write_5m + row.cache_write_1h;

    if (!isPricedModel(row.model, row.at)) {
      out.unpricedRequests += row.requests;
      continue;
    }
    out.costUsd += syncCostOf(row.model, {
      input_tokens: row.in_tokens,
      output_tokens: row.out_tokens,
      cache_read_input_tokens: row.cache_read,
      cache_creation_5m: row.cache_write_5m,
      cache_creation_1h: row.cache_write_1h,
    }, row.at);
  }
  return out;
}

export type ClaudeUsageDay = { day: string; costUsd: number; tokens: number; unpricedRequests: number };

/**
 * The transcript meter on the same daily axis the other three surfaces use, so
 * it can be drawn beside them rather than in a chart of its own.
 */
export function byDay(sinceMs: number): ClaudeUsageDay[] {
  const rows = db().prepare(`
    SELECT date(at / 1000, 'unixepoch', 'localtime') AS day,
           model,
           MIN(at) AS at,
           COUNT(*) AS requests,
           COALESCE(SUM(in_tokens), 0) AS in_tokens,
           COALESCE(SUM(out_tokens), 0) AS out_tokens,
           COALESCE(SUM(cache_read), 0) AS cache_read,
           COALESCE(SUM(cache_write_5m), 0) AS cache_write_5m,
           COALESCE(SUM(cache_write_1h), 0) AS cache_write_1h
    FROM claude_usage_events WHERE at >= ?
    GROUP BY day, model
  `).all(sinceMs) as (TokenRow & { day: string })[];

  const acc = new Map<string, ClaudeUsageDay>();
  for (const row of rows) {
    const day = acc.get(row.day) ?? { day: row.day, costUsd: 0, tokens: 0, unpricedRequests: 0 };
    day.tokens += row.in_tokens + row.out_tokens + row.cache_read + row.cache_write_5m + row.cache_write_1h;
    if (isPricedModel(row.model, row.at)) {
      day.costUsd += syncCostOf(row.model, {
        input_tokens: row.in_tokens,
        output_tokens: row.out_tokens,
        cache_read_input_tokens: row.cache_read,
        cache_creation_5m: row.cache_write_5m,
        cache_creation_1h: row.cache_write_1h,
      }, row.at);
    } else {
      day.unpricedRequests += row.requests;
    }
    acc.set(row.day, day);
  }
  return [...acc.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Tokens per minute since `sinceMs`, and where the window ends if it holds.
 *
 * Deliberately a token rate rather than a dollar rate. The thing a five-hour
 * window actually meters is tokens against a plan limit, and the account's own
 * answer to "how much is left" comes from claude-limits.ts asking the provider.
 * A dollar burn rate would be Wanigan's arithmetic dressed up as a plan reading.
 */
export type BurnRate = {
  windowStartMs: number;
  elapsedMinutes: number;
  tokens: number;
  requests: number;
  tokensPerMinute: number;
  /** Tokens by the end of the window if the observed rate holds. Null with no end. */
  projectedTokens: number | null;
};

export function burnRate(sinceMs: number, windowEndMs: number | null): BurnRate {
  const row = db().prepare(`
    SELECT COUNT(*) AS requests,
           COALESCE(SUM(in_tokens + out_tokens + cache_read + cache_write_5m + cache_write_1h), 0) AS tokens
    FROM claude_usage_events WHERE at >= ?
  `).get(sinceMs) as { requests: number; tokens: number };

  // A window that has just opened divides by a fraction of a minute and reports
  // a rate in the millions. One minute is the floor for the same reason
  // spend.ts counts today as a whole elapsed day: a number nobody can act on is
  // worse than a slightly conservative one.
  const elapsedMinutes = Math.max(1, (Date.now() - sinceMs) / 60_000);
  const perMinute = row.tokens / elapsedMinutes;
  const remaining = windowEndMs === null ? null : Math.max(0, (windowEndMs - Date.now()) / 60_000);

  return {
    windowStartMs: sinceMs,
    elapsedMinutes,
    tokens: row.tokens ?? 0,
    requests: row.requests ?? 0,
    tokensPerMinute: perMinute,
    projectedTokens: remaining === null ? null : Math.round(row.tokens + perMinute * remaining),
  };
}

export const __test = { rowOf, readSlice, transcriptFiles, projectRoots };

/**
 * Models present in the transcripts that this pricing table cannot price, with
 * how many turns each accounts for, dearest-looking first.
 *
 * Named rather than counted, because the fix is a one-line edit to MODELS and
 * nobody can make it from a bare number. A model released after the table was
 * last touched is the normal case here, not a corruption — `claude-fable-5-1`
 * was 2,468 turns on the machine this was written against — and the surface
 * that shows a total has to be able to say which work it is not speaking for.
 */
export function unpricedModels(sinceMs: number | null): { model: string; requests: number }[] {
  const where = sinceMs === null ? '' : 'WHERE at >= ?';
  const statement = db().prepare(`
    SELECT model, MIN(at) AS at, COUNT(*) AS requests
    FROM claude_usage_events ${where}
    GROUP BY model ORDER BY requests DESC
  `);
  const rows = (sinceMs === null ? statement.all() : statement.all(sinceMs)) as
    { model: string; at: number; requests: number }[];
  return rows
    .filter((row) => !isPricedModel(row.model, row.at))
    .map((row) => ({ model: row.model, requests: row.requests }));
}
