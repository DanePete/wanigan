import { useEffect, useState } from 'react';
import type { MaintainabilityView } from '@shared/maintainability';
import type { ReviewWorkFile } from '@shared/review-work';
import { SCRATCH_WORDS } from '@shared/scratch-files';
import { CITE_INSTRUCTION, type ScopedRules } from '@shared/review-rules';
import { Mark, Note, num } from './bits';
import '../styles/depth.css';

/*
 * Review-depth sections under the diff (helper sweep P7). Each is a
 * `details.rw-section`, the same shape as the dependency and claim sections
 * beside it, and each reads its own evidence from main.
 */

const HEURISTIC = <Mark glyph="≈" word="heuristic" tone="quiet" />;

/**
 * Three separate observed numbers about the code a session changed, each
 * labelled a heuristic. There is no score and no grade: a longer function or a
 * copied block is sometimes the right change, and only a person reading the
 * diff can say which.
 */
export function MaintainabilitySection({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [view, setView] = useState<MaintainabilityView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.depth.maintainability(sessionId)
      .then((v) => { if (live) { setView(v); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, refreshKey]);
  const r = view?.report ?? null;
  const summary = r
    ? `+${num(r.codeAdded)} −${num(r.codeRemoved)} code lines · ${r.duplicatedBlocks.length} new duplicate block${r.duplicatedBlocks.length === 1 ? '' : 's'}`
    : err ? 'unreadable' : view ? view.state === 'no-checkpoints' ? 'no checkpoints' : view.state === 'unchanged' ? 'no change' : 'unreadable' : 'reading…';
  return (
    <details className="rw-section dp-drift" open={!!r && r.duplicatedBlocks.length > 0}>
      <summary>Maintainability <span className="faint">{summary}</span></summary>
      {err && <Note tone="error">{err}</Note>}
      {view && !r && <p className="faint rw-section-empty">{view.detail}</p>}
      {view && r && (
        <>
          <p className="faint rw-section-empty">
            The {num(r.analysed)} code file{r.analysed === 1 ? '' : 's'} changed between the snapshot this session started from
            ({view.base?.slice(0, 8)}) and its latest checkpoint{view.latestTurn !== null ? ` (turn ${view.latestTurn})` : ''}.
            Each number is its own heuristic; none is a grade.
          </p>
          <dl className="dp-drift-grid">
            <dt>Code lines {HEURISTIC}</dt>
            <dd><strong>+{num(r.codeAdded)}</strong> added · <strong>−{num(r.codeRemoved)}</strong> removed
              <span className="faint dp-fine">blank and comment-only lines are not counted</span></dd>
            <dt>Longest function {HEURISTIC}</dt>
            <dd>
              <span>before: {r.longestBefore ? <><strong>{num(r.longestBefore.lines)} lines</strong> <span className="mono">{r.longestBefore.name}</span> <span className="faint mono">{r.longestBefore.path}:{r.longestBefore.line}</span></> : <span className="faint">none found</span>}</span>
              <span>after: {r.longestAfter ? <><strong>{num(r.longestAfter.lines)} lines</strong> <span className="mono">{r.longestAfter.name}</span> <span className="faint mono">{r.longestAfter.path}:{r.longestAfter.line}</span></> : <span className="faint">none found</span>}</span>
              <span className="faint dp-fine">braces for JS/TS, Go, Java, C#, Rust and PHP; indentation for Python</span>
            </dd>
            <dt>New duplicate blocks {HEURISTIC}</dt>
            <dd>
              <strong>{num(r.duplicatedBlocks.length)}</strong>
              <span className="faint dp-fine">the same normalised six-line window twice or more after the change, and not before</span>
              {r.duplicatedBlocks.length > 0 && (
                <ul className="dp-dupes">
                  {r.duplicatedBlocks.slice(0, 5).map((b, i) => (
                    <li key={i}>
                      <span className="mono dp-dupe-preview">{b.preview}</span>
                      <span className="faint dp-fine">{num(b.lines)} lines at {b.occurrences.slice(0, 4).map((o) => `${o.path}:${o.line}`).join(', ')}{b.occurrences.length > 4 ? ` and ${b.occurrences.length - 4} more` : ''}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
          {r.skipped.length > 0 && (
            <details className="dp-skipped">
              <summary>{num(r.skipped.length)} changed file{r.skipped.length === 1 ? '' : 's'} not analysed</summary>
              <ul>{r.skipped.slice(0, 40).map((s) => <li key={s.path}><span className="mono">{s.path}</span> <span className="faint">{s.reason}</span></li>)}</ul>
            </details>
          )}
        </>
      )}
    </details>
  );
}

/**
 * Changed files set aside as scratch: listed, collapsed, and out of every count
 * above them. "Count this file" puts one back into the review and is kept for
 * the project until taken back.
 */
export function ScratchFilesSection({ sessionId, files, selected, onOpen, onChanged }: {
  sessionId: string; files: readonly ReviewWorkFile[]; selected: string | null;
  onOpen: (path: string) => void; onChanged: () => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (!files.length) return null;
  const count = (path: string) => {
    setBusy(path); setErr(null);
    window.wanigan.depth.promoteScratch(sessionId, path, true)
      .then(() => onChanged())
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null));
  };
  return (
    <details className="dp-scratch">
      <summary>Scratch files <span className="faint">{num(files.length)} · not counted in this review</span></summary>
      <ul className="dp-scratch-list">
        {files.map((f) => (
          <li key={f.path}>
            <button type="button" className={`code-file${selected === f.path ? ' on' : ''}`} onClick={() => onOpen(f.path)}>
              <span className="stat">{f.status}</span>
              <span className="trunc faint">{f.path}</span>
            </button>
            <span className="faint dp-fine">{f.scratch ? SCRATCH_WORDS[f.scratch] : ''}</span>
            <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => count(f.path)}>
              {busy === f.path ? 'Counting…' : 'Count this file'}
            </button>
          </li>
        ))}
      </ul>
      {err && <Note tone="error">{err}</Note>}
    </details>
  );
}

/**
 * The `Code Review Rules` sections that cover this diff, beside it: from the
 * AGENTS.md and CLAUDE.md files on the path from the repository root to each
 * changed file. Send review carries the same block, cited, with the instruction
 * to cite the rule a finding relies on.
 */
export function ReviewRulesSection({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [data, setData] = useState<{ rules: ScopedRules[]; changed: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.depth.reviewRules(sessionId)
      .then((d) => { if (live) { setData(d); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, refreshKey]);
  const count = data?.rules.reduce((n, r) => n + r.rules.length, 0) ?? 0;
  return (
    <details className="rw-section dp-rules" open={count > 0}>
      <summary>Code review rules <span className="faint">{data ? count ? `${count} rule${count === 1 ? '' : 's'} from ${data.rules.length} section${data.rules.length === 1 ? '' : 's'}` : 'none cover this diff' : err ? 'unreadable' : 'reading…'}</span></summary>
      {err && <Note tone="error">{err}</Note>}
      {data && !data.rules.length && (
        <p className="faint rw-section-empty">No AGENTS.md or CLAUDE.md on the path to the {num(data.changed)} changed file{data.changed === 1 ? '' : 's'} has a Code Review Rules section.</p>
      )}
      {data?.rules.map((r) => (
        <div key={`${r.file}:${r.line}`} className="dp-rules-block">
          <div className="dp-rules-source"><span className="mono">{r.file}</span> › {r.heading} <span className="faint dp-fine">line {r.line} · covers {num(r.covers.length)} changed file{r.covers.length === 1 ? '' : 's'}{r.scope ? ` under ${r.scope}/` : ''}</span></div>
          <ul className="dp-rules-list">{r.rules.map((rule, i) => <li key={i}>{rule}</li>)}</ul>
        </div>
      ))}
      {data && data.rules.length > 0 && <p className="faint rw-section-empty">Send review includes these, with the instruction to {CITE_INSTRUCTION}.</p>}
    </details>
  );
}
