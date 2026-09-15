import { useEffect, useState } from 'react';
import type { Measure, SessionAnatomy } from '@shared/session-anatomy';
import { Icon, num } from './bits';
import '../styles/cost.css';

/**
 * Where this session's time and context went, in the Timeline beside Tool
 * timing. Each figure carries its own status word — observed, inferred, or not
 * recorded — because a gap between two timestamps is a fact, and calling it
 * "waiting on you" is a reading of that fact.
 */

function duration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function Row({ label, m, format }: { label: string; m: Measure<number>; format: (n: number) => string }) {
  return (
    <div className="cost-anatomy-row">
      <dt>{label}</dt>
      <dd>
        <strong>{m.value === null ? '—' : format(m.value)}</strong>
        <span className={`cost-anatomy-status is-${m.status}`}>{m.status === 'not-recorded' ? 'not recorded' : m.status}</span>
        {m.note && <span className="cost-cell-sub">{m.note}</span>}
      </dd>
    </div>
  );
}

export default function SessionAnatomyPanel({ sessionId, eventCount }: { sessionId: string; eventCount: number }) {
  const [anatomy, setAnatomy] = useState<SessionAnatomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.cost.anatomy(sessionId)
      .then((value) => { if (live) { setAnatomy(value); setError(null); } })
      .catch((e) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
    // Re-read when the timeline has taken in more events.
  }, [sessionId, eventCount]);
  return (
    <details className="tl-summary cost-anatomy">
      <summary><span>Session anatomy</span><span>{anatomy ? `${num(anatomy.eventCount)} events read` : error ? 'could not read' : 'reading'} <Icon name="chevron-down" /></span></summary>
      {error && !anatomy && <p className="faint cost-fine">{error}</p>}
      {anatomy && (
        <dl className="cost-anatomy-grid">
          <Row label="Before the first edit" m={anatomy.orientationMs} format={duration} />
          <Row label="In edits and commands" m={anatomy.editsAndCommandsMs} format={duration} />
          <Row label="Waiting on the operator" m={anatomy.waitingMs} format={duration} />
          <Row label="Peak context" m={anatomy.peakContextTokens} format={(n) => `${num(n)} tokens`} />
          <Row label="Compactions" m={anatomy.compactions} format={num} />
          <Row label="Subagents started" m={anatomy.subagents} format={num} />
        </dl>
      )}
    </details>
  );
}
