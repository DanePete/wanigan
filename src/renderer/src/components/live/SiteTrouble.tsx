// Why the live view is not showing the site, over the stage: a site that is
// not running (and Start it, which runs ddev start on the owner's click), a
// certificate described as it states itself, or an address nothing answers.
// The words are decided in @shared/live-site (diagnose), the same ones a
// card's screenshots and the helper's save use.
import { useEffect, useId, useState } from 'react';
import type { LiveRunEvent, LiveStartResult, LiveStatus, LiveTrouble } from '@shared/live-site';
import { attempt, bridge, call, useQuery } from '../../lib/api';
import { Icon } from '../icons';
import { Button, useToast } from '../ui';

/** Whether a project's site runs (`live.siteStatus`): asked when the view opens, again on a failure, and after a start. */
export function useSiteStatus(projectId: string) {
  return useQuery('live.siteStatus', { projectId }, ['liveRun'], (_e, d) => {
    const run = d as LiveRunEvent;
    return run.projectId === projectId && run.done;
  });
}

/** A ddev start or restart going on for this project: its command and its lines so far, as the core sends them. */
function useRun(projectId: string, busy: LiveStatus['busy']): { command: string; lines: string[] } | null {
  const [run, setRun] = useState<{ command: string; lines: string[] } | null>(busy ? { command: busy.command, lines: busy.output } : null);
  useEffect(() => { if (busy) setRun((r) => r ?? { command: busy.command, lines: busy.output }); }, [busy]);
  useEffect(() => bridge().on((event, data) => {
    if (event !== 'liveRun') return;
    const e = data as LiveRunEvent;
    if (e.projectId !== projectId) return;
    if (e.done) { setRun(null); return; }
    setRun((r) => ({ command: e.command, lines: e.line ? [...(r?.command === e.command ? r.lines : []), e.line].slice(-40) : r?.lines ?? [] }));
  }), [projectId]);
  return run;
}

export function SiteTrouble({ trouble, status, projectId, onReload, onCheck, onStarted, onEdit }: {
  trouble: LiveTrouble;
  status: LiveStatus | null;
  projectId: string;
  onReload: () => void;
  /** Ask whatever runs the site again. */
  onCheck: () => void;
  /** ddev started (or restarted) the site: load the page again. */
  onStarted: () => void;
  onEdit: () => void;
}) {
  const toast = useToast();
  const titleId = useId();
  const going = useRun(projectId, status?.busy ?? null);
  const [failed, setFailed] = useState<LiveStartResult | null>(null);
  const calm = trouble.kind === 'not-running' || trouble.kind === 'starting' || trouble.kind === 'checking';
  const ddev = status?.run.tool === 'ddev';
  const folder = status?.run.folder ?? '';

  const start = async (): Promise<void> => {
    setFailed(null);
    const done = await attempt(() => call('live.start', { projectId, restart: trouble.action === 'restart' }), (m) => toast(m, 'error'));
    if (!done) return;
    if (done.ok) { onStarted(); return; }
    setFailed(done);
  };

  // Chromium's words sit after a line that ends by introducing them, or at the foot.
  const inline = trouble.lines.some((l) => l.endsWith(':'));
  return (
    <div className={`live-problem${calm ? ' live-problem-calm' : ''}`} role={calm ? 'status' : 'alert'} aria-labelledby={titleId}>
      <Icon name={calm ? 'pause' : 'alert'} size={18} />
      <div className="live-problem-body">
        <p className="live-problem-title" id={titleId}>{trouble.title}</p>
        {trouble.lines.map((line) => (
          <p key={line} className="small">
            {line}{line.endsWith(':') && trouble.chromium ? <>{' '}<span className="mono">{trouble.chromium}</span></> : null}
          </p>
        ))}
        {trouble.facts.length ? (
          <dl className="live-problem-facts small" aria-label="The certificate presented">
            {trouble.facts.map((f) => (
              <div key={f.label} className="live-problem-fact">
                <dt className="faint">{f.label}</dt>
                <dd className="mono">{f.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {trouble.steps.length && !going ? (
          <div className="live-problem-steps small">
            <p className="live-problem-subtitle">What to do</p>
            {trouble.steps.map((step) => <p key={step}>{step}</p>)}
          </div>
        ) : null}
        {going ? (
          <div className="live-run" aria-live="polite">
            <p className="small"><span className="mono">{going.command}</span> is running in <span className="mono">{folder}</span>…</p>
            {going.lines.length ? <pre className="live-run-output mono">{going.lines.slice(-4).join('\n')}</pre> : null}
          </div>
        ) : failed ? (
          <div className="live-run" role="alert">
            <p className="small"><span className="mono">{failed.command}</span> did not finish in <span className="mono">{failed.folder}</span>. ddev said:</p>
            <pre className="live-run-output mono">{failed.output.slice(-6).join('\n') || '(nothing)'}</pre>
          </div>
        ) : null}
        {trouble.chromium && !inline ? <p className="faint small">Chromium: <span className="mono">{trouble.chromium}</span></p> : null}
        <div className="live-problem-actions">
          {trouble.action && ddev ? (
            <Button size="s" tone="primary" icon="play" disabled={!!going} onClick={start}>
              {going ? 'Starting…' : trouble.action === 'start' ? 'Start it' : 'Restart it'}
            </Button>
          ) : null}
          <Button size="s" icon="refresh" tone={trouble.action ? 'plain' : 'primary'} onClick={onReload}>Reload</Button>
          {ddev ? <Button size="s" tone="quiet" disabled={!!going} onClick={onCheck}>Check again</Button> : null}
          <Button size="s" tone="quiet" onClick={onEdit}>Change the address</Button>
        </div>
      </div>
    </div>
  );
}
