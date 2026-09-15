import { useEffect, useState } from 'react';
import CodePanel from './CodePanel';
import { EmptyState, PageHead } from './bits';
import { applyThemePreference, storedThemePreference, THEME_STORAGE_KEY } from '../theme-boot';
import '../styles/helper-ux.css';

/**
 * One session's code rail in a window of its own — the diff on a second
 * monitor while the terminal keeps the first.
 *
 * Main opened this window with the session in its URL and lets it call only the
 * code panel's own channels, each bound to that session and its folder. So this
 * view asks main which session it is showing rather than trusting the query
 * string for anything but the id, and it renders nothing that writes to a
 * terminal: no composer, no attachments, no controls.
 */
type RailSession = Awaited<ReturnType<typeof window.wanigan.ux.railSession>>;

export default function CodeRailWindow({ sessionId }: { sessionId: string }) {
  // The appearance comes from the storage the main window writes, and follows
  // it: a theme changed there fires a storage event here. The settings channel
  // is deliberately not one this window may call.
  useEffect(() => {
    applyThemePreference(storedThemePreference(), false);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== THEME_STORAGE_KEY) return;
      applyThemePreference(storedThemePreference(), false);
    };
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onSystem = () => { if (storedThemePreference() === 'system') applyThemePreference('system', false); };
    window.addEventListener('storage', onStorage);
    media?.addEventListener?.('change', onSystem);
    return () => { window.removeEventListener('storage', onStorage); media?.removeEventListener?.('change', onSystem); };
  }, []);
  const [session, setSession] = useState<RailSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.ux.railSession(sessionId)
      .then((s) => {
        if (!live) return;
        setSession(s);
        document.title = `Code — ${s.title ?? s.projectName}`;
      })
      .catch((e: unknown) => { if (live) setError(e instanceof Error ? e.message : String(e)); });
    return () => { live = false; };
  }, [sessionId]);

  if (error) {
    return (
      <div className="pane ux-rail-window">
        <PageHead title="Code" lead="This window could not load its session." />
        <EmptyState posture="could-not-read" title="The session is not available" cue={error} />
      </div>
    );
  }
  if (!session) {
    return (
      <div className="pane ux-rail-window">
        <PageHead title="Code" lead="Reading the session…" />
      </div>
    );
  }
  return (
    <div className="pane ux-rail-window">
      <PageHead compact title={`Code · ${session.title ?? session.projectName}`}
                lead={<>{session.projectName} <span className="ux-cue">{session.root}</span>
                  {!session.live && <span className="ux-cue"> · this session is no longer open in Wanigan</span>}</>} />
      <div className="ux-rail-body">
        <CodePanel projectPath={session.root} projectName={session.projectName} sessionId={session.id}
                   checkpointsSupported={session.checkpointsSupported} />
      </div>
    </div>
  );
}
