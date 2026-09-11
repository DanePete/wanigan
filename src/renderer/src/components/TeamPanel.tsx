import { useCallback, useEffect, useRef, useState } from 'react';
import { Hint, Mark, Note, SectionHead, Segmented, ago, markOf, num } from './bits';
import '../styles/team.css';

type Member = { name: string; agentId: string | null; agentType: string | null; isLead: boolean };
type Task = {
  id: string; title: string; status: string; assignee: string | null;
  dependsOn: string[]; blocked: boolean;
  /** Counted by main: unfinished dependencies, not the total declared. */
  blockedBy: number; updatedAt: number | null;
};
type Msg = { to: string; from: string | null; at: number | null; kind: string; preview: string };
type Team = {
  name: string; configPath: string; members: Member[]; tasks: Task[]; pending: Msg[];
  counts: { pending: number; inProgress: number; completed: number; blocked: number };
  updatedAt: number | null;
};
type TeamState = { teams: Team[]; enabled: boolean; note: string | null };
type Filter = 'all' | 'unfinished' | 'blocked' | 'completed';
const completed = (task: Task) => task.status === 'complete' || task.status === 'completed';

/** Read-only task and mailbox observations. No assignments or messages are sent. */
export default function TeamPanel() {
  const [state, setState] = useState<TeamState | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const sequence = useRef(0);
  const inFlight = useRef(0);
  const load = useCallback(async () => {
    if (inFlight.current && inFlight.current === sequence.current) return;
    const request = ++sequence.current;
    inFlight.current = request;
    setReading(true);
    try {
      const value = await window.wanigan.teams.read();
      if (request === sequence.current) { setState(value); setError(null); setReadAt(Date.now()); }
    } catch (e) {
      if (request === sequence.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (inFlight.current === request) inFlight.current = 0;
      if (request === sequence.current) setReading(false);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 6000);
    const onVisible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { sequence.current++; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [load]);

  if (!error && (!state || (state.teams.length === 0 && !state.enabled))) return null;
  const total = state?.teams.reduce((n, team) => n + team.tasks.length, 0) ?? 0;
  const blocked = state?.teams.reduce((n, team) => n + team.counts.blocked, 0) ?? 0;
  const waiting = state?.teams.reduce((n, team) => n + team.pending.length, 0) ?? 0;
  return <section className="team-workspace" aria-label="Agent teams">
    <SectionHead label="Agent teams" count={state?.teams.length} right={<button className="btn btn-sm" type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Hide tasks' : 'Show tasks'}</button>} />
    <div className="team-summary"><strong>{num(total)} shared {total === 1 ? 'task' : 'tasks'}</strong>{blocked > 0 && <Mark {...markOf('blocked')} word={`${blocked} blocked`} />}{waiting > 0 && <span>{waiting} messages waiting</span>}</div>
    {error && <Note tone="warn" action={{ label: reading ? 'Reading teams…' : 'Retry team read', run: load }}>{state ? 'Team update unavailable. Showing the last successful read. ' : 'Team information unavailable. '}{error}</Note>}
    {state?.note && <p className="team-note">{state.note}</p>}
    {open && <>
      <div className="team-tools">
        <input className="field" type="search" aria-label="Search team tasks" placeholder="Find a task, teammate or team" value={query} onChange={event => setQuery(event.target.value)} />
        <Segmented<Filter> label="Team task status" value={filter} onChange={setFilter} options={[{value:'all',label:'All'},{value:'unfinished',label:'Unfinished'},{value:'blocked',label:'Blocked'},{value:'completed',label:'Completed'}]} />
      </div>
      {state?.teams.length === 0 && <Hint>No shared teams have been recorded.</Hint>}
      {state?.teams.map(team => <TeamDetail key={team.name} team={team} query={query} filter={filter} onClear={() => { setQuery(''); setFilter('all'); }} />)}
      <p className="team-note">{readAt ? `Read ${ago(readAt)}. ` : ''}Task and inbox files only; this view does not send messages or assign work.</p>
    </>}
  </section>;
}

function TeamDetail({ team, query, filter, onClear }: { team: Team; query: string; filter: Filter; onClear: () => void }) {
  const [limit, setLimit] = useState(24);
  useEffect(() => setLimit(24), [query, filter]);
  const needle = query.trim().toLowerCase();
  const tasks = team.tasks.filter(task => (`${team.name} ${task.title} ${task.id} ${task.assignee ?? ''}`).toLowerCase().includes(needle)
    && (filter === 'all' || filter === 'blocked' && task.blocked || filter === 'completed' && completed(task) || filter === 'unfinished' && !completed(task)));
  return <article className="team-detail">
    <SectionHead label={team.name} right={team.updatedAt ? <span>Updated {ago(team.updatedAt)}</span> : undefined} />
    <ul className="team-members" aria-label={`${team.name} members`}>{team.members.map(member => <li key={member.name}><strong>{member.name}</strong><span>{member.isLead ? 'Lead' : member.agentType ?? 'Teammate'}</span></li>)}</ul>
    {team.tasks.length === 0 ? <Hint>No shared tasks. Teammates may coordinate through messages.</Hint> : tasks.length === 0 ? <Hint>No tasks match this view. <button type="button" className="btn btn-sm" onClick={onClear}>Clear task filters</button></Hint> : <>
      <ol className="team-tasks" aria-label={`${team.name} tasks`}>{tasks.slice(0,limit).map(task => <li key={task.id}>
        <div className="team-task-description"><strong>{task.title}</strong><span>{task.assignee ? `Claimed by ${task.assignee}` : 'Unclaimed'}</span>{task.blocked && <p className="team-blocker">Waiting on {task.blockedBy} of {task.dependsOn.length} dependencies</p>}</div>
        <Mark {...markOf(completed(task) ? 'completed' : task.status.includes('progress') ? 'running' : 'pending')} word={task.status.replaceAll('_',' ')} />
      </li>)}</ol>
      <div className="team-list-end"><span>{Math.min(limit,tasks.length)} of {tasks.length} matching tasks</span>{tasks.length > limit && <button type="button" className="btn btn-sm" onClick={() => setLimit(value => value + 24)}>Show more tasks</button>}</div>
    </>}
    {team.pending.length > 0 && <details className="team-mail"><summary>Waiting messages <span>{team.pending.length}</span></summary><p className="team-note">Stored previews from the team inboxes.</p>{team.pending.map((message,index) => <article key={`${message.to}-${message.at}-${index}`}><div><strong>{message.from ?? 'Unknown sender'} → {message.to}</strong>{message.at && <time>{ago(message.at)}</time>}</div><p>{message.preview || 'No preview recorded.'}</p></article>)}</details>}
  </article>;
}
