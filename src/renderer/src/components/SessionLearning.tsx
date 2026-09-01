import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CandidateStatus,
  KnowledgeKind,
  KnowledgeStatus,
  LearningSignal,
  SessionBriefingRecord,
  SessionLearningLedger,
} from '@shared/types';
import { ago, num } from './bits';
import '../styles/session-learning.css';

/**
 * What this session was told, and what it recorded — from stored rows only.
 *
 * Three rules shape the surface:
 *  - Assert nothing SQLite did not record. A briefing record with zero entries
 *    ("retrieval ran, nothing matched") and no briefing record at all are two
 *    different facts and render as two different lines.
 *  - Counts are plain; token numbers are bytes÷4 heuristics and always carry
 *    the ~ and the word "est." — never dressed up as measurements.
 *  - Push refreshes are quiet. learningChanged refetches behind the current
 *    render; the loading state appears only for a fresh mount or a retry.
 */

type Phase = 'loading' | 'error' | 'ready';

/* Categorical kind colours by fixed slot; the printed word carries identity. */
const KIND_COLOR: Record<KnowledgeKind, string> = {
  instruction: 'var(--series-1)',
  rule: 'var(--series-2)',
  memory: 'var(--series-3)',
  skill: 'var(--series-4)',
  mission: 'var(--text-dim)',
  gate: 'var(--text-dim)',
  eval: 'var(--text-dim)',
  'project-map': 'var(--text-dim)',
};

const ITEM_STATUS: Record<KnowledgeStatus, { glyph: string; word: string; color: string }> = {
  active:      { glyph: '●', word: 'active',      color: 'var(--good)' },
  quarantined: { glyph: '⊘', word: 'quarantined', color: 'var(--serious)' },
  retired:     { glyph: '·', word: 'retired',     color: 'var(--text-faint)' },
};

const CANDIDATE_STATUS: Record<CandidateStatus, { glyph: string; word: string; color: string }> = {
  pending:    { glyph: '○', word: 'pending review', color: 'var(--warning)' },
  approved:   { glyph: '●', word: 'approved',       color: 'var(--good)' },
  rejected:   { glyph: '✕', word: 'rejected',       color: 'var(--text-dim)' },
  snoozed:    { glyph: '·', word: 'snoozed',        color: 'var(--text-faint)' },
  promoted:   { glyph: '●', word: 'promoted',       color: 'var(--good)' },
  applied:    { glyph: '●', word: 'applied',        color: 'var(--good)' },
  failed:     { glyph: '✕', word: 'failed',         color: 'var(--critical)' },
  superseded: { glyph: '·', word: 'superseded',     color: 'var(--text-faint)' },
};

const RECENT = 12;

/** The main-process ledger read returns at most this many signals (ledger.ts). */
const LEDGER_CAP = 300;

const plural = (n: number, word: string) => `${num(n)} ${word}${n === 1 ? '' : 's'}`;

const fullDate = (ts: number) =>
  new Date(ts).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

function Mark({ glyph, word, color, title }: { glyph: string; word: string; color: string; title?: string }) {
  return (
    <span className="sl-mark" style={{ color }} title={title}>
      <span className="g" aria-hidden="true">{glyph}</span>{word}
    </span>
  );
}

function KindChip({ kind }: { kind: KnowledgeKind }) {
  return <span className="sl-kind" style={{ color: KIND_COLOR[kind] ?? 'var(--text-dim)' }}>{kind}</span>;
}

function Sep() {
  return <span className="sl-sep" aria-hidden="true">·</span>;
}

/* ── signals, grouped by mechanism ───────────────────────────────────── */

type SignalGroups = { toolOk: number; toolFail: number; permission: number; compaction: number; teach: number; other: number };

function groupSignals(signals: LearningSignal[]): SignalGroups {
  const g: SignalGroups = { toolOk: 0, toolFail: 0, permission: 0, compaction: 0, teach: 0, other: 0 };
  for (const s of signals) {
    if (s.kind === 'tool-success') g.toolOk++;
    else if (s.kind === 'tool-failure') g.toolFail++;
    else if (s.kind === 'permission-denied') g.permission++;
    else if (s.kind === 'compaction') g.compaction++;
    else if (s.kind === 'explicit-teach' || s.kind === 'correction') g.teach++;
    else g.other++;
  }
  return g;
}

function SignalChips({ groups }: { groups: SignalGroups }) {
  const chips: { key: string; glyph: string; word: string; n: number; color: string; title: string }[] = [
    // The glyph is aria-hidden, so the word alone must distinguish the two
    // tool chips for assistive tech — a bare "tool"/"tool" pair does not.
    { key: 'ok',   glyph: '✓', word: 'tool ok', n: groups.toolOk,   color: 'var(--good)',       title: 'Tool calls recorded as completed.' },
    { key: 'fail', glyph: '✕', word: 'tool failed', n: groups.toolFail, color: 'var(--warning)', title: 'Tool calls recorded as failed.' },
    { key: 'perm', glyph: '⊘', word: 'permission-denied', n: groups.permission, color: 'var(--serious)', title: 'Recorded permission denials.' },
    { key: 'comp', glyph: '≡', word: 'compaction', n: groups.compaction, color: 'var(--series-1)', title: 'Recorded context compaction events.' },
    { key: 'teach', glyph: '✎', word: 'teach/correction', n: groups.teach, color: 'var(--series-2)', title: 'Explicit teach or correction signals recorded from this session.' },
    { key: 'other', glyph: '·', word: 'other', n: groups.other,    color: 'var(--text-dim)',   title: 'Other recorded signal kinds (session lifecycle, file changes, gates).' },
  ];
  return (
    <>
      {chips.filter((c) => c.n > 0).map((c) => (
        <span key={c.key} className="sl-chip" style={{ color: c.color }} title={c.title}>
          <span className="g" aria-hidden="true">{c.glyph}</span>{c.word} <span className="sl-num">{num(c.n)}</span>
        </span>
      ))}
    </>
  );
}

function SignalRow({ signal }: { signal: LearningSignal }) {
  const d = signal.detail ?? {};
  const ok = typeof d.ok === 'boolean' ? d.ok : undefined;
  const failed = ok === false || /-(failure|denied)$/.test(signal.kind);
  const succeeded = !failed && (ok === true || /-(success|passed)$/.test(signal.kind));
  const mark = failed
    ? { glyph: '✕', color: 'var(--warning)' }
    : succeeded ? { glyph: '✓', color: 'var(--good)' } : { glyph: '·', color: 'var(--text-faint)' };
  const toolName = typeof d.toolName === 'string' && d.toolName ? d.toolName : null;
  return (
    <li className="sl-item">
      <span className="sl-glyph" style={{ color: mark.color }} aria-hidden="true">{mark.glyph}</span>
      <span className="sl-trunc" title={signal.summary}>{signal.summary}</span>
      {toolName && <span className="sl-tool" title={toolName}>{toolName}</span>}
      {d.learningCandidateEligible === false && (
        <span className="sl-shell" title="Shell command text is discarded before storage; this row is counted operationally but never consolidated.">shell — content discarded</span>
      )}
      {d.summaryRedacted === true && (
        <span className="sl-badge" title="Credential-like content was removed before this summary was stored.">redacted</span>
      )}
      <span className="sl-when">{ago(signal.createdAt)}</span>
    </li>
  );
}

/* ── briefing ────────────────────────────────────────────────────────── */

function briefingHeldBack(rec: SessionBriefingRecord) {
  const parts: string[] = [];
  if (rec.omittedStale > 0) parts.push(`${num(rec.omittedStale)} stale-cited`);
  if (rec.omittedBudget > 0) parts.push(`${num(rec.omittedBudget)} over budget`);
  if (parts.length === 0) return null;
  return (
    <Mark glyph="⊘" word={`held back: ${parts.join(' · ')}`} color="var(--warning)"
      title={'stale-cited: quarantined at retrieval because a stored file citation no longer verified. over budget: ranked but dropped once the token ceiling was reached.'} />
  );
}

function BriefingLine({ rec }: { rec: SessionBriefingRecord | null }) {
  if (!rec) {
    return (
      <Mark glyph="·" word="no briefing recorded for this session" color="var(--text-faint)"
        title="Sessions launched before briefing recording existed, non-learning harnesses, and sessions with learning disabled all look like this — the panel asserts only what SQLite recorded." />
    );
  }
  if (rec.entries.length === 0) {
    return (
      <>
        <Mark glyph="○" word="retrieval ran" color="var(--text-dim)"
          title="A briefing record exists for this session with zero entries — retrieval executed and admitted nothing." />
        <span>— nothing in the knowledge store matched this task</span>
        {briefingHeldBack(rec)}
        <Sep /><span className="sl-when" title={fullDate(rec.at)}>{ago(rec.at)}</span>
      </>
    );
  }
  return (
    <>
      <Mark glyph="●" word="briefed" color="var(--good)" />
      <Sep /><span className="sl-num">{plural(rec.entries.length, 'item')}</span>
      <Sep /><span className="sl-num">~{num(rec.estimatedTokens)} est. tokens of {num(rec.maxTokens)} budget</span>
      <Sep /><span>via {rec.delivery}</span>
      {briefingHeldBack(rec)}
      <Sep /><span className="sl-when" title={fullDate(rec.at)}>{ago(rec.at)}</span>
    </>
  );
}

/* ── the panel ───────────────────────────────────────────────────────── */

export default function SessionLearning({ sessionId, harness, compact }: {
  sessionId: string;
  harness?: string | null;
  compact?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [ledger, setLedger] = useState<SessionLearningLedger | null>(null);
  const [openBriefing, setOpenBriefing] = useState(false);
  const [openSignals, setOpenSignals] = useState(false);
  // Monotonic fetch id: a stale response (session switched, unmount) is dropped.
  const seq = useRef(0);

  const load = useCallback(async (quiet: boolean) => {
    const mine = ++seq.current;
    if (!quiet) { setPhase('loading'); setErr(null); }
    try {
      const next = await window.wanigan.learning.sessionLedger(sessionId);
      if (seq.current !== mine) return;
      setLedger(next); setErr(null); setPhase('ready');
    } catch (e) {
      if (seq.current !== mine) return;
      // A quiet refresh keeps the last-good ledger instead of flashing an error.
      if (!quiet) { setErr(e instanceof Error ? e.message : String(e)); setPhase('error'); }
    }
  }, [sessionId]);

  useEffect(() => {
    setLedger(null); setOpenBriefing(false); setOpenSignals(false);
    void load(false);
    return () => { seq.current++; };
  }, [load]);

  useEffect(() => {
    let timer: number | undefined;
    const off = window.wanigan.on.learningChanged(() => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => { timer = undefined; void load(true); }, 1000);
    });
    return () => { off(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [load]);

  const briefing = ledger?.briefings[0] ?? null;
  const signals = ledger?.signals ?? [];
  const groups = groupSignals(signals);
  const reach = (ledger?.contributions.length ?? 0) + (ledger?.candidates.length ?? 0) > 0;
  const empty = !!ledger && !ledger.briefings.length && !signals.length && !reach;
  const recent = signals.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, RECENT);

  const codexNote = harness === 'codex';
  const unverifiedNote = !codexNote && harness !== 'claude-code' && signals.length === 0;

  let body: React.ReactNode;
  if (phase === 'loading') {
    body = <p className="sl-state">Reading the learning ledger…</p>;
  } else if (phase === 'error') {
    body = (
      <div className="sl-row sl-error">
        <p>{err ?? 'The learning ledger could not be read.'}</p>
        <button className="btn" onClick={() => void load(false)}>Retry</button>
      </div>
    );
  } else if (empty) {
    body = (
      <>
        <p className="sl-state">
          Nothing recorded yet. Tool activity in Claude Code sessions records signals as it
          happens; a briefing is recorded at launch when learning is enabled.
        </p>
        {!compact && codexNote && <CodexNote />}
        {!compact && unverifiedNote && <UnverifiedNote />}
      </>
    );
  } else if (compact) {
    body = (
      <>
        <div className="sl-line"><BriefingLine rec={briefing} /></div>
        <div className="sl-line">
          <strong className="sl-num">{plural(signals.length, 'signal')}</strong>
          <SignalChips groups={groups} />
        </div>
      </>
    );
  } else {
    body = (
      <>
        <div className="sl-row">
          <div className="sl-line">
            <BriefingLine rec={briefing} />
            {briefing && briefing.entries.length > 0 && (
              <button className="sl-expand" aria-expanded={openBriefing} onClick={() => setOpenBriefing((v) => !v)}>
                <span className="g" aria-hidden="true">{openBriefing ? '▼' : '▶'}</span>
                {openBriefing ? 'hide items' : 'items'}
              </button>
            )}
          </div>
          {briefing && openBriefing && (
            <ul className="sl-list">
              {briefing.entries.map((e, i) => (
                <li className="sl-item" key={`${e.itemId}-${i}`}>
                  <KindChip kind={e.kind} />
                  <span className="sl-trunc" title={e.title}>{e.title}</span>
                  <span className="sl-when">~{num(e.estimatedTokens)} est.</span>
                </li>
              ))}
            </ul>
          )}
          {briefing && (
            <p className="sl-cap">
              Read from the stored briefing record for this session
              {ledger && ledger.briefings.length > 1 ? ` (newest of ${ledger.briefings.length})` : ''};
              token numbers are bytes÷4 estimates.
            </p>
          )}
        </div>

        <div className="sl-row">
          <div className="sl-line">
            {signals.length === 0
              ? <Mark glyph="·" word="no signals recorded" color="var(--text-faint)" />
              : <strong className="sl-num">{plural(signals.length, 'signal')}</strong>}
            <SignalChips groups={groups} />
            {signals.length > 0 && (
              <button className="sl-expand" aria-expanded={openSignals} onClick={() => setOpenSignals((v) => !v)}>
                <span className="g" aria-hidden="true">{openSignals ? '▼' : '▶'}</span>
                {openSignals ? 'hide recent' : 'recent'}
              </button>
            )}
          </div>
          {openSignals && (
            <ul className="sl-list">
              {recent.map((s) => <SignalRow key={s.id} signal={s} />)}
            </ul>
          )}
          <p className="sl-cap">
            Recorded from session events; credential-redacted; identical repeats collapse into one row.
            {openSignals && signals.length > RECENT ? ` Showing the newest ${RECENT} of ${num(signals.length)}.` : ''}
            {signals.length >= LEDGER_CAP
              ? ` The ledger read returns at most ${num(LEDGER_CAP)}, so this is the newest ${num(LEDGER_CAP)} — older signals are neither listed nor counted above.`
              : ''}
          </p>
        </div>

        {reach && ledger && (
          <div className="sl-row">
            <div className="sl-line"><strong>Evidence from this session reached:</strong></div>
            <ul className="sl-list">
              {ledger.contributions.map((c) => {
                const s = ITEM_STATUS[c.status] ?? ITEM_STATUS.retired;
                return (
                  <li className="sl-item" key={`i-${c.itemId}`}>
                    <KindChip kind={c.kind} />
                    <span className="sl-trunc" title={c.title}>{c.title}</span>
                    <span className="sl-when sl-num">{plural(c.evidenceCount, 'evidence row')}</span>
                    <Mark glyph={s.glyph} word={s.word} color={s.color} />
                  </li>
                );
              })}
              {ledger.candidates.map((c) => {
                const s = CANDIDATE_STATUS[c.status] ?? CANDIDATE_STATUS.pending;
                return (
                  <li className="sl-item" key={`c-${c.candidateId}`}>
                    <KindChip kind={c.targetKind} />
                    <span className="sl-trunc" title={c.title}>{c.title}</span>
                    <span className="sl-when">candidate</span>
                    <Mark glyph={s.glyph} word={s.word} color={s.color} />
                  </li>
                );
              })}
            </ul>
            <p className="sl-cap">Stored as citation rows — auditable in Learning → Knowledge.</p>
          </div>
        )}

        {codexNote && <CodexNote />}
        {unverifiedNote && <UnverifiedNote />}
      </>
    );
  }

  return (
    <section className="card sl-panel" aria-label="Session learning ledger">
      <header className="sl-head">
        <span className="label">Learning</span>
        {phase === 'ready' && !empty && !compact && <small>this session’s recorded ledger</small>}
      </header>
      {body}
    </section>
  );
}

function CodexNote() {
  return (
    <p className="sl-note">
      <span className="g" aria-hidden="true" style={{ color: 'var(--series-1)' }}>◑</span>
      <span>lifecycle-only observation — Codex exposes no per-tool events; only turn completion and approvals are recorded.</span>
    </p>
  );
}

function UnverifiedNote() {
  return (
    <p className="sl-note">
      <span className="g" aria-hidden="true" style={{ color: 'var(--text-faint)' }}>·</span>
      <span>This harness has no verified observation channel; absence of signals is not absence of activity.</span>
    </p>
  );
}
