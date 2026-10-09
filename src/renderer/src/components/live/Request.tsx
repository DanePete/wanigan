// The request behind the page shown, from the site helper's trace: what it
// cost in all, the hooks in the order they fired (filtered by who implements
// them, searched, the slowest marked), its queries (slowest first, or by the
// code that ran them; pointing at one outlines the part it was for), the
// scripts and styles it added, and what it logged. Every number is what the
// helper measured in this one render on this Mac.
import { useMemo, useState } from 'react';
import { queriesByCaller, slowest, truncatedNote, type LiveTraceAnswer, type PartIndex } from '@shared/live-lens';
import type { LiveSite } from '@shared/live';
import type { LiveTrace, TraceQuery } from '@shared/live-trace';
import type { ProjectSummary } from '@shared/model';
import { ago } from '../../lib/format';
import { Select } from '../Select';
import { CopyButton, Segmented } from '../ui';
import { TraceNote } from './TraceNote';
import { bytes, ms, where } from './trace-format';

type Part = 'hooks' | 'queries' | 'assets' | 'logs';
const SLOWEST = 5;
const SHOWN = 400;

export function RequestTab({ answer, site, project, parts, onPoint }: {
  answer: LiveTraceAnswer | null;
  site: LiveSite;
  project: ProjectSummary;
  parts: PartIndex;
  /** Outline a part's regions on the page while a query is pointed at; null to stop. */
  onPoint: (indexes: number[] | null) => void;
}) {
  const [part, setPart] = useState<Part>('hooks');
  if (answer?.state !== 'ok') return <div className="live-side-block"><TraceNote answer={answer} site={site} project={project} /></div>;
  const t = answer.trace;
  const cut = truncatedNote(t);
  const options: { value: Part; label: string }[] = [
    { value: 'hooks', label: `Hooks ${t.hooks?.length ?? 0}` },
    { value: 'queries', label: `Queries ${t.queries?.length ?? 0}` },
    { value: 'assets', label: `Assets ${t.assets?.length ?? 0}` },
    { value: 'logs', label: `Logs ${t.logs?.length ?? 0}` },
  ];
  return (
    <div className="live-request">
      <Totals trace={t} />
      {cut ? <p className="live-note small" role="status">{cut}</p> : null}
      <Segmented<Part> size="s" label="Request detail" value={part} options={options} onChange={setPart} />
      {part === 'hooks' ? <Hooks trace={t} /> : part === 'queries' ? <Queries trace={t} parts={parts} onPoint={onPoint} /> : part === 'assets' ? <Assets trace={t} /> : <Logs trace={t} />}
    </div>
  );
}

function Totals({ trace: t }: { trace: LiveTrace }) {
  const stats: [string, string, string | null][] = [
    ['Time', ms(t.total.ms), null],
    ['Queries', t.total.queries !== undefined ? String(t.total.queries) : '—', t.total.queryMs !== undefined ? ms(t.total.queryMs) : null],
    ['Memory', t.total.memoryBytes !== undefined ? bytes(t.total.memoryBytes) : '—', null],
    ['Hooks', t.total.hooks !== undefined ? String(t.total.hooks) : String(t.hooks?.length ?? '—'), null],
  ];
  return (
    <div className="live-totals">
      <dl className="live-stats">
        {stats.map(([k, v, sub]) => (
          <div key={k} className="live-stat">
            <dt className="faint small">{k}</dt>
            <dd>{v}</dd>
            {sub ? <dd className="faint small">{sub}</dd> : null}
          </div>
        ))}
      </dl>
      <p className="faint small">
        <span className="mono">{t.url}</span>, rendered by {t.platform === 'drupal' ? 'Drupal' : 'WordPress'}{t.at ? ` ${ago(t.at)}` : ''}
        {t.user ? ` for ${t.user.name}${t.user.roles.length ? ` (${t.user.roles.join(', ')})` : ''}` : ''}, in {t.parts.length} parts. Measured in that render, on this Mac.
      </p>
    </div>
  );
}

function Hooks({ trace }: { trace: LiveTrace }) {
  const hooks = trace.hooks ?? [];
  const [by, setBy] = useState('');
  const [query, setQuery] = useState('');
  const owners = useMemo(() => [...new Set(hooks.map((h) => h.by))].sort(), [hooks]);
  const slow = useMemo(() => slowest(hooks, SLOWEST), [hooks]);
  const longest = useMemo(() => hooks.reduce((m, h) => Math.max(m, h.ms ?? 0), 0), [hooks]);
  if (!hooks.length) return <p className="faint small">The helper reported no hooks for this request.</p>;
  const q = query.trim().toLowerCase();
  const shown = hooks.map((h, i) => ({ h, i })).filter(({ h }) => (!by || h.by === by)
    && (!q || h.hook.toLowerCase().includes(q) || h.by.toLowerCase().includes(q) || (h.callback ?? '').toLowerCase().includes(q)));
  return (
    <div className="live-side-block">
      <div className="live-request-filters">
        <Select<string> label="Implemented by" size="s" value={by} onChange={setBy}
          options={[{ value: '', label: `Every ${trace.platform === 'drupal' ? 'module and theme' : 'plugin and theme'}` }, ...owners.map((o) => ({ value: o, label: o }))]} />
        <label className="search-field live-request-search">
          <span className="visually-hidden">Search hooks</span>
          <input type="search" placeholder="Search hooks" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </div>
      <p className="faint small">{shown.length === hooks.length ? `${hooks.length} in the order they fired` : `${shown.length} of ${hooks.length}`}; the {SLOWEST} slowest are marked.</p>
      <ol className="live-timeline" aria-label="Hooks in the order they fired">
        {shown.slice(0, SHOWN).map(({ h, i }) => (
          <li key={i} className={`live-hook${slow.has(i) ? ' slow' : ''}`}>
            <span className="live-hook-bar" aria-hidden="true"><span style={{ inlineSize: `${longest ? Math.max(2, ((h.ms ?? 0) / longest) * 100) : 0}%` }} /></span>
            <span className="live-hook-name">
              <span className="mono small">{h.hook}</span>
              {h.ms !== undefined ? <span className="live-ms small">{ms(h.ms)}{slow.has(i) ? <span className="visually-hidden"> (one of the slowest)</span> : null}</span> : null}
            </span>
            <span className="faint small">{h.by}{h.callback ? ` · ${h.callback}` : ''}{h.priority !== undefined ? ` · priority ${h.priority}` : ''}</span>
            {h.changed?.length ? <span className="small">Changed <span className="mono">{h.changed.join(', ')}</span></span> : null}
          </li>
        ))}
      </ol>
      {shown.length > SHOWN ? <p className="faint small">The first {SHOWN} are shown; search or filter to find the rest.</p> : null}
    </div>
  );
}

function QueryRow({ q, parts, onPoint }: { q: TraceQuery; parts: PartIndex; onPoint: (indexes: number[] | null) => void }) {
  const regions = q.part ? parts.regionsOf.get(q.part) ?? [] : [];
  const label = q.part ? parts.parts.get(q.part)?.label ?? null : null;
  const point = (): void => onPoint(regions.length ? regions : null);
  return (
    <li className="live-query" onMouseEnter={point} onMouseLeave={() => onPoint(null)} onFocus={point} onBlur={() => onPoint(null)}>
      <span className="live-query-head">
        <span className="live-ms small">{ms(q.ms)}</span>
        {q.rows !== undefined ? <span className="faint small">{q.rows} {q.rows === 1 ? 'row' : 'rows'}</span> : null}
        {label ? <span className="small live-query-part" title={regions.length ? 'Outlined on the page while pointed at' : 'Not on this page'}>for {label}</span> : null}
        <CopyButton text={q.sql} label="Copy the SQL" what="the query" />
      </span>
      <code className="live-sql">{q.sql}</code>
      {q.caller ? <span className="mono small faint">{where(q.caller)}</span> : null}
    </li>
  );
}

function Queries({ trace, parts, onPoint }: { trace: LiveTrace; parts: PartIndex; onPoint: (indexes: number[] | null) => void }) {
  const [grouped, setGrouped] = useState(false);
  const list = useMemo(() => [...(trace.queries ?? [])].sort((a, b) => b.ms - a.ms), [trace]);
  const groups = useMemo(() => (grouped ? queriesByCaller(list) : []), [grouped, list]);
  if (!list.length) return <p className="faint small">The helper reported no queries for this request.</p>;
  return (
    <div className="live-side-block" onMouseLeave={() => onPoint(null)}>
      <label className="live-check small">
        <input type="checkbox" checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
        <span>Group by the code that ran them</span>
      </label>
      <p className="faint small">Slowest first. Pointing at one outlines the part it was for.</p>
      {grouped ? groups.map((g) => (
        <section key={g.caller} className="live-query-group" aria-label={`${g.caller}: ${g.queries.length} queries, ${ms(g.ms)}`}>
          <h4 className="live-query-caller"><span className="mono small">{g.caller}</span><span className="live-ms small">{g.queries.length} · {ms(g.ms)}</span></h4>
          <ol className="live-queries">{g.queries.slice(0, 50).map((q, i) => <QueryRow key={i} q={q} parts={parts} onPoint={onPoint} />)}</ol>
        </section>
      )) : (
        <ol className="live-queries" aria-label="Queries, slowest first">{list.slice(0, SHOWN).map((q, i) => <QueryRow key={i} q={q} parts={parts} onPoint={onPoint} />)}</ol>
      )}
    </div>
  );
}

function Assets({ trace }: { trace: LiveTrace }) {
  const assets = trace.assets ?? [];
  if (!assets.length) return <p className="faint small">The helper reported no scripts or styles for this request.</p>;
  const total = assets.reduce((n, a) => n + (a.bytes ?? 0), 0);
  return (
    <div className="live-side-block">
      <p className="faint small">{assets.filter((a) => a.kind === 'script').length} scripts, {assets.filter((a) => a.kind === 'style').length} stylesheets{total ? `, ${bytes(total)} where sizes were reported` : ''}.</p>
      <ul className="live-assets">
        {assets.map((a, i) => (
          <li key={`${a.handle}-${i}`}>
            <span className="live-asset-head">
              <span className="lib-tag">{a.kind === 'script' ? 'Script' : 'Style'}</span>
              <span className="small">{a.handle}</span>
              {a.bytes !== undefined ? <span className="faint small">{bytes(a.bytes)}</span> : null}
            </span>
            <span className="faint small">Added by {a.by}</span>
            <span className="mono small faint live-asset-src" title={a.src}>{a.src}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const LEVEL = { error: 'Error', warning: 'Warning', notice: 'Notice', info: 'Info' } as const;

function Logs({ trace }: { trace: LiveTrace }) {
  const logs = trace.logs ?? [];
  if (!logs.length) return <p className="faint small">Nothing was logged while this page rendered.</p>;
  return (
    <ul className="live-problems">
      {logs.map((l, i) => (
        <li key={i} className={`live-problem-item ${l.level === 'error' ? 'error' : ''}`}>
          <span className="live-problem-level">{LEVEL[l.level]}{l.source ? ` · ${where(l.source)}` : ''}</span>
          <span className="small mono">{l.message}</span>
        </li>
      ))}
    </ul>
  );
}
