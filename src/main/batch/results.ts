import fs from 'node:fs';
import path from 'node:path';
import { db, logEvent, resultsDir } from '../db';
import { client, isMock } from './anthropic';
import { costOf } from './pricing';
import { mockResults } from './mock';

type ResultLine = {
  custom_id: string;
  result:
    | { type: 'succeeded'; message: { content: { type: string; text?: string }[]; stop_reason: string | null; usage: Record<string, number> } }
    | { type: 'errored'; error: { error?: { type?: string; message?: string } } }
    | { type: 'canceled' }
    | { type: 'expired' };
};

/**
 * Streams a finished batch's .jsonl into SQLite one line at a time. Results can
 * be hundreds of MB and are returned in arbitrary order, so every row is matched
 * back to its input by custom_id, never by position.
 */
export async function ingestResults(runId: string, batchId: string, model: string): Promise<{ ingested: number }> {
  const d = db();
  const archive = path.join(resultsDir(), `${batchId}.jsonl`);
  fs.mkdirSync(resultsDir(), { recursive: true });
  const out = fs.createWriteStream(archive, { flags: 'w' });

  const update = d.prepare(`
    UPDATE requests SET status=@status, output_text=@text, output_json=@json, stop_reason=@stop,
      error_type=@etype, error_message=@emsg, in_tokens=@in, out_tokens=@out,
      cache_read=@cr, cache_write=@cw
    WHERE run_id=@run AND custom_id=@cid
  `);

  let ingested = 0;
  let unmatched = 0;
  const batchSize = 500;
  let buffer: Record<string, unknown>[] = [];

  const flush = d.transaction((rows: Record<string, unknown>[]) => {
    for (const r of rows) {
      const info = update.run(r);
      if (info.changes === 0) unmatched++;
    }
  });

  const iter: Iterable<ResultLine> | AsyncIterable<ResultLine> = isMock()
    ? (mockResults(batchId) as Iterable<ResultLine>)
    : (client().messages.batches.results(batchId) as unknown as AsyncIterable<ResultLine>);

  for await (const line of iter as AsyncIterable<ResultLine>) {
    out.write(JSON.stringify(line) + '\n');
    buffer.push(toRow(runId, line));
    ingested++;
    if (buffer.length >= batchSize) { flush(buffer); buffer = []; }
  }
  if (buffer.length) flush(buffer);
  out.end();

  if (unmatched) {
    logEvent(runId, 'warn', `${unmatched} result line(s) had a custom_id not present in this run.`);
  }
  logEvent(runId, 'info', `Ingested ${ingested.toLocaleString()} results from ${batchId} → ${path.basename(archive)}`);

  d.prepare('UPDATE batches SET results_ingested_at = ? WHERE id = ?').run(Date.now(), batchId);
  rollUp(runId, model);
  return { ingested };
}

function toRow(runId: string, line: ResultLine) {
  const base = {
    run: runId, cid: line.custom_id,
    status: line.result.type, text: null as string | null, json: null as string | null,
    stop: null as string | null, etype: null as string | null, emsg: null as string | null,
    in: 0, out: 0, cr: 0, cw: 0,
  };
  if (line.result.type === 'succeeded') {
    const m = line.result.message;
    const u = m.usage || {};
    // stop_reason "refusal" is an HTTP 200 with no usable content — safety
    // classifiers declined. Counting it as a success silently drops rows.
    const refused = m.stop_reason === 'refusal';
    const detail = (m as { stop_details?: { category?: string; explanation?: string } }).stop_details;
    return {
      ...base,
      status: refused ? 'refused' : 'succeeded',
      etype: refused ? `refusal:${detail?.category ?? 'unspecified'}` : null,
      emsg: refused ? (detail?.explanation ?? 'The model declined this request.') : null,
      text: (m.content || []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'),
      json: JSON.stringify(m),
      stop: m.stop_reason ?? null,
      in: u.input_tokens ?? 0,
      out: u.output_tokens ?? 0,
      cr: u.cache_read_input_tokens ?? 0,
      cw: u.cache_creation_input_tokens ?? 0,
    };
  }
  if (line.result.type === 'errored') {
    return { ...base, etype: line.result.error?.error?.type ?? 'unknown', emsg: line.result.error?.error?.message ?? 'unknown error' };
  }
  return base;
}

/** Recompute the run's token and cost totals from its rows. Cheap; always exact. */
export function rollUp(runId: string, model: string) {
  const d = db();
  const t = d.prepare(`
    SELECT COALESCE(SUM(in_tokens),0) i, COALESCE(SUM(out_tokens),0) o,
           COALESCE(SUM(cache_read),0) cr, COALESCE(SUM(cache_write),0) cw
    FROM requests WHERE run_id = ?
  `).get(runId) as { i: number; o: number; cr: number; cw: number };

  const cost = costOf(model, {
    input_tokens: t.i, output_tokens: t.o,
    cache_read_input_tokens: t.cr, cache_creation_input_tokens: t.cw,
  });

  d.prepare('UPDATE runs SET in_tokens=?, out_tokens=?, cache_read=?, cache_write=?, cost_usd=? WHERE id=?')
    .run(t.i, t.o, t.cr, t.cw, cost, runId);
}
