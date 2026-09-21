import { useState } from 'react';
import type { RelayRead } from '@shared/types';
import { Explainer, Hint } from '../components/bits';

export default function RelayAutomation({ read, busy, save }: {
  read: RelayRead; busy: boolean; save: (input: { budgetUsd: number } | null) => Promise<void>;
}) {
  const [budget, setBudget] = useState(read.docket.budgetUsd?.toString() ?? '');
  const value = Number(budget);
  const enabled = read.automaticProgress && read.docket.autopilot.enabled;
  return <Explainer id={`relay-automation-${read.docket.id}`} title="Automatic progress settings" defaultHidden>
    <div className="rl-automation-options">
    <label><span className="label">Agent spending limit (USD)</span><input className="field" type="number" min="0.01" max="100000" step="0.01"
      value={budget} disabled={busy} onChange={event => setBudget(event.target.value)} /></label>
    <div className="row">
      <button className="btn" disabled={busy || !Number.isFinite(value) || value <= 0 || value > 100000}
        onClick={() => void save({ budgetUsd: value })}>{enabled ? 'Update allowance' : 'Enable automatic progress'}</button>
      {enabled && <button className="btn" disabled={busy} onClick={() => void save(null)}>Pause automatic progress</button>}
    </div>
    <Hint>Advances accepted plans and work that passes the review gate. Verification runs without a model. Final review stays with you. Stops new paid stages when cost is unreported or the allowance is reached; running turns may exceed it.</Hint>
    <Hint>Pausing stops future automatic actions. It does not interrupt a currently running agent or review command.</Hint>
    </div>
  </Explainer>;
}
