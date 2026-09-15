import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@shared/types';
import type { ProcessSurvivor, SessionProcesses as Reading, StopSurvivorResult } from '@shared/process-tree';
import { ConfirmNote, Mark, Note, SectionHead, ago, dur, num, size } from './bits';
import '../styles/runtime.css';

/**
 * What a session is running, and what it left running.
 *
 * Main samples the process table only while a view like this one asks, and at
 * most every ten seconds however many ask — so this polls on that interval and
 * no faster. Every figure is a reading of `ps` and `lsof` at `sampledAt`, and
 * the sentence under the numbers says so.
 */
const POLL_MS = 10_000;

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

export function useSessionProcesses(sessionId: string): { reading: Reading | null; error: string | null; reload: () => Promise<void> } {
  const [reading, setReading] = useState<Reading | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    const ticket = ++seq.current;
    try {
      const next = await window.wanigan.processes.forSession(sessionId);
      if (ticket === seq.current) { setReading(next); setError(null); }
    } catch (e) {
      if (ticket === seq.current) setError(msg(e));
    }
  }, [sessionId]);
  useEffect(() => {
    // The counter object, not its value, is what cleanup bumps: a reply that
    // lands after the session changed carries a ticket that no longer matches.
    const counter = seq;
    void reload();
    const timer = setInterval(() => { void reload(); }, POLL_MS);
    return () => { clearInterval(timer); counter.current++; };
  }, [reload]);
  return { reading, error, reload };
}

function idleWords(s: ProcessSurvivor): string {
  return s.cpuIdleBasis === 'observed'
    ? `CPU idle ${dur(s.cpuIdleMs)}`
    : `no CPU use seen in ${dur(s.cpuIdleMs)}`;
}

/** One leftover process, with the only action this feature offers: Stop, confirmed. */
function SurvivorRow({ sessionId, survivor, onStopped }: {
  sessionId: string; survivor: ProcessSurvivor; onStopped: (result: StopSurvivorResult) => void;
}) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try { onStopped(await window.wanigan.processes.stop(sessionId, survivor.pid)); }
    catch (e) { onStopped({ pid: survivor.pid, outcome: 'refused', detail: msg(e) }); }
    finally { setBusy(false); setAsking(false); }
  };
  return (
    <li className="proc-survivor">
      <div className="proc-survivor-line">
        <span className="mono proc-pid">pid {survivor.pid}</span>
        <code className="proc-command">{survivor.command}</code>
      </div>
      <div className="proc-survivor-facts">
        <span>{survivor.ports.length
          ? `listening on ${survivor.ports.map((p) => `${p.address}:${p.port}`).join(', ')}`
          : 'no listening TCP port'}</span>
        <span>{idleWords(survivor)}</span>
        <span>started {ago(survivor.startedAt)}</span>
        {!asking && (
          <button type="button" className="btn btn-sm btn-danger proc-stop" disabled={busy}
                  aria-label={`Stop pid ${survivor.pid}`} onClick={() => setAsking(true)}>
            Stop
          </button>
        )}
      </div>
      {asking && (
        <ConfirmNote tone="error" busy={busy} verb={busy ? 'Stopping…' : `Stop pid ${survivor.pid}`}
          onCancel={() => setAsking(false)} onRun={stop}
          what={<>Send SIGTERM to pid {survivor.pid}, then SIGKILL if it is still running after five seconds?
            Wanigan checks again, just before each signal, that this pid is still the process it recorded.</>} />
      )}
    </li>
  );
}

/**
 * The block both Fleet's inspector and a session's details render. `compact`
 * drops the section head for the Sessions controls drawer, which has its own.
 */
export default function SessionProcessesPanel({ session, compact }: { session: Session; compact?: boolean }) {
  const { reading, error, reload } = useSessionProcesses(session.id);
  const [result, setResult] = useState<StopSurvivorResult | null>(null);

  if (error && !reading) {
    return <div className="proc-panel"><Note tone="warn" role="none">Processes could not be read: {error}</Note></div>;
  }
  if (!reading) {
    return <div className="proc-panel"><p className="proc-reading">Reading the process table…</p></div>;
  }

  const sampled = reading.sampledAt ? `read from ps and lsof ${ago(reading.sampledAt)}` : 'not read yet';
  return (
    <div className="proc-panel" data-proc-session={session.id}>
      {!compact && <SectionHead label="Processes" right={<span className="proc-reading">{sampled}</span>} />}
      {reading.live ? (
        reading.tree ? (
          <div className="proc-tree">
            <div className="proc-figures">
              <span><strong>{num(reading.tree.processes)}</strong> process{reading.tree.processes === 1 ? '' : 'es'}</span>
              <span><strong>{reading.tree.cpuPercent.toFixed(1)}%</strong> CPU</span>
              <span><strong>{size(reading.tree.rssBytes)}</strong> memory</span>
            </div>
            {reading.ports.length ? (
              <ul className="proc-ports" aria-label="Listening ports">
                {reading.ports.map((p) => (
                  <li key={`${p.pid}-${p.address}-${p.port}`}>
                    <span className="mono">{p.address}:{p.port}</span>
                    <span className="proc-port-owner">pid {p.pid} · <code>{p.command}</code></span>
                  </li>
                ))}
              </ul>
            ) : <p className="proc-reading">No listening TCP port in this session&rsquo;s process tree.</p>}
          </div>
        ) : <p className="proc-reading">The agent process was not in the process table at the last reading.</p>
      ) : reading.survivors.length ? (
        <div className="proc-left">
          <Mark glyph="!" word={`Still running after the session ended · ${reading.survivors.length}`} tone="warn" />
          <ul className="proc-survivors">
            {reading.survivors.map((s) => (
              <SurvivorRow key={s.pid} sessionId={session.id} survivor={s}
                onStopped={(r) => { setResult(r); void reload(); }} />
            ))}
          </ul>
        </div>
      ) : (
        <p className="proc-reading">
          {reading.recorded
            ? `None of the ${num(reading.recorded)} process${reading.recorded === 1 ? '' : 'es'} recorded while this session ran is still running.`
            : 'No process of this session was recorded while it ran, so nothing can be listed as left running. Wanigan reads the process table while Fleet or Sessions is open.'}
        </p>
      )}
      {result && (
        <Note tone={result.outcome === 'terminated' || result.outcome === 'killed' || result.outcome === 'already-gone' ? 'ok' : 'warn'}
              onDismiss={() => setResult(null)}>
          pid {result.pid}: {result.detail}
        </Note>
      )}
      {reading.notes.map((note) => <p key={note} className="proc-reading">{note}</p>)}
      {compact && <p className="proc-reading">{sampled}.</p>}
    </div>
  );
}

/** Every ended session with something still running, closed tabs included. */
export function SurvivorsAcrossSessions({ sessions }: { sessions: Session[] }) {
  const [rows, setRows] = useState<Reading[]>([]);
  const [result, setResult] = useState<StopSurvivorResult | null>(null);
  const load = useCallback(async () => {
    try { setRows(await window.wanigan.processes.survivors()); } catch { /* unavailable here, e.g. the demo */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  if (!rows.length) return null;
  const nameOf = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    return s ? (s.displayTitle || s.title || s.projectName) : 'a closed session';
  };
  const total = rows.reduce((n, r) => n + r.survivors.length, 0);
  return (
    <section className="proc-across" aria-label="Still running after the session ended">
      <SectionHead label="Still running after the session ended" count={total} />
      {rows.map((r) => (
        <div key={r.sessionId} className="proc-across-session">
          <span className="proc-across-name">{nameOf(r.sessionId)}</span>
          <ul className="proc-survivors">
            {r.survivors.map((s) => (
              <SurvivorRow key={s.pid} sessionId={r.sessionId} survivor={s}
                onStopped={(res) => { setResult(res); void load(); }} />
            ))}
          </ul>
        </div>
      ))}
      {result && <Note tone="info" onDismiss={() => setResult(null)}>pid {result.pid}: {result.detail}</Note>}
    </section>
  );
}
