// What the site helper's trace says about a chosen part, in the Inspector:
// who made it and the hooks that shaped it, its data, every way to edit it,
// its cache, its cost and queries, its revisions and who may see it. The most
// used open by default; the rest open on request and say in one line what
// they hold.
import type { EditTarget, LiveTrace, TracePart, TraceStep } from '@shared/live-trace';
import { partQueries } from '@shared/live-lens';
import { ago } from '../../lib/format';
import { Button, CopyButton, Disclosure } from '../ui';
import { OWNER_LABEL, maxAge, ms, ownerClass, where } from './trace-format';

const EDIT_KIND: Record<EditTarget['kind'], string> = {
  field: 'Field', property: 'Property', 'block-attributes': 'Block settings', config: 'Configuration', option: 'Site option', meta: 'Post meta',
  props: 'Component props', 'menu-link': 'Menu link', 'template-override': 'Template override',
};

/** Its source and owner, and the chain of hooks that shaped it, slowest marked. For the Made by section. */
export function TraceMadeBy({ part, edits, onEdit }: { part: TracePart; edits: Map<string, EditTarget>; onEdit: (t: EditTarget) => void }) {
  const chain = part.chain ?? [];
  const slow = chain.reduce((m, s) => Math.max(m, s.ms ?? 0), 0);
  const override = (part.edits ?? []).map((id) => edits.get(id)).find((e): e is EditTarget => !!e && e.kind === 'template-override' && !e.why);
  return (
    <div className="live-trace-made">
      {part.source ? (
        <div className="live-made-file">
          <span className="mono small" title={where(part.source)}>{where(part.source)}</span>
          <span className={`live-origin ${ownerClass(part.source.owner)}`}>{OWNER_LABEL[part.source.owner]}{part.source.package ? ` · ${part.source.package}` : ''}</span>
          <CopyButton text={where(part.source)} label="Copy the file’s path" what="the path" />
        </div>
      ) : null}
      {chain.length ? (
        <ol className="live-chain" aria-label="What shaped it, in the order it ran">
          {chain.map((s, i) => <ChainStep key={`${s.hook}-${i}`} step={s} slowest={!!s.ms && s.ms === slow && chain.length > 1} />)}
        </ol>
      ) : null}
      {part.alternatives?.length ? (
        <div className="live-alternatives">
          <p className="small faint">Templates it could use, most specific first:</p>
          <ul className="live-alt-list">
            {part.alternatives.map((a) => (
              <li key={a.name} className={a.chosen ? 'chosen' : a.exists ? 'exists' : ''}>
                <span className="mono small">{a.name}</span>
                <span className="faint small">{a.chosen ? 'used' : a.exists ? 'exists' : 'not made'}</span>
              </li>
            ))}
          </ul>
          {override ? <div className="live-actions"><Button size="s" icon="file" onClick={() => onEdit(override)}>Create override…</Button></div> : null}
        </div>
      ) : null}
    </div>
  );
}

function ChainStep({ step, slowest }: { step: TraceStep; slowest: boolean }) {
  return (
    <li className={`live-chain-step${slowest ? ' slow' : ''}`}>
      <span className="live-chain-head">
        <span className="mono small">{step.hook}</span>
        {step.ms !== undefined ? <span className="live-ms small">{ms(step.ms)}</span> : null}
      </span>
      <span className="small faint">
        {step.by}{step.callback ? <> · <span className="mono">{step.callback}</span></> : null}{step.priority !== undefined ? ` · priority ${step.priority}` : ''}
      </span>
      {step.changed?.length ? <span className="small">Changed <span className="mono">{step.changed.join(', ')}</span></span> : null}
      {step.source ? (
        <span className="live-chain-source">
          <span className="mono small faint" title={where(step.source)}>{where(step.source)}</span>
          <CopyButton text={where(step.source)} label={`Copy the path of ${step.callback ?? step.hook}`} what="the path" />
        </span>
      ) : null}
    </li>
  );
}

/** Every way to change the part, one click each; what cannot be changed here says why. */
export function TraceEdits({ part, edits, onEdit }: { part: TracePart; edits: Map<string, EditTarget>; onEdit: (t: EditTarget) => void }) {
  const list = (part.edits ?? []).map((id) => edits.get(id)).filter((e): e is EditTarget => !!e);
  if (!list.length) return null;
  const open = list.filter((e) => !e.why).length;
  return (
    <Disclosure title="Edit" open summary={`${open} here${list.length > open ? `, ${list.length - open} not` : ''}`}>
      <ul className="live-edit-list">
        {list.map((e) => (
          <li key={e.id}>
            <div className="live-edit-what">
              <span className="small">{e.label}</span>
              <span className="faint small">{EDIT_KIND[e.kind]}{e.via === 'native-form' ? ' · the site’s own form' : ''}{e.revisions ? ' · saved as a revision' : ''}</span>
              {e.why ? <span className="small faint">{e.why}</span> : null}
            </div>
            {e.why ? null : <Button size="s" icon="pencil" onClick={() => onEdit(e)} aria-label={`Edit ${e.label}`}>Edit</Button>}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** The variables it was rendered with, previewed (the helper bounds them and hides secrets), each editable where an edit target sets it. */
export function TraceData({ part, edits, onEdit }: { part: TracePart; edits: Map<string, EditTarget>; onEdit: (t: EditTarget) => void }) {
  const vars = part.variables ?? [];
  if (!vars.length) return null;
  return (
    <Disclosure title="Data" summary={`${vars.length} ${vars.length === 1 ? 'variable' : 'variables'}`}>
      <dl className="live-vars">
        {vars.map((v) => {
          const target = v.edit ? edits.get(v.edit) : undefined;
          return (
            <div key={v.name} className="live-var">
              <dt>
                <span className="mono small">{v.name}</span>
                <span className="lib-tag mono">{v.type}</span>
                {target && !target.why ? <Button size="s" tone="quiet" icon="pencil" onClick={() => onEdit(target)} aria-label={`Edit ${v.name}: ${target.label}`}>Edit</Button> : null}
              </dt>
              <dd className="mono small">{v.preview || <span className="faint">(empty)</span>}</dd>
              {v.setBy ? <dd className="faint small">Set by {v.setBy}</dd> : null}
            </div>
          );
        })}
      </dl>
    </Disclosure>
  );
}

export function TraceCache({ part }: { part: TracePart }) {
  const c = part.cache;
  if (!c) return null;
  const status = c.status === 'placeholder' ? 'filled in late' : c.status === 'uncacheable' ? 'never cached' : c.status ?? null;
  return (
    <Disclosure title="Cache" summary={[status, c.maxAge === 'permanent' ? 'kept' : c.maxAge === 0 ? 'max-age 0' : `max-age ${c.maxAge}`].filter(Boolean).join(' · ')}>
      <p className="small">Kept: {maxAge(c.maxAge)}.{c.status === 'hit' ? ' This render came from the cache.' : c.status === 'miss' ? ' This render built it.' : ''}</p>
      {c.tags.length ? (
        <div className="live-tags">
          <span className="small faint">Cleared when any of these change</span>
          <span className="live-files">{c.tags.map((t) => <span key={t} className="lib-tag mono">{t}</span>)}</span>
          <CopyButton text={c.tags.join(' ')} label="Copy the cache tags" what="the cache tags" />
        </div>
      ) : null}
      {c.contexts.length ? (
        <div className="live-tags">
          <span className="small faint">A copy for each</span>
          <span className="live-files">{c.contexts.map((t) => <span key={t} className="lib-tag mono">{t}</span>)}</span>
        </div>
      ) : null}
    </Disclosure>
  );
}

export function TraceCost({ part, trace }: { part: TracePart; trace: LiveTrace }) {
  const queries = partQueries(trace, part.id);
  if (!part.cost && !queries.length) return null;
  const c = part.cost;
  return (
    <Disclosure title="Cost" summary={c ? `${ms(c.ms)}${c.queries ? ` · ${c.queries} ${c.queries === 1 ? 'query' : 'queries'}` : ''}` : `${queries.length} queries`}>
      {c ? <p className="small">{ms(c.ms)} to render{c.queries !== undefined ? `, ${c.queries} ${c.queries === 1 ? 'query' : 'queries'}${c.queryMs !== undefined ? ` taking ${ms(c.queryMs)}` : ''}` : ''}, measured in this render on this Mac.</p> : null}
      {queries.length ? (
        <ol className="live-queries" aria-label="Its queries, slowest first">
          {queries.slice(0, 50).map((q, i) => (
            <li key={i} className="live-query">
              <span className="live-query-head">
                <span className="live-ms small">{ms(q.ms)}</span>
                {q.rows !== undefined ? <span className="faint small">{q.rows} {q.rows === 1 ? 'row' : 'rows'}</span> : null}
                <CopyButton text={q.sql} label="Copy the SQL" what="the query" />
              </span>
              <code className="live-sql">{q.sql}</code>
              {q.caller ? <span className="mono small faint">{where(q.caller)}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
    </Disclosure>
  );
}

export function TraceHistory({ part }: { part: TracePart }) {
  const list = part.history ?? [];
  if (!list.length) return null;
  return (
    <Disclosure title="History" summary={`${list.length} ${list.length === 1 ? 'revision' : 'revisions'}, last ${ago(list[0]?.at ?? 0)}`}>
      <ol className="live-history">
        {list.map((h) => (
          <li key={h.id}>
            <span className="small">{h.message ?? 'No message'}</span>
            <span className="faint small">{h.by} · {ago(h.at)} · revision {h.id}</span>
          </li>
        ))}
      </ol>
    </Disclosure>
  );
}

const ACCESS = { allowed: 'Allowed', forbidden: 'Forbidden', neutral: 'No opinion (neutral)' } as const;

export function TraceAccess({ part, user }: { part: TracePart; user: LiveTrace['user'] }) {
  if (!part.access) return null;
  return (
    <Disclosure title="Access" summary={ACCESS[part.access.result]}>
      <p className="small">{ACCESS[part.access.result]} for {user ? `${user.name}${user.roles.length ? ` (${user.roles.join(', ')})` : ''}` : 'the user logged in in the live view'}.</p>
      {part.access.reason ? <p className="small faint">{part.access.reason}</p> : null}
    </Disclosure>
  );
}
