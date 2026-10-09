// "How this works": the board as a picture, with live numbers. Every sentence
// here is a rule the core enforces; if a rule changes, this changes with it.
// A number whose source has not answered is left out, never guessed.
import type { KeyboardEvent, ReactNode } from 'react';
import type { CardSummary, ProjectSummary } from '@shared/model';
import { useQuery } from '../lib/api';
import { navigate } from '../lib/router';
import { plural } from '../lib/format';
import { Dialog } from '../components/ui';

type Actor = 'you' | 'agents' | 'jev' | 'board' | 'needs' | 'done';
type Column = 'inbox' | 'ready' | 'working' | 'review' | 'done';

const ACTOR_TAG: Record<Actor, string> = {
  you: 'You', agents: 'Agents', jev: 'Jev', board: 'The board', needs: 'Needs you', done: 'The board',
};

const DAY = 86_400_000;

export function HowItWorks({ project, cards, onClose, showColumn }: {
  project: ProjectSummary;
  cards: CardSummary[] | undefined;
  onClose: () => void;
  showColumn: (column: Column) => void;
}) {
  const jev = useQuery('jev.status', {}, ['projects']);
  const live = cards?.filter((c) => c.status !== 'archived');
  const count = (pred: (c: CardSummary) => boolean): number | null => (live ? live.filter(pred).length : null);
  const column = (col: Column): number | null => count((c) => c.status === col);
  const recent = cards ? cards.filter((c) => Date.now() - c.createdAt < 3 * DAY) : null;
  const filedByAgents = recent ? recent.filter((c) => c.createdBy.startsWith('session:')).length : null;
  const stopped = count((c) => c.status === 'working' && !c.live);

  const go = (col: Column) => () => { onClose(); showColumn(col); };
  const page = (to: () => void) => () => { onClose(); to(); };
  const jevLine = !jev.data ? null
    : !jev.data.configured ? 'not set up'
      : project.jev === 'off' ? 'off in this project'
        : jev.data.online ? `online · ${jev.data.callsToday} reads today` : 'not answering';

  return (
    <Dialog title="How this works" onClose={onClose} width={1240}>
      <p className="how-intro">
        <strong>You decide what gets built and what counts as done.</strong>{' '}
        Agents file cards and do the work in real terminals, Jev reads what comes in, and nothing reaches Done until you approve it.
      </p>
      <div className="how">
        <div className="how-flow" aria-label="How a card moves through the board">
          <Lane n={1} title="Filing" actor="you">
            <Box actor="you" title="You file a card" num={recent ? `${plural(recent.length, 'card')} filed in 3 days` : null}>
              New card (C) or + on a column. Yours go straight to Ready, unless you put them in the Inbox. Draft with Claude can write one up from a rough note.
            </Box>
            <Arrow />
            <Box actor="agents" title="Agents file what they find" num={filedByAgents !== null ? `${filedByAgents} by agents in 3 days` : null} onClick={go('inbox')} hint="Show the Inbox">
              Any session can run <code>wanigan file bug “…”</code>. What an agent files always lands in the Inbox, for you.
            </Box>
            <Arrow />
            <Box actor="jev" title="Jev reads each new card" num={jevLine} onClick={page(() => navigate({ name: 'settings' }))} hint="Open Jev’s settings">
              In under a second: what to do with it, how much it matters, and whether it repeats another card. Advice, unless this project lets Jev accept confident cards.
            </Box>
          </Lane>

          <Lane n={2} title="Your call" actor="you">
            <Box actor="you" title="Inbox" num={numOf(column('inbox'), 'waiting for you')} onClick={go('inbox')} hint="Show the Inbox">
              Accept it to Ready (A), archive it (X), or start a session on it, which accepts it. Agents cannot take a card from the Inbox.
            </Box>
            <Arrow label="you accept" />
            <Box actor="board" title="Ready" num={numOf(column('ready'), 'ready')} onClick={go('ready')} hint="Show Ready">
              Accepted work. Acceptance criteria say what done means, and the agent is told them when it starts.
            </Box>
          </Lane>

          <Lane n={3} title="The work" actor="agents">
            <Box actor="agents" title="A session takes it" num={numOf(project.liveSessions, 'session running', 'sessions running')}>
              Start Claude Code, Codex or a shell on a card. It claims the card for 30 minutes at a time, renewed while it runs, on its own branch if you like.
            </Box>
            <Arrow />
            <Box actor="agents" title="Working" num={numOf(column('working'), 'in progress')} onClick={go('working')} hint="Show Working">
              The agent works in a real terminal that keeps running when the window closes. It notes progress, and asks you with <code>wanigan ask</code>.
            </Box>
            <Arrow label="with evidence" />
            <Box actor="you" title="Review" num={numOf(column('review'), 'for you to review')} onClick={go('review')} hint="Show Review">
              Only with evidence: a file, a link or a note. Ask Claude to check it against each criterion if you like; that is advice.
            </Box>
            <Arrow label="you approve" />
            <Box actor="done" title="Done" num={numOf(column('done'), 'done')} onClick={go('done')} hint="Show Done">
              Only you approve. An agent can never mark its own work done.
            </Box>
          </Lane>

          <Lane n={4} title="When it goes wrong" actor="needs">
            <Box actor="you" title="Send back" num={numOf(count((c) => c.sentBack), 'sent back')} onClick={go('ready')} hint="Show Ready">
              Not right yet? It goes back to Ready with your note, and the next session is told it.
            </Box>
            <Box actor="you" title="Reopen" num={numOf(count((c) => c.reopened), 'reopened')} onClick={go('ready')} hint="Show Ready">
              Done, but not fixed? Reopen it and say what is still wrong; that becomes a new criterion.
            </Box>
            <Box actor="board" title="A session stops" num={stopped ? `${plural(stopped, 'card')} held, no session running` : null} onClick={go('working')} hint="Show Working">
              Its claim is released and the card returns to Ready. Notes, evidence and history stay on the card.
            </Box>
            <Box actor="needs" title="Needs you" num={numOf(project.needsYou, 'need you now', 'need you now')} onClick={page(() => navigate({ name: 'needs' }))} hint="Open Needs you">
              Permission prompts, questions, failures, finished turns and quiet sessions, from every project, most urgent first.
            </Box>
          </Lane>
        </div>

        <aside className="how-side">
          <section className="how-card how-card-needs">
            <h3>When you are needed</h3>
            <ul>
              <li><strong>Asking permission:</strong> an agent is waiting on a prompt in its terminal.</li>
              <li><strong>Ready for review:</strong> evidence is in; approve it or send it back.</li>
              <li><strong>A question:</strong> an agent asked on a card.</li>
              <li><strong>Failed or interrupted:</strong> a session ended badly.</li>
              <li><strong>Two sessions, one file:</strong> they may be undoing each other.</li>
              <li><strong>Gone quiet, or finished a turn:</strong> worth a look.</li>
            </ul>
          </section>
          <section className="how-card">
            <h3>Who does what</h3>
            <ul className="how-legend">
              <li><span className="how-swatch how-you" aria-hidden="true" /><strong>You:</strong> what to build, what counts as done, and every approval.</li>
              <li><span className="how-swatch how-agents" aria-hidden="true" /><strong>Agents:</strong> Claude Code, Codex or a shell, in real terminals. They claim, work, ask and submit through <code>wanigan</code>.</li>
              <li><span className="how-swatch how-jev" aria-hidden="true" /><strong>Jev:</strong> TypeSafe’s fast decision model. Reads new cards; advice by default.{jevLine ? ` Now: ${jevLine}.` : ''}</li>
              <li><span className="how-swatch how-board" aria-hidden="true" /><strong>The board:</strong> keeps the rules. Wanigan enforces them; no one can skip a step.</li>
            </ul>
          </section>
          <section className="how-card how-card-quiet">
            <h3>Reading the picture</h3>
            <ul>
              <li>Arrows are the usual path. Lane 4 is how work comes back.</li>
              <li>Click a box to open its column or page.</li>
              <li>Numbers are live from this board. A missing number means its source has not answered.</li>
              <li>Nothing is deleted. Archived cards keep their history.</li>
            </ul>
          </section>
        </aside>
      </div>
    </Dialog>
  );
}

function numOf(n: number | null, one: string, many = one): string | null {
  if (n === null) return null;
  return `${n} ${n === 1 ? one : many}`;
}

function Lane({ n, title, actor, children }: { n: number; title: string; actor: Actor; children: ReactNode }) {
  return (
    <section className={`how-lane how-${actor}`} aria-label={`${n}. ${title}`}>
      <h3 className="how-lane-title"><span className="how-lane-n">{n}</span>{title}</h3>
      <div className="how-lane-row">{children}</div>
    </section>
  );
}

function Box({ actor, title, num, children, onClick, hint }: {
  actor: Actor; title: string; num: string | null; children: ReactNode; onClick?: () => void; hint?: string;
}) {
  const onKey = (e: KeyboardEvent): void => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
  };
  return (
    <div
      className={`how-box how-${actor}${onClick ? ' linked' : ''}`}
      {...(onClick ? { role: 'link', tabIndex: 0, onClick, onKeyDown: onKey, 'aria-label': `${title}. ${hint ?? ''}`, title: hint } : {})}
    >
      <span className="how-tag">{ACTOR_TAG[actor]}</span>
      <strong className="how-title">{title}</strong>
      <p className="how-text">{children}</p>
      {num ? <span className="how-num">{num}</span> : null}
    </div>
  );
}

function Arrow({ label }: { label?: string }) {
  return (
    <span className={`how-arrow${label ? ' labelled' : ''}`} aria-hidden="true">
      {label ? <span className="how-arrow-label">{label}</span> : null}
    </span>
  );
}
