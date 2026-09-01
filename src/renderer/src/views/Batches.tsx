import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type {
  CacheTtl, EvalPair, EvalRowDiff, GoldenSet, Project, RunConfig, SourceConfig, UploadedFile,
} from '@shared/types';
import { estimateTokens } from '@shared/tokens';
import { Pill, Bar, Stat, Note, Section, num, usd, ago, until } from '../components/bits';

type Preset = { id: string; label: string; blurb: string; config: Omit<RunConfig, 'name'> };
type Model = {
  id: string; label: string; maxTokens: number; maxInputTokens: number | null;
  batchInput: number | null; batchOutput: number | null; pricingKnown: boolean;
  extendedOutput: boolean; supportsStructuredOutputs: boolean;
  efforts: string[]; thinkingAdaptive: boolean;
};
type Run = {
  id: string; name: string; preset: string | null; model: string; status: string;
  total_requests: number; succeeded: number; failed: number; pending: number;
  est_cost_usd: number; cost_usd: number; created_at: number; ended_at: number | null;
  expires_at: number | null; parent_run_id: string | null; project_name: string | null;
};

/** Which tab of the run detail is open. Refusals appears only when there are any. */
type DetailTab = 'results' | 'refusals' | 'evals' | 'batches' | 'events' | 'config';

/** A rescue run, as refusal.children() reports it. */
type RescueChild = { id: string; name: string; status: string; model: string };

/**
 * `upload` is additive on the main-process side: sources.ts reads it
 * defensively off the object so a source saved before uploads existed behaves
 * exactly as it did, which is why it is not a field of SourceConfig. Naming it
 * once here beats casting at every call site.
 */
type UploadableSource = SourceConfig & { upload?: boolean };

/**
 * Categorical slots in fixed order, exactly as Insights assigns them. The order
 * IS the colourblind-safety mechanism — reordering to suit meaning puts yellow
 * beside orange and the pair fails both separation floors.
 */
const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Units, always. "412 KB" reads; "421888" is a puzzle. */
function bytesLabel(n: number): string {
  if (n < 1024) return `${num(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * Per-row costs live in fractions of a cent, and usd() floors at "<$0.01" —
 * which would render an entire A-versus-B cost column as the same three
 * characters, hiding the one number the comparison is for.
 */
function usdFine(n: number): string {
  if (!n) return '$0';
  if (n >= 0.01) return usd(n);
  return `$${n.toFixed(4)}`;
}

const usdDelta = (n: number) => (Math.abs(n) < 0.00005 ? 'no change' : `${n > 0 ? '+' : '\u2212'}${usdFine(Math.abs(n))}`);

const pctLabel = (n: number) => `${(n * 100).toFixed(n >= 0.1 ? 0 : 1)}%`;

/**
 * A priced figure nobody has been billed for yet.
 *
 * One grammar for the whole surface: an estimate carries a tilde on the value
 * and the word "est." beside it; an amount the API actually charged renders
 * plain. The number that decides whether to spend money is the last one that
 * may look like a measurement, so the mark is applied at every site rather than
 * only where the label happens to say "Est.".
 */
const usdEst = (n: number) => `~${usd(n)}`;

/**
 * JSON out of SQLite, pretty-printed without letting one bad row take the
 * window with it.
 *
 * `row_json` is whatever the dataset loader wrote: a truncated write, a
 * hand-edited database, or a row stored by a Wanigan old enough to have used a
 * different shape all throw here. This runs inside render, and an exception in
 * render unmounts the pane \u2014 a white screen over a live PTY, for a drawer whose
 * whole job is to show what a request actually contained. So a parse failure
 * degrades to the stored bytes verbatim, and says that it did.
 */
function parseStored(text: string | null | undefined): { ok: boolean; text: string } {
  if (!text) return { ok: true, text: '\u2014' };
  try { return { ok: true, text: JSON.stringify(JSON.parse(text), null, 2) }; }
  catch { return { ok: false, text }; }
}

/**
 * How many run rows are painted before the list says it stopped.
 *
 * No list in this app is virtualized and none is about to be: pulling a
 * windowing library in for one table is a worse trade than drawing fewer rows
 * and being honest about it, the way the Git diff viewer already is.
 */
const RUN_ROWS = 60;

/** Same guard for the per-batch counts map, which has a usable empty fallback. */
function parseCounts(text: string | null | undefined): Record<string, number> {
  if (!text) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, number>;
  } catch { return {}; }
}

/**
 * The batch-depth phases have no feature stylesheet of their own and index.css
 * belongs to the shell, so the rules ride with the surface. Namespaced `bx-`
 * so a sibling sheet cannot collide, and every colour is a token — none is
 * declared here.
 */
const BATCH_CSS = `
.bx-lane { display: flex; flex-direction: column; gap: 12px; min-width: 0; }

/* index.css styles :focus on .field only, and most of this surface is buttons,
   checkboxes and selects. A keyboard user has to be able to see where they are. */
.bx-lane :focus-visible,
.bx-f:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
.bx-lane .field:focus-visible, .field.bx-f:focus-visible { outline-offset: -1px; }

/* Wide content scrolls inside its own box; the page body never moves sideways. */
.bx-scroll { overflow-x: auto; }
.bx-scroll > table { min-width: 540px; }

.bx-num { font-variant-numeric: tabular-nums; }

.bx-ab { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
@media (max-width: 940px) { .bx-ab { grid-template-columns: minmax(0, 1fr); } }

.bx-out {
  margin: 0; padding: 8px 10px; max-height: 210px; overflow: auto;
  white-space: pre-wrap; overflow-wrap: anywhere;
  font-family: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace;
  font-size: 11.5px; line-height: 1.5; color: var(--text-dim);
}

.bx-swatch { display: inline-block; width: 9px; height: 9px; border-radius: 2px; flex: none; }

/* Empty, loading, zero-results and error all land here, and each says a
   different thing — the shared box only makes them look like siblings. */
.bx-state { padding: 24px 18px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 9px; }
.bx-state h4 { font-size: 13px; font-weight: 600; }
.bx-state p { font-size: 12.5px; color: var(--text-dim); line-height: 1.55; max-width: 60ch; }
`;

function BatchStyles() {
  return <style>{BATCH_CSS}</style>;
}

export default function Batches({ projects, hasKey, onNeedKey, seed, onSeedConsumed }: {
  projects: Project[]; hasKey: boolean; onNeedKey: () => void;
  seed?: { projectId: string; root: string; paths: string[] } | null;
  onSeedConsumed?: () => void;
}) {
  const [view, setView] = useState<{ page: 'list' } | { page: 'new' } | { page: 'detail'; id: string }>({ page: 'list' });

  // A session handing over its changed files opens the builder directly.
  useEffect(() => { if (seed) setView({ page: 'new' }); }, [seed]);
  const page =
    view.page === 'new'
      ? <NewRun projects={projects} hasKey={hasKey} onNeedKey={onNeedKey}
                seed={seed} onSeedConsumed={onSeedConsumed}
                onDone={(id) => setView({ page: 'detail', id })} onCancel={() => setView({ page: 'list' })} />
      : view.page === 'detail'
        ? <RunDetail id={view.id} onBack={() => setView({ page: 'list' })}
                     onOpen={(id) => setView({ page: 'detail', id })} />
        : <RunList onNew={() => setView({ page: 'new' })} onOpen={(id) => setView({ page: 'detail', id })} />;

  // A <style> element is display:none, so it costs the flex layout nothing.
  return <><BatchStyles />{page}</>;
}

/* ── list ─────────────────────────────────────────────────────────────── */

function RunList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * A failed read is not an empty workspace. Swallowing the rejection sent
   * every failure to the "No runs yet" onboarding state, which invites you to
   * build your first batch over the top of runs the database still holds.
   */
  const [err, setErr] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async () => {
    try { setRuns((await window.wanigan.batch.runs()) as Run[]); setErr(null); }
    catch (e) { setErr(msg(e)); }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const off = window.wanigan.on.batchChanged(() => void load());
    const t = setInterval(load, 8000);
    return () => { off(); clearInterval(t); };
  }, [load]);

  const active = runs.filter((r) => ['in_progress', 'submitting', 'canceling'].includes(r.status));
  const spent = runs.reduce((a, r) => a + (r.cost_usd || 0), 0);
  // Main returns up to 200 runs and every row draws a progress bar, so the
  // whole table re-lays out on an eight-second beat. Cut what is painted, say
  // so, and keep the way through — the counters above still total all 200.
  const listed = expanded ? runs : runs.slice(0, RUN_ROWS);
  const hiddenRuns = runs.length - listed.length;

  const head = (
    <div className="pane-head">
      <div>
        <h1>Batches</h1>
        <p className="dim">Bulk work across your repos, asynchronous, at half price.</p>
      </div>
      <button className="btn btn-primary" onClick={onNew}>New run</button>
    </div>
  );

  // Nothing was counted, so nothing is totalled: the stats and the onboarding
  // empty state below would both be claims about a database Wanigan could not read.
  if (err && !runs.length) {
    return (
      <div className="pane">
        {head}
        <div className="card bx-state">
          <h4>Could not read your runs</h4>
          <p>{err}</p>
          <p>
            This is a failed read, not an empty workspace. Runs already submitted are untouched, and
            none of them are counted above because none of them were seen.
          </p>
          <button className="btn" onClick={() => { setLoading(true); void load(); }}>Try again</button>
        </div>
      </div>
    );
  }

  return (
    <div className="pane">
      {head}

      {err && (
        <Note tone="warn">
          <strong>Last refresh failed.</strong> {err} The runs below are from the previous read, so
          their progress and cost may have moved since.{' '}
          <button className="bx-f" style={{ textDecoration: 'underline' }} onClick={() => void load()}>Retry</button>
        </Note>
      )}

      <div className="stat-grid">
        <Stat label="Runs" value={num(runs.length)} />
        <Stat label="Active" value={num(active.length)} tone={active.length ? 'var(--accent)' : undefined}
              sub={active.reduce((a, r) => a + r.pending, 0) ? `${num(active.reduce((a, r) => a + r.pending, 0))} in flight` : 'nothing in flight'} />
        <Stat label="Spent" value={usd(spent)} sub="batch rates" />
        {/* Nobody was ever billed the synchronous price, so this is a modelled
            counterfactual off the published 50% batch discount — arithmetic,
            not an invoice line. It gets the same mark as every other number
            here that has not been charged. */}
        <Stat label="Saved vs sync" value={usdEst(spent)} tone="var(--ok)"
              sub="est. · batch rates are 50% of list" />
      </div>

      <div className="card scroll-x">
        <table className="grid">
          <thead>
            <tr className="label">
              <th>Run</th><th>Status</th><th className="r">Requests</th>
              <th>Progress</th><th className="r">Cost</th><th className="r">Expires</th><th className="r">Created</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="dim center">Loading…</td></tr>}
            {!loading && !runs.length && (
              <tr><td colSpan={7} className="center" style={{ padding: '46px 12px' }}>
                <p className="dim">No runs yet.</p>
                <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={onNew}>Build your first batch</button>
              </td></tr>
            )}
            {listed.map((r) => {
              const exp = until(r.expires_at);
              return (
                <tr key={r.id} onClick={() => onOpen(r.id)} className="clickable">
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    <div className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 2 }}>
                      {r.model}{r.project_name && ` · ${r.project_name}`}{r.parent_run_id && ' · retry'}
                    </div>
                  </td>
                  <td><Pill status={r.status} /></td>
                  <td className="r mono">{num(r.total_requests)}</td>
                  <td style={{ minWidth: 140 }}>
                    <Bar succeeded={r.succeeded} failed={r.failed} pending={r.pending} />
                    <div className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 4, display: 'flex', gap: 8 }}>
                      <span style={{ color: r.succeeded ? 'var(--ok)' : undefined }}>{num(r.succeeded)} ok</span>
                      {r.failed > 0 && <span style={{ color: 'var(--bad)' }}>{num(r.failed)} failed</span>}
                      {r.pending > 0 && <span>{num(r.pending)} pending</span>}
                    </div>
                  </td>
                  <td className="r mono">
                    {r.cost_usd
                      ? usd(r.cost_usd)
                      : <span className="faint" title="Priced before submission from a sampled token count. Nothing has been billed for this run yet.">
                          {usdEst(r.est_cost_usd)} est.
                        </span>}
                  </td>
                  <td className="r mono" style={{ color: exp.urgent ? 'var(--warn)' : undefined }}>
                    {r.status === 'in_progress' ? exp.text : '—'}
                  </td>
                  <td className="r faint mono">{ago(r.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* A table that stops without saying so reads as the whole history, and
          the missing part is exactly the part nobody goes looking for. */}
      {hiddenRuns > 0 && (
        <div className="faint" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
          <span>
            Showing {num(listed.length)} of {num(runs.length)} runs — the {num(hiddenRuns)} older ones
            are not drawn. The counters above still total all {num(runs.length)}.
          </span>
          <button className="bx-f" style={{ textDecoration: 'underline' }} onClick={() => setExpanded(true)}>
            Draw all {num(runs.length)}
          </button>
        </div>
      )}
      {expanded && runs.length > RUN_ROWS && (
        <div className="faint" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
          <span>Showing all {num(runs.length)} runs. Main returns at most 200; anything older is not read.</span>
          <button className="bx-f" style={{ textDecoration: 'underline' }} onClick={() => setExpanded(false)}>
            Back to {RUN_ROWS}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── builder ──────────────────────────────────────────────────────────── */

function NewRun({ projects, hasKey, onNeedKey, seed, onSeedConsumed, onDone, onCancel }: {
  projects: Project[]; hasKey: boolean; onNeedKey: () => void;
  seed?: { projectId: string; root: string; paths: string[] } | null;
  onSeedConsumed?: () => void;
  onDone: (id: string) => void; onCancel: () => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [catalog, setCatalog] = useState<{ fetchedAt: number | null; stale: boolean }>({ fetchedAt: null, stale: true });
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  /** The recipes and the model list, without which there is no form to show. */
  const [bootErr, setBootErr] = useState<string | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0);
  const [cfg, setCfg] = useState<RunConfig | null>(null);
  const [preview, setPreview] = useState<any>(null);
  const [previewErr, setPreviewErr] = useState<string | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [est, setEst] = useState<any>(null);
  const [estMeta, setEstMeta] = useState<{ warnings: string[]; errors: string[] } | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [dry, setDry] = useState<any>(null);
  const [drying, setDrying] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitErr, setSubmitErr] = useState<string | null>(null);

  const projectId = cfg?.projectId ?? projects[0]?.id;

  useEffect(() => {
    const pid = seed?.projectId ?? projects[0]?.id;
    window.wanigan.batch.presets(pid).then((d) => {
      setBootErr(null);
      setPresets(d.presets); setModels(d.models);
      setCatalog({ fetchedAt: d.modelsFetchedAt, stale: d.modelsStale });

      if (seed) {
        // Review-the-agent's-work is the obvious job for a handed-over file
        // list, so start from the audit recipe rather than a blank one.
        const audit = (d.presets as Preset[]).find((x) => x.id === 'repo-audit') ?? d.presets[0];
        const project = projects.find((p) => p.id === seed.projectId);
        setCfg({
          ...audit.config,
          name: `Review ${seed.paths.length} changed file${seed.paths.length === 1 ? '' : 's'}${project ? ` — ${project.name}` : ''}`,
          projectId: seed.projectId,
          source: { kind: 'files', root: seed.root, paths: seed.paths, maxBytes: 120_000 },
        });
        onSeedConsumed?.();
      } else {
        // Only ever INITIALIZE. This effect re-runs whenever the shared project
        // list is refreshed (a new array identity every 30s) and again when a
        // consumed seed clears — an unconditional setCfg here wiped the user's
        // half-built run on a timer, and erased the seeded config it had just
        // handed over.
        setCfg((current) => current ?? { name: '', projectId: pid, ...d.presets[0].config });
      }
    }).catch((e) => setBootErr(msg(e)));
    // Seeding is a one-shot handoff; re-running on every projects change would
    // clobber edits the user has already made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, seed, bootAttempt]);

  const model = useMemo(() => models.find((m) => m.id === cfg?.model), [models, cfg?.model]);

  async function refreshCatalog() {
    setRefreshingModels(true); setModelsErr(null);
    try {
      await window.wanigan.batch.refreshModels();
      const d = await window.wanigan.batch.presets(projectId);
      setModels(d.models); setCatalog({ fetchedAt: d.modelsFetchedAt, stale: d.modelsStale });
    } catch (e) {
      // Nothing runs after this to notice, so a swallowed failure leaves the
      // previous capability table on screen looking freshly read — which is
      // how a context window or an effort level silently goes out of date.
      setModelsErr(msg(e));
    }
    finally { setRefreshingModels(false); }
  }
  const patch = (p: Partial<RunConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const invalidate = () => { setEst(null); setDry(null); };

  async function applyPreset(id: string) {
    const d = await window.wanigan.batch.presets(projectId);
    const p = (d.presets as Preset[]).find((x) => x.id === id);
    if (!p) return;
    setCfg({ name: cfg?.name || '', projectId, ...p.config });
    setPresets(d.presets); setPreview(null); setPreviewErr(null); invalidate();
  }

  async function changeProject(id: string) {
    // Re-resolve presets so their example paths point at the new project.
    const d = await window.wanigan.batch.presets(id);
    setPresets(d.presets);
    const p = (d.presets as Preset[]).find((x) => x.id === cfg?.preset);
    setCfg((c) => (c ? { ...c, projectId: id, ...(p ? { source: p.config.source } : {}) } : c));
    setPreview(null); invalidate();
  }

  async function loadPreview() {
    if (!cfg) return;
    setLoadingPreview(true); setPreviewErr(null); invalidate();
    try { setPreview(await window.wanigan.batch.preview(cfg.source, cfg.userTemplate)); }
    catch (e) { setPreviewErr(e instanceof Error ? e.message : String(e)); setPreview(null); }
    finally { setLoadingPreview(false); }
  }

  async function runEstimate(observed?: number) {
    if (!cfg) return;
    if (!hasKey) { onNeedKey(); return; }
    setEstimating(true);
    try {
      const d = await window.wanigan.batch.estimate(cfg, observed);
      setEst(d.estimate); setEstMeta({ warnings: d.warnings ?? [], errors: d.errors ?? [] });
    } catch (e) {
      setEstMeta({ warnings: [], errors: [e instanceof Error ? e.message : String(e)] }); setEst(null);
    } finally { setEstimating(false); }
  }

  async function runDry() {
    if (!cfg) return;
    if (!hasKey) { onNeedKey(); return; }
    setDrying(true); setDry(null);
    try {
      const d = await window.wanigan.batch.dryRun(cfg, 0);
      setDry(d);
      if (d.result?.ok && d.result.usage?.output_tokens) await runEstimate(d.result.usage.output_tokens);
    } catch (e) {
      setDry({ result: { ok: false, message: e instanceof Error ? e.message : String(e) } });
    } finally { setDrying(false); }
  }

  async function submit() {
    if (!cfg || !est) return;
    setSubmitting(true); setSubmitErr(null);
    try {
      const r = await window.wanigan.batch.submit(cfg, {
        // The ceiling, not the optimistic band: submit.ts gates the spend cap
        // on whatever cost arrives, and a run that only fits under the cap if
        // every response comes back short has not been shown to fit. Pairing
        // worstCaseOutputTokens with costLowUsd also stored two different
        // quantities in one column, which skewed estimate accuracy.
        input: est.totalInputTokens, output: est.worstCaseOutputTokens, cost: est.costHighUsd,
      });
      onDone(r.runId);
    } catch (e) { setSubmitErr(e instanceof Error ? e.message : String(e)); setSubmitting(false); }
  }

  if (!cfg) {
    // Loading and failed-to-load are different states: the second one has to
    // say so, or the builder sits on "Loading…" for the rest of the session.
    if (bootErr) {
      return (
        <div className="pane">
          <div className="pane-head">
            <div>
              <button className="faint" style={{ fontSize: 'var(--t-small)' }} onClick={onCancel}>← Batches</button>
              <h1 style={{ marginTop: 2 }}>New run</h1>
            </div>
          </div>
          <div className="card bx-state">
            <h4>Could not load the recipes</h4>
            <p>{bootErr}</p>
            <p>The builder needs the preset list and the model table before it can show a form. Nothing has been built or submitted.</p>
            <button className="btn" onClick={() => setBootAttempt((n) => n + 1)}>Try again</button>
          </div>
        </div>
      );
    }
    return <div className="pane"><p className="dim">Loading…</p></div>;
  }

  const dryFailed = dry?.result && !dry.result.ok;
  const blockers: string[] = [];
  if (!cfg.name.trim()) blockers.push('name the run');
  if (!preview) blockers.push('load the dataset');
  if (preview && !preview.rowCount) blockers.push('dataset is empty');
  if (preview?.missingSlots?.length) blockers.push('fix unresolved slots');
  if (!est) blockers.push('run the estimate');
  if (dryFailed) blockers.push('dry run failed');

  return (
    <div className="pane builder">
      <div className="builder-main">
        <div className="pane-head">
          <div>
            <button className="faint" style={{ fontSize: 'var(--t-small)' }} onClick={onCancel}>← Batches</button>
            <h1 style={{ marginTop: 2 }}>New run</h1>
            <p className="dim">Dataset in, one prompt across every row, results back at half price.</p>
          </div>
        </div>

        <Section n={1} title="Recipe" hint="Presets are starting points — everything stays editable.">
          <div className="preset-grid">
            {presets.map((p) => (
              <button key={p.id} onClick={() => applyPreset(p.id)} className="sunk preset"
                      style={cfg.preset === p.id || (!cfg.preset && p.id === 'blank')
                        ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : undefined}>
                <div style={{ fontWeight: 600, fontSize: 'var(--t-small)' }}>{p.label}</div>
                <div className="dim" style={{ fontSize: 'var(--t-micro)', marginTop: 4, lineHeight: 1.4 }}>{p.blurb}</div>
              </button>
            ))}
          </div>
          <div className="row2" style={{ marginTop: 14 }}>
            <div>
              <label className="label">Run name</label>
              <input className="field" style={{ marginTop: 4 }} value={cfg.name}
                     placeholder="e.g. Normalise venue names — August export"
                     onChange={(e) => patch({ name: e.target.value })} />
            </div>
            <div>
              <label className="label">Project</label>
              <select className="field" style={{ marginTop: 4 }} value={cfg.projectId ?? ''}
                      onChange={(e) => void changeProject(e.target.value)}>
                {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.branch ? ` — ${p.branch}` : ''}</option>)}
              </select>
            </div>
          </div>
        </Section>

        <Section n={2} title="Dataset" hint="One request per row. Load it first — every number below depends on it."
                 right={<button className="btn" onClick={loadPreview} disabled={loadingPreview}>
                   {loadingPreview ? 'Loading…' : preview ? 'Reload' : 'Load dataset'}</button>}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 11, flexWrap: 'wrap' }}>
            {(cfg.source.kind === 'files' ? (['files'] as const) : (['csv', 'jsonl', 'glob', 'command'] as const)).map((k) => (
              <button key={k} className="pill" onClick={() => { patch({ source: defaultSource(k) }); setPreview(null); invalidate(); }}
                      style={cfg.source.kind === k ? { background: 'var(--accent)', color: 'var(--bg)' }
                                                   : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                {({ csv: 'CSV', jsonl: 'JSONL', glob: 'Files', command: 'Command', files: 'From session' } as const)[k]}
              </button>
            ))}
          </div>
          <SourceEditor source={cfg.source} onChange={(s) => { patch({ source: s }); setPreview(null); invalidate(); }} />
          {previewErr && <div style={{ marginTop: 11 }}><Note tone="error">{previewErr}</Note></div>}
          {preview && (
            <div style={{ marginTop: 11 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 'var(--t-small)', marginBottom: 7 }}>
                <span className="pill" style={{ background: 'var(--ok-soft)', color: 'var(--ok)' }}>{num(preview.rowCount)} rows</span>
                <span className="dim">{preview.columns.length} columns</span>
                {preview.note && <span className="faint">· {preview.note}</span>}
              </div>
              <div className="sunk scroll-x">
                <table className="grid mono">
                  <thead><tr>{preview.columns.map((c: string) => <th key={c} className="label">{c}</th>)}</tr></thead>
                  <tbody>
                    {preview.rows.slice(0, 6).map((r: any, i: number) => (
                      <tr key={i}>{preview.columns.map((c: string) => (
                        <td key={c} className="trunc" title={String(r[c] ?? '')}>{String(r[c] ?? '')}</td>
                      ))}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
          {(cfg.source.kind === 'glob' || cfg.source.kind === 'files') && <UploadCache />}
        </Section>

        <Section n={3} title="Prompt"
                 hint="Cached blocks must be byte-identical on every request — that is why shared context lives here, not in the per-row template.">
          {cfg.system.map((b, i) => (
            <div key={i} style={{ marginBottom: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="label">System block {cfg.system.length > 1 ? i + 1 : ''}</span>
                <label style={{ marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 'var(--t-small)', cursor: 'pointer' }}>
                  <input type="checkbox" checked={b.cache}
                         onChange={(e) => { const s = [...cfg.system]; s[i] = { ...b, cache: e.target.checked }; patch({ system: s }); invalidate(); }} />
                  cache this block
                </label>
              </div>
              <textarea className="field mono" rows={b.cache ? 8 : 4} value={b.text}
                        placeholder="Instructions identical for every row."
                        onChange={(e) => { const s = [...cfg.system]; s[i] = { ...b, text: e.target.value }; patch({ system: s }); invalidate(); }} />
            </div>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span className="label">User template</span>
            <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>{'{{column}}'} binds to dataset columns</span>
          </div>
          <textarea className="field mono" rows={5} value={cfg.userTemplate}
                    onChange={(e) => { patch({ userTemplate: e.target.value }); invalidate(); }} />
          {preview && (
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginTop: 7 }}>
              {preview.columns.map((c: string) => (
                <button key={c} className="pill mono" style={{ background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}
                        onClick={() => { patch({ userTemplate: cfg.userTemplate + `{{${c}}}` }); invalidate(); }}>+ {c}</button>
              ))}
            </div>
          )}
          {preview?.missingSlots?.length ? (
            <div style={{ marginTop: 11 }}>
              <Note tone="error">
                Template references {preview.missingSlots.map((s: string) => `{{${s}}}`).join(', ')} — no such column.
                These render empty on every row.
              </Note>
            </div>
          ) : null}
        </Section>

        <Section n={4} title="Model and output"
                 right={<button className="btn" onClick={refreshCatalog} disabled={refreshingModels}>
                   {refreshingModels ? 'Refreshing…' : 'Refresh models'}</button>}>
          <p className="faint" style={{ fontSize: 'var(--t-micro)', marginBottom: 9, lineHeight: 1.45 }}>
            {catalog.fetchedAt
              ? <>Capabilities read from the Models API{catalog.stale ? ' — over a day old' : ''}. Only models that support the Batch API are listed.</>
              : <>Using the local model table. Add an API key and refresh to read live capabilities, context windows and effort levels.</>}
          </p>
          {modelsErr && (
            <div style={{ marginBottom: 9 }}>
              <Note tone="error">
                <strong>Model refresh failed.</strong> {modelsErr} The list below is unchanged — it is
                still {catalog.fetchedAt ? 'the capabilities read earlier' : 'the local model table'},
                not a fresh read.
              </Note>
            </div>
          )}
          <div className="row3">
            <div>
              <label className="label">Model</label>
              <select className="field" style={{ marginTop: 4 }} value={cfg.model}
                      onChange={(e) => { patch({ model: e.target.value }); invalidate(); }}>
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}{m.pricingKnown ? ` — $${m.batchInput}/$${m.batchOutput} per MTok` : ' — pricing unknown'}
                  </option>
                ))}
              </select>
              {model?.maxInputTokens ? (
                <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 3 }}>
                  {num(model.maxInputTokens)} token context
                </p>
              ) : null}
            </div>
            <div>
              <label className="label">Max tokens</label>
              <input type="number" min={1} className="field" style={{ marginTop: 4 }} value={cfg.maxTokens}
                     onChange={(e) => { patch({ maxTokens: Number(e.target.value) }); invalidate(); }} />
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 3 }}>cap {num(cfg.extendedOutput ? 300000 : model?.maxTokens ?? 0)}</p>
            </div>
            <div>
              <label className="label">Cache TTL</label>
              <select className="field" style={{ marginTop: 4 }} value={cfg.cacheTtl}
                      onChange={(e) => { patch({ cacheTtl: e.target.value as '5m' | '1h' }); invalidate(); }}>
                <option value="1h">1 hour — right for batches</option>
                <option value="5m">5 minutes</option>
              </select>
            </div>
          </div>
          {model && model.efforts.length > 0 && (
            <div style={{ marginTop: 13 }}>
              <label className="label">Effort <span className="faint" style={{ textTransform: 'none' }}>
                — the largest cost lever; it shapes thinking, tool calls and response length</span></label>
              <div style={{ display: 'flex', gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
                {model.efforts.map((lvl) => (
                  <button key={lvl} className="pill" onClick={() => { patch({ effort: lvl as never }); invalidate(); }}
                          style={(cfg.effort ?? 'high') === lvl
                            ? { background: 'var(--accent)', color: 'var(--bg)' }
                            : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                    {lvl}
                  </button>
                ))}
              </div>
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5, lineHeight: 1.45 }}>
                {EFFORT_HINT[cfg.effort ?? 'high']} Effort is part of the rendered prompt, so it is set
                once per run — changing it mid-run would invalidate the cached prefix.
              </p>
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, marginTop: 13, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--t-small)' }}
                   title={model?.extendedOutput ? '' : `${model?.label ?? 'This model'} does not support extended output`}>
              <input type="checkbox" disabled={!model?.extendedOutput} checked={!!cfg.extendedOutput}
                     onChange={(e) => { patch({ extendedOutput: e.target.checked }); invalidate(); }} />
              Extended output (300k max_tokens, batch only)
            </label>
            {model?.thinkingAdaptive && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--t-small)' }}>
                <input type="checkbox" checked={cfg.thinking === 'adaptive'}
                       onChange={(e) => { patch({ thinking: e.target.checked ? 'adaptive' : 'off' }); invalidate(); }} />
                Adaptive thinking
              </label>
            )}
            {cfg.thinking === 'adaptive' && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 'var(--t-small)' }}>
                <input type="checkbox" checked={cfg.thinkingDisplay === 'summarized'}
                       onChange={(e) => { patch({ thinkingDisplay: e.target.checked ? 'summarized' : 'omitted' }); invalidate(); }} />
                Return a reasoning summary
              </label>
            )}
          </div>
          <details style={{ marginTop: 13 }} open={!!cfg.schemaJson}>
            <summary className="dim" style={{ cursor: 'pointer', fontSize: 'var(--t-small)' }}>
              Structured output schema {cfg.schemaJson ? '(set)' : '(optional)'}
              {model && !model.supportsStructuredOutputs && (
                <span style={{ color: 'var(--warn)' }}> — {model.label} does not support this</span>
              )}
            </summary>
            <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 6, lineHeight: 1.45 }}>
              Sent as <span className="mono">output_config.format</span>. Every object needs{' '}
              <span className="mono">additionalProperties: false</span> and a{' '}
              <span className="mono">required</span> list, or the API rejects the batch.
            </p>
            <textarea className="field mono" rows={7} style={{ marginTop: 6 }} value={cfg.schemaJson ?? ''}
                      onChange={(e) => { patch({ schemaJson: e.target.value }); invalidate(); }} />
          </details>
        </Section>
      </div>

      <aside className="builder-side">
        <div className="card" style={{ padding: 15, display: 'flex', flexDirection: 'column', gap: 11 }}>
          <h2 style={{ fontSize: 'var(--t-body)', fontWeight: 600 }}>Pre-flight</h2>
          {!hasKey && <Note tone="warn">No API key yet — add one in Settings to estimate or submit.</Note>}
          <div style={{ display: 'flex', gap: 7 }}>
            <button className="btn" style={{ flex: 1, justifyContent: 'center' }}
                    onClick={() => runEstimate(est?.observedOutputTokens)} disabled={estimating || !preview}>
              {estimating ? 'Counting…' : 'Estimate'}
            </button>
            <button className="btn" style={{ flex: 1, justifyContent: 'center' }} onClick={runDry} disabled={drying || !preview}>
              {drying ? 'Running…' : 'Dry run'}
            </button>
          </div>
          <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
            Batch validation is asynchronous — a malformed request is not reported until the whole
            batch ends. The dry run sends one row synchronously to find that now.
          </p>

          {estMeta?.errors.length ? <Note tone="error">{estMeta.errors.join(' ')}</Note> : null}
          {estMeta?.warnings.map((w, i) => <Note key={i} tone="warn">{w}</Note>)}

          {est && (
            <>
              <div className="stat-2">
                <Stat label="Requests" value={num(est.requests)} sub={est.chunks > 1 ? `${est.chunks} batches` : '1 batch'} />
                {/* The number an operator reads before spending must not be the
                    one that looks most like a measurement: both bounds are
                    priced off a sampled token count, so both carry the mark. */}
                <Stat label="Est. cost" value={usdEst(est.costLowUsd)}
                      sub={`est. · up to ${usdEst(est.costHighUsd)}`} tone="var(--accent)" />
              </div>
              <div className="sunk" style={{ padding: '9px 11px', fontSize: 'var(--t-small)', lineHeight: 1.7 }}>
                {/* Counted on a sample and multiplied out to the whole dataset:
                    exact for the rows that were counted, a projection for the
                    run. The projection is what prices the batch, so it is the
                    one that carries the mark. */}
                <KV k="Mean input" v={`~${num(est.meanInputTokens)} tok`}
                    note={`est. · sampled ${est.sampledRows} of ${num(est.requests)}`} />
                {est.cachedPrefixTokens > 0 && <KV k="Cached prefix" v={`${num(est.cachedPrefixTokens)} tok`} note="written once" />}
                <KV k={est.observedOutputTokens ? 'Output (measured)' : 'Output (assumed)'}
                    v={est.observedOutputTokens
                        ? `${num(est.observedOutputTokens)} tok/row`
                        : `~${num(Math.round(est.worstCaseOutputTokens * 0.25 / est.requests))} tok/row est.`} />
                <KV k="Same work, sync" v={`${usdEst(est.syncCostHighUsd)} est.`} note="you save half" />
              </div>
              {est.notes?.map((n: string, i: number) => <p key={i} className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>{n}</p>)}
            </>
          )}

          <CachePreflight cfg={cfg} requests={est?.requests ?? preview?.rowCount ?? 0}
                          prefixTokens={est?.cachedPrefixTokens ?? 0}
                          onUseTtl={(ttl) => { patch({ cacheTtl: ttl }); invalidate(); }} />

          {dry?.result && (dry.result.ok
            ? <>
                <Note tone="ok">Dry run passed — the request shape is valid.</Note>
                <pre className="sunk mono scroll-y" style={{ padding: 10, maxHeight: 170 }}>{dry.result.text}</pre>
              </>
            : <Note tone="error"><strong>Dry run failed.</strong> {dry.result.message}</Note>)}

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 11 }}>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
                    disabled={!!blockers.length || submitting} onClick={submit}>
              {submitting ? 'Submitting…' : est ? `Submit — up to ${usdEst(est.costHighUsd)} est.` : 'Submit'}
            </button>
            {blockers.length > 0 && (
              <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 7, textAlign: 'center' }}>Still to do: {blockers.join(', ')}.</p>
            )}
            {submitErr && <div style={{ marginTop: 8 }}><Note tone="error">{submitErr}</Note></div>}
          </div>
        </div>
      </aside>
    </div>
  );
}

const EFFORT_HINT: Record<string, string> = {
  low: 'Fewest tokens: terser answers, fewer tool calls. Right for classification and high-volume passes.',
  medium: 'Balanced. A solid cost step down from the default without much capability loss.',
  high: 'The API default. Complex reasoning and anything quality-sensitive.',
  xhigh: 'Extended exploration for long-horizon coding and agentic work. Expect meaningfully more tokens.',
  max: 'No constraint on token spend. Reserve for genuinely frontier problems.',
};

function KV({ k, v, note }: { k: string; v: string; note?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
      <span className="dim">{k}</span>
      <span className="mono">{v}{note && <span className="faint"> · {note}</span>}</span>
    </div>
  );
}

function defaultSource(kind: SourceConfig['kind']): SourceConfig {
  switch (kind) {
    case 'csv':     return { kind: 'csv', text: '' };
    case 'jsonl':   return { kind: 'jsonl', text: '' };
    case 'glob':    return { kind: 'glob', root: '', pattern: '**/*.php', maxBytes: 120000 };
    case 'command': return { kind: 'command', cwd: '', command: '', format: 'jsonl' };
    case 'files':   return { kind: 'files', root: '', paths: [], maxBytes: 120_000 };
  }
}

function SourceEditor({ source, onChange }: { source: UploadableSource; onChange: (s: UploadableSource) => void }) {
  if (source.kind === 'csv' || source.kind === 'jsonl') {
    return (
      <>
        <textarea className="field mono" rows={6} value={source.text}
                  placeholder={source.kind === 'csv' ? 'nid,title,body\n12,"Winterland","…"' : '{"nid":"12","title":"Winterland"}'}
                  onChange={(e) => onChange({ ...source, text: e.target.value })} />
        <label className="btn" style={{ marginTop: 7 }}>
          Choose file…
          <input type="file" style={{ display: 'none' }} accept=".csv,.jsonl,.json,.txt,.tsv"
                 onChange={async (e) => { const f = e.target.files?.[0]; if (f) onChange({ ...source, text: await f.text() }); }} />
        </label>
      </>
    );
  }
  if (source.kind === 'files') {
    return (
      <div>
        <p className="dim" style={{ fontSize: 'var(--t-small)', marginBottom: 7 }}>
          {source.paths.length} file{source.paths.length === 1 ? '' : 's'} handed over from a session, in{' '}
          <span className="mono">{source.root}</span>.
        </p>
        <div className="sunk mono scroll-y" style={{ maxHeight: 150, padding: 9, fontSize: 'var(--t-small)', lineHeight: 1.6 }}>
          {source.paths.map((f) => <div key={f}>{f}</div>)}
        </div>
        <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 5 }}>
          Deleted files are skipped at load time rather than failing the run.
        </p>
        <UploadToggle source={source} onChange={onChange} />
      </div>
    );
  }
  if (source.kind === 'glob') {
    return (
      <>
        <div className="row3">
          <div><label className="label">Root directory</label>
            <input className="field mono" style={{ marginTop: 4 }} value={source.root}
                   onChange={(e) => onChange({ ...source, root: e.target.value })} /></div>
          <div><label className="label">Pattern</label>
            <input className="field mono" style={{ marginTop: 4 }} value={source.pattern}
                   onChange={(e) => onChange({ ...source, pattern: e.target.value })} /></div>
          <div><label className="label">Max chars</label>
            <input type="number" className="field mono" style={{ marginTop: 4 }} value={source.maxBytes ?? 120000}
                   onChange={(e) => onChange({ ...source, maxBytes: Number(e.target.value) })} /></div>
        </div>
        <UploadToggle source={source} onChange={onChange} />
      </>
    );
  }
  return (
    <>
      <div className="row2">
        <div><label className="label">Working directory</label>
          <input className="field mono" style={{ marginTop: 4 }} value={source.cwd}
                 onChange={(e) => onChange({ ...source, cwd: e.target.value })} /></div>
        <div><label className="label">Output format</label>
          <select className="field" style={{ marginTop: 4 }} value={source.format}
                  onChange={(e) => onChange({ ...source, format: e.target.value as 'csv' | 'jsonl' })}>
            <option value="jsonl">JSONL</option><option value="csv">CSV / TSV</option>
          </select></div>
      </div>
      <label className="label" style={{ display: 'block', marginTop: 9 }}>Command</label>
      <textarea className="field mono" rows={4} style={{ marginTop: 4 }} value={source.command}
                placeholder='drush sql:query --extra=-B "SELECT nid, title FROM node_field_data"'
                onChange={(e) => onChange({ ...source, command: e.target.value })} />
      <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 4 }}>
        Runs in your shell with your permissions — the same trust boundary as a terminal.
      </p>
    </>
  );
}

/* ── detail ───────────────────────────────────────────────────────────── */

function RunDetail({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<DetailTab>('results');
  const [rescues, setRescues] = useState<RescueChild[]>([]);
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [detailErr, setDetailErr] = useState<string | null>(null);
  const [rowsErr, setRowsErr] = useState<string | null>(null);
  const [exportNote, setExportNote] = useState<{ tone: 'ok' | 'info' | 'error'; text: string } | null>(null);

  const loadDetail = useCallback(async () => {
    // A run that cannot be read is not a run that is still loading. Swallowing
    // this parked the whole view on "Loading…" with nothing to act on.
    try { setD(await window.wanigan.batch.run(id)); setDetailErr(null); }
    catch (e) { setDetailErr(msg(e)); }
    // Rescue runs are their own runs, so a merged rescue stays worth showing
    // after the parent's refused count has fallen back to zero.
    try { setRescues(await window.wanigan.refusal.children(id)); } catch { /* pre-P15 database */ }
  }, [id]);
  const loadRows = useCallback(async () => {
    try {
      const r = await window.wanigan.batch.results(id, filter, q, offset);
      setRows(r.rows); setTotal(r.total); setRowsErr(null);
    } catch (e) { setRowsErr(msg(e)); }
  }, [id, filter, q, offset]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => {
    if (!d) return;
    if (!['in_progress', 'submitting', 'canceling'].includes(d.run.status)) return;
    const t = setInterval(() => { void loadDetail(); void loadRows(); }, 8000);
    return () => clearInterval(t);
  }, [d, loadDetail, loadRows]);

  if (!d) {
    if (detailErr) {
      return (
        <div className="pane">
          <div className="pane-head">
            <div>
              <button className="faint" style={{ fontSize: 'var(--t-small)' }} onClick={onBack}>← Batches</button>
              <h1 style={{ marginTop: 2 }}>Run unavailable</h1>
              <p className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 3 }}>{id}</p>
            </div>
          </div>
          <div className="card bx-state">
            <h4>Could not read this run</h4>
            <p>{detailErr}</p>
            <p>Nothing about the run has changed. If it was deleted this will keep failing; otherwise the read can be retried.</p>
            <button className="btn" onClick={() => void loadDetail()}>Try again</button>
          </div>
        </div>
      );
    }
    return <div className="pane"><p className="dim">Loading…</p></div>;
  }

  const { run, counts } = d;
  const succeeded = counts.succeeded ?? 0;
  const failed = (counts.errored ?? 0) + (counts.expired ?? 0) + (counts.canceled ?? 0);
  const pending = counts.pending ?? 0;
  // A refusal arrives as HTTP 200 with stop_reason "refusal" — neither a
  // success nor an error. Leaving it out of `done` is what parks a run with
  // refusals at 94% forever, so it counts as landed here and as a failure in
  // the bar, which is the same call Insights makes.
  const refused = counts.refused ?? 0;
  const live = ['in_progress', 'submitting', 'canceling'].includes(run.status);
  const soonest = d.batches.filter((b: any) => b.processing_status !== 'ended').map((b: any) => b.expires_at).filter(Boolean).sort()[0];
  const exp = until(soonest);
  const done = succeeded + failed + refused;
  const pct = run.total_requests ? Math.round((done / run.total_requests) * 100) : 0;

  // A rescue shares the parent_run_id column with a dead-letter retry, so the
  // two have to be told apart here or a rescue reads as "retried as".
  const retries = (d.children as { id: string }[]).filter((c) => !rescues.some((r) => r.id === c.id));

  const tabs: DetailTab[] = ['results'];
  if (refused > 0 || rescues.length > 0) tabs.push('refusals');
  tabs.push('evals', 'batches', 'events', 'config');
  // Merging the last rescue can retire the refusals tab underneath the user.
  const activeTab: DetailTab = tabs.includes(tab) ? tab : 'results';

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label);
    try {
      const r = await fn();
      if (r?.runId) { onOpen(r.runId); return; }
      await loadDetail(); await loadRows();
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  /**
   * A save dialog the user closed is not a failure, and a file that was
   * written is worth naming — the main process returns the path on success and
   * null when the dialog was dismissed, which is exactly that distinction.
   */
  async function exportResults(format: 'jsonl' | 'csv') {
    setBusy(`export-${format}`); setExportNote(null);
    try {
      const path = await window.wanigan.batch.exportTo(id, format);
      setExportNote(path
        ? { tone: 'ok', text: `Exported to ${path}` }
        : { tone: 'info', text: `Export canceled — no ${format.toUpperCase()} file was written.` });
    } catch (e) {
      setExportNote({ tone: 'error', text: `Export failed. ${msg(e)}` });
    } finally { setBusy(null); }
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <div style={{ minWidth: 0 }}>
          <button className="faint" style={{ fontSize: 'var(--t-small)' }} onClick={onBack}>← Batches</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 3 }}>
            <h1>{run.name}</h1><Pill status={run.status} />
          </div>
          <p className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 3 }}>{run.id} · {run.model}</p>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {live && <button className="btn btn-danger" disabled={busy === 'cancel'}
                           onClick={() => act(() => window.wanigan.batch.cancel(id), 'cancel')}>
            {busy === 'cancel' ? 'Canceling…' : 'Cancel run'}</button>}
          {!live && failed > 0 && <button className="btn" disabled={busy === 'retry'}
                           onClick={() => act(() => window.wanigan.batch.retry(id), 'retry')}>
            {busy === 'retry' ? 'Resubmitting…' : `Retry ${num(failed)} failed`}</button>}
          <button className="btn" disabled={busy === 'export-jsonl'} onClick={() => void exportResults('jsonl')}>
            {busy === 'export-jsonl' ? 'Exporting…' : 'Export JSONL'}</button>
          <button className="btn" disabled={busy === 'export-csv'} onClick={() => void exportResults('csv')}>
            {busy === 'export-csv' ? 'Exporting…' : 'Export CSV'}</button>
        </div>
      </div>

      {exportNote && <Note tone={exportNote.tone}>{exportNote.text}</Note>}
      {detailErr && (
        <Note tone="warn">
          <strong>Last refresh failed.</strong> {detailErr} The numbers below are from the previous read.{' '}
          <button className="bx-f" style={{ textDecoration: 'underline' }} onClick={() => void loadDetail()}>Retry</button>
        </Note>
      )}
      {run.error && <Note tone="error"><strong>Run failed.</strong> {run.error}</Note>}
      {retries.length > 0 && (
        <Note tone="info">Retried as {retries.map((c: any) => (
          <button key={c.id} className="mono bx-f" style={{ textDecoration: 'underline' }} onClick={() => onOpen(c.id)}>{c.id}</button>
        ))}.</Note>
      )}

      <div className="stat-grid-5" style={refused ? { gridTemplateColumns: 'repeat(6, minmax(0, 1fr))' } : undefined}>
        <Stat label="Progress" value={`${pct}%`} sub={`${num(done)} of ${num(run.total_requests)} requests`} />
        <Stat label="Succeeded" value={num(succeeded)} tone={succeeded ? 'var(--ok)' : undefined} />
        <Stat label="Failed" value={num(failed)} tone={failed ? 'var(--bad)' : undefined} sub={failed ? 'retryable' : 'none'} />
        {refused > 0 && (
          <Stat label="Refused" value={<span>⊘ {num(refused)}</span>} tone="var(--serious)"
                sub="declined — rescue on another model" />
        )}
        {/* One grammar with the pre-flight card and the run list: a tilde and
            "est." until the API has returned token counts to price, plain once
            it has. */}
        <Stat label="Cost" value={run.cost_usd ? usd(run.cost_usd) : usdEst(run.est_cost_usd)}
              sub={run.cost_usd ? 'priced from returned token counts' : 'est. · no token counts returned yet'} />
        <Stat label={live ? 'Expires in' : 'Duration'}
              value={live ? exp.text : run.ended_at && run.submitted_at ? `${Math.max(1, Math.round((run.ended_at - run.submitted_at) / 60000))}m` : '—'}
              tone={live && exp.urgent ? 'var(--warn)' : undefined} sub={live ? '24h hard limit' : ago(run.ended_at)} />
      </div>

      <div className="card" style={{ padding: 13 }}>
        <Bar succeeded={succeeded} failed={failed + refused} pending={pending} />
        <div className="faint mono bx-num" style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 'var(--t-micro)', flexWrap: 'wrap' }}>
          {refused > 0 && <span style={{ color: 'var(--serious)' }}>⊘ {num(refused)} refused</span>}
          <span>{num(run.in_tokens)} tokens in</span><span>{num(run.out_tokens)} tokens out</span>
          {run.cache_read > 0 && <span style={{ color: 'var(--ok)' }}>{num(run.cache_read)} cache read</span>}
          {run.cache_write > 0 && <span>{num(run.cache_write)} cache write</span>}
          <span style={{ marginLeft: 'auto' }}>{d.batches.length} batch{d.batches.length === 1 ? '' : 'es'}</span>
        </div>
      </div>

      {run.submitted_at ? <CacheObserved runId={id} run={run} config={d.config} /> : null}

      <div className="tabs">
        {tabs.map((t) => (
          <button key={t} onClick={() => setTab(t)} className={activeTab === t ? 'tab-on bx-f' : 'bx-f'}>
            {t}
            {t === 'results' && total ? ` (${num(total)})` : ''}
            {t === 'refusals' && refused ? ` (${num(refused)})` : ''}
          </button>
        ))}
      </div>

      {activeTab === 'results' && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {['all', 'succeeded', 'failed', 'pending'].map((f) => (
              <button key={f} className="pill" onClick={() => { setFilter(f); setOffset(0); }}
                      style={filter === f ? { background: 'var(--accent)', color: 'var(--bg)' }
                                          : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>{f}</button>
            ))}
            <input className="field" style={{ marginLeft: 'auto', maxWidth: 260 }} placeholder="Search prompts, output, errors…"
                   value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          </div>
          {rowsErr && (
            <Note tone="error">
              <strong>Could not read these results.</strong> {rowsErr} This is a failed read, not an
              empty result set.{' '}
              <button className="bx-f" style={{ textDecoration: 'underline' }} onClick={() => void loadRows()}>Retry</button>
            </Note>
          )}
          <div className="card scroll-x">
            <table className="grid">
              <thead><tr className="label"><th>custom_id</th><th>Status</th><th>Output</th><th className="r">Tokens</th></tr></thead>
              <tbody>
                {!rows.length && <tr><td colSpan={4} className="dim center">
                  {rowsErr ? 'Results could not be read — the message above says why.'
                    : pending ? 'Still processing — results land as batches end.' : 'No rows match.'}</td></tr>}
                {rows.map((r) => (
                  <tr key={r.custom_id} className="clickable" onClick={() => setOpen(r)}>
                    <td className="mono">{r.custom_id}</td>
                    <td><Pill status={r.status} /></td>
                    <td className="dim trunc" style={{ maxWidth: 520 }}>
                      {r.status === 'succeeded' ? (r.output_text ?? '').slice(0, 200)
                        : <span style={{ color: 'var(--bad)' }}>{r.error_message ?? '—'}</span>}
                    </td>
                    <td className="r faint mono">{r.in_tokens ? `${num(r.in_tokens)}/${num(r.out_tokens)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {total > 50 && (
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 'var(--t-small)' }}>
              <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
              <span className="dim">{num(offset + 1)}–{num(Math.min(offset + 50, total))} of {num(total)}</span>
              <button className="btn" disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Next</button>
            </div>
          )}
        </>
      )}

      {activeTab === 'refusals' && (
        <RefusalLane runId={id} run={run} config={d.config} rescues={rescues} live={live}
                     onOpen={onOpen}
                     onChanged={async () => { await loadDetail(); await loadRows(); }} />
      )}

      {activeTab === 'evals' && <EvalsTab runId={id} run={run} onOpen={onOpen} />}

      {activeTab === 'batches' && (
        <div className="card scroll-x">
          <table className="grid">
            <thead><tr className="label"><th>Batch</th><th>Status</th><th className="r">Requests</th><th>Counts</th><th className="r">Expires</th><th className="r">Polled</th></tr></thead>
            <tbody>
              {d.batches.map((b: any) => {
                const c = parseCounts(b.counts_json);
                const e = until(b.expires_at);
                return (
                  <tr key={b.id}>
                    <td className="mono">{b.id}</td>
                    <td><Pill status={b.processing_status} /></td>
                    <td className="r mono">{num(b.request_count)}</td>
                    <td className="faint mono">{Object.entries(c).filter(([, v]) => (v as number) > 0).map(([k, v]) => `${v} ${k}`).join(' · ') || '—'}</td>
                    <td className="r mono" style={{ color: e.urgent ? 'var(--warn)' : undefined }}>{b.processing_status === 'ended' ? '—' : e.text}</td>
                    <td className="r faint mono">{ago(b.last_polled_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {activeTab === 'events' && (
        <div className="card">
          {!d.events.length && <p className="dim" style={{ padding: 14 }}>No events.</p>}
          {d.events.map((e: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 11, padding: '7px 14px', fontSize: 'var(--t-small)', borderTop: i ? '1px solid var(--line)' : undefined }}>
              <span className="faint mono" style={{ flex: 'none' }}>{new Date(e.at).toLocaleTimeString()}</span>
              <span style={{ color: e.level === 'error' ? 'var(--bad)' : e.level === 'warn' ? 'var(--warn)' : undefined }}>{e.message}</span>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'config' && <pre className="card mono scroll-y" style={{ padding: 14, maxHeight: 560 }}>{JSON.stringify(d.config, null, 2)}</pre>}

      {open && <RequestDrawer row={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

/**
 * What one request actually contained — the prompt sent, the model's output and
 * the stored source row.
 *
 * This is the evidence somebody opens when a batch request went wrong, so it is
 * a real dialog rather than a div that looks like one: focus moves in on open
 * and returns to the row that opened it, Tab stays inside, and Escape closes.
 * Without those, a keyboard user could open this drawer and have no way back
 * out of it. App.tsx and Sessions.tsx already suppress their shortcuts on
 * `.modal-backdrop` and on `[role="dialog"][aria-modal="true"]`, so the
 * semantics below also stop ⌘-keys firing behind the scrim.
 *
 * The backdrop closes on mousedown rather than click: this pane is full of long
 * output somebody selects and copies, and a drag that starts inside the drawer
 * and releases over the scrim is a text selection, not a request to throw the
 * evidence away.
 */
function RequestDrawer({ row, onClose }: { row: any; onClose: () => void }) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const source = parseStored(row.row_json);

  useEffect(() => {
    const priorFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      priorFocus?.focus?.();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])'
      )].filter((node) => !node.hasAttribute('hidden'));
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="drawer" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
           onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
          <h3 id={titleId} className="mono" style={{ fontSize: 'var(--t-body)', fontWeight: 600 }}>{row.custom_id}</h3>
          <Pill status={row.status} />
          <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>Close</button>
        </div>
        <div className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 4 }}>
          row {row.row_index}
          {row.stop_reason && ` · stop_reason: ${row.stop_reason}`}
          {row.in_tokens > 0 && ` · ${num(row.in_tokens)} in / ${num(row.out_tokens)} out`}
        </div>
        {row.error_message && <div style={{ marginTop: 11 }}><Note tone="error"><strong>{row.error_type}</strong> — {row.error_message}</Note></div>}
        <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
          <div><div className="label" style={{ marginBottom: 4 }}>Prompt sent</div>
            <pre className="sunk mono scroll-y" style={{ padding: 11, maxHeight: 260 }}>{row.rendered}</pre></div>
          {row.output_text && <div><div className="label" style={{ marginBottom: 4 }}>Output</div>
            <pre className="sunk mono scroll-y" style={{ padding: 11, maxHeight: 340 }}>{row.output_text}</pre></div>}
          <div>
            <div className="label" style={{ marginBottom: 4 }}>Source row</div>
            {!source.ok && (
              <div style={{ marginBottom: 6 }}>
                <Note tone="warn">
                  <strong>This row is not valid JSON.</strong> It is shown below exactly as it is stored,
                  unformatted — the request was still built from these bytes.
                </Note>
              </div>
            )}
            <pre className="sunk mono scroll-y" style={{ padding: 11, maxHeight: 200 }}>{source.text}</pre>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ── P13 · uploaded rows ──────────────────────────────────────────────── */

/**
 * The toggle that turns a file source into an uploaded one.
 *
 * A repo audit that inlines every file hits the 256 MB batch ceiling long
 * before the 100,000 request one — 2,000 files at 130 KB each is already over
 * — and an uploaded file is sent once and re-used by every later run.
 */
function UploadToggle({ source, onChange }: {
  source: UploadableSource; onChange: (s: UploadableSource) => void;
}) {
  const on = source.upload === true;
  return (
    <div className="bx-lane" style={{ marginTop: 11, gap: 8 }}>
      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 'var(--t-small)', cursor: 'pointer' }}>
        <input className="bx-f" type="checkbox" checked={on} style={{ marginTop: 2, flex: 'none' }}
               onChange={(e) => onChange({ ...source, upload: e.target.checked })} />
        <span>
          Upload files instead of inlining them
          <span className="faint" style={{ display: 'block', fontSize: 'var(--t-micro)', marginTop: 3, lineHeight: 1.5 }}>
            A repo audit hits the 256 MB batch ceiling long before the 100,000 request one, and an uploaded
            file is re-used across runs instead of being re-sent with every one.
          </span>
        </span>
      </label>
      {on && (
        <Note tone="info">
          <strong>Loading the dataset performs the upload</strong>, so the first load is slower and every later
          run with the same bytes reuses it for free. Rows then carry a <span className="mono">fileRef</span>{' '}
          column and an empty <span className="mono">content</span> one — the file travels as its own content
          block — so write the template as an instruction and drop{' '}
          <span className="mono">{'{{content}}'}</span>. Anything Wanigan cannot classify as a document or an
          image is inlined as before, and the batch is created with the files beta; without it every uploaded
          row fails.
        </Note>
      )}
    </div>
  );
}

/**
 * What has actually been uploaded, keyed by content hash on the main side.
 *
 * A cache you cannot see is a cache you cannot trust: these files exist on the
 * API and stay there until something deletes them, and a stale id is worse than
 * a miss — it is accepted at build time and fails every request carrying it.
 */
function UploadCache() {
  const [files, setFiles] = useState<UploadedFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pruneNote, setPruneNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setFiles(await window.wanigan.uploads.list()); setErr(null); }
    catch (e) { setErr(msg(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function prune() {
    setBusy('prune'); setPruneNote(null); setErr(null);
    try {
      const n = await window.wanigan.uploads.prune();
      setPruneNote(n
        ? `${num(n)} stale entr${n === 1 ? 'y' : 'ies'} dropped — those files no longer exist on the API, and a run reusing one would have failed every row that carried it.`
        : 'Every cached upload still exists on the API. Nothing dropped.');
      await load();
    } catch (e) { setErr(msg(e)); }
    finally { setBusy(null); }
  }

  async function remove(f: UploadedFile) {
    setBusy(f.hash); setPruneNote(null); setErr(null);
    try { await window.wanigan.uploads.remove(f.hash); await load(); }
    catch (e) { setErr(msg(e)); }
    finally { setBusy(null); }
  }

  const total = files?.reduce((a, f) => a + f.bytes, 0) ?? 0;

  return (
    <div className="sunk bx-lane" style={{ marginTop: 12, padding: 12, gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span className="label">Upload cache</span>
        {files ? (
          <span className="faint bx-num" style={{ fontSize: 'var(--t-micro)' }}>
            {num(files.length)} file{files.length === 1 ? '' : 's'} · {bytesLabel(total)} held on the API
          </span>
        ) : null}
        <button className="btn bx-f" style={{ marginLeft: 'auto', padding: '4px 9px', fontSize: 'var(--t-small)' }}
                onClick={prune} disabled={busy !== null || !files?.length}>
          {busy === 'prune' ? 'Checking each file…' : 'Prune stale'}
        </button>
      </div>

      {err && (
        <Note tone="error">
          <strong>Could not read the upload cache.</strong> {err}{' '}
          <button className="link bx-f" onClick={() => void load()}>Try again</button>.
        </Note>
      )}
      {pruneNote && <Note tone="ok">{pruneNote}</Note>}

      {!files && !err && (
        <div className="bx-state"><p>Reading the upload cache…</p></div>
      )}

      {files && files.length === 0 && !err && (
        <div className="bx-state">
          <h4>Nothing uploaded yet</h4>
          <p>
            Turn on “upload files instead of inlining them” above, then load the dataset. The first run uploads
            each file once; every later run with the same bytes re-uses it and pays nothing to send it again.
          </p>
        </div>
      )}

      {files && files.length > 0 && (
        <div className="bx-scroll">
          <table className="grid">
            <thead>
              <tr className="label">
                <th>File</th><th>Type</th><th className="r">Size</th><th className="r">Uploaded</th><th />
              </tr>
            </thead>
            <tbody>
              {files.map((f) => (
                <tr key={f.hash}>
                  <td className="mono trunc" title={f.path}>{f.path.split('/').pop() || f.path}
                    <div className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 2 }}>{f.fileId}</div>
                  </td>
                  <td className="dim mono" style={{ fontSize: 'var(--t-micro)' }}>{f.mediaType}</td>
                  <td className="r mono">{bytesLabel(f.bytes)}</td>
                  <td className="r faint mono">{ago(f.uploadedAt)}</td>
                  <td className="r">
                    <button className="btn btn-danger bx-f" style={{ padding: '3px 8px', fontSize: 'var(--t-micro)' }}
                            disabled={busy !== null} onClick={() => void remove(f)}>
                      {busy === f.hash ? 'Deleting…' : 'Delete'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
        Pruning only drops local rows whose remote file is definitely gone. It never deletes a remote file
        Wanigan cannot prove it uploaded — the Files API is organisation-wide, and another tool's files live there too.
      </p>
    </div>
  );
}

/* ── P16 · cache diagnosis ────────────────────────────────────────────── */

/** One bar, direct-labelled by the hero above it. */
function RateBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value));
  return (
    <svg className="chart-svg" viewBox="0 0 100 10" role="img"
         aria-label={`Observed cache hit rate ${Math.round(pct * 100)} percent`}>
      <rect x="0" y="2" width="100" height="6" rx="3" fill="var(--bg-sunk)" />
      <rect x="0" y="2" width={Math.max(1.2, pct * 100)} height="6" rx="3" fill="var(--series-3)" />
    </svg>
  );
}

/**
 * Before submit: the floor and the TTL, which are the two things that decide
 * whether a prefix caches at all. Under the floor the API creates no entry —
 * no write, no read, no error — which is why a misconfigured run reads as a
 * flat 0% rather than as a failure.
 */
function CachePreflight({ cfg, requests, prefixTokens, onUseTtl }: {
  cfg: RunConfig; requests: number; prefixTokens: number; onUseTtl: (ttl: CacheTtl) => void;
}) {
  const [minimum, setMinimum] = useState<number | null>(null);
  const [advice, setAdvice] = useState<{ ttl: string; why: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cachedBlock = cfg.system.some((b) => b.cache && b.text.trim());

  useEffect(() => {
    let live = true;
    Promise.all([window.wanigan.cache.minimum(cfg.model), window.wanigan.cache.ttl(cfg, requests)])
      .then(([m, a]) => { if (live) { setMinimum(m); setAdvice(a); setErr(null); } })
      .catch((e) => { if (live) setErr(msg(e)); });
    return () => { live = false; };
    // The floor and the TTL recommendation read only the model, the TTL, the
    // request count and whether any block is cached — so a keystroke in the
    // template must not re-ask the main process.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.model, cfg.cacheTtl, requests, cachedBlock]);

  const underFloor = cachedBlock && minimum !== null && prefixTokens > 0 && prefixTokens < minimum;

  return (
    <div className="bx-lane" style={{ borderTop: '1px solid var(--line)', paddingTop: 11, gap: 9 }}>
      <span className="label">Cache diagnosis</span>

      {err && <Note tone="error"><strong>Could not read the cache floor.</strong> {err} The run is still
        submittable — this panel is a diagnostic, not a gate.</Note>}

      <div className="sunk" style={{ padding: '9px 11px', fontSize: 'var(--t-small)', lineHeight: 1.7 }}>
        <KV k="Minimum prefix" v={minimum === null ? '—' : `${num(minimum)} tok`} note={cfg.model} />
        {/* "measured" was a claim this panel cannot make. The number arrives
            from the estimate, which counts tokens through the API in normal
            mode and falls back to the local heuristic in mock mode — the
            renderer is handed the figure, not which of the two produced it. */}
        <KV k="Your cached prefix"
            v={prefixTokens > 0 ? `${num(prefixTokens)} tok` : '—'}
            note={prefixTokens > 0 ? 'from the estimate' : 'run the estimate'} />
        <KV k="Recommended TTL" v={advice?.ttl ?? '—'} note={advice && advice.ttl !== cfg.cacheTtl ? `set to ${cfg.cacheTtl}` : 'matches'} />
      </div>

      {!cachedBlock && (
        <Note tone="info">
          No system block is marked cached, so there is no prefix and nothing can hit. Mark the block that is
          byte-identical on every row — the instructions, never the per-row text.
        </Note>
      )}
      {underFloor && (
        <Note tone="warn">
          <strong>The prefix is under the floor.</strong> {num(prefixTokens)} tokens against {num(minimum ?? 0)}{' '}
          for {cfg.model}. Below it the API creates no entry at all — no write, no read and no error — so this
          shows up as a flat 0%, not as a failure. Move more of the shared instructions into the cached block.
        </Note>
      )}
      {cachedBlock && !underFloor && prefixTokens > 0 && (
        <Note tone="ok">
          The cached prefix clears the {num(minimum ?? 0)}-token floor for {cfg.model}, so an entry will be written.
        </Note>
      )}

      {advice && (
        <>
          <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>{advice.why}</p>
          {advice.ttl !== cfg.cacheTtl && (
            <button className="btn bx-f" style={{ alignSelf: 'flex-start', padding: '4px 9px', fontSize: 'var(--t-small)' }}
                    onClick={() => onUseTtl(advice.ttl as CacheTtl)}>
              Switch to {advice.ttl}
            </button>
          )}
        </>
      )}

      <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
        Even with all of the above right, hits inside a batch are best-effort. The API does not guarantee them,
        and real runs land anywhere between 30% and 98% depending on how the batch is scheduled.
      </p>
    </div>
  );
}

/**
 * After the run: the rate that actually happened, reported AS OBSERVED.
 *
 * Null is not zero. A run whose rows landed carrying no usage has nothing to
 * measure, and reporting that as a 0% hit rate sends someone rewriting a prompt
 * that was never the problem.
 */
function CacheObserved({ runId, run, config }: { runId: string; run: any; config: RunConfig }) {
  const [rate, setRate] = useState<number | null | undefined>(undefined);
  const [minimum, setMinimum] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.wanigan.cache.hitRate(runId)
      .then((r) => { if (live) { setRate(r); setErr(null); } })
      .catch((e) => { if (live) { setErr(msg(e)); setRate(null); } });
    window.wanigan.cache.minimum(run.model).then((m) => { if (live) setMinimum(m); }).catch(() => {});
    return () => { live = false; };
  }, [runId, run.model, run.status, run.cache_read, run.in_tokens]);

  const read = run.cache_read ?? 0;
  const write = run.cache_write ?? 0;
  const input = run.in_tokens ?? 0;
  const total = read + write + input;
  const cachedBlock = config?.system?.some((b) => b.cache && b.text.trim()) ?? false;

  const parts = [
    { key: 'Read from cache', v: read, c: SERIES[2], note: 'billed at a tenth of the input rate' },
    { key: 'Written to cache', v: write, c: SERIES[3], note: config?.cacheTtl === '1h' ? '2× base, 1-hour entry' : '1.25× base, 5-minute entry' },
    { key: 'Uncached input', v: input, c: SERIES[0], note: 'full input rate' },
  ];

  return (
    <div className="chart-card">
      <h3>Cache hit rate, as observed</h3>
      <div className="hero" style={{ marginTop: 8 }}>
        {rate === undefined ? '…' : rate === null ? '—' : pctLabel(rate)}
      </div>
      <div className="hero-sub">
        {rate === null ? (
          <>Nothing to measure yet — no request in this run has reported usage. That is not a 0% hit rate, and
             reading it as one sends you rewriting a prompt that was never the problem.</>
        ) : rate === undefined ? (
          <>Measuring across this run’s own request rows…</>
        ) : (
          <>{num(read)} tokens read from cache out of {num(total)} billed as input.{' '}
             <strong>Observed, not promised:</strong> hits inside a batch are best-effort — the API guarantees
             none of them, and real runs land anywhere between 30% and 98% depending on how the batch was
             scheduled. The same config can read 90% one week and 40% the next.</>
        )}
      </div>

      {typeof rate === 'number' && total > 0 && <RateBar value={rate} />}

      {err && <div style={{ marginTop: 10 }}><Note tone="error"><strong>Could not measure the cache.</strong> {err}</Note></div>}

      {rate === 0 && cachedBlock && minimum !== null && (
        <div style={{ marginTop: 10 }}>
          <Note tone="warn">
            <strong>Zero, with a block marked cached.</strong> The commonest cause is a prefix under{' '}
            {run.model}’s {num(minimum)}-token floor: below it the API silently creates no entry, so there is no
            write, no read and no error to find. The second is a value that changes per run — a timestamp or a
            UUID inside the cached text — which writes a fresh entry every time.
          </Note>
        </div>
      )}

      {total > 0 && (
        <table className="viz-table">
          <thead>
            <tr>
              <th>Input tokens</th>
              <th style={{ textAlign: 'right' }}>Tokens</th>
              <th style={{ textAlign: 'right' }}>Share</th>
              <th>Billed at</th>
            </tr>
          </thead>
          <tbody>
            {parts.map((p) => (
              <tr key={p.key}>
                <td>
                  <span className="bx-swatch" style={{ background: p.c, marginRight: 7 }} />
                  {p.key}
                </td>
                <td className="n">{num(p.v)}</td>
                <td className="n" style={{ color: 'var(--text-dim)' }}>{pctLabel(p.v / total)}</td>
                <td className="dim" style={{ fontSize: 'var(--t-micro)' }}>{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/* ── P15 · the refusal lane ───────────────────────────────────────────── */

/**
 * `fallbacks` — the server-side parameter that re-runs a refused request on a
 * second model — is rejected by the Batches API, so a batch that trips a safety
 * classifier just ends with rows nobody answered. Wanigan gives those rows their
 * own outcome, which makes it the only thing that can do the rescue itself.
 */
function RefusalLane({ runId, run, config, rescues, live, onOpen, onChanged }: {
  runId: string; run: any; config: RunConfig; rescues: RescueChild[]; live: boolean;
  onOpen: (id: string) => void; onChanged: () => Promise<void>;
}) {
  const [summary, setSummary] = useState<{ total: number; byCategory: { category: string; n: number }[] } | null>(null);
  const [examples, setExamples] = useState<Record<string, string>>({});
  const [models, setModels] = useState<Model[]>([]);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.wanigan.refusal.summary(runId)
      .then((s) => { if (alive) { setSummary(s); setLoadErr(null); } })
      .catch((e) => { if (alive) setLoadErr(msg(e)); });
    // One example explanation per category: a category name says what tripped,
    // the model's own sentence says why, and that is what tells you whether a
    // different model will answer or refuse in the same place.
    window.wanigan.refusal.rows(runId).then((rows) => {
      if (!alive) return;
      const first: Record<string, string> = {};
      for (const r of rows) {
        const k = (r.category as string | null) ?? 'unspecified';
        if (!first[k] && r.explanation) first[k] = String(r.explanation);
      }
      setExamples(first);
    }).catch(() => {});
    window.wanigan.batch.presets(config?.projectId).then((d) => {
      if (!alive) return;
      const list = d.models as Model[];
      setModels(list);
      setPick((cur) => cur || list.find((m) => m.id !== run.model)?.id || '');
    }).catch(() => {});
    return () => { alive = false; };
  }, [runId, config?.projectId, run.model]);

  async function rescue() {
    if (!pick) return;
    setBusy('rescue'); setErr(null); setOk(null);
    try {
      const r = await window.wanigan.refusal.rescue(runId, pick);
      onOpen(r.runId);
    } catch (e) { setErr(msg(e)); setBusy(null); }
  }

  async function merge(child: RescueChild) {
    setBusy(child.id); setErr(null); setOk(null);
    try {
      const r = await window.wanigan.refusal.merge(child.id);
      setOk(`${num(r.merged)} rescued row${r.merged === 1 ? '' : 's'} folded back into this run. The rescue’s spend stays on ${child.id} — this run’s totals are unchanged, because the parent was billed for the refusal and the child for the answer.`);
      await onChanged();
    } catch (e) { setErr(msg(e)); }
    finally { setBusy(null); }
  }

  const cats = summary?.byCategory ?? [];
  const total = summary?.total ?? 0;
  const cachedBlock = config?.system?.some((b) => b.cache && b.text.trim()) ?? false;
  const cachedTokens = config?.system?.filter((b) => b.cache && b.text.trim())
    .reduce((a, b) => a + estimateTokens(b.text), 0) ?? 0;

  // Offsets first, so the stacked bar does not need a mutable counter inside JSX.
  let cursor = 0;
  const segments = cats.map((c, i) => {
    const w = total > 0 ? (c.n / total) * 100 : 0;
    const seg = { ...c, x: cursor, w, colour: SERIES[i % SERIES.length] };
    cursor += w;
    return seg;
  });

  return (
    <div className="bx-lane">
      {loadErr && (
        <Note tone="error">
          <strong>Could not read the refusals.</strong> {loadErr} The rows themselves are intact — the results
          tab, filtered to failed, still lists every one.
        </Note>
      )}
      {err && <Note tone="error">{err}</Note>}
      {ok && <Note tone="ok">{ok}</Note>}

      {total === 0 && !loadErr && (
        <div className="card bx-state">
          <h4>No refusals in this run</h4>
          <p>
            Nothing here was declined. Rows that errored, expired or were canceled are retryable instead —
            use “Retry failed” at the top of the run.
          </p>
        </div>
      )}

      {total > 0 && (
        <div className="chart-card">
          <h3>Refusals by category</h3>
          <p className="sub">
            {num(total)} of {num(run.total_requests)} requests came back declined. A refusal is an HTTP 200 with
            stop_reason “refusal”, so it is neither an error nor an answer — it is a decision this model made,
            and re-asking the same model costs money to hear it again.
          </p>
          <svg className="chart-svg" viewBox="0 0 100 12" role="img"
               aria-label={cats.map((c) => `${c.category} ${c.n}`).join(', ')}>
            {segments.map((s) => (
              <rect key={s.category} x={s.x} y="0" width={Math.max(0, s.w - 0.4)} height="9" rx="2" fill={s.colour}>
                <title>{`${s.category}: ${num(s.n)} requests`}</title>
              </rect>
            ))}
          </svg>
          <div className="bx-scroll">
            <table className="viz-table">
              <thead>
                <tr>
                  <th>Category</th>
                  <th style={{ textAlign: 'right' }}>Requests</th>
                  <th style={{ textAlign: 'right' }}>Share</th>
                  <th>What the model said</th>
                </tr>
              </thead>
              <tbody>
                {segments.map((s) => (
                  <tr key={s.category}>
                    <td>
                      <span className="bx-swatch" style={{ background: s.colour, marginRight: 7 }} />
                      <span style={{ color: 'var(--serious)', fontWeight: 700, marginRight: 6 }}>⊘</span>
                      refused · {s.category}
                    </td>
                    <td className="n">{num(s.n)}</td>
                    <td className="n" style={{ color: 'var(--text-dim)' }}>{pctLabel(s.n / total)}</td>
                    <td className="dim" style={{ fontSize: 'var(--t-micro)', maxWidth: 320 }}>{examples[s.category] ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > 0 && (
        <Section title="Rescue these rows on another model"
                 hint="A child run built from exactly the refused rows, keyed so the answers can be folded back onto this one.">
          {cachedBlock && (
            <div style={{ marginBottom: 11 }}>
              <Note tone="warn">
                <strong>The cache does not carry over.</strong> Prompt caches belong to one model, so a rescue
                writes this run’s cached prefix{cachedTokens ? ` (~${num(cachedTokens)} est. tokens)` : ''} again at
                full price on the fallback and reads it back across only {num(total)} request
                {total === 1 ? '' : 's'}. Expect the cost per row to land well above this run’s.
              </Note>
            </div>
          )}

          {!models.length ? (
            <Note tone="info">
              The model catalogue has not loaded, so there is nothing to pick from yet. Open the builder once —
              it fetches the list — then come back.
            </Note>
          ) : (
            <div className="row2" style={{ alignItems: 'end' }}>
              <div>
                <label className="label" htmlFor="bx-fallback">Fallback model</label>
                <select id="bx-fallback" className="field bx-f" style={{ marginTop: 4 }} value={pick}
                        onChange={(e) => setPick(e.target.value)}>
                  {models.map((m) => (
                    <option key={m.id} value={m.id} disabled={m.id === run.model}>
                      {m.label}
                      {m.id === run.model
                        ? ' — this is the model that refused'
                        : m.pricingKnown ? ` — $${m.batchInput}/$${m.batchOutput} per MTok` : ' — pricing unknown'}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary bx-f" style={{ justifyContent: 'center' }}
                      disabled={!pick || pick === run.model || busy !== null || live}
                      onClick={() => void rescue()}>
                {busy === 'rescue' ? 'Submitting…' : `Rescue ${num(total)} row${total === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          <p className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 8, lineHeight: 1.5 }}>
            {live
              ? 'This run is still in flight. Wait for it to end — the refused set is not final until it does.'
              : 'The rescue is priced before it is submitted, so it goes through the per-run spend cap rather than around it. A batch cannot be un-submitted.'}
          </p>
        </Section>
      )}

      <Section title="Rescue runs" hint="Each is a run of its own; merging copies the answers back, never the costs.">
        {!rescues.length ? (
          <div className="bx-state">
            <h4>No rescue has been run yet</h4>
            <p>
              Pick a fallback above and the child run appears here. Its answers stay in it until you merge them,
              so nothing is written onto this run without you asking.
            </p>
          </div>
        ) : (
          <div className="bx-scroll">
            <table className="grid">
              <thead>
                <tr className="label"><th>Run</th><th>Model</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {rescues.map((c) => {
                  const running = ['in_progress', 'submitting', 'canceling'].includes(c.status);
                  return (
                    <tr key={c.id}>
                      <td>
                        <button className="link mono bx-f" onClick={() => onOpen(c.id)}>{c.id}</button>
                        <div className="faint" style={{ fontSize: 'var(--t-micro)', marginTop: 2 }}>{c.name}</div>
                      </td>
                      <td className="mono" style={{ fontSize: 'var(--t-micro)' }}>{c.model}</td>
                      <td><Pill status={c.status} /></td>
                      <td className="r">
                        <button className="btn bx-f" style={{ padding: '3px 9px', fontSize: 'var(--t-small)' }}
                                disabled={busy !== null || running}
                                title={running ? 'Still in flight — merge once it ends.' : ''}
                                onClick={() => void merge(c)}>
                          {busy === c.id ? 'Merging…' : 'Merge into this run'}
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

/* ── P17 · evals ──────────────────────────────────────────────────────── */

/**
 * A/B two runs, read the diff row by row, and pin the dataset.
 *
 * createPair throws when more than one config field differs, and that throw is
 * the feature rather than an inconvenience: a comparison where the model AND
 * the effort moved has measured "Sonnet at low" against "Opus at max" and can
 * attribute the result to neither. The message is shown verbatim.
 */
function EvalsTab({ runId, run, onOpen }: { runId: string; run: any; onOpen: (id: string) => void }) {
  const [pairs, setPairs] = useState<EvalPair[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [diff, setDiff] = useState<any>(null);
  const [verdict, setVerdict] = useState<any>(null);
  const [diffErr, setDiffErr] = useState<string | null>(null);
  const [other, setOther] = useState('');
  const [name, setName] = useState('');
  const [pairErr, setPairErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'all' | 'differs' | 'a' | 'b' | 'tie'>('all');
  const [limit, setLimit] = useState(15);
  const [judgeRun, setJudgeRun] = useState('');
  const [judgeNote, setJudgeNote] = useState<string | null>(null);
  const [judgeErr, setJudgeErr] = useState<string | null>(null);
  const [golden, setGolden] = useState<GoldenSet[] | null>(null);
  const [gName, setGName] = useState('');
  const [gErr, setGErr] = useState<string | null>(null);
  const [gOk, setGOk] = useState<string | null>(null);
  const [gBusy, setGBusy] = useState(false);

  const loadPairs = useCallback(async () => {
    try {
      const all = await window.wanigan.evals.pairs();
      const mine = all.filter((p) => p.runAId === runId || p.runBId === runId);
      setPairs(mine);
      setSel((cur) => (cur && mine.some((p) => p.id === cur) ? cur : mine[0]?.id ?? null));
    } catch { setPairs([]); }
  }, [runId]);

  const loadGolden = useCallback(async () => {
    try { setGolden(await window.wanigan.evals.golden()); } catch { setGolden([]); }
  }, []);

  useEffect(() => { void loadPairs(); }, [loadPairs]);
  useEffect(() => { void loadGolden(); }, [loadGolden]);
  useEffect(() => { window.wanigan.batch.runs().then((r) => setRuns(r as Run[])).catch(() => {}); }, []);

  const loadDiff = useCallback(async (pairId: string) => {
    setDiffErr(null);
    try {
      const [d, s] = await Promise.all([window.wanigan.evals.diff(pairId), window.wanigan.evals.summary(pairId)]);
      setDiff(d); setVerdict(s);
    } catch (e) { setDiffErr(msg(e)); setDiff(null); setVerdict(null); }
  }, []);

  useEffect(() => {
    if (!sel) { setDiff(null); setVerdict(null); return; }
    setLimit(15); setFilter('all');
    void loadDiff(sel);
  }, [sel, loadDiff]);

  async function createPair() {
    if (!other) return;
    setCreating(true); setPairErr(null);
    try {
      const bName = runs.find((r) => r.id === other)?.name ?? other;
      const p = await window.wanigan.evals.createPair(name.trim() || `${run.name} vs ${bName}`, runId, other);
      setName('');
      await loadPairs();
      setSel(p.id);
    } catch (e) { setPairErr(msg(e)); }
    finally { setCreating(false); }
  }

  async function ingest() {
    if (!judgeRun.trim()) return;
    setJudgeErr(null); setJudgeNote(null);
    try {
      const r = await window.wanigan.evals.ingest(judgeRun.trim());
      setJudgeNote(`${num(r.scored)} row${r.scored === 1 ? '' : 's'} scored. Presentation order was randomised per row and un-swapped on the way in, so the verdict is not a position bias.`);
      setJudgeRun('');
      if (sel) await loadDiff(sel);
    } catch (e) { setJudgeErr(msg(e)); }
  }

  async function saveGolden() {
    setGBusy(true); setGErr(null); setGOk(null);
    try {
      const g = await window.wanigan.evals.saveGolden(gName.trim() || `${run.name} — snapshot`, runId);
      setGOk(`Pinned ${num(g.rows)} row${g.rows === 1 ? '' : 's'} as “${g.name}”. A comparison against it next month measures the config, not the tree.`);
      setGName('');
      await loadGolden();
    } catch (e) { setGErr(msg(e)); }
    finally { setGBusy(false); }
  }

  const others = runs.filter((r) => r.id !== runId);
  const pair: EvalPair | undefined = diff?.pair;
  const rows: EvalRowDiff[] = diff?.rows ?? [];
  const sum = diff?.summary;
  const runA = runs.find((r) => r.id === pair?.runAId);
  const runB = runs.find((r) => r.id === pair?.runBId);
  const shown = rows.filter((r) => (
    filter === 'all' ? true : filter === 'differs' ? !r.same : r.winner === filter
  ));

  const wins = verdict
    ? [
        { key: 'A wins', n: verdict.aWins as number, colour: SERIES[0] },
        { key: 'B wins', n: verdict.bWins as number, colour: SERIES[1] },
        { key: 'Ties', n: verdict.ties as number, colour: SERIES[2] },
      ]
    : [];
  const judged = wins.reduce((a, w) => a + w.n, 0);
  let cursor = 0;
  const winSegments = wins.map((w) => {
    const width = judged > 0 ? (w.n / judged) * 100 : 0;
    const seg = { ...w, x: cursor, w: width };
    cursor += width;
    return seg;
  });

  return (
    <div className="bx-lane">
      <Section title="Pair this run with another"
               hint="Exactly one config field may differ. Two moving parts make a story, not a result.">
        {!others.length ? (
          <div className="bx-state">
            <h4>Only one run exists</h4>
            <p>
              A pair needs a second run. Copy this run in the builder, change exactly one field — the model,
              the effort, max_tokens, the template or the schema — and submit it. Then come back here.
            </p>
          </div>
        ) : (
          <>
            <div className="row3" style={{ alignItems: 'end' }}>
              <div>
                <label className="label" htmlFor="bx-b">Compare against</label>
                <select id="bx-b" className="field bx-f" style={{ marginTop: 4 }} value={other}
                        onChange={(e) => { setOther(e.target.value); setPairErr(null); }}>
                  <option value="">Pick a run…</option>
                  {others.map((r) => (
                    <option key={r.id} value={r.id}>{r.name} — {r.model}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="bx-pname">Name (optional)</label>
                <input id="bx-pname" className="field bx-f" style={{ marginTop: 4 }} value={name}
                       placeholder="e.g. effort: high vs medium"
                       onChange={(e) => setName(e.target.value)} />
              </div>
              <button className="btn btn-primary bx-f" style={{ justifyContent: 'center' }}
                      disabled={!other || creating} onClick={() => void createPair()}>
                {creating ? 'Pairing…' : 'Pair runs'}
              </button>
            </div>
            {pairErr && (
              <div style={{ marginTop: 11 }}>
                <Note tone="error">
                  <strong>These two runs cannot be compared.</strong>
                  <span style={{ display: 'block', marginTop: 4 }}>{pairErr}</span>
                </Note>
              </div>
            )}
          </>
        )}

        {pairs && pairs.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 13 }}>
            {pairs.map((p) => (
              <button key={p.id} className="pill bx-f" onClick={() => setSel(p.id)}
                      style={sel === p.id
                        ? { background: 'var(--accent)', color: 'var(--bg)' }
                        : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                {p.name} · {p.variable}
              </button>
            ))}
          </div>
        )}
      </Section>

      {!sel && pairs && pairs.length === 0 && others.length > 0 && (
        <div className="card bx-state">
          <h4>No comparison yet</h4>
          <p>
            Pick a second run above to pair it with this one. Wanigan refuses the pair unless exactly one field
            differs, so whatever the diff shows can be attributed to that field and nothing else.
          </p>
        </div>
      )}

      {diffErr && <Note tone="error"><strong>Could not read the comparison.</strong> {diffErr}</Note>}

      {sel && verdict && pair && (
        <div className="chart-card">
          <h3>Verdict</h3>
          <p className="sub">{verdict.verdict}</p>

          {judged > 0 && (
            <>
              <svg className="chart-svg" viewBox="0 0 100 12" role="img"
                   aria-label={wins.map((w) => `${w.key} ${w.n}`).join(', ')}>
                {winSegments.map((s) => (
                  <rect key={s.key} x={s.x} y="0" width={Math.max(0, s.w - 0.4)} height="9" rx="2" fill={s.colour}>
                    <title>{`${s.key}: ${num(s.n)} rows`}</title>
                  </rect>
                ))}
              </svg>
              <table className="viz-table">
                <thead>
                  <tr><th>Outcome</th><th style={{ textAlign: 'right' }}>Rows</th><th style={{ textAlign: 'right' }}>Share</th></tr>
                </thead>
                <tbody>
                  {wins.map((w) => (
                    <tr key={w.key}>
                      <td><span className="bx-swatch" style={{ background: w.colour, marginRight: 7 }} />{w.key}</td>
                      <td className="n">{num(w.n)}</td>
                      <td className="n" style={{ color: 'var(--text-dim)' }}>{pctLabel(w.n / judged)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          <div className="stat-grid" style={{ marginTop: 12 }}>
            <Stat label="Variable" value={<span style={{ fontSize: 'var(--t-lead)' }}>{pair.variable}</span>} sub="the only field that moved" />
            <Stat label="Mean margin" value={verdict.meanScore === null ? '—' : `${(verdict.meanScore as number).toFixed(1)}/10`}
                  sub={verdict.meanScore === null ? 'no judge has scored this' : 'gap size, not direction'} />
            <Stat label="Cost of B vs A" value={usdDelta(verdict.costDeltaUsd as number)}
                  tone={(verdict.costDeltaUsd as number) > 0 ? 'var(--warn)' : undefined}
                  sub={`A ${usdFine(sum?.costA ?? 0)} · B ${usdFine(sum?.costB ?? 0)}`} />
            <Stat label="Rows matched" value={num((sum?.same ?? 0) + (sum?.different ?? 0))}
                  sub={`${num(sum?.same ?? 0)} identical · ${num(sum?.different ?? 0)} differ`} />
          </div>

          {(sum?.onlyA > 0 || sum?.onlyB > 0) && (
            <div style={{ marginTop: 11 }}>
              <Note tone="warn">
                <strong>The two datasets are not identical.</strong> {num(sum.onlyA)} row
                {sum.onlyA === 1 ? '' : 's'} exist only in A and {num(sum.onlyB)} only in B. Rows are matched by
                custom_id, so this is a glob or a command source that re-read a tree which moved between the two
                submits — a second variable hiding inside “same dataset”. Pin it with a golden set below.
              </Note>
            </div>
          )}

          <div className="sunk bx-lane" style={{ marginTop: 12, padding: 11, gap: 8 }}>
            <span className="label">Score this pair from a judge run</span>
            <p className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.5 }}>
              A verdict without a judge is only “the outputs differ”. Paste the id of a judge run created for
              this pair and its scores land here, un-swapped — the judge sees A and B in a random order per row,
              and skipping the un-swap is how a randomised judge silently becomes a coin flip.
            </p>
            <div style={{ display: 'flex', gap: 7 }}>
              <input className="field mono bx-f" placeholder="run_…" value={judgeRun}
                     onChange={(e) => setJudgeRun(e.target.value)} />
              <button className="btn bx-f" disabled={!judgeRun.trim()} onClick={() => void ingest()}>Ingest scores</button>
            </div>
            {judgeErr && <Note tone="error">{judgeErr}</Note>}
            {judgeNote && <Note tone="ok">{judgeNote}</Note>}
          </div>
        </div>
      )}

      {sel && diff && (
        <Section title="Row by row"
                 hint="Matched on custom_id, never on position — results come back unordered and the two runs were submitted separately."
                 right={
                   <span className="faint bx-num" style={{ fontSize: 'var(--t-micro)' }}
                         title={diff?.truncated
                           ? `This run pair has ${num(diff.totalRows)} matched rows; the row list is capped at ${num(diff.rowLimit)}. The counts and costs above are computed over every row, not just these.`
                           : undefined}>
                     {num(shown.length)} of {num(rows.length)} rows
                     {/* Silent truncation would read as a complete comparison. */}
                     {diff?.truncated && <> · newest {num(diff.rowLimit)} of {num(diff.totalRows)} matched</>}
                   </span>
                 }>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 11 }}>
            {([
              ['all', 'all rows'], ['differs', 'output differs'],
              ['a', 'A wins'], ['b', 'B wins'], ['tie', 'ties'],
            ] as const).map(([k, label]) => (
              <button key={k} className="pill bx-f" onClick={() => setFilter(k)}
                      style={filter === k
                        ? { background: 'var(--accent)', color: 'var(--bg)' }
                        : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                {label}
              </button>
            ))}
          </div>

          <div className="bx-ab" style={{ marginBottom: 9, fontSize: 'var(--t-small)' }}>
            <div>
              <span className="bx-swatch" style={{ background: SERIES[0], marginRight: 6 }} />
              <strong>A</strong> — {runA?.name ?? pair?.runAId} <span className="faint mono">{runA?.model}</span>
            </div>
            <div>
              <span className="bx-swatch" style={{ background: SERIES[1], marginRight: 6 }} />
              <strong>B</strong> — {runB?.name ?? pair?.runBId} <span className="faint mono">{runB?.model}</span>
            </div>
          </div>

          {rows.length === 0 && (
            <div className="bx-state">
              <h4>Neither run has landed a result yet</h4>
              <p>
                Rows appear here as each batch ends. Both sides have to have ingested before a comparison means
                anything — a half-finished run reads as a regression that is really just latency.
              </p>
            </div>
          )}

          {rows.length > 0 && shown.length === 0 && (
            <div className="bx-state">
              <h4>That filter excluded all {num(rows.length)} rows</h4>
              <p>
                {filter === 'differs'
                  ? 'Every matched row produced identical output, so the change made no difference to the text at all — which is itself the result.'
                  : 'No row carries that verdict. Only a judge pass assigns winners; without one, every row is unjudged.'}
              </p>
              <button className="btn bx-f" onClick={() => setFilter('all')}>Show all rows</button>
            </div>
          )}

          <div className="bx-lane" style={{ gap: 9 }}>
            {shown.slice(0, limit).map((r) => (
              <div key={r.customId} className="sunk" style={{ padding: 11 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', fontSize: 'var(--t-small)' }}>
                  <span className="mono" style={{ fontWeight: 600 }}>{r.customId}</span>
                  <WinnerMark winner={r.winner} same={r.same} score={r.score} />
                  <span className="faint mono bx-num" style={{ marginLeft: 'auto' }}>
                    A {usdFine(r.aCost)} · B {usdFine(r.bCost)} · {usdDelta(r.bCost - r.aCost)}
                  </span>
                </div>
                {r.rationale && (
                  <p className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 6, lineHeight: 1.5 }}>{r.rationale}</p>
                )}
                <div className="bx-ab" style={{ marginTop: 8 }}>
                  <OutputSide side="A" status={r.aStatus} text={r.aText} colour={SERIES[0]} />
                  <OutputSide side="B" status={r.bStatus} text={r.bText} colour={SERIES[1]} />
                </div>
              </div>
            ))}
          </div>

          {shown.length > limit && (
            <button className="btn bx-f" style={{ marginTop: 11 }} onClick={() => setLimit(limit + 25)}>
              Show 25 more — {num(shown.length - limit)} still hidden
            </button>
          )}
        </Section>
      )}

      <Section title="Golden sets"
               hint="A glob or a command source re-reads the world at submit time, so “the same dataset” is otherwise a hope.">
        <div className="row2" style={{ alignItems: 'end' }}>
          <div>
            <label className="label" htmlFor="bx-gname">Name this snapshot</label>
            <input id="bx-gname" className="field bx-f" style={{ marginTop: 4 }} value={gName}
                   placeholder={`${run.name} — snapshot`} onChange={(e) => setGName(e.target.value)} />
          </div>
          <button className="btn bx-f" style={{ justifyContent: 'center' }} disabled={gBusy}
                  onClick={() => void saveGolden()}>
            {gBusy ? 'Snapshotting…' : 'Pin this run’s rows'}
          </button>
        </div>
        {gErr && <div style={{ marginTop: 10 }}><Note tone="error">{gErr}</Note></div>}
        {gOk && <div style={{ marginTop: 10 }}><Note tone="ok">{gOk}</Note></div>}

        <div style={{ marginTop: 13 }}>
          {!golden && <p className="dim" style={{ fontSize: 'var(--t-small)' }}>Reading golden sets…</p>}
          {golden && golden.length === 0 && (
            <div className="bx-state">
              <h4>No golden sets yet</h4>
              <p>
                The rows a run actually saw are the only durable record of its dataset. Pin them and a config
                from next month can be compared with one from today and have the comparison mean something.
              </p>
            </div>
          )}
          {golden && golden.length > 0 && (
            <div className="bx-scroll">
              <table className="grid">
                <thead>
                  <tr className="label"><th>Set</th><th className="r">Rows</th><th>From run</th><th className="r">Created</th></tr>
                </thead>
                <tbody>
                  {golden.map((g) => (
                    <tr key={g.id}>
                      <td>{g.name}<div className="faint mono" style={{ fontSize: 'var(--t-micro)', marginTop: 2 }}>{g.id}</div></td>
                      <td className="r mono">{num(g.rows)} rows</td>
                      <td>
                        {g.sourceRunId
                          ? <button className="link mono bx-f" onClick={() => onOpen(g.sourceRunId as string)}>{g.sourceRunId}</button>
                          : <span className="faint">—</span>}
                      </td>
                      <td className="r faint mono">{ago(g.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>
    </div>
  );
}

/** Winner is a status: it carries a glyph and a word, never a hue on its own. */
function WinnerMark({ winner, same, score }: {
  winner: 'a' | 'b' | 'tie' | null; same: boolean; score: number | null;
}) {
  const gap = typeof score === 'number' ? ` · gap ${score.toFixed(1)}/10` : '';
  if (winner === 'a') return <span style={{ color: SERIES[0], fontWeight: 600 }}>◀ A wins{gap}</span>;
  if (winner === 'b') return <span style={{ color: SERIES[1], fontWeight: 600 }}>▶ B wins{gap}</span>;
  if (winner === 'tie') return <span className="dim">= tie{gap}</span>;
  return same
    ? <span className="dim">≡ identical output</span>
    : <span className="dim">≠ differs · unjudged</span>;
}

function OutputSide({ side, status, text, colour }: {
  side: 'A' | 'B'; status: string; text: string | null; colour: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center', marginBottom: 4 }}>
        <span className="bx-swatch" style={{ background: colour }} />
        <span className="label">{side}</span>
        {status === 'missing'
          ? <span className="pill" style={{ background: 'var(--warn-soft)', color: 'var(--warn)' }}>no such row</span>
          : <Pill status={status} />}
      </div>
      <pre className="sunk bx-out">
        {text ?? (status === 'missing'
          ? 'This custom_id does not exist in this run — the datasets drifted between the two submits.'
          : 'No output on this side.')}
      </pre>
    </div>
  );
}
