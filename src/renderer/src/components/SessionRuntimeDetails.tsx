import type { Session } from '@shared/types';
import SessionProcessesPanel from './SessionProcesses';
import { SessionProvenance } from './LaunchProvenance';
import '../styles/runtime.css';

/**
 * A session's runtime details, folded under its header: the processes it runs
 * and the ones it left running. Closed by default — the terminal is what the
 * operator came to this view for, and this drawer is where they look when a
 * port is taken or the fans spin up.
 */
export default function SessionRuntimeDetails({ session }: { session: Session }) {
  return (
    <>
      <details className="session-runtime">
        <summary>Processes and ports<span>{session.status === 'exited' ? 'what it left running' : 'what it is running'}</span></summary>
        <div className="session-runtime-body">
          <SessionProcessesPanel session={session} compact />
        </div>
      </details>
      <details className="session-runtime">
        <summary>Launch values<span>where each one came from</span></summary>
        <div className="session-runtime-body">
          <SessionProvenance sessionId={session.id} />
        </div>
      </details>
    </>
  );
}
