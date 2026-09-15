import { useEffect, useState } from 'react';
import type { ProjectionBudgetView } from '@shared/cost-types';
import { Note } from './bits';
import '../styles/cost.css';

/**
 * The Codex budget verdict for one proposal, shown in the review inbox before
 * anyone presses Apply. Main compiles the candidate for the selected provider
 * without writing anything and measures the result against the AGENTS.md or
 * skills budget; the same check refuses the apply itself when the block would
 * land past the cut. Nothing renders for a non-Codex target or an ok verdict.
 */
export default function ProjectionBudgetNote({ candidateId, providerId }: { candidateId: string; providerId: string }) {
  const [verdict, setVerdict] = useState<ProjectionBudgetView | null>(null);
  useEffect(() => {
    let live = true;
    setVerdict(null);
    if (!providerId) return;
    void window.wanigan.cost.projectionBudget(candidateId, providerId)
      .then((value) => { if (live) setVerdict(value); })
      .catch(() => { /* the apply path still runs the check; the inbox note is advisory */ });
    return () => { live = false; };
  }, [candidateId, providerId]);
  if (!verdict || !verdict.applies || verdict.verdict === 'ok') return null;
  return (
    <div className="cost-budget-note">
      <Note tone={verdict.verdict === 'refuse' ? 'error' : 'warn'} role="none">
        <strong>{verdict.verdict === 'refuse' ? 'Apply will be refused: ' : 'Codex budget: '}</strong>{verdict.reason}
      </Note>
    </div>
  );
}
