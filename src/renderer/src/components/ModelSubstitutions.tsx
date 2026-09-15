import { useEffect, useState } from 'react';
import type { Substitution } from '@shared/model-substitution';
import { substitutionSentence } from '@shared/model-substitution';
import { Mark, ago, num, usd } from './bits';
import '../styles/runtime.css';

/**
 * "Requested opus, answered by claude-sonnet-5", where the session is shown.
 *
 * Renders nothing when the models agree — agreement is the normal case and a
 * line saying so on every card would be noise. When they do not, it says how
 * often, since when, which evidence it read, and how much of the reported cost
 * the substituting model answered: that is the cost attributed to it.
 */

const POLL_MS = 15_000;

const VIA_WORDS: Record<Substitution['via'][number], string> = {
  otel: 'telemetry',
  transcript: 'transcript',
  'codex-rollout': 'Codex rollout',
  'auto-switch': 'CLI fallback',
};

export default function ModelSubstitutions({ sessionId, compact }: { sessionId: string; compact?: boolean }) {
  const [rows, setRows] = useState<Substitution[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => window.wanigan.models.substitutions(sessionId)
      .then((r) => { if (live) setRows(r.substitutions); })
      .catch(() => { /* not available here, e.g. the demo workspace */ });
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [sessionId]);
  if (!rows.length) return null;
  return (
    <ul className={`model-subs${compact ? ' model-subs-compact' : ''}`} aria-label="Model substitutions">
      {rows.map((s) => (
        <li key={`${s.requested}→${s.reported}`} data-substitution={`${s.requested}→${s.reported}`}>
          <Mark glyph="⇄" word={substitutionSentence(s)} tone="warn" />
          <span className="model-subs-facts">
            {num(s.count)} answer{s.count === 1 ? '' : 's'} since {ago(s.firstAt)}
            {s.costUsd !== null ? ` · ${usd(s.costUsd)} reported, attributed to ${s.reported}` : ' · no cost reported for them'}
            {' · from '}{s.via.map((v) => VIA_WORDS[v]).join(', ')}
          </span>
        </li>
      ))}
    </ul>
  );
}
