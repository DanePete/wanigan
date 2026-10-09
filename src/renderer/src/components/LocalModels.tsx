// Settings › Local models: models that run on this Mac, through LM Studio, and
// any a running Ollama (or NVIDIA PAIR) offers. Optional: without them this says
// so and nothing else changes. A download is confirmed with its size first.
import { useState } from 'react';
import { RUNTIME_LABEL, formatBytes, type LocalModule, type LocalStatus } from '@shared/local-models';
import { attempt, call, useQuery } from '../lib/api';
import { PROVIDER_LABEL } from '../lib/format';
import { Button, Dialog, useToast } from './ui';

export function LocalModelsSettings() {
  const toast = useToast();
  const status = useQuery('local.status', {}, ['local']);
  const [asking, setAsking] = useState<LocalModule | null>(null);
  const fail = (m: string): void => toast(m, 'error');
  const s = status.data;

  const start = async (): Promise<void> => {
    const next = await attempt(() => call('local.startServer', {}), fail);
    if (next) status.reload();
  };
  const get = async (module: LocalModule): Promise<void> => {
    setAsking(null);
    const next = await attempt(() => call('local.download', { module: module.id }), fail);
    if (next) status.reload();
  };
  const stop = async (module: LocalModule): Promise<void> => {
    await attempt(() => call('local.cancel', { module: module.id }), fail);
    status.reload();
  };

  return (
    <section className="settings-group" aria-labelledby="set-local">
      <header className="account-group-head">
        <h2 id="set-local">Local models</h2>
      </header>
      <p className="lede">
        Run Claude Code on a model that lives on this Mac: prompts and code go to it, not to a model provider, and no plan’s limits apply.
        It is optional. Without LM Studio, Wanigan works exactly as it does, and nothing is downloaded until you choose to.
      </p>

      {!s ? null : !s.lmstudio.installed ? (
        <div className="settings-row">
          <p>
            <span className="settings-label">LM Studio is not installed.</span>{' '}
            <span className="faint">Get it from <a href="https://lmstudio.ai" target="_blank" rel="noreferrer">lmstudio.ai</a>, open it once, then come back here.</span>
          </p>
          <OtherRuntimes status={s} />
        </div>
      ) : (
        <>
          <div className="settings-row">
            <div className="settings-line">
              <span className="settings-label">LM Studio</span>
              {s.lmstudio.server.running
                ? <span className="faint small">Server running on port {s.lmstudio.server.port}</span>
                : <Button size="s" icon="play" onClick={() => start()}>Start its server</Button>}
            </div>
            {!s.lmstudio.server.running ? <p className="faint small">Its server starts by itself when a session on a local model starts.</p> : null}
          </div>
          <ul className="local-modules">
            {s.modules.map(({ module, downloaded, download }) => (
              <li key={module.id} className="settings-row local-module">
                <div className="settings-line">
                  <span>
                    <span className="settings-label">{module.label}</span>{' '}
                    <span className="tag">with {PROVIDER_LABEL[module.agent]}</span>{' '}
                    <span className={`tag${module.proven ? ' proven' : ''}`}>{module.proven ? `Proven ${module.proven.on}` : 'Not yet proven'}</span>
                  </span>
                  {downloaded ? <span className="faint small">On this Mac</span>
                    : download?.state === 'downloading' ? <Button size="s" tone="quiet" icon="stop" onClick={() => stop(module)}>Stop</Button>
                      : <Button size="s" icon="pull" onClick={() => setAsking(module)}>{download?.state === 'failed' ? 'Carry on' : 'Get'} ({formatBytes(module.downloadBytes)})</Button>}
                </div>
                <p className="faint small">{module.summary}{module.proven ? ` ${module.proven.detail}` : ''}</p>
                {download?.state === 'downloading' ? (
                  <div className="local-progress" role="status">
                    <div className="meter-bar" aria-hidden="true"><span style={{ width: `${Math.round((download.fraction ?? 0) * 100)}%` }} /></div>
                    <span className="faint small">{download.fraction !== null ? `${Math.round(download.fraction * 100)}%` : 'Starting…'}{download.detail ? ` · ${download.detail}` : ''}</span>
                  </div>
                ) : download?.state === 'failed' && !downloaded ? (
                  <p className="small" role="status">{download.error}</p>
                ) : null}
              </li>
            ))}
          </ul>
          <OtherRuntimes status={s} />
        </>
      )}

      {asking ? (
        <Dialog
          title={`Download ${asking.label}?`}
          onClose={() => setAsking(null)}
          footer={<><Button tone="quiet" onClick={() => setAsking(null)}>Cancel</Button><Button tone="primary" icon="pull" data-autofocus onClick={() => get(asking)}>Download {formatBytes(asking.downloadBytes)}</Button></>}
        >
          <p>
            LM Studio downloads <span className="mono">{asking.key}</span> ({asking.format.toUpperCase()}), <strong>{formatBytes(asking.downloadBytes)}</strong>,
            from its catalogue on Hugging Face, into <span className="mono">~/.lmstudio/models</span>.
          </p>
          <p className="faint small">
            Wanigan checks there is room first and keeps 10 GB of your disk free. You can stop it at any time; Get carries on from where it stopped.
            Remove a model in LM Studio itself.
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}

/** Models on this Mac that no module describes: offered in the picker as not proven. */
function OtherRuntimes({ status }: { status: LocalStatus }) {
  const others = [...status.lmstudio.models.filter((m) => !m.module), ...status.ollama.models];
  if (!others.length && !status.ollama.running) return <p className="faint small">Ollama is not running. If it (or NVIDIA PAIR) is, its models are offered too.</p>;
  return (
    <div className="settings-row">
      <span className="settings-label">Other models on this Mac</span>
      {others.length ? (
        <ul className="local-others">
          {others.map((m) => (
            <li key={`${m.runtime}/${m.id}`}>
              <span className="mono">{m.id}</span>{' '}
              <span className="faint small">{RUNTIME_LABEL[m.runtime]}{m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : ''} · not proven with an agent</span>
            </li>
          ))}
        </ul>
      ) : <p className="faint small">Ollama is running with no models.</p>}
    </div>
  );
}
