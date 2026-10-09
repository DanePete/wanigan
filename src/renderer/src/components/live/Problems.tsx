// What the site says is wrong on the page it shows: its own error and warning
// messages, and what its console logged. Read from the page; sent to an agent
// only when the owner asks.
import type { LiveProblem } from '@shared/live';
import type { ProjectSummary } from '@shared/model';
import { Button } from '../ui';
import { addNote } from './note-store';

export function ProblemsTab({ problems, project, url, onRefresh }: {
  problems: LiveProblem[] | null;
  project: ProjectSummary;
  url: string | null;
  onRefresh: () => void;
}) {
  if (!problems) return <p className="faint small live-side-block">Reading the page…</p>;
  if (!problems.length) {
    return (
      <div className="live-side-block">
        <p className="small">Nothing wrong on this page.</p>
        <p className="faint small">No error or warning messages from the site, and nothing logged as an error in its console since it loaded.</p>
        <div><Button size="s" tone="quiet" icon="refresh" onClick={onRefresh}>Check again</Button></div>
      </div>
    );
  }
  const keep = (): void => {
    addNote(project.id, {
      url: url ?? '', regions: [], pick: null, words: null, style: [], shot: null,
      text: `Fix what this page reports:\n${problems.map((p) => `- ${p.level === 'error' ? 'Error' : 'Warning'} (${p.source === 'page' ? 'shown on the page' : p.source === 'network' ? 'a request' : 'console'}): ${p.text}`).join('\n')}`,
    });
  };
  return (
    <div className="live-side-block">
      <ul className="live-problems">
        {problems.map((p, i) => (
          <li key={i} className={`live-problem-item ${p.level}`}>
            <span className="live-problem-level">{p.level === 'error' ? 'Error' : 'Warning'} · {p.source === 'page' ? 'on the page' : p.source === 'network' ? 'request' : 'console'}</span>
            <span className="small mono">{p.text}</span>
          </li>
        ))}
      </ul>
      <div className="live-send">
        <Button size="s" icon="note" onClick={keep}>Add to notes</Button>
        <Button size="s" tone="quiet" icon="refresh" onClick={onRefresh}>Check again</Button>
      </div>
    </div>
  );
}
