import { useEffect, useRef, useState, type ReactNode } from 'react';
import Orb from './Orb';
import { readTemperament } from '../orb/expression';
import { PageHead } from './bits';
import '../styles/planning.css';

export type PlanningStage = 'idea' | 'conversation' | 'plan' | 'saved';
const CUES: Record<PlanningStage, string> = {
  idea: 'A rough idea will do. We can sharpen it.',
  conversation: 'The interesting part is usually in the details.',
  plan: 'Let’s make “done” something we can actually prove.',
  saved: 'A plan with a point. I like it.',
};

/** A shared place to plan, with gestures driven by the operator and real results. */
export default function PlanningTable({ stage, project, busy, thinking, error, answered, onBack, backLabel, actions, children }: {
  stage: PlanningStage; project: string; busy: boolean; thinking: boolean; error: string | null; answered: number;
  onBack: () => void; backLabel: string; actions?: ReactNode; children: ReactNode;
}) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const [temperament] = useState(readTemperament);
  const [focused, setFocused] = useState(false);
  const [cue, setCue] = useState('');
  const [inputEvent, setInputEvent] = useState(0);
  const [acknowledgements, setAcknowledgements] = useState(0);
  const [spinEvent, setSpinEvent] = useState(0);
  const [completionEvent, setCompletionEvent] = useState(0);
  const [attentionEvent, setAttentionEvent] = useState(0);
  const previous = useRef({ stage, answered, error });
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (stage === 'saved' && previous.current.stage !== 'saved') {
      setCompletionEvent(value => value + 1); setSpinEvent(value => value + 1);
    }
    if (answered > previous.current.answered) setAcknowledgements(value => value + 1);
    if (error && error !== previous.current.error) setAttentionEvent(value => value + 1);
    if (stage !== previous.current.stage) { setFocused(false); setCue(''); setTarget(null); }
    previous.current = { stage, answered, error };
  }, [stage, answered, error]);
  useEffect(() => { root.current?.querySelector<HTMLElement>('[data-planning-initial]')?.focus(); }, [stage, answered]);
  const message = error ? 'A snag. Your draft is still here.' : thinking ? 'Turning that over…' : busy ? 'Keeping this together…' : cue || CUES[stage];
  return <div className="pane wide planning-table" ref={root} data-stage={stage}>
    <PageHead compact title="Plan with Wanigan" lead={project || 'Make room for an idea.'}
      actions={<><button type="button" className="btn" disabled={busy} onClick={onBack}>{backLabel}</button>{actions}</>} />
    <div className="planning-layout">
      <aside className="planning-companion" aria-label="Your planning companion">
        <div className="planning-orbit">
          <Orb focused={focused} thinking={thinking} gazeTarget={target} inputEvent={inputEvent} temperament={temperament}
            answerEvent={acknowledgements} completionEvent={completionEvent} attentionEvent={attentionEvent} spinEvent={spinEvent}
            label="Wanigan, your planning companion. Click to nudge; drag to stir; double-click to spin."
            onActivate={() => { setCue('Yes, I’m still here. Very focused. Mostly.'); setFocused(false); setTarget(null); }} />
        </div>
        <p className="planning-voice">{message}</p>
        <p className="planning-play">Give him a nudge. He can take it.</p>
        <ol className="planning-journey" aria-label="Planning stages">
          {(['idea', 'conversation', 'plan', 'saved'] as const).map((value, index) => <li key={value} aria-current={stage === value ? 'step' : undefined}>
            <span aria-hidden="true">{index + 1}</span>{({idea:'The idea',conversation:'Think it through',plan:'Shape the plan',saved:'Ready to begin'})[value]}
          </li>)}
        </ol>
      </aside>
      <div className="planning-work" onFocusCapture={event => {
        const el = event.target as HTMLElement;
        setTarget(el); setFocused(true);
        setCue(el.closest<HTMLElement>('[data-planning-cue]')?.dataset.planningCue ?? 'Go on. I’m listening.');
      }} onBlurCapture={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        const el = event.target;
        if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && el.value.trim()) setAcknowledgements(value => value + 1);
      }} onChangeCapture={() => setInputEvent(value => value + 1)}>
        {children}
      </div>
    </div>
  </div>;
}
