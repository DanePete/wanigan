import { db, logEvent } from '../db';
import { buildRequests } from './build';
import { estimate } from './estimate';
import { costOf, usd } from './pricing';
import { loadSource, type Dataset } from './sources';
import { createAndSubmitRun } from './submit';
import { EFFORT_LEVELS } from '../../shared/types';
import type { Effort, EvalPair, EvalRowDiff, GoldenSet, RunConfig, SourceConfig } from '../../shared/types';

/**
 * A/B runs and an LLM judge.
 *
 * The batch engine is already an eval harness wearing a different label: one
 * prompt, N rows, half price, results keyed by a stable custom_id. So nothing
 * here re-implements submission or ingestion — a variant is a run, a judge pass
 * is a run, and the only new ideas are the enforcement of a single variable and
 * the un-swapping of the judge's presentation order.
 */

/* ── the single variable ────────────────────────────────────────────── */

/**
 * The fields that make a run behave differently.
 *
 * `name` and `preset` are labels, not behaviour. `projectId` is left out
 * because the dataset it points at already travels in `source` — counting both
 * would report one change as two and refuse a perfectly readable pair.
 */
const COMPARED = [
  'model', 'maxTokens', 'temperature', 'system', 'userTemplate', 'keyColumn',
  'cacheTtl', 'extendedOutput', 'effort', 'thinking', 'thinkingDisplay', 'schemaJson', 'source',
] as const satisfies readonly (keyof RunConfig)[];

/**
 * A variant over a glob or a command is submitted with its rows pinned as jsonl
 * (see runVariant), so the source stored on the run is not the source it
 * describes. `pinnedFrom` carries the original, and every comparison and label
 * reads through it — without that, pairing a variant with its base would see
 * glob-vs-jsonl and refuse a pair that has exactly one variable.
 */
type PinnedConfig = RunConfig & { pinnedFrom?: SourceConfig };

const sourceOf = (cfg: RunConfig): SourceConfig => (cfg as PinnedConfig).pinnedFrom ?? cfg.source;

/**
 * Ceiling on a dataset serialised into one cell — a pinned variant source or a
 * golden set's rows_json. A JS string caps near 512 MB and SQLITE_MAX_LENGTH at
 * 1e9 bytes, so past some size the join throws 'Invalid string length' or
 * better-sqlite3 answers 'string or blob too big'. Both are raw engine messages
 * that say nothing about what to do, and they land on exactly the whole-repo
 * glob runs that most need pinning — so the limit is named here instead.
 */
const MAX_ROWS_BYTES = 32 * 1024 * 1024;

function joinRows(lines: string[], separator: string, remedy: string): string {
  let bytes = 0;
  for (const line of lines) {
    bytes += line.length + separator.length;
    if (bytes > MAX_ROWS_BYTES) {
      throw new Error(
        `These rows are over ${MAX_ROWS_BYTES / (1024 * 1024)} MB serialised as JSON, which is more than Foreman ` +
        `stores in a single cell. ${remedy}`
      );
    }
  }
  return lines.join(separator);
}

/** Stable stringify: key order is an artefact of how a config was built, not a difference. */
function stable(v: unknown): string {
  if (v === undefined || v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Normalised for comparison the same way build.ts normalises for sending: it
 * trims before testing a schema and filters empty system blocks, so a config
 * that says `schemaJson: ''` and one that omits it produce byte-identical
 * requests. Reporting that as a variable would block a pair that has none.
 */
function comparable(cfg: RunConfig, field: (typeof COMPARED)[number]): string {
  if (field === 'system') {
    return stable((cfg.system ?? []).filter((b) => b.text.trim()).map((b) => ({ text: b.text, cache: b.cache })));
  }
  if (field === 'source') return stable(sourceOf(cfg));
  const v = cfg[field];
  if (typeof v === 'string' && !v.trim()) return 'null';
  return stable(v);
}

export function variableBetween(a: RunConfig, b: RunConfig): { variable: string | null; differences: string[] } {
  const differences = COMPARED.filter((f) => comparable(a, f) !== comparable(b, f)).map((f) => String(f));
  return { variable: differences.length === 1 ? differences[0] : null, differences };
}

/* ── pairs ──────────────────────────────────────────────────────────── */

type RunRecord = { id: string; name: string; model: string; config_json: string };

function runRecord(id: string): RunRecord {
  const r = db().prepare('SELECT id, name, model, config_json FROM runs WHERE id = ?')
    .get(id) as RunRecord | undefined;
  if (!r) throw new Error(`Run ${id} not found — it may have been deleted. Pick another run.`);
  return r;
}

function configOf(id: string): { run: RunRecord; cfg: RunConfig } {
  const run = runRecord(id);
  return { run, cfg: JSON.parse(run.config_json) as RunConfig };
}

type PairRow = { id: string; name: string; run_a: string; run_b: string; variable: string; created_at: number };

const toPair = (r: PairRow): EvalPair => ({
  id: r.id, name: r.name, runAId: r.run_a, runBId: r.run_b, variable: r.variable, createdAt: r.created_at,
});

function pairRecord(id: string): EvalPair {
  const r = db().prepare('SELECT * FROM eval_pairs WHERE id = ?').get(id) as PairRow | undefined;
  if (!r) throw new Error(`Eval pair ${id} not found.`);
  return toPair(r);
}

/**
 * One variable, enforced.
 *
 * Effort is part of the rendered prompt and cannot vary within a run, so an A/B
 * where both the model and the effort moved has measured "Sonnet at low" against
 * "Opus at max" and can attribute the difference to neither. The same is true of
 * any second field: the moment two things move you have a story, not a result.
 * Refusing here — rather than letting the UI draw a confident bar chart over an
 * uninterpretable comparison — is the difference between an experiment and a vibe.
 */
export async function createPair(name: string, runAId: string, runBId: string): Promise<EvalPair> {
  if (runAId === runBId) {
    throw new Error('A pair needs two different runs. Use "run variant" to produce a B from this run.');
  }
  const a = configOf(runAId);
  const b = configOf(runBId);
  const { variable, differences } = variableBetween(a.cfg, b.cfg);

  if (!differences.length) {
    throw new Error(
      `"${a.run.name}" and "${b.run.name}" have identical configs, so there is nothing to attribute a ` +
      `difference to. Change exactly one field and re-run before pairing them.`
    );
  }
  if (!variable) {
    throw new Error(
      `${differences.length} fields differ between "${a.run.name}" and "${b.run.name}": ${differences.join(', ')}. ` +
      `An A/B with more than one variable cannot say which change caused the result — re-run B with only one of ` +
      `them changed.`
    );
  }

  const pair: EvalPair = {
    id: `pair_${Math.random().toString(36).slice(2, 10)}`,
    name, runAId, runBId, variable, createdAt: Date.now(),
  };
  db().prepare('INSERT INTO eval_pairs (id, name, run_a, run_b, variable, created_at) VALUES (?,?,?,?,?,?)')
    .run(pair.id, pair.name, pair.runAId, pair.runBId, pair.variable, pair.createdAt);
  return pair;
}

export function listPairs(): EvalPair[] {
  return (db().prepare('SELECT * FROM eval_pairs ORDER BY created_at DESC').all() as PairRow[]).map(toPair);
}

/* ── the diff ───────────────────────────────────────────────────────── */

type ReqRow = {
  custom_id: string; row_index: number; status: string; rendered: string; output_text: string | null;
  in_tokens: number; out_tokens: number; cache_read: number; cache_write: number;
};

function requestsOf(runId: string): ReqRow[] {
  return db().prepare(`
    SELECT custom_id, row_index, status, rendered, output_text, in_tokens, out_tokens, cache_read, cache_write
    FROM requests WHERE run_id = ? ORDER BY row_index
  `).all(runId) as ReqRow[];
}

const rowCost = (cfg: RunConfig, model: string, r: ReqRow) => costOf(model, {
  input_tokens: r.in_tokens, output_tokens: r.out_tokens,
  cache_read_input_tokens: r.cache_read, cache_creation_input_tokens: r.cache_write,
  cacheTtl: cfg.cacheTtl,
});

/** Empty and absent are the same outcome — neither side produced text. */
const norm = (t: string | null) => (t ?? '').trim();

/**
 * Rows are matched by custom_id, never by position — results come back
 * unordered, and the two runs were submitted separately.
 *
 * onlyA/onlyB is therefore also the drift detector: a custom_id is `r{index}`
 * plus the key column, so a glob or command source that changed between the two
 * runs shows up here as rows that line up with nothing. That is a second
 * variable, and it is worth seeing before you read the win counts.
 */
export function pairDiff(pairId: string): {
  pair: EvalPair;
  rows: EvalRowDiff[];
  summary: { same: number; different: number; onlyA: number; onlyB: number; costA: number; costB: number };
} {
  const pair = pairRecord(pairId);
  const a = configOf(pair.runAId);
  const b = configOf(pair.runBId);

  const scores = new Map<string, { score: number | null; winner: string | null; rationale: string | null }>();
  for (const s of db().prepare('SELECT custom_id, score, winner, rationale FROM eval_scores WHERE pair_id = ?')
    .all(pairId) as { custom_id: string; score: number | null; winner: string | null; rationale: string | null }[]) {
    scores.set(s.custom_id, s);
  }

  const verdictOf = (customId: string): Pick<EvalRowDiff, 'score' | 'winner' | 'rationale'> => {
    const s = scores.get(customId);
    const w = s?.winner;
    return {
      score: s?.score ?? null,
      winner: w === 'a' || w === 'b' || w === 'tie' ? w : null,
      rationale: s?.rationale ?? null,
    };
  };

  const rowsA = requestsOf(pair.runAId);
  const byB = new Map(requestsOf(pair.runBId).map((r) => [r.custom_id, r]));

  const rows: EvalRowDiff[] = [];
  let same = 0, different = 0, onlyA = 0, onlyB = 0, costA = 0, costB = 0;

  for (const ra of rowsA) {
    const rb = byB.get(ra.custom_id);
    byB.delete(ra.custom_id);
    const aCost = rowCost(a.cfg, a.run.model, ra);
    const bCost = rb ? rowCost(b.cfg, b.run.model, rb) : 0;
    costA += aCost;
    costB += bCost;

    const equal = rb ? norm(ra.output_text) === norm(rb.output_text) : false;
    if (!rb) onlyA++;
    else if (equal) same++;
    else different++;

    rows.push({
      customId: ra.custom_id,
      rowIndex: ra.row_index,
      aText: ra.output_text,
      bText: rb?.output_text ?? null,
      aStatus: ra.status,
      bStatus: rb?.status ?? 'missing',
      aCost,
      bCost,
      same: equal,
      ...verdictOf(ra.custom_id),
    });
  }

  for (const rb of byB.values()) {
    onlyB++;
    costB += rowCost(b.cfg, b.run.model, rb);
    rows.push({
      customId: rb.custom_id,
      rowIndex: rb.row_index,
      aText: null,
      bText: rb.output_text,
      aStatus: 'missing',
      bStatus: rb.status,
      aCost: 0,
      bCost: rowCost(b.cfg, b.run.model, rb),
      same: false,
      ...verdictOf(rb.custom_id),
    });
  }

  rows.sort((x, y) => x.rowIndex - y.rowIndex || x.customId.localeCompare(y.customId));
  return { pair, rows, summary: { same, different, onlyA, onlyB, costA, costB } };
}

/* ── running the other side ─────────────────────────────────────────── */

/**
 * Priced before submitting so the per-run spend cap in submit.ts has something
 * to compare against — without an estimate it silently never fires, and a batch
 * cannot be un-submitted. The ceiling is used, not the hopeful figure: a cap you
 * can overshoot is not a cap.
 */
async function priceOf(cfg: RunConfig): Promise<{ input: number; output: number; cost: number; dataset: Dataset }> {
  const ds = await loadSource(cfg.source);
  const built = buildRequests(cfg, ds.rows, ds.columns);
  if (built.errors.length) throw new Error(built.errors.join(' '));
  if (!built.requests.length) throw new Error('That config produces zero requests — check the source and the template.');
  const est = await estimate(cfg, built.requests);
  // The dataset comes back with the price so the caller can submit these exact
  // rows. Pricing one read and submitting another makes the spend cap a
  // check-then-act against a dataset that no longer exists.
  return { input: est.totalInputTokens, output: est.worstCaseOutputTokens, cost: est.costHighUsd, dataset: ds };
}

/** glob, files and command all re-read the world; csv and jsonl carry their bytes in the config. */
const rereadsTheWorld = (src: SourceConfig) =>
  src.kind === 'glob' || src.kind === 'files' || src.kind === 'command';

export async function runVariant(
  baseRunId: string,
  change: Partial<RunConfig>,
  name: string
): Promise<{ runId: string }> {
  const base = configOf(baseRunId);
  const variant: RunConfig = { ...base.cfg, ...change, name };

  // Checked here as well as in createPair, because a variant you cannot pair is
  // a run you paid for and cannot read.
  const { variable, differences } = variableBetween(base.cfg, variant);
  if (!differences.length) {
    throw new Error(
      `Nothing in this variant differs from "${base.run.name}", so the pair would have no variable. ` +
      `Change exactly one field — model, effort, max_tokens, the template or the schema.`
    );
  }
  if (!variable) {
    throw new Error(
      `A variant may change one field; this one changes ${differences.length}: ${differences.join(', ')}. ` +
      `Run them as separate variants so each result can be attributed to its own change.`
    );
  }

  const priced = await priceOf(variant);

  // priceOf read the source to price it; createAndSubmitRun reads it again and
  // builds the batch from that second read. For a glob or a command those are
  // not the same dataset — the command is executed a second time, side effects
  // and all, and a query whose window advanced can return 90,000 rows where the
  // priced read returned 400. The cap in submit.ts would then pass on a $3
  // figure describing rows that were never sent while $700 of requests go out,
  // and a batch cannot be un-submitted. Pinning the priced rows as jsonl makes
  // the read that was priced and the read that is submitted the same one.
  const pinned = rereadsTheWorld(variant.source);
  const submitted: PinnedConfig = pinned
    ? {
        ...variant,
        source: {
          kind: 'jsonl',
          text: joinRows(
            priced.dataset.rows.map((r) => JSON.stringify(r)),
            '\n',
            `A variant has to be submitted from exactly the rows it was priced from, or the spend cap is checked ` +
            `against a dataset that was never sent. Narrow the source — a tighter glob, or a LIMIT on the ` +
            `command — and run the variant over that subset.`
          ),
        },
        pinnedFrom: variant.source,
      }
    : variant;

  const runId = (await createAndSubmitRun(submitted, {
    parentRunId: baseRunId,
    estimate: priced,
  })).runId;

  logEvent(runId, 'info', `Variant of ${baseRunId} — the only field changed is ${variable}.`);
  if (pinned) {
    // submit.ts logs ds.note for the source it loaded, which is now the pinned
    // jsonl — the original read's notes ("3 file(s) truncated") would vanish.
    if (priced.dataset.note) logEvent(runId, 'info', `Source: ${priced.dataset.note}`);
    logEvent(runId, 'warn',
      `This ${variant.source.kind} source re-reads the world, so its ${priced.dataset.rows.length.toLocaleString()} ` +
      `rows were pinned at submit time. They are the rows this run was priced on, but ${baseRunId} read its own ` +
      `rows earlier — if the dataset moved in between, the comparison still has two variables. Save a golden set ` +
      `and point both runs at it to rule that out.`);
  }
  return { runId };
}

/* ── the judge ──────────────────────────────────────────────────────── */

const JUDGE_MAX_TOKENS = 2000;

/**
 * `score` is a magnitude, not a preference: the direction lives in `winner`.
 * That is what makes it survive the presentation swap below without being
 * flipped, and it is why the mean is readable as "how far apart the two sides
 * were" rather than as an average of two different scales.
 *
 * The 0-10 range is stated in the description rather than as minimum/maximum,
 * because structured outputs does not support those keywords — build.ts warns
 * about exactly that.
 */
const JUDGE_SCHEMA = JSON.stringify(
  {
    type: 'object',
    additionalProperties: false,
    required: ['score', 'winner', 'rationale'],
    properties: {
      score: {
        type: 'number',
        description: 'Size of the gap between the two responses: 0 means indistinguishable, 10 means one is categorically better. Not a quality score for either response on its own.',
      },
      winner: { type: 'string', enum: ['a', 'b', 'tie'], description: 'Which response the rubric favours, or tie.' },
      rationale: { type: 'string', description: 'One or two sentences naming the concrete difference that decided it.' },
    },
  },
  null,
  2
);

const JUDGE_TEMPLATE = `Task given to both responses:
{{prompt}}

--- Response A ---
{{a}}

--- Response B ---
{{b}}`;

function judgeSystem(rubric: string): string {
  return `You are grading two responses to the same task against a rubric.

The two responses are labelled A and B. Their order is randomised for every item
and carries no information: A is not "the original" and B is not "the new one",
and you are not told what differs between the systems that produced them. Judge
only what is in front of you.

Rubric:
${rubric.trim()}

Rules:
- Pick the response the rubric favours. If the rubric does not separate them,
  answer "tie". A tie is a real answer; do not manufacture a preference.
- "score" is the size of the gap, not the direction. The direction is "winner".
- Ignore length, formatting and confident tone unless the rubric asks for them.
- Judge the response against the task, not against your own preferred answer.

Return only the JSON object described by the schema.`;
}

function judgeEffort(effort?: string): Effort | undefined {
  if (!effort) return undefined;
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    throw new Error(`Unknown effort "${effort}". Use one of: ${EFFORT_LEVELS.join(', ')}.`);
  }
  return effort as Effort;
}

/**
 * A judgement is only as good as the judge, so every score carries the model and
 * effort that produced it. eval_scores has one column for that, so the label
 * rides in judge_run: an unattributed score is unfalsifiable, and "Opus at max
 * preferred B" and "Haiku at low preferred B" are not the same finding.
 */
const judgeLabel = (runId: string, model: string, effort?: string) =>
  [runId, model, effort ?? 'default'].join(' · ');

function describeJudge(label: string): string {
  const [, model, effort] = label.split(' · ');
  if (!model) return 'an unrecorded judge';
  return effort && effort !== 'default' ? `${model} at ${effort} effort` : `${model} at the default effort`;
}

type JudgeRow = { custom_id: string; prompt: string; a: string; b: string; swapped: boolean };

export async function judgePair(
  pairId: string,
  opts: { model: string; rubric: string; effort?: string }
): Promise<{ runId: string; rows: number }> {
  const pair = pairRecord(pairId);
  if (!opts.rubric.trim()) {
    throw new Error('A judge needs a rubric. Say what "better" means for this task — the judge cannot infer it.');
  }
  const effort = judgeEffort(opts.effort);

  const inFlight = db().prepare(
    "SELECT id FROM runs WHERE eval_pair_id = ? AND kind = 'eval' AND status IN ('submitting','in_progress')"
  ).get(pairId) as { id: string } | undefined;
  if (inFlight) {
    throw new Error(
      `Judge run ${inFlight.id} is already scoring this pair. Wait for it to end or cancel it — a second pass pays ` +
      `for the same judgement twice.`
    );
  }

  const { rows: diff } = pairDiff(pairId);
  const judgeable = diff.filter((r) => norm(r.aText) && norm(r.bText));
  if (!judgeable.length) {
    throw new Error(
      `Nothing to judge in "${pair.name}": no row has output from both runs. Wait for both runs to finish ingesting ` +
      `results, then try again.`
    );
  }

  const a = configOf(pair.runAId);
  const prompts = new Map(requestsOf(pair.runAId).map((r) => [r.custom_id, r.rendered]));

  const rows: JudgeRow[] = judgeable.map((r) => {
    // Position bias is real and large: a judge shown the same two answers in the
    // other order will change its mind on a meaningful share of items. Randomise
    // per row and carry the mapping, so the bias averages out instead of landing
    // entirely on whichever run happens to be A. ingestJudgement un-swaps it.
    const swapped = Math.random() < 0.5;
    return {
      custom_id: r.customId,
      // When the variable IS the template, the two prompts differ; A's is used
      // as the statement of the task, because the judge is scoring the answers
      // against the task rather than scoring the wording.
      prompt: prompts.get(r.customId) ?? '',
      a: (swapped ? r.bText : r.aText) ?? '',
      b: (swapped ? r.aText : r.bText) ?? '',
      // Never referenced by the template, so it rides in the row without ever
      // reaching the judge's prompt.
      swapped,
    };
  });

  const cfg: RunConfig = {
    name: `${pair.name} — judge (${opts.model})`,
    projectId: a.cfg.projectId,
    model: opts.model,
    maxTokens: JUDGE_MAX_TOKENS,
    cacheTtl: '1h',
    effort,
    keyColumn: 'custom_id',
    // The rubric is byte-identical on every row, which is exactly what the
    // cached prefix is for.
    system: [{ text: judgeSystem(opts.rubric), cache: true }],
    userTemplate: JUDGE_TEMPLATE,
    schemaJson: JUDGE_SCHEMA,
    source: { kind: 'jsonl', text: rows.map((r) => JSON.stringify(r)).join('\n') },
  };

  // The judge's source is jsonl built right here, so there is nothing to pin:
  // the two reads are the same bytes.
  const { runId } = await createAndSubmitRun(cfg, { estimate: await priceOf(cfg) });

  // submit.ts owns run creation and knows nothing about evals, so the judge run
  // is labelled here. Without eval_pair_id, ingestJudgement has no way back to
  // the pair it scored and the run reads as an ordinary batch forever.
  db().prepare("UPDATE runs SET kind = 'eval', eval_pair_id = ? WHERE id = ?").run(pairId, runId);
  logEvent(runId, 'info',
    `Judging ${rows.length.toLocaleString()} paired rows from ${pair.runAId} vs ${pair.runBId} ` +
    `(variable: ${pair.variable}). Presentation order randomised per row.`);

  return { runId, rows: rows.length };
}

/**
 * Structured outputs should make this a plain JSON.parse. The fallbacks exist
 * because a fenced or prefixed answer still happens, and a row we cannot read
 * must be skipped rather than counted — a mis-read judgement scored as a tie
 * would quietly drag the verdict toward "no difference".
 */
function parseVerdict(text: string | null): { score: number; winner: 'a' | 'b' | 'tie'; rationale: string } | null {
  if (!text) return null;
  let t = text.trim();
  if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    const open = t.indexOf('{');
    const close = t.lastIndexOf('}');
    if (open < 0 || close <= open) return null;
    try { parsed = JSON.parse(t.slice(open, close + 1)); } catch { return null; }
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const winner = o.winner;
  if (winner !== 'a' && winner !== 'b' && winner !== 'tie') return null;
  if (typeof o.score !== 'number' || !Number.isFinite(o.score)) return null;
  return { score: o.score, winner, rationale: typeof o.rationale === 'string' ? o.rationale : '' };
}

const flip = (w: 'a' | 'b' | 'tie'): 'a' | 'b' | 'tie' => (w === 'a' ? 'b' : w === 'b' ? 'a' : 'tie');

export function ingestJudgement(judgeRunId: string): { scored: number; pairId: string } {
  const d = db();
  const run = d.prepare('SELECT id, kind, eval_pair_id, model, config_json FROM runs WHERE id = ?')
    .get(judgeRunId) as { id: string; kind: string; eval_pair_id: string | null; model: string; config_json: string } | undefined;
  if (!run) throw new Error(`Run ${judgeRunId} not found.`);
  if (run.kind !== 'eval' || !run.eval_pair_id) {
    throw new Error(`Run ${judgeRunId} is not a judge run — only a run created by judgePair records the pair it scored.`);
  }
  const pairId = run.eval_pair_id;
  const cfg = JSON.parse(run.config_json) as RunConfig;
  const label = judgeLabel(run.id, run.model, cfg.effort);

  const rows = d.prepare('SELECT row_json, output_text, status FROM requests WHERE run_id = ?')
    .all(judgeRunId) as { row_json: string; output_text: string | null; status: string }[];

  const put = d.prepare(`
    INSERT INTO eval_scores (pair_id, custom_id, score, winner, rationale, judge_run) VALUES (?,?,?,?,?,?)
    ON CONFLICT(pair_id, custom_id) DO UPDATE SET
      score = excluded.score, winner = excluded.winner,
      rationale = excluded.rationale, judge_run = excluded.judge_run
  `);

  let scored = 0;
  let unreadable = 0;
  let declined = 0;
  const write = d.transaction(() => {
    for (const r of rows) {
      if (r.status !== 'succeeded') {
        // A refused or errored judge row is not a tie — it is a row with no
        // verdict, and it has to be visible or the summary quietly reads as if
        // the judge had scored the whole set.
        if (r.status !== 'pending') declined++;
        continue;
      }
      const row = JSON.parse(r.row_json) as Partial<JudgeRow>;
      if (!row.custom_id) continue;
      const v = parseVerdict(r.output_text);
      if (!v) { unreadable++; continue; }
      // Un-swap: the judge's "a" was run B's output whenever this row was
      // presented in reverse. Skipping this step is how a randomised judge
      // silently becomes a coin flip.
      put.run(pairId, row.custom_id, v.score, row.swapped ? flip(v.winner) : v.winner, v.rationale, label);
      scored++;
    }
  });
  write();

  if (unreadable) {
    logEvent(judgeRunId, 'warn', `${unreadable} judgement(s) did not parse as the scored schema and were skipped.`);
  }
  if (declined) {
    logEvent(judgeRunId, 'warn', `${declined} row(s) came back errored, refused or expired and have no verdict.`);
  }
  logEvent(judgeRunId, 'info', `Scored ${scored.toLocaleString()} rows for pair ${pairId}.`);
  return { scored, pairId };
}

/* ── the verdict ────────────────────────────────────────────────────── */

export function regressionSummary(pairId: string): {
  aWins: number; bWins: number; ties: number; meanScore: number | null; costDeltaUsd: number; verdict: string;
} {
  const { pair, rows, summary } = pairDiff(pairId);
  const a = configOf(pair.runAId);
  const b = configOf(pair.runBId);

  const judged = rows.filter((r) => r.winner !== null);
  const aWins = judged.filter((r) => r.winner === 'a').length;
  const bWins = judged.filter((r) => r.winner === 'b').length;
  const ties = judged.filter((r) => r.winner === 'tie').length;
  const withScore = judged.filter((r) => typeof r.score === 'number');
  const meanScore = withScore.length
    ? withScore.reduce((acc, r) => acc + (r.score ?? 0), 0) / withScore.length
    : null;
  const costDeltaUsd = summary.costB - summary.costA;

  const move = `${pair.variable}: ${describeValue(a.cfg, pair.variable)} → ${describeValue(b.cfg, pair.variable)}`;
  const cost = Math.abs(costDeltaUsd) < 0.005
    ? 'at the same cost'
    : `at ${usd(Math.abs(costDeltaUsd))} ${costDeltaUsd > 0 ? 'more' : 'less'}`;

  const drift = summary.onlyA || summary.onlyB
    ? ` ${(summary.onlyA + summary.onlyB).toLocaleString()} row(s) exist on only one side, so the datasets are not identical — read this with that in mind.`
    : '';

  if (!judged.length) {
    const identical = summary.different === 0 && summary.same > 0
      ? ` The two runs produced identical output on all ${summary.same.toLocaleString()} matched rows, so the change made no difference to the text at all.`
      : ` ${summary.different.toLocaleString()} of ${(summary.same + summary.different).toLocaleString()} matched rows differ in output.`;
    return {
      aWins, bWins, ties, meanScore, costDeltaUsd,
      verdict: `${move} — no judgement yet, run a judge pass to get a verdict.${identical} B ran ${cost}.${drift}`,
    };
  }

  const judges = [...new Set(
    (db().prepare('SELECT DISTINCT judge_run FROM eval_scores WHERE pair_id = ? AND judge_run IS NOT NULL')
      .all(pairId) as { judge_run: string }[]).map((j) => describeJudge(j.judge_run))
  )].join(' and ');

  // A 26–24 split over 50 rows is a coin flip, not a result. sqrt(n) is the
  // rough scale of that noise, and calling it out is the difference between a
  // finding and a number that happens to be bigger.
  const lead = Math.abs(aWins - bWins);
  const decisive = lead > Math.sqrt(judged.length);
  const side = aWins > bWins ? 'A' : bWins > aWins ? 'B' : null;

  const headline = side && decisive
    ? `${side} wins ${side === 'A' ? aWins : bWins} of ${judged.length.toLocaleString()} judged rows ` +
      `(${side === 'A' ? bWins : aWins} against, ${ties} tied)`
    : `no clear winner over ${judged.length.toLocaleString()} judged rows (A ${aWins}, B ${bWins}, ${ties} tied)`;
  const noise = side && !decisive
    ? ` A ${aWins}-${bWins} split over ${judged.length.toLocaleString()} rows is inside the noise at this sample size — read it as no difference.`
    : '';

  const margin = meanScore === null ? '' : `, mean margin ${meanScore.toFixed(1)}/10`;
  return {
    aWins, bWins, ties, meanScore, costDeltaUsd,
    verdict: `${move} — ${headline}${margin}, ${cost}.${noise} Judged by ${judges || 'an unrecorded judge'}.${drift}`,
  };
}

/** A template or a schema is thousands of characters; a verdict sentence is one line. */
function describeValue(cfg: RunConfig, field: string): string {
  const v = (cfg as unknown as Record<string, unknown>)[field];
  if (v === undefined || v === null || v === '') return 'unset';
  if (field === 'source') return sourceOf(cfg).kind;
  const s = typeof v === 'string' ? v : stable(v);
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine;
}

/* ── golden sets ────────────────────────────────────────────────────── */

type GoldenRow = { id: string; name: string; row_count: number; created_at: number; source_run_id: string | null };

const toGolden = (r: GoldenRow): GoldenSet => ({
  id: r.id, name: r.name, rows: r.row_count, createdAt: r.created_at, sourceRunId: r.source_run_id,
});

/**
 * The rows a run actually saw are the only durable record of its dataset: a glob
 * or command source re-reads the world on every submit, so "the same dataset"
 * is otherwise a hope. Snapshotting them is what lets a config from next month
 * be compared with one from today and have the comparison mean something.
 */
export function saveGoldenSet(name: string, runId: string): GoldenSet {
  const d = db();
  runRecord(runId);
  const rows = d.prepare('SELECT row_json FROM requests WHERE run_id = ? ORDER BY row_index')
    .all(runId) as { row_json: string }[];
  if (!rows.length) {
    throw new Error(`Run ${runId} has no input rows to snapshot — only a run that was built and submitted has any.`);
  }

  const set: GoldenSet = {
    id: `gold_${Math.random().toString(36).slice(2, 10)}`,
    name,
    rows: rows.length,
    createdAt: Date.now(),
    sourceRunId: runId,
  };
  // row_json is the whole input row, and a glob or files source inlines up to
  // maxBytes of file content per row — a 5,000-file audit is ~1 GB of JSON. The
  // join that builds this single cell would throw 'Invalid string length', or
  // better-sqlite3 would answer 'string or blob too big', on exactly the runs a
  // golden set exists to pin. joinRows names the ceiling and what to do instead.
  const rowsJson = `[${joinRows(
    rows.map((r) => r.row_json),
    ',',
    `Run ${runId} is too large to pin as one golden set. Snapshot a run over a smaller dataset, or lower ` +
    `maxBytes on its source so file contents are truncated further before the next run.`
  )}]`;

  d.prepare(`
    INSERT INTO golden_sets (id, name, rows_json, row_count, source_run_id, created_at) VALUES (?,?,?,?,?,?)
  `).run(set.id, set.name, rowsJson, set.rows, runId, set.createdAt);
  return set;
}

export function listGoldenSets(): GoldenSet[] {
  return (db().prepare('SELECT id, name, row_count, created_at, source_run_id FROM golden_sets ORDER BY created_at DESC')
    .all() as GoldenRow[]).map(toGolden);
}

/** Ready to drop into a RunConfig: jsonl is the one source kind that cannot drift. */
export function goldenSetSource(id: string): SourceConfig {
  const r = db().prepare('SELECT rows_json FROM golden_sets WHERE id = ?').get(id) as { rows_json: string } | undefined;
  if (!r) throw new Error(`Golden set ${id} not found.`);
  const rows = JSON.parse(r.rows_json) as unknown[];
  return { kind: 'jsonl', text: rows.map((row) => JSON.stringify(row)).join('\n') };
}
