import { useState } from 'react';
import {
  gapSentence, lookbackSentence, repoLabel,
  type IntakeKind, type IntakeOverview, type IntakePoll, type IntakeProject,
} from '@shared/intake';
import { EmptyState, Hint, Mark, Note, Reading, SectionHead, type MarkSpec } from './bits';
import '../styles/intake.css';

/**
 * GitHub intake inside Control's event inbox: for each project with a GitHub
 * remote, what its last check did, and a press that checks again.
 *
 * The three facts of a check are three marks, never one status: fired (by a
 * press or the timer), ran (gh invoked) and how it ended. A check that never
 * ran says "did not run" rather than borrowing the time it fired, and a failed
 * or skipped one prints main's reason with gh's own words beside it. When a
 * check's window started long before it, the gap sentence is a warning, because
 * an issue opened and closed while nothing was watching is simply not here.
 *
 * Nothing in this component writes to GitHub. The press reads, main records,
 * and the events it added appear in the list below like any other.
 */

/** What a GitHub event is, beside the kind word Control already stores. */
export const INTAKE_MARKS: Record<IntakeKind, MarkSpec> = {
  opened: { glyph: '+', word: 'opened', tone: 'accent' },
  labelled: { glyph: '•', word: 'labelled', tone: 'quiet' },
  commented: { glyph: '›', word: 'commented', tone: 'quiet' },
  ci_failed: { glyph: '✕', word: 'CI failed', tone: 'bad' },
};

/**
 * Main appends the link to a GitHub event's summary so a goal made from it keeps
 * a way back to the issue. The row has its own Open on GitHub button, so the
 * link is not printed twice; any other ending is shown exactly as stored.
 */
export function summaryWithoutLink(summary: string, url: string | null): string {
  const tail = url ? ` — ${url}` : '';
  return tail && summary.endsWith(tail) ? summary.slice(0, -tail.length) : summary;
}

function when(at: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

function outcomeMark(poll: IntakePoll): MarkSpec {
  const at = poll.finishedAt === null ? '' : ` ${when(poll.finishedAt)}`;
  if (poll.outcome === 'succeeded') return { glyph: '✓', word: `succeeded${at}`, tone: 'ok' };
  if (poll.outcome === 'failed') return { glyph: '✕', word: `failed${at}`, tone: 'bad' };
  if (poll.outcome === 'skipped') return { glyph: '⊘', word: `skipped${at}`, tone: 'warn' };
  return { glyph: '…', word: 'still reading', tone: 'quiet' };
}

function countsSentence(poll: IntakePoll): string {
  const added = poll.counts.opened + poll.counts.labelled + poll.counts.commented + poll.counts.ci_failed;
  if (poll.factsRead === 0) return 'Nothing new on GitHub in this window.';
  const known = poll.factsRead - added;
  if (added === 0) return `No new events: ${plural(poll.factsRead, 'fact')} read, all already in the inbox.`;
  return `${plural(added, 'new event')}: ${poll.counts.opened} opened · ${poll.counts.labelled} labelled · ${poll.counts.commented} commented · ${poll.counts.ci_failed} CI failed.`
    + (known > 0 ? ` ${plural(known, 'other fact')} read ${known === 1 ? 'was' : 'were'} already in the inbox.` : '');
}

function PollLines({ poll, lastSucceeded }: { poll: IntakePoll; lastSucceeded: IntakePoll | null }) {
  const gap = gapSentence(poll);
  const covered = poll.outcome === 'succeeded' && poll.since !== null && poll.until !== null
    ? [`Covered ${when(poll.since)} to ${when(poll.until)}.`, lookbackSentence(poll), poll.capped].filter(Boolean).join(' ')
    : null;
  return <>
    <p className="intake-states">
      <Mark glyph="●" word={`fired ${when(poll.firedAt)}`} tone="quiet" />
      <span className="intake-by">{poll.trigger === 'timer' ? 'by the timer' : 'by a press'}</span>
      {poll.ranAt === null ? <Mark glyph="–" word="did not run" tone="dead" /> : <Mark glyph="▸" word={`ran ${when(poll.ranAt)}`} tone="quiet" />}
      <Mark {...outcomeMark(poll)} />
    </p>
    {poll.outcome === 'succeeded' && <p className="intake-counts">{countsSentence(poll)}</p>}
    {covered && <p className="intake-detail">{covered}</p>}
    {(poll.outcome === 'failed' || poll.outcome === 'skipped') && poll.reason && <p className="intake-reason">{poll.reason}</p>}
    {poll.error && <p className="intake-said">{poll.ranAt === null ? 'git' : 'gh'} said: <span className="intake-words">{poll.error}</span></p>}
    {gap && <Note tone="warn" role="none">{gap}</Note>}
    {(poll.outcome === 'failed' || poll.outcome === 'skipped') && <p className="intake-detail">
      {lastSucceeded?.finishedAt
        ? `The last successful check finished ${when(lastSucceeded.finishedAt)}; the inbox holds what it and earlier checks recorded.`
        : 'No check of this project has succeeded yet, so nothing from GitHub is in the inbox for it.'}
    </p>}
  </>;
}

function ProjectIntake({ project, busy, pressing, refused, onCheck }: {
  project: IntakeProject; busy: boolean; pressing: boolean; refused: string | null; onCheck: () => void;
}) {
  const watch = project.watch.kind === 'github' ? project.watch : null;
  return <div className="intake-project" role="group" aria-label={`${project.projectName} on GitHub`}>
    <div className="intake-project-line">
      <strong>{project.projectName}</strong>
      {watch && <span className="intake-repo">{repoLabel(watch.repo)}{watch.remote === 'origin' ? '' : ` · via ${watch.remote}`}</span>}
      <button type="button" className="btn btn-sm" disabled={busy} onClick={onCheck}>{pressing ? 'Checking…' : 'Check GitHub now'}</button>
    </div>
    {refused && <Note tone="error">The check was not recorded: {refused}</Note>}
    {project.last
      ? <PollLines poll={project.last} lastSucceeded={project.lastSucceeded} />
      : <p className="intake-detail">Not checked yet, so nothing from GitHub is in the inbox for this project.</p>}
  </div>;
}

export default function GitHubIntake({ overview, error, onReload, onChecked }: {
  overview: IntakeOverview | null;
  error: string | null;
  onReload: () => void;
  /** After a press settles, whatever it recorded: the inbox and this section read again. */
  onChecked: () => void;
}) {
  const [pressing, setPressing] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ projectId: string; text: string } | null>(null);

  async function check(projectId: string) {
    setPressing(projectId); setRefused(null);
    try {
      await window.wanigan.intake.check(projectId);
    } catch (e) {
      setRefused({ projectId, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setPressing(null);
      onChecked();
    }
  }

  if (!overview) {
    return error
      ? <EmptyState posture="could-not-read" title="GitHub intake could not be read" cue={error} action={<button type="button" className="btn" onClick={onReload}>Try again</button>} />
      : <Reading what="GitHub intake" />;
  }
  const watched = overview.projects.filter((project) => project.watch.kind === 'github');
  const unwatched = overview.projects.filter((project) => project.watch.kind === 'unwatched');
  const timer = overview.timer;
  return <section className="intake" aria-label="GitHub intake">
    <SectionHead label="GitHub intake" count={watched.length} />
    <p className="intake-lead">Issues opened, labelled or commented on, and failed CI runs, read through your gh and added to this inbox for you to triage. Nothing is written to GitHub.</p>
    <p className="intake-timer">
      {timer.enabled
        ? <><Mark glyph="▸" word={`timer every ${timer.intervalMinutes} minutes`} tone="quiet" /> Only while Wanigan is running: nothing watches while it is closed or this Mac sleeps, and the next check says for how long.</>
        : <><Mark glyph="○" word="timer off" tone="quiet" /> GitHub is read only when you press Check GitHub now. The timer is in Settings › Connections.</>}
    </p>
    {error && <Note tone="error">GitHub intake could not be read again, so this may be out of date: {error}</Note>}
    {watched.length === 0 && <Hint>No project has a GitHub remote, so there is nothing to check.</Hint>}
    {watched.map((project) => <ProjectIntake key={project.projectId} project={project} busy={pressing !== null}
      pressing={pressing === project.projectId} refused={refused?.projectId === project.projectId ? refused.text : null}
      onCheck={() => void check(project.projectId)} />)}
    {unwatched.length > 0 && <details className="intake-unwatched">
      <summary>{plural(unwatched.length, 'project')} not watched</summary>
      <ul>{unwatched.map((project) => <li key={project.projectId}>
        <strong>{project.projectName}</strong> {project.watch.kind === 'unwatched' ? project.watch.detail : ''}
      </li>)}</ul>
    </details>}
  </section>;
}
