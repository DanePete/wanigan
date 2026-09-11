import { useEffect, useRef, useState } from 'react';
import type { DocketRisk, Interview as InterviewRecord, InterviewProposal, Project } from '@shared/types';
import { EmptyState, Note, SectionHead, Segmented, usd } from '../components/bits';
import PlanningTable, { type PlanningStage } from '../components/PlanningTable';
import PlanEditor, { planProblems, planRowsFromDefault, toPlanNodes } from '../components/PlanEditor';
import type { PlanRow } from '../components/PlanEditor';
import { useViewMemory } from '../components/viewMemory';
import { usePlanningMemory } from '../components/planningMemory';

type Draft = {
  project: string; seed: string; title: string; objective: string; acceptance: string;
  risk: DocketRisk; budget: string; plan: PlanRow[]; mode: 'together' | 'manual';
  interviewId: string | null; savedId: string | null;
};
const initialDraft = (project: string): Draft => ({ project, seed:'', title:'', objective:'', acceptance:'', risk:'elevated', budget:'', plan:planRowsFromDefault(), mode:'together', interviewId:null, savedId:null });
const rowsFrom = (proposal: InterviewProposal): PlanRow[] => proposal.plan.map(node => ({ ...node, dependsOn:[...(node.dependsOn ?? [])], claimPath:node.claimPath ?? '' }));
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** Both goal entry points use this workspace. Only explicit actions call the model. */
export default function Interview({ projects, projectId, onDone, onCancel, backLabel='Back to the board' }: {
  projects: Project[]; projectId: string | null; onDone:(id:string)=>void; onCancel:()=>void; backLabel?:string;
}) {
  const [draft, setDraft] = usePlanningMemory<Draft>('draft', initialDraft(projectId ?? projects[0]?.id ?? ''));
  const edit = (patch: Partial<Draft>) => setDraft(previous => ({...previous,...patch}));
  const [record, setRecord] = usePlanningMemory<InterviewRecord | null>('record', null);
  const [resumable, setResumable] = useState<InterviewRecord[]>([]);
  const [picked, setPicked] = usePlanningMemory<Project[]>('picked', []);
  const projectOptions = [...projects, ...picked.filter(row => !projects.some(project => project.id === row.id))];
  const [models, setModels] = useState<{id:string;label:string;costPerQuestion:number}[]>([]);
  const [modelsReady, setModelsReady] = useState(false);
  const [model, setModel] = useViewMemory('planningModel', '');
  const [questions, setQuestions] = useViewMemory('planningLength', 10);
  const [answer, setAnswer] = usePlanningMemory('answer', '');
  const [busy, setBusy] = usePlanningMemory<string | null>('busy', null);
  const [error, setError] = usePlanningMemory<string | null>('error', null);
  const [resumeError, setResumeError] = useState<string | null>(null);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let cancelled = false;
    void window.wanigan.interview.models().then(rows => {
      if (cancelled) return;
      setModels(rows); setModelsReady(true);
      if (!rows.some(row => row.id === model)) setModel(rows[0]?.id ?? '');
    }).catch(() => { if (!cancelled) { setModelsReady(true); setModels([]); } });
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    void window.wanigan.interview.list(null, 20).then(rows => {
      if (!cancelled) setResumable(rows.filter(row => ['asking','proposed','failed'].includes(row.status)));
    }).catch(() => { if (!cancelled) setResumeError('Saved planning conversations could not be read.'); });
    if (draft.interviewId && !draft.savedId && !busy) {
      void window.wanigan.interview.get(draft.interviewId).then(row => {
        if (!cancelled) {
          setRecord(row);
          if (row.status === 'committed' && row.docketId) edit({savedId:row.docketId});
        }
      }).catch(cause => { if (!cancelled) setResumeError(errorText(cause)); });
    }
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (!draft.project && projectOptions[0]) edit({project:projectOptions[0].id});
  }, [projects, picked, draft.project]);

  // UI locks also cover keyboard shortcuts and the frame before React disables a button.
  const run = async (label:string, work:()=>Promise<void>) => {
    if (lock.current || busy !== null) return;
    lock.current = true; setBusy(label); setError(null);
    try { await work(); }
    catch (cause) {
      setError(errorText(cause));
      // An answer can be recorded before its model request fails. Re-read the
      // durable state instead of offering to submit that same answer again.
      if (record?.id) {
        try {
          const latest = await window.wanigan.interview.get(record.id);
          setRecord(latest);
          if (latest.status === 'committed' && latest.docketId) { edit({savedId:latest.docketId}); setError(null); }
        } catch { /* Keep the visible draft and original failure. */ }
      }
    } finally { lock.current = false; setBusy(null); }
  };
  const receive = (next:InterviewRecord) => {
    setRecord(next);
    if (alive.current) setResumeError(null);
    setAnswer('');
    edit({interviewId:next.id, project:next.projectId, seed:next.seed, mode:'together',
      ...(next.status === 'proposed' && next.proposal ? {
        title:next.proposal.title, objective:next.proposal.objective, acceptance:next.proposal.acceptance.join('\n'), risk:next.proposal.risk, plan:rowsFrom(next.proposal),
      } : {}),
      ...(next.status === 'committed' ? {savedId:next.docketId} : {}),
    });
  };
  const open = record?.status === 'asking' ? record.turns.at(-1) : null;
  const answered = record?.turns.filter(turn => turn.answer !== null).length ?? 0;
  const stage:PlanningStage = draft.savedId ? 'saved' : draft.mode === 'manual' || record?.status === 'proposed' ? 'plan' : draft.interviewId ? 'conversation' : 'idea';
  const checks = draft.acceptance.split('\n').map(line => line.trim()).filter(Boolean);
  const planFaults = planProblems(draft.plan);
  const budgetInvalid = draft.budget.trim() !== '' && (!Number.isFinite(Number(draft.budget)) || Number(draft.budget) < 0 || Number(draft.budget) > 100_000);
  const missing = [!projectOptions.some(row => row.id === draft.project) && 'a project', !draft.title.trim() && 'a title', !draft.objective.trim() && 'an objective', !checks.length && 'an acceptance check'].filter(Boolean);
  const problems = [...missing, ...(budgetInvalid ? ['a budget between 0 and 100,000 USD'] : []), ...(planFaults.length ? [`${planFaults.length} task graph correction${planFaults.length === 1 ? '' : 's'}`] : [])];
  const chosenModel = models.find(row => row.id === model);
  const toManual = () => {
    edit({mode:'manual', objective:draft.objective || record?.seed || draft.seed});
    setError(null);
  };
  const addProject = () => run('project', async () => {
    const project = await window.wanigan.projects.pick();
    if (project) { setPicked(rows => [...rows.filter(row => row.id !== project.id), project]); edit({project:project.id}); }
  });
  const submitAnswer = () => {
    if (!record || !open || open.answer !== null || !answer.trim() || lock.current) return;
    const value = answer.trim();
    void run('answer', async () => receive(await window.wanigan.interview.answer(record.id, value)));
  };
  const create = () => run('create', async () => {
    if (problems.length) return;
    const proposal = {title:draft.title.trim(), objective:draft.objective.trim(), acceptance:checks, risk:draft.risk,
      plan:toPlanNodes(draft.plan), budgetUsd:draft.budget.trim() ? Number(draft.budget) : null};
    const goal = draft.mode === 'together' && record?.status === 'proposed'
      ? await window.wanigan.interview.commit(record.id, proposal)
      : await window.wanigan.control.create({projectId:draft.project, ...proposal});
    // Keep the success receipt on screen; celebrate only a confirmed write.
    edit({savedId:goal.id, title:goal.title, acceptance:goal.acceptance.join('\n')});
  });
  const finish = () => {
    const id = draft.savedId;
    setDraft(initialDraft(draft.project)); setAnswer(''); setRecord(null); setError(null);
    if (id) onDone(id);
  };
  const history = record && record.turns.length > 0 && <details className="planning-history">
    <summary>Our conversation · {answered} answer{answered === 1 ? '' : 's'}</summary>
    <ol>{record.turns.map((turn,index) => <li key={`${turn.at}:${index}`}><strong>{turn.question}</strong><p>{turn.answer ?? 'Not answered yet.'}</p></li>)}</ol>
  </details>;
  const projectPicker = <label data-planning-cue="A good plan needs a place to land.">Project<select className="field" aria-label="Goal project" value={draft.project} disabled={!!record && draft.mode === 'together'} onChange={event => edit({project:event.target.value})}>
    {!projectOptions.some(row => row.id === draft.project) && <option value={draft.project}>{draft.project ? 'Project unavailable' : 'Choose a project'}</option>}
    {projectOptions.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
  </select></label>;

  return <PlanningTable stage={stage} project={projectOptions.find(row => row.id === draft.project)?.name ?? ''}
    busy={busy !== null} thinking={['start','answer','conclude'].includes(busy ?? '')} error={error} answered={answered}
    onBack={draft.savedId ? finish : onCancel} backLabel={backLabel}>
    {error && <Note tone="error">{error}</Note>}
    {resumeError && <Note tone="warn">{resumeError}</Note>}
    {record?.detail && <Note tone="warn">{record.detail}</Note>}
    {record && !draft.savedId && <p className="planning-fine">{models.find(row => row.id === record.model)?.label ?? record.model} · {usd(record.spendUsd)} recorded planning spend · {record.turns.length} question{record.turns.length === 1 ? '' : 's'} asked</p>}

    {stage === 'idea' && <fieldset className="planning-fields" disabled={busy !== null}>
      <h2>What are we making happen?</h2>
      <label data-planning-cue="Keep going. The rough edges are useful.">Your idea<textarea className="field planning-seed" aria-label="Your goal idea" data-planning-initial value={draft.seed} maxLength={4000}
        onChange={event => edit({seed:event.target.value})} placeholder="Something to build, a problem to untangle, an idea that won’t leave you alone…" /></label>
      {projectPicker}
      {!projectOptions.length && <button className="btn" type="button" disabled={busy !== null} onClick={() => void addProject()}>Add your first project</button>}
      <details className="planning-settings"><summary>Planning preferences{chosenModel ? ` · ${chosenModel.label}` : ''}</summary>
        <div className="planning-fields">
          <label>Planning model<select className="field" aria-label="Planning model" value={model} disabled={!models.length} onChange={event => setModel(event.target.value)}>
            {!models.length && <option value="">{modelsReady ? 'No planning models available' : 'Reading models…'}</option>}
            {models.map(row => <option key={row.id} value={row.id}>{row.label}</option>)}
          </select></label>
          <SectionHead label="How far shall we explore?" />
          <Segmented label="Planning depth" value={String(questions)} onChange={value => setQuestions(Number(value))}
            options={[{value:'5',label:'Quick · 5 questions'},{value:'10',label:'Standard · 10'},{value:'16',label:'Thorough · 16'}]} />
        </div>
      </details>
      <p className="planning-fine">{chosenModel ? `Estimated planning cost ${usd(chosenModel.costPerQuestion * questions)} for up to ${questions} questions. ` : ''}Planning uses your Claude API key. Actual reported spend appears as we go.</p>
      <div className="planning-actions"><button className="btn btn-primary" type="button" disabled={busy !== null || !chosenModel || !projectOptions.some(row => row.id === draft.project) || draft.seed.trim().length < 8}
        onClick={() => void run('start', async () => receive(await window.wanigan.interview.start({projectId:draft.project, seed:draft.seed.trim(), model, maxQuestions:questions})))}>{busy === 'start' ? 'Thinking it through…' : 'Plan together'}</button>
        <button className="btn" type="button" disabled={busy !== null} onClick={toManual}>I’ll write the plan</button></div>
      {resumable.length > 0 && <div className="planning-resume"><SectionHead label="Pick up an idea" />{resumable.map(row => <button key={row.id} type="button" disabled={busy !== null} onClick={() => void run('resume', async () => receive(await window.wanigan.interview.get(row.id)))}>
        <span>{row.seed}</span><small>{row.turns.filter(turn => turn.answer !== null).length} answers · {usd(row.spendUsd)} recorded · {row.status === 'proposed' ? 'plan ready to review' : row.status === 'failed' ? 'needs attention' : 'in progress'}</small>
      </button>)}</div>}
    </fieldset>}

    {stage === 'conversation' && <>
      {!record && <EmptyState posture="could-not-read" title={resumeError ? 'Your conversation could not be opened.' : 'Opening your conversation…'} cue="Your saved answers stay with the planning record." action={resumeError ? <button className="btn" type="button" disabled={busy !== null} onClick={() => void run('resume', async () => receive(await window.wanigan.interview.get(draft.interviewId!)))}>Try again</button> : undefined} />}
      {open && open.answer === null && <>
        <h2>{open.question}</h2>
        {open.why && <p className="planning-fine">{open.why}</p>}
        <label data-planning-cue="I’m listening. Specific beats polished.">Your answer<textarea className="field planning-seed" aria-label="Your planning answer" data-planning-initial key={`${record?.id}:${open.at}:${record?.turns.length}`}
          value={answer} maxLength={4000} disabled={busy !== null} onChange={event => setAnswer(event.target.value)}
          onKeyDown={event => {if (!event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey) && event.key === 'Enter') {event.preventDefault(); submitAnswer();}}} /></label>
        <div className="planning-actions"><button className="btn btn-primary" type="button" disabled={busy !== null || !answer.trim()} onClick={submitAnswer}>{busy === 'answer' ? 'Thinking it through…' : 'Continue together'}</button><span className="planning-fine">⌘↵ to send</span></div>
      </>}
      {record?.status === 'asking' && <div className="planning-actions">
        <button className="btn" type="button" disabled={busy !== null} onClick={() => void run('conclude', async () => receive(await window.wanigan.interview.conclude(record.id)))}>Shape the plan from here</button>
        <button className="btn" type="button" disabled={busy !== null} onClick={toManual}>Continue without AI</button>
      </div>}
      {record?.status === 'failed' && <><h2>Let’s keep what we know.</h2><p className="planning-fine">The planning request stopped. Your answers are saved, and you can use them to finish the plan yourself.</p><button className="btn" type="button" disabled={busy !== null} onClick={toManual}>Continue with an editable plan</button></>}
      {history}
    </>}

    {stage === 'plan' && <>
      <h2>{draft.mode === 'manual' ? 'Make the idea a plan.' : 'Here’s what we’ve shaped.'}</h2>
      <p className="planning-fine">The outcome, the proof, and the work between them. Everything here is yours to edit.</p>
      {draft.mode === 'manual' && !record && <div className="planning-actions"><button className="btn btn-sm" type="button" disabled={busy !== null} onClick={() => edit({mode:'together',seed:draft.seed || draft.objective})}>Talk it through first</button></div>}
      <fieldset className="planning-fields" disabled={busy !== null}>
        {projectPicker}
        {!projectOptions.length && <button className="btn" type="button" onClick={() => void addProject()}>Add your first project</button>}
        <label data-planning-cue="Give it a name you’ll recognise tomorrow.">Title<input className="field" data-planning-initial maxLength={180} value={draft.title} onChange={event => edit({title:event.target.value})} placeholder="A checkout that never charges twice" /></label>
        <label data-planning-cue="What changes when this works?">Objective<textarea className="field" value={draft.objective} onChange={event => edit({objective:event.target.value})} placeholder="What should be different, and why?" /></label>
        <label data-planning-cue="This is the good part. How will we know?">Acceptance checks · one per line<textarea className="field" value={draft.acceptance} onChange={event => edit({acceptance:event.target.value})} placeholder={'Retrying a payment never creates a second charge.\nThe existing checkout tests still pass.'} /></label>
        <div className="planning-inline"><label data-planning-cue="What would be expensive to get wrong?">Risk<select className="field" value={draft.risk} onChange={event => edit({risk:event.target.value as DocketRisk})}>{['low','elevated','high'].map(risk => <option key={risk} value={risk}>{risk}</option>)}</select></label>
          <label data-planning-cue="Give the work a sensible boundary.">Goal budget · USD<input className="field" inputMode="decimal" value={draft.budget} onChange={event => edit({budget:event.target.value})} placeholder="Optional" /></label></div>
        <section className="planning-plan" data-planning-cue="One job at a time. With the right things waiting."><SectionHead label="The work ahead" count={draft.plan.length} /><PlanEditor rows={draft.plan} onChange={plan => edit({plan})} /></section>
      </fieldset>
      {history}
      {problems.length > 0 && <p className="planning-fine" id="planning-problems">Still needed: {problems.join(', ')}.</p>}
      <div className="planning-actions"><button className="btn btn-primary" type="button" aria-describedby={problems.length ? 'planning-problems' : undefined} disabled={busy !== null || problems.length > 0} onClick={() => void create()}>{busy === 'create' ? 'Saving your goal…' : 'Create goal'}</button></div>
      <p className="planning-fine">Creating the goal saves the plan. You choose when to start its tasks.</p>
    </>}

    {stage === 'saved' && <div className="planning-saved"><h2>Ready when you are.</h2><h3>{draft.title}</h3><p className="planning-fine">Your goal is saved with {draft.plan.length} tasks and {checks.length} acceptance checks.</p><p className="planning-fine">Next, open the goal to choose an agent for the first ready task.</p><div className="planning-actions"><button className="btn btn-primary" data-planning-initial type="button" onClick={finish}>Open goal</button></div></div>}
  </PlanningTable>;
}
