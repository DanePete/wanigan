import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  OPINION_LIMITS, decisionNote, droppedSentence, findingNote, indexDiff,
  type Adjudication, type OpinionKind, type OpinionLedger, type OpinionPreview, type OpinionProfile, type OpinionRun, type OpinionRunFinding,
  type StoredDecision,
} from '@shared/second-opinions';
import type { ReviewNote } from '@shared/review-notes';
import { Mark, Note, ago, type Tone } from './bits';
import { useDialog } from './useDialog';
import '../styles/second-opinions.css';

/**
 * Second opinions in the code rail (helper sweep · P9): a billed review of this
 * session's diff by a profile the operator picks, and a same-backend search for
 * decisions nobody asked for. Both start only from a consent dialog, and main
 * asks a second time before anything is sent. What comes back is a list of
 * candidates the operator judges; nothing a model said reaches the session
 * except what the operator confirms and adds to the review message.
 */

const POLL_MS = 3_000;

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '') : String(e);
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/** A session's runs, re-read while one is still going. */
export function useOpinionRuns(sessionId: string | undefined, enabled: boolean) {
  const [runs, setRuns] = useState<OpinionRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!sessionId) { setRuns([]); return; }
    const ticket = ++seq.current;
    try {
      const next = await window.wanigan.opinions.runs(sessionId);
      if (ticket !== seq.current) return;
      setRuns(Array.isArray(next) ? next : []); setError(null);
    } catch (e) {
      if (ticket === seq.current) setError(msg(e));
    }
  }, [sessionId]);
  const anyRunning = runs.some((r) => r.status === 'running');
  useEffect(() => {
    if (!enabled) return undefined;
    void reload();
    if (!anyRunning) return () => { seq.current += 1; };
    const t = window.setInterval(() => { if (!document.hidden) void reload(); }, POLL_MS);
    return () => { window.clearInterval(t); seq.current += 1; };
  }, [reload, enabled, anyRunning]);
  return { runs, error, reload };
}

/* ── the actions under the verdict ──────────────────────────────────── */

export function SecondOpinionActions({ onOpen, runs, resultsOpen, onToggleResults }: {
  onOpen: (kind: OpinionKind) => void; runs: OpinionRun[]; resultsOpen: boolean; onToggleResults: () => void;
}) {
  const running = runs.filter((r) => r.status === 'running');
  return (
    <div className="so-actions" role="group" aria-label="Second opinions">
      <span className="faint so-actions-label">Second opinions · billed, per run</span>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('review')}>Get a second review…</button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('decisions')}>Find unrequested decisions…</button>
      <button type="button" className="btn btn-sm" aria-pressed={resultsOpen} aria-controls="so-results" onClick={onToggleResults}>
        Results · {runs.length}
      </button>
      {running.length > 0 && <Mark glyph="◌" word={`${running.length} running`} tone="accent" />}
    </div>
  );
}

/* ── the consent dialog ─────────────────────────────────────────────── */

const METERING_MARK: Record<OpinionProfile['metering'], { glyph: string; word: string; tone: Tone }> = {
  unproven: { glyph: '○', word: 'no second opinion recorded yet', tone: 'quiet' },
  priced: { glyph: '$', word: 'has reported a price', tone: 'ok' },
  unpriced: { glyph: '?', word: 'reports tokens, no price', tone: 'warn' },
  unmetered: { glyph: '✕', word: 'reports no usage', tone: 'bad' },
};

export function OpinionConsentDialog({ sessionId, kind, onClose, onStarted }: {
  sessionId: string; kind: OpinionKind; onClose: () => void; onStarted: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'least-destructive' });
  const [profiles, setProfiles] = useState<OpinionProfile[] | null>(null);
  const [providerId, setProviderId] = useState('');
  const [budget, setBudget] = useState<string>(OPINION_LIMITS.defaultBudgetUsd.toFixed(2));
  const [previewed, setPreviewed] = useState<{ preview: OpinionPreview; usd: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const previewSeq = useRef(0);

  useEffect(() => {
    let live = true;
    window.wanigan.opinions.profiles(sessionId, kind)
      .then((list) => {
        if (!live) return;
        const rows = Array.isArray(list) ? list : [];
        setProfiles(rows);
        const first = rows.find((p) => !p.refusal) ?? rows[0];
        setProviderId(first?.providerId ?? '');
      })
      .catch((e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, [sessionId, kind]);

  const profile = profiles?.find((p) => p.providerId === providerId) ?? null;
  const usd = profile?.cap.kind === 'usd' ? Number(budget) : null;

  useEffect(() => {
    if (!providerId) { setPreviewed(null); return undefined; }
    const ticket = ++previewSeq.current;
    const timer = window.setTimeout(() => {
      window.wanigan.opinions.preview({ sessionId, kind, providerId, maxBudgetUsd: usd })
        .then((p) => { if (ticket === previewSeq.current) { setPreviewed({ preview: p, usd }); setError(null); } })
        .catch((e) => { if (ticket === previewSeq.current) { setPreviewed(null); setError(msg(e)); } });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [sessionId, kind, providerId, usd]);

  // Only the preview of exactly what is on screen: the profile picked and the
  // cap typed. A preview still on its way for a new cap is not the one to run.
  const current = previewed && previewed.preview.profile.providerId === providerId && previewed.usd === usd ? previewed.preview : null;
  const run = async () => {
    if (!current || current.refusal) return;
    setBusy(true); setError(null);
    try {
      await window.wanigan.opinions.start({
        sessionId, kind, providerId, maxBudgetUsd: usd, digest: current.digest, fingerprint: current.profile.fingerprint,
      });
      onStarted();
      onClose();
    } catch (e) {
      setError(msg(e));
    } finally { setBusy(false); }
  };

  const title = kind === 'review' ? 'Get a second review' : 'Find decisions nobody asked for';
  const s = current?.sends;
  return portal(
    <div {...backdropProps}>
      <section {...dialogProps} className="modal so-consent" aria-labelledby="so-consent-title">
        <div className="label">Billed · asks before sending</div>
        <h2 id="so-consent-title">{title}</h2>
        <p className="dim so-lead">
          {kind === 'review'
            ? 'A model you pick reads this session\'s diff and returns findings. You mark each one Confirmed, Refuted or Not sure; only confirmed findings can join your review.'
            : 'The backend this session ran on reads your messages, the goal and plan, and the diff, and names choices in the diff that none of them asked for. Every location it cites is checked against the diff.'}
        </p>

        <label className="so-field" htmlFor="so-profile">
          <span className="label">{kind === 'review' ? 'Reviewer profile' : 'Profile (same backend only)'}</span>
        </label>
        <select id="so-profile" className="field so-select" value={providerId} disabled={!profiles}
                onChange={(e) => setProviderId(e.target.value)}>
          {!profiles && <option value="">Reading profiles…</option>}
          {profiles?.map((p) => (
            <option key={p.providerId} value={p.providerId}>
              {p.label} · {p.vendor}{p.refusal ? ' — unavailable' : ''}
            </option>
          ))}
        </select>
        {profile && (
          <p className="so-profile-line">
            <Mark {...METERING_MARK[profile.metering]} />
            {kind === 'decisions' && profile.sameBackend && <Mark glyph="=" word="the backend this session ran on" tone="ok" />}
          </p>
        )}
        {profile?.refusal && <Note tone="warn">{profile.refusal}</Note>}

        {current && s && (
          <>
            <h3 className="so-h3">Exactly what is sent</h3>
            <ul className="so-sends">
              <li>
                {s.truncated
                  ? <>The diff against its base commit, cut to the first <strong>{kb(s.sentBytes)}</strong> of {kb(s.diffBytes)} (the cap is {kb(s.capBytes)}).</>
                  : <>The diff against its base commit: <strong>{kb(s.sentBytes)}</strong>, whole (the cap is {kb(s.capBytes)}).</>}
              </li>
              <li>The list of {s.files} changed file{s.files === 1 ? '' : 's'}{s.preexistingLeftOut ? `; ${s.preexistingLeftOut} file${s.preexistingLeftOut === 1 ? '' : 's'} you had already changed before the session ${s.preexistingLeftOut === 1 ? 'is' : 'are'} left out` : ''}.</li>
              {kind === 'decisions' && s.messages && (
                <li>Your {s.messages.sent} message{s.messages.sent === 1 ? '' : 's'} in this session ({s.messages.chars.toLocaleString('en-US')} characters){s.messages.omitted ? `; ${s.messages.omitted} earlier not sent` : ''}.</li>
              )}
              {s.goal
                ? <li>The goal “{s.goal.title}”: {s.checks.length} acceptance check{s.checks.length === 1 ? '' : 's'}{kind === 'decisions' ? `, its objective and ${s.goal.planItems} plan item${s.goal.planItems === 1 ? '' : 's'}` : ''}.</li>
                : <li>No goal: this session was not started from one, so no acceptance checks.</li>}
              {kind === 'review' && (
                <li>Scoped code review rules: {s.reviewRules === null ? 'none — this build has no collector for them, so none are sent' : `${s.reviewRules}`}.</li>
              )}
            </ul>
            <p className="so-statement"><strong>Nothing else.</strong> {current.statements.nothingElse}</p>
            <p className="so-statement">{current.statements.vendor}</p>
            {profile?.cap.kind === 'usd' ? (
              <div className="so-cap">
                <label htmlFor="so-budget" className="label">Dollar cap</label>
                <input id="so-budget" className="field so-budget" type="number" inputMode="decimal"
                       min={profile.cap.minUsd} max={profile.cap.maxUsd} step="0.05" value={budget}
                       onChange={(e) => setBudget(e.target.value)} />
                <span className="so-statement">{current.statements.cap}</span>
              </div>
            ) : (
              <p className="so-statement">{current.statements.cap}</p>
            )}
            <p className="so-statement faint">{current.statements.environment}</p>
            <p className="so-billed"><Mark glyph="$" word="This is billed." tone="warn" /> {current.statements.billed.replace(/^This is billed\.\s*/, '')}</p>
            <details className="so-argv">
              <summary>The command it runs</summary>
              <pre className="mono">{current.argv.join(' ')}</pre>
            </details>
            {current.refusal && current.refusal !== profile?.refusal && <Note tone="warn">{current.refusal}</Note>}
          </>
        )}
        {!current && providerId && !error && <p className="faint so-statement">Reading what would be sent…</p>}
        {error && <Note tone="error">{error}</Note>}

        <div className="so-dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!current || !!current.refusal || busy} onClick={() => void run()}>
            {busy ? 'Waiting for your confirmation…' : kind === 'review' ? 'Run billed review…' : 'Run billed search…'}
          </button>
        </div>
      </section>
    </div>,
  );
}

/* ── results, under the diff ────────────────────────────────────────── */

const SEVERITY_TONE: Record<string, Tone> = { critical: 'bad', high: 'serious', medium: 'warn', low: 'quiet' };
const RISK_TONE: Record<string, Tone> = { high: 'serious', medium: 'warn', low: 'quiet' };

function where(f: { file: string; lineStart: number | null; lineEnd: number | null }): string {
  if (f.lineStart === null || f.lineEnd === null) return f.file;
  return f.lineStart === f.lineEnd ? `${f.file}:${f.lineStart}` : `${f.file}:${f.lineStart}–${f.lineEnd}`;
}

const VERDICTS: { value: Adjudication; label: string }[] = [
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'refuted', label: 'Refuted' },
  { value: 'unsure', label: 'Not sure' },
];

const LOCATED_WORD: Record<OpinionRunFinding['located'], string | null> = {
  'lines-in-diff': null,
  'file-in-diff': 'lines not in the diff shown',
  'not-in-diff': 'file not in this diff',
};

function FindingRow({ finding, onJudge, onOpen }: {
  finding: OpinionRunFinding; onJudge: (id: string, verdict: Adjudication) => void; onOpen: (file: string, line: number | null) => void;
}) {
  const choice = finding.adjudication;
  return (
    <li className="so-finding" data-adjudication={finding.adjudication}>
      <div className="so-finding-top">
        <Mark glyph="●" word={finding.severity} tone={SEVERITY_TONE[finding.severity] ?? 'quiet'} />
        <strong className="so-finding-title">{finding.title}</strong>
        <span className="faint so-confidence">{Math.round(finding.confidence * 100)}% sure</span>
      </div>
      <button type="button" className="so-where mono" onClick={() => onOpen(finding.file, finding.lineStart)}>{where(finding)}</button>
      {LOCATED_WORD[finding.located] && <Mark glyph="△" word={LOCATED_WORD[finding.located]!} tone="warn" />}
      {finding.body && <p className="so-body">{finding.body}</p>}
      {/* Pressed buttons rather than Segmented: a finding starts unjudged, and a
          segmented group with nothing selected has no tab stop at all. */}
      <div className="rw-actions so-verdict" role="group" aria-label={`Your verdict on “${finding.title}”`}>
        {VERDICTS.map((v) => (
          <button key={v.value} type="button" className="btn btn-sm" aria-pressed={choice === v.value}
                  onClick={() => onJudge(finding.id, choice === v.value ? 'unjudged' : v.value)}>{v.label}</button>
        ))}
      </div>
    </li>
  );
}

function DecisionRow({ entry, onAdd, onOpen, added }: {
  entry: StoredDecision; onAdd: (entry: StoredDecision) => void; onOpen: (file: string, line: number | null) => void; added: boolean;
}) {
  return (
    <li className="so-finding">
      <div className="so-finding-top">
        <Mark glyph="▲" word={`${entry.risk} risk`} tone={RISK_TONE[entry.risk] ?? 'quiet'} />
        <strong className="so-finding-title">{entry.decision}</strong>
      </div>
      <div className="so-touches">
        {entry.touches.map((t) => (
          <button key={t.raw} type="button" className="so-where mono" onClick={() => onOpen(t.file, t.lineStart)}>{t.raw}</button>
        ))}
        {entry.unrealTouches > 0 && <span className="faint">{entry.unrealTouches} cited location{entry.unrealTouches === 1 ? '' : 's'} not in the diff removed</span>}
      </div>
      {entry.whyItMatters && <p className="so-body">{entry.whyItMatters}</p>}
      <div>
        <button type="button" className="btn btn-sm" disabled={added} onClick={() => onAdd(entry)}>{added ? 'Added to review notes' : 'Add to review notes'}</button>
      </div>
    </li>
  );
}

function RunResult({ run, patch, onJudge, onAddNotes, onOpen }: {
  run: OpinionRun; patch: string | null;
  onJudge: (id: string, verdict: Adjudication) => void;
  onAddNotes: (notes: ReviewNote[]) => string | null;
  onOpen: (file: string, line: number | null) => void;
}) {
  const [said, setSaid] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const index = useMemo(() => (patch === null ? null : indexDiff(patch)), [patch]);
  const confirmed = run.findings.filter((f) => f.adjudication === 'confirmed');
  const addConfirmed = () => {
    if (!index) return;
    const notes = confirmed.map((f) => findingNote(f, index, run.profileLabel)).filter((n): n is ReviewNote => n !== null);
    const skipped = confirmed.length - notes.length;
    if (!notes.length) { setSaid({ tone: 'warn', text: 'No confirmed finding points at a file in this diff, so none can be anchored.' }); return; }
    const refused = onAddNotes(notes);
    if (refused) { setSaid({ tone: 'warn', text: refused }); return; }
    setSaid({ tone: 'ok', text: `Added ${notes.length} confirmed finding${notes.length === 1 ? '' : 's'} to the review notes above.${skipped ? ` ${skipped} cite${skipped === 1 ? 's' : ''} a file not in this diff and ${skipped === 1 ? 'was' : 'were'} not added.` : ''} Send review puts them in the message box.` });
  };
  const addDecision = (entry: StoredDecision) => {
    if (!index) return;
    const note = decisionNote(entry, index, run.profileLabel);
    if (!note) { setSaid({ tone: 'warn', text: 'None of this entry\'s locations is in the diff as it is now.' }); return; }
    const refused = onAddNotes([note]);
    if (refused) { setSaid({ tone: 'warn', text: refused }); return; }
    void window.wanigan.opinions.decisionAdded(entry.id).catch(() => {});
    setAdded((cur) => new Set(cur).add(entry.id));
    setSaid({ tone: 'ok', text: 'Added to the review notes above. Send review puts it in the message box.' });
  };

  if (run.status === 'running') return <p className="faint so-pad">Running with {run.profileLabel}. Sent {kb(run.sentBytes)}; started {ago(run.createdAt)}.</p>;
  if (run.status === 'failed') return <div className="so-pad"><Note tone="warn">The call did not complete: {run.error ?? 'no reason was recorded.'}</Note></div>;
  if (run.status === 'unreadable') {
    return (
      <div className="so-pad so-unreadable">
        <Note tone="warn">Could not read findings: {run.reason}</Note>
        <p className="faint so-statement">The reply, as it came:</p>
        <pre className="mono so-raw">{run.raw || '(empty)'}</pre>
      </div>
    );
  }
  return (
    <div className="so-pad">
      {run.kind === 'review' ? (
        <>
          <p className="so-statement">
            <Mark glyph={run.verdict === 'approve' ? '✓' : '◐'} word={run.verdict === 'approve' ? 'approve' : 'needs attention'} tone={run.verdict === 'approve' ? 'ok' : 'warn'} />
            {' '}{run.findings.length} finding{run.findings.length === 1 ? '' : 's'}{run.findingsOmitted ? `, and ${run.findingsOmitted} more not kept` : ''} from {run.profileLabel}. They are candidates until you judge them.
          </p>
          {run.findings.length > 0 && (
            <ol className="so-findings">
              {run.findings.map((f) => <FindingRow key={f.id} finding={f} onJudge={onJudge} onOpen={onOpen} />)}
            </ol>
          )}
          {run.findings.length > 0 && (
            <div className="so-add">
              <button type="button" className="btn btn-sm btn-primary" disabled={!confirmed.length || !index} onClick={addConfirmed}>
                Add {confirmed.length} confirmed to review notes
              </button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="so-statement">
            {run.decisions.length} decision{run.decisions.length === 1 ? '' : 's'} nobody asked for, from {run.profileLabel}; every location below is in the diff.
          </p>
          {droppedSentence(run.dropped) && <Note tone="info">{droppedSentence(run.dropped)}</Note>}
          {run.decisions.length > 0 && (
            <ol className="so-findings">
              {run.decisions.map((d) => <DecisionRow key={d.id} entry={d} onAdd={addDecision} onOpen={onOpen} added={added.has(d.id)} />)}
            </ol>
          )}
        </>
      )}
      {said && <Note tone={said.tone} onDismiss={() => setSaid(null)}>{said.text}</Note>}
    </div>
  );
}

function findingCounts(r: OpinionLedger['rows'][number]): string {
  return `${r.confirmed} confirmed · ${r.refuted} refuted · ${r.unsure} not sure${r.unjudged ? ` · ${r.unjudged} unjudged` : ''}`;
}

function LedgerTotals({ ledger }: { ledger: OpinionLedger }) {
  return (
    <p className="faint so-statement">
      ${ledger.pricedUsd.toFixed(2)} recorded across {ledger.pricedRuns} priced run{ledger.pricedRuns === 1 ? '' : 's'}
      {ledger.unpricedRuns ? ` · ${ledger.unpricedRuns} run${ledger.unpricedRuns === 1 ? '' : 's'} with no recorded price, not counted` : ''}. As each CLI reported it; never estimated.
    </p>
  );
}

/**
 * The ledger of second opinions. In Insights it is a table across sessions; in
 * the code rail, which is a column a few hundred pixels wide, the same rows are
 * a list, because a seven-column table there is a table nobody can read
 * without scrolling sideways.
 */
export function OpinionLedgerTable({ ledger, showSession }: { ledger: OpinionLedger; showSession?: boolean }) {
  if (!ledger.rows.length) return <p className="faint so-statement">No second opinion has run{showSession ? '' : ' for this session'}.</p>;
  if (!showSession) {
    return (
      <>
        <ul className="so-ledger-list">
          {ledger.rows.map((r) => (
            <li key={r.id}>
              <span className="so-ledger-what">{r.kind === 'review' ? 'Second review' : 'Decisions'} · {r.profileLabel}{r.status !== 'done' ? ` · ${r.status}` : ''}</span>
              <span className="mono so-ledger-cost">{r.costText}</span>
              <span className="so-counts faint">
                {r.status !== 'done' ? '—' : r.kind === 'review' ? findingCounts(r) : `${r.kept} kept · ${r.dropped} dropped`} · {ago(r.createdAt)}
              </span>
            </li>
          ))}
        </ul>
        <LedgerTotals ledger={ledger} />
      </>
    );
  }
  return (
    <>
      <div className="so-table-wrap">
        <table className="so-table">
          <caption className="sr-only">Second opinions: reviewer, cost and what came of them</caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              {showSession && <th scope="col">Session</th>}
              <th scope="col">Reviewer</th>
              <th scope="col">Cost</th>
              <th scope="col">Findings</th>
              <th scope="col">Entries</th>
              <th scope="col">When</th>
            </tr>
          </thead>
          <tbody>
            {ledger.rows.map((r) => (
              <tr key={r.id}>
                <td>{r.kind === 'review' ? 'Second review' : 'Decisions'}{r.status !== 'done' ? <span className="faint"> · {r.status}</span> : null}</td>
                {showSession && <td className="so-cell-wrap">{r.sessionLabel ?? r.sessionId}</td>}
                <td>{r.profileLabel}</td>
                <td className="mono">{r.costText}</td>
                <td>{r.kind === 'review' && r.status === 'done'
                  ? <span className="so-counts">{findingCounts(r)}</span>
                  : <span className="faint">—</span>}</td>
                <td>{r.kind === 'decisions' && r.status === 'done'
                  ? <span className="so-counts">{r.kept} kept · {r.dropped} dropped</span>
                  : <span className="faint">—</span>}</td>
                <td className="faint">{ago(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LedgerTotals ledger={ledger} />
    </>
  );
}

/**
 * The results of this session's second opinions, in the file list's place
 * while open rather than as a section under the diff: a paid-for answer the
 * operator asked for must not sit below a four-thousand-line diff. A location
 * in it opens that line in the diff below it, and Close brings the list back.
 */
export function SecondOpinionsSection({ sessionId, runs, error, refreshKey, onChanged, onAddNotes, onOpen, onClose }: {
  sessionId: string;
  runs: OpinionRun[];
  error: string | null;
  refreshKey: string;
  onChanged: () => void;
  onAddNotes: (notes: ReviewNote[]) => string | null;
  onOpen: (file: string, line: number | null) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [patch, setPatch] = useState<string | null>(null);
  const [ledger, setLedger] = useState<OpinionLedger | null>(null);
  const [judgeErr, setJudgeErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.reviewWork.patch(sessionId).then((p) => { if (live) setPatch(p.patch); }).catch(() => { if (live) setPatch(null); });
    return () => { live = false; };
  }, [sessionId, refreshKey]);
  const runKey = runs.map((r) => `${r.id}:${r.status}:${r.findings.map((f) => f.adjudication[0]).join('')}`).join('|');
  useEffect(() => {
    let live = true;
    window.wanigan.opinions.ledger(sessionId).then((l) => { if (live) setLedger(l); }).catch(() => {});
    return () => { live = false; };
  }, [sessionId, runKey]);
  const run = runs.find((r) => r.id === selected) ?? runs[0] ?? null;
  const judge = (id: string, verdict: Adjudication) => {
    setJudgeErr(null);
    window.wanigan.opinions.adjudicate(id, verdict).then(onChanged).catch((e) => setJudgeErr(msg(e)));
  };
  return (
    <section id="so-results" className="so-panel" aria-label="Second opinions results">
      <div className="rw-find-head">
        <strong>Second opinions</strong>
        <span className="faint">
          {runs.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}${runs.some((r) => r.status === 'running') ? ' · one running' : ''}` : error ? 'unreadable' : 'none yet'}
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>Close</button>
      </div>
      <div className="so-panel-body">
      {error && <Note tone="error">{error}</Note>}
      {!runs.length && !error && (
        <p className="faint rw-section-empty">A second review or a search for unrequested decisions runs only when you start one from the bar above, and says what it will send and that it is billed before it does.</p>
      )}
      {runs.length > 1 && (
        <div className="so-run-pick">
          <label htmlFor="so-run" className="faint">Showing</label>
          <select id="so-run" className="field so-select" value={run?.id ?? ''} onChange={(e) => setSelected(e.target.value)}>
            {runs.map((r) => <option key={r.id} value={r.id}>{r.kind === 'review' ? 'Second review' : 'Decisions'} · {r.profileLabel} · {ago(r.createdAt)}</option>)}
          </select>
        </div>
      )}
      {run && (
        <>
          {run.status !== 'running' && run.kind === 'review' && (
            <p className="faint so-statement">Sent {kb(run.sentBytes)}{run.truncated ? ` of ${kb(run.diffBytes)}` : ''} to {run.vendor} · {run.costText} · {run.inTokens.toLocaleString('en-US')} tokens in, {run.outTokens.toLocaleString('en-US')} out</p>
          )}
          {run.status !== 'running' && run.kind === 'decisions' && (
            <p className="faint so-statement">Sent {kb(run.sentBytes)}{run.truncated ? ` of ${kb(run.diffBytes)}` : ''} to {run.vendor} · {run.costText}</p>
          )}
          <RunResult key={run.id} run={run} patch={patch} onJudge={judge} onAddNotes={onAddNotes} onOpen={onOpen} />
        </>
      )}
      {judgeErr && <Note tone="error">{judgeErr}</Note>}
      {ledger && runs.length > 0 && (
        <div className="so-ledger">
          <div className="label">Ledger for this session</div>
          <OpinionLedgerTable ledger={ledger} />
        </div>
      )}
      </div>
    </section>
  );
}

/* ── Spend ──────────────────────────────────────────────────────────── */

export function SecondOpinionsSpend() {
  const [ledger, setLedger] = useState<OpinionLedger | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.opinions.ledger().then((l) => { if (live) { setLedger(l); setError(null); } }).catch((e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, []);
  return (
    <section className="card so-spend" aria-label="Second opinions ledger">
      <div className="so-spend-head">
        <h3>Second opinions</h3>
        <span className="faint">Billed reviews and decision searches you started from a session&apos;s code rail. Observed counts only.</span>
      </div>
      {error && <Note tone="warn">The ledger could not be read: {error}</Note>}
      {!ledger && !error && <p className="faint so-statement">Reading the ledger…</p>}
      {ledger && <OpinionLedgerTable ledger={ledger} showSession />}
    </section>
  );
}
