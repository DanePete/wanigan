// Record: a recording of the live view, and nothing else, with a step log, sent
// to an agent as key frames and words with the owner's explanation. The main
// process records (src/main/live-record.ts); this is what the window shows.
//
// - The bar's Record (⇧R) starts it; while it records, the button says Stop
//   with the time, the status line says Recording with the time and how to
//   stop, and the start and the stop are announced. Escape (not while typing)
//   or the control stops it; so do two minutes, leaving the live view, or the
//   view going away.
// - Stopped, the review is drawn in the stage where the page is (as Compare
//   is): the clip, saved as a video file for the owner (WebM), its key frames
//   (at most eight: each click, navigation and error), and the step log; where
//   it is kept, with a button to show it, and Delete.
// - Ask an agent opens the note composer (Notes.tsx) with the key frames
//   attached and the step log filled in as words the owner can change. Agents
//   get pictures and words, never the video, and the composer says so.
// Design: docs/design/2026-10-08-live-view.md, "Snap and Record".
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { LiveRecordState, LiveRecording } from '@shared/bridge';
import type { LiveComponent } from '@shared/live';
import { RECORDINGS_KEPT, clock, isErrorStep, length, recordContext, stepText, type PartNamer } from '@shared/live-record';
import { formatBytes } from '@shared/attachments';
import type { ProjectSummary } from '@shared/model';
import { keyLabel } from '@shared/shortcuts';
import { bridge } from '../../lib/api';
import { liveBridge, useCoversLive } from '../../lib/live';
import { isTyping } from '../../lib/live-goto';
import { Button, IconButton, useToast } from '../ui';
import { Icon } from '../icons';
import { NoteComposer, draftFor } from './Notes';
import '../../styles/live-snap.css';

const OFF: LiveRecordState = { on: false, projectId: null, startedAt: null, limitMs: 120_000, frames: 0, steps: 0, saving: false, done: null, error: null };

/**
 * The recorder as this project's live view sees it: recording or not, the seconds since it began (counted here, each
 * second), and starting and stopping it. A recording that ends (however it ends) and is saved opens its review once.
 */
export function useRecorder(projectId: string, onSaved: (r: LiveRecording) => void) {
  const live = liveBridge();
  const toast = useToast();
  const [state, setState] = useState<LiveRecordState>(OFF);
  const [now, setNow] = useState(Date.now());
  const saved = useRef(onSaved);
  saved.current = onSaved;
  const opened = useRef<string | null>(null);
  /** Recordings started here: only these open a review here. */
  const mine = useRef(false);
  useEffect(() => live?.onRecord((s) => {
    setState(s);
    if (s.error && mine.current && !s.on) toast(s.error, 'error');
    if (!s.on && !s.saving && s.done && s.done.projectId === projectId && mine.current && opened.current !== s.done.id) {
      opened.current = s.done.id;
      mine.current = false;
      saved.current(s.done);
    }
  }), [live, projectId, toast]);
  const on = state.on && state.projectId === projectId;
  useEffect(() => {
    if (!on) return undefined;
    const t = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(t);
  }, [on]);
  const start = useCallback(async (): Promise<void> => {
    if (!live) return;
    mine.current = true;
    const s = await live.recordStart();
    setState(s);
    setNow(Date.now());
    if (!s.on) { mine.current = false; toast(s.error ?? 'The view could not be recorded.', 'error'); }
  }, [live, toast]);
  const stop = useCallback(async (): Promise<void> => { await live?.recordStop(); }, [live]);
  const elapsed = on && state.startedAt ? Math.max(0, Math.min(state.limitMs, now - state.startedAt)) : 0;
  return { state, on, saving: state.saving && state.projectId === projectId, elapsed, start, stop, toggle: () => (on ? stop() : start()) };
}

export type Recorder = ReturnType<typeof useRecorder>;

/** Escape stops a recording: in the window while nothing is typed into and nothing is open over it (the page's Escape is the page script's). */
export function useRecordEscape(rec: Recorder, blocked: boolean): void {
  const stop = rec.stop;
  useEffect(() => {
    if (!rec.on || blocked) return undefined;
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing || document.querySelector('[aria-modal="true"], .sel-list, [role="menu"]')) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && isTyping(t)) return;
      e.preventDefault();
      e.stopPropagation();
      void stop();
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [rec.on, blocked, stop]);
}

/**
 * The bar's Record: an icon that starts it (⇧R), its name its accessible name and tooltip; while recording it is Stop
 * with the time, pressed, in words, always in sight.
 */
export function RecordButton({ rec, disabled }: { rec: Recorder; disabled: boolean }) {
  const mac = bridge().platform === 'darwin';
  const key = `${keyLabel('Shift', mac)}${mac ? '' : '+'}R`;
  if (rec.saving) {
    return (
      <Button size="s" tone="quiet" icon="record" disabled aria-label="Saving the recording…" className="live-record-btn saving">
        <span className="live-record-word">Saving…</span>
      </Button>
    );
  }
  if (!rec.on) {
    return (
      <IconButton icon="record" onClick={() => void rec.toggle()} disabled={disabled} aria-keyshortcuts="Shift+R" aria-pressed={false} className="btn btn-quiet btn-icon live-record-btn"
        label={`Record (${key})`} title={`Record: the live view, and only it, for up to ${length(rec.state.limitMs)}, with a log of each step (${key})`} />
    );
  }
  return (
    <Button size="s" tone="primary" icon="stop" className="live-record-btn on" onClick={() => void rec.stop()} aria-keyshortcuts="Shift+R" aria-pressed
      aria-label={`Stop recording, ${length(rec.elapsed)} of ${length(rec.state.limitMs)} (${key} or Escape)`} title={`Recording the live view: ${key} or Escape stops it`}>
      <span className="live-record-word">Stop <time className="live-record-time">{length(rec.elapsed)}</time></span>
    </Button>
  );
}

/** Said once each, to a screen reader: the recording began, stopped, was saved. */
export function RecordAnnounce({ rec }: { rec: Recorder }) {
  const [said, setSaid] = useState('');
  const was = useRef({ on: rec.on, saving: rec.saving });
  useEffect(() => {
    const before = was.current;
    if (rec.on && !before.on) setSaid('Recording the live view. Escape or Shift R stops it.');
    else if (!rec.on && before.on) setSaid('Recording stopped. Saving it…');
    else if (!rec.saving && before.saving) setSaid('The recording is saved.');
    was.current = { on: rec.on, saving: rec.saving };
  }, [rec.on, rec.saving]);
  return <div className="visually-hidden" role="status" aria-live="assertive">{said}</div>;
}

const revealLabel = (platform: string): string => (platform === 'darwin' ? 'Show in Finder' : platform === 'win32' ? 'Show in File Explorer' : 'Show in its folder');

/** A stopped recording: its clip, key frames and step log, where it is kept, and asking an agent about it. */
export function RecordReview({ project, recording, partName, components, prefer, onClose }: {
  project: ProjectSummary;
  recording: LiveRecording;
  partName: PartNamer;
  components: Map<string, LiveComponent>;
  prefer: string | null;
  onClose: () => void;
}) {
  const live = liveBridge();
  const toast = useToast();
  const titleId = useId();
  const platform = bridge().platform;
  const mac = platform === 'darwin';
  useCoversLive(true);
  const [clip, setClip] = useState<string | null>(null);
  const [frames, setFrames] = useState<(string | null)[]>([]);
  const [composing, setComposing] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  const r = recording;

  useEffect(() => {
    if (!live) return undefined;
    let current = true;
    let url: string | null = null;
    void Promise.all(r.keyFrames.map((k) => live.recordFile(r.projectId, r.id, `frame-${k.n}`))).then((all) => { if (current) setFrames(all); });
    if (r.clip) {
      void live.recordFile(r.projectId, r.id, 'clip').then((b64) => {
        if (!current || !b64) return;
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        url = URL.createObjectURL(new Blob([bytes], { type: 'video/webm' }));
        setClip(url);
      });
    }
    return () => { current = false; if (url) URL.revokeObjectURL(url); };
  }, [live, r]);

  const seek = (at: number): void => {
    const v = video.current;
    if (!v) return;
    v.currentTime = Math.max(0, at / 1000);
    v.pause();
  };
  const context = useMemo(() => recordContext({ url: r.url, viewWidth: r.viewWidth, ms: r.ms, steps: r.steps, keyFrames: r.keyFrames, cut: r.cut, partName }), [r, partName]);
  const sent = frames.filter((f): f is string => !!f);

  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || document.querySelector('[aria-modal="true"], .sel-list')) return;
      const t = e.target instanceof Element ? e.target : null;
      if (t && t !== document.body && !t.closest('.live-stage-snap, .live')) return;
      const typing = !!t && isTyping(t);
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (e.key === 'Escape' && !typing) { e.preventDefault(); e.stopPropagation(); if (composing) setComposing(false); else close.current(); return; }
      if (composing || typing || e.altKey) return;
      if (mod && !e.shiftKey && e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); setComposing(true); return; }
      if (mod && !e.shiftKey && e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); void actions.current.remove(); return; }
      if (!mod && !e.shiftKey && !e.metaKey && !e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); e.stopPropagation(); void actions.current.reveal(); }
    };
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [composing, mac]);

  const reveal = async (): Promise<void> => { if (!(await live?.recordReveal(r.projectId, r.id))) toast('That recording is no longer there.', 'error'); };
  const remove = async (): Promise<void> => {
    if (!(await live?.recordDelete(r.projectId, r.id))) { toast('That recording could not be deleted.', 'error'); return; }
    toast('Deleted the recording: its clip, key frames and log.');
    onClose();
  };
  const actions = useRef({ reveal, remove });
  actions.current = { reveal, remove };
  const chord = (...k: string[]): string => k.map((x) => keyLabel(x, mac)).join(mac ? '' : '+');
  const why = r.stopped === 'limit' ? `It stopped at ${length(r.ms)}, the longest a recording runs.`
    : r.stopped === 'view' ? 'It stopped when the live view went away.' : r.stopped === 'escape' ? 'Escape on the page stopped it.' : null;

  return (
    <section className="live-stage-snap live-record-review" aria-labelledby={titleId}>
      <div className="live-snap-head">
        <h2 className="live-snap-title" id={titleId}><Icon name="record" size={16} /> Recording, {length(r.ms)}</h2>
        <span className="small faint live-snap-path mono" title={r.url}>{r.url}</span>
        <span className="live-snap-spacer" />
        {composing ? <Button size="s" tone="quiet" icon="back" onClick={() => setComposing(false)} aria-keyshortcuts="Escape">Back</Button> : (
          <Button size="s" tone="primary" icon="send" onClick={() => setComposing(true)} aria-keyshortcuts={mac ? 'Meta+Enter' : 'Control+Enter'}
            title={`Send the key frames and the step log, with what you say (${chord('Mod', 'Enter')})`}>
            Ask an agent <kbd className="live-key" aria-hidden="true">{chord('Mod', 'Enter')}</kbd>
          </Button>
        )}
        <IconButton icon="close" label="Close the recording (Escape)" onClick={onClose} />
      </div>
      {composing ? (
        <div className="live-snap-compose">
          <ol className="live-record-frames compact" aria-label="Key frames attached, in order">
            {r.keyFrames.map((k, i) => (
              <li key={k.n}>{frames[i] ? <img src={`data:image/jpeg;base64,${frames[i]}`} alt={`Key frame ${k.n}, at ${clock(k.at)}: ${k.why}`} /> : null}</li>
            ))}
          </ol>
          <NoteComposer project={project} components={components} prefer={prefer} draft={draftFor(r.url, { regions: [], pick: null })}
            with={{
              kind: 'recording', frames: sent, context,
              notice: <>The agent gets the {sent.length} key {sent.length === 1 ? 'frame' : 'frames'} as pictures and the step log as words. <strong>Agents don’t receive video</strong>: the clip stays in Wanigan’s data on this computer.</>,
            }}
            onDone={onClose} />
        </div>
      ) : (
        <div className="live-record-body">
          <div className="live-record-clip">
            {r.clip ? (
              clip ? <video ref={video} src={clip} controls preload="auto" aria-label={`The clip, ${length(r.ms)}`} />
                : <div className="live-snap-wait small faint" role="status">Loading the clip…</div>
            ) : <p className="small live-note" role="note">No clip: {r.clipWhy ?? 'none was made.'} The key frames and the step log are kept.</p>}
            <ol className="live-record-frames" aria-label="Key frames: each click, navigation and error (at most eight)">
              {r.keyFrames.map((k, i) => (
                <li key={k.n}>
                  <button type="button" className="live-record-frame" onClick={() => seek(k.at)} aria-label={`Key frame ${k.n}, at ${clock(k.at)}: ${k.why}. Show it in the clip`}>
                    {frames[i] ? <img src={`data:image/jpeg;base64,${frames[i]}`} alt="" /> : <span className="live-shot-wait faint small">…</span>}
                    <span className="small"><span className="mono">{clock(k.at)}</span> {k.why}</span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
          <div className="live-record-log">
            <h3 className="live-section-title">Steps</h3>
            {r.steps.length ? (
              <ol className="live-record-steps" aria-label="The step log">
                {r.steps.map((s, i) => (
                  <li key={i} data-type={s.type} data-error={isErrorStep(s) ? '' : undefined}>
                    <button type="button" onClick={() => seek(s.at)} aria-label={`${clock(s.at)}: ${stepText(s, partName)}. Show it in the clip`}>
                      <span className="mono small faint">{clock(s.at)}</span>
                      <span className="small">{stepText(s, partName)}</span>
                    </button>
                  </li>
                ))}
              </ol>
            ) : <p className="small faint">Nothing was clicked, typed, loaded or reported while it recorded.</p>}
            {r.cut ? <p className="small faint">The log stopped at its limit.</p> : null}
            <div className="live-record-kept small">
              <p>
                {why ? <>{why} </> : null}
                Kept in Wanigan’s own data on this computer, never in the site: <span className="mono">{r.folder}</span>
                {r.clip ? <>, the clip a WebM video of {formatBytes(r.clip.bytes)}</> : null}. A project keeps its last {RECORDINGS_KEPT} recordings; a file is held to 20 MB, as attachments are.
              </p>
              <div className="live-record-kept-actions">
                <Button size="s" tone="quiet" icon="folder" onClick={() => void reveal()} aria-keyshortcuts="O" title={`${revealLabel(platform)} (O)`}>{revealLabel(platform)}</Button>
                <Button size="s" tone="quiet" icon="trash" onClick={() => void remove()} aria-keyshortcuts={mac ? 'Meta+Backspace' : 'Control+Backspace'}
                  title={`Delete the clip, its key frames and its log (${chord('Mod', 'Backspace')})`}>Delete</Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
