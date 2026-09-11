import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { BudgetState, Project, Reconciliation, UnifiedSpendDay } from '@shared/types';
import { Note, PageHead, Segmented, Stat, num, usd } from '../components/bits';
import '../styles/insights.css';
import { useViewMemory } from '../components/viewMemory';

/**
 * Where the money went, across all three surfaces — and by which meter.
 *
 * Charts are hand-rolled SVG: the renderer runs under a strict CSP with no
 * external hosts, and a handful of small charts do not justify a charting
 * library.
 *
 * Colour rules that are load-bearing, not taste:
 *  - Categorical hues are assigned by SLOT in fixed order. Reordering them to
 *    suit meaning puts yellow beside orange, a pair that fails both the CVD and
 *    normal-vision separation floors. Sessions are always slot 1, batches
 *    always slot 2, headless always slot 3 — on every chart on this page, so a
 *    reader who learns the mapping once keeps it.
 *  - Status marks (succeeded / failed / over budget) always carry a glyph and a
 *    text label. Green vs red measures ΔE 4.1 under deuteranopia — hue alone is
 *    unreadable, and "this project has blown its cap" must never be invisible.
 *  - Every chart has a table underneath, so identity never depends on colour.
 *
 * THE HONESTY RULE. Two meters feed this page and they will not agree to the
 * cent:
 *  - Interactive sessions and headless runs report their own cost. The Claude
 *    Code CLI computes it; Wanigan banks the number it is handed.
 *  - Batch runs are priced by Wanigan, multiplying the token counts the Batches
 *    API returned against the local pricing table.
 * A model newer than that table falls back to a default rate, and the CLI's
 * figure covers turns Wanigan never sees a token count for. So every chart that
 * mixes them names both sources underneath. A chart implying one authority over
 * two different instruments is a chart that lies quietly, and the lie is only
 * found months later, against an invoice.
 *
 * The two new time-series charts draw in CSS pixels off a measured container
 * rather than a unitless viewBox, so a 2px line is 2px and an 11px label is
 * 11px at every pane width. The four original batch charts are untouched.
 */

const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

/* ── meters ───────────────────────────────────────────────────────────── */

type MeterKey = 'cli' | 'wanigan' | 'transcript';

const METER: Record<MeterKey, { glyph: string; word: string; detail: string }> = {
  cli: {
    glyph: '◐',
    word: 'CLI meter',
    detail: "the agent's own accounting, banked as the Claude Code CLI reported it",
  },
  wanigan: {
    glyph: '◑',
    word: 'Wanigan meter',
    detail: "Wanigan's arithmetic over its local batch pricing table",
  },
  transcript: {
    glyph: '◒',
    word: 'Transcript meter',
    detail: "Claude's own token counts from its local transcripts, priced by Wanigan",
  },
};

/** The source line every chart that mixes instruments carries underneath it. */
function Meters({ of, extra }: { of: MeterKey[]; extra?: React.ReactNode }) {
  return (
    <div className="ins-meterline">
      {of.map((k) => (
        <span key={k} className="ins-src">
          <span aria-hidden="true">{METER[k].glyph}</span>
          <span><strong style={{ fontWeight: 600 }}>{METER[k].word}</strong> — {METER[k].detail}</span>
        </span>
      ))}
      {extra ? <span className="ins-src">{extra}</span> : null}
    </div>
  );
}

/* ── surfaces ─────────────────────────────────────────────────────────── */

type SurfaceKey = 'session' | 'batch' | 'headless';

const SURFACES: { key: SurfaceKey; label: string; color: string; meter: MeterKey }[] = [
  { key: 'session',  label: 'Sessions', color: SERIES[0], meter: 'cli' },
  { key: 'batch',    label: 'Batches',  color: SERIES[1], meter: 'wanigan' },
  { key: 'headless', label: 'Headless', color: SERIES[2], meter: 'cli' },
];

/* ── formatting ───────────────────────────────────────────────────────── */

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** usd() reads a negative as "<$0.01"; a delta needs its sign back. */

/** Money to the cent, for columns where two meters are compared side by side. */
const cents = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  })}`;

const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

/**
 * A per-unit rate, which is routinely smaller than a cent. Rounding it to two
 * places prints "$0.00" against 3,200 requests, which reads as free.
 */
const unit = (n: number) => (n !== 0 && Math.abs(n) < 0.01 ? `${n < 0 ? '−' : ''}$${Math.abs(n).toFixed(4)}` : cents(n));

const pad2 = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 'YYYY-MM-DD' → 'Aug 27', parsed as a local date so it cannot slip a day. */
function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** A round axis top, so the tick labels are numbers a person would say. */
function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const base = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) if (v <= m * base) return m * base;
  return 10 * base;
}

/* ── layout helpers ───────────────────────────────────────────────────── */

/**
 * The chart's own width in CSS pixels. Charts drawn against a unitless viewBox
 * scale their strokes and type with the container, so the same "2px" hairline
 * is 2px in one pane and 5px in another. Measuring costs one observer and makes
 * the mark specs mean what they say.
 */
function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(720);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const next = Math.max(260, Math.round(entries[0]?.contentRect.width ?? 720));
      setW((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/* ── shared types ─────────────────────────────────────────────────────── */

type BatchInsights = {
  perRun: Record<string, number | string>[];
  byModel: Record<string, number | string>[];
  totals: Record<string, number>;
  outcomes: { status: string; n: number }[];
};

type EffortRow = { effort: string; requests: number; costUsd: number };
type CacheRow = { surface: string; read: number; write: number; input: number; rate: number; note: string };
type AccuracyRow = { model: string; runs: number; estUsd: number; actualUsd: number; ratio: number };
type CodexUsage = { conversations: number; inTokens: number; outTokens: number; cacheRead: number; totalTokens: number; lastAt: number | null };

type DayRow = { day: string; session: number; batch: number; headless: number; total: number; sync: number; unpricedRequests: number; unpricedHeadlessRows: number };

/**
 * Three surfaces per day, read from the one source that computes them.
 *
 * This used to rebuild the split by subtraction — batch inferred from the gap
 * between the sync and actual series, headless from whatever the session line
 * did not account for. That is only sound while both inputs cover the same
 * days, and they did not: the preload dropped the window argument, so the sync
 * series was always thirty days while the session series honoured the picker.
 * On a seven-day view every interactive dollar from days eight to thirty had no
 * session figure to subtract and landed in the headless column, under a legend
 * that named it.
 *
 * `spend.unified` returns the three series the main process already keeps
 * separately, for the window asked for. `sync` stays the counterfactual it
 * always was: list price for the same work, which is batch at 2x.
 */
function surfaceRows(days: UnifiedSpendDay[]): DayRow[] {
  return days.map((r) => {
    const total = r.sessionUsd + r.batchUsd + r.headlessUsd;
    return {
      day: r.day,
      session: r.sessionUsd,
      batch: r.batchUsd,
      headless: r.headlessUsd,
      total,
      sync: r.sessionUsd + r.headlessUsd + r.batchUsd * 2,
      unpricedRequests: r.unpricedRequests,
      unpricedHeadlessRows: r.unpricedHeadlessRows,
    };
  });
}

/**
 * Spend per repository, split by meter rather than by surface.
 *
 * `sessionUsd` is everything the CLI billed for itself in that repo —
 * interactive sessions and headless runs both — and `batchUsd` is what Wanigan
 * priced from token counts. The split is the whole point: the column Wanigan
 * computed stays separable from the column it was handed.
 */
type ProjectSpendRow = {
  projectId: string | null; projectName: string;
  sessionUsd: number; batchUsd: number; total: number;
};

/**
 * The preload signature for this channel is `unknown[]`, so the shape is
 * checked here rather than asserted. A row that does not carry the fields is
 * dropped — a NaN column reads as a real number, and this page is about money.
 */
function projectRows(value: unknown[]): ProjectSpendRow[] {
  const money = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const out: ProjectSpendRow[] = [];
  for (const row of value) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.projectName !== 'string') continue;
    out.push({
      projectId: typeof r.projectId === 'string' ? r.projectId : null,
      projectName: r.projectName,
      sessionUsd: money(r.sessionUsd),
      batchUsd: money(r.batchUsd),
      total: money(r.total),
    });
  }
  return out;
}

/**
 * Claude Code's own transcripts, as spend.transcriptMeter() returns them.
 *
 * A fourth source and the only one that can see work Wanigan never launched.
 * It is NOT summed into the totals above and must never be: it overlaps the
 * session series wherever a session was launched from Wanigan, so adding them
 * would bill that work twice. The card reports the two side by side and lets
 * the gap be the finding.
 */
type TranscriptMeter = {
  days: number;
  requests: number;
  outsideWanigan: number;
  filesBehind: number;
  firstAt: number | null;
  costUsd: number;
  tokens: number;
  unpricedRequests: number;
  unpricedModels: { model: string; requests: number }[];
  telemetryUsd: number;
  telemetryRequests: number;
};

/** One provider-reported limit window, with the token rate measured inside it. */
type BurnWindow = {
  kind: string;
  scope: string | null;
  accountLabel: string;
  usedPercent: number;
  resetsAtText: string | null;
  resetsAt: number;
  tokens: number;
  tokensPerMinute: number;
  projectedTokens: number | null;
  spansMultipleAccounts: boolean;
};

const numberOr = (v: unknown, fallback = 0) =>
  typeof v === 'number' && Number.isFinite(v) ? v : fallback;

/**
 * Both of these arrive over a channel typed `unknown`, so the shape is checked
 * rather than asserted — the same rule projectRows() follows, and for the same
 * reason: a NaN reads on screen as a real number and this page is about money.
 */
function transcriptMeter(value: unknown): TranscriptMeter | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const coverage = (r.coverage ?? {}) as Record<string, unknown>;
  const totals = (r.totals ?? {}) as Record<string, unknown>;
  const models: { model: string; requests: number }[] = [];
  for (const row of Array.isArray(r.unpricedModels) ? r.unpricedModels : []) {
    if (!row || typeof row !== 'object') continue;
    const m = row as Record<string, unknown>;
    if (typeof m.model === 'string') models.push({ model: m.model, requests: numberOr(m.requests) });
  }
  return {
    days: numberOr(r.days, 30),
    requests: numberOr(coverage.requests),
    outsideWanigan: numberOr(coverage.outsideWanigan),
    filesBehind: numberOr(r.filesBehind),
    firstAt: typeof coverage.firstAt === 'number' ? coverage.firstAt : null,
    costUsd: numberOr(totals.costUsd),
    tokens: numberOr(totals.inTokens) + numberOr(totals.outTokens)
      + numberOr(totals.cacheRead) + numberOr(totals.cacheWrite),
    unpricedRequests: numberOr(totals.unpricedRequests),
    unpricedModels: models,
    telemetryUsd: numberOr(r.telemetryUsd),
    telemetryRequests: numberOr(r.telemetryRequests),
  };
}

function burnWindows(value: unknown): BurnWindow[] {
  const out: BurnWindow[] = [];
  for (const row of Array.isArray(value) ? value : []) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const burn = (r.burn ?? {}) as Record<string, unknown>;
    if (typeof r.kind !== 'string' || typeof r.resetsAt !== 'number') continue;
    out.push({
      kind: r.kind,
      scope: typeof r.scope === 'string' ? r.scope : null,
      accountLabel: typeof r.accountLabel === 'string' ? r.accountLabel : 'Account',
      usedPercent: numberOr(r.usedPercent),
      resetsAtText: typeof r.resetsAtText === 'string' ? r.resetsAtText : null,
      resetsAt: r.resetsAt,
      tokens: numberOr(burn.tokens),
      tokensPerMinute: numberOr(burn.tokensPerMinute),
      projectedTokens: typeof burn.projectedTokens === 'number' ? burn.projectedTokens : null,
      spansMultipleAccounts: r.spansMultipleAccounts === true,
    });
  }
  return out;
}

/**
 * Which meter the headline totals and the two time-series charts speak for.
 *
 * ccusage offers auto/calculate/display over one source; Wanigan's equivalent
 * question is which of its two instruments is being read, because it genuinely
 * has two and they are not interchangeable. 'both' is the page as it has always
 * been. The other two are for the moment a figure looks wrong and the first
 * thing worth knowing is which half of it moved.
 */
const METER_MODES = [
  { value: 'both', label: 'Both meters' },
  { value: 'cli', label: 'CLI-reported' },
  { value: 'wanigan', label: 'Wanigan-priced' },
] as const;
type MeterMode = (typeof METER_MODES)[number]['value'];

const WINDOWS = [7, 30, 90];

/**
 * How long each read may be reused before the 15-second beat asks for it again.
 *
 * Every figure on this page is a multi-table aggregate over the whole ledger —
 * the effort, cache and estimator rollups scan every session, run and row there
 * is — and ten of them were being recomputed on a clock rather than when
 * anything moved. So the idle beat reuses what it read recently, and the TTL is
 * set per read by how fast that number can actually change: the two windowed
 * series stay on the beat, an all-time distribution does not need to.
 *
 * Every explicit signal bypasses this entirely. Changing the window, a
 * batch-changed event and every Retry button call `load` unquiet, which forces
 * a full re-read — a cache must never be the reason a page disagrees with the
 * database after you asked it to look again.
 */
const TTL = {
  /** The headline series. The beat IS its cadence; this never suppresses one. */
  spend: 15_000,
  /** A breached cap must not wait behind a slower tier. */
  breached: 15_000,
  batch: 30_000,
  budgets: 60_000,
  codex: 60_000,
  /** All-time distributions: a single turn moves them by a rounding error. */
  rollups: 90_000,
  accuracy: 120_000,
  /** Only changes when a repository is added or removed. */
  projects: 120_000,
  /**
   * The transcript meter reads a table the background ingest is still filling
   * on a first run, so it is the one read here that can legitimately change
   * between two beats with nothing else moving.
   */
  transcripts: 20_000,
  /**
   * A limit window is a live provider probe behind a staleness bound. Asking
   * more often than that bound cannot return anything new and does spawn a CLI
   * process, so this is set to the bound rather than to a refresh rate.
   */
  burn: 10 * 60_000,
} as const;

/* ── the view ─────────────────────────────────────────────────────────── */

export default function InsightsView({ onOpenRun, projects: given }: {
  onOpenRun?: (id: string) => void;
  /**
   * The shell already holds the project list and hands it to every other view.
   * Insights kept a private copy on a 15-second timer instead, so the two could
   * disagree about which repositories exist. Optional because App does not pass
   * it yet; until it does, the fallback read below is the honest source.
   */
  projects?: Project[];
}) {
  const [days, setDays] = useViewMemory<number>('days', 30);
  const [report, setReport] = useViewMemory<'spending' | 'activity' | 'budgets' | 'batch'>('report', 'spending');
  const [batch, setBatch] = useState<BatchInsights | null>(null);
  const [unified, setUnified] = useState<UnifiedSpendDay[]>([]);
  const [effort, setEffort] = useState<EffortRow[]>([]);
  const [cache, setCache] = useState<CacheRow[]>([]);
  const [buds, setBuds] = useState<BudgetState[]>([]);
  const [breached, setBreached] = useState<BudgetState[]>([]);
  const [acc, setAcc] = useState<AccuracyRow[]>([]);
  const [byProject, setByProject] = useState<ProjectSpendRow[]>([]);
  const [ownProjects, setOwnProjects] = useState<Project[]>([]);
  const [codexUsage, setCodexUsage] = useState<CodexUsage | null>(null);
  const [transcripts, setTranscripts] = useState<TranscriptMeter | null>(null);
  const [burn, setBurn] = useState<BurnWindow[]>([]);
  const [meterMode, setMeterMode] = useViewMemory<MeterMode>('meter', 'both');
  const [errs, setErrs] = useState<{ batch?: string; spend?: string; budgets?: string }>({});
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // The shell's list wins when there is one; the private read is the fallback.
  const projects = given ?? ownProjects;
  // A boolean, not the array: `load` is a dependency of the effect that calls
  // it, so anything unstable in its closure would re-run the whole page on
  // every render of a parent that rebuilds the list.
  const shellSuppliesProjects = given !== undefined;

  const alive = useRef(true);
  const daysRef = useRef(days);
  daysRef.current = days;

  /**
   * When each read last succeeded, so the idle beat can skip the ones that
   * cannot have moved. A failed read is never stamped, so it is retried on the
   * next beat rather than being cached as an absence.
   */
  const readAt = useRef<Map<string, number>>(new Map());
  const due = useCallback((key: string, ttl: number, force: boolean) => {
    if (force) return true;
    const at = readAt.current.get(key);
    return at === undefined || Date.now() - at >= ttl;
  }, []);

  // Set on mount, not just cleared on unmount: StrictMode mounts twice in dev,
  // and a flag only ever cleared would leave the second mount reading dead.
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const load = useCallback(async (d: number, quiet = false) => {
    if (!quiet) setBusy(true);
    const next: { batch?: string; spend?: string; budgets?: string } = {};
    // An unquiet load is somebody asking — a window change, a Retry, the first
    // paint — so it reads everything. Only the idle beat consults the TTLs.
    const force = !quiet;
    const stamp = (key: string) => { readAt.current.set(key, Date.now()); };

    await Promise.all([
      (async () => {
        if (!due('batch', TTL.batch, force)) return;
        try {
          const r = await window.wanigan.batch.insights();
          stamp('batch');
          if (alive.current) setBatch(r as BatchInsights);
        } catch (e) { next.batch = msg(e); }
      })(),
      (async () => {
        if (!due('codex', TTL.codex, force)) return;
        try {
          const value = await window.wanigan.codex.usageSummary();
          stamp('codex');
          if (alive.current) setCodexUsage(value);
        } catch { /* Codex may not be installed; the rest of Insights still works. */ }
      })(),
      // The two windowed series, keyed by window so switching to 90 days can
      // never be answered out of the 7-day read.
      (async () => {
        if (!due(`spend:${d}`, TTL.spend, force)) return;
        try {
          // `spend.unified` alone. The old `spend.sync` series was read beside
          // it and never used again once surfaceRows started deriving the
          // counterfactual locally — it re-ran the same three daily
          // aggregations on every refresh to fill state nothing rendered.
          const un = await window.wanigan.spend.unified(d);
          stamp(`spend:${d}`);
          // A window the operator has already moved on from must not land over
          // the one they are looking at.
          if (!alive.current || d !== daysRef.current) return;
          setUnified(un);
        } catch (e) { next.spend = msg(e); }
      })(),
      (async () => {
        if (!due(`project:${d}`, TTL.spend, force)) return;
        try {
          const rows = await window.wanigan.spend.byProject(d);
          stamp(`project:${d}`);
          if (alive.current) setByProject(projectRows(rows));
        } catch (e) { next.spend = msg(e); }
      })(),
      // All-time distributions. Neither is scoped by the window and neither
      // moves visibly inside one beat.
      (async () => {
        if (!due('rollups', TTL.rollups, force)) return;
        try {
          const [ef, ca] = await Promise.all([
            window.wanigan.spend.effort(),
            window.wanigan.spend.cache(),
          ]);
          stamp('rollups');
          if (!alive.current) return;
          setEffort(ef); setCache(ca);
        } catch (e) { next.spend = msg(e); }
      })(),
      (async () => {
        if (!due(`transcripts:${d}`, TTL.transcripts, force)) return;
        try {
          const value = await window.wanigan.spend.transcripts(d);
          stamp(`transcripts:${d}`);
          if (!alive.current || d !== daysRef.current) return;
          const meter = transcriptMeter(value);
          setTranscripts(meter);
          // A cold store fills on a background beat measured in minutes. Asking
          // for one bounded slice while somebody is actually looking at the page
          // makes that visible instead of leaving a card that says "still
          // reading" and does not move. Self-limiting: it only fires while
          // files are behind, once per read, and the budget is clamped in the
          // main process. The result is picked up by the next beat rather than
          // awaited, so it cannot delay this paint.
          if (meter && meter.filesBehind > 0) {
            window.wanigan.spend.ingestTranscripts(600)
              .then(() => { readAt.current.delete(`transcripts:${d}`); })
              .catch(() => {});
          }
        } catch { /* A machine with no Claude transcripts is not an error. */ }
      })(),
      (async () => {
        if (!due('burn', TTL.burn, force)) return;
        try {
          // Never forced. `force` here would re-probe the account on every
          // window change and every Retry, and each probe starts a real CLI
          // process; the staleness bound in claude-limits.ts is what decides
          // when a reading is old, and this read honours it.
          const value = await window.wanigan.usage.burn(false);
          stamp('burn');
          if (alive.current) setBurn(burnWindows(value));
        } catch { /* No Claude account, or the probe could not read the reply. */ }
      })(),
      (async () => {
        if (!due('budgets', TTL.budgets, force)) return;
        try {
          const ls = await window.wanigan.budgets.list();
          stamp('budgets');
          if (alive.current) setBuds(ls);
        } catch (e) { next.budgets = msg(e); }
      })(),
      (async () => {
        if (!due('breached', TTL.breached, force)) return;
        try {
          const br = await window.wanigan.budgets.breached();
          stamp('breached');
          if (alive.current) setBreached(br);
        } catch (e) { next.budgets = msg(e); }
      })(),
      (async () => {
        if (!due('accuracy', TTL.accuracy, force)) return;
        try {
          const ac = await window.wanigan.budgets.accuracy();
          stamp('accuracy');
          if (alive.current) setAcc(ac);
        } catch (e) { next.budgets = msg(e); }
      })(),
      (async () => {
        // Skipped entirely when the shell handed the list down.
        if (shellSuppliesProjects || !due('projects', TTL.projects, force)) return;
        try {
          const pr = await window.wanigan.projects.list();
          stamp('projects');
          if (alive.current) setOwnProjects(pr);
        } catch (e) { next.budgets = msg(e); }
      })(),
    ]);

    if (!alive.current) return;
    setErrs(next);
    setReady(true);
    setBusy(false);
  }, [due, shellSuppliesProjects]);

  useEffect(() => { void load(days); }, [load, days]);

  useEffect(() => {
    // The beat is idle refresh and consults the TTLs. A batch-changed event is
    // the ledger telling us it moved, so it re-reads everything — a cache must
    // not be the reason a finished run is missing from the page that reports on
    // it. Its `quiet` flag stays true so the header does not flash "Refreshing".
    const tick = () => void load(daysRef.current, true);
    const off = window.wanigan.on.batchChanged(() => { readAt.current.clear(); tick(); });
    const t = setInterval(() => { if (document.hidden) return; tick(); }, 15_000);
    // A page nobody is looking at does not need ten aggregate queries a minute;
    // the beat resumes, and re-reads, the moment the window comes back.
    const onVisible = () => { if (!document.hidden) tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      off(); clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  /**
   * The day series, with the meter the operator is not reading zeroed out.
   *
   * Zeroed rather than filtered: every chart below draws a continuous axis over
   * `rows`, and dropping days would make a mode switch silently change the
   * window as well. `sync` is rebuilt from what survives, because the
   * counterfactual is only defined over the work still on the chart — leaving
   * the full-price line while removing the actual one it is compared against
   * would draw a saving that nothing on screen accounts for.
   */
  const rows = useMemo(() => {
    const all = surfaceRows(unified);
    if (meterMode === 'both') return all;
    const cli = meterMode === 'cli';
    return all.map((r) => {
      const session = cli ? r.session : 0;
      const headless = cli ? r.headless : 0;
      const batch = cli ? 0 : r.batch;
      return {
        ...r,
        session, headless, batch,
        total: session + headless + batch,
        sync: session + headless + batch * 2,
      };
    });
  }, [unified, meterMode]);
  const win = useMemo(() => {
    const acc0 = { session: 0, batch: 0, headless: 0, total: 0, sync: 0, unpricedRequests: 0, unpricedHeadlessRows: 0 };
    for (const r of rows) {
      acc0.session += r.session; acc0.batch += r.batch; acc0.headless += r.headless;
      acc0.total += r.total; acc0.sync += r.sync;
      acc0.unpricedRequests += r.unpricedRequests; acc0.unpricedHeadlessRows += r.unpricedHeadlessRows;
    }
    return acc0;
  }, [rows]);
  /**
   * Work in this window that produced no cost figure at all.
   *
   * A Codex plan, a GLM flat plan and a Claude account whose telemetry omits
   * cost all bill through channels Wanigan is never handed a number for. Those
   * requests were summed as zero, so the totals above read as the whole bill.
   * They are not a bill while this is non-zero, and the page says so.
   */
  const unmetered = win.unpricedRequests + win.unpricedHeadlessRows;

  const t = batch?.totals ?? {};
  const hasBatch = (t.runs ?? 0) > 0;
  const cacheTotal = cache.reduce((a, c) => a + c.read + c.write + c.input, 0);
  /**
   * Whether anything has been billed at all — the gate on the empty state.
   *
   * The transcript meter belongs in it, and its absence was a real defect
   * rather than a missing nicety: every other term here describes work Wanigan
   * launched, so a person who has run Claude Code for a year from a terminal or
   * the VS Code extension and has just installed Wanigan saw "Nothing has been
   * billed yet" over a store holding tens of thousands of turns. The one card
   * that could have corrected the page was below the return that produced it.
   */
  const everSpent =
    hasBatch || win.total > 0 || cacheTotal > 0 ||
    effort.some((e) => e.costUsd > 0 || e.requests > 0) ||
    buds.some((b) => b.spentUsd > 0) || (codexUsage?.totalTokens ?? 0) > 0 ||
    (transcripts?.requests ?? 0) > 0;

  const head = (
    <PageHead title="Insights" lead="The bigger picture of your agent work." actions={(
      <div className="ins-actions">
        <select className="field" aria-label="Reporting window in days" value={days}
                onChange={(e) => setDays(Number(e.target.value))}>
          {WINDOWS.map((d) => <option key={d} value={d}>Last {d} days</option>)}
        </select>
        <span className="faint">{busy ? 'Refreshing…' : 'Checks for updates every 15s'}</span>
      </div>
    )} />
  );

  /* Four distinct states. Loading is not empty; empty is not zero-results. */

  if (!ready) {
    return (
      <div className="pane wide insights">
        {head}
        <div className="card chart-empty">
          <p>Reading the ledger…</p>
          <p className="faint" style={{ marginTop: 6 }}>
            Session and headless spend from the agent's own accounting, batch spend from Wanigan's
            pricing table, budgets from disk.
          </p>
        </div>
      </div>
    );
  }

  const fatal = errs.batch && errs.spend && errs.budgets;
  if (fatal) {
    return (
      <div className="pane wide insights">
        {head}
        <Note tone="error">
          <strong>Could not read any spend data.</strong> {errs.spend}
          <div style={{ marginTop: 6 }}>
            Every figure here is read by the main process out of the local database. If Wanigan is
            still starting, that database is not open yet — retry, and if it keeps failing reopen
            the window.
          </div>
          <button className="btn ins-btn" style={{ marginTop: 8 }} onClick={() => void load(days)}>
            Retry now
          </button>
        </Note>
      </div>
    );
  }

  if (!everSpent && buds.length === 0) {
    return (
      <div className="pane wide insights">
        {head}
        <div className="card" style={{ padding: 22 }}>
          <h2 style={{ fontSize: 'var(--t-lead)', fontWeight: 600 }}>Nothing has been billed yet</h2>
          <p className="dim" style={{ marginTop: 8, lineHeight: 1.55, maxWidth: 640 }}>
            This page reports on money already spent, so it stays blank until something has cost
            something. Three things fill it, and any one of them is enough:
          </p>
          <ul className="dim ins-start">
            <li>
              <strong>Open a session.</strong> Cost and effort arrive from the agent's own
              telemetry, so the first numbers land after its first API call. Claude Code's
              transcripts are read separately and fill this page on their own, including for
              sessions Wanigan never launched — if that store is still being read, this page
              will populate without you doing anything.
            </li>
            <li>
              <strong>Submit a batch run.</strong> Batch rates are half of list, and the synchronous
              comparison only has something to compare once a run has finished.
            </li>
            <li>
              <strong>Set a budget.</strong> A cap with no spend against it still draws its meter,
              and it is the only way to be warned before the money is gone.
            </li>
          </ul>
          <BudgetEditor projects={projects} buds={buds} onSaved={setBuds} />
        </div>
      </div>
    );
  }

  return (
    <div className="pane wide insights">
      {head}

      <div aria-live="polite">
        <BreachBanner breached={breached} />
      </div>

      {errs.spend && (
        <Note tone="warn">
          <strong>Spend figures are stale.</strong> {errs.spend} — the charts below are the last
          good read.{' '}
          <button className="ins-inline" onClick={() => void load(days)}>Retry now</button>
        </Note>
      )}
      {errs.budgets && (
        <Note tone="warn">
          <strong>Budgets could not be read.</strong> {errs.budgets} — caps and projections are
          missing from this page until it succeeds.{' '}
          <button className="ins-inline" onClick={() => void load(days)}>Retry now</button>
        </Note>
      )}
      {errs.batch && (
        <Note tone="warn">
          <strong>Batch history could not be read.</strong> {errs.batch} — the batch-only charts
          further down are missing.{' '}
          <button className="ins-inline" onClick={() => void load(days)}>Retry now</button>
        </Note>
      )}

      <div className="ins-workspace">
        <nav className="ins-reports" aria-label="Insights reports">
          {([
            ['spending', 'Spending', 'Trends and projects'],
            ['activity', 'Tokens & pace', 'Activity, effort and cache'],
            ['budgets', 'Budgets', 'Month-to-date limits'],
            ['batch', 'Batch reports', 'Outcomes and reconciliation'],
          ] as const).map(([id, title, hint]) => (
            <button key={id} aria-current={report === id ? 'true' : undefined}
                    aria-controls={`ins-report-${id}`} onClick={() => setReport(id)}>
              <strong>{title}</strong><span>{hint}</span>
            </button>
          ))}
          <details className="ins-sources">
            <summary>About the meters</summary>
            <p>Session and headless costs use CLI accounting. Batch costs use Wanigan’s local
              pricing table and may fall back to a default rate for newer models. Every chart
              names its sources; these figures may differ from your bill.</p>
          </details>
        </nav>
        <div className="ins-report-content">
          {/* Keep reports mounted: changing a report must not discard a budget or reconciliation draft. */}
          <section id="ins-report-spending" className="ins-report" hidden={report !== 'spending'} aria-label="Spending report">
            <div className="ins-intro"><h2>Spending</h2><p>Recorded costs across your projects · last {days} days</p></div>
            <div className="ins-filters">
              <span className="label">Meter</span>
              <Segmented label="Which meter the totals below are read from" value={meterMode} onChange={setMeterMode}
                         options={METER_MODES.map((m) => ({value: m.value, label: m.label}))} />
              <span className="faint ins-filter-note">
                Scopes the totals and two time-series charts. Project spend includes both meters.
                {meterMode !== 'both' && <> The other meter reads zero by choice here, not because nothing was spent.</>}
              </span>
            </div>
            <TwoSpeeds win={win} days={days} unmetered={unmetered} />

            <SurfaceOverTime rows={rows} days={days} onWiden={() => setDays(90)} />

            <SpendByProject rows={byProject} days={days} />
            <details className="ins-comparison">
              <summary>Compare with synchronous pricing</summary>
              <SyncComparison rows={rows} days={days} totals={win} onWiden={() => setDays(90)} />
            </details>
          </section>
          <section id="ins-report-activity" className="ins-report" hidden={report !== 'activity'} aria-label="Tokens and pace report">
            <div className="ins-intro"><h2>Tokens &amp; pace</h2><p>Live provider windows, {days}-day transcripts, and all-time effort and cache.</p></div>
            <BurnRate windows={burn} />
            <TranscriptMeterCard meter={transcripts} days={days} />
            {codexUsage && codexUsage.totalTokens > 0 && <CodexActivity usage={codexUsage} />}
            <EffortDistribution rows={effort} />
            <UnifiedCache rows={cache} />
          </section>
          <section id="ins-report-budgets" className="ins-report" hidden={report !== 'budgets'} aria-label="Budgets report">
            <div className="ins-intro"><h2>Budgets</h2><p>Month-to-date spend and the limits you set. Independent of the reporting window.</p></div>
            <Budgets buds={buds} projects={projects} onSaved={(next) => {
              setBuds(next);
              window.wanigan.budgets.breached().then((b) => { if (alive.current) setBreached(b); }).catch(() => {});
            }} />

          </section>
          <section id="ins-report-batch" className="ins-report" hidden={report !== 'batch'} aria-label="Batch report">
            <div className="ins-intro"><h2>Batch reports</h2><p>All-time results, estimates and a separate reconciliation window.</p></div>
            <div className="ins-divider">
              <span className="label">Batch runs · Wanigan meter</span>
              <span className="faint">
                {METER.wanigan.glyph} Priced locally from returned token counts. The reconciliation card
                at the foot of this page is what tests those figures against the bill.
              </span>
            </div>

            {!hasBatch ? (
              <div className="card chart-empty">
                No batch runs have been submitted yet. Build one in Batches — bulk work is billed at half
                of list, which is the whole reason the comparison above exists.
              </div>
            ) : (
              <>
                <div className="chart-grid">
                  {/* The sentence carries the whole claim. The two-bar picture that
                      used to sit here drew batch at exactly 50% every time, because
                      the comparison is defined as spent × 2 — a shape that can never
                      vary is decoration, not evidence. */}
                  <HeroCard
                    title="Total batch spend"
                    hero={usd(t.cost ?? 0)}
                    sub={<>Batch rates are exactly half of list, so the same work run synchronously
                          would have cost <strong>{usd((t.cost ?? 0) * 2)}</strong>.</>}
                  />

                  <BatchCacheCard totals={t} />
                </div>

                <TokenFlow totals={t} />
                <SpendByModel rows={batch?.byModel ?? []} />
                <Outcomes rows={batch?.outcomes ?? []} />
                <SpendOverTime runs={batch?.perRun ?? []} onOpenRun={onOpenRun} />
              </>
            )}

            <Reconcile />

            <EstimateAccuracy rows={acc} />
          </section>
        </div>
      </div>
    </div>
  );
}

/* ── budget breach banner ─────────────────────────────────────────────── */

type Mark = { glyph: string; word: string; fg: string; bg: string };

/** Glyph + word + colour, in that order of importance. */
function budgetMark(b: BudgetState): Mark {
  if (b.monthlyUsd <= 0) {
    return { glyph: '◦', word: 'No cap', fg: 'var(--text-dim)', bg: 'var(--bg-sunk)' };
  }
  if (b.spentUsd >= b.monthlyUsd) {
    return { glyph: '✕', word: 'Over budget', fg: 'var(--critical)', bg: 'var(--critical-soft)' };
  }
  if (b.projectedUsd >= b.monthlyUsd) {
    return { glyph: '▲', word: 'Trending over', fg: 'var(--serious)', bg: 'var(--serious-soft)' };
  }
  if (b.spentUsd >= b.monthlyUsd * b.warnAt) {
    return { glyph: '!', word: 'Past warning', fg: 'var(--warning)', bg: 'var(--warning-soft)' };
  }
  return { glyph: '✓', word: 'On track', fg: 'var(--good)', bg: 'var(--good-soft)' };
}

function MarkPill({ m }: { m: Mark }) {
  return (
    <span className="pill" style={{ background: m.bg, color: m.fg }}>
      <span aria-hidden="true" style={{ fontWeight: 700 }}>{m.glyph}</span> {m.word}
    </span>
  );
}

function BreachBanner({ breached }: { breached: BudgetState[] }) {
  if (!breached.length) return null;
  const over = breached.filter((b) => b.spentUsd >= b.monthlyUsd);
  return (
    <Note tone={over.length ? 'error' : 'warn'}>
      <strong>
        {over.length
          ? `${over.length === 1 ? '1 budget is' : `${over.length} budgets are`} already over.`
          : `${breached.length === 1 ? '1 budget is' : `${breached.length} budgets are`} past their warning line.`}
      </strong>{' '}
      A cap that only speaks once it has been exceeded is a receipt, not a budget — these are listed
      while there is still a month left to change.
      <ul className="ins-breach">
        {breached.map((b) => {
          const m = budgetMark(b);
          return (
            <li key={b.scopeId ?? '*'}>
              <span aria-hidden="true" style={{ fontWeight: 700, color: m.fg }}>{m.glyph}</span>{' '}
              <strong>{b.scopeName}</strong> — {m.word}: {cents(b.spentUsd)} of {cents(b.monthlyUsd)}{' '}
              ({pct(b.monthlyUsd > 0 ? b.spentUsd / b.monthlyUsd : 0)}) on day {b.daysElapsed} of{' '}
              {b.daysInMonth}, projecting {cents(b.projectedUsd)} by month end.
            </li>
          );
        })}
      </ul>
    </Note>
  );
}

/** Codex plan activity is measurable even when its account surface has no invoice. */
function CodexActivity({ usage }: { usage: CodexUsage }) {
  return (
    <div className="card" style={{ padding: 15 }}>
      <div className="ins-cardhead">
        <div>
          <h3 style={{ fontSize: 'var(--t-body)', fontWeight: 600 }}>Codex activity</h3>
          <p className="dim" style={{ marginTop: 3, lineHeight: 1.45 }}>
            Exact cumulative counters from local Codex rollouts across {num(usage.conversations)} conversation{usage.conversations === 1 ? '' : 's'}.
          </p>
        </div>
        <span className="pill" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>No per-thread invoice</span>
      </div>
      <div className="stat-grid ins-hero-row">
        <Stat label="Total tokens" value={num(usage.totalTokens)} sub="input plus output" />
        <Stat label="Input" value={num(usage.inTokens)} sub={`${num(usage.cacheRead)} cached reads`} />
        <Stat label="Output" value={num(usage.outTokens)}
              sub={`${pct(usage.totalTokens > 0 ? usage.outTokens / usage.totalTokens : 0)} of all tokens`} />
        <Stat label="Dollar amount" value="Not reported" sub="your Codex plan does not expose one per conversation" />
      </div>
      <p className="faint" style={{ marginTop: 10, fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
        These tokens are real usage, but they are not converted to dollars: a ChatGPT/Codex plan can include usage, rate limits, or credits that do not map to a fixed API price. Wanigan will show a dollar amount only when the provider reports a billable amount.
      </p>
    </div>
  );
}

/* ── the transcript meter ─────────────────────────────────────────────── */

/**
 * Claude Code's own record, beside what the collector was handed.
 *
 * The card exists for one number: `outsideWanigan`. Every other figure on this
 * page describes work Wanigan started, so the page has never been able to say
 * anything at all about a session run from a terminal or the VS Code
 * extension — including saying that it existed. That silence reads as zero.
 *
 * The two dollar figures are deliberately NOT differenced into a single "you
 * were missing $X". They cover overlapping sets — the collector's number is
 * the CLI's own cost for the sessions it received, the transcript number is
 * Wanigan's arithmetic over Claude's token counts for every session on disk —
 * so their difference is not a quantity anything was billed for. They sit side
 * by side and the reader draws the conclusion.
 */
function TranscriptMeterCard({ meter, days }: { meter: TranscriptMeter | null; days: number }) {
  if (!meter || meter.requests === 0) return null;

  const share = meter.requests > 0 ? meter.outsideWanigan / meter.requests : 0;
  return (
    <div className="chart-card">
      <h3>Claude&rsquo;s own transcripts</h3>
      <p className="dim ins-note">
        Read from the files Claude Code writes for itself, which exist whether or not telemetry
        was ever switched on. This is the only meter here that can see a session Wanigan did not
        launch.
      </p>

      <div className="stat-grid ins-hero-row">
        <Stat
          label={`Turns on record · ${days}d window`}
          value={num(meter.requests)}
          sub={<>{num(meter.outsideWanigan)} from an entrypoint Wanigan never launched
            {meter.requests > 0 && <> · {pct(share)} of all turns</>}</>}
        />
        <Stat
          label="Priced from transcripts"
          value={usd(meter.costUsd)}
          sub={<>{METER.transcript.glyph} {METER.transcript.word} · {num(meter.tokens)} tokens</>}
        />
        <Stat
          label="Seen by the collector"
          value={usd(meter.telemetryUsd)}
          sub={<>{METER.cli.glyph} {METER.cli.word} · {num(meter.telemetryRequests)} requests</>}
        />
      </div>

      <Meters of={['transcript', 'cli']} extra={
        <> These two are not added together and their difference is not a bill: they cover
          overlapping sets of the same work, measured by different instruments.</>
      } />

      {meter.unpricedRequests > 0 && (
        <Note tone="warn">
          <strong>{num(meter.unpricedRequests)} turns have no published rate</strong> and are
          absent from the figure above, not counted as free.{' '}
          {meter.unpricedModels.length > 0 && (
            <>The models are{' '}
              {meter.unpricedModels.map((m, i) => (
                <span key={m.model}>
                  {i > 0 && ', '}<code>{m.model}</code> ({num(m.requests)})
                </span>
              ))}
              . Adding a row for each to the pricing table is what closes this.
            </>
          )}
        </Note>
      )}

      {meter.filesBehind > 0 && (
        <Note tone="info">
          <strong>Still reading.</strong> {num(meter.filesBehind)} transcript
          {meter.filesBehind === 1 ? ' has' : 's have'} bytes not yet folded in, so every figure on
          this card is a floor that is still rising. A first pass over a large history takes a few
          minutes and resumes on its own.
        </Note>
      )}
    </div>
  );
}

/* ── burn rate against the provider's own window ──────────────────────── */

/**
 * How fast the current limit window is going, and where it lands.
 *
 * The window is the provider's, not one this page inferred: claude-limits.ts
 * asks the account and is told the percentage used and the instant it resets.
 * ccusage, where the idea comes from, reconstructs a five-hour block by adding
 * five hours to the first message it can find; that guess is exactly what the
 * limits probe exists to avoid, so it is not repeated here.
 *
 * The rate is tokens, never dollars. The plan meters tokens, so a dollar rate
 * would answer a different question from the percentage beside it while looking
 * like the same one.
 */
function BurnRate({ windows }: { windows: BurnWindow[] }) {
  if (windows.length === 0) return null;

  return (
    <div className="chart-card">
      <h3>Burn rate</h3>
      <p className="dim ins-note">
        Token throughput measured inside the window the account itself reports, so the percentage
        and the rate are describing the same period.
      </p>

      <div className="stat-grid ins-hero-row">
        {windows.map((w) => {
          const label = w.scope ? `${w.kind} · ${w.scope}` : w.kind;
          const perMin = w.tokensPerMinute;
          return (
            <Stat
              key={`${w.accountLabel}-${w.kind}-${w.scope ?? 'all'}`}
              label={`${label} · ${w.accountLabel}`}
              value={`${num(Math.round(perMin))}/min`}
              sub={<>
                {pct(w.usedPercent / 100)} used
                {w.resetsAtText ? <> · resets {w.resetsAtText}</> : null}
                {w.projectedTokens !== null && (
                  <> · ~{num(w.projectedTokens)} tokens by reset at this rate</>
                )}
              </>}
            />
          );
        })}
      </div>

      <p className="faint ins-note">
        The percentage is the provider&rsquo;s own reading for one account. The rate is measured
        from Claude&rsquo;s transcripts on this machine
        {windows.some((w) => w.spansMultipleAccounts)
          ? ', which cover every account signed in on it — so with more than one account the rate '
            + 'can legitimately outrun the percentage beside it.'
          : '.'}
        {' '}The projection assumes the observed rate holds, which is a run rate rather than a
        forecast.
      </p>
    </div>
  );
}

/* ── the two speeds, as a number ──────────────────────────────────────── */

function TwoSpeeds({ win, days, unmetered }: {
  win: { session: number; batch: number; headless: number; total: number; sync: number };
  days: number;
  /** Requests and headless rows in this window that reported no cost at all. */
  unmetered: number;
}) {
  const interactive = win.session + win.headless;
  const saved = win.sync - win.total;
  return (
    <div className="stat-grid">
      <Stat
        label={`Interactive · ${days}d`}
        value={usd(interactive)}
        sub={<>
          {METER.cli.glyph} CLI meter · sessions {usd(win.session)} + headless {usd(win.headless)}
          {unmetered > 0 && (
            <> · <span className="pill" title="These ran on a plan or a harness that reports no per-request cost. Wanigan records the work and refuses to price it, so this figure is a floor rather than a bill.">
              {num(unmetered)} unpriced
            </span></>
          )}
        </>}
      />
      <Stat
        label={`Bulk · ${days}d`}
        value={usd(win.batch)}
        sub={<>{METER.wanigan.glyph} Wanigan meter · billed at half of list</>}
      />
      <Stat
        label={`Everything · ${days}d`}
        value={usd(win.total)}
        sub={
          win.total > 0
            ? <>{pct(interactive / win.total)} interactive · {pct(win.batch / win.total)} bulk{unmetered > 0 ? ' · at least' : ''}</>
            : <>Nothing billed in this window</>
        }
      />
      <Stat
        label="Synchronous list price"
        // Not a saving in the observed-good colour: `saved` is
        // `sync - actual`, and `sync` is a modelled counterfactual — what the
        // same batch work would have cost at list rates. No money moved, so it
        // wears the estimate mark and the neutral tone every other derived
        // figure on this page wears.
        value={<>~{usd(win.sync)}</>}
        sub={
          win.sync > 0
            ? <>{usd(saved)} less was billed · {pct(saved / win.sync)} below list · est.</>
            : <>No batch runs in this window</>
        }
      />
    </div>
  );
}

/* ── 1 · spend by surface over time ───────────────────────────────────── */

function SurfaceOverTime({ rows, days, onWiden }: {
  rows: DayRow[]; days: number; onWiden: () => void;
}) {
  const [ref, w] = useWidth();
  const [allDays, setAllDays] = useState(false);

  const totals = SURFACES.map((s) => ({
    ...s,
    value: rows.reduce((a, r) => a + r[s.key], 0),
  }));
  const grand = totals.reduce((a, s) => a + s.value, 0);

  const H = 196, PAD_T = 14, PAD_B = 32, PAD_L = 52, PAD_R = 8;
  const plotW = Math.max(60, w - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const max = niceMax(Math.max(...rows.map((r) => r.total), 0));
  const step = rows.length ? plotW / rows.length : plotW;
  const bw = Math.max(1.5, Math.min(22, step * 0.68));
  const GAP = 2;

  const ticks = [0, 0.5, 1].map((f) => ({ f, v: max * f }));

  return (
    <div className="chart-card" ref={ref}>
      <h3>Spend by surface, day by day</h3>
      <p className="sub">The last {days} days, stacked: interactive sessions, bulk batch runs and headless fan-outs.</p>
      <details className="ins-how">
        <summary>How this is derived</summary>
        <p>
          Sessions are always slot 1, batches slot 2, headless slot 3 — the order is fixed on every
          chart on this page, because the order is what keeps the palette readable under colour
          vision deficiency.
        </p>
      </details>

      {grand <= 0 ? (
        <ZeroResults days={days} onWiden={onWiden} />
      ) : (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${w} ${H}`} height={H} role="img"
               aria-label={`Daily spend for the last ${days} days by surface. ${
                 totals.map((s) => `${s.label} ${usd(s.value)}`).join(', ')}. Total ${usd(grand)}.`}>
            {ticks.map((tk) => {
              const y = PAD_T + plotH - tk.f * plotH;
              return (
                <g key={tk.f}>
                  <line x1={PAD_L} y1={y} x2={w - PAD_R} y2={y}
                        stroke="var(--grid)" strokeWidth="1" />
                  <text x={PAD_L - 8} y={y + 3.5} fontSize="10" textAnchor="end"
                        fill="var(--text-faint)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {usd(tk.v)}
                  </text>
                </g>
              );
            })}

            {rows.map((r, i) => {
              const x = PAD_L + i * step + (step - bw) / 2;
              let y = PAD_T + plotH;
              return (
                <g key={r.day}>
                  {SURFACES.map((s) => {
                    const v = r[s.key];
                    if (v <= 0) return null;
                    const h = (v / max) * plotH;
                    y -= h;
                    return (
                      <rect key={s.key} x={x} y={y} width={bw}
                            height={Math.max(1, h - GAP)}
                            rx={Math.min(4, bw / 2)} fill={s.color} />
                    );
                  })}
                </g>
              );
            })}

            {/* A full-height hit target per day, so the tooltip is not a pinpoint. */}
            {rows.map((r, i) => (
              <rect key={`hit-${r.day}`} x={PAD_L + i * step} y={PAD_T}
                    width={Math.max(step, 1)} height={plotH} fill="transparent">
                <title>
                  {`${fmtDay(r.day)}\n` +
                   `Sessions ${usd(r.session)}\nBatches ${usd(r.batch)}\nHeadless ${usd(r.headless)}\n` +
                   `Total ${usd(r.total)}`}
                </title>
              </rect>
            ))}

            <line x1={PAD_L} y1={PAD_T + plotH} x2={w - PAD_R} y2={PAD_T + plotH}
                  stroke="var(--line)" strokeWidth="1" />

            {rows.length > 0 && (
              <>
                <text x={PAD_L} y={H - 12} fontSize="10" fill="var(--text-faint)">
                  {fmtDay(rows[0].day)}
                </text>
                <text x={w - PAD_R} y={H - 12} fontSize="10" textAnchor="end" fill="var(--text-faint)">
                  {fmtDay(rows[rows.length - 1].day)}
                </text>
              </>
            )}
          </svg>

          <div className="legend">
            {totals.map((s) => (
              <span key={s.key} className="legend-item">
                <span className="legend-swatch" style={{ background: s.color }} />
                {s.label} <span className="mono ins-num">{usd(s.value)}</span>
              </span>
            ))}
          </div>

          <table className="viz-table">
            <thead>
              <tr>
                <th>Surface</th>
                <th className="ins-th-r">Spend ({days}d)</th>
                <th className="ins-th-r">Share</th>
                <th>Meter</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((s) => (
                <tr key={s.key}>
                  <td>
                    <span className="legend-swatch ins-swatch" style={{ background: s.color }} />
                    {s.label}
                  </td>
                  <td className="n">{cents(s.value)}</td>
                  <td className="n ins-dim">{grand > 0 ? pct(s.value / grand, 1) : '—'}</td>
                  <td className="ins-dim">{METER[s.meter].glyph} {METER[s.meter].word}</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td className="n"><strong>{cents(grand)}</strong></td>
                <td className="n ins-dim">100.0%</td>
                <td className="ins-dim">mixed</td>
              </tr>
            </tbody>
          </table>

          <button className="ins-inline ins-more" onClick={() => setAllDays((v) => !v)}
                  aria-expanded={allDays}>
            {allDays ? 'Hide the daily rows' : `Show all ${rows.length} daily rows`}
          </button>

          {allDays && (
            <div className="ins-scroll">
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="ins-th-r">Sessions</th>
                    <th className="ins-th-r">Batches</th>
                    <th className="ins-th-r">Headless</th>
                    <th className="ins-th-r">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.day}>
                      <td className="ins-nowrap">{fmtDay(r.day)}</td>
                      <td className="n">{cents(r.session)}</td>
                      <td className="n">{cents(r.batch)}</td>
                      <td className="n">{cents(r.headless)}</td>
                      <td className="n">{cents(r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <Meters of={['cli', 'wanigan']} />
    </div>
  );
}

/**
 * Which repository the money went to.
 *
 * Every other axis on this page is surface, effort, model or day — none of
 * which answers "which repo is this costing me", the question anybody with more
 * than two projects asks first. The main process has always grouped this; the
 * channel was simply never called.
 *
 * The two columns are two different instruments and stay apart. A repo whose
 * spend cannot be attributed keeps its own row rather than being dropped: a
 * session that ran before its folder was registered is still money.
 */
function SpendByProject({ rows, days }: { rows: ProjectSpendRow[]; days: number }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.total));
  const total = rows.reduce((a, r) => a + r.total, 0);
  return (
    <div className="chart-card">
      <h3>Spend by repository</h3>
      {/* The two-meter split changes how the number is read, so it stays at
          level one; only the reason for the column layout moves. */}
      <p className="sub">
        Last {days} days, dearest first. Sessions and headless runs are the CLI's own figure; batch
        runs are Wanigan's arithmetic.
      </p>
      <details className="ins-how">
        <summary>How this is derived</summary>
        <p>They are separate columns because they are separate meters, and averaging them would invent a rate neither one reported.</p>
      </details>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map((r) => {
          const p = max > 0 ? (r.total / max) * 100 : 0;
          const cliShare = r.total > 0 ? (r.sessionUsd / r.total) * 100 : 0;
          return (
            <div key={r.projectId ?? r.projectName}>
              <div style={{ display: 'flex', fontSize: 'var(--t-small)', marginBottom: 3, gap: 8 }}>
                <span className="trunc">{r.projectName}</span>
                <span className="mono ins-num" style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>
                  {cents(r.total)}
                </span>
              </div>
              {/* One bar, two segments, in the page's fixed slot order:
                  sessions are always slot 1 and batches always slot 2, on every
                  chart here, so the mapping is learned once. */}
              <div style={{ height: 7, borderRadius: 'var(--r-sm)', background: 'var(--bg-sunk)',
                            overflow: 'hidden', display: 'flex', width: `${Math.max(p, 1)}%` }}>
                <div style={{ width: `${cliShare}%`, background: SERIES[0] }} />
                <div style={{ width: `${100 - cliShare}%`, background: SERIES[1] }} />
              </div>
            </div>
          );
        })}
      </div>
      <table className="viz-table">
        <thead>
          <tr>
            <th>Repository</th>
            <th className="ins-th-r">{METER.cli.glyph} Sessions &amp; headless</th>
            <th className="ins-th-r">{METER.wanigan.glyph} Batches</th>
            <th className="ins-th-r">Total</th>
            <th className="ins-th-r">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.projectId ?? r.projectName}>
              <td className="trunc">
                {r.projectName}
                {r.projectId === null && (
                  <span className="ins-dim"> · not attributed to a registered repository</span>
                )}
              </td>
              <td className="n">{cents(r.sessionUsd)}</td>
              <td className="n">{cents(r.batchUsd)}</td>
              <td className="n">{cents(r.total)}</td>
              <td className="n ins-dim">{total > 0 ? pct(r.total / total, 1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Meters of={['cli', 'wanigan']}
              extra="Totals are the two columns added, never reconciled against each other." />
    </div>
  );
}

/** The window excluded everything — a different state from "nothing exists". */
function ZeroResults({ days, onWiden }: { days: number; onWiden: () => void }) {
  return (
    <div className="chart-empty">
      <p>Nothing was billed in the last {days} days.</p>
      <p className="ins-zero-sub">
        There is spend on record, just not inside this window.{' '}
        {days < 90 ? (
          <button className="ins-inline" onClick={onWiden}>Widen it to 90 days</button>
        ) : (
          <>Ninety days is the widest window here; the all-time cards further down still have data.</>
        )}
      </p>
    </div>
  );
}

/* ── 4 · synchronous comparison ───────────────────────────────────────── */

function SyncComparison({ rows, days, totals, onWiden }: {
  rows: DayRow[]; days: number;
  totals: { total: number; sync: number; batch: number; session: number; headless: number };
  onWiden: () => void;
}) {
  const [ref, w] = useWidth();
  const [allDays, setAllDays] = useState(false);

  const H = 196, PAD_T = 16, PAD_B = 32, PAD_L = 52, PAD_R = 44;
  const plotW = Math.max(60, w - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const max = niceMax(Math.max(...rows.map((r) => r.sync), 0));
  const n = rows.length;

  const px = (i: number) => PAD_L + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const py = (v: number) => PAD_T + plotH - (v / max) * plotH;

  const line = (pick: (r: DayRow) => number) =>
    rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${px(i).toFixed(2)},${py(pick(r)).toFixed(2)}`).join(' ');

  const band = n > 1
    ? `${line((r) => r.sync)} ` +
      rows.slice().reverse().map((r, j) => {
        const i = n - 1 - j;
        return `L${px(i).toFixed(2)},${py(r.total).toFixed(2)}`;
      }).join(' ') + ' Z'
    : '';

  const saved = totals.sync - totals.total;
  const last = rows[n - 1];
  const gapOk = last ? Math.abs(py(last.sync) - py(last.total)) >= 13 : false;

  const ticks = [0, 0.5, 1].map((f) => ({ f, v: max * f }));

  return (
    <div className="chart-card" ref={ref}>
      <h3>What synchronous would have cost</h3>
      <p className="sub">
        Batch rates are exactly half of list, so a batch run's synchronous figure is 2×. Session and
        headless spend is <strong>already</strong> at list price and crosses over at 1× — doubling
        it too would invent a saving Wanigan never made, and it would grow with exactly the surface
        you spend most of your day in, so the invented number would end up the largest one here.
      </p>

      {totals.sync <= 0 ? (
        <ZeroResults days={days} onWiden={onWiden} />
      ) : (
        <>
          <svg className="chart-svg" viewBox={`0 0 ${w} ${H}`} height={H} role="img"
               aria-label={`Actual spend ${usd(totals.total)} against the synchronous equivalent ${
                 usd(totals.sync)} over the last ${days} days.`}>
            {ticks.map((tk) => {
              const y = py(tk.v);
              return (
                <g key={tk.f}>
                  <line x1={PAD_L} y1={y} x2={w - PAD_R} y2={y} stroke="var(--grid)" strokeWidth="1" />
                  <text x={PAD_L - 8} y={y + 3.5} fontSize="10" textAnchor="end"
                        fill="var(--text-faint)" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {usd(tk.v)}
                  </text>
                </g>
              );
            })}

            {band && <path d={band} fill={SERIES[1]} opacity="0.14" />}
            {n > 1 && (
              <>
                <path d={line((r) => r.sync)} fill="none" stroke={SERIES[1]} strokeWidth="2"
                      strokeLinejoin="round" strokeLinecap="round" />
                <path d={line((r) => r.total)} fill="none" stroke={SERIES[0]} strokeWidth="2"
                      strokeLinejoin="round" strokeLinecap="round" />
              </>
            )}

            {rows.map((r, i) => (
              <rect key={`hit-${r.day}`} x={px(i) - (n > 1 ? plotW / (n - 1) / 2 : plotW / 2)}
                    y={PAD_T} width={n > 1 ? plotW / (n - 1) : plotW} height={plotH} fill="transparent">
                <title>
                  {`${fmtDay(r.day)}\nActual ${usd(r.total)}\nSynchronous ${usd(r.sync)}\n` +
                   `Saved ${usd(r.sync - r.total)}`}
                </title>
              </rect>
            ))}

            <line x1={PAD_L} y1={PAD_T + plotH} x2={w - PAD_R} y2={PAD_T + plotH}
                  stroke="var(--line)" strokeWidth="1" />

            {last && (
              <>
                <circle cx={px(n - 1)} cy={py(last.sync)} r="3" fill={SERIES[1]}
                        stroke="var(--bg-soft)" strokeWidth="2" />
                <circle cx={px(n - 1)} cy={py(last.total)} r="3" fill={SERIES[0]}
                        stroke="var(--bg-soft)" strokeWidth="2" />
              </>
            )}
            {last && gapOk && (
              <>
                <text x={w - PAD_R + 7} y={py(last.sync) + 3.5} fontSize="10" fill="var(--text-dim)">
                  sync
                </text>
                <text x={w - PAD_R + 7} y={py(last.total) + 3.5} fontSize="10" fill="var(--text-dim)">
                  actual
                </text>
              </>
            )}
            {last && !gapOk && (
              <text x={w - PAD_R + 7} y={py(last.total) + 3.5} fontSize="10" fill="var(--text-faint)">
                same
              </text>
            )}

            {rows.length > 0 && (
              <>
                <text x={PAD_L} y={H - 12} fontSize="10" fill="var(--text-faint)">
                  {fmtDay(rows[0].day)}
                </text>
                <text x={w - PAD_R} y={H - 12} fontSize="10" textAnchor="end" fill="var(--text-faint)">
                  {fmtDay(rows[rows.length - 1].day)}
                </text>
              </>
            )}
          </svg>

          <div className="legend">
            <span className="legend-item">
              <span className="legend-swatch" style={{ background: SERIES[0] }} />
              Actual billed <span className="mono ins-num">{usd(totals.total)}</span>
            </span>
            <span className="legend-item">
              <span className="legend-swatch" style={{ background: SERIES[1] }} />
              Synchronous equivalent <span className="mono ins-num">{usd(totals.sync)}</span>
            </span>
          </div>

          <table className="viz-table">
            <thead>
              <tr>
                <th>Line</th>
                <th className="ins-th-r">{days}-day total</th>
                <th>How it is derived</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>Actual billed</td>
                <td className="n">{cents(totals.total)}</td>
                <td className="ins-dim">sessions + headless + batches, as billed</td>
              </tr>
              <tr>
                <td>Synchronous equivalent</td>
                <td className="n">{cents(totals.sync)}</td>
                <td className="ins-dim">sessions + headless at 1× · batches at 2×</td>
              </tr>
              <tr>
                <td><strong>Saved by batching</strong></td>
                <td className="n"><strong>{cents(saved)}</strong></td>
                <td className="ins-dim">
                  equals the batch column ({cents(totals.batch)}) — nothing else is discounted
                </td>
              </tr>
            </tbody>
          </table>

          <button className="ins-inline ins-more" onClick={() => setAllDays((v) => !v)}
                  aria-expanded={allDays}>
            {allDays ? 'Hide the daily rows' : `Show all ${rows.length} daily rows`}
          </button>

          {allDays && (
            <div className="ins-scroll">
              <table className="viz-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="ins-th-r">Actual</th>
                    <th className="ins-th-r">Synchronous</th>
                    <th className="ins-th-r">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.day}>
                      <td className="ins-nowrap">{fmtDay(r.day)}</td>
                      <td className="n">{cents(r.total)}</td>
                      <td className="n">{cents(r.sync)}</td>
                      <td className="n">{cents(r.sync - r.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <Meters of={['cli', 'wanigan']} />
    </div>
  );
}

/* ── 2 · effort distribution ──────────────────────────────────────────── */

/** Cheapest first is meaningless here; the order is cost, as the query returns it. */
const HIGH_EFFORT = new Set(['xhigh', 'max']);

function EffortDistribution({ rows }: { rows: EffortRow[] }) {
  const live = rows.filter((r) => r.requests > 0 || r.costUsd > 0);
  const cost = live.reduce((a, r) => a + r.costUsd, 0);
  const reqs = live.reduce((a, r) => a + r.requests, 0);
  const high = live.filter((r) => HIGH_EFFORT.has(r.effort));
  const highCost = high.reduce((a, r) => a + r.costUsd, 0);
  const highReqs = high.reduce((a, r) => a + r.requests, 0);
  const max = Math.max(...live.map((r) => r.costUsd), 0);

  return (
    <div className="chart-card">
      <h3>Effort distribution</h3>
      <p className="sub">
        {live.length === 0
          ? 'Every session request on record, grouped by the effort it was configured with.'
          : cost > 0 && reqs > 0
            ? <>
                Every session request on record, by the effort it ran at.{' '}
                <strong>xhigh and max are {pct(highCost / Math.max(cost, 1e-9))} of the spend</strong>{' '}
                from {pct(highReqs / Math.max(reqs, 1))} of the requests
                {highReqs > 0 && reqs - highReqs > 0 && <>
                  {' '}— {unit(highCost / highReqs)} a request against{' '}
                  {unit((cost - highCost) / Math.max(1, reqs - highReqs))} everywhere else
                </>}.
              </>
            : 'Every session request on record, by the effort it ran at.'}
      </p>

      {live.length === 0 ? (
        <div className="chart-empty">
          <p>No session requests on record yet.</p>
          <p className="ins-zero-sub">
            Effort is read off the agent's own telemetry, so it appears once a session has made its
            first API call. Runs from before the field existed are grouped as <code>default</code>.
          </p>
        </div>
      ) : (
        <>
          <div className="ins-bars">
            {live.map((r) => (
              <div key={r.effort}>
                <div className="ins-barhead">
                  <span className="mono">
                    {r.effort}
                    {HIGH_EFFORT.has(r.effort) && <span className="ins-tag">high effort</span>}
                  </span>
                  <span className="mono ins-dim ins-num">
                    {cents(r.costUsd)} · {num(r.requests)} requests
                  </span>
                </div>
                <div className="ins-track" title={`${r.effort}: ${cents(r.costUsd)} over ${num(r.requests)} requests`}>
                  <div className="ins-fill"
                       style={{ width: `${max > 0 ? Math.max(1, (r.costUsd / max) * 100) : 1}%`,
                                background: SERIES[0] }} />
                </div>
              </div>
            ))}
          </div>

          <table className="viz-table">
            <thead>
              <tr>
                <th>Effort</th>
                <th className="ins-th-r">Requests</th>
                <th className="ins-th-r">Spend</th>
                <th className="ins-th-r">Per request</th>
                <th className="ins-th-r">Share of spend</th>
              </tr>
            </thead>
            <tbody>
              {live.map((r) => (
                <tr key={r.effort}>
                  <td className="mono">{r.effort}</td>
                  <td className="n">{num(r.requests)}</td>
                  <td className="n">{cents(r.costUsd)}</td>
                  <td className="n">{r.requests > 0 ? unit(r.costUsd / r.requests) : '—'}</td>
                  <td className="n ins-dim">{cost > 0 ? pct(r.costUsd / cost, 1) : '—'}</td>
                </tr>
              ))}
              <tr>
                <td><strong>All effort levels</strong></td>
                <td className="n"><strong>{num(reqs)}</strong></td>
                <td className="n"><strong>{cents(cost)}</strong></td>
                <td className="n">{reqs > 0 ? unit(cost / reqs) : '—'}</td>
                <td className="n ins-dim">100.0%</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      <Meters of={['cli']} extra={
        <span>
          Sessions only — a batch run carries its effort in its config, not in this stream, so
          nothing here is mixed with Wanigan-priced spend.
        </span>
      } />
    </div>
  );
}

/* ── 3 · unified cache rate ───────────────────────────────────────────── */

const CACHE_LABEL: Record<string, { label: string; color: string; meter: MeterKey }> = {
  sessions: { label: 'Sessions', color: SERIES[0], meter: 'cli' },
  batches:  { label: 'Batches',  color: SERIES[1], meter: 'wanigan' },
  headless: { label: 'Headless', color: SERIES[2], meter: 'cli' },
};

function UnifiedCache({ rows }: { rows: CacheRow[] }) {
  const read = rows.reduce((a, r) => a + r.read, 0);
  const write = rows.reduce((a, r) => a + r.write, 0);
  const input = rows.reduce((a, r) => a + r.input, 0);
  const all = read + write + input;
  const unified = all > 0 ? read / all : 0;

  // The notes are per surface but repeat across surfaces sharing a meter.
  // Rendering each one once, naming the surfaces it covers, keeps every word on
  // screen without printing the same paragraph three times.
  const noteGroups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.note) continue;
      const label = CACHE_LABEL[r.surface]?.label ?? r.surface;
      m.set(r.note, [...(m.get(r.note) ?? []), label]);
    }
    return [...m].map(([note, surfaces]) => ({ note, surfaces }));
  }, [rows]);

  return (
    <div className="chart-card">
      <h3>Unified cache rate</h3>
      <p className="sub">
        Cached reads as a share of <strong>all</strong> input-side tokens — reads + writes +
        uncached input — which is the share of the input bill that arrived cheap. Deliberately not
        reads ÷ (reads + writes): that ratio ignores uncached input entirely and reads high on a run
        that barely cached anything. The batch card further down uses the narrower definition, so
        the two numbers answer different questions and will not match.
      </p>

      {all === 0 ? (
        <div className="chart-empty">
          <p>No cached tokens on record on any surface.</p>
          <p className="ins-zero-sub">
            Mark a system block as cached in the batch builder, or keep a long-lived session on one
            repo, and the shared prefix is billed once at a tenth of the input rate instead of on
            every turn.
          </p>
        </div>
      ) : (
        <>
          <div className="ins-hero-row">
            <div className="hero">{pct(unified)}</div>
            <div className="hero-sub">
              across all three surfaces · {num(read)} tokens read from cache, {num(write)} written,
              {' '}{num(input)} paid for as uncached input
            </div>
          </div>

          <div className="ins-bars">
            {rows.map((r) => {
              const spec = CACHE_LABEL[r.surface] ?? { label: r.surface, color: SERIES[3], meter: 'cli' as MeterKey };
              const total = r.read + r.write + r.input;
              return (
                <div key={r.surface}>
                  <div className="ins-barhead">
                    <span>{spec.label}</span>
                    <span className="mono ins-dim ins-num">
                      {total > 0 ? `${pct(r.rate, 1)} of ${num(total)} tokens` : 'no tokens on record'}
                    </span>
                  </div>
                  <div className="ins-track"
                       title={`${spec.label}: ${pct(r.rate, 1)} cached reads of ${num(total)} input-side tokens`}>
                    <div className="ins-fill"
                         style={{ width: `${total > 0 ? Math.max(1, r.rate * 100) : 0}%`,
                                  background: SERIES[0] }} />
                  </div>
                </div>
              );
            })}
          </div>

          <table className="viz-table">
            <thead>
              <tr>
                <th>Surface</th>
                <th className="ins-th-r">Cache read (tokens)</th>
                <th className="ins-th-r">Cache write (tokens)</th>
                <th className="ins-th-r">Uncached input (tokens)</th>
                <th className="ins-th-r">Rate</th>
                <th>Meter</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const spec = CACHE_LABEL[r.surface] ?? { label: r.surface, meter: 'cli' as MeterKey };
                const total = r.read + r.write + r.input;
                return (
                  <tr key={r.surface}>
                    <td>{spec.label}</td>
                    <td className="n">{num(r.read)}</td>
                    <td className="n">{num(r.write)}</td>
                    <td className="n">{num(r.input)}</td>
                    <td className="n">{total > 0 ? pct(r.rate, 1) : '—'}</td>
                    <td className="ins-dim">{METER[spec.meter].glyph} {METER[spec.meter].word}</td>
                  </tr>
                );
              })}
              <tr>
                <td><strong>Unified</strong></td>
                <td className="n"><strong>{num(read)}</strong></td>
                <td className="n"><strong>{num(write)}</strong></td>
                <td className="n"><strong>{num(input)}</strong></td>
                <td className="n"><strong>{pct(unified, 1)}</strong></td>
                <td className="ins-dim">mixed</td>
              </tr>
            </tbody>
          </table>
        </>
      )}

      {noteGroups.map((g) => (
        <p key={g.note} className="ins-note">
          <strong>{g.surfaces.join(' and ')}:</strong> {g.note}
        </p>
      ))}

      <Meters of={['cli', 'wanigan']} />
    </div>
  );
}

/* ── 5 · budgets ──────────────────────────────────────────────────────── */

function Budgets({ buds, projects, onSaved }: {
  buds: BudgetState[]; projects: Project[]; onSaved: (next: BudgetState[]) => void;
}) {
  const [editing, setEditing] = useState<string | null | undefined>(undefined);

  return (
    <div className="chart-card">
      <div className="ins-cardhead">
        <div>
          <h3>Budgets</h3>
          <p className="sub">
            Month to date against the cap, and where the month lands if the rest of it looks like the
            part already spent. The projection is spend ÷ days elapsed × days in month, with today
            counted as a whole day — a run rate, not a forecast, and noisy in the first days of a
            month. Each meter is split by instrument: the session half is the CLI's number, the
            batch half is Wanigan's arithmetic.
          </p>
        </div>
        <button className="btn ins-btn" onClick={() => setEditing((v) => (v === undefined ? null : undefined))}>
          {editing === undefined ? 'Set a budget' : 'Close'}
        </button>
      </div>

      {editing !== undefined && (
        <BudgetEditor key={String(editing)} projects={projects} buds={buds} scope={editing}
                      onSaved={(next) => { onSaved(next); setEditing(undefined); }}
                      onCancel={() => setEditing(undefined)} />
      )}

      {buds.length === 0 ? (
        <div className="chart-empty">
          <p>No budgets set yet.</p>
          <p className="ins-zero-sub">
            A budget is one number per scope: a monthly ceiling, and the share of it at which Wanigan
            starts saying something. Press <strong>Set a budget</strong> above, pick{' '}
            <em>All projects</em> for a single ceiling over everything, or one repo to cap it on its
            own.
          </p>
        </div>
      ) : (
        <>
          <div className="ins-budgets">
            {buds.map((b) => (
              <BudgetMeter key={b.scopeId ?? '*'} b={b} onEdit={() => setEditing(b.scopeId)} />
            ))}
          </div>

          <div className="ins-scroll">
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Scope</th>
                  <th className="ins-th-r">Cap</th>
                  <th className="ins-th-r">Sessions {METER.cli.glyph}</th>
                  <th className="ins-th-r">Batches {METER.wanigan.glyph}</th>
                  <th className="ins-th-r">Spent</th>
                  <th className="ins-th-r">Used</th>
                  <th className="ins-th-r">Projected</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {buds.map((b) => {
                  const m = budgetMark(b);
                  return (
                    <tr key={b.scopeId ?? '*'}>
                      <td className="trunc">{b.scopeName}</td>
                      <td className="n">{b.monthlyUsd > 0 ? cents(b.monthlyUsd) : '—'}</td>
                      <td className="n">{cents(b.sessionUsd)}</td>
                      <td className="n">{cents(b.batchUsd)}</td>
                      <td className="n">{cents(b.spentUsd)}</td>
                      <td className="n">{b.monthlyUsd > 0 ? pct(b.spentUsd / b.monthlyUsd) : '—'}</td>
                      <td className="n">{cents(b.projectedUsd)}</td>
                      <td>
                        <span aria-hidden="true" style={{ color: m.fg, fontWeight: 700, marginRight: 6 }}>
                          {m.glyph}
                        </span>
                        {m.word}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <p className="ins-note">
            There is deliberately no total row: the scopes overlap, so a repo's spend also counts
            against <em>All projects</em> and adding the columns up would double-count it. Read each
            row on its own.
          </p>
        </>
      )}

      <Meters of={['cli', 'wanigan']} extra={
        <span>Headless spend sits with sessions: both figures come from the CLI's own accounting.</span>
      } />
    </div>
  );
}

function BudgetMeter({ b, onEdit }: { b: BudgetState; onEdit: () => void }) {
  const m = budgetMark(b);
  const cap = b.monthlyUsd;
  const share = (v: number) => (cap > 0 ? Math.max(0, Math.min(100, (v / cap) * 100)) : 0);
  const sessionW = share(b.sessionUsd);
  const batchW = Math.min(share(b.batchUsd), 100 - sessionW);
  const projected = cap > 0 ? (b.projectedUsd / cap) * 100 : 0;
  const remaining = cap - b.spentUsd;

  return (
    <div className="sunk ins-budget">
      <div className="ins-budget-head">
        <span className="ins-budget-name trunc" title={b.scopeName}>{b.scopeName}</span>
        <MarkPill m={m} />
        <button className="ins-inline ins-budget-edit" onClick={onEdit}
                aria-label={`Edit the budget for ${b.scopeName}`}>
          Edit
        </button>
      </div>

      {cap > 0 ? (
        <>
          <div className="ins-meter" role="img"
               aria-label={`${b.scopeName}: ${cents(b.spentUsd)} of ${cents(cap)} spent, ${
                 pct(b.spentUsd / cap)}, warning at ${pct(b.warnAt)}, projecting ${cents(b.projectedUsd)}`}>
            <div className="ins-meter-track">
              {sessionW > 0 && (
                <div className="ins-meter-seg"
                     style={{ width: `${sessionW}%`, background: SERIES[0] }}
                     title={`Sessions + headless ${cents(b.sessionUsd)} — CLI meter`} />
              )}
              {batchW > 0 && (
                <div className="ins-meter-seg"
                     style={{ width: `${batchW}%`, background: SERIES[1] }}
                     title={`Batches ${cents(b.batchUsd)} — Wanigan meter`} />
              )}
            </div>
            <div className="ins-meter-warn" style={{ left: `${Math.min(100, b.warnAt * 100)}%` }}
                 title={`Warning threshold at ${pct(b.warnAt)} of the cap`} />
            <div className="ins-meter-proj"
                 style={{ left: `${Math.max(0, Math.min(100, projected))}%` }}
                 title={`Projected month end ${cents(b.projectedUsd)}`}>
              <span aria-hidden="true">▲</span>
            </div>
          </div>

          <div className="ins-budget-legend">
            <span>
              <strong className="ins-num">{cents(b.spentUsd)}</strong> of {cents(cap)} ·{' '}
              {pct(b.spentUsd / cap)} used
            </span>
            <span className={remaining < 0 ? 'ins-over' : 'ins-dim'}>
              {remaining >= 0 ? `${cents(remaining)} left` : `${cents(-remaining)} over`}
            </span>
          </div>
          <div className="ins-budget-foot">
            <span>▲ Projecting <strong className="ins-num">{cents(b.projectedUsd)}</strong> by month end</span>
            <span className="faint">
              day {b.daysElapsed} of {b.daysInMonth} · warn at {pct(b.warnAt)}
              {projected > 100 ? ' · projection is off the end of the bar' : ''}
            </span>
          </div>
        </>
      ) : (
        <div className="ins-budget-nocap">
          <div className="ins-meter-track ins-meter-flat">
            <div className="ins-meter-seg" style={{ width: '100%', background: 'var(--bg)' }} />
          </div>
          <p className="faint">
            Tracked but uncapped: <strong className="ins-num">{cents(b.spentUsd)}</strong> spent this
            month ({cents(b.sessionUsd)} sessions + headless, {cents(b.batchUsd)} batches),
            projecting {cents(b.projectedUsd)}. Nothing can breach a cap of zero — set one to be
            warned.
          </p>
        </div>
      )}
    </div>
  );
}

/** One form for both "set" and "edit"; the scope select decides which it is. */
function BudgetEditor({ projects, buds, scope, onSaved, onCancel }: {
  projects: Project[]; buds: BudgetState[];
  scope?: string | null;
  onSaved: (next: BudgetState[]) => void;
  onCancel?: () => void;
}) {
  const uid = useId();
  const [scopeId, setScopeId] = useState<string>(scope === undefined || scope === null ? '' : scope);
  const existing = buds.find((b) => (b.scopeId ?? '') === scopeId);
  const [monthly, setMonthly] = useState<string>(existing ? String(existing.monthlyUsd) : '');
  const [warn, setWarn] = useState<string>(existing ? String(Math.round(existing.warnAt * 100)) : '80');
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Switching scope re-reads that scope's current numbers, so the form never
  // shows one project's cap under another project's name.
  const pick = (next: string) => {
    setScopeId(next);
    const b = buds.find((x) => (x.scopeId ?? '') === next);
    setMonthly(b ? String(b.monthlyUsd) : '');
    setWarn(b ? String(Math.round(b.warnAt * 100)) : '80');
    setErr(null);
  };

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      const amount = Number(monthly);
      const w = Number(warn);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(
          `A monthly budget is a number of dollars, zero or more — "${monthly}" is not one. ` +
          'Enter 0 to keep tracking this scope without capping it.',
        );
      }
      if (!Number.isFinite(w) || w <= 0 || w > 100) {
        throw new Error(
          `The warning threshold is a percentage above 0 and at most 100 — "${warn}" is not one. ` +
          'Enter 80 to be warned at 80% of the cap.',
        );
      }
      const next = await window.wanigan.budgets.set(scopeId === '' ? null : scopeId, amount, w / 100);
      onSaved(next);
    } catch (e) {
      setErr(msg(e));
    } finally {
      setSaving(false);
    }
  }

  const named = scopeId === '' ? 'All projects' : (projects.find((p) => p.id === scopeId)?.name ?? scopeId);

  return (
    <div className="sunk ins-editor">
      <div className="ins-editor-row">
        <label className="ins-field">
          <span className="label" id={`${uid}-scope`}>Scope</span>
          <select className="field" value={scopeId} aria-labelledby={`${uid}-scope`}
                  onChange={(e) => pick(e.target.value)}>
            <option value="">All projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            {/* A budget can outlive the project it was set on. */}
            {buds
              .filter((b) => b.scopeId && !projects.some((p) => p.id === b.scopeId))
              .map((b) => (
                <option key={b.scopeId} value={b.scopeId ?? ''}>{b.scopeName} (removed)</option>
              ))}
          </select>
        </label>

        <label className="ins-field ins-field-sm">
          <span className="label" id={`${uid}-cap`}>Monthly cap (USD)</span>
          <input className="field" type="number" min="0" step="1" inputMode="decimal"
                 aria-labelledby={`${uid}-cap`} placeholder="0"
                 value={monthly} onChange={(e) => setMonthly(e.target.value)} />
        </label>

        <label className="ins-field ins-field-sm">
          <span className="label" id={`${uid}-warn`}>Warn at (%)</span>
          <input className="field" type="number" min="1" max="100" step="1" inputMode="numeric"
                 aria-labelledby={`${uid}-warn`}
                 value={warn} onChange={(e) => setWarn(e.target.value)} />
        </label>

        <div className="ins-editor-actions">
          <button className="btn btn-primary ins-btn" disabled={saving} onClick={() => void save()}>
            {saving ? 'Saving…' : existing ? 'Update' : 'Set budget'}
          </button>
          {onCancel && (
            <button className="btn ins-btn" onClick={onCancel} disabled={saving}>Cancel</button>
          )}
        </div>
      </div>

      <p className="faint ins-editor-hint">
        {existing
          ? <>Updating the cap for <strong>{named}</strong>, currently {cents(existing.monthlyUsd)} with{' '}
             {cents(existing.spentUsd)} spent this month.</>
          : <>Setting a new cap for <strong>{named}</strong>. A cap of 0 tracks the scope without
             capping it. Scopes overlap on purpose: spend in a repo also counts against{' '}
             <em>All projects</em>.</>}
      </p>

      {err && (
        <Note tone="error">
          <strong>Budget not saved.</strong> {err}
        </Note>
      )}
    </div>
  );
}

/* ── 6 · reconciliation ───────────────────────────────────────────────── */

function Reconcile() {
  const uid = useId();
  const now = new Date();
  const [from, setFrom] = useState(isoDate(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(isoDate(now));
  const [res, setRes] = useState<Reconciliation | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      // The main process filters the window as [from, to), so an inclusive "to"
      // in the UI has to hand it the following midnight or today's spend falls
      // out of a window a person believes includes today.
      const [y, m, d] = to.split('-').map(Number);
      const endExclusive = y && m && d ? isoDate(new Date(y, m - 1, d + 1)) : to;
      setRes(await window.wanigan.budgets.reconcile(from, endExclusive));
    } catch (e) {
      setErr(msg(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  }

  const reconciled = !!res && res.reportedUsd > 0;
  const mark: Mark = !res
    ? { glyph: '·', word: 'Not run', fg: 'var(--text-faint)', bg: 'var(--bg-sunk)' }
    : reconciled
      ? { glyph: '✓', word: 'Reconciled', fg: 'var(--good)', bg: 'var(--good-soft)' }
      : { glyph: '◦', word: 'Local figures only', fg: 'var(--text-dim)', bg: 'var(--bg-sunk)' };

  const max = res ? Math.max(...res.byModel.map((r) => Math.max(r.localUsd, r.reportedUsd)), 0) : 0;

  return (
    <div className="chart-card">
      <div className="ins-cardhead">
        <div>
          <h3>Reconciliation</h3>
          <p className="sub">
            Wanigan's own batch arithmetic against what the organisation was actually billed, for one
            window. Only batch runs are compared: session and headless costs come from the CLI and
            are already the biller's number, so reconciling those would be comparing a figure to
            itself and calling the agreement a result. The window is handled in UTC, because the
            Admin API snaps its buckets to UTC days.
          </p>
        </div>
        <MarkPill m={mark} />
      </div>

      <div className="ins-editor-row ins-recon-row">
        <label className="ins-field ins-field-sm">
          <span className="label" id={`${uid}-from`}>From</span>
          <input className="field" type="date" value={from} aria-labelledby={`${uid}-from`}
                 onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="ins-field ins-field-sm">
          <span className="label" id={`${uid}-to`}>To (inclusive)</span>
          <input className="field" type="date" value={to} aria-labelledby={`${uid}-to`}
                 onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="ins-editor-actions">
          <button className="btn btn-primary ins-btn" disabled={busy} onClick={() => void run()}>
            {busy ? 'Asking the Admin API…' : 'Reconcile'}
          </button>
        </div>
      </div>

      {err && (
        <Note tone="error">
          <strong>Reconciliation failed.</strong> {err}
          <div style={{ marginTop: 6 }}>
            Check the dates read as a window (the end must be after the start), then try again. If
            the call reached the Admin API and was refused, the key in{' '}
            <code>ANTHROPIC_ADMIN_KEY</code> is the thing to check — it is a different credential
            from the one Wanigan sends batches with.
          </div>
        </Note>
      )}

      {!res && !err && (
        <div className="chart-empty">
          <p>Not run for this window yet.</p>
          <p className="ins-zero-sub">
            Press <strong>Reconcile</strong> to compare Wanigan's batch figures with the
            organisation's actual charges. Without an Admin API key it still runs and shows
            Wanigan's own side — that is a normal result, not a failure.
          </p>
        </div>
      )}

      {res && (
        <>
          <div className="stat-grid">
            <Stat label={`Wanigan ${METER.wanigan.glyph}`} value={cents(res.localUsd)}
                  sub="computed from the local batch pricing table" />
            <Stat label="Reported by the API" value={reconciled ? cents(res.reportedUsd) : '—'}
                  sub={reconciled ? "the organisation's actual charges" : 'no admin key — nothing reported'} />
            <Stat label="Delta" value={reconciled ? cents(res.deltaUsd) : '—'}
                  sub={reconciled ? 'Wanigan minus reported' : 'needs both sides to mean anything'} />
            <Stat label="Agreement" value={reconciled ? pct(res.accuracy, 1) : '—'}
                  sub={`window ${res.from.slice(0, 10)} → ${res.to.slice(0, 10)}, end exclusive`} />
          </div>

          {res.note && (
            <Note tone="info">
              <strong>{reconciled ? 'What these figures cover.' : 'Why there is only one column.'}</strong>{' '}
              {res.note}
            </Note>
          )}

          {res.byModel.length === 0 ? (
            <div className="chart-empty">
              <p>No batch runs were booked in this window.</p>
              <p className="ins-zero-sub">
                A run is booked on the day it finished, not the day it was submitted. Widen the
                window, or reconcile a month in which a run completed.
              </p>
            </div>
          ) : (
            <>
              <div className="ins-bars">
                {res.byModel.map((r) => (
                  <div key={r.model}>
                    <div className="ins-barhead">
                      <span className="mono trunc">{r.model}</span>
                      <span className="mono ins-dim ins-num">
                        {cents(r.localUsd)}{reconciled ? ` vs ${cents(r.reportedUsd)}` : ''}
                      </span>
                    </div>
                    <div className="ins-pair">
                      <div className="ins-track" title={`Wanigan: ${cents(r.localUsd)}`}>
                        <div className="ins-fill"
                             style={{ width: `${max > 0 ? Math.max(1, (r.localUsd / max) * 100) : 1}%`,
                                      background: SERIES[0] }} />
                      </div>
                      {reconciled && (
                        <div className="ins-track" title={`Reported: ${cents(r.reportedUsd)}`}>
                          <div className="ins-fill"
                               style={{ width: `${max > 0 ? Math.max(1, (r.reportedUsd / max) * 100) : 1}%`,
                                        background: SERIES[1] }} />
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="legend">
                <span className="legend-item">
                  <span className="legend-swatch" style={{ background: SERIES[0] }} />
                  Wanigan {METER.wanigan.glyph}
                </span>
                {reconciled && (
                  <span className="legend-item">
                    <span className="legend-swatch" style={{ background: SERIES[1] }} />
                    Reported by the Admin API
                  </span>
                )}
              </div>

              <div className="ins-scroll">
                <table className="viz-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="ins-th-r">Wanigan {METER.wanigan.glyph}</th>
                      <th className="ins-th-r">Reported</th>
                      <th className="ins-th-r">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.byModel.map((r) => (
                      <tr key={r.model}>
                        <td className="mono trunc">{r.model}</td>
                        <td className="n">{cents(r.localUsd)}</td>
                        <td className="n">{reconciled ? cents(r.reportedUsd) : '—'}</td>
                        <td className="n">{reconciled ? cents(r.localUsd - r.reportedUsd) : '—'}</td>
                      </tr>
                    ))}
                    <tr>
                      <td><strong>All models</strong></td>
                      <td className="n"><strong>{cents(res.localUsd)}</strong></td>
                      <td className="n">{reconciled ? cents(res.reportedUsd) : '—'}</td>
                      <td className="n">{reconciled ? cents(res.deltaUsd) : '—'}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}

      <Meters of={['wanigan']} extra={
        <span>
          The reported column is the organisation's whole bill for the window, including work
          Wanigan never ran — a delta is not by itself an error in Wanigan.
        </span>
      } />
    </div>
  );
}

/* ── estimator accuracy ───────────────────────────────────────────────── */

function EstimateAccuracy({ rows }: { rows: AccuracyRow[] }) {
  const est = rows.reduce((a, r) => a + r.estUsd, 0);
  const act = rows.reduce((a, r) => a + r.actualUsd, 0);
  const max = Math.max(...rows.map((r) => Math.max(r.estUsd, r.actualUsd)), 0);

  const ratioMark = (ratio: number): Mark => {
    if (ratio > 1.15) return { glyph: '▲', word: 'over', fg: 'var(--serious)', bg: 'var(--serious-soft)' };
    if (ratio < 0.85) return { glyph: '▼', word: 'under', fg: 'var(--text-dim)', bg: 'var(--bg-sunk)' };
    return { glyph: '=', word: 'on target', fg: 'var(--good)', bg: 'var(--good-soft)' };
  };

  return (
    <div className="chart-card">
      <h3>Estimate against actual</h3>
      <p className="sub">
        How close the pre-flight estimate came to the finished batch run, per model. Both numbers
        come out of the <strong>same</strong> local pricing table, so this measures the token
        guess — the sampled input lengths and the assumption about output length — and says nothing
        about whether the rates themselves are right. A ratio of 1.00 here is not evidence that
        Wanigan's dollar figures are correct; the reconciliation card above is the only thing that
        tests that. Ratio is actual ÷ estimated, so above 1 means the run cost more than it promised.
      </p>

      {rows.length === 0 ? (
        <div className="chart-empty">
          <p>No finished run has an estimate to compare against yet.</p>
          <p className="ins-zero-sub">
            A run appears here once it has both a pre-flight estimate and a settled cost — that is,
            after it finishes. Estimate a batch in the builder before submitting it and the pair is
            recorded.
          </p>
        </div>
      ) : (
        <>
          <div className="ins-bars">
            {rows.map((r) => (
              <div key={r.model}>
                <div className="ins-barhead">
                  <span className="mono trunc">{r.model}</span>
                  <span className="mono ins-dim ins-num">
                    {cents(r.estUsd)} est → {cents(r.actualUsd)} actual · {r.ratio.toFixed(2)}×
                  </span>
                </div>
                <div className="ins-pair">
                  <div className="ins-track" title={`Estimated: ${cents(r.estUsd)}`}>
                    <div className="ins-fill"
                         style={{ width: `${max > 0 ? Math.max(1, (r.estUsd / max) * 100) : 1}%`,
                                  background: SERIES[0] }} />
                  </div>
                  <div className="ins-track" title={`Actual: ${cents(r.actualUsd)}`}>
                    <div className="ins-fill"
                         style={{ width: `${max > 0 ? Math.max(1, (r.actualUsd / max) * 100) : 1}%`,
                                  background: SERIES[1] }} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="legend">
            <span className="legend-item">
              <span className="legend-swatch" style={{ background: SERIES[0] }} />Estimated
            </span>
            <span className="legend-item">
              <span className="legend-swatch" style={{ background: SERIES[1] }} />Actual
            </span>
          </div>

          <div className="ins-scroll">
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="ins-th-r">Runs</th>
                  <th className="ins-th-r">Estimated</th>
                  <th className="ins-th-r">Actual</th>
                  <th className="ins-th-r">Ratio</th>
                  <th>Direction</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const m = ratioMark(r.ratio);
                  return (
                    <tr key={r.model}>
                      <td className="mono trunc">{r.model}</td>
                      <td className="n">{num(r.runs)}</td>
                      <td className="n">{cents(r.estUsd)}</td>
                      <td className="n">{cents(r.actualUsd)}</td>
                      <td className="n">{r.ratio.toFixed(2)}×</td>
                      <td>
                        <span aria-hidden="true" style={{ color: m.fg, fontWeight: 700, marginRight: 6 }}>
                          {m.glyph}
                        </span>
                        {m.word}
                      </td>
                    </tr>
                  );
                })}
                <tr>
                  <td><strong>All models</strong></td>
                  <td className="n">{num(rows.reduce((a, r) => a + r.runs, 0))}</td>
                  <td className="n"><strong>{cents(est)}</strong></td>
                  <td className="n"><strong>{cents(act)}</strong></td>
                  <td className="n">{est > 0 ? `${(act / est).toFixed(2)}×` : '—'}</td>
                  <td className="ins-dim">{est > 0 ? ratioMark(act / est).word : '—'}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </>
      )}

      <Meters of={['wanigan']} extra={
        <span>Both columns are Wanigan's arithmetic; neither has been near a bill.</span>
      } />
    </div>
  );
}

/* ── existing batch charts ────────────────────────────────────────────── */

function HeroCard({ title, hero, sub, children }: {
  title: string; hero: string; sub: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div className="chart-card">
      <h3>{title}</h3>
      <div className="hero" style={{ marginTop: 8 }}>{hero}</div>
      <div className="hero-sub">{sub}</div>
      {children}
    </div>
  );
}

/**
 * Cache economics for batch runs alone. A cached prefix costs 0.1x base input to
 * read; without the cache those tokens would have been billed at full input
 * rate. The denominator here is reads + writes, which is a narrower question
 * than the unified card asks — both are labelled so the two numbers cannot be
 * mistaken for a disagreement.
 */
function BatchCacheCard({ totals }: { totals: Record<string, number> }) {
  const cacheableTotal = (totals.cache_read ?? 0) + (totals.cache_write ?? 0);
  const hitRate = cacheableTotal > 0 ? (totals.cache_read ?? 0) / cacheableTotal : 0;
  return (
    <HeroCard
      title="Batch cache hit rate"
      hero={cacheableTotal ? `${Math.round(hitRate * 100)}%` : '—'}
      sub={cacheableTotal
        ? <>{num(totals.cache_read)} tokens read from cache at a tenth of the input rate,
             {' '}{num(totals.cache_write)} written — reads over reads + writes. Hits inside a batch
             are best-effort.</>
        : <>No cached prefix in any run yet. Mark a system block as cached in the builder
             and the shared context is billed once instead of per row.</>}
    >
      {cacheableTotal > 0 && <Gauge value={hitRate} />}
    </HeroCard>
  );
}

function Gauge({ value }: { value: number }) {
  const p = Math.max(0, Math.min(1, value));
  return (
    <div className="ins-track ins-gauge" role="img"
         aria-label={`Cache hit rate ${Math.round(p * 100)} percent`}>
      <div className="ins-fill" style={{ width: `${Math.max(1.5, p * 100)}%`, background: SERIES[2] }} />
    </div>
  );
}

/**
 * Where the tokens went, as one stacked bar. Cache reads are the interesting
 * segment: they are billed at a tenth of the input rate, so a wide aqua band is
 * the shape you want.
 */
function TokenFlow({ totals }: { totals: Record<string, number> }) {
  const parts = [
    { key: 'Input (uncached)', v: totals.in_tokens ?? 0,    c: SERIES[0] },
    { key: 'Output',           v: totals.out_tokens ?? 0,   c: SERIES[1] },
    { key: 'Cache read',       v: totals.cache_read ?? 0,   c: SERIES[2] },
    { key: 'Cache write',      v: totals.cache_write ?? 0,  c: SERIES[3] },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (!total) return null;

  return (
    <div className="chart-card">
      <h3>Token flow</h3>
      <p className="sub">
        Every token this workspace has been billed for, by kind. Cache reads cost a tenth
        of the input rate — the wider that band, the more the cached prefix is paying off.
      </p>
      <div className="ins-stack" role="img"
           aria-label={parts.map((p) => `${p.key} ${num(p.v)}`).join(', ')}>
        {parts.filter((p) => p.v > 0).map((p) => (
          <span key={p.key} style={{ flex: `${p.v} 1 0`, background: p.c }}
                title={`${p.key}: ${num(p.v)} tokens (${((p.v / total) * 100).toFixed(1)}%)`} />
        ))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.key} className="legend-item">
            <span className="legend-swatch" style={{ background: p.c }} />
            {p.key} <span className="mono ins-num">{num(p.v)}</span>
          </span>
        ))}
      </div>
      <table className="viz-table">
        <thead>
          <tr>
            <th>Token kind</th>
            <th className="ins-th-r">Tokens</th>
            <th className="ins-th-r">Share</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((p) => (
            <tr key={p.key}>
              <td>
                <span className="legend-swatch ins-swatch" style={{ background: p.c }} />
                {p.key}
              </td>
              <td className="n">{num(p.v)}</td>
              <td className="n ins-dim">{((p.v / total) * 100).toFixed(1)}%</td>
            </tr>
          ))}
          <tr>
            <td><strong>All tokens</strong></td>
            <td className="n"><strong>{num(total)}</strong></td>
            <td className="n ins-dim">100.0%</td>
          </tr>
        </tbody>
      </table>
      <Meters of={['wanigan']} />
    </div>
  );
}

/** One series, so no legend — the title names it. Bars are direct-labelled. */
function SpendByModel({ rows }: { rows: Record<string, number | string>[] }) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => Number(r.cost)));
  const total = rows.reduce((a, r) => a + Number(r.cost), 0);
  return (
    <div className="chart-card">
      <h3>Spend by model</h3>
      <p className="sub">Total billed per model across every submitted batch run.</p>
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 7 }}>
        {rows.map((r) => {
          const cost = Number(r.cost);
          const p = max > 0 ? (cost / max) * 100 : 0;
          const reqs = Number(r.requests) || 0;
          return (
            <div key={String(r.model)}>
              <div style={{ display: 'flex', fontSize: 'var(--t-small)', marginBottom: 3 }}>
                <span className="mono">{String(r.model)}</span>
                <span className="mono ins-num" style={{ marginLeft: 'auto', color: 'var(--text-dim)' }}>
                  {usd(cost)}
                  {reqs > 0 && <span style={{ color: 'var(--text-faint)' }}>
                    {'  '}· {usd((cost / reqs) * 1000)}/1k rows
                  </span>}
                </span>
              </div>
              <div style={{ height: 7, borderRadius: 'var(--r-sm)', background: 'var(--bg-sunk)', overflow: 'hidden' }}>
                <div style={{ width: `${Math.max(p, 1)}%`, height: '100%', borderRadius: 'var(--r-sm)',
                              background: 'var(--series-1)' }} />
              </div>
            </div>
          );
        })}
      </div>
      <table className="viz-table">
        <thead>
          <tr>
            <th>Model</th>
            <th className="ins-th-r">Runs</th>
            <th className="ins-th-r">Requests</th>
            <th className="ins-th-r">Spend</th>
            <th className="ins-th-r">Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r.model)}>
              <td className="mono trunc">{String(r.model)}</td>
              <td className="n">{num(Number(r.runs))}</td>
              <td className="n">{num(Number(r.requests))}</td>
              <td className="n">{cents(Number(r.cost))}</td>
              <td className="n ins-dim">{total > 0 ? pct(Number(r.cost) / total, 1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <Meters of={['wanigan']} />
    </div>
  );
}

/**
 * Outcomes are a status encoding. Green vs red is the classic CVD failure, so
 * each row carries a glyph and a word — colour is decoration here, never the
 * message.
 */
function Outcomes({ rows }: { rows: { status: string; n: number }[] }) {
  const SPEC: Record<string, { label: string; glyph: string; color: string }> = {
    succeeded: { label: 'Succeeded', glyph: '✓', color: 'var(--good)' },
    errored:   { label: 'Errored',   glyph: '✕', color: 'var(--critical)' },
    refused:   { label: 'Refused',   glyph: '⊘', color: 'var(--serious)' },
    expired:   { label: 'Expired',   glyph: '⏱', color: 'var(--warning)' },
    canceled:  { label: 'Canceled',  glyph: '⊖', color: 'var(--text-faint)' },
    pending:   { label: 'Pending',   glyph: '·', color: 'var(--text-faint)' },
  };
  const known = rows.filter((r) => r.n > 0);
  const total = known.reduce((a, r) => a + r.n, 0);
  if (!total) return null;

  const ok = known.find((r) => r.status === 'succeeded')?.n ?? 0;

  return (
    <div className="chart-card">
      <h3>Request outcomes</h3>
      <p className="sub">
        {num(ok)} of {num(total)} requests succeeded. Refusals are counted as failures, not
        successes — the API returns them as HTTP 200, so treating them as good silently drops rows.
      </p>
      <div className="ins-stack" role="img"
           aria-label={known.map((r) => `${SPEC[r.status]?.label ?? r.status} ${r.n}`).join(', ')}>
        {known.map((r) => (
          <span key={r.status} style={{ flex: `${r.n} 1 0`,
                                        background: SPEC[r.status]?.color ?? 'var(--text-faint)' }}
                title={`${SPEC[r.status]?.label ?? r.status}: ${num(r.n)}`} />
        ))}
      </div>
      <table className="viz-table">
        <thead><tr><th>Outcome</th><th className="ins-th-r">Requests</th><th className="ins-th-r">Share</th></tr></thead>
        <tbody>
          {known.map((r) => {
            const s = SPEC[r.status] ?? { label: r.status, glyph: '·', color: 'var(--text-faint)' };
            return (
              <tr key={r.status}>
                <td>
                  <span aria-hidden="true" style={{ color: s.color, marginRight: 7, fontWeight: 700 }}>{s.glyph}</span>
                  {s.label}
                </td>
                <td className="n">{num(r.n)}</td>
                <td className="n ins-dim">{((r.n / total) * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Cost per run over time. Bars are clickable — the chart is a way into a run. */
function SpendOverTime({ runs, onOpenRun }: {
  runs: Record<string, number | string>[]; onOpenRun?: (id: string) => void;
}) {
  const [ref, w] = useWidth();
  const withCost = runs.filter((r) => Number(r.cost_usd) > 0);
  if (!withCost.length) return null;
  // One run is not a trend, but it is still a run with a cost and a way into
  // it. Dropping the whole card took the table and its links with it.
  const trend = withCost.length >= 2;

  const max = Math.max(...withCost.map((r) => Number(r.cost_usd)));
  const models = [...new Set(withCost.map((r) => String(r.model)))];
  // Colour follows the model, not the bar's rank, so filtering never repaints it.
  const colorFor = (m: string) => SERIES[models.indexOf(m) % SERIES.length];

  const H = 156, PAD_T = 12, PAD_B = 26, PAD_L = 44, PAD_R = 8;
  const plotW = Math.max(60, w - PAD_L - PAD_R);
  const plotH = H - PAD_T - PAD_B;
  const top = niceMax(max);
  const step = plotW / withCost.length;
  const bw = Math.max(2, Math.min(26, step * 0.68));

  return (
    <div className="chart-card" ref={ref}>
      <h3>Cost per run</h3>
      <p className="sub">
        {trend
          ? `Oldest to newest. Hover for the run${onOpenRun ? '; click to open it' : ''}.`
          : 'One run has a settled cost so far. A cost-over-time line needs at least two, so none is drawn — the run itself is below.'}
      </p>
      {trend && (
      <svg className="chart-svg" viewBox={`0 0 ${w} ${H}`} height={H} role="img"
           aria-label="Cost per run over time">
        {[0, 1].map((f) => {
          const y = PAD_T + plotH - f * plotH;
          return (
            <g key={f}>
              <line x1={PAD_L} y1={y} x2={w - PAD_R} y2={y}
                    stroke={f === 0 ? 'var(--line)' : 'var(--grid)'} strokeWidth="1" />
              <text x={PAD_L - 8} y={y + 3.5} fontSize="10" textAnchor="end" fill="var(--text-faint)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}>{usd(top * f)}</text>
            </g>
          );
        })}
        {withCost.map((r, i) => {
          const c = Number(r.cost_usd);
          const h = Math.max(2, (c / top) * plotH);
          const x = PAD_L + i * step + (step - bw) / 2;
          return (
            <rect key={String(r.id)} x={x} y={PAD_T + plotH - h} width={bw} height={h}
                  rx={Math.min(4, bw / 2)} fill={colorFor(String(r.model))}
                  style={{ cursor: onOpenRun ? 'pointer' : undefined }}
                  onClick={() => onOpenRun?.(String(r.id))}>
              <title>{`${r.name}\n${r.model}\n${usd(c)} · ${num(Number(r.total_requests))} requests`}</title>
            </rect>
          );
        })}
        <text x={PAD_L} y={H - 8} fontSize="10" fill="var(--text-faint)">oldest</text>
        <text x={w - PAD_R} y={H - 8} fontSize="10" textAnchor="end" fill="var(--text-faint)">newest</text>
      </svg>
      )}
      {trend && models.length > 1 && (
        <div className="legend">
          {models.map((m) => (
            <span key={m} className="legend-item">
              <span className="legend-swatch" style={{ background: colorFor(m) }} />
              <span className="mono">{m}</span>
            </span>
          ))}
        </div>
      )}
      <div className="ins-scroll">
        <table className="viz-table">
          <thead>
            <tr>
              <th>Run</th>
              <th>Model</th>
              <th className="ins-th-r">Requests</th>
              <th className="ins-th-r">Cost</th>
            </tr>
          </thead>
          <tbody>
            {withCost.map((r) => (
              <tr key={String(r.id)}>
                <td className="trunc">
                  {onOpenRun
                    ? <button className="ins-inline" onClick={() => onOpenRun(String(r.id))}>
                        {String(r.name)}
                      </button>
                    : String(r.name)}
                </td>
                <td className="mono trunc">{String(r.model)}</td>
                <td className="n">{num(Number(r.total_requests))}</td>
                <td className="n">{cents(Number(r.cost_usd))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Meters of={['wanigan']} />
    </div>
  );
}

/* ── styles ───────────────────────────────────────────────────────────────
   This view has no feature stylesheet of its own and index.css belongs to the
   shell, so the rules live here, scoped to .insights .ins-how > summary { cursor: pointer; color: var(--text-faint); font-size: var(--t-micro); margin-top: 4px; }
.insights .ins-how > summary:hover { color: var(--text); }
.insights .ins-how > p { margin-top: 4px; color: var(--text-faint); font-size: var(--t-micro); line-height: 1.5; }
.insights and hoisted once by React.
   Not one colour is declared — every value is a token from index.css.
   ───────────────────────────────────────────────────────────────────────── */
