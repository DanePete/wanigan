// Why there is no trace for the page shown, said plainly, with the one thing
// to do next: install or update the helper, reload, start the site.
import { useState } from 'react';
import { traceNote, type LiveTraceAnswer } from '@shared/live-lens';
import type { LiveSite } from '@shared/live';
import type { ProjectSummary } from '@shared/model';
import { liveBridge } from '../../lib/live';
import { Button } from '../ui';
import { HelperDialog } from './Helper';

export function TraceNote({ answer, site, project, compact = false }: {
  answer: LiveTraceAnswer | null;
  site: LiveSite;
  project: ProjectSummary;
  /** One line, for the lens strip and the Inspector. */
  compact?: boolean;
}) {
  const [helper, setHelper] = useState(false);
  const note = traceNote(answer, site.helper, site.platform);
  if (!note) return null;
  const canHelp = !!site.helperPlan && !site.helperPlan.refused;
  const action = (() => {
    switch (note.next) {
      case 'reload':
      case 'log-in':
      case 'start-site':
        return <Button size="s" icon="refresh" onClick={() => void liveBridge()?.reload(true)}>Reload</Button>;
      case 'install-helper':
        return canHelp ? <Button size="s" icon="plug" onClick={() => setHelper(true)}>Set up the helper…</Button> : null;
      case 'update-helper':
        return canHelp && site.helper ? <Button size="s" icon="plug" onClick={() => setHelper(true)}>Update the helper…</Button> : null;
      default:
        return null;
    }
  })();
  return (
    <div className={`live-trace-note${compact ? ' compact' : ''}`} role="status">
      <div className="live-trace-note-text">
        <p className="live-trace-note-title">{note.title}</p>
        {compact ? null : <p className="small faint">{note.body}</p>}
      </div>
      {action}
      {helper ? <HelperDialog site={site} project={project} onClose={() => setHelper(false)} /> : null}
    </div>
  );
}
