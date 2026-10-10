// Voice input's one control: a mic beside the box it belongs to. Pressed, it
// listens (water fill, a ring that follows the voice), shows the words heard so
// far above itself while the owner speaks, and puts each sentence in at the
// box's caret as ordinary, editable, undoable text once a pause ends it. ⌘⇧M
// (Ctrl+Shift+M) starts or stops it, and holding ⌘⇧H talks until the keys are
// let go: the chords reach the control of the box being typed in, or the one
// used last (lib/voice.ts).
//
// What the owner can act on is said beside it, in a popover: no model yet
// (download it, with its size and source), the microphone refused (how to allow
// it on this OS), no microphone, the engine failed (try again).
// Design: docs/design/2026-10-10-voice-input.md, "The control".
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { VOICE_HOLD, VOICE_TOGGLE } from '@shared/shortcuts';
import { VOICE_MODELS, modelBytes, modelPage, voiceModel, type VoiceModelState, type VoiceState } from '@shared/voice';
import {
  clearProblem, insertSpoken, markVoiceUsed, startListening, stopListening, useListening, useVoiceState, useVoiceTarget, voiceAct, voiceBridge,
  type ListenProblem, type VoiceBox,
} from '../lib/voice';
import { openSettingsSection } from '../shell/SettingsNav';
import { Popover } from './Popover';
import { Button, IconButton, KeyCaps, useToast } from './ui';
import '../styles/voice.css';

export { VOICE_HOLD, VOICE_TOGGLE };

const mb = (bytes: number): string => `${Math.round(bytes / 1_000_000)} MB`;

/** How to let Wanigan use the microphone, on this OS. */
export function allowMicWords(platform: string): string {
  if (platform === 'darwin') return 'Open System Settings › Privacy & Security › Microphone, turn Wanigan on, then try again.';
  if (platform === 'win32') return 'Open Settings › Privacy & security › Microphone, turn on Microphone access and “Let desktop apps access your microphone”, then try again. It may also be in use by another app.';
  return 'Check that a microphone is connected and chosen as the input in your sound settings. In a Flatpak or a Snap, allow Wanigan the microphone (a Snap’s audio-record interface), then try again.';
}

/** What a problem says, its title and its words. */
export function problemWords(p: ListenProblem, platform: string): { title: string; body: string } {
  switch (p.kind) {
    case 'denied': return { title: 'Wanigan can’t use the microphone', body: allowMicWords(platform) };
    case 'no-mic': return { title: 'No microphone was found', body: 'Connect one, or choose an input in your sound settings, then try again.' };
    case 'busy': return { title: 'The microphone could not start', body: 'Another app may be using it. Close that app, or choose another input in your sound settings, then try again.' };
    case 'engine': return { title: 'The speech engine stopped', body: p.message };
    case 'notice': return { title: 'Listening stopped', body: p.message };
    case 'no-model': return { title: 'Speak instead of typing', body: '' };
  }
}

/** Downloading a model: how far, and Stop. */
export function ModelProgress({ model, state }: { model: (typeof VOICE_MODELS)[number]; state: VoiceModelState }) {
  const d = state.download;
  if (d.state !== 'downloading') return null;
  const total = d.total || modelBytes(model);
  const pct = total ? Math.min(100, Math.round((d.done / total) * 100)) : 0;
  return (
    <div className="voice-progress" role="status">
      <div className="meter-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
      <span className="small faint">Downloading {model.label.toLowerCase()}: {mb(d.done)} of {mb(total)}</span>
      <Button size="s" tone="quiet" icon="stop" onClick={() => voiceAct((vb) => vb.cancel(model.id))}>Stop</Button>
    </div>
  );
}

/** The first-use prompt: the model, its size and its source, and Download. Nothing is downloaded before the click. */
export function ModelPrompt({ state, onReady }: { state: VoiceState; onReady?: () => void }) {
  const chosen = voiceModel(state.settings.model) ?? (VOICE_MODELS[0] as (typeof VOICE_MODELS)[number]);
  const ms = state.models.find((m) => m.id === chosen.id);
  const other = VOICE_MODELS.find((m) => m.id !== chosen.id);
  const d = ms?.download;
  if (ms?.ready) {
    return (
      <div className="voice-pop-body">
        <p className="small">The {chosen.label.toLowerCase()} model is ready. Press the mic, or <KeyCaps shortcut={VOICE_TOGGLE} />, and speak.</p>
        {onReady ? <Button size="s" tone="primary" icon="mic" onClick={onReady} data-autofocus>Start speaking</Button> : null}
      </div>
    );
  }
  return (
    <div className="voice-pop-body">
      <p className="small">
        Speech becomes text on this computer: the audio never leaves it. Voice input needs a speech model first, downloaded once
        and kept in Wanigan’s data.
      </p>
      <dl className="voice-facts small">
        <dt>Model</dt><dd>{chosen.label}: {chosen.name}, {mb(modelBytes(chosen))}</dd>
        <dt>From</dt><dd><a href={modelPage(chosen)} target="_blank" rel="noreferrer">Hugging Face, {chosen.repo}</a>, at a checked version</dd>
        <dt>Licence</dt><dd>{chosen.licence}</dd>
      </dl>
      {ms && d?.state === 'downloading' ? <ModelProgress model={chosen} state={ms} /> : (
        <>
          {d?.state === 'failed' ? <p className="small error-text" role="alert">{d.error}</p> : null}
          <div className="voice-pop-actions">
            <Button size="s" tone="primary" icon="pull" data-autofocus onClick={() => voiceAct((vb) => vb.download(chosen.id))}>
              {d?.state === 'failed' && d.done > 0 ? `Carry on (${mb(modelBytes(chosen) - d.done)} left)` : `Download (${mb(modelBytes(chosen))})`}
            </Button>
            <Button size="s" tone="quiet" onClick={() => openSettingsSection('set-voice')}>Settings</Button>
          </div>
          {other ? <p className="small faint">Or {other.label.toLowerCase()} ({other.name}, {mb(modelBytes(other))}) in Settings › Voice: {other.summary.toLowerCase()}</p> : null}
        </>
      )}
    </div>
  );
}

/** A problem's popover body: what happened, and what to do. */
export function ProblemBody({ problem, state, onRetry }: { problem: ListenProblem; state: VoiceState; onRetry: () => void }) {
  const toast = useToast();
  const words = problemWords(problem, state.platform);
  const openSettings = async (): Promise<void> => { if (!(await voiceBridge()?.openMicSettings())) toast('This system has no microphone settings page Wanigan can open.', 'error'); };
  return (
    <div className="voice-pop-body">
      <p className="small">{words.body}</p>
      <div className="voice-pop-actions">
        <Button size="s" tone="primary" icon="mic" data-autofocus onClick={onRetry}>Try again</Button>
        {problem.kind === 'denied' && state.micSettings ? (
          <Button size="s" icon="open" onClick={openSettings}>{state.platform === 'darwin' ? 'Open Microphone settings' : 'Open microphone privacy settings'}</Button>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The control, for one box. `target` is the box its words go into (a textarea, or an input: one line, no closing full
 * stop). Renders nothing where voice input cannot run (no voice bridge: the phone page, a sweep that does not stub it).
 */
export function VoiceInput({ target, label = 'Speak instead of typing', size = 'm', tipSide }: {
  target: RefObject<VoiceBox | null>;
  label?: string;
  size?: 's' | 'm';
  tipSide?: 'top' | 'right' | 'bottom';
}) {
  const owner = useMemo(() => Symbol('voice-input'), []);
  const state = useVoiceState();
  const { mine, problem } = useListening(owner);
  const wrap = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [said, setSaid] = useState('');
  const held = useRef(false);
  const available = !!voiceBridge();
  const ready = !!state?.models.find((m) => m.id === state.settings.model)?.ready;

  const write = (text: string): void => {
    const el = target.current;
    if (!el || !insertSpoken(el, text)) return;
    el.classList.remove('voice-settled');
    void el.offsetWidth;
    el.classList.add('voice-settled');
    setSaid(`Added: ${text}`);
  };
  const start = async (): Promise<void> => {
    markVoiceUsed(owner);
    if (!ready) { setOpen(true); return; }
    setOpen(false);
    setSaid('Listening.');
    await startListening(owner, write);
  };
  const stop = (): void => { void stopListening(owner, 'finish'); setSaid('Stopped listening.'); };
  const toggle = (): void => { if (mine) stop(); else void start(); };

  // A problem opens the popover beside the mic, where it says what to do.
  useEffect(() => { if (problem) setOpen(true); }, [problem]);
  // A box that goes away stops what it was listening for.
  useEffect(() => () => { void stopListening(owner, 'cancel'); clearProblem(owner); }, [owner]);

  useVoiceTarget(available ? {
    owner,
    box: () => target.current,
    rank: () => 1,
    shown: () => !!wrap.current && wrap.current.getClientRects().length > 0,
    toggle: () => { target.current?.focus(); toggle(); },
    hold: (down) => {
      if (down && !mine) { held.current = true; void start(); }
      else if (!down && held.current) { held.current = false; stop(); }
    },
  } : null);

  if (!available) return null;
  const listening = mine && mine.phase !== 'finishing';
  const words = problem && problem.kind !== 'no-model' && state ? problemWords(problem, state.platform) : null;
  const popTitle = words?.title ?? 'Speak instead of typing';
  const tip = mine?.phase === 'finishing' ? 'Writing the last words…' : listening ? 'Stop listening' : label;
  let body: ReactNode = null;
  if (state && problem && problem.kind !== 'no-model') body = <ProblemBody problem={problem} state={state} onRetry={() => { clearProblem(owner); void start(); }} />;
  else if (state) body = <ModelPrompt state={state} onReady={() => void start()} />;

  return (
    <span ref={wrap} className={`voice${listening ? ' listening' : ''}${mine?.speaking ? ' speaking' : ''}`}
      style={{ ['--voice-level' as string]: String(mine?.level ?? 0) }} data-voice={mine ? mine.phase : problem ? problem.kind : ready ? 'idle' : 'no-model'}>
      <IconButton icon="mic" size={size} label={tip} keys={VOICE_TOGGLE} pressed={!!mine} tipSide={tipSide} className="voice-mic" onClick={toggle} />
      {mine && (mine.volatile || mine.phase !== 'finishing') ? (
        <span className="voice-volatile" aria-hidden="true">
          <span className="voice-dot" />
          {mine.volatile ? <span className="voice-words">{mine.volatile}</span>
            : <span className="voice-words faint">{mine.phase === 'starting' ? 'Getting ready…' : 'Listening…'}</span>}
        </span>
      ) : null}
      <span className="visually-hidden" role="status" aria-live="polite">{said}</span>
      <Popover anchor={wrap} open={open && !!body} onClose={() => { setOpen(false); if (problem) clearProblem(owner); }} label={popTitle}
        side="top" align="end" width={340} className="voice-pop">
        <h3 className="voice-pop-title">{popTitle}</h3>
        {body}
      </Popover>
    </span>
  );
}
