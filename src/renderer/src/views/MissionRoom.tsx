import { PromptField } from '../prompt-actions/PromptField';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CompanionSnapshot, CompanionSource, CompanionTurn } from '@shared/companion';
import type { Attention, Project, Session } from '@shared/types';
import type { OrbStory } from '@shared/orb-story';
import type { CompanionPresenceState, PresenceRead } from '@shared/companion-presence';
import Orb from '../components/Orb';
import SetupChecklist from '../components/SetupChecklist';
import HomeWork from '../components/HomeWork';
import { useViewMemory } from '../components/viewMemory';
import { TEMPERAMENTS, readTemperament, type Temperament } from '../orb/expression';
import type { OrbPlay } from '../orb/runtime';
import { usePresenceReactions } from '../orb/presence';
import { Icon, Note, PageHead, SectionHead, Segmented, ago } from '../components/bits';
import '../styles/mission.css';
import '../styles/home.css';

const numerals = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const count = (n: number) => numerals[n] ?? String(n);

export default function MissionRoom({ story, followedSession, sessions=[], attention, attentionRead, projects, projectsRead, onFleet, onFollow, projectId, presence, onOpenSession, onProject, onAddProject, onNewSession, onSettings, onUsage, demo = false }: {
  demo?: boolean;story?:OrbStory;followedSession?:string|null;sessions?:Session[];onFollow?:(id:string|null)=>void;
  presence:CompanionPresenceState;
  attention: Attention[]; attentionRead: PresenceRead; projects: Project[]; projectsRead: boolean; onFleet: () => void;
  projectId: string | null; onOpenSession: (id: string) => void; onProject: (id: string) => void;
  onAddProject: () => void; onNewSession: () => void; onSettings: () => void; onUsage: () => void;
}) {
  // Home opens on the companion, which is what this surface is for: the orb
  // and a conversation about your recorded workspace. It spent a while opening
  // on a work summary instead, with the orb shrunk to a badge behind a button —
  // and the summary largely repeats what Fleet and the project picker already
  // say, so the page led with its least distinctive half and hid the reason it
  // exists. "Back to work" still reaches the summary, and the choice is
  // remembered either way.
  //
  // The key is versioned rather than the default simply flipped: useViewMemory
  // prefers a stored value over its initial one, so every operator who had ever
  // closed the companion would have kept a `false` that predates this decision
  // and would never have seen the change. A new key hands everyone the new
  // default exactly once and then remembers what they choose next.
  const [companionOpen, setCompanionOpen] = useViewMemory('companion-open-v2', true);
  const [snapshot, setSnapshot] = useState<CompanionSnapshot | null>(null);
  const [turns, setTurns] = useState<CompanionTurn[]>([]);
  const [question, setQuestion] = useState('');
  const [model, setModel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [focused,setFocused]=useState(false);
  const [inputEvent,setInputEvent]=useState(0);
  const [answerEvent,setAnswerEvent]=useState(0);
  const {attentionEvent,completionEvent,failureEvent}=usePresenceReactions(presence);
  const [floating,setFloating]=useState(false);
  const [requestReply,setRequestReply]=useState<OrbStory['reply']>();
  const [spinEvent,setSpinEvent]=useState(0);
  const [playEvent,setPlayEvent]=useState<{kind:OrbPlay;id:number}>({kind:'splash',id:0});
  const [temperament,setTemperament]=useState(readTemperament);
  const [playFeedback, setPlayFeedback] = useState('');
  const material = TEMPERAMENTS.find(item => item.value === temperament)!;
  const chooseTemperament=(value:Temperament)=>{
    if(value!=='water')setFloating(false);setTemperament(value);try{localStorage.setItem('wanigan.orb.temperament',value);}catch{/* Keep this window’s choice when local storage is unavailable. */}
  };
  const scopeRef = useRef(projectId); scopeRef.current = projectId;
  const input = useRef<HTMLTextAreaElement>(null);
  const appearance=useRef<HTMLDivElement>(null),appearanceButton=useRef<HTMLButtonElement>(null);
  const finishPlay = (message: string) => {
    setPlayFeedback(message);
    appearance.current?.hidePopover();
    document.querySelector<HTMLButtonElement>('.mission-presence .wanigan-orb')?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!playFeedback) return;
    const timer = window.setTimeout(() => setPlayFeedback(''), 4500);
    return () => window.clearTimeout(timer);
  }, [playFeedback]);
  useEffect(() => {
    let alive = true; let loading = false;
    setSnapshot(null); setTurns([]); setError(null); setReadError(null); setSending(false); setQuestion('');setRequestReply(undefined);
    const refresh = async () => {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const [facts, history] = await Promise.all([window.wanigan.companion.snapshot(projectId), window.wanigan.companion.history(projectId)]);
        if (alive) {
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
    const requestId=crypto.randomUUID();setRequestReply({id:requestId,status:'pending'});
    try {
      const turn = await window.wanigan.companion.ask({ question: text, projectId, model });
      if (scopeRef.current === requestedScope) {
        setRequestReply({id:turn.id,status:turn.status});
        setTurns((rows) => [...rows.filter((r) => r.id !== turn.id), turn]);
        if(turn.status==='answered')setAnswerEvent(n=>n+1);
      }
    } catch (e) {
      if (scopeRef.current === requestedScope) { setRequestReply({id:requestId,status:'failed'});setError(e instanceof Error ? e.message : String(e)); setQuestion(text); }
    } finally { if (scopeRef.current === requestedScope) setSending(false); }
  }, [question, pending, snapshot?.available, projectId, model]);
  const openSource = (source: CompanionSource) => source.kind === 'usage' ? onUsage()
    : source.kind === 'session' ? onOpenSession(source.targetId) : onProject(source.targetId);
  const title = !snapshot ? <>Your work,<br />coming into view.</>
    : snapshot.needsYou ? <>{count(snapshot.totalProjects)} {snapshot.totalProjects === 1 ? 'space' : 'spaces'}, together.<br />{count(snapshot.needsYou)} {snapshot.needsYou === 1 ? 'session needs' : 'sessions need'} you.</>
    : snapshot.running ? <>{count(snapshot.running)} {snapshot.running === 1 ? 'session' : 'sessions'} running.<br />Room to think.</>
    : <>A quiet moment.<br />What shall we make?</>;

  const setupKey = `${projectsRead}:${projects.map(project => project.id).join('|')}:${sessions.length}`;
  return <main className="pane mission-room home-room">
    <div className="home-intro">
      {!companionOpen && <Orb compact signal={presence.signal} story={story} temperament={temperament}
        label="Talk to Wanigan" onActivate={() => setCompanionOpen(true)} />}
      <PageHead title={companionOpen ? 'With Wanigan' : 'Home'} lead={companionOpen
        ? 'An optional conversation about your recorded workspace.'
        : projectId ? projects.find(project => project.id === projectId)?.name ?? 'Project unavailable' : 'Your work, across projects.'}
        actions={<><button className="btn" aria-expanded={companionOpen} aria-controls="home-companion" onClick={() => setCompanionOpen(!companionOpen)}>
          {companionOpen ? 'Back to work' : 'Talk to Wanigan'}</button>
          <button className="btn btn-primary" onClick={onNewSession}><Icon name="plus" />New session</button></>} />
    </div>
    {!companionOpen && <>
      <SetupChecklist refreshKey={setupKey} onAddProject={onAddProject} onNewSession={onNewSession} />
      <HomeWork sessions={sessions} attention={attention} read={attentionRead} projects={projects}
        projectId={projectId} onOpenSession={onOpenSession} onProject={onProject} onNewSession={onNewSession} onFleet={onFleet} />
      <button className="btn home-add-project" onClick={onAddProject}><Icon name="plus" />Add project</button>
    </>}
    {companionOpen && <div id="home-companion">
    <section className="mission-stage" aria-label="Wanigan companion">
      <div className="mission-presence" onKeyDown={event=>{
        if(event.key==='Escape'&&appearance.current?.matches(':popover-open')){
          event.preventDefault();event.stopPropagation();appearance.current.hidePopover();appearanceButton.current?.focus();
        }
      }}>
        <Orb descriptionId="mission-orb-invitation" inputEvent={inputEvent} story={{...story,failureEvent,failed:!!presence.errorEvents?.length,conversationScope:projectId??'all',reply:requestReply??latest}} floating={floating} onFloat={()=>{chooseTemperament('water');setFloating(value=>!value);}} signal={presence.signal} thinking={pending} focused={focused} answerEvent={answerEvent} completionEvent={completionEvent} attentionEvent={attentionEvent} spinEvent={spinEvent} playEvent={playEvent} temperament={temperament} />
        <button ref={appearanceButton} className="mission-orb-caption" type="button" popoverTarget="wanigan-personality" aria-label="Wanigan appearance and play"
          onClick={event => event.currentTarget.closest('.mission-presence')?.scrollIntoView({ block: 'nearest', behavior: 'instant' })}>
          {pending ? 'Let me take a look' : requestReply?.status==='failed'||latest?.status==='failed' ? 'That request needs a look' : focused ? 'You have my attention' : floating ? 'A little less gravity' : 'Wanigan'}<span className="mission-play-label">Play <Icon name="sliders" /></span>
        </button>
        <p className="mission-orb-invitation" id="mission-orb-invitation">Drag to stir. Double-click to spin.<br /><span>{material.label} · <kbd>S</kbd> spins when he has focus</span></p>
        <span className="mission-play-response" role="status">{playFeedback}</span>
        <div ref={appearance} className="mission-temperament" id="wanigan-personality" popover="auto" aria-label="Wanigan appearance and play">
          <SectionHead label="A little room to play" right={<button className="btn" aria-label="Close play controls" onClick={() => { appearance.current?.hidePopover(); appearanceButton.current?.focus(); }}><Icon name="x" /></button>} />
          <p className="mission-play-hint">Choose what’s inside. Then give him a nudge.</p>
          <Segmented label="Wanigan’s temperament" value={temperament}
          options={TEMPERAMENTS.map(({value,label})=>({value,label}))}
          onChange={value => { chooseTemperament(value); setPlayFeedback(''); }} />
          <p className="mission-material-hint">{material.hint}</p>
          <details className="mission-follow-controls"><summary>Follow a session’s context</summary><label className="mission-follow">Follow context
            <select className="field" aria-label="Session whose context Wanigan follows" value={followedSession??''} onChange={event=>onFollow?.(event.target.value||null)}>
              <option value="">Choose a session</option>
              {sessions.map(session=><option key={session.id} value={session.id}>{session.displayTitle||session.id}</option>)}
            </select>
          </label>
          <p className="mission-play-hint">{story?.context?`${story.context.label} · ${story.context.note}`:'Choose a session to see its context in the globe.'}{story?.compaction?.phase==='gathering'?' · Compacting context':''}</p></details>
          <div className="mission-play" aria-label="Play with Wanigan">
            <button type="button" aria-pressed={floating} onClick={()=>{chooseTemperament('water');setFloating(value=>!value);finishPlay(floating ? 'Gravity is back.' : 'Water, with a little less gravity.');}}>{floating?'Bring gravity back':'Let the water float'}<span aria-hidden="true">◯</span></button>
            <button type="button" onClick={()=>{setSpinEvent(n=>n+1);finishPlay('A spin, just for you.');}} aria-label="Spin Wanigan">Give him a spin <span aria-hidden="true">↻</span></button>
            {([{kind:'splash',label:'Make a splash',glyph:'≈'},{kind:'burst',label:'Bubble burst',glyph:'◌'},
              {kind:'rain',label:'Little rainstorm',glyph:'☂'},{kind:'bloom',label:'Drop some ink',glyph:'◉'},{kind:'shake',label:'Shake the globe',glyph:'↝'}] as const).map(action=><button key={action.kind} type="button"
                onClick={()=>{if(action.kind==='bloom')chooseTemperament('ink');else if(action.kind==='rain'||action.kind==='burst'||action.kind==='splash')chooseTemperament('water');setPlayEvent(previous=>({kind:action.kind,id:previous.id+1}));finishPlay(action.label);}}>
                {action.label}<span aria-hidden="true">{action.glyph}</span>
              </button>)}
          </div>
          <details className="mission-play-keys"><summary>Keyboard play</summary><p>Focus the globe, then use ← → to splash, S to spin, B for bubbles, R for rain, or G to float the water. Motion follows your Appearance setting.</p></details>
        </div>
      </div>
      <div className="mission-briefing">
        <span className="mission-scope">{projectId ? snapshot?.projects[0]?.name ?? 'Project space' : 'Across your spaces'}</span>
        <PageHead title={title} />
        <div className="mission-summary"><p>Ask about your agents or the recorded overview of your projects.</p></div>
        <form className="mission-composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <PromptField scopeKey={`companion:${projectId ?? 'all'}`} purpose="companion question" actionsDisabled={pending} ref={input} aria-label="Talk to Wanigan" readOnly={demo} placeholder={demo ? "Companion answers are off in this demo" : "Talk to Wanigan…"} value={question} maxLength={4_000} rows={1}
            onFocus={()=>setFocused(true)} onBlur={()=>setFocused(false)}
            onValueChange={question => {setQuestion(question);setInputEvent(value=>value+1);}}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void ask(); } }} />
          {pending ? <button type="button" aria-label="Stop this answer" onClick={() => void window.wanigan.companion.cancel().catch((e) => setError(String(e)))}><Icon name="x" /></button>
            : <button type="submit" aria-label="Send question to Wanigan" disabled={!question.trim() || !snapshot?.available}><span aria-hidden="true">↑</span></button>}
        </form>
        <div className="mission-connection">
          {demo ? <span>Fictional workspace · No model connected</span> : snapshot?.available ? <label>Claude API <select aria-label="Companion model" value={model} onChange={(event) => setModel(event.target.value)} disabled={pending}>
            {snapshot.models.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select></label> : <button type="button" onClick={onSettings}>Connect the companion <Icon name="external" /></button>}
          {!demo && <details><summary>What I can see</summary><p>Project names and branches, session providers, recorded status, account limits and the last 14 days of recorded tokens and costs from Usage. Usage covers all accounts and projects; read times and missing values stay explicit. Questions and these summaries go to the selected Claude API model when you send. Account emails, credentials, agent conversations, terminal output and files stay out of this overview. API usage is billed separately from CLI subscriptions.</p></details>}
        </div>
        {!demo && !latest && <div className="mission-prompts">
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
    <div className="mission-observed">{snapshot && <>{demo ? 'Fictional sample workspace' : <>From local records · Updated {ago(snapshot.readAt)}</>}{snapshot.sessionsTruncated && ' · Recent sessions shown'}</>}</div>
    </div>}
  </main>;
}
