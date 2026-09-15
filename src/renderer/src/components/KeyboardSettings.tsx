import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chordTextFromEvent, effectiveKeymap, keymapGroups, type EffectiveBinding, type KeymapRefusal, type KeymapWrite } from '@shared/keymap';
import { applyKeymapState, chordLabels, setChordCapture, useKeymap } from '../bindings';
import { Mark, Note, Reading, Section, SectionHead } from './bits';
import '../styles/settings.css';

/**
 * Settings › App › Keyboard: every binding the cheat sheet lists, in the same
 * groups and order, with the chord in effect and what can be done about it.
 *
 * A row is one of two kinds, and says which in words. A rebindable row has
 * Change, which records the next chord pressed anywhere in the window, and
 * Reset once it has moved. A fixed row has no control at all, and the reason
 * printed under it — an arrow key that is how a list works, an Enter that
 * belongs to a text field, a chord the Sessions view still tests by hand.
 *
 * Nothing is decided here. The chord goes to main as text and main answers:
 * applied, with the new state, or refused, with a named reason that is printed
 * under the row that asked. The renderer's copy of the keymap only ever comes
 * from that answer, so this list, the sheet and the key handlers cannot show a
 * rebinding main did not store.
 */

type Outcome =
  | { tone: 'done'; text: string }
  | { tone: 'refused'; refusal: KeymapRefusal }
  | { tone: 'error'; text: string };

export default function KeyboardSettings() {
  const { map, state, read, error } = useKeymap();
  const groups = useMemo(() => keymapGroups(map), [map]);
  const [recording, setRecording] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, Outcome>>({});
  const [resetAllError, setResetAllError] = useState<string | null>(null);
  const changeButtons = useRef(new Map<string, HTMLButtonElement>());

  const returnFocus = useCallback((id: string) => {
    requestAnimationFrame(() => changeButtons.current.get(id)?.focus());
  }, []);

  const write = useCallback(async (id: string, name: string, run: () => Promise<KeymapWrite>) => {
    setBusy(id);
    try {
      const result = await run();
      applyKeymapState(result.state);
      // Read from the state main returned, not from the map this render holds,
      // which is the one from before the write.
      const now = chordLabels(effectiveKeymap(result.state.keymap), id).glyphs;
      const moved = result.state.keymap[id] !== undefined;
      setOutcomes((prev) => ({
        ...prev,
        [id]: result.applied
          ? { tone: 'done', text: moved ? `${name} is now ${now}.` : `${name} is back on ${now}.` }
          : { tone: 'refused', refusal: result.refusal },
      }));
    } catch (failure) {
      setOutcomes((prev) => ({ ...prev, [id]: { tone: 'error', text: failure instanceof Error ? failure.message : String(failure) } }));
    } finally {
      setBusy(null);
    }
  }, []);

  // While a row is recording, the next chord pressed anywhere in the window is
  // its answer. The listener takes the key in the capture phase and the root
  // flag stands every binding down, so ⌘T pressed to be recorded does not also
  // open New session. Escape on its own cancels and writes nothing.
  useEffect(() => {
    if (!recording) return;
    const id = recording;
    const name = map.byId.get(id)?.name ?? id;
    setChordCapture(true);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat) return;
      const text = chordTextFromEvent(e);
      if (text === null) return;  // a modifier held on its own: keep waiting
      setRecording(null);
      if (text === 'Escape') { returnFocus(id); return; }
      void write(id, name, () => window.wanigan.keymap.set(id, text)).then(() => returnFocus(id));
    };
    // Anything else the operator does ends the recording, so the shortcuts it
    // stood down come straight back rather than waiting on a forgotten row.
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && changeButtons.current.get(id)?.contains(e.target)) return;
      setRecording(null);
    };
    const onBlur = () => setRecording(null);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('blur', onBlur);
      setChordCapture(false);
    };
  }, [map, recording, returnFocus, write]);

  const anyStored = map.bindings.some((binding) => binding.rebound) || state.ignored.length > 0 || state.unreadable !== null;

  const resetAll = async () => {
    setBusy('*');
    setResetAllError(null);
    try {
      applyKeymapState(await window.wanigan.keymap.resetAll());
      setOutcomes({});
    } catch (failure) {
      setResetAllError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(null);
    }
  };

  // Chords the Sessions view prints in its own labels, which do not read the
  // keymap yet. Said here, where the change was made, rather than left for the
  // operator to find a button still showing the old chord.
  const sessionsLabels = [
    map.byId.get('new-session')?.rebound && `${map.byId.get('new-session')?.defaultKeys} on its New session button and in its status line`,
    (map.byId.get('session-prev')?.rebound || map.byId.get('session-next')?.rebound) && '⌥⌘←→ for switching sessions in its status line',
  ].filter(Boolean);

  return (
    <Section title="Keyboard"
             hint="Every shortcut, grouped the way the cheat sheet groups them. A change moves the key, the cheat sheet and the menu bar together."
             right={<button className="btn btn-sm" type="button" disabled={!anyStored || busy !== null} onClick={() => void resetAll()}>Reset all</button>}>
      <p className="set-caption set-keys-rules">
        A shortcut needs ⌘ or ⌃. Chords macOS or a text field already owns — ⌘Q, ⌘C, Enter — are refused, and so is a
        chord another shortcut holds, which is named so you can move that one first. Inside a terminal every key still
        belongs to the agent, whatever is set here.
      </p>
      {read === 'loading' && <Reading what="your keyboard shortcuts" />}
      {read === 'failed' && (
        <Note tone="error">
          Could not read your keyboard shortcuts: {error}. The keys are on their defaults, which is what this list shows
          until a read succeeds.
        </Note>
      )}
      {state.unreadable && <Note tone="warn">{state.unreadable}</Note>}
      {state.ignored.length > 0 && (
        <Note tone="warn">
          {state.ignored.length === 1 ? 'One stored shortcut was' : `${state.ignored.length} stored shortcuts were`} not
          applied, so {state.ignored.length === 1 ? 'that binding is' : 'those bindings are'} on the default:
          <ul className="set-keys-ignored">
            {state.ignored.map((entry) => (
              <li key={`${entry.id}:${entry.chord}`}>
                {map.byId.get(entry.id)?.name ?? (entry.id || 'The keymap')}: {entry.refusal.message}
              </li>
            ))}
          </ul>
        </Note>
      )}
      {sessionsLabels.length > 0 && (
        <Note tone="info" role="none">
          The keys follow your chords everywhere. The Sessions view’s own labels do not read the keymap yet, so it still
          prints {sessionsLabels.join(', and ')}.
        </Note>
      )}
      {resetAllError && <Note tone="error">Could not reset the shortcuts: {resetAllError}</Note>}
      {groups.map((group) => (
        <div className="set-keys-group" key={group.title} role="group" aria-label={group.title}>
          <SectionHead label={group.title} count={group.bindings.length} />
          <ul className="set-keys">
            {group.bindings.map((binding) => (
              <KeyRow key={binding.id} binding={binding} keys={chordLabels(map, binding.id).keys}
                      recording={recording === binding.id} outcome={outcomes[binding.id]}
                      buttonRef={(el) => { if (el) changeButtons.current.set(binding.id, el); else changeButtons.current.delete(binding.id); }}
                      onChange={() => {
                        setOutcomes((prev) => { const next = { ...prev }; delete next[binding.id]; return next; });
                        setRecording((current) => (current === binding.id ? null : binding.id));
                      }}
                      onReset={() => void write(binding.id, binding.name, () => window.wanigan.keymap.reset(binding.id))} />
            ))}
          </ul>
        </div>
      ))}
    </Section>
  );
}

function KeyRow({ binding, keys, recording, outcome, buttonRef, onChange, onReset }: {
  binding: EffectiveBinding;
  keys: string;
  recording: boolean;
  outcome: Outcome | undefined;
  buttonRef: (el: HTMLButtonElement | null) => void;
  onChange: () => void;
  onReset: () => void;
}) {
  const statusId = `set-keys-status-${binding.id.replace(/[^a-z0-9-]/gi, '-')}`;
  return (
    <li className="set-keys-row" data-binding={binding.id}>
      <div className="set-keys-what">
        <span className="set-keys-name">{binding.name}</span>
        {binding.does !== binding.name && !binding.id.startsWith('view:') && <span className="set-keys-does">{binding.does}</span>}
      </div>
      <div className="set-keys-chord">
        <kbd>{keys}</kbd>
        {binding.rebound && <Mark glyph="●" word="changed" tone="accent" />}
      </div>
      {binding.rebindable ? (
        <div className="set-keys-actions">
          <button ref={buttonRef} className={`btn btn-sm${recording ? ' btn-primary' : ''}`} type="button"
                  aria-pressed={recording}
                  aria-label={recording ? undefined : `Change the shortcut for ${binding.name}`}
                  aria-describedby={recording ? statusId : undefined}
                  onClick={onChange}>
            {recording ? 'Press the new chord…' : 'Change'}
          </button>
          {binding.rebound && (
            <button className="btn btn-sm" type="button"
                    aria-label={`Reset the shortcut for ${binding.name} to ${binding.defaultKeys}`}
                    onClick={onReset}>Reset</button>
          )}
        </div>
      ) : (
        <div className="set-keys-actions"><Mark glyph="—" word="fixed" tone="quiet" /></div>
      )}
      {!binding.rebindable && <p className="set-keys-note">{binding.fixedReason}</p>}
      {binding.rebound && <p className="set-keys-note">Default: {binding.defaultKeys}</p>}
      {recording && (
        <p className="set-keys-note set-keys-listening" id={statusId} role="status">
          Recording: press the chord for {binding.name}, holding ⌘ or ⌃. Escape cancels.
        </p>
      )}
      {outcome?.tone === 'refused' && (
        <p className="set-keys-refusal" role="alert"><span aria-hidden="true">✕ </span>Not changed. {outcome.refusal.message}</p>
      )}
      {outcome?.tone === 'error' && (
        <p className="set-keys-refusal" role="alert"><span aria-hidden="true">✕ </span>Could not save: {outcome.text}</p>
      )}
      {outcome?.tone === 'done' && <p className="set-keys-note" role="status"><span aria-hidden="true">✓ </span>{outcome.text}</p>}
    </li>
  );
}
