import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project } from '@shared/types';
import { Chip, ConfirmNote, EmptyState, Explainer, Note, PageHead, Pill, Reading, SectionHead, Segmented, ago, num, usd } from '../components/bits';
import { useLiveViewMemory } from '../components/planningMemory';
import { useViewMemory } from '../components/viewMemory';

/* What a schedule can be created as.
   'session' is deliberately absent. An unattended PTY that nobody is watching
   is more concurrency, not more review capacity, and the queue has never had a
   runner registered for that kind — every session schedule ever created sat in
   the queue blocked on "no runner registered" and fired nothing. Rows written
   by an older build are still in the database, so the stored shape below still
   admits the value rather than pretending those rows are not there. */
type Kind = 'headless' | 'batch';

type Schedule = {
  id: string; name: string; cron: string; kind: Kind | 'session'; payload: unknown;
  projectId: string | null; enabled: boolean; createdAt: number;
  nextAt: number | null; lastAt: number | null; lastStatus: string | null;
  lastDetail: string | null; runs: number; describe: string;
};

/* The columns the re-run picker reads. batch.runs() hands back the whole row,
   config_json included; a schedule stores the run id and nothing more, so the
   system prompt and the dataset stay in the runs table where they were. */
type RunOption = {
  id: string; name: string; kind: string; model: string; status: string;
  total_requests: number; est_cost_usd: number; cost_usd: number; created_at: number;
};

/* Presets people actually want, phrased as the job rather than the syntax.
   Deliberately off :00 and :30 — Claude Code's own scheduler adds jitter there,
   and a job pinned to the top of the hour is a job competing with every other.
   The labels name the minute each one really fires: this view's whole claim is
   that a schedule can be audited, and a label that rounds 03:03 to 03:00 is the
   first thing to check and the first thing to be wrong. */
const PRESETS: { label: string; cron: string }[] = [
  { label: 'every 15 min', cron: '*/15 * * * *' },
  { label: 'hourly at :07', cron: '7 * * * *' },
  { label: 'nightly 03:03', cron: '3 3 * * *' },
  { label: 'weekday mornings 09:07', cron: '7 9 * * 1-5' },
  { label: 'Monday 08:07', cron: '7 8 * * 1' },
];

/* What a recorded fire came to, and how honest each answer is.
   Everything except 'failed' used to render as either nothing at all (in the
   row) or a green tick (in the history), so a fire still sitting in the queue,
   and one nothing ever reported back on, both read as a success. They are the
   two states an operator most needs to tell apart from one. */
const OUTCOME: Record<string, { glyph: string; text: string; tone: string }> = {
  ok: { glyph: '✓', text: 'last fire ok', tone: 'var(--good)' },
  failed: { glyph: '✕', text: 'failed', tone: 'var(--bad)' },
  queued: { glyph: '◷', text: 'queued — nothing has picked it up yet', tone: 'var(--warning)' },
  dispatching: { glyph: '▸', text: 'dispatching', tone: 'var(--accent)' },
  running: { glyph: '▸', text: 'running', tone: 'var(--accent)' },
  skipped: { glyph: '·', text: 'skipped', tone: 'var(--text-dim)' },
  canceled: { glyph: '·', text: 'canceled', tone: 'var(--text-dim)' },
  unknown: { glyph: '?', text: 'no outcome was recorded', tone: 'var(--warning)' },
};
/* A status this build has never heard of is reported as itself, in the tone
   that claims the least. */
const outcome = (status: string) => OUTCOME[status] ?? { glyph: '·', text: status, tone: 'var(--text-dim)' };

const when = (t: number | null) => (t === null ? '—' : new Date(t).toLocaleString(undefined, {
  weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric',
}));

/* What one scheduled fire is capped at, per repository.

   The ceiling itself is SCHEDULED_BUDGET_USD in src/main/index.ts, handed to
   the CLI as --max-budget-usd. No IPC channel reports it, so this is a mirror
   and has to be changed with it. It is mirrored rather than left out because a
   fan-out has to be able to say what it will cost BEFORE it is saved, and a
   blast radius with no number is a warning nobody can size. It is a ceiling
   the run is held to, not an estimate of what a run will spend. */
const PER_REPO_BUDGET_USD = 2;

/**
 * What a batch schedule points at, read defensively.
 *
 * Batch schedules created before this form could describe one carry a bare
 * `{ prompt }` — a batch is a whole RunConfig, so those can never submit
 * anything. Returning null for them is what lets the list say so instead of
 * showing a healthy-looking row that fails at 03:00.
 */
function batchTarget(p: unknown): { runId: string; runName: string | null } | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as { runId?: unknown; runName?: unknown };
  if (typeof o.runId !== 'string' || !o.runId) return null;
  return { runId: o.runId, runName: typeof o.runName === 'string' ? o.runName : null };
}

/**
 * Whether a headless schedule says out loud that it means every repository.
 *
 * A schedule with no project pinned is expanded to the whole registered list at
 * fire time, and by then a run across every repository someone has ever added
 * is the same array as one they chose repository by repository. So the runner
 * carries an explicit `allProjects` through and refuses the fan-out without it.
 *
 * Rows written before that flag existed carry a bare `{ prompt }` and read
 * false here, which is what lets the list say they need attention instead of
 * leaving them to fail at 03:00 with nobody watching.
 */
function declaresAllProjects(p: unknown): boolean {
  return !!p && typeof p === 'object' && (p as { allProjects?: unknown }).allProjects === true;
}

/* Naming the repositories is the point of a blast radius, but a list of forty
   is a wall nobody reads and the count is what carries the size. */
const namesOf = (projects: Project[], cap = 6): string =>
  projects.length <= cap
    ? projects.map((p) => p.name).join(', ')
    : `${projects.slice(0, cap).map((p) => p.name).join(', ')} and ${projects.length - cap} more`;

type Draft = { name:string; cron:string; kind:Kind; projectId:string; prompt:string; allProjects:boolean; rerunId:string };
type Fire = { at:number; status:string; detail:string|null };
type Preview = { cron:string; fires:number[]; describe:string };
type Daemon = { supported:boolean; installed:boolean; detail:string };
const errorText = (cause:unknown) => cause instanceof Error ? cause.message : String(cause);
const promptOf = (row:Schedule) => row.payload && typeof row.payload === 'object' && 'prompt' in row.payload && typeof row.payload.prompt === 'string' ? row.payload.prompt : '';
const newDraft = (projectId:string):Draft => ({name:'',cron:'3 3 * * *',kind:'headless',projectId,prompt:'',allProjects:false,rerunId:''});
const fromSchedule = (row:Schedule):Draft => ({name:row.name,cron:row.cron,kind:row.kind==='batch'?'batch':'headless',projectId:row.projectId??'',prompt:promptOf(row),allProjects:declaresAllProjects(row.payload),rerunId:batchTarget(row.payload)?.runId??''});
const needsAttention = (row:Schedule) => row.kind==='session' || (row.kind==='batch'&&!batchTarget(row.payload)) || (row.kind==='headless'&&!row.projectId&&!declaresAllProjects(row.payload)) || ['failed','unknown'].includes(row.lastStatus??'');
const clockTime = (at:number|null) => at===null?'—':new Date(at).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
const calendarDay = (at:number|null) => at===null?'No date':new Date(at).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});

export default function Schedules({ projects }: { projects:Project[] }) {
  const [list,setList] = useLiveViewMemory<Schedule[]>('scheduleRows',[]);
  const [selected,setSelected] = useLiveViewMemory<string|null>('selectedSchedule',null);
  const [ready,setReady] = useState(false), [refreshing,setRefreshing] = useState(false);
  const [readError,setReadError] = useState<string|null>(null);
  const [actionError,setActionError] = useLiveViewMemory<string|null>('scheduleActionError',null);
  const [notice,setNotice] = useLiveViewMemory<string|null>('scheduleNotice',null);
  const [job,setJob] = useLiveViewMemory<string|null>('scheduleJob',null);
  const [query,setQuery] = useViewMemory('scheduleQuery','');
  const [filter,setFilter] = useViewMemory('scheduleFilter','all');
  const [editor,setEditor] = useLiveViewMemory<string|null>('scheduleEditor',null);
  const [drafts,setDrafts] = useLiveViewMemory<Record<string,Draft>>('scheduleDrafts',{});
  const [confirmDelete,setConfirmDelete] = useState<string|null>(null);
  const [cap,setCap] = useState<number|null>(null);
  const [daemon,setDaemon] = useLiveViewMemory<Daemon|null>('scheduleDaemon',null);
  const [daemonError,setDaemonError] = useState<string|null>(null);
  const [revision,setRevision] = useLiveViewMemory('scheduleRevision',0);
  const [runs,setRuns] = useState<RunOption[]>([]), [runsError,setRunsError] = useState<string|null>(null);
  const [hist,setHist] = useState<Record<string,Fire[]>>({});
  const [histError,setHistError] = useState<Record<string,string>>({});
  const [histBusy,setHistBusy] = useState<string|null>(null);
  const alive=useRef(true), readSequence=useRef(0), historySequence=useRef(0), lock=useRef(false);
  const newButton=useRef<HTMLButtonElement>(null), inspector=useRef<HTMLDivElement>(null);
  const selectedRef=useRef(selected);selectedRef.current=selected;
  const ordered=[...list].sort((a,b)=>Number(b.enabled)-Number(a.enabled)||(a.enabled?(a.nextAt??Infinity)-(b.nextAt??Infinity):0)||a.name.localeCompare(b.name)||a.id.localeCompare(b.id));
  const visible=ordered.filter(row=>(filter==='all'||filter==='enabled'&&row.enabled||filter==='paused'&&!row.enabled||filter==='attention'&&needsAttention(row))&&`${row.name} ${projects.find(project=>project.id===row.projectId)?.name??''} ${row.cron}`.toLowerCase().includes(query.trim().toLowerCase()));
  const current=list.find(row=>row.id===selected)??null;
  const draft=editor ? drafts[editor] : undefined;
  const enabled=list.filter(row=>row.enabled).length;
  const mutationDisabled=!!job||!ready||!!readError;
  const clearFilters=()=>{setQuery('');setFilter('all');};

  const load=useCallback(async()=>{
    const request=++readSequence.current;setRefreshing(true);
    try {
      const rows:Schedule[]=await window.wanigan.schedule.list();
      if(!alive.current||request!==readSequence.current)return;
      setList(rows);setReadError(null);setReady(true);
      if(!rows.some(row=>row.id===selectedRef.current)) {
        const first=[...rows].sort((a,b)=>Number(b.enabled)-Number(a.enabled)||(a.nextAt??Infinity)-(b.nextAt??Infinity))[0];
        setSelected(first?.id??null);setConfirmDelete(null);
      }
    }catch(cause){if(alive.current&&request===readSequence.current){setReadError(errorText(cause));setReady(true);}}
    finally{if(alive.current&&request===readSequence.current)setRefreshing(false);}
    try {const value=(await window.wanigan.settings.get()).spendCapUsd;if(alive.current&&request===readSequence.current)setCap(value);}
    catch {if(alive.current&&request===readSequence.current)setCap(null);}
  },[]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;readSequence.current++;historySequence.current++;};},[]);
  useEffect(() => {
    void load();
    const t = setInterval(() => { if (document.hidden) return; void load(); }, 15_000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVisible); };
  }, [load,revision]);
  const readDaemon=()=>window.wanigan.schedule.daemon().then(value=>{if(alive.current){setDaemon(value);setDaemonError(null);}}).catch(cause=>{if(alive.current)setDaemonError(errorText(cause));});
  useEffect(()=>{void readDaemon();},[]);
  useEffect(()=>{
    if(draft?.kind!=='batch')return;
    let live=true;
    void window.wanigan.batch.runs().then((rows:RunOption[])=>{if(live){setRuns(rows.filter(row=>row.kind==='batch'));setRunsError(null);}}).catch(cause=>{if(live)setRunsError(errorText(cause));});
    return()=>{live=false;};
  },[draft?.kind]);
  const history=useCallback(async(id:string)=>{
    const request=++historySequence.current;setHistBusy(id);setHistError(values=>({...values,[id]:''}));
    try {const rows=await window.wanigan.schedule.history(id,8);if(alive.current&&request===historySequence.current)setHist(values=>({...values,[id]:rows}));}
    catch(cause){if(alive.current&&request===historySequence.current)setHistError(values=>({...values,[id]:errorText(cause)}));}
    finally{if(alive.current&&request===historySequence.current)setHistBusy(null);}
  },[]);
  useEffect(()=>{if(selected)void history(selected);else historySequence.current++;},[selected,revision,history]);
  useEffect(()=>{setConfirmDelete(null);inspector.current?.scrollTo({top:0});},[selected,editor]);
  useEffect(()=>{if(editor)inspector.current?.querySelector<HTMLElement>('[data-schedule-initial]')?.focus();},[editor]);

  const mutate=async(label:string,work:()=>Promise<void>)=>{
    if(lock.current||job)return;
    lock.current=true;setJob(label);setActionError(null);setNotice(null);
    try {await work();setRevision(value=>value+1);}
    catch(cause){setActionError(errorText(cause));}
    finally{lock.current=false;setJob(null);}
  };
  const choose=(id:string)=>{setSelected(id);setEditor(null);setConfirmDelete(null);setActionError(null);setNotice(null);};
  const begin=(id:string)=>{
    if(job)return;
    const row=list.find(row=>row.id===id);
    if(id!=='new'&&!row)return;
    setDrafts(values=>values[id]?values:{...values,[id]:row?fromSchedule(row):newDraft(projects[0]?.id??'')});
    setEditor(id);setConfirmDelete(null);setActionError(null);setNotice(null);
  };
  const closeEditor=()=>{
    if(editor&&editor!=='new')setDrafts(values=>{const next={...values};delete next[editor];return next;});
    setEditor(null);setActionError(null);requestAnimationFrame(()=>newButton.current?.focus());
  };
  const save=async()=>{
    if(!editor||!draft||mutationDisabled)return;
    const id=editor,value=draft,target=runs.find(row=>row.id===value.rerunId);
    await mutate(id==='new'?'create':'save',async()=>{
      if(value.kind==='batch'&&!target)throw new Error('Choose a saved batch run before saving.');
      const payload=target&&value.kind==='batch'?{runId:target.id,runName:target.name}:{prompt:value.prompt.trim(),allProjects:!value.projectId&&value.allProjects};
      const input={name:value.name.trim(),cron:value.cron.trim(),payload,projectId:value.projectId||null};
      const saved:Schedule|null=id==='new'?await window.wanigan.schedule.create({...input,kind:value.kind}):await window.wanigan.schedule.update(id,input);
      if(!saved)throw new Error('This schedule no longer exists. Your draft is still here.');
      setList(rows=>[...rows.filter(row=>row.id!==saved.id),saved]);setSelected(saved.id);setEditor(null);clearFilters();
      setDrafts(values=>{const next={...values};delete next[id];return next;});
      setNotice(id==='new'?'Schedule created. Its next due time is shown below.':'Schedule updated.');
    });
  };
  const toggle=(row:Schedule)=>mutate(`toggle:${row.id}`,async()=>{
    const updated:Schedule|null=await window.wanigan.schedule.setEnabled(row.id,!row.enabled);
    if(!updated)throw new Error('This schedule no longer exists. Refresh schedules.');
    setList(rows=>rows.map(item=>item.id===updated.id?updated:item));
    setNotice(row.enabled?'Schedule paused. Work already started keeps running.':'Schedule resumed.');
  });
  const remove=(row:Schedule)=>mutate(`delete:${row.id}`,async()=>{
    const removed=await window.wanigan.schedule.remove(row.id);
    if(!removed)throw new Error('This schedule was already removed. Refresh schedules.');
    setList(rows=>rows.filter(item=>item.id!==row.id));setConfirmDelete(null);setNotice('Schedule and its history deleted. Work already started keeps running.');
  });
  const runDue=()=>mutate('tick',async()=>{
    const fired=await window.wanigan.schedule.tick();
    setNotice(fired===0?'No new occurrences queued. Nothing was due, the fleet is halted, or a scheduler check was already in progress.':`${fired} due occurrence${fired===1?' was':'s were'} queued. Check the recorded history for the outcome.`);
  });
  const toggleDaemon=()=>mutate('daemon',async()=>{
    if(!daemon) return;
    setDaemon(daemon.installed?await window.wanigan.schedule.uninstallDaemon():await window.wanigan.schedule.installDaemon());
  });
  return <div className="pane wide sc-wrap">
    <PageHead title="Schedules" lead={readError&&!list.length?'Schedule list unavailable':ready?`${enabled} enabled · ${list.length-enabled} paused · times are local to this Mac`:'Reading your schedules…'} actions={<>
      <button className="btn" type="button" disabled={refreshing} onClick={()=>void load()}>Refresh schedules</button>
      <button className="btn btn-primary" type="button" ref={newButton} disabled={mutationDisabled} onClick={()=>begin('new')}>New schedule</button>
    </>} />
    {readError&&<div className="sc-read-error"><Note tone="error">{readError}{list.length>0?' Showing the last readable records. Refresh before making changes.':''}</Note></div>}
    {!editor&&actionError&&<Note tone="error">{actionError}</Note>}
    {notice&&<Note>{notice}</Note>}
    <div className="sc-workspace">
      <aside className="sc-agenda" aria-label="Schedule agenda">
        <SectionHead label="Up next" count={list.length} />
        <input className="field" type="search" aria-label="Search schedules" value={query} placeholder="Find a schedule or project" onChange={event=>setQuery(event.target.value)} />
        <Segmented label="Schedule filter" value={filter} onChange={setFilter} options={[{value:'all',label:'All'},{value:'enabled',label:'Enabled'},{value:'paused',label:'Paused'},{value:'attention',label:'Attention'}]} />
        {(query||filter!=='all')&&<button className="btn btn-sm" type="button" onClick={clearFilters}>Clear filters</button>}
        {!ready?<Reading what="schedules" />:visible.length===0?<EmptyState posture={readError?'could-not-read':list.length?'nothing-in-scope':'nothing-yet'} title={readError?'Schedule list unavailable':list.length?'No matching schedules':'Nothing scheduled yet'} cue={list.length?'Try another name or clear the filters.':undefined} />:
          <div className="sc-agenda-list">{visible.map((row,index)=><div key={row.id}>
            {(index===0||row.enabled!==visible[index-1].enabled)&&<p className="sc-group">{row.enabled?'Upcoming':'Paused'}</p>}
            <button className="sc-entry" type="button" data-schedule-id={row.id} aria-pressed={selected===row.id&&!editor} onClick={()=>choose(row.id)}>
              <span className="sc-time"><strong>{row.enabled?clockTime(row.nextAt):'Ⅱ'}</strong><small>{row.enabled?calendarDay(row.nextAt):'Paused'}</small></span>
              <span className="sc-entry-copy"><strong>{row.name}</strong><span>{row.projectId?projects.find(project=>project.id===row.projectId)?.name??'Project unavailable':row.kind==='batch'?'Saved batch':declaresAllProjects(row.payload)?'Every repository':'Scope needs review'}</span>
                <span className="sc-entry-state">{needsAttention(row)?'Needs attention':row.lastStatus?outcome(row.lastStatus).text:'Not run yet'}</span></span>
            </button>
          </div>)}</div>}
      </aside>
      <div className="sc-inspector" ref={inspector}>
        {editor&&draft?<ScheduleEditor key={editor} draft={draft} setDraft={value=>setDrafts(values=>({...values,[editor]:value}))} projects={projects} runs={runs} runsError={runsError} cap={cap} existing={editor==='new'?null:list.find(row=>row.id===editor)??null} creating={editor==='new'} busy={!!job} disabled={mutationDisabled} error={actionError} onSave={()=>void save()} onCancel={closeEditor} />:
        current?<div className="sc-reading" key={current.id}>
          <div className="sc-identity"><Pill status={current.enabled?'Enabled':'Paused'} tone={current.enabled?'ok':'quiet'} /><span>{current.kind==='headless'?'Headless run':current.kind==='batch'?'Batch re-run':'Legacy terminal'}</span></div>
          <h2 data-schedule-id={current.id}>{current.name}</h2>
          <div className="sc-actions">
            <button className="btn btn-sm" type="button" disabled={mutationDisabled} onClick={()=>void toggle(current)}>{job===`toggle:${current.id}`?(current.enabled?'Pausing…':'Resuming…'):current.enabled?'Pause':'Resume'}</button>
            {current.kind!=='session'&&<button className="btn btn-sm" type="button" disabled={mutationDisabled} onClick={()=>begin(current.id)}>Edit</button>}
            <button className="btn btn-sm" type="button" disabled={histBusy===current.id} onClick={()=>void history(current.id)}>Refresh history</button>
            <button className="btn btn-danger btn-sm" type="button" disabled={mutationDisabled} aria-expanded={confirmDelete===current.id} onClick={()=>setConfirmDelete(confirmDelete===current.id?null:current.id)}>Delete…</button>
          </div>
          {confirmDelete===current.id&&<ConfirmNote tone="error" verb={job===`delete:${current.id}`?'Deleting…':'Delete schedule'} busy={!!job} onCancel={()=>setConfirmDelete(null)} onRun={()=>remove(current)} what={<>Delete <strong>{current.name}</strong> and its recorded history? This cannot be undone. Work already started keeps running.</>} />}
          <div className="sc-timing"><div><span>{current.enabled?'Next due':'Schedule paused'}</span><strong>{current.enabled?clockTime(current.nextAt):'On your time.'}</strong><p>{current.enabled?calendarDay(current.nextAt):'Resume when you want this work to recur.'}</p></div><div><span>Cadence</span><strong>{current.describe}</strong><code>{current.cron}</code></div></div>
          <SchedulePreview cron={current.cron} paused={!current.enabled} />
          <section className="sc-section"><SectionHead label="What runs" />
            {current.kind==='session'?<Note tone="warn">Session schedules are no longer supported. Recreate this as a headless run.</Note>:current.kind==='batch'?batchTarget(current.payload)?<p>Re-submits <strong>{batchTarget(current.payload)!.runName??batchTarget(current.payload)!.runId}</strong> using its saved configuration. File and command sources are read again when it fires.</p>:<Note tone="warn">Needs attention: this batch schedule names no saved run. Edit it and choose the run to re-submit.</Note>:<>
              <p className="sc-prompt">{promptOf(current)||'No prompt recorded.'}</p>
              <p className="sc-fine">{current.projectId?`Runs in ${projects.find(project=>project.id===current.projectId)?.name??'an unavailable project'}, with a ${usd(PER_REPO_BUDGET_USD)} per-run ceiling.`:declaresAllProjects(current.payload)?`Runs in every registered repository: ${namesOf(projects)||'none registered'}. ${projects.length} today, with a ${usd(PER_REPO_BUDGET_USD)} ceiling per repository (${usd(PER_REPO_BUDGET_USD*projects.length)} across the current list). New projects are included automatically.`:'No project is pinned and permission to run across every repository is not recorded.'}</p>
              {!current.projectId&&!declaresAllProjects(current.payload)&&<Note tone="warn">Needs attention: edit this schedule to pin a project or explicitly allow every registered repository.{projects.length===1?' This legacy schedule can run against the single project today; adding another causes its runs to be refused.':' Its runs are refused until its scope is resolved.'}</Note>}
            </>}
          </section>
          <section className="sc-section"><SectionHead label="Recorded history" count={current.runs} right={<span className="sc-fine">Latest 8 occurrences</span>} />
            {current.lastStatus&&<div className="sc-last"><Pill status={current.lastStatus} /><span>{outcome(current.lastStatus).text}</span>{current.lastAt&&<span>{ago(current.lastAt)}</span>}{current.lastDetail&&<p>{current.lastDetail}</p>}</div>}
            {histError[current.id]&&<Note tone="error">{histError[current.id]}</Note>}
            {histBusy===current.id&&!hist[current.id]?<Reading what="schedule history" />:hist[current.id]?.length?<ol className="sc-history">{hist[current.id].map((fire,index)=><li key={`${fire.at}:${index}`}><time dateTime={new Date(fire.at).toISOString()}>{when(fire.at)}</time><Pill status={fire.status} /><p>{fire.detail??outcome(fire.status).text}</p></li>)}</ol>:!histError[current.id]&&<p className="sc-fine">No recorded occurrences yet.</p>}
          </section>
        </div>:ready&&!readError?<EmptyState posture="nothing-yet" title="Give the work a rhythm." cue="A nightly check. A familiar batch. Choose work you have already reviewed, then give it a time to return." action={<button className="btn btn-primary" type="button" disabled={mutationDisabled} onClick={()=>begin('new')}>Create your first schedule</button>} />:readError?<EmptyState posture="could-not-read" title="Schedule details unavailable" cue="Refresh schedules to try again." />:<Reading what="schedule details" />}
      </div>
    </div>
    <details className="sc-support"><summary>Scheduler settings</summary><div className="sc-support-body">
      {daemonError&&<Note tone="error">{daemonError}<button className="btn btn-sm" type="button" onClick={()=>void readDaemon()}>Read scheduler status</button></Note>}
      <p>{daemon?.detail??'Reading background scheduler status…'}</p>
      {daemon?.supported&&<button className="btn" type="button" disabled={!!job} onClick={()=>void toggleDaemon()}>{job==='daemon'?'Updating background scheduler…':daemon.installed?'Stop background scheduler':'Fire schedules while Wanigan is closed'}</button>}
      <div className="sc-tick"><button className="btn" type="button" disabled={mutationDisabled} onClick={()=>void runDue()}>{job==='tick'?'Checking…':'Run anything due now'}</button><p className="sc-fine">Checks the current due window now. This can launch unattended agents or submit batches; schedules that are not due stay untouched.</p></div>
      <Explainer id="schedules-guide" title="How schedules run" defaultHidden><p>Schedules are stored in the local database. While Wanigan is open it checks for due work every 20 seconds. The background scheduler lets macOS run the same app without a window after login. Otherwise, missed work fires once on the next opening, rather than once for every missed occurrence. Pausing or deleting a schedule does not stop work that already started.</p></Explainer>
    </div></details>
  </div>;
}

function SchedulePreview({cron,paused=false,onReady}:{cron:string;paused?:boolean;onReady?:(valid:boolean)=>void}) {
  const [preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState<string|null>(null);
  const notify=useRef(onReady);notify.current=onReady;
  useEffect(()=>{
    let live=true;setPreview(null);setError(null);notify.current?.(false);
    const timer=setTimeout(()=>{void window.wanigan.schedule.preview(cron).then(value=>{if(live){setPreview({...value,cron});notify.current?.(value.fires.length>0);}}).catch(cause=>{if(live){setError(errorText(cause));notify.current?.(false);}});},180);
    return()=>{live=false;clearTimeout(timer);};
  },[cron]);
  if(error)return <Note tone="error">{error}</Note>;
  if(!preview||preview.cron!==cron)return <Reading what="next occurrences" />;
  if(!preview.fires.length)return <Note tone="warn">This expression has no matching future date.</Note>;
  return <section className="sc-preview"><SectionHead label={paused?'Cadence preview · currently paused':'Upcoming windows'} /><ol>{preview.fires.slice(0,3).map((at,index)=><li key={at}><span>{index+1}</span><strong>{calendarDay(at)}</strong><time dateTime={new Date(at).toISOString()}>{clockTime(at)}</time></li>)}</ol><p className="sc-fine">{preview.describe}. Local time on this Mac.{paused?' These windows will not run while paused.':' Due times are windows; the actual outcome appears in history.'}</p></section>;
}

function ScheduleEditor({draft,setDraft,projects,runs,runsError,cap,existing,creating,busy,disabled,error,onSave,onCancel}:{draft:Draft;setDraft:(draft:Draft)=>void;projects:Project[];runs:RunOption[];runsError:string|null;cap:number|null;existing:Schedule|null;creating:boolean;busy:boolean;disabled:boolean;error:string|null;onSave:()=>void;onCancel:()=>void}) {
  const [validCron,setValidCron]=useState(false);
  const [checkedCron,setCheckedCron]=useState('');
  const patch=(change:Partial<Draft>)=>setDraft({...draft,...change});
  const chosen=runs.find(row=>row.id===draft.rerunId);
  const missingProject=!!draft.projectId&&!projects.some(project=>project.id===draft.projectId);
  const unpinned=draft.kind==='headless'&&!draft.projectId;
  const canSave=validCron&&checkedCron===draft.cron&&!!draft.name.trim()&&!missingProject&&(creating||!!existing)&&(draft.kind==='batch'?!!chosen:!!draft.prompt.trim()&&(!unpinned||draft.allProjects&&projects.length>0));
  return <form className="sc-editor" onSubmit={event=>{event.preventDefault();if(canSave&&!disabled)onSave();}}>
    <div className="sc-editor-title"><h2>{creating?'Give it a time to return.':'Shape the next run.'}</h2><button className="btn btn-sm" type="button" disabled={busy} onClick={onCancel}>{creating?'Back to schedules':'Cancel edit'}</button></div>
    <p className="sc-fine">{creating?'Saving enables the schedule. Review the work, its scope and its next due times.':`Editing ${existing?.name??'a removed schedule'}. The next occurrence will use your saved changes.`}</p>
    {error&&<Note tone="error">{error}</Note>}
    <fieldset disabled={busy}>
      <label>Schedule name<input className="field" aria-label="Schedule name" data-schedule-initial maxLength={180} value={draft.name} placeholder="Keep checkout honest" onChange={event=>patch({name:event.target.value})} /></label>
      <div className="sc-fields-row"><label>What runs<select className="field" aria-label="What runs" value={draft.kind} disabled={!creating} onChange={event=>patch({kind:event.target.value as Kind})}><option value="headless">Headless run</option><option value="batch">Batch re-run</option></select></label>
        <label>Project<select className="field" aria-label="Project" value={draft.projectId} onChange={event=>patch({projectId:event.target.value,allProjects:false})}><option value="">{draft.kind==='batch'?'No project label':'Every registered repository'}</option>{missingProject&&<option value={draft.projectId}>Project unavailable</option>}{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
      {draft.kind==='headless'?<>
        <label>What should the agent do?<textarea className="field" aria-label="Prompt" value={draft.prompt} placeholder="Review the checkout changes and report risks. Make no changes." onChange={event=>patch({prompt:event.target.value})} /></label>
        <p className="sc-fine">Each occurrence starts an unattended agent with this prompt and the project's configured instructions, within a {usd(PER_REPO_BUDGET_USD)} per-repository ceiling.</p>
        {unpinned&&<div className="sc-scope"><label className="sc-check"><input type="checkbox" checked={draft.allProjects} onChange={event=>patch({allProjects:event.target.checked})} /><span><strong>Run in every registered repository.</strong> New projects will be included automatically.</span></label><p>{projects.length?`${namesOf(projects)}. ${projects.length} repositories today, with a combined ${usd(projects.length*PER_REPO_BUDGET_USD)} ceiling per occurrence.`:'No repositories are registered. Add one before creating a schedule.'}</p>{!draft.allProjects&&<p>Choose a single project or explicitly allow every registered repository before saving.</p>}</div>}
      </>:<>
        <label>Run to re-submit<select className="field" aria-label="Run to re-submit" value={draft.rerunId} onChange={event=>patch({rerunId:event.target.value})}><option value="">Choose a saved batch…</option>{draft.rerunId&&!chosen&&<option value={draft.rerunId}>Saved run unavailable</option>}{runs.map(row=><option key={row.id} value={row.id}>{row.name} · {num(row.total_requests)} requests</option>)}</select></label>
        {runsError&&<Note tone="error">{runsError}</Note>}
        <p className="sc-fine">{chosen?`${chosen.name} is submitted again from its saved configuration. ${chosen.cost_usd>0?`Last recorded cost: ${usd(chosen.cost_usd)}.`:`No settled cost; previous estimate: ${usd(chosen.est_cost_usd)}.`}`:'Choose a batch whose results you have already reviewed.'} File and command sources read the disk again at run time; pasted data keeps the same rows. The project selection is a label here; the batch uses its saved configuration.</p>
        {chosen&&cap!==null&&cap>0&&chosen.cost_usd>cap&&<Note tone="warn">The previous run cost {usd(chosen.cost_usd)}, above the current {usd(cap)} per-run cap. A fresh estimate must fit that cap before submission.</Note>}
      </>}
      <section className="sc-section"><SectionHead label="When it returns" /><div className="sc-presets">{PRESETS.map(preset=><Chip key={preset.cron} pressed={draft.cron===preset.cron} onToggle={()=>patch({cron:preset.cron})}>{preset.label}</Chip>)}</div><label>Cron expression<input className="field mono" aria-label="Cron expression" value={draft.cron} onChange={event=>patch({cron:event.target.value})} /></label>
        <SchedulePreview cron={draft.cron} onReady={valid=>{setValidCron(valid);setCheckedCron(draft.cron);}} /></section>
    </fieldset>
    {!creating&&!existing&&<Note tone="error">This schedule was removed. Your draft is still here, but it cannot be saved to the removed schedule.</Note>}
    <div className="sc-form-actions"><button className="btn btn-primary" type="submit" disabled={disabled||!canSave}>{busy?(creating?'Creating…':'Saving…'):creating?'Create schedule':'Save changes'}</button><p className="sc-fine">{!draft.name.trim()?'Give the schedule a name.':missingProject?'Choose an available project.':!canSave?'Complete the work, repository scope and timing above.':creating?'The schedule starts enabled; it can fire once its due window arrives.':'Work already started keeps its original instructions.'}</p></div>
  </form>;
}
