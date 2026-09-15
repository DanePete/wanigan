import type { AgentGitMark } from '@shared/agent-git';
import { Mark, ago } from './bits';
import '../styles/depth.css';

/**
 * "Run by <session>" on the Git view's rows an agent's git command produced.
 *
 * A reflog join names the SHA or branch git itself recorded inside the Bash
 * call's window; a time join only found a commit made in that window and says
 * "by time". A row with no mark is not a claim that a person made it — only
 * that no recorded agent command did.
 */

export type AgentGitLink = (sessionId: string, eventId: number) => void;

function title(marks: readonly AgentGitMark[]): string {
  const names = [...new Set(marks.map((m) => m.sessionTitle))];
  return names.length === 1 ? names[0] : `${names[0]} and ${names.length - 1} more`;
}

/** The inline words on a commit row. Not interactive: the row itself is the button. */
export function RunByInline({ marks }: { marks: readonly AgentGitMark[] | undefined }) {
  if (!marks?.length) return null;
  const weak = marks.every((m) => m.join === 'time');
  // "by time" leads, so a narrow row that cuts its end never cuts the word that says the join is weak.
  return <span className="dp-runby-inline"> · {weak ? '≈ by time: ' : '⌥ '}{marks[0].verb} run by {title(marks)}</span>;
}

/** The marks on a selected commit or a branch row, each linking to its timeline row when the session is open. */
export function RunByList({ marks, openSessions, onOpen, compact }: {
  marks: readonly AgentGitMark[] | undefined; openSessions: ReadonlySet<string>; onOpen?: AgentGitLink; compact?: boolean;
}) {
  if (!marks?.length) return null;
  return (
    <ul className={`dp-runby${compact ? ' compact' : ''}`}>
      {marks.map((m) => {
        const canOpen = !!onOpen && openSessions.has(m.sessionId);
        return (
          <li key={`${m.eventId}:${m.verb}`}>
            <Mark glyph="⌥" word={`${m.verb} run by ${m.sessionTitle}`} tone="accent" />
            {m.join === 'time' && <Mark glyph="≈" word="by time" tone="warn" title="No reflog entry matched this command; a commit made inside its window was joined by time." />}
            {!compact && <code className="dp-runby-cmd">{m.command}</code>}
            <span className="faint dp-fine">{ago(m.at)}</span>
            {canOpen
              ? <button type="button" className="btn btn-sm" onClick={() => onOpen!(m.sessionId, m.eventId)}>Open in timeline</button>
              : <span className="faint dp-fine">session not open</span>}
          </li>
        );
      })}
    </ul>
  );
}
