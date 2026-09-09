import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db';
import * as claudeUsage from './claude-usage';
import { CACHE_MULTIPLIER, MODELS, costOf, findModel, isPricedModel, pickRate, rateAt } from './batch/pricing';

type Check = (ok: boolean, label: string, detail?: unknown) => void;
type Say = (s: string) => void;

/**
 * Offline contract tests for the Claude transcript meter and the rate
 * schedule. Fixture transcripts are handed to `ingest({ roots })` directly
 * rather than through CLAUDE_CONFIG_DIR, so the suite can never wander into the
 * operator's real 3 GB corpus and its numbers are exact rather than whatever
 * happens to be on the machine.
 *
 * The cases are the ones that cost real money if they regress: the fold that
 * stops a multi-block turn being counted once per block, the field-wise maximum
 * that stops a mid-stream snapshot being banked as the final count, the
 * cross-file fold that stops a resumed session paying twice, and the refusal to
 * price a model the table has never heard of.
 */
export async function runClaudeMeterSmoke(check: Check, say: Say): Promise<void> {
  say('── claude transcript meter · fold, backfill, rate schedule');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wanigan-ctm-'));
  const root = path.join(base, 'projects');
  const dir = path.join(root, '-Users-x-repo');
  fs.mkdirSync(dir, { recursive: true });

  const T0 = Date.parse('2026-09-01T10:00:00.000Z');
  const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

  type Tok = { in?: number; out?: number; read?: number; c5?: number; c1h?: number; legacy?: number };
  const line = (o: {
    req: string | null; msg: string | null; tok: Tok; at?: number;
    model?: string; entrypoint?: string; effort?: string; cwd?: string; sidechain?: boolean;
  }) => JSON.stringify({
    type: 'assistant',
    timestamp: iso(o.at ?? 0),
    requestId: o.req,
    uuid: `u-${Math.random().toString(36).slice(2)}`,
    cwd: o.cwd ?? '/Users/x/repo',
    sessionId: 'sess-1',
    effort: o.effort ?? 'default',
    entrypoint: o.entrypoint ?? 'cli',
    isSidechain: o.sidechain ?? false,
    message: {
      id: o.msg,
      role: 'assistant',
      model: o.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: o.tok.in ?? 0,
        output_tokens: o.tok.out ?? 0,
        cache_read_input_tokens: o.tok.read ?? 0,
        ...(o.tok.legacy !== undefined ? { cache_creation_input_tokens: o.tok.legacy } : {}),
        ...(o.tok.c5 !== undefined || o.tok.c1h !== undefined
          ? {
            cache_creation: {
              ephemeral_5m_input_tokens: o.tok.c5 ?? 0,
              ephemeral_1h_input_tokens: o.tok.c1h ?? 0,
            },
          }
          : {}),
      },
    },
  });

  const write = (name: string, lines: string[]) =>
    fs.writeFileSync(path.join(dir, name), lines.join('\n') + '\n');
  const append = (name: string, lines: string[]) =>
    fs.appendFileSync(path.join(dir, name), lines.join('\n') + '\n');

  // Both halves, every time. Clearing the tables but leaving the fixture files
  // on disk would let the previous case's transcript be re-ingested by the next
  // one — the bookmark is gone, so nothing stops it being read again — and every
  // total after the first would quietly carry work from a test that had ended.
  const wipe = () => {
    db().exec('DELETE FROM claude_usage_events; DELETE FROM claude_usage_files;');
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith('.jsonl')) fs.rmSync(path.join(dir, name), { force: true });
    }
  };
  const run = (budgetMs = 5_000) => claudeUsage.ingest({ budgetMs, roots: [root] });

  try {
    /* ── one line in, one row out ──────────────────────────────────── */
    wipe();
    write('a.jsonl', [
      'not json at all, and tolerated',
      line({ req: 'req_1', msg: 'msg_1', tok: { in: 100, out: 50, read: 10, c5: 5, c1h: 2 } }),
    ]);
    let r = run();
    check(r.done && r.rowsWritten === 1, 'a single usage line ingests as one row', JSON.stringify(r));

    let t = claudeUsage.totals(null);
    check(t.requests === 1 && t.inTokens === 100 && t.outTokens === 50
      && t.cacheRead === 10 && t.cacheWrite === 7,
      'token columns land as written, with the cache halves summed for display', JSON.stringify(t));

    /* ── the fold: identical copies of one turn ────────────────────── */
    wipe();
    const dup = { req: 'req_2', msg: 'msg_2', tok: { in: 4, out: 900, read: 30_000, c5: 1_000 } };
    write('b.jsonl', [line(dup), line(dup), line(dup), line(dup)]);
    run();
    t = claudeUsage.totals(null);
    check(t.requests === 1 && t.outTokens === 900,
      'four identical copies of one turn count once, not four times', JSON.stringify(t));

    /* ── the fold: copies that disagree ────────────────────────────── */
    // The shape ccusage gets wrong. The first copy is a mid-stream snapshot;
    // keeping it undercounts output by 890 tokens on this one turn alone.
    wipe();
    write('c.jsonl', [
      line({ req: 'req_3', msg: 'msg_3', tok: { in: 4, out: 10, read: 100 } }),
      line({ req: 'req_3', msg: 'msg_3', tok: { in: 4, out: 400, read: 100 } }),
      line({ req: 'req_3', msg: 'msg_3', tok: { in: 4, out: 900, read: 100 } }),
    ]);
    run();
    t = claudeUsage.totals(null);
    check(t.requests === 1 && t.outTokens === 900,
      'disagreeing copies keep the largest count, not the first', JSON.stringify(t));

    // The case that makes maximum the rule rather than last-wins: one key in
    // 1,168 on the corpus this was measured against ends on a lower value.
    wipe();
    write('d.jsonl', [
      line({ req: 'req_4', msg: 'msg_4', tok: { out: 900, read: 100 } }),
      line({ req: 'req_4', msg: 'msg_4', tok: { out: 120, read: 100 } }),
    ]);
    run();
    check(claudeUsage.totals(null).outTokens === 900,
      'a final copy smaller than an earlier one does not shrink the turn');

    /* ── the fold across files: a resumed session ──────────────────── */
    wipe();
    const shared = { req: 'req_5', msg: 'msg_5', tok: { in: 2, out: 700, read: 500 } };
    write('e1.jsonl', [line(shared)]);
    write('e2.jsonl', [line(shared), line({ req: 'req_6', msg: 'msg_6', tok: { out: 11 } })]);
    run();
    t = claudeUsage.totals(null);
    check(t.requests === 2 && t.outTokens === 711,
      'a turn copied into a resumed session’s transcript is not paid for twice', JSON.stringify(t));

    /* ── what is not a billable turn ───────────────────────────────── */
    wipe();
    write('f.jsonl', [
      line({ req: 'req_7', msg: 'msg_7', tok: { out: 5 }, model: '<synthetic>' }),
      line({ req: null, msg: null, tok: { out: 5 } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'assistant', timestamp: iso(0), requestId: 'req_8', message: { id: 'msg_8', model: 'claude-sonnet-5' } }),
    ]);
    run();
    check(claudeUsage.totals(null).requests === 0,
      'synthetic turns, identity-less lines, user lines and usage-less lines are all skipped');

    /* ── subagent transcripts, which are most of the corpus ────────── */
    // A one-level walk found 286 of 5,135 files on the machine this was
    // written against: the rest are subagent transcripts nested under
    // <session>/subagents/, and a subagent that spawns another nests again.
    // Missing them reported 6% of the work and called the other 94% absent.
    wipe();
    const deep = path.join(dir, 'sess-uuid', 'subagents');
    const deeper = path.join(deep, 'agent-1', 'subagents');
    fs.mkdirSync(deeper, { recursive: true });
    fs.mkdirSync(path.join(dir, 'sess-uuid', 'memory'), { recursive: true });
    write('sess-uuid.jsonl', [line({ req: 'req_p', msg: 'msg_p', tok: { out: 100 } })]);
    fs.writeFileSync(path.join(deep, 'agent-1.jsonl'),
      line({ req: 'req_s1', msg: 'msg_s1', tok: { out: 20 } }) + '\n');
    fs.writeFileSync(path.join(deeper, 'agent-2.jsonl'),
      line({ req: 'req_s2', msg: 'msg_s2', tok: { out: 3 } }) + '\n');
    // Auto-memory lives beside the transcripts and is not turns. A .jsonl there
    // would still be skipped, because the directory is never walked.
    fs.writeFileSync(path.join(dir, 'sess-uuid', 'memory', 'notes.jsonl'),
      line({ req: 'req_mem', msg: 'msg_mem', tok: { out: 9_999 } }) + '\n');
    run();
    t = claudeUsage.totals(null);
    check(t.requests === 3 && t.outTokens === 123,
      'nested subagent transcripts count, and the memory directory is not walked', JSON.stringify(t));
    fs.rmSync(path.join(dir, 'sess-uuid'), { recursive: true, force: true });

    /* ── incremental catch-up ──────────────────────────────────────── */
    wipe();
    write('g.jsonl', [line({ req: 'req_9', msg: 'msg_9', tok: { out: 100 } })]);
    run();
    const afterFirst = claudeUsage.totals(null).outTokens;
    const second = run();
    check(second.bytesRead === 0 && second.filesSkipped >= 1,
      'a file that has not moved is stat-ed and skipped, not re-read', JSON.stringify(second));

    append('g.jsonl', [line({ req: 'req_10', msg: 'msg_10', tok: { out: 250 }, at: 1000 })]);
    const third = run();
    t = claudeUsage.totals(null);
    check(third.bytesRead > 0 && t.outTokens === afterFirst + 250 && t.requests === 2,
      'appended turns are read from the stored offset and add to the total', JSON.stringify({ third, t }));

    /* ── resumability under a budget ───────────────────────────────── */
    wipe();
    for (let i = 0; i < 40; i += 1) {
      write(`h${i}.jsonl`, [line({ req: `req_h${i}`, msg: `msg_h${i}`, tok: { out: 10 } })]);
    }
    // A budget this small expires inside the loop; the contract is that it
    // stops cleanly with progress committed, not that it finishes.
    const partial = claudeUsage.ingest({ budgetMs: 1, roots: [root] });
    let guard = 0;
    let last = partial;
    while (!last.done && guard < 200) { last = run(200); guard += 1; }
    t = claudeUsage.totals(null);
    check(last.done && t.requests === 40 && t.outTokens === 400,
      'an ingest that runs out of budget resumes and reaches the same total', JSON.stringify({ guard, t }));

    /* ── coverage: the work telemetry could never have seen ────────── */
    wipe();
    write('i.jsonl', [
      line({ req: 'req_11', msg: 'msg_11', tok: { out: 1 }, entrypoint: 'cli' }),
      line({ req: 'req_12', msg: 'msg_12', tok: { out: 1 }, entrypoint: 'claude-vscode' }),
      line({ req: 'req_13', msg: 'msg_13', tok: { out: 1 }, entrypoint: 'claude-vscode' }),
    ]);
    run();
    const cover = claudeUsage.coverage();
    check(cover.requests === 3 && cover.outsideWanigan === 2 && cover.filesBehind === 0,
      'coverage separates turns from an entrypoint Wanigan never launched', JSON.stringify(cover));

    /* ── refusing to price what the table does not know ────────────── */
    wipe();
    write('j.jsonl', [
      line({ req: 'req_14', msg: 'msg_14', tok: { in: 1_000_000 }, model: 'claude-not-a-real-model-9' }),
      line({ req: 'req_15', msg: 'msg_15', tok: { in: 1_000_000 }, model: 'claude-sonnet-5' }),
    ]);
    run();
    t = claudeUsage.totals(null);
    const unpriced = claudeUsage.unpricedModels(null);
    check(t.unpricedRequests === 1 && unpriced.length === 1 && unpriced[0].model === 'claude-not-a-real-model-9',
      'an unknown model is counted as unpriced and named, never priced at a stand-in rate',
      JSON.stringify({ unpriced, t }));
    // Sonnet 5 batch input is $1.00/MTok, so one million input tokens at
    // synchronous rates is exactly $2.00 and the unknown model adds nothing.
    check(Math.abs(t.costUsd - 2) < 1e-9,
      'the priced half of a mixed window is the only half that reaches the total', t.costUsd);

    /* ── the cache halves are billed apart ─────────────────────────── */
    const sonnet = findModel('claude-sonnet-5')!;
    const write5m = costOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, cache_creation_5m: 1_000_000 });
    const write1h = costOf('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, cache_creation_1h: 1_000_000 });
    check(Math.abs(write5m - sonnet.batchInput * CACHE_MULTIPLIER.write5m) < 1e-9
      && Math.abs(write1h - sonnet.batchInput * CACHE_MULTIPLIER.write1h) < 1e-9,
      'a 1-hour cache write bills at 2.0x base input and a 5-minute one at 1.25x',
      JSON.stringify({ write5m, write1h }));

    const legacy = costOf('claude-sonnet-5', {
      input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000,
    });
    check(Math.abs(legacy - write5m) < 1e-9,
      'a transcript with no split attributes its cache writes to the cheaper rate');

    /* ── the rate schedule ─────────────────────────────────────────── */
    const changeover = Date.parse('2026-06-01T00:00:00.000Z');
    const scheduled = { ...sonnet, history: [{ until: changeover, batchInput: 0.5, batchOutput: 2.5 }] };
    check(pickRate(scheduled, changeover - 1).batchInput === 0.5
      && pickRate(scheduled, changeover).batchInput === sonnet.batchInput,
      'a turn before a rate change is priced at the rate that was in force');
    check(pickRate(sonnet, 0).batchInput === sonnet.batchInput,
      'a model that has never moved prices the same at every instant');
    check(MODELS.every((m) => (m.history ?? []).every((h, i, all) => i === 0 || all[i - 1].until <= h.until)),
      'every shipped rate history is ordered oldest-first, which is what the walk assumes');
    check(rateAt('claude-not-a-real-model-9') === undefined && isPricedModel('claude-sonnet-5'),
      'rateAt answers undefined for an unknown model rather than a stand-in');

    /* ── burn rate ─────────────────────────────────────────────────── */
    wipe();
    const now = Date.now();
    db().prepare(`
      INSERT INTO claude_usage_events
        (request_key, at, model, sidechain, in_tokens, out_tokens, cache_read, cache_write_5m, cache_write_1h)
      VALUES ('burn-1', ?, 'claude-sonnet-5', 0, 300, 300, 0, 0, 0)
    `).run(now - 30 * 60_000);
    const burn = claudeUsage.burnRate(now - 60 * 60_000, now + 60 * 60_000);
    check(Math.abs(burn.tokensPerMinute - 10) < 0.5 && burn.projectedTokens !== null
      && burn.projectedTokens > burn.tokens,
      '600 tokens over an hour reads as 10/min and projects forward, not backward', JSON.stringify(burn));
    const cold = claudeUsage.burnRate(now - 1_000, null);
    check(cold.projectedTokens === null && cold.elapsedMinutes >= 1,
      'a window with no end projects nothing, and a fresh one cannot divide by a sliver', JSON.stringify(cold));

    wipe();
    check(claudeUsage.isEmpty(), 'an empty store says so rather than reporting zero spend');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
    try { db().exec('DELETE FROM claude_usage_events; DELETE FROM claude_usage_files;'); } catch { /* db may be closed */ }
  }
}
