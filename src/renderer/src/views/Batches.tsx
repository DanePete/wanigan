import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Project, RunConfig, SourceConfig } from '@shared/types';
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

export default function Batches({ projects, hasKey, onNeedKey }: {
  projects: Project[]; hasKey: boolean; onNeedKey: () => void;
}) {
  const [view, setView] = useState<{ page: 'list' } | { page: 'new' } | { page: 'detail'; id: string }>({ page: 'list' });
  if (view.page === 'new') {
    return <NewRun projects={projects} hasKey={hasKey} onNeedKey={onNeedKey}
                   onDone={(id) => setView({ page: 'detail', id })} onCancel={() => setView({ page: 'list' })} />;
  }
  if (view.page === 'detail') {
    return <RunDetail id={view.id} onBack={() => setView({ page: 'list' })}
                      onOpen={(id) => setView({ page: 'detail', id })} />;
  }
  return <RunList onNew={() => setView({ page: 'new' })} onOpen={(id) => setView({ page: 'detail', id })} />;
}

/* ── list ─────────────────────────────────────────────────────────────── */

function RunList({ onNew, onOpen }: { onNew: () => void; onOpen: (id: string) => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try { setRuns((await window.foreman.batch.runs()) as Run[]); } catch { /* db not ready */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
    const off = window.foreman.on.batchChanged(() => void load());
    const t = setInterval(load, 8000);
    return () => { off(); clearInterval(t); };
  }, [load]);

  const active = runs.filter((r) => ['in_progress', 'submitting', 'canceling'].includes(r.status));
  const spent = runs.reduce((a, r) => a + (r.cost_usd || 0), 0);

  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h1>Batches</h1>
          <p className="dim">Bulk work across your repos, asynchronous, at half price.</p>
        </div>
        <button className="btn btn-primary" onClick={onNew}>New run</button>
      </div>

      <div className="stat-grid">
        <Stat label="Runs" value={num(runs.length)} />
        <Stat label="Active" value={num(active.length)} tone={active.length ? 'var(--accent)' : undefined}
              sub={active.reduce((a, r) => a + r.pending, 0) ? `${num(active.reduce((a, r) => a + r.pending, 0))} in flight` : 'nothing in flight'} />
        <Stat label="Spent" value={usd(spent)} sub="batch rates" />
        <Stat label="Saved vs sync" value={usd(spent)} tone="var(--ok)" sub="batch is 50% of list" />
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
            {runs.map((r) => {
              const exp = until(r.expires_at);
              return (
                <tr key={r.id} onClick={() => onOpen(r.id)} className="clickable">
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.name}</div>
                    <div className="faint mono" style={{ fontSize: 10.5, marginTop: 2 }}>
                      {r.model}{r.project_name && ` · ${r.project_name}`}{r.parent_run_id && ' · retry'}
                    </div>
                  </td>
                  <td><Pill status={r.status} /></td>
                  <td className="r mono">{num(r.total_requests)}</td>
                  <td style={{ minWidth: 140 }}>
                    <Bar succeeded={r.succeeded} failed={r.failed} pending={r.pending} />
                    <div className="faint mono" style={{ fontSize: 10.5, marginTop: 4, display: 'flex', gap: 8 }}>
                      <span style={{ color: r.succeeded ? 'var(--ok)' : undefined }}>{num(r.succeeded)} ok</span>
                      {r.failed > 0 && <span style={{ color: 'var(--bad)' }}>{num(r.failed)} failed</span>}
                      {r.pending > 0 && <span>{num(r.pending)} pending</span>}
                    </div>
                  </td>
                  <td className="r mono">{r.cost_usd ? usd(r.cost_usd) : <span className="faint">~{usd(r.est_cost_usd)}</span>}</td>
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
    </div>
  );
}

/* ── builder ──────────────────────────────────────────────────────────── */

function NewRun({ projects, hasKey, onNeedKey, onDone, onCancel }: {
  projects: Project[]; hasKey: boolean; onNeedKey: () => void;
  onDone: (id: string) => void; onCancel: () => void;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [catalog, setCatalog] = useState<{ fetchedAt: number | null; stale: boolean }>({ fetchedAt: null, stale: true });
  const [refreshingModels, setRefreshingModels] = useState(false);
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
    window.foreman.batch.presets(projects[0]?.id).then((d) => {
      setPresets(d.presets); setModels(d.models);
      setCatalog({ fetchedAt: d.modelsFetchedAt, stale: d.modelsStale });
      setCfg({ name: '', projectId: projects[0]?.id, ...d.presets[0].config });
    });
  }, [projects]);

  const model = useMemo(() => models.find((m) => m.id === cfg?.model), [models, cfg?.model]);

  async function refreshCatalog() {
    setRefreshingModels(true);
    try {
      const r = await window.foreman.batch.refreshModels();
      const d = await window.foreman.batch.presets(projectId);
      setModels(d.models); setCatalog({ fetchedAt: d.modelsFetchedAt, stale: d.modelsStale });
    } catch (e) { /* surfaced by the estimate path */ }
    finally { setRefreshingModels(false); }
  }
  const patch = (p: Partial<RunConfig>) => setCfg((c) => (c ? { ...c, ...p } : c));
  const invalidate = () => { setEst(null); setDry(null); };

  async function applyPreset(id: string) {
    const d = await window.foreman.batch.presets(projectId);
    const p = (d.presets as Preset[]).find((x) => x.id === id);
    if (!p) return;
    setCfg({ name: cfg?.name || '', projectId, ...p.config });
    setPresets(d.presets); setPreview(null); setPreviewErr(null); invalidate();
  }

  async function changeProject(id: string) {
    // Re-resolve presets so their example paths point at the new project.
    const d = await window.foreman.batch.presets(id);
    setPresets(d.presets);
    const p = (d.presets as Preset[]).find((x) => x.id === cfg?.preset);
    setCfg((c) => (c ? { ...c, projectId: id, ...(p ? { source: p.config.source } : {}) } : c));
    setPreview(null); invalidate();
  }

  async function loadPreview() {
    if (!cfg) return;
    setLoadingPreview(true); setPreviewErr(null); invalidate();
    try { setPreview(await window.foreman.batch.preview(cfg.source, cfg.userTemplate)); }
    catch (e) { setPreviewErr(e instanceof Error ? e.message : String(e)); setPreview(null); }
    finally { setLoadingPreview(false); }
  }

  async function runEstimate(observed?: number) {
    if (!cfg) return;
    if (!hasKey) { onNeedKey(); return; }
    setEstimating(true);
    try {
      const d = await window.foreman.batch.estimate(cfg, observed);
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
      const d = await window.foreman.batch.dryRun(cfg, 0);
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
      const r = await window.foreman.batch.submit(cfg, {
        input: est.totalInputTokens, output: est.worstCaseOutputTokens, cost: est.costLowUsd,
      });
      onDone(r.runId);
    } catch (e) { setSubmitErr(e instanceof Error ? e.message : String(e)); setSubmitting(false); }
  }

  if (!cfg) return <div className="pane"><p className="dim">Loading…</p></div>;

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
            <button className="faint" style={{ fontSize: 12 }} onClick={onCancel}>← Batches</button>
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
                <div style={{ fontWeight: 600, fontSize: 12.5 }}>{p.label}</div>
                <div className="dim" style={{ fontSize: 11, marginTop: 4, lineHeight: 1.4 }}>{p.blurb}</div>
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
            {(['csv', 'jsonl', 'glob', 'command'] as const).map((k) => (
              <button key={k} className="pill" onClick={() => { patch({ source: defaultSource(k) }); setPreview(null); invalidate(); }}
                      style={cfg.source.kind === k ? { background: 'var(--accent)', color: '#0c0e12' }
                                                   : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                {({ csv: 'CSV', jsonl: 'JSONL', glob: 'Files', command: 'Command' } as const)[k]}
              </button>
            ))}
          </div>
          <SourceEditor source={cfg.source} onChange={(s) => { patch({ source: s }); setPreview(null); invalidate(); }} />
          {previewErr && <div style={{ marginTop: 11 }}><Note tone="error">{previewErr}</Note></div>}
          {preview && (
            <div style={{ marginTop: 11 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 7 }}>
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
        </Section>

        <Section n={3} title="Prompt"
                 hint="Cached blocks must be byte-identical on every request — that is why shared context lives here, not in the per-row template.">
          {cfg.system.map((b, i) => (
            <div key={i} style={{ marginBottom: 11 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className="label">System block {cfg.system.length > 1 ? i + 1 : ''}</span>
                <label style={{ marginLeft: 'auto', display: 'flex', gap: 5, alignItems: 'center', fontSize: 11.5, cursor: 'pointer' }}>
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
            <span className="faint" style={{ fontSize: 11 }}>{'{{column}}'} binds to dataset columns</span>
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
          <p className="faint" style={{ fontSize: 11, marginBottom: 9, lineHeight: 1.45 }}>
            {catalog.fetchedAt
              ? <>Capabilities read from the Models API{catalog.stale ? ' — over a day old' : ''}. Only models that support the Batch API are listed.</>
              : <>Using the local model table. Add an API key and refresh to read live capabilities, context windows and effort levels.</>}
          </p>
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
                <p className="faint" style={{ fontSize: 11, marginTop: 3 }}>
                  {num(model.maxInputTokens)} token context
                </p>
              ) : null}
            </div>
            <div>
              <label className="label">Max tokens</label>
              <input type="number" min={1} className="field" style={{ marginTop: 4 }} value={cfg.maxTokens}
                     onChange={(e) => { patch({ maxTokens: Number(e.target.value) }); invalidate(); }} />
              <p className="faint" style={{ fontSize: 11, marginTop: 3 }}>cap {num(cfg.extendedOutput ? 300000 : model?.maxTokens ?? 0)}</p>
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
                            ? { background: 'var(--accent)', color: '#0c0e12' }
                            : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>
                    {lvl}
                  </button>
                ))}
              </div>
              <p className="faint" style={{ fontSize: 11, marginTop: 5, lineHeight: 1.45 }}>
                {EFFORT_HINT[cfg.effort ?? 'high']} Effort is part of the rendered prompt, so it is set
                once per run — changing it mid-run would invalidate the cached prefix.
              </p>
            </div>
          )}

          <div style={{ display: 'flex', gap: 16, marginTop: 13, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}
                   title={model?.extendedOutput ? '' : `${model?.label ?? 'This model'} does not support extended output`}>
              <input type="checkbox" disabled={!model?.extendedOutput} checked={!!cfg.extendedOutput}
                     onChange={(e) => { patch({ extendedOutput: e.target.checked }); invalidate(); }} />
              Extended output (300k max_tokens, batch only)
            </label>
            {model?.thinkingAdaptive && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={cfg.thinking === 'adaptive'}
                       onChange={(e) => { patch({ thinking: e.target.checked ? 'adaptive' : 'off' }); invalidate(); }} />
                Adaptive thinking
              </label>
            )}
            {cfg.thinking === 'adaptive' && (
              <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12 }}>
                <input type="checkbox" checked={cfg.thinkingDisplay === 'summarized'}
                       onChange={(e) => { patch({ thinkingDisplay: e.target.checked ? 'summarized' : 'omitted' }); invalidate(); }} />
                Return a reasoning summary
              </label>
            )}
          </div>
          <details style={{ marginTop: 13 }} open={!!cfg.schemaJson}>
            <summary className="dim" style={{ cursor: 'pointer', fontSize: 12 }}>
              Structured output schema {cfg.schemaJson ? '(set)' : '(optional)'}
              {model && !model.supportsStructuredOutputs && (
                <span style={{ color: 'var(--warn)' }}> — {model.label} does not support this</span>
              )}
            </summary>
            <p className="faint" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.45 }}>
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
          <h2 style={{ fontSize: 13.5, fontWeight: 600 }}>Pre-flight</h2>
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
          <p className="faint" style={{ fontSize: 11, lineHeight: 1.45 }}>
            Batch validation is asynchronous — a malformed request is not reported until the whole
            batch ends. The dry run sends one row synchronously to find that now.
          </p>

          {estMeta?.errors.length ? <Note tone="error">{estMeta.errors.join(' ')}</Note> : null}
          {estMeta?.warnings.map((w, i) => <Note key={i} tone="warn">{w}</Note>)}

          {est && (
            <>
              <div className="stat-2">
                <Stat label="Requests" value={num(est.requests)} sub={est.chunks > 1 ? `${est.chunks} batches` : '1 batch'} />
                <Stat label="Est. cost" value={usd(est.costLowUsd)} sub={`up to ${usd(est.costHighUsd)}`} tone="var(--accent)" />
              </div>
              <div className="sunk" style={{ padding: '9px 11px', fontSize: 12, lineHeight: 1.7 }}>
                <KV k="Mean input" v={`${num(est.meanInputTokens)} tok`} note={`sampled ${est.sampledRows}`} />
                {est.cachedPrefixTokens > 0 && <KV k="Cached prefix" v={`${num(est.cachedPrefixTokens)} tok`} note="written once" />}
                <KV k={est.observedOutputTokens ? 'Output (measured)' : 'Output (assumed)'}
                    v={`${num(est.observedOutputTokens ?? Math.round(est.worstCaseOutputTokens * 0.25 / est.requests))} tok/row`} />
                <KV k="Same work, sync" v={usd(est.syncCostHighUsd)} note="you save half" />
              </div>
              {est.notes?.map((n: string, i: number) => <p key={i} className="faint" style={{ fontSize: 11, lineHeight: 1.45 }}>{n}</p>)}
            </>
          )}

          {dry?.result && (dry.result.ok
            ? <>
                <Note tone="ok">Dry run passed — the request shape is valid.</Note>
                <pre className="sunk mono scroll-y" style={{ padding: 10, maxHeight: 170 }}>{dry.result.text}</pre>
              </>
            : <Note tone="error"><strong>Dry run failed.</strong> {dry.result.message}</Note>)}

          <div style={{ borderTop: '1px solid var(--line)', paddingTop: 11 }}>
            <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center' }}
                    disabled={!!blockers.length || submitting} onClick={submit}>
              {submitting ? 'Submitting…' : est ? `Submit — ${usd(est.costLowUsd)}` : 'Submit'}
            </button>
            {blockers.length > 0 && (
              <p className="faint" style={{ fontSize: 11, marginTop: 7, textAlign: 'center' }}>Still to do: {blockers.join(', ')}.</p>
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
  }
}

function SourceEditor({ source, onChange }: { source: SourceConfig; onChange: (s: SourceConfig) => void }) {
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
  if (source.kind === 'glob') {
    return (
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
      <p className="faint" style={{ fontSize: 11, marginTop: 4 }}>
        Runs in your shell with your permissions — the same trust boundary as a terminal.
      </p>
    </>
  );
}

/* ── detail ───────────────────────────────────────────────────────────── */

function RunDetail({ id, onBack, onOpen }: { id: string; onBack: () => void; onOpen: (id: string) => void }) {
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<'results' | 'batches' | 'events' | 'config'>('results');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const loadDetail = useCallback(async () => { try { setD(await window.foreman.batch.run(id)); } catch { /* deleted */ } }, [id]);
  const loadRows = useCallback(async () => {
    const r = await window.foreman.batch.results(id, filter, q, offset);
    setRows(r.rows); setTotal(r.total);
  }, [id, filter, q, offset]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => { void loadRows(); }, [loadRows]);
  useEffect(() => {
    if (!d) return;
    if (!['in_progress', 'submitting', 'canceling'].includes(d.run.status)) return;
    const t = setInterval(() => { void loadDetail(); void loadRows(); }, 8000);
    return () => clearInterval(t);
  }, [d, loadDetail, loadRows]);

  if (!d) return <div className="pane"><p className="dim">Loading…</p></div>;

  const { run, counts } = d;
  const succeeded = counts.succeeded ?? 0;
  const failed = (counts.errored ?? 0) + (counts.expired ?? 0) + (counts.canceled ?? 0);
  const pending = counts.pending ?? 0;
  const live = ['in_progress', 'submitting', 'canceling'].includes(run.status);
  const soonest = d.batches.filter((b: any) => b.processing_status !== 'ended').map((b: any) => b.expires_at).filter(Boolean).sort()[0];
  const exp = until(soonest);
  const done = succeeded + failed;
  const pct = run.total_requests ? Math.round((done / run.total_requests) * 100) : 0;

  async function act(fn: () => Promise<any>, label: string) {
    setBusy(label);
    try {
      const r = await fn();
      if (r?.runId) { onOpen(r.runId); return; }
      await loadDetail(); await loadRows();
    } catch (e) { alert(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  }

  return (
    <div className="pane">
      <div className="pane-head">
        <div style={{ minWidth: 0 }}>
          <button className="faint" style={{ fontSize: 12 }} onClick={onBack}>← Batches</button>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 3 }}>
            <h1>{run.name}</h1><Pill status={run.status} />
          </div>
          <p className="faint mono" style={{ fontSize: 11, marginTop: 3 }}>{run.id} · {run.model}</p>
        </div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {live && <button className="btn btn-danger" disabled={busy === 'cancel'}
                           onClick={() => act(() => window.foreman.batch.cancel(id), 'cancel')}>
            {busy === 'cancel' ? 'Canceling…' : 'Cancel run'}</button>}
          {!live && failed > 0 && <button className="btn" disabled={busy === 'retry'}
                           onClick={() => act(() => window.foreman.batch.retry(id), 'retry')}>
            {busy === 'retry' ? 'Resubmitting…' : `Retry ${num(failed)} failed`}</button>}
          <button className="btn" onClick={() => window.foreman.batch.exportTo(id, 'jsonl')}>Export JSONL</button>
          <button className="btn" onClick={() => window.foreman.batch.exportTo(id, 'csv')}>Export CSV</button>
        </div>
      </div>

      {run.error && <Note tone="error"><strong>Run failed.</strong> {run.error}</Note>}
      {d.children.length > 0 && (
        <Note tone="info">Retried as {d.children.map((c: any) => (
          <button key={c.id} className="mono" style={{ textDecoration: 'underline' }} onClick={() => onOpen(c.id)}>{c.id}</button>
        ))}.</Note>
      )}

      <div className="stat-grid-5">
        <Stat label="Progress" value={`${pct}%`} sub={`${num(done)} of ${num(run.total_requests)}`} />
        <Stat label="Succeeded" value={num(succeeded)} tone={succeeded ? 'var(--ok)' : undefined} />
        <Stat label="Failed" value={num(failed)} tone={failed ? 'var(--bad)' : undefined} sub={failed ? 'retryable' : 'none'} />
        <Stat label="Cost" value={run.cost_usd ? usd(run.cost_usd) : `~${usd(run.est_cost_usd)}`} sub={run.cost_usd ? 'actual' : 'estimated'} />
        <Stat label={live ? 'Expires in' : 'Duration'}
              value={live ? exp.text : run.ended_at && run.submitted_at ? `${Math.max(1, Math.round((run.ended_at - run.submitted_at) / 60000))}m` : '—'}
              tone={live && exp.urgent ? 'var(--warn)' : undefined} sub={live ? '24h hard limit' : ago(run.ended_at)} />
      </div>

      <div className="card" style={{ padding: 13 }}>
        <Bar succeeded={succeeded} failed={failed} pending={pending} />
        <div className="faint mono" style={{ display: 'flex', gap: 12, marginTop: 8, fontSize: 11 }}>
          <span>{num(run.in_tokens)} in</span><span>{num(run.out_tokens)} out</span>
          {run.cache_read > 0 && <span style={{ color: 'var(--ok)' }}>{num(run.cache_read)} cache read</span>}
          {run.cache_write > 0 && <span>{num(run.cache_write)} cache write</span>}
          <span style={{ marginLeft: 'auto' }}>{d.batches.length} batch{d.batches.length === 1 ? '' : 'es'}</span>
        </div>
      </div>

      <div className="tabs">
        {(['results', 'batches', 'events', 'config'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={tab === t ? 'tab-on' : ''}>
            {t}{t === 'results' && total ? ` (${num(total)})` : ''}
          </button>
        ))}
      </div>

      {tab === 'results' && (
        <>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {['all', 'succeeded', 'failed', 'pending'].map((f) => (
              <button key={f} className="pill" onClick={() => { setFilter(f); setOffset(0); }}
                      style={filter === f ? { background: 'var(--accent)', color: '#0c0e12' }
                                          : { background: 'var(--bg-sunk)', color: 'var(--text-dim)' }}>{f}</button>
            ))}
            <input className="field" style={{ marginLeft: 'auto', maxWidth: 260 }} placeholder="Search prompts, output, errors…"
                   value={q} onChange={(e) => { setQ(e.target.value); setOffset(0); }} />
          </div>
          <div className="card scroll-x">
            <table className="grid">
              <thead><tr className="label"><th>custom_id</th><th>Status</th><th>Output</th><th className="r">Tokens</th></tr></thead>
              <tbody>
                {!rows.length && <tr><td colSpan={4} className="dim center">
                  {pending ? 'Still processing — results land as batches end.' : 'No rows match.'}</td></tr>}
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
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12 }}>
              <button className="btn" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>Previous</button>
              <span className="dim">{num(offset + 1)}–{num(Math.min(offset + 50, total))} of {num(total)}</span>
              <button className="btn" disabled={offset + 50 >= total} onClick={() => setOffset(offset + 50)}>Next</button>
            </div>
          )}
        </>
      )}

      {tab === 'batches' && (
        <div className="card scroll-x">
          <table className="grid">
            <thead><tr className="label"><th>Batch</th><th>Status</th><th className="r">Requests</th><th>Counts</th><th className="r">Expires</th><th className="r">Polled</th></tr></thead>
            <tbody>
              {d.batches.map((b: any) => {
                const c = b.counts_json ? JSON.parse(b.counts_json) : {};
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

      {tab === 'events' && (
        <div className="card">
          {!d.events.length && <p className="dim" style={{ padding: 14 }}>No events.</p>}
          {d.events.map((e: any, i: number) => (
            <div key={i} style={{ display: 'flex', gap: 11, padding: '7px 14px', fontSize: 12, borderTop: i ? '1px solid var(--line)' : undefined }}>
              <span className="faint mono" style={{ flex: 'none' }}>{new Date(e.at).toLocaleTimeString()}</span>
              <span style={{ color: e.level === 'error' ? 'var(--bad)' : e.level === 'warn' ? 'var(--warn)' : undefined }}>{e.message}</span>
            </div>
          ))}
        </div>
      )}

      {tab === 'config' && <pre className="card mono scroll-y" style={{ padding: 14, maxHeight: 560 }}>{JSON.stringify(d.config, null, 2)}</pre>}

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', gap: 11, alignItems: 'center' }}>
              <h3 className="mono" style={{ fontSize: 13.5, fontWeight: 600 }}>{open.custom_id}</h3>
              <Pill status={open.status} />
              <button className="btn" style={{ marginLeft: 'auto' }} onClick={() => setOpen(null)}>Close</button>
            </div>
            <div className="faint mono" style={{ fontSize: 11, marginTop: 4 }}>
              row {open.row_index}
              {open.stop_reason && ` · stop_reason: ${open.stop_reason}`}
              {open.in_tokens > 0 && ` · ${num(open.in_tokens)} in / ${num(open.out_tokens)} out`}
            </div>
            {open.error_message && <div style={{ marginTop: 11 }}><Note tone="error"><strong>{open.error_type}</strong> — {open.error_message}</Note></div>}
            <div style={{ display: 'grid', gap: 14, marginTop: 14 }}>
              <div><div className="label" style={{ marginBottom: 4 }}>Prompt sent</div>
                <pre className="sunk mono scroll-y" style={{ padding: 11, maxHeight: 260 }}>{open.rendered}</pre></div>
              {open.output_text && <div><div className="label" style={{ marginBottom: 4 }}>Output</div>
                <pre className="sunk mono scroll-y" style={{ padding: 11, maxHeight: 340 }}>{open.output_text}</pre></div>}
              <div><div className="label" style={{ marginBottom: 4 }}>Source row</div>
                <pre className="sunk mono scroll-y" style={{ padding: 11, maxHeight: 200 }}>{JSON.stringify(JSON.parse(open.row_json), null, 2)}</pre></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
