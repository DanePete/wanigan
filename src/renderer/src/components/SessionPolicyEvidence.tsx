import { useEffect, useState } from 'react';
import type { PolicySignal } from '@shared/types';
import { Mark, ago, type Tone } from './bits';
import '../styles/policy-evidence.css';

/**
 * The policy evidence one session left behind, on its timeline: history
 * rewrites pinned as evidence and the commands that performed them, tripwires,
 * and runs of fast approvals. Hidden entirely when there is none, which is the
 * ordinary case.
 */

const KIND: Record<string, { glyph: string; word: string; tone: Tone }> = {
  'git-rewrite': { glyph: '⎇', word: 'history rewritten, evidence pinned', tone: 'bad' },
  'git-rewrite-command': { glyph: '⎇', word: 'rewriting command', tone: 'warn' },
  'git-rewrite-pruned': { glyph: '·', word: 'evidence pins retired', tone: 'quiet' },
  tripwire: { glyph: '⚑', word: 'tripwire, not containment', tone: 'warn' },
  fatigue: { glyph: '≫', word: 'fast approvals, inferred', tone: 'warn' },
};

export default function SessionPolicyEvidence({ sessionId }: { sessionId: string }) {
  const [signals, setSignals] = useState<PolicySignal[]>([]);
  useEffect(() => {
    let live = true;
    const read = () => {
      window.wanigan.policyEvidence.session(sessionId)
        .then((r) => { if (live) setSignals(r.signals); })
        .catch(() => { /* evidence is supplementary; the timeline stands without it */ });
    };
    read();
    const off = window.wanigan.on.sessionEvent((e) => {
      if (e.sessionId === sessionId && (e.event === 'Stop' || e.event === 'PreToolUse')) window.setTimeout(read, 1200);
    });
    return () => { live = false; off(); };
  }, [sessionId]);
  if (!signals.length) return null;
  return (
    <details className="tl-summary pe-session">
      <summary><span>Policy evidence</span><span>{signals.length} recorded</span></summary>
      <ul className="pe-session-list">
        {signals.map((s) => {
          const k = KIND[s.kind] ?? { glyph: '·', word: s.kind, tone: 'quiet' as Tone };
          return (
            <li key={s.id}>
              <Mark glyph={k.glyph} word={k.word} tone={k.tone} />
              <span className="pe-session-text">{s.summary}</span>
              <span className="faint pe-fine">{ago(s.at)} · {s.rule}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
