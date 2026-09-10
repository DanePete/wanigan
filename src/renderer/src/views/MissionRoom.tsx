import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionSnapshot, CompanionSource, CompanionTurn } from '@shared/companion';
import Orb from '../components/Orb';
import type { Temperament } from '../orb/expression';
import { EmptyState, Icon, Note, PageHead, Pill, SectionHead, Segmented, ago } from '../components/bits';
import '../styles/mission.css';

const stateWord = { permission: 'Permission needed', error: 'Needs a look', finished: 'Turn finished',
  idle: 'Idle', working: 'Working', unknown: 'No attention signal' };
const numerals = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => numerals[n] ?? String(n);

export default function MissionRoom({ projectId, onOpenSession, onProject, onAddProject, onNewSession, onSettings }: {
  projectId: string | null; onOpenSession: (id: string) => void; onProject: (id: string) => void;
  onAddProject: () => void; onNewSession: () => void; onSettings: () => void;
}) {
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null);
  const [turns, setTurns] = useState<CompanionTurn[]>([]);
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [focused,setFocused]=useState(false);
  const [answerEvent,setAnswerEvent]=useState(0);
  const [attentionEvent,setAttentionEvent]=useState(0);
  const [spinEvent,setSpinEvent]=useState(0);
  const [temperament,setTemperament]=useState<Temperament>(()=>{
    try{return localStorage.getItem('wanigan.orb.temperament')==='ember'?'ember':'water';}catch{return 'water';}
  });
  const scopeRef = useRef(projectId); scopeRef.current = projectId;
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let alive = true; let loading = false;
    let previousAttention:Set<string>|null=null;
    setSnapshot(null); setTurns([]); setError(null); setReadError(null); setSending(false); setQuestion('');
    const refresh = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const [facts, history] = await Promise.all([window.wanigan.companion.snapshot(projectId), window.wanigan.companion.history(projectId)]);
        if (alive) {
          const attention=new Set(facts.projects.flatMap(p=>p.sessions.filter(s=>['permission','error','finished'].includes(s.state)).map(s=>`${s.id}:${s.state}`)));
          if(previousAttention&&[...attention].some(key=>!previousAttention!.has(key)))setAttentionEvent(n=>n+1);
          previousAttention=attention;
          setSnapshot(facts); setTurns(history); setModel((current) => current || facts.defaultModel); setReadError(null);
        }
      } catch (e) { if (alive) setReadError(e instanceof Error ? e.message : String(e)); }
      finally { loading = false; }
    };
    void refresh(); const timer = setInterval(refresh, 3_000);
    document.addEventListener('visibilitychange', refresh);
    return () => { alive = false; clearInterval(timer); document.removeEventListener('visibilitychange', refresh); };
  }, [projectId]);
  const pending = sending || turns.some((t) => t.status === 'pending');
  const latest = turns[turns.length - 1];
  const ask = useCallback(async () => {
    if (!question.trim() || pending || !snapshot?.available) return;
    const requestedScope = projectId; const text = question.trim();
    setSending(true); setError(null); setQuestion('');
    try {
      const turn = await window.wanigan.companion.ask({ question: text, projectId, model });
      if (scopeRef.current === requestedScope) {
        setTurns((rows) => [...rows.filter((r) => r.id !== turn.id), turn]);
        if(turn.status==='answered')setAnswerEvent(n=>n+1);
      }
    } catch (e) {
      if (scopeRef.current === requestedScope) { setError(e instanceof Error ? e.message : String(e)); setQuestion(text); }
    } finally { if (scopeRef.current === requestedScope) setSending(false); }
  }, [question, pending, snapshot?.available, projectId, model]);
  const openSource = (source: CompanionSource) => source.kind === 'session' ? onOpenSession(source.targetId) : onProject(source.targetId);
  const title = !snapshot ? <>Your work,<br />coming into view.</>
    : snapshot.needsYou ? <>{count(snapshot.totalProjects)} {snapshot.totalProjects === 1 ? 'space' : 'spaces'}, together.<br />{count(snapshot.needsYou)} {snapshot.needsYou === 1 ? 'session needs' : 'sessions need'} you.</>
    : snapshot.running ? <>{count(snapshot.running)} {snapshot.running === 1 ? 'session' : 'sessions'} running.<br />Room to think.</>
    : <>A little space.<br />For your next big thing.</>;
  const priority = snapshot?.projects.flatMap((p) => p.sessions.filter((s) => ['permission', 'error', 'finished'].includes(s.state)).map((s) => ({ project: p, session: s }))).slice(0, 2) ?? [];

  return <main className="pane mission-room">
    <section className="mission-stage" aria-label="Wanigan companion">
      <div className="mission-presence">
        <Orb thinking={pending} focused={focused} answerEvent={answerEvent} attentionEvent={attentionEvent} spinEvent={spinEvent} temperament={temperament} />
        <button className="mission-orb-caption" type="button" popoverTarget="wanigan-personality" aria-label="Wanigan appearance and play">
          {pending ? 'Thinking about your question' : 'Wanigan'}<Icon name="sliders" />
        </button>
        <div className="mission-temperament" id="wanigan-personality" popover="auto" aria-label="Wanigan appearance and play">
          <SectionHead label="Make him yours" />
          <Segmented label="Wanigan’s temperament" value={temperament}
          options={[{value:'water',label:'Water & mist'},{value:'ember',label:'Ember & flame'}]}
          onChange={value=>{setTemperament(value);try{localStorage.setItem('wanigan.orb.temperament',value);}catch{/* Keep this window’s choice when local storage is unavailable. */}}} />
          <button className="mission-spin" type="button" onClick={()=>setSpinEvent(n=>n+1)} aria-label="Spin Wanigan">Give him a spin <span aria-hidden="true">↻</span></button>
        </div>
      </div>
      <div className="mission-briefing">
        <span className="mission-scope">{projectId ? snapshot?.projects[0]?.name ?? 'Project space' : 'Across your spaces'}</span>
        <PageHead title={title} />
        <div className="mission-summary">
          {priority.length ? priority.map(({ project, session }) => <button key={session.id} type="button" onClick={() => onOpenSession(session.id)}>
            <span>{project.name}</span><span>{stateWord[session.state]}</span><Icon name="external" />
          </button>) : <p>{snapshot ? snapshot.totalProjects ? 'Ask about your agents, pick up a project, or make room for something new.' : 'Bring in a project. I’ll keep the moving pieces in view.' : 'Reading your local project and session records…'}</p>}
        </div>
        <form className="mission-composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <textarea ref={input} aria-label="Talk to Wanigan" placeholder="Talk to Wanigan…" value={question} maxLength={4_000} rows={1}
            onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
            onChange={(event) => setQuestion(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} />
          {pending ? <button type="button" aria-label="Stop this answer" onClick={() => void window.wanigan.companion.cancel().catch((e) => setError(String(e)))}><Icon name="x" /></button>
            : <button type="submit" aria-label="Send question to Wanigan" disabled={!question.trim() || !snapshot?.available}><span aria-hidden="true">↑</span></button>}
        </form>
        <div className="mission-connection">
          {snapshot?.available ? <label>Claude API <select aria-label="Companion model" value={model} onChange={(event) => setModel(event.target.value)} disabled={pending}>
            {snapshot.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label> : <button type="button" onClick={onSettings}>Connect the companion <Icon name="external" /></button>}
          <details><summary>What I can see</summary><p>Project names and branches, session providers, and recorded status. Questions go to the selected Claude API model when you send. Agent conversations, terminal output and files stay out of this overview. API usage is billed separately from CLI subscriptions.</p></details>
        </div>
        {!latest && <div className="mission-prompts">
          {['What needs me?', 'Which projects are active?'].map((prompt) => <button key={prompt} type="button" onClick={() => { setQuestion(prompt); input.current?.focus(); }}>{prompt}</button>)}
        </div>}
      </div>
    </section>
    {(error || readError) && <Note tone="error">{error ?? readError}</Note>}
    {latest && <section className="mission-conversation" aria-label="Conversation with Wanigan">
      <SectionHead label="With Wanigan" right={turns.length > 1 ? <button className="btn btn-sm" type="button" aria-expanded={historyOpen} onClick={() => setHistoryOpen((v) => !v)}>{historyOpen ? 'Latest answer' : 'Conversation history'}</button> : undefined} />
      {(historyOpen ? turns : [latest]).map((turn) => <article className="mission-turn" key={turn.id}>
        <p className="mission-question">{turn.question}</p>
        <div className="mission-answer" role={turn.id === latest.id ? 'status' : undefined}>
          {turn.status === 'pending' ? 'Reading the current overview…' : turn.answer ?? turn.error}
        </div>
        {!!turn.sources.length && <div className="mission-sources">{turn.sources.map((source) => <button className="btn btn-sm" type="button" key={source.id} onClick={() => openSource(source)}>{source.label}<Icon name="external" /></button>)}</div>}
        <small>{turn.model} · {ago(turn.at)}{turn.status !== 'pending' && (turn.costUsd === null ? ' · Cost not reported' : ` · $${turn.costUsd.toFixed(4)} from reported tokens`)}</small>
      </article>)}
    </section>}
    <section className="mission-projects" aria-label="Your project spaces">
      <SectionHead label="Your spaces" count={snapshot?.totalProjects} right={<button type="button" className="btn btn-sm" onClick={onAddProject}><Icon name="plus" />Add space</button>} />
      {snapshot?.projects.length === 0 ? <EmptyState posture="nothing-yet" title="Every project starts somewhere." cue="Choose a folder to bring your first repository into Wanigan." action={<button className="btn btn-primary" onClick={onAddProject}>Add a project</button>} /> :
        <div className="mission-shelf">{snapshot?.projects.map((project) => <article className="mission-space" key={project.id}>
          <div className="mission-space-title"><span className="mission-project-mark" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
            <button type="button" onClick={() => onProject(project.id)}>{project.name}</button>
            {project.needsYou > 0 && <Pill tone="warn" status={`${project.needsYou} ${project.needsYou === 1 ? 'needs' : 'need'} you`} />}
          </div>
          <p className="mission-branch"><Icon name="branch" />{project.branch ?? 'No branch recorded'}</p>
          <div className="mission-session-list">{project.sessions.slice(0, 3).map((session) => <button type="button" key={session.id} onClick={() => onOpenSession(session.id)}>
            <span className={`mission-state state-${session.state}`} aria-hidden="true">{session.state === 'permission' ? '?' : session.state === 'error' ? '!' : session.state === 'finished' ? '✓' : '·'}</span>
            <span>{session.provider}<small>{stateWord[session.state]}</small></span><Icon name="external" />
          </button>)}{project.sessions.length === 0 && <p className="mission-space-empty">A clear desk.<br />Start something here.</p>}</div>
          <button className="mission-open" type="button" onClick={() => onProject(project.id)}>Open space <Icon name="external" /></button>
        </article>)}</div>}
      {!snapshot && !error && <p className="dim">Loading your spaces…</p>}
      {snapshot && snapshot.running === 0 && snapshot.projects.length > 0 && <button className="mission-start" type="button" onClick={onNewSession}><Icon name="plus" />Start a session</button>}
    </section>
    <div className="mission-observed">{snapshot && <>From local records · Updated {ago(snapshot.readAt)}{snapshot.sessionsTruncated && ' · Recent sessions shown'}</>}</div>
  </main>;
}
