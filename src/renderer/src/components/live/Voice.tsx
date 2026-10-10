// Voice, the live editor's tool (in the toolbar's voice slot, after Snap and
// Record): speaking instead of typing.
//
// - While a recording runs, it narrates: what the owner says goes into the
//   recording's step log as `said` steps, each at the moment its words began
//   (live.recordSay). Settings › Voice › "Narrate recordings" starts it with
//   every recording; otherwise this tool (or ⌘⇧M with nothing typed into)
//   starts it for this one. It stops with the recording; the sentence still
//   being said is written into the log while the recording is saved.
// - Otherwise it speaks into the live view's note box (the chosen part's, or a
//   snap's or a recording's explanation), as that box's own mic does; with no
//   box shown it says where one is.
// The words heard so far show in the status line: the page covers the canvas.
// Design: docs/design/2026-10-10-voice-input.md, "Narration for recordings".
import { useEffect, useMemo, useRef, useState } from 'react';
import { VOICE_TOGGLE } from '@shared/shortcuts';
import { liveBridge } from '../../lib/live';
import { startListening, stopListening, useListening, useVoiceState, useVoiceTarget, voiceBridge, voiceTargetNow, clearProblem } from '../../lib/voice';
import { Popover } from '../Popover';
import { StatusSlot } from '../StatusLine';
import { IconButton, KeyCaps } from '../ui';
import { ModelPrompt, ProblemBody, problemWords } from '../VoiceInput';
import type { Recorder } from './Record';
import '../../styles/voice.css';

export function LiveVoice({ rec }: { rec: Recorder }) {
  const owner = useMemo(() => Symbol('narration'), []);
  const state = useVoiceState();
  const { mine, any, problem } = useListening(owner);
  const wrap = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const ready = !!state?.models.find((m) => m.id === state.settings.model)?.ready;
  const narrateOn = !!state?.settings.narrate;

  const narrate = (text: string, at: number): void => { void liveBridge()?.recordSay(text, at); };
  const startNarrating = (): void => {
    if (!ready) { setOpen(true); return; }
    void startListening(owner, narrate);
  };

  // "Narrate recordings": from each recording's start to its stop. A recording that stops ends narration with it.
  useEffect(() => {
    if (rec.on && narrateOn && ready && !mine) void startListening(owner, narrate);
    if (!rec.on && mine) void stopListening(owner, 'finish');
  }, [rec.on, narrateOn, ready]);
  useEffect(() => () => { void stopListening(owner, 'finish'); }, [owner]);
  useEffect(() => { if (problem) setOpen(true); }, [problem]);

  const click = (): void => {
    if (rec.on) { if (mine) void stopListening(owner, 'finish'); else startNarrating(); return; }
    // Not recording: the live view's note box, as its own mic would.
    const box = voiceTargetNow({ exclude: owner, boxes: true });
    if (box) { (box.box() as HTMLElement | null)?.focus(); box.toggle(); return; }
    setOpen(true);
  };

  useVoiceTarget(voiceBridge() ? {
    owner,
    box: () => null,
    rank: () => (rec.on ? 2 : 0),
    shown: () => rec.on && !!wrap.current && wrap.current.getClientRects().length > 0,
    toggle: () => { if (mine) void stopListening(owner, 'finish'); else startNarrating(); },
    hold: (down) => { if (down && !mine) startNarrating(); else if (!down && mine && !narrateOn) void stopListening(owner, 'finish'); },
  } : null);

  if (!voiceBridge()) return null;
  const label = rec.on ? (mine ? 'Stop narrating' : 'Narrate this recording') : 'Speak a note';
  const pressed = rec.on ? !!mine : !!any;
  const title = problem && problem.kind !== 'no-model' && state ? problemWords(problem, state.platform).title : !ready ? 'Speak instead of typing' : 'Speak a note';
  return (
    <span ref={wrap} className={`voice${mine ? ' listening' : ''}${mine?.speaking ? ' speaking' : ''}`} style={{ ['--voice-level' as string]: String(mine?.level ?? 0) }}
      data-voice={mine ? `narrating-${mine.phase}` : 'idle'}>
      <IconButton icon="mic" label={label} keys={VOICE_TOGGLE} pressed={pressed} className="voice-mic" onClick={click}
        data-tip={rec.on ? (mine ? 'Narrating: what you say goes into the recording’s log' : 'Narrate: what you say goes into the recording’s log, at the moment you say it') : 'Speak into the note box'} />
      {mine ? (
        <StatusSlot>
          <span className="voice-narrating small" role="status">
            <span className="voice-dot" aria-hidden="true" />
            {mine.volatile ? <span className="voice-words">{mine.volatile}</span> : <span className="faint">{mine.phase === 'finishing' ? 'Writing the last words into the log…' : 'Narrating…'}</span>}
          </span>
        </StatusSlot>
      ) : null}
      <Popover anchor={wrap} open={open} onClose={() => { setOpen(false); clearProblem(owner); }} label={title} side="bottom" align="end" width={340} className="voice-pop">
        <h3 className="voice-pop-title">{title}</h3>
        {problem && problem.kind !== 'no-model' && state ? (
          <ProblemBody problem={problem} state={state} onRetry={() => { clearProblem(owner); setOpen(false); startNarrating(); }} />
        ) : state && !ready ? <ModelPrompt state={state} /> : (
          <div className="voice-pop-body">
            <p className="small">Choose a part on the page, then speak into its note box with the mic beside it, or <KeyCaps shortcut={VOICE_TOGGLE} /> while you type there.</p>
            <p className="small">Or Record, and narrate: what you say goes into the recording’s log, at the moment you say it.</p>
          </div>
        )}
      </Popover>
    </span>
  );
}
