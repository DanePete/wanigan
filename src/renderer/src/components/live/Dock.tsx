// The live view's tabs in the dock beneath the page: its notes, the problems
// the page reports, and the request behind it, beside the code editor. The
// dock is the code editor's drawer (editor/EditorDrawer.tsx), mounted once by
// the window; the live view adds its tabs to it while it is on screen and
// draws the one shown into it through a portal, so each stays part of the
// live view (its state, its keys, its toasts) while it sits under the page.
// What the dock shows, its height, its side and whether it is open are kept on
// this Mac with the drawer's own (editor/prefs.ts).
import { useEffect, useId, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { dockShows, setDockTabs, useDockHost, useEditor, type DockTab } from '../../editor/store';

export type LiveDockTab = 'notes' | 'problems' | 'request';

export function LiveDock({ tabs, children }: {
  tabs: readonly (DockTab & { id: LiveDockTab })[];
  /** What a tab shows, drawn only while the dock shows it. */
  children: (tab: LiveDockTab) => ReactNode;
}) {
  const owner = useId();
  const editor = useEditor();
  const host = useDockHost();
  // By what they say, not the array: a count changing relabels a tab; nothing else does.
  const said = tabs.map((t) => `${t.id}|${t.label}|${t.hint ?? ''}`).join('\n');
  useEffect(() => { setDockTabs(owner, tabs); }, [owner, said]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setDockTabs(owner, null), [owner]);
  const shows = dockShows(editor);
  const tab = editor.open && !editor.page ? tabs.find((t) => t.id === shows)?.id ?? null : null;
  if (!host || !tab) return null;
  return createPortal(<div className="live-docked" data-tab={tab}>{children(tab)}</div>, host);
}
