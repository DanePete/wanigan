import { useEffect, useRef, useState } from 'react';
import type { RelayRead } from '@shared/types';
import type { RelayDeliveryAttempt, RelayDeliveryKind, RelayDeliveryPreview, RelayDeliveryStage, RelayDeployConfig } from '@shared/relay-delivery';
import { Hint, Note, Pill, SectionHead, ago, dur } from '../components/bits';

type Act = (key: string, run: () => Promise<unknown>) => Promise<void>;
type ActionProps = {
  read: RelayRead; kind: RelayDeliveryKind; stage: RelayDeliveryStage;
  busy: string | null; unavailable: boolean; act: Act;
};

/** A preview is a short-lived main-process authorization for exactly the checkout shown. */
export function RelayDeliveryAction({ read, kind, stage, busy, unavailable, act }: ActionProps) {
  const [preview, setPreview] = useState<RelayDeliveryPreview | null>(null);
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  const messageEl = useRef<HTMLTextAreaElement>(null);
  const executeEl = useRef<HTMLButtonElement>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (preview) (messageEl.current ?? executeEl.current)?.focus();
  }, [preview]);
  const lastAttempt = stage.attempts[0]?.id;
  useEffect(() => { setPreview(null); }, [stage.status, lastAttempt, read.delivery?.config.updatedAt]);
  const disabled = busy !== null || unavailable;
  const approved = read.docket.status === 'accepted';
  const blocked = kind === 'commit' ? !approved : read.delivery?.commit.status !== 'completed' || !read.delivery.config.command.trim();
  const expired = preview !== null && preview.expiresAt <= Date.now();
  const prepare = () => act(`preview-${kind}`, async () => {
    setPreview(null);
    const next = await window.wanigan.relay.previewDelivery(read.docket.id, kind);
    if (alive.current) { setPreview(next); setMessage(next.message); }
  });
  const execute = () => act(kind, async () => {
    if (!preview) return;
    // Consume the local preview even when main refuses or records a failed
    // attempt. A retry always starts with a fresh checkout reading.
    setPreview(null);
    if (kind === 'commit') await window.wanigan.relay.commitDelivery(read.docket.id, { token: preview.token, message });
    else await window.wanigan.relay.deployDelivery(read.docket.id, { token: preview.token });
  });
  if (stage.status === 'running') return <>
    <h3>{kind === 'commit' ? 'Creating the commit.' : 'Deployment command is running.'}</h3>
    <p>{stage.detail || 'The recorded result will appear here when the command finishes.'}</p>
    {kind === 'deploy' && <button className="btn" disabled={disabled} onClick={() => void act('cancel-deploy', () => window.wanigan.relay.cancelDeploy(read.docket.id))}>Stop deployment command</button>}
    {kind === 'deploy' && <Hint>Stopping the command cannot undo changes it already made to the deployment target.</Hint>}
  </>;
  if (stage.status === 'completed') return <>
    <h3>{kind === 'commit' ? 'The commit is recorded.' : 'The deployment command completed.'}</h3>
    {stage.receipt?.commitHash && <p className="rl-delivery-hash">Commit <code>{stage.receipt.commitHash}</code></p>}
    <p>{kind === 'commit' ? 'Deployment is a separate action using the project’s saved command.' : 'The command exited successfully. Inspect its recorded output for the deployment result.'}</p>
  </>;
  return <>
    <h3>{kind === 'commit' ? 'Commit the reviewed work.' : 'Deploy the recorded commit.'}</h3>
    {stage.detail && <p>{stage.detail}</p>}
    {stage.status === 'failed' || stage.status === 'interrupted'
      ? <Note tone="warn">The last attempt {stage.status === 'interrupted' ? 'was interrupted' : 'failed'}. Inspect its recorded result, then prepare a new preview to retry.</Note>
      : null}
    {blocked && <Hint>{kind === 'commit' ? 'Complete verification and approve the review before creating a commit.'
      : read.delivery?.commit.status !== 'completed' ? 'Record the commit before deploying.' : 'Save a deployment command for this project in Deploy details below.'}</Hint>}
    {!preview && <button className="btn btn-primary" disabled={disabled || blocked} onClick={() => void prepare()}>
      {busy === `preview-${kind}` ? 'Reading checkout…' : stage.attempts.length ? `Preview ${kind === 'commit' ? 'commit' : 'deployment'} retry` : `Preview ${kind === 'commit' ? 'commit' : 'deployment'}`}
    </button>}
    {preview && <div className="rl-delivery-preview">
      <dl className="rl-facts">
        <div><dt>Checkout</dt><dd><code>{preview.checkout}</code></dd></div>
        <div><dt>{kind === 'commit' ? 'Current commit' : 'Deploy revision'}</dt><dd><code>{preview.head}</code></dd></div>
        {kind === 'deploy' && <><div><dt>Command</dt><dd><code>{preview.command}</code></dd></div><div><dt>Timeout</dt><dd>{dur(preview.timeoutMs)}</dd></div></>}
      </dl>
      {kind === 'commit' && <>
        {preview.existingCommit ? <p>The reviewed checkout is clean. Record its existing commit to continue.</p> : <>
          <p>These {preview.files.length} changed {preview.files.length === 1 ? 'file will' : 'files will'} be staged and included in the local commit.</p>
          <PathList files={preview.files} />
          <label><span className="label">Commit message</span><textarea ref={messageEl} className="field" aria-label="Relay commit message" rows={3} value={message} disabled={disabled} onChange={event => setMessage(event.target.value)} /></label>
        </>}
        {preview.trailers.length > 0 && <><span className="label">Attribution added to the commit</span><pre className="rl-delivery-output">{preview.trailers.join('\n')}</pre></>}
        <Hint>This action does not push to a remote.</Hint>
      </>}
      {kind === 'deploy' && <Hint>Runs this saved command in the checkout shown. Its actions depend on the command you configured.</Hint>}
      {expired && <Note tone="warn">This preview expired. Refresh it before continuing.</Note>}
      <div className="rl-actions">
        <button ref={executeEl} className="btn btn-primary" disabled={disabled || blocked || expired || (kind === 'commit' && !preview.existingCommit && !message.trim())} onClick={() => void execute()}>
          {busy === kind ? 'Starting…' : kind === 'commit' ? preview.existingCommit ? 'Record existing commit' : 'Stage files and commit' : 'Run deployment'}
        </button>
        <button className="btn" disabled={disabled} onClick={() => void prepare()}>Refresh preview</button>
      </div>
    </div>}
    {kind === 'commit' && approved && read.delivery?.commit.receipt?.status !== 'completed' && <div className="rl-decision">
      <button className="btn" disabled={disabled} onClick={() => void act('reopen-delivery-review', () => window.wanigan.relay.reopenDeliveryReview(read.docket.id))}>
        {busy === 'reopen-delivery-review' ? 'Reopening…' : 'Reopen verification and review'}
      </button>
      <Hint>Reopens both stages so you can record fresh checks and a new approval. Existing evidence is kept; no agent is started.</Hint>
    </div>}
  </>;
}

function PathList({ files }: { files: string[] }) {
  return <ul className="rl-delivery-paths">{files.map(file => <li key={file}><code>{file}</code></li>)}</ul>;
}

function DeploymentConfig({ docketId, config, busy, unavailable, act }: {
  docketId: string; config: RelayDeployConfig; busy: string | null; unavailable: boolean; act: Act;
}) {
  const [command, setCommand] = useState(config.command);
  const [seconds, setSeconds] = useState(String(config.timeoutMs / 1000));
  useEffect(() => { setCommand(config.command); setSeconds(String(config.timeoutMs / 1000)); }, [config.command, config.timeoutMs]);
  const timeout = Number(seconds);
  const dirty = command !== config.command || timeout * 1000 !== config.timeoutMs;
  const valid = command.trim().length > 0 && Number.isInteger(timeout) && timeout >= 1 && timeout <= 3600;
  const disabled = busy !== null || unavailable;
  return <details className="rl-evidence" open={!config.command}>
    <summary>{config.command ? 'Project deployment command' : 'Configure this project’s deployment command'}</summary>
    <div className="rl-delivery-config">
      <p className="dim">Saved for this project. Saving a command does not run it.</p>
      <label><span className="label">Deployment command</span><textarea className="field" aria-label="Project deployment command" rows={3} value={command} disabled={disabled} onChange={event => setCommand(event.target.value)} placeholder="npm run deploy" /></label>
      <label><span className="label">Timeout in seconds</span><input className="field" aria-label="Deployment timeout in seconds" type="number" min="1" max="3600" step="1" value={seconds} disabled={disabled} onChange={event => setSeconds(event.target.value)} /></label>
      {(!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) && <Hint>Use a whole number from 1 to 3,600 seconds.</Hint>}
      <button className="btn" disabled={disabled || !valid || !dirty} onClick={() => void act('save-deploy', () => window.wanigan.relay.saveDeployConfig(docketId, { command, timeoutMs: timeout * 1000 }))}>{busy === 'save-deploy' ? 'Saving…' : 'Save deployment command'}</button>
      {dirty && <Hint>Unsaved changes. Deployment uses the saved command shown in its preview.</Hint>}
    </div>
  </details>;
}

function AttemptReceipt({ attempt }: { attempt: RelayDeliveryAttempt }) {
  return <li>
    <details>
      <summary><Pill status={attempt.status} tone={attempt.status === 'completed' ? 'ok' : attempt.status === 'failed' || attempt.status === 'interrupted' ? 'bad' : 'quiet'} /> <span>{ago(attempt.startedAt)}</span></summary>
      <dl className="rl-facts">
        <div><dt>Started</dt><dd>{new Date(attempt.startedAt).toLocaleString()}</dd></div>
        <div><dt>Checkout</dt><dd><code>{attempt.checkout}</code></dd></div>
        <div><dt>Starting revision</dt><dd><code>{attempt.head}</code></dd></div>
        {attempt.commitHash && <div><dt>Commit</dt><dd><code>{attempt.commitHash}</code></dd></div>}
        {attempt.command && <div><dt>Command</dt><dd><code>{attempt.command}</code></dd></div>}
        {attempt.message && <div><dt>Message</dt><dd>{attempt.message}</dd></div>}
        {attempt.exitCode !== null && <div><dt>Exit code</dt><dd>{attempt.exitCode}</dd></div>}
        {attempt.endedAt !== null && <div><dt>Finished</dt><dd>{new Date(attempt.endedAt).toLocaleString()}</dd></div>}
      </dl>
      {attempt.files.length > 0 && <><span className="label">Recorded files</span><PathList files={attempt.files} /></>}
      {attempt.trailers.length > 0 && <><span className="label">Recorded attribution</span><pre className="rl-delivery-output">{attempt.trailers.join('\n')}</pre></>}
      {attempt.error && <Note tone="error" role="none">{attempt.error}</Note>}
      {attempt.output ? <pre className="rl-delivery-output" tabIndex={0} aria-label="Recorded command output">{attempt.output}</pre> : <Hint>No command output recorded.</Hint>}
    </details>
  </li>;
}

export function RelayDeliveryDetails({ read, kind, stage, busy, unavailable, act, back }: ActionProps & { back?: () => void }) {
  return <div className="rl-detail" aria-label={`${kind === 'commit' ? 'Commit' : 'Deploy'} stage details`}>
    <SectionHead label={`${kind === 'commit' ? 'Commit' : 'Deploy'} details`} right={back && <button className="btn btn-sm" onClick={back}>Back to current stage</button>} />
    <div className="rl-detail-content">
      <p className="rl-stage-instructions">{kind === 'commit' ? 'Create or record a local commit of the approved implementation checkout.' : 'Run the project’s saved command against the recorded commit. Each attempt keeps its command and result.'}</p>
      <dl className="rl-facts"><div><dt>Status</dt><dd>{stage.status}</dd></div>
        {stage.receipt?.commitHash && <div><dt>Recorded commit</dt><dd><code>{stage.receipt.commitHash}</code></dd></div>}
      </dl>
      {stage.detail && <Note role="none">{stage.detail}</Note>}
      {kind === 'deploy' && read.delivery && <DeploymentConfig docketId={read.docket.id} config={read.delivery.config} busy={busy} unavailable={unavailable || stage.status === 'running'} act={act} />}
      <details className="rl-evidence" open={stage.status === 'failed' || stage.status === 'interrupted'}>
        <summary>Recorded attempts ({stage.attempts.length})</summary>
        {stage.attempts.length ? <ol>{stage.attempts.map(attempt => <AttemptReceipt key={attempt.id} attempt={attempt} />)}</ol> : <p className="faint">No attempt has run for this stage.</p>}
      </details>
    </div>
  </div>;
}
