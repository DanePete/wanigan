// The live view's tabs in the dock beneath the page: its notes, the problems
// the page reports, the request behind it and the page's own DevTools
// (DevTools.tsx), beside the code editor. The dock is the code editor's drawer
// (editor/EditorDrawer.tsx), mounted once by the window; the live view adds its
// tabs to it while it is on screen and draws the one shown into it through a
// portal, so each stays part of the live view (its state, its keys, its toasts)
// while it sits under the page.
//
// The tabs wait at the end of the frame's status line (DockTabs, drawn there by
// the live view through StatusSlot), open or closed: each opens the dock on
// itself, and closes it when it is the one shown. ⇧[ and ⇧] step through them,
// ⌘J is the code editor's, and DevTools has Chrome's own chord. What the dock
// shows, its height, its side and whether it is open are kept on this computer
// with the drawer's own (editor/prefs.ts).
import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CODE_TAB, dockShows, setDockTabs, toggleDock, useDockHost, useEditor, type DockTab } from '../../editor/store';
import { keyLabel } from '@shared/shortcuts';
import { bridge } from '../../lib/api';
import { toggleDevtoolsTab } from '../../lib/live-devtools';
import { Count, tipProps } from '../ui';

export type LiveDockTab = 'notes' | 'problems' | 'request' | 'devtools';

/** A tab as the live view gives it: its count and what that count means (news in water, failures in red). */
export type LiveDockItem = DockTab & { id: LiveDockTab; count?: number; tone?: 'water' | 'red' | 'sunk' };

export function LiveDock({ tabs, children }: {
  tabs: readonly LiveDockItem[];
  /** What a tab shows, drawn only while the dock shows it. */
  children: (tab: LiveDockTab) => ReactNode;
}) {
  const owner = useId();
  const editor = useEditor();
  const host = useDockHost();
  // By what they say, not the array: a tab coming or going relabels the dock; a count does not.
  const said = tabs.map((t) => `${t.id}|${t.label}|${t.hint ?? ''}`).join('\n');
  useEffect(() => { setDockTabs(owner, tabs.map(({ id, label, hint }) => ({ id, label, hint }))); }, [owner, said]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setDockTabs(owner, null), [owner]);
  const shows = dockShows(editor);
  const tab = editor.open && !editor.page ? tabs.find((t) => t.id === shows)?.id ?? null : null;
  if (!host || !tab) return null;
  return createPortal(<div className="live-docked" data-tab={tab}>{children(tab)}</div>, host);
}

/**
 * The dock's tabs, waiting in the status line: Code, then the live view's. Each is a toggle (pressed while the dock
 * shows it), with its count; the dock opens on it, or closes when it already shows it.
 */
export function DockTabs({ projectId, tabs, chord }: {
  projectId: string;
  tabs: readonly LiveDockItem[];
  /** The DevTools chord on this platform (⌥⌘I, Ctrl+Shift+I), as words and as aria-keyshortcuts. */
  chord: { text: string; aria: string };
}) {
  const editor = useEditor();
  const mac = bridge().platform === 'darwin';
  const shows = editor.open && !editor.page ? dockShows(editor) : null;
  const mine = editor.tabs.filter((t) => t.projectId === projectId);
  const unsaved = mine.filter((t) => editor.unsaved.has(t.key)).length;
  const all: (DockTab & { count?: number; tone?: LiveDockItem['tone'] })[] = [{ ...CODE_TAB, count: mine.length, tone: 'sunk' }, ...tabs];
  return (
    <div className="dock-tabs" role="group" aria-label="The dock beneath the page" data-tour="live-dock">
      {all.map((t) => {
        const on = shows === t.id;
        const counted = t.count ? `, ${t.count} ${t.id === 'notes' ? 'waiting' : t.id === 'problems' ? 'reported' : t.count === 1 ? 'file open' : 'files open'}` : '';
        const name = `${t.label}${counted}${t.id === CODE_TAB.id && unsaved ? `, ${unsaved} unsaved` : ''}`;
        const tip = t.id === CODE_TAB.id ? tipProps(`The code editor${on ? ': hide the dock' : ''}`, 'toggle-editor')
          : t.id === 'devtools' ? { 'data-tip': `${t.hint ?? t.label}${on ? ': hide the dock' : ''}`, 'data-tip-keys': chord.text, 'aria-keyshortcuts': chord.aria }
            : { 'data-tip': `${t.hint ?? t.label}${on ? ': hide the dock' : ''}` };
        return (
          <button key={t.id} type="button" className="btn btn-quiet btn-s dock-tab" aria-pressed={on} data-dock={t.id} aria-label={name} {...tip}
            onClick={() => (t.id === 'devtools' ? toggleDevtoolsTab() : toggleDock(t.id))}>
            <span>{t.label}</span>
            {t.count ? <Count n={t.count} tone={on ? 'sunk' : t.tone ?? 'sunk'} /> : null}
            {t.id === CODE_TAB.id && unsaved ? <span className="dock-tab-unsaved" aria-hidden="true" data-tip={`${unsaved} unsaved`} /> : null}
          </button>
        );
      })}
      <span className="visually-hidden">{`${keyLabel('Shift', mac)}${mac ? '' : '+'}[ and ${keyLabel('Shift', mac)}${mac ? '' : '+'}] step through the dock.`}</span>
    </div>
  );
}
