import { useEffect, useState } from 'react';
import type { Project } from '@shared/types';
import { outcomeRule, type WeeklyRecap } from '@shared/weekly-recap';
import { EmptyState, Mark, Note, SectionHead, Segmented, Stat, ago } from './bits';
import '../styles/mac-around.css';

/**
 * "This week" for one project, from recorded evidence (helper sweep · P8).
 * Every tile is a count of rows or a fact git states; a figure nothing
 * recorded reads "not recorded" or "not observed", never a zero.
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

function day(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export default function WeeklyRecapSection({ projectId }: { projectId: string | null }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [chosen, setChosen] = useState<string | null>(projectId);
  const [back, setBack] = useState<'0' | '1'>('0');
  const [recap, setRecap] = useState<WeeklyRecap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<string | null>(null);

  useEffect(() => { setChosen(projectId); }, [projectId]);
  useEffect(() => {
    let live = true;
    window.wanigan.projects.list().then((list) => {
      if (!live) return;
      setProjects(list);
      setChosen((current) => current ?? list[0]?.id ?? null);
    }, () => {});
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!chosen) return;
    let live = true;
    setRecap(null); setError(null); setExported(null);
    window.wanigan.recap.week(chosen, Number(back)).then((r) => { if (live) setRecap(r); }, (e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, [chosen, back]);

  if (!projects.length && !projectId) return null;
  const notRecorded = <span className="p8-fine">not recorded</span>;
  return (
    <section className="p8-recap" aria-label="This week">
      <SectionHead label={back === '0' ? 'This week' : 'Last week'} right={
        <div className="p8-recap-controls">
          {!projectId && projects.length > 1 && (
            <select className="field" aria-label="Project for the weekly recap" value={chosen ?? ''} onChange={(e) => setChosen(e.target.value)}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <Segmented label="Which week" value={back} onChange={setBack} options={[{ value: '0', label: 'This week' }, { value: '1', label: 'Last week' }]} />
          <button type="button" className="btn" disabled={!recap || !chosen}
                  onClick={() => { if (chosen) window.wanigan.recap.exportMarkdown(chosen, Number(back)).then(setExported, (e) => setError(msg(e))); }}>
            Export Markdown…
          </button>
        </div>
      } />
      {error && <Note tone="error">{error}</Note>}
      {exported && <Note tone="ok" onDismiss={() => setExported(null)}>Written to <code className="mono">{exported}</code>.</Note>}
      {!recap && !error && <p className="p8-fine">Reading this project’s records…</p>}
      {recap && (
        <>
          <p className="p8-fine">
            {recap.projectName} · {day(recap.start)} to {day(recap.end - 1)} · from Wanigan’s local records and git; no model wrote any of this.
          </p>
          {recap.nothingRecorded ? (
            <EmptyState posture="nothing-yet" title="Nothing recorded this week."
              cue="No session ran, no goal was accepted and no review gate ran in this project this week." />
          ) : (
            <>
              <div className="p8-recap-grid">
                <Stat label="Sessions run" value={recap.sessionsRun} sub={`${recap.conversations} conversation${recap.conversations === 1 ? '' : 's'}`} />
                <Stat label="Merged" value={recap.merged ?? notRecorded} sub={recap.outcomeMethod === 'git' ? 'read from git' : recap.outcomeMethod === 'mixed' ? 'recorded, and read from git' : undefined} />
                <Stat label="Discarded" value={recap.discarded ?? notRecorded} sub={recap.outcomeMethod === 'git' ? 'removed unmerged' : recap.outcomeMethod === 'mixed' ? 'recorded, and read from git' : undefined} />
                <Stat label="Goals accepted" value={recap.goalsAccepted.length} />
                <Stat label="Gates failed" value={recap.gatesFailed} sub={`of ${recap.gatesRun} run`} />
                <Stat label="Worktrees open" value={recap.worktreesOpen.length} sub="now, not only this week" />
                <Stat label="Half-finished" value={recap.halfFinished.length} sub="exited without a merge" />
                <Stat label="Cost" value={recap.cost ? `$${recap.cost.usd.toFixed(2)}` : <span className="p8-fine">not observed</span>}
                      sub={recap.cost ? `reported by ${recap.cost.sessionsReporting} session${recap.cost.sessionsReporting === 1 ? '' : 's'}` : 'no session reported a cost'} />
              </div>
              <p className="p8-fine">Merge outcomes: {outcomeRule(recap.outcomeMethod)}.</p>
              {recap.halfFinished.length > 0 && (
                <div className="p8-recap-list">
                  <h3 className="label">Half-finished</h3>
                  <ul>
                    {recap.halfFinished.map((h) => (
                      <li key={h.sessionId}>
                        <Mark glyph="◐" word="open" tone="warn" />
                        <span>{h.title ?? h.sessionId}</span>
                        {h.branch && <code className="mono p8-path">{h.branch}</code>}
                        <span className="p8-fine">exited {ago(h.endedAt)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {recap.failedCommands.length > 0 && (
                <div className="p8-recap-list">
                  <h3 className="label">Gate commands that failed</h3>
                  <ul>{recap.failedCommands.map((c) => <li key={c}><Mark glyph="✕" word="failed" tone="bad" /><code className="mono">{c}</code></li>)}</ul>
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
