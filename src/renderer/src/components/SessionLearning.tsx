import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CandidateStatus,
  KnowledgeKind,
  KnowledgeStatus,
  LearningSignal,
  SessionBriefingRecord,
  SessionLearningLedger,
} from '@shared/types';
import { Note, SectionHead, Segmented, ago, num } from './bits';
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

const briefingKey = (record: SessionBriefingRecord) => `${record.at}:${record.delivery}:${record.sessionStartAt ?? ''}`;

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
  const detail = signal.detail ?? {};
  const failed = detail.ok === false || /-(failure|denied)$/.test(signal.kind);
  const tool = typeof detail.toolName === 'string' ? detail.toolName : null;
  return <li className="sl-signal">
    <details>
      <summary><span className="sl-glyph" aria-hidden="true">{failed ? '✕' : '·'}</span><span className="sl-signal-title">{signal.summary}</span><time>{ago(signal.createdAt)}</time><span className="sl-signal-toggle" aria-hidden="true">›</span></summary>
      <p className="sl-signal-copy">{signal.summary}</p>
      <div className="sl-line"><span>{signal.kind}</span>{tool && <span>{tool}</span>}<time>{fullDate(signal.createdAt)}</time></div>
      {detail.learningCandidateEligible === false && <p className="sl-cap">Shell command text was discarded before storage. This signal is counted operationally and excluded from consolidation.</p>}
      {detail.summaryRedacted === true && <p className="sl-cap">Credential-like content was removed before this summary was stored.</p>}
    </details>
  </li>;
}

/* ── briefing ────────────────────────────────────────────────────────── */

function briefingHeldBack(rec: SessionBriefingRecord) {
  const parts: string[] = [];
  if (rec.omittedStale > 0) parts.push(`${num(rec.omittedStale)} stale-cited`);
  if (rec.omittedBudget > 0) parts.push(`${num(rec.omittedBudget)} over budget`);
  if (rec.omittedUnsynthesized !== null && rec.omittedUnsynthesized > 0) parts.push(`${num(rec.omittedUnsynthesized)} unsynthesized`);
  if (rec.omittedUnverified !== null && rec.omittedUnverified > 0) parts.push(`${num(rec.omittedUnverified)} unverified`);
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
        <span>— no items admitted to this briefing</span>
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
  sessionId: string; harness?: string | null; compact?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [err, setErr] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [ledger, setLedger] = useState<SessionLearningLedger | null>(null);
  const [area, setArea] = useState<'briefing' | 'signals' | 'reach'>('briefing');
  const [selectedBriefing, setSelectedBriefing] = useState('latest');
  const [query, setQuery] = useState('');
  const [failures, setFailures] = useState(false);
  const [limit, setLimit] = useState(RECENT);
  const seq = useRef(0);
  const load = useCallback(async (quiet: boolean) => {
    const mine = ++seq.current;
    if (!quiet) { setPhase('loading'); setErr(null); }
    try {
      const next = await window.wanigan.learning.sessionLedger(sessionId);
      if (seq.current !== mine) return;
      setLedger(next); setErr(null); setStale(false); setPhase('ready');
    } catch (e) {
      if (seq.current !== mine) return;
      setErr(e instanceof Error ? e.message : String(e));
      if (quiet) setStale(true); else setPhase('error');
    }
  }, [sessionId]);
  useEffect(() => {
    setLedger(null); setArea('briefing'); setSelectedBriefing('latest'); setQuery(''); setFailures(false); setLimit(RECENT); setStale(false);
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
  useEffect(() => setLimit(RECENT), [query, failures]);
  const selectedRecord = ledger?.briefings.find(record => briefingKey(record) === selectedBriefing);
  const briefing = selectedRecord ?? ledger?.briefings[0] ?? null;
  const signals = ledger?.signals ?? [];
  const groups = groupSignals(signals);
  const reach = (ledger?.contributions.length ?? 0) + (ledger?.candidates.length ?? 0);
  const empty = !!ledger && !ledger.briefings.length && !signals.length && !reach;
  const filtered = signals.filter(signal => (`${signal.summary} ${signal.kind} ${signal.detail?.toolName ?? ''}`).toLowerCase().includes(query.trim().toLowerCase())
    && (!failures || signal.detail?.ok === false || /-(failure|denied)$/.test(signal.kind))).sort((a,b) => b.createdAt-a.createdAt);
  const codexNote = harness === 'codex';
  const unverifiedNote = !codexNote && harness !== 'claude-code' && signals.length === 0;
  return <section className="sl-panel" aria-label="Session learning ledger">
    <SectionHead label="Session learning" />
    {phase === 'loading' && <p className="sl-state" role="status">Reading the learning ledger…</p>}
    {phase === 'error' && <Note tone="error" action={{ label: 'Retry ledger read', run: () => load(false) }}>{err ?? 'The learning ledger could not be read.'}</Note>}
    {phase === 'ready' && <>
      {stale && <Note tone="warn" action={{ label: 'Retry ledger update', run: () => load(true) }}>Update unavailable. Showing the last successful read. {err}</Note>}
      {empty ? <p className="sl-state">Nothing recorded for this session yet. Briefings and observed learning signals appear here when they are recorded.</p> : compact ? <>
        <div className="sl-line"><BriefingLine rec={briefing} /></div><div className="sl-line"><strong>{plural(signals.length,'signal')}</strong><SignalChips groups={groups} /></div>
      </> : <>
        <Segmented label="Session learning area" value={area} onChange={setArea} options={[{value:'briefing',label:'Briefing'},{value:'signals',label:`Signals ${signals.length}`},{value:'reach',label:`Contributions ${reach}`}]} />
        {area === 'briefing' && <div className="sl-area">
          <p className="sl-intro">What this session was given.</p>
          {ledger && ledger.briefings.length > 1 && <select className="field" aria-label="Recorded briefing" value={selectedRecord ? selectedBriefing : 'latest'} onChange={event => setSelectedBriefing(event.target.value)}><option value="latest">Latest briefing</option>{ledger.briefings.map((record,index) => <option key={`${record.at}-${index}`} value={briefingKey(record)}>{fullDate(record.at)}</option>)}</select>}
          <div className="sl-line"><BriefingLine rec={briefing} /></div>
          {briefing && <>
            <ul className="sl-list">{briefing.entries.map((entry,index) => <li className="sl-briefing-item" key={`${entry.itemId}-${index}`}><KindChip kind={entry.kind} /><strong>{entry.title}</strong><span className="sl-when">~{num(entry.estimatedTokens)} est. tokens</span><p className="sl-cap">Citations: {entry.checked === null ? 'checked count not recorded' : `${entry.checked} checked`}; {entry.skipped === null ? 'skipped count not recorded' : `${entry.skipped} skipped`}.</p></li>)}</ul>
            <p className="sl-cap">Stored briefing evidence. Token numbers are bytes÷4 estimates.</p>
          </>}
        </div>}
        {area === 'signals' && <div className="sl-area">
          <p className="sl-intro">What this session recorded.</p>
          <div className="sl-line"><SignalChips groups={groups} /></div>
          <input className="field" type="search" aria-label="Search learning signals" value={query} onChange={event => setQuery(event.target.value)} placeholder="Find a signal or tool" />
          <label className="sl-filter"><input type="checkbox" checked={failures} onChange={event => setFailures(event.target.checked)} />Failures and denials only</label>
          {!filtered.length && <p className="sl-state">{signals.length ? 'No signals match this view.' : 'No signals recorded.'}{signals.length > 0 && <button className="btn btn-sm" onClick={() => { setQuery(''); setFailures(false); }}>Clear signal filters</button>}</p>}
          <ul className="sl-list">{filtered.slice(0,limit).map(signal => <SignalRow key={signal.id} signal={signal} />)}</ul>
          <div className="sl-list-end"><span>{Math.min(limit,filtered.length)} of {filtered.length} matching signals</span>{filtered.length > limit && <button className="btn btn-sm" onClick={() => setLimit(value => value+RECENT)}>Show more signals</button>}</div>
          <p className="sl-cap">Recorded from session events; credential-redacted; identical repeats collapse into one row.{signals.length >= LEDGER_CAP ? ` This read contains only the newest ${num(LEDGER_CAP)} signals. Older signals are not counted here.` : ''}</p>
        </div>}
        {area === 'reach' && <div className="sl-area">
          <p className="sl-intro">Where this session’s evidence went.</p>
          {!reach && <p className="sl-state">No knowledge contributions or candidates are linked to this session yet.</p>}
          <ul className="sl-list">{ledger?.contributions.map(item => { const status=ITEM_STATUS[item.status] ?? ITEM_STATUS.retired; return <li className="sl-contribution" key={item.itemId}><KindChip kind={item.kind} /><strong>{item.title}</strong><Mark {...status} /><span className="sl-when">{plural(item.evidenceCount,'evidence row')}</span></li>; })}
          {ledger?.candidates.map(item => { const status=CANDIDATE_STATUS[item.status] ?? CANDIDATE_STATUS.pending; return <li className="sl-contribution" key={item.candidateId}><KindChip kind={item.targetKind} /><strong>{item.title}</strong><Mark {...status} /><span className="sl-when">Candidate</span></li>; })}</ul>
          <p className="sl-cap">Stored citation links. Review the full records in Learning → Knowledge.</p>
        </div>}
      </>}
      {!compact && codexNote && <CodexNote />}{!compact && unverifiedNote && <UnverifiedNote />}
    </>}
  </section>;
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
