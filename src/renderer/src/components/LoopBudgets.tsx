import { useEffect, useState } from 'react';
import type { DocketDetail } from '@shared/types';
import { DEFAULT_MAX_ROUNDS } from '@shared/goal-budgets';
import { Hint, Mark, Note, SectionHead, num } from './bits';
import '../styles/depth.css';

/**
 * A goal's loop budgets, beside its spend cap: how many implementation rounds
 * it may run, and how many changed lines its implementation worktree may reach,
 * before the next dispatch is held for a person with a named reason.
 *
 * Both are off until the operator turns one on. The rounds limit offers 3 when
 * it is switched on, which is the number Gemini CLI's PR generator uses; the
 * line limit has no default, because a sensible size depends on the repository.
 * The measured numbers are shown as they stand, so the limit is set against
 * what the goal has actually done rather than a guess.
 */

type Measure = { implementRounds: number; changedLines: number | null; binaryFiles: number; worktree: string | null };

export default function LoopBudgets({ docket, disabled, onChanged }: {
  docket: DocketDetail; disabled: boolean; onChanged: (next: DocketDetail) => void;
}) {
  const budgets = docket.loopBudgets ?? { maxRounds: null, maxChangedLines: null };
  const [rounds, setRounds] = useState(budgets.maxRounds === null ? '' : String(budgets.maxRounds));
  const [lines, setLines] = useState(budgets.maxChangedLines === null ? '' : String(budgets.maxChangedLines));
  const [measure, setMeasure] = useState<Measure | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    setRounds(budgets.maxRounds === null ? '' : String(budgets.maxRounds));
    setLines(budgets.maxChangedLines === null ? '' : String(budgets.maxChangedLines));
  }, [docket.id, budgets.maxRounds, budgets.maxChangedLines]);

  useEffect(() => {
    let live = true;
    window.wanigan.depth.goals.measure(docket.id)
      .then((m) => { if (live) setMeasure(m); })
      .catch(() => { if (live) setMeasure(null); });
    return () => { live = false; };
  }, [docket.id, docket.updatedAt]);

  const held = docket.nodes.filter((node) => node.hold);

  const save = (next: { maxRounds: number | null; maxChangedLines: number | null }, said: string) => {
    setError(null); setSaved(null);
    window.wanigan.depth.goals.setLoopBudgets(docket.id, next)
      .then((detail) => { onChanged(detail); setSaved(said); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  const parse = (text: string): number | null => (text.trim() === '' ? null : Number(text.trim()));

  return (
    <div className="dp-loop">
      <SectionHead label="Loop budgets" right={held.length
        ? <Mark glyph="⏸" word={`${held.length} held for a person`} tone="warn" />
        : <Mark glyph="·" word={budgets.maxRounds === null && budgets.maxChangedLines === null ? 'no limits' : 'within limits'} tone="quiet" />} />
      <p className="dp-fine">
        When a limit is reached the next dispatch is held with a reason instead of started, and autopilot stops and records why.
        Nothing is retried on its own.
      </p>
      {held.map((node) => (
        <Note key={node.id} tone="warn" role="none">
          <strong>{node.title}</strong> · <span className="mono">{node.hold!.reason}</span> — {node.hold!.detail}
        </Note>
      ))}
      <dl className="dp-loop-facts">
        <dt>Implementation rounds</dt>
        <dd><strong>{measure ? num(measure.implementRounds) : '—'}</strong>{budgets.maxRounds !== null && <span className="faint"> of {num(budgets.maxRounds)} allowed</span>}</dd>
        <dt>Changed lines</dt>
        <dd>
          <strong>{measure?.changedLines != null ? num(measure.changedLines) : '—'}</strong>
          {budgets.maxChangedLines !== null && <span className="faint"> of {num(budgets.maxChangedLines)} allowed</span>}
          <span className="faint dp-fine">{measure?.changedLines == null
            ? ' not measured: no implementation worktree on disk, or no base commit recorded'
            : ` numstat against ${docket.baseCommit?.slice(0, 8) ?? 'the base'}, plus untracked files${measure.binaryFiles ? `; ${measure.binaryFiles} binary not counted` : ''}`}</span>
        </dd>
      </dl>
      <div className="dp-loop-form">
        <label><span className="label">Rounds limit</span>
          <input className="field" inputMode="numeric" value={rounds} placeholder="no limit" disabled={disabled}
                 onChange={(e) => setRounds(e.target.value)} /></label>
        <label><span className="label">Changed-lines limit</span>
          <input className="field" inputMode="numeric" value={lines} placeholder="no limit" disabled={disabled}
                 onChange={(e) => setLines(e.target.value)} /></label>
        <button type="button" className="btn" disabled={disabled}
                onClick={() => save({ maxRounds: parse(rounds), maxChangedLines: parse(lines) }, 'Loop budgets saved. Any hold was cleared and the next dispatch decides again.')}>
          Save limits
        </button>
        {budgets.maxRounds === null && (
          <button type="button" className="btn btn-sm" disabled={disabled}
                  onClick={() => { setRounds(String(DEFAULT_MAX_ROUNDS)); save({ maxRounds: DEFAULT_MAX_ROUNDS, maxChangedLines: parse(lines) }, `Rounds limited to ${DEFAULT_MAX_ROUNDS}.`); }}>
            Limit to {DEFAULT_MAX_ROUNDS} rounds
          </button>
        )}
      </div>
      {error && <Note tone="error">{error}</Note>}
      {saved && <Hint>{saved}</Hint>}
    </div>
  );
}
