import { useEffect, useState } from 'react';
import type { AnnotatedRange, AttributionSummary } from '@shared/line-attribution';
import { Mark, Note } from './bits';
import '../styles/mac-around.css';

/**
 * Line-level attribution in the code reader (helper sweep · P8): a session's
 * added-versus-still-present counts with Export as git notes…, and a file view
 * whose "Show who wrote this" toggle marks each line range with the session and
 * turn git blame traces it to. Unmarked lines are untracked, not "human".
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

export function AttributionSummaryBar({ sessionId }: { sessionId: string }) {
  const [summary, setSummary] = useState<AttributionSummary | null>(null);
  const [busy, setBusy] = useState<'compute' | 'export' | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.attribution.summary(sessionId).then((s) => { if (live) setSummary(s); }, (e) => { if (live) setNote({ tone: 'error', text: msg(e) }); });
    return () => { live = false; };
  }, [sessionId]);

  const compute = () => {
    setBusy('compute'); setNote(null);
    window.wanigan.attribution.compute(sessionId).then(setSummary, (e) => setNote({ tone: 'error', text: msg(e) })).finally(() => setBusy(null));
  };
  const exportNotes = () => {
    setBusy('export'); setNote(null);
    window.wanigan.attribution.exportNotes(sessionId).then((r) => {
      if (r.cancelled) return;
      setNote({ tone: 'ok', text: `Wrote ${r.written} note${r.written === 1 ? '' : 's'} under ${r.ref}${r.skipped ? `; ${r.skipped} commit${r.skipped === 1 ? '' : 's'} already had one and were left alone` : ''}. Nothing was pushed.` });
    }, (e) => setNote({ tone: 'error', text: msg(e) })).finally(() => setBusy(null));
  };

  return (
    <div className="p8-attr">
      <div className="p8-attr-line">
        <strong className="p8-attr-title">Attribution</strong>
        {summary?.computedAt ? (
          <>
            <span>{summary.addedByTurns === null ? <span className="p8-fine">turns not recorded</span> : <><b>{summary.addedByTurns}</b> lines added in the agent’s turns</>}</span>
            <span><b>{summary.addedInCommits}</b> in {summary.commits} commit{summary.commits === 1 ? '' : 's'}</span>
            {summary.stillPresent && (
              <span><b>{summary.stillPresent.lines}</b> of those still present on {summary.stillPresent.target}</span>
            )}
          </>
        ) : <span className="p8-fine">Not computed for this session yet.</span>}
        <span className="p8-attr-actions">
          <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={compute}>{busy === 'compute' ? 'Computing…' : summary?.computedAt ? 'Recompute' : 'Compute'}</button>
          <button type="button" className="btn btn-sm" disabled={busy !== null || !summary?.commits} onClick={exportNotes}>Export as git notes…</button>
        </span>
      </div>
      {summary?.note && summary.computedAt && <p className="p8-fine">{summary.note}.</p>}
      {note && <Note tone={note.tone} onDismiss={() => setNote(null)}>{note.text}</Note>}
    </div>
  );
}

type FileShape = { rel: string; text: string; truncated: boolean; binary: boolean };

export function AttributedFileView({ file, sessionId }: { file: FileShape; sessionId?: string }) {
  const [show, setShow] = useState(false);
  const [ranges, setRanges] = useState<AnnotatedRange[] | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  useEffect(() => { setRanges(null); setInfo(null); }, [file.rel, sessionId]);
  useEffect(() => {
    if (!show || !sessionId || file.binary) return;
    let live = true;
    window.wanigan.attribution.file(sessionId, file.rel).then((r) => {
      if (!live) return;
      setRanges(r.ranges);
      setInfo(`${r.lines - r.unmarked} of ${r.lines} lines traced to a session${r.unmarked ? `; ${r.unmarked} untracked` : ''}${r.note ? ` — ${r.note}` : ''}`);
    }, (e) => { if (live) { setRanges([]); setInfo(msg(e)); } });
    return () => { live = false; };
  }, [show, sessionId, file.rel, file.binary]);

  if (file.binary) return <p className="faint code-hint">Binary file.</p>;
  const lines = file.text.split('\n');
  const startAt = new Map((ranges ?? []).map((r) => [r.start, r] as const));
  const within = (n: number) => (ranges ?? []).find((r) => n >= r.start && n <= r.end) ?? null;
  return (
    <>
      {sessionId && (
        <div className="p8-who-bar">
          <label className="p8-check">
            <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
            <span>Show who wrote this</span>
          </label>
          {show && info && <span className="p8-fine">{info}</span>}
        </div>
      )}
      {/* The gutter clips a long session title; the legend never does. */}
      {show && ranges && ranges.length > 0 && (
        <ul className="p8-who-legend">
          {ranges.map((r) => (
            <li key={`${r.start}-${r.end}`}>
              <span className="mono">{r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`}</span>
              <span>{r.title}{r.turn !== null ? ` · turn ${r.turn}` : ''}</span>
              <span className="p8-fine">{r.origin === 'commit' ? 'committed' : 'uncommitted, from its checkpoint'}</span>
            </li>
          ))}
        </ul>
      )}
      {file.truncated && <div className="code-err">Truncated for display — open in your editor for the whole file.</div>}
      <pre className="filepre">
        {lines.map((l, i) => {
          const n = i + 1;
          const head = show ? startAt.get(n) : undefined;
          const inside = show ? within(n) : null;
          return (
            <div key={i} className="fl" data-attributed={inside ? 'true' : undefined}>
              <span className="ln">{n}</span>
              {show && (
                <span className="p8-who">
                  {head ? <Mark glyph={head.origin === 'commit' ? '●' : '◐'} word={`${head.title}${head.turn !== null ? ` · turn ${head.turn}` : ''}`} tone="accent" /> : null}
                </span>
              )}
              <span className="lt">{l || ' '}</span>
            </div>
          );
        })}
      </pre>
    </>
  );
}
