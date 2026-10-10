// The dock's DevTools tab: the page's own Chromium DevTools (Elements with its
// own picker, Console, Network, Sources, Application, Performance), drawn by
// the main process in a view of its own laid over this tab's area
// (src/main/live-devtools.ts) and following it as the window, the dock's
// height and its side change. A native view draws above the window, so
// anything over the tab (a dialog, a menu) steps it aside and its last picture
// stands in, as the page's does. In a window of its own (a second screen) the
// tab says so and brings it back on request. Under it, once: what of the page's
// HTML is Wanigan's own while the live view is on.
//
// Hiding the tab keeps DevTools as it was; leaving the project closes it.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { LiveBounds } from '@shared/bridge';
import type { ProjectSummary } from '@shared/model';
import { bridge } from '../../lib/api';
import { liveBridge, useLiveCovered } from '../../lib/live';
import { devtoolsChord, inProject, setDevtoolsMode, takeFocusWish, useDevtoolsMode } from '../../lib/live-devtools';
import { setEditorOpen } from '../../editor/store';
import { Button } from '../ui';

export function DevtoolsTab({ project, keyed }: {
  project: ProjectSummary;
  /** The helper's key rides on the page's own loads (a local site with the helper): DevTools' Network panel shows it. */
  keyed: boolean;
}) {
  const live = liveBridge();
  const host = useRef<HTMLDivElement>(null);
  const covered = useLiveCovered();
  const mode = useDevtoolsMode();
  const [frame, setFrame] = useState<string | null>(null);
  const mac = bridge().platform === 'darwin';
  const chord = devtoolsChord(mac);

  const rect = (): LiveBounds | null => {
    const el = host.current;
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  };
  const show = (focus = false): void => {
    const r = rect();
    if (live && r) void live.devtoolsShow(r, focus).then(setDevtoolsMode);
  };

  // Where the tab is, as it moves: the window resized, the dock's edge dragged, the dock moved beside the page.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el || !live) return undefined;
    let raf = 0;
    const moved = (): void => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { const r = rect(); if (r) live.devtoolsBounds(r); });
    };
    const observer = new ResizeObserver(moved);
    observer.observe(el);
    window.addEventListener('resize', moved);
    return () => { cancelAnimationFrame(raf); observer.disconnect(); window.removeEventListener('resize', moved); };
  }, [live]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shown, unless something is over it: then it steps aside and its last picture stands in.
  useEffect(() => {
    if (!live) return undefined;
    let current = true;
    if (covered) void live.devtoolsHide(true).then((f) => { if (current) setFrame(f); });
    else { setFrame(null); show(takeFocusWish()); }
    return () => { current = false; };
  }, [covered, live]); // eslint-disable-line react-hooks/exhaustive-deps

  // The tab hidden (another tab, the dock closed, another view of the project) keeps DevTools; leaving the project closes it.
  useEffect(() => () => {
    if (!live) return;
    if (inProject(project.key)) void live.devtoolsHide(false); else void live.devtoolsClose();
  }, [live, project.key]);

  const detach = async (): Promise<void> => {
    if (!live) return;
    setDevtoolsMode((await live.devtoolsDetach()) ? 'detached' : 'closed');
  };
  const dockAgain = async (): Promise<void> => {
    if (!live) return;
    await live.devtoolsClose();
    show(true);
  };
  const closeIt = async (): Promise<void> => {
    if (!live) return;
    await live.devtoolsClose();
    setEditorOpen(false);
  };

  return (
    <div className="live-devtools">
      <div className="live-devtools-host" ref={host} data-mode={mode}>
        {frame ? <img className="live-devtools-frame" src={frame} alt="" /> : null}
        {mode === 'detached' ? (
          <div className="live-devtools-away">
            <p className="small">DevTools is in its own window.</p>
            <div className="live-actions">
              <Button size="s" icon="dockBottom" onClick={dockAgain}>Back into the dock</Button>
              <Button size="s" tone="quiet" icon="close" onClick={closeIt}>Close DevTools</Button>
            </div>
          </div>
        ) : mode === 'closed' && !frame ? (
          <div className="live-devtools-away">
            <p className="faint small">DevTools is closed.</p>
            <div className="live-actions"><Button size="s" icon="devtools" onClick={() => show(true)}>Open DevTools</Button></div>
          </div>
        ) : !frame ? <p className="live-devtools-wait faint small" aria-hidden="true">Opening DevTools…</p> : null}
      </div>
      <div className="live-devtools-foot">
        <p className="faint small live-devtools-said">
          Wanigan’s marks are in this page’s HTML while the live view is on.
          {keyed ? ' The Network panel shows the helper’s key (X-Wanigan-Live) on the page’s own loads: keep it out of what you share.' : null}
          {' '}<span className="live-devtools-keys">{chord.text} opens or closes this tab.</span>
        </p>
        <Button size="s" tone="quiet" icon="open" disabled={mode === 'detached'} onClick={detach}
          title="DevTools in a window of its own, for a second screen">Open in its own window</Button>
      </div>
    </div>
  );
}
