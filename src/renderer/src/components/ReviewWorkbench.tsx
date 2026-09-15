import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReviewMarkState } from '@shared/review-marks';
import { MAX_MARK_NOTE_CHARS, diffStatLabel } from '@shared/review-marks';
import type { ClaimsReview, DependencyReview, ReviewImageSide, ReviewWork, ReviewWorkFile, StagePlan } from '@shared/review-work';
import { FILE_KIND_LABEL, orderForReview, type ReviewOrderMode } from '@shared/review-order';
import { inAgentScope } from '@shared/edit-attribution';
import { parseUnifiedDiff } from '@shared/review-notes';
/* ── helper sweep · P11 deps ── */
import { attributionPhrase, installPhrase, type DepTurnAttribution } from '@shared/dependency-turns';
import { DependencyAdvisories } from './DependencyAdvisories';
import { ConfirmNote, Mark, Note, Segmented, type Tone } from './bits';
import '../styles/review-work.css';

/**
 * The review half of the code rail: the needs-review verdict, the scopes and
 * the per-file marks, and the evidence that sits under a diff — dependencies,
 * claims, image before/after and staging the session's own hunks. Every read is
 * a channel that takes the session id; main resolves the checkout.
 */

export type ReviewScope = 'agent' | 'uncommitted' | 'branch';

const POLL_MS = 6_000;

/**
 * The session's review, re-read on a slow beat while the window is visible and
 * the Changes tab is open, and at once on request. Each read is a git diff in
 * main, so a hidden tab asks for nothing.
 */
export function useReviewWork(sessionId: string | undefined, whitespace: boolean, enabled: boolean) {
  const [work, setWork] = useState<ReviewWork | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!sessionId) { setWork(null); return; }
    const ticket = ++seq.current;
    try {
      const next = await window.wanigan.reviewWork.work(sessionId, { whitespace });
      if (ticket !== seq.current) return;
      setWork(next); setError(null);
    } catch (e) {
      if (ticket !== seq.current) return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [sessionId, whitespace]);
  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    const t = window.setInterval(() => { if (!document.hidden) void reload(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) void reload(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { window.clearInterval(t); document.removeEventListener('visibilitychange', onVis); seq.current += 1; };
  }, [reload, enabled]);
  return { work, error, reload };
}

export const MARK_SPEC: Record<ReviewMarkState, { glyph: string; word: string; tone: Tone }> = {
  approved: { glyph: '✓', word: 'approved', tone: 'ok' },
  rejected: { glyph: '✕', word: 'rejected', tone: 'bad' },
  commented: { glyph: '✎', word: 'commented', tone: 'accent' },
  unreviewed: { glyph: '○', word: 'unreviewed', tone: 'quiet' },
};

/** Files of a scope, filtered by path (a rename matches by its old name too) and put in review order. */
export function scopedFiles(work: ReviewWork | null, scope: ReviewScope, filter: string, order: ReviewOrderMode): ReviewWorkFile[] {
  if (!work) return [];
  const needle = filter.trim().toLowerCase();
  const inScope = scope === 'agent' ? work.files.filter((f) => inAgentScope(f.attribution)) : work.files;
  const matched = needle ? inScope.filter((f) => f.path.toLowerCase().includes(needle) || (f.oldPath ?? '').toLowerCase().includes(needle)) : inScope;
  return orderForReview(matched, order);
}

/* ── the verdict and Send review ────────────────────────────────────── */

export function ReviewSummaryBar({ work, error, onSend, sending, sent, onDismissSent }: {
  work: ReviewWork | null;
  error: string | null;
  onSend: () => void;
  sending: boolean;
  sent: { tone: 'ok' | 'warn'; text: string } | null;
  onDismissSent: () => void;
}) {
  if (error && !work) {
    return <div className="rw-summary"><Note tone="error">The review could not be read: {error}</Note></div>;
  }
  if (!work) return <div className="rw-summary"><span className="faint rw-summary-line">Reading this session's diff…</span></div>;
  const { verdict } = work;
  const c = verdict.counts;
  return (
    <section className="rw-summary" aria-label="Review of this session">
      <div className="rw-summary-line">
        {verdict.needsReview
          ? <Mark glyph="◐" word={work.label} tone="warn" />
          : verdict.reason === 'all-approved'
            ? <Mark glyph="✓" word={`Reviewed · ${c.approved} of ${c.files} file${c.files === 1 ? '' : 's'} approved`} tone="ok" />
            : <Mark glyph="○" word={verdict.reason === 'working' ? 'Working · review when the turn ends' : verdict.reason === 'no-diff' ? 'No changes to review' : verdict.reason === 'no-base' ? 'No base commit recorded' : 'Diff unreadable'} tone="quiet" />}
        {c.files > 0 && <span className="rw-stat">{diffStatLabel(c.added, c.removed)}</span>}
        <button type="button" className="btn btn-sm rw-send" disabled={sending || !work.anchor} onClick={onSend}>
          {sending ? 'Writing…' : 'Send review'}
        </button>
      </div>
      <p className="rw-because">
        {c.rejected > 0 && <><Mark {...MARK_SPEC.rejected} word={`${c.rejected} rejected`} />{' '}</>}
        {c.commented > 0 && <><Mark {...MARK_SPEC.commented} word={`${c.commented} commented`} />{' '}</>}
        {c.stale > 0 && <><Mark glyph="△" word={`${c.stale} changed since marked`} tone="warn" />{' '}</>}
        {work.highTierUnapproved.length > 0 && <><Mark glyph="▲" word={`${work.highTierUnapproved.length} high-tier unapproved`} tone="serious" />{' '}</>}
        {verdict.because}
      </p>
      {sent && <Note tone={sent.tone} onDismiss={onDismissSent}>{sent.text}</Note>}
    </section>
  );
}

/* ── scope, order, whitespace, filter, find ─────────────────────────── */

/** File order and whitespace: view options, kept in the rail's Actions menu so the list keeps its height. */
export function ReviewViewOptions({ order, onOrder, whitespace, onWhitespace }: {
  order: ReviewOrderMode; onOrder: (o: ReviewOrderMode) => void;
  whitespace: boolean; onWhitespace: (v: boolean) => void;
}) {
  return (
    <div className="rw-view-options">
      <span className="faint">File order</span>
      <Segmented label="File order" value={order} onChange={onOrder} options={[
        { value: 'review', label: 'Tests first', title: 'Tests, then schema and migrations, then the rest' },
        { value: 'path', label: 'Path', title: 'Alphabetical by path' },
      ]} />
      <label className="rw-check"><input type="checkbox" checked={whitespace} onChange={(e) => onWhitespace(e.target.checked)} /> Hide whitespace changes</label>
    </div>
  );
}

export function ReviewToolbar({ scope, onScope, order, whitespace, filter, onFilter, find, onFind, onRunFind, counts }: {
  scope: ReviewScope; onScope: (s: ReviewScope) => void;
  order: ReviewOrderMode; whitespace: boolean;
  filter: string; onFilter: (v: string) => void;
  find: string; onFind: (v: string) => void; onRunFind: () => void;
  counts: { agent: number; uncommitted: number; branch: number };
}) {
  return (
    <div className="rw-toolbar">
      <Segmented label="Diff scope" value={scope} onChange={onScope} options={[
        { value: 'agent', label: `Agent edits ${counts.agent}`, title: 'Files an edit tool wrote, or a shell command reported changing' },
        { value: 'uncommitted', label: `Uncommitted ${counts.uncommitted}`, title: 'Everything not yet committed' },
        { value: 'branch', label: `Branch ${counts.branch}`, title: 'Everything since the commit this session started from' },
      ]} />
      {(order !== 'review' || whitespace) && (
        <p className="rw-because">{[order === 'path' ? 'Files in path order' : null, whitespace ? 'whitespace-only changes hidden' : null].filter(Boolean).join(' · ')} — change it under Actions.</p>
      )}
      <div className="rw-toolbar-row">
        <input className="field rw-filter" value={filter} placeholder="Filter files by path" aria-label="Filter changed files by path"
               onChange={(e) => onFilter(e.target.value)} />
        <input className="field rw-filter" value={find} placeholder="Find in the whole diff" aria-label="Find text across the whole diff"
               onChange={(e) => onFind(e.target.value)}
               onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onRunFind(); } }} />
      </div>
    </div>
  );
}

export type FindHit = { file: string; line: number | null; side: 'new' | 'old' | null; text: string };

/** Every diff line containing the needle, with its file and line number. */
export function findInPatch(patch: string, query: string, limit = 400): { hits: FindHit[]; more: number } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { hits: [], more: 0 };
  const hits: FindHit[] = [];
  let more = 0;
  for (const row of parseUnifiedDiff(patch)) {
    if (row.kind !== 'add' && row.kind !== 'del' && row.kind !== 'ctx') continue;
    if (!row.text.toLowerCase().includes(needle) || !row.file) continue;
    if (hits.length >= limit) { more += 1; continue; }
    hits.push({ file: row.file, line: row.newLine ?? row.oldLine, side: row.newLine !== null ? 'new' : row.oldLine !== null ? 'old' : null, text: row.text });
  }
  return { hits, more };
}

export function FindResults({ query, hits, more, truncated, onOpen, onClose }: {
  query: string; hits: FindHit[]; more: number; truncated: boolean;
  onOpen: (hit: FindHit) => void; onClose: () => void;
}) {
  const files = new Set(hits.map((h) => h.file)).size;
  return (
    <section className="rw-find" aria-label="Find across the whole diff">
      <div className="rw-find-head">
        <strong>{hits.length + more} line{hits.length + more === 1 ? '' : 's'} match “{query}”</strong>
        <span className="faint">in {files} file{files === 1 ? '' : 's'}{truncated ? ' · the diff was cut at 2 MB, so later files were not searched' : ''}</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      <ol className="rw-find-list">
        {hits.map((h, i) => (
          <li key={`${h.file}:${h.line}:${i}`}>
            <button type="button" className="rw-find-hit" onClick={() => onOpen(h)}>
              <span className="mono rw-find-where">{h.file}{h.line !== null ? `:${h.line}` : ''}</span>
              <span className="mono rw-find-text">{h.text}</span>
            </button>
          </li>
        ))}
      </ol>
      {more > 0 && <p className="faint rw-find-more">and {more} more lines, not listed.</p>}
    </section>
  );
}

/* ── one file's header: marks, tier, attribution, alarms ────────────── */

export function FileTags({ file }: { file: ReviewWorkFile }) {
  const mark = MARK_SPEC[file.review.stale ? 'unreviewed' : file.review.state];
  return (
    <div className="rw-tags">
      {file.review.stale
        ? <Mark glyph="△" word="changed since you marked it" tone="warn" />
        : <Mark {...mark} />}
      {file.tier && <Mark glyph={file.tier === 'high' ? '▲' : '△'} word={`${file.tier} tier`} tone={file.tier === 'high' ? 'serious' : 'warn'} />}
      {file.kind !== 'other' && <span className="rw-tag">{FILE_KIND_LABEL[file.kind]}</span>}
      <span className="rw-tag">{file.attributionLabel}</span>
      {file.preexisting && <span className="rw-tag">already changed before the session</span>}
      {file.alarms.map((a, i) => (
        <Mark key={`${a.kind}:${i}`} glyph="⚠" word={a.line !== null ? `${a.label} · line ${a.line}` : a.label} tone="warn" />
      ))}
    </div>
  );
}

export function ReviewFileBar({ sessionId, file, onMarked }: {
  sessionId: string; file: ReviewWorkFile; onMarked: () => void;
}) {
  const [composing, setComposing] = useState<'commented' | 'rejected' | null>(null);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  useEffect(() => { setComposing(null); setBody(''); setWhy(null); setConfirmDiscard(false); }, [file.path]);

  const mark = async (state: ReviewMarkState, note?: string | null) => {
    setBusy(true); setWhy(null);
    try {
      await window.wanigan.reviewWork.setMark(sessionId, file.path, state, note ?? null);
      setComposing(null); setBody(''); setConfirmDiscard(false);
      onMarked();
    } catch (e) { setWhy(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const open = (kind: 'commented' | 'rejected') => {
    setComposing(kind); setWhy(null);
    setBody(file.review.marked === kind || file.review.marked === 'commented' || file.review.marked === 'rejected' ? file.review.note ?? '' : '');
  };
  const cancel = () => { if (body.trim() && body.trim() !== (file.review.note ?? '')) setConfirmDiscard(true); else { setComposing(null); setBody(''); } };
  const state = file.review.stale ? 'unreviewed' : file.review.state;

  return (
    <div className="rw-filebar">
      <div className="rw-filebar-top">
        <span className="mono rw-path">{file.path}</span>
        {file.oldPath && <span className="faint rw-was">was {file.oldPath}</span>}
        <span className="rw-stat">{file.added === null ? 'binary' : diffStatLabel(file.added, file.removed ?? 0)}</span>
      </div>
      <FileTags file={file} />
      {file.review.note && !composing && (
        <p className="rw-note"><span className="faint">{file.review.stale ? 'Your note on the earlier version: ' : 'Your note: '}</span>{file.review.note}</p>
      )}
      <div className="rw-actions" role="group" aria-label={`Review marks for ${file.path}`}>
        <button type="button" className="btn btn-sm" aria-pressed={state === 'approved'} disabled={busy} onClick={() => void mark('approved')}>Approve</button>
        <button type="button" className="btn btn-sm" aria-pressed={state === 'rejected'} disabled={busy} onClick={() => open('rejected')}>Reject…</button>
        <button type="button" className="btn btn-sm" aria-pressed={state === 'commented'} disabled={busy} onClick={() => open('commented')}>Comment…</button>
        {file.review.marked !== null && (
          <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void mark('unreviewed')}>Clear mark</button>
        )}
      </div>
      {composing && (
        <div className="review-compose rw-compose">
          <textarea aria-label={composing === 'rejected' ? `Why reject ${file.path}` : `Comment on ${file.path}`} value={body} autoFocus maxLength={MAX_MARK_NOTE_CHARS}
                    placeholder={composing === 'rejected' ? 'What is wrong with it? (optional)' : 'What should the agent know about this file?'}
                    onChange={(e) => { setBody(e.target.value); setConfirmDiscard(false); }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void mark(composing, body); }
                      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                    }} />
          {why && <p className="review-why" role="status">{why}</p>}
          {confirmDiscard ? (
            <ConfirmNote what={`Discard the ${composing === 'rejected' ? 'rejection note' : 'comment'} on ${file.path}? It has not been saved.`} verb="Discard it"
                         onRun={() => { setComposing(null); setBody(''); setConfirmDiscard(false); }} onCancel={() => setConfirmDiscard(false)} />
          ) : (
            <div className="review-compose-actions">
              <button type="button" className="btn btn-primary" disabled={busy || (composing === 'commented' && !body.trim())} onClick={() => void mark(composing, body)}>
                {composing === 'rejected' ? 'Reject file' : 'Save comment'}
              </button>
              <button type="button" className="btn" onClick={cancel}>Cancel</button>
              <span className="faint">⌘↩ saves</span>
            </div>
          )}
        </div>
      )}
      {!composing && why && <p className="review-why" role="status">{why}</p>}
    </div>
  );
}

/* ── image before and after ─────────────────────────────────────────── */

function ImageSide({ label, side }: { label: string; side: ReviewImageSide | null }) {
  return (
    <figure className="rw-image-side">
      <figcaption className="faint">{label}{side?.bytes != null ? ` · ${Math.max(1, Math.round(side.bytes / 1024)).toLocaleString('en-US')} KB` : ''}</figcaption>
      {side?.dataUrl
        ? <img src={side.dataUrl} alt={`${label} version`} className="rw-image" />
        : <p className="faint rw-image-empty">{side ? side.note ?? 'Not available.' : 'Reading…'}</p>}
    </figure>
  );
}

export function ImageDiff({ sessionId, file }: { sessionId: string; file: string }) {
  const [sides, setSides] = useState<{ before: ReviewImageSide; after: ReviewImageSide } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setSides(null); setErr(null);
    window.wanigan.reviewWork.image(sessionId, file)
      .then((s) => { if (live) setSides(s); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, file]);
  if (err) return <div className="rw-pad"><Note tone="error">{err}</Note></div>;
  return (
    <div className="rw-image-diff" aria-label={`Before and after for ${file}`} role="group">
      <ImageSide label="Before (base commit)" side={sides?.before ?? null} />
      <ImageSide label="After (working tree)" side={sides?.after ?? null} />
    </div>
  );
}

/* ── dependencies and claims, under the diff ────────────────────────── */

/* ── helper sweep · P11 deps ── */
/**
 * Where a change came from: the turn whose snapshots first show it, with a jump
 * to that turn's diff, and whether an install command ran in that turn. Any
 * other answer is said as what it is, never rounded to a turn.
 */
function DepOrigin({ attribution, onJumpTurn }: { attribution: DepTurnAttribution; onJumpTurn?: (turn: number) => void }) {
  const also = attribution.alsoTurns.length ? ` Also changed in turn${attribution.alsoTurns.length === 1 ? '' : 's'} ${attribution.alsoTurns.join(', ')}.` : '';
  if (attribution.state !== 'turn') {
    return (
      <span className="faint rw-dep-origin">
        {attributionPhrase(attribution)}
        {attribution.state === 'outside-turns' || attribution.state === 'unknown' ? ` · ${attribution.detail}` : ''}{also}
      </span>
    );
  }
  return (
    <span className="rw-dep-origin">
      {onJumpTurn
        ? <button type="button" className="btn btn-sm rw-dep-turn" onClick={() => onJumpTurn(attribution.turn)}
                  aria-label={`Open turn ${attribution.turn}'s diff`}>turn {attribution.turn} ↗</button>
        : <span className="mono">turn {attribution.turn}</span>}
      <span className="faint"><Ticks text={`${installPhrase(attribution.install)}.${also}`} /></span>
    </span>
  );
}

export function DependenciesSection({ sessionId, refreshKey, onJumpTurn }: { sessionId: string; refreshKey: string; onJumpTurn?: (turn: number) => void }) {
  const [deps, setDeps] = useState<DependencyReview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.reviewWork.dependencies(sessionId)
      .then((d) => { if (live) { setDeps(d); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, refreshKey]);
  const changes = deps?.manifests.reduce((n, m) => n + m.changes.length, 0) ?? 0;
  const added = deps?.manifests.reduce((n, m) => n + m.changes.filter((c) => c.change === 'added').length, 0) ?? 0;
  return (
    <details className="rw-section" open={added > 0}>
      <summary>Dependencies <span className="faint">{deps ? `${changes} change${changes === 1 ? '' : 's'}${added ? ` · ${added} added` : ''}` : err ? 'unreadable' : 'reading…'}</span></summary>
      {err && <Note tone="error">{err}</Note>}
      {deps && deps.manifests.length === 0 && <p className="faint rw-section-empty">No manifest or lockfile changed in this diff.</p>}
      {deps?.manifests.map((m) => (
        <div key={m.path} className="rw-manifest">
          <div className="mono rw-manifest-path">{m.path}</div>
          {m.error && <p className="review-why">{m.error}</p>}
          {!m.error && m.changes.length === 0 && <p className="faint rw-section-empty">Changed, but no dependency entry moved.</p>}
          <ul className="rw-dep-list">
            {m.changes.map((c, i) => (
              <li key={`${c.section}:${c.name}`}>
                <Mark glyph={c.change === 'added' ? '+' : c.change === 'removed' ? '−' : '↕'} word={c.change} tone={c.change === 'added' ? 'warn' : c.change === 'removed' ? 'quiet' : 'accent'} />
                <span className="mono">{c.name}</span>
                <span className="faint">{c.change === 'added' ? c.after ?? '' : c.change === 'removed' ? c.before ?? '' : `${c.before ?? '?'} → ${c.after ?? '?'}`} · {c.section}</span>
                {m.attributions?.[i] && <DepOrigin attribution={m.attributions[i]} onJumpTurn={onJumpTurn} />}
              </li>
            ))}
          </ul>
          {m.note && <p className="faint rw-section-empty">{m.note}</p>}
        </div>
      ))}
      {deps && (
        <p className="faint rw-section-empty">
          {deps.installs.length
            ? `Install commands recorded in this session: ${deps.installs.map((i) => `${i.command}${i.ok === false ? ` (failed${i.exitCode !== null ? `, exit ${i.exitCode}` : ''})` : ''}`).join('; ')}.`
            : deps.hooksRecorded ? 'No install command is recorded for this session.' : 'This session has no hook record, so Wanigan cannot say whether an install ran.'}
        </p>
      )}
      {deps && <DependencyAdvisories sessionId={sessionId} refreshKey={refreshKey}
                                     hasCandidates={deps.manifests.some((m) => !m.error && m.changes.some((c) => c.change === 'added' || c.change === 'upgraded'))} />}
    </details>
  );
}
/* ── end helper sweep · P11 deps ── */

/** `code` in a sentence as monospace, the rest as text. */
function Ticks({ text }: { text: string }) {
  return <>{text.split('`').map((part, i) => (i % 2 ? <span key={i} className="mono">{part}</span> : part))}</>;
}

const CLAIM_MARK: Record<'verified' | 'unsupported' | 'needs-review', { glyph: string; word: string; tone: Tone }> = {
  verified: { glyph: '✓', word: 'verified', tone: 'ok' },
  unsupported: { glyph: '✕', word: 'unsupported', tone: 'bad' },
  'needs-review': { glyph: '?', word: 'needs review', tone: 'warn' },
};

export function ClaimsSection({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [claims, setClaims] = useState<ClaimsReview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.reviewWork.claims(sessionId)
      .then((c) => { if (live) { setClaims(c); setErr(null); } })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId, refreshKey]);
  const counts = claims?.state === 'graded'
    ? (['verified', 'unsupported', 'needs-review'] as const).map((g) => [g, claims.claims.filter((c) => c.grade === g).length] as const)
    : [];
  return (
    <details className="rw-section" open={claims?.state === 'graded' && claims.claims.some((c) => c.grade === 'unsupported')}>
      <summary>Claims in the final message <span className="faint">
        {claims?.state === 'graded' ? counts.filter(([, n]) => n > 0).map(([g, n]) => `${n} ${CLAIM_MARK[g].word}`).join(' · ') || 'no claims found' : err ? 'unreadable' : claims ? 'not graded' : 'reading…'}
      </span></summary>
      {err && <Note tone="error">{err}</Note>}
      {claims && claims.state !== 'graded' && <p className="faint rw-section-empty">{claims.reason}</p>}
      {claims?.state === 'graded' && (
        <>
          <ul className="rw-claims">
            {claims.claims.map((c, i) => (
              <li key={`${c.kind}:${c.subject ?? ''}:${i}`}>
                <Mark {...CLAIM_MARK[c.grade]} />
                <span className="rw-claim-quote">“<Ticks text={c.quote} />”</span>
                <span className="faint rw-claim-why"><Ticks text={c.because} /></span>
              </li>
            ))}
          </ul>
          <p className="faint rw-section-empty">Read from {claims.source}; checked against this diff, its dependency list and the recorded Bash commands. No model was asked.</p>
        </>
      )}
    </details>
  );
}

/* ── stage only the session's hunks ─────────────────────────────────── */

export function StageHunksPanel({ sessionId, onClose, onStaged }: { sessionId: string; onClose: () => void; onStaged: (detail: string) => void }) {
  const [plan, setPlan] = useState<StagePlan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    window.wanigan.reviewWork.stagePlan(sessionId)
      .then((p) => { if (live) setPlan(p); })
      .catch((e) => { if (live) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId]);
  const staging = plan?.files.filter((f) => f.action === 'stage') ?? [];
  const refused = plan?.files.filter((f) => f.action === 'refuse') ?? [];
  const already = plan?.files.filter((f) => f.action === 'already-staged') ?? [];
  const apply = async () => {
    if (!plan?.digest) return;
    setBusy(true); setErr(null);
    try { const r = await window.wanigan.reviewWork.stageApply(sessionId, plan.digest); onStaged(r.detail); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <section className="rw-stage" aria-label="Stage only the session's hunks">
      <div className="rw-find-head">
        <strong>Stage only the session's hunks</strong>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      {!plan && !err && <p className="faint">Reading the per-turn snapshots…</p>}
      {err && <Note tone="error">{err}</Note>}
      {plan && !plan.ok && <Note tone="warn">{plan.refusal}</Note>}
      {plan?.ok && (
        <>
          <p className="rw-because">
            From {plan.turns} turn{plan.turns === 1 ? '' : 's'}: {staging.length} file{staging.length === 1 ? '' : 's'} to stage
            {refused.length ? `, ${refused.length} refused` : ''}{already.length ? `, ${already.length} already staged` : ''}.
            {plan.untouched.length > 0 && ` ${plan.untouched.length} other changed file${plan.untouched.length === 1 ? '' : 's'} no turn produced ${plan.untouched.length === 1 ? 'stays' : 'stay'} unstaged.`}
            {' '}Only the index is written; the working tree and your own hunks are left as they are.
          </p>
          <ul className="rw-stage-list">
            {plan.files.map((f) => (
              <li key={f.path}>
                <Mark glyph={f.action === 'stage' ? '+' : f.action === 'refuse' ? '✕' : '✓'} word={f.action === 'stage' ? (f.mixed ? 'stage the turns\' hunks' : 'stage') : f.action === 'refuse' ? 'refused' : 'already staged'}
                      tone={f.action === 'refuse' ? 'bad' : f.action === 'stage' ? 'accent' : 'quiet'} />
                <span className="mono">{f.path}</span>
                {f.action === 'stage' && <span className="faint">turn{f.turns.length === 1 ? '' : 's'} {f.turns.join(', ')}{f.mixed ? ' · also edited outside the turns, which stays unstaged' : ''}</span>}
                {f.reason && <span className="faint"><Ticks text={f.reason} /></span>}
              </li>
            ))}
          </ul>
          {plan.patch && (
            <details className="rw-section">
              <summary>Preview the patch <span className="faint">{plan.patch.split('\n').length.toLocaleString('en-US')} lines</span></summary>
              <pre className="diff rw-stage-patch">{plan.patch.split('\n').slice(0, 800).map((l, i) => (
                <div key={i} className={`dl ${l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : 'meta'}`}>{l || ' '}</div>
              ))}</pre>
            </details>
          )}
          {plan.digest
            ? <ConfirmNote what={`Stage ${staging.length} file${staging.length === 1 ? '' : 's'} into the index exactly as previewed?`} verb={`Stage ${staging.length} file${staging.length === 1 ? '' : 's'}`}
                           busy={busy} onRun={apply} onCancel={onClose} />
            : <p className="faint">Nothing to stage.</p>}
        </>
      )}
    </section>
  );
}

/** A compact line of marks for a row in the file list. Words, not colour alone. */
export function FileRowMarks({ file }: { file: ReviewWorkFile }) {
  const spec = file.review.stale ? { glyph: '△', word: 'changed since marked', tone: 'warn' as Tone } : MARK_SPEC[file.review.state];
  return (
    <span className="rw-row-marks">
      {(file.review.state !== 'unreviewed' || file.review.stale) && <span className={`mark tone-${spec.tone}`}><span aria-hidden="true">{spec.glyph}</span><span className="sr-only">{spec.word}</span></span>}
      {file.tier && <span className={`mark tone-${file.tier === 'high' ? 'serious' : 'warn'}`}><span aria-hidden="true">{file.tier === 'high' ? '▲' : '△'}</span><span className="sr-only">{file.tier} tier</span></span>}
      {file.alarms.length > 0 && <span className="mark tone-warn"><span aria-hidden="true">⚠{file.alarms.length}</span><span className="sr-only">{file.alarms.length} test alarm{file.alarms.length === 1 ? '' : 's'}</span></span>}
    </span>
  );
}

