// Settings › Local models: models that run on this computer, through LM Studio,
// and any a running Ollama (or NVIDIA PAIR) offers. Optional: without them this
// says so and nothing else changes. A download is confirmed with its size first.
import { useState } from 'react';
import { RUNTIME_LABEL, formatBytes, type LocalModule, type LocalStatus } from '@shared/local-models';
import { attempt, call, useQuery } from '../lib/api';
import { PROVIDER_LABEL } from '../lib/format';
import { useHow } from '../lib/how';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from './How';
import { Badge, Button, Dialog, EmptyState, NotAnswering, useToast } from './ui';
import { SettingRow, SettingsGroup, SettingsPage } from '../views/SettingsPage';

export function LocalModelsSettings() {
  const toast = useToast();
  const status = useQuery('local.status', {}, ['local']);
  const [asking, setAsking] = useState<LocalModule | null>(null);
  const how = useHow('settings');
  const fail = (m: string): void => toast(m, 'error');
  const s = status.data;

  const start = async (): Promise<void> => {
    const next = await attempt(() => call('local.startServer', {}), fail);
    if (next) { status.reload(); toast(`LM Studio’s server is running on port ${next.lmstudio.server.port ?? '?'}.`, 'done'); }
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
    <SettingsPage id="set-local" title="Local models" tools={<HowButton onClick={how.show} />}>
      {status.error ? <NotAnswering error={status.error} onRetry={status.reload} /> : !s ? null : !s.lmstudio.installed ? (
        <>
          <EmptyState title="LM Studio is not installed" icon="local"
            action={<a className="btn btn-plain btn-m" href="https://lmstudio.ai" target="_blank" rel="noreferrer"><span>Get LM Studio</span></a>}>
            Get it from lmstudio.ai and open it once; Wanigan finds it then. Without it, Wanigan works exactly as it does, and nothing is downloaded.
          </EmptyState>
          <OtherRuntimes status={s} />
        </>
      ) : (
        <>
          <SettingsGroup title="LM Studio">
            <SettingRow label="Its server"
              hint={s.lmstudio.server.running ? `Server running on port ${s.lmstudio.server.port}` : 'Its server starts by itself when a session on a local model starts.'}
              control={s.lmstudio.server.running ? null : <Button size="s" icon="play" onClick={() => start()}>Start its server</Button>} />
          </SettingsGroup>
          <SettingsGroup title="Models Wanigan knows">
            {s.modules.map(({ module, downloaded, download }) => (
              <SettingRow key={module.id} className="local-module"
                label={(
                  <span className="local-name">
                    {module.label}
                    <Badge>with {PROVIDER_LABEL[module.agent]}</Badge>
                    <Badge tone={module.proven ? 'water' : 'neutral'}>{module.proven ? `Proven ${module.proven.on}` : 'Not yet proven'}</Badge>
                  </span>
                )}
                hint={`${module.summary}${module.proven ? ` ${module.proven.detail}` : ''}`}
                control={downloaded ? <Badge tone="green">On this computer</Badge>
                  : download?.state === 'downloading' ? <Button size="s" tone="quiet" icon="stop" onClick={() => stop(module)}>Stop</Button>
                    : <Button size="s" icon="pull" onClick={() => setAsking(module)}>{download?.state === 'failed' ? 'Carry on' : 'Get'} ({formatBytes(module.downloadBytes)})</Button>}>
                {download?.state === 'downloading' ? (
                  <div className="local-progress" role="status">
                    <div className="meter-bar" aria-hidden="true"><span style={{ width: `${Math.round((download.fraction ?? 0) * 100)}%` }} /></div>
                    <span className="setting-hint">{download.fraction !== null ? `${Math.round(download.fraction * 100)}%` : 'Starting…'}{download.detail ? ` · ${download.detail}` : ''}</span>
                  </div>
                ) : download?.state === 'failed' && !downloaded ? (
                  <p className="error-text small" role="status">{download.error}</p>
                ) : null}
              </SettingRow>
            ))}
          </SettingsGroup>
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
      {how.open ? <LocalModelsHow status={s ?? null} onClose={how.hide} /> : null}
    </SettingsPage>
  );
}

/** Models on this computer that no module describes: offered in the picker as not proven. */
function OtherRuntimes({ status }: { status: LocalStatus }) {
  const others = [...status.lmstudio.models.filter((m) => !m.module), ...status.ollama.models];
  return (
    <SettingsGroup title="Other models on this computer">
      {others.length ? others.map((m) => (
        <SettingRow key={`${m.runtime}/${m.id}`} label={<span className="mono">{m.id}</span>}
          hint={`${RUNTIME_LABEL[m.runtime]}${m.sizeBytes ? ` · ${formatBytes(m.sizeBytes)}` : ''} · not proven with an agent`} />
      )) : (
        <SettingRow hint={status.ollama.running ? 'Ollama is running with no models.' : 'Ollama is not running. If it (or NVIDIA PAIR) is, its models are offered too.'} />
      )}
    </SettingsGroup>
  );
}

/** How local models work, as a picture: every sentence is a rule the core enforces (core/local-models.ts). */
function LocalModelsHow({ status, onClose }: { status: LocalStatus | null; onClose: () => void }) {
  const onDisk = status ? status.lmstudio.models.length + status.ollama.models.length : null;
  return (
    <HowDialog place="settings" title="How local models work" onClose={onClose}
      intro={<><strong>An agent on a model that runs on this computer.</strong> Prompts and code go to it, not to a model provider, and no plan’s limits apply. It is optional: without LM Studio, nothing here changes anything.</>}
      side={(
        <>
          <HowNote title="Proven or not">
            <ul>
              <li><strong>Proven:</strong> a real turn with a tool call was read back on this pairing of model and agent.</li>
              <li><strong>Not yet proven:</strong> offered, and said so wherever you pick it.</li>
              <li>A model no module describes is offered as not proven with that agent.</li>
            </ul>
          </HowNote>
          <HowNote title="Reading the picture" tone="quiet">
            <ul>
              <li>Numbers are live from this computer. A missing number means LM Studio or Ollama has not answered.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Getting a model" actor="you">
        <HowBox actor="you" title="You choose Get" num={status ? howNum(status.modules.filter((m) => !m.downloaded).length, 'not downloaded yet', 'not downloaded yet') : null}>
          Its size is shown first. Wanigan checks there is room and keeps 10 GB of your disk free; Stop, and Get carries on where it stopped.
        </HowBox>
        <HowArrow />
        <HowBox actor="site" tag="LM Studio" title="LM Studio downloads it" num={howNum(onDisk, 'model here', 'models here')}>
          Into its own models folder, from its catalogue. A model a running Ollama or NVIDIA PAIR has is offered too.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="A session on it" actor="agents">
        <HowBox actor="you" title="New session, this model">
          Pick it under On this computer in New session, or make it a project’s default in the project’s settings. Resuming keeps it.
        </HowBox>
        <HowArrow />
        <HowBox actor="wanigan" title="Wanigan loads it" num={status ? (status.lmstudio.server.running ? `server on port ${status.lmstudio.server.port}` : 'server not running') : null}>
          It starts LM Studio’s server if it is not running, asks LM Studio whether the model fits in memory, and refuses to load one that will not.
        </HowBox>
        <HowArrow />
        <HowBox actor="agents" title="The agent talks to it">
          Claude Code is pointed at the local server for every model it might pick, with the account’s own sign-in kept out, and sends Anthropic no telemetry.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}
