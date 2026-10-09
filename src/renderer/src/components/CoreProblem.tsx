// Said in the shell, above any view: the core could not start (and why, and
// where its log is), or the core running is from another build of Wanigan and
// restarting it would end live sessions. Nothing here pretends a terminal
// survives its core.
import { useId } from 'react';
import type { CoreAction } from '@shared/bridge';
import { bridge, useCoreProblem } from '../lib/api';
import { plural } from '../lib/format';
import { Button } from './ui';

export function CoreProblemPanel() {
  const problem = useCoreProblem();
  const title = useId();
  if (!problem) return null;
  const act = (action: CoreAction): Promise<void> => bridge().coreAction(action);
  if (problem.kind === 'failed') {
    return (
      <section className="core-problem" role="alert" aria-labelledby={title}>
        <h2 id={title}>Wanigan’s core could not start</h2>
        <p className="core-problem-reason">{problem.reason}</p>
        <p className="faint small">The core keeps the board and runs every session, so nothing works until it starts. More in its log, <span className="mono">{problem.log}</span>.</p>
        <div className="core-problem-actions">
          <Button tone="primary" icon="refresh" onClick={() => act('retry')}>Try again</Button>
          <Button tone="quiet" icon="folder" onClick={() => bridge().openPath(problem.log)}>Show the log</Button>
        </div>
      </section>
    );
  }
  return (
    <section className="core-problem other-build" role="alert" aria-labelledby={title}>
      <h2 id={title}>Wanigan’s core is from another build</h2>
      <p>Restart it? {problem.live > 0 ? `${plural(problem.live, 'live session')} will be interrupted: a terminal ends with the core it runs in.` : 'No live sessions were reported.'}</p>
      <p>Restarting also stops running reviews, answers, and Jev requests. An older core may be unable to confirm it is idle.</p>
      <p className="faint small">Kept, this window talks to the older core, and what changed since may not work until it restarts.</p>
      <div className="core-problem-actions">
        <Button tone="danger" icon="reopen" onClick={() => act('restart')}>Restart</Button>
        <Button tone="quiet" onClick={() => act('keep')}>Keep using it</Button>
      </div>
    </section>
  );
}
