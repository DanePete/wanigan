// Settings › Voice: the two speech models (each with its size, source, commit
// and licence; downloaded only on a click, removable), which one to use, the
// language, narration for recordings, the keys, and what the OS says of the
// microphone. Its own file: Settings › Voice, one of Settings' sections (views/SettingsView.tsx).
// Design: docs/design/2026-10-10-voice-input.md.
import { VOICE_HOLD, VOICE_TOGGLE } from '@shared/shortcuts';
import { VOICE_LANGUAGES, VOICE_MODELS, modelBytes, modelPage, type VoiceModelId } from '@shared/voice';
import { useVoiceState, voiceAct, voiceBridge } from '../lib/voice';
import { Select } from './Select';
import { Button, KeyCaps, Segmented, Toggle, useToast } from './ui';
import { ModelProgress, allowMicWords } from './VoiceInput';
import { SettingsPage } from '../views/SettingsPage';
import '../styles/voice.css';

const mb = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`;

const MIC_WORDS: Record<string, string> = {
  granted: 'Allowed.',
  'not-determined': 'Not asked yet: the system asks the first time you speak.',
  denied: 'Refused.',
  restricted: 'Blocked by this computer’s settings or policy.',
};

export function VoiceSettings() {
  const state = useVoiceState();
  const toast = useToast();
  if (!voiceBridge() || !state) return null;
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  const act = (fn: Parameters<typeof voiceAct>[0]): Promise<void> => voiceAct(fn).then(() => undefined, fail);
  const s = state.settings;
  const ready = (id: VoiceModelId): boolean => !!state.models.find((m) => m.id === id)?.ready;

  return (
    <SettingsPage id="set-voice" title="Voice">

      <div className="settings-row">
        <div className="settings-notify-head">
          <span className="settings-label">Model</span>
          <Segmented<VoiceModelId> label="Speech model" value={s.model}
            options={VOICE_MODELS.map((m) => ({ value: m.id, label: m.label, hint: `${m.name}, ${mb(modelBytes(m))}${ready(m.id) ? '' : ': not downloaded yet'}` }))}
            onChange={(model) => void act((vb) => vb.setSettings({ model }))} />
        </div>
      </div>
      <ul className="voice-models">
        {VOICE_MODELS.map((m) => {
          const ms = state.models.find((x) => x.id === m.id);
          const d = ms?.download;
          return (
            <li key={m.id} className="settings-row">
              <div className="voice-model-head">
                <span className="settings-label">{m.label}: {m.name}</span>
                {ms?.ready ? (
                  <>
                    <span className="faint small">On this computer, {mb(modelBytes(m))}</span>
                    <Button size="s" tone="quiet" icon="trash" onClick={() => act((vb) => vb.remove(m.id))}>Remove</Button>
                  </>
                ) : d?.state === 'downloading' ? null : (
                  <Button size="s" icon="pull" onClick={() => act((vb) => vb.download(m.id))}>
                    {d?.state === 'failed' && d.done > 0 ? `Carry on (${mb(modelBytes(m) - d.done)} left)` : `Download (${mb(modelBytes(m))})`}
                  </Button>
                )}
              </div>
              <p className="faint small">{m.summary}</p>
              <p className="faint small">
                From <a href={modelPage(m)} target="_blank" rel="noreferrer">Hugging Face, {m.repo}</a> at commit <span className="mono">{m.revision.slice(0, 10)}</span>,
                each file checked against its SHA-256. Licence {m.licence}.
              </p>
              {ms && d?.state === 'downloading' ? <ModelProgress model={m} state={ms} /> : null}
              {d?.state === 'failed' ? <p className="small error-text" role="alert">{d.error}</p> : null}
            </li>
          );
        })}
      </ul>

      <div className="settings-row">
        <div className="settings-line">
          <span className="settings-label">Language</span>
          <Select<string> label="Language you speak" size="s" value={s.language}
            options={[{ value: 'auto', label: 'Detect it' }, ...VOICE_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))]}
            onChange={(language) => void act((vb) => vb.setSettings({ language }))} />
        </div>
        <p className="faint small">Naming the language you speak makes the fast model more accurate: in testing, Portuguese went from 67% of characters wrong to 19%.</p>
      </div>

      <div className="settings-row">
        <Toggle checked={s.narrate} onChange={(narrate) => void act((vb) => vb.setSettings({ narrate }))} label="Narrate recordings"
          hint="While the live view records, what you say goes into its step log, each line at the moment you said it. The microphone is on only while it records; without this, the mic beside Record narrates one recording." />
      </div>

      <div className="settings-row">
        <div className="voice-keys small">
          <span><KeyCaps shortcut={VOICE_TOGGLE} /> starts or stops listening in the box you are typing in</span>
          <span><KeyCaps shortcut={VOICE_HOLD} /> held, listens until you let go</span>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-line">
          <span className="settings-label">Microphone</span>
          {state.mic === 'denied' && state.micSettings ? (
            <Button size="s" icon="open" onClick={() => void voiceBridge()?.openMicSettings().catch(fail)}>Open its settings</Button>
          ) : null}
        </div>
        <p className="faint small">{state.mic === 'unknown' ? 'This system does not say ahead of time; the mic says if it cannot listen.' : MIC_WORDS[state.mic]}{state.mic === 'denied' ? ` ${allowMicWords(state.platform)}` : ''}</p>
      </div>
      <p className="settings-foot">
        Speak instead of typing, in any box with a mic. Speech becomes text on this computer: the audio never leaves it, no model is called
        over the network, and nothing goes to an agent until you send it.
      </p>
    </SettingsPage>
  );
}
