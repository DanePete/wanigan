import { useEffect, useState } from 'react';
import type { MacSettings } from '@shared/mac-presence';
import { Note, Section } from './bits';
import '../styles/mac-around.css';

/**
 * Settings for the Mac around the app (helper sweep · P8): the Dock badge, the
 * menu-bar session list, and the local automation socket.
 *
 * A file of its own rather than more of Settings.tsx, which several packages
 * change at once. Every switch here reads and writes through `mac:*`, which
 * main validates, and each one says what turning it on does before anyone
 * turns it on.
 */

function msg(e: unknown): string {
  return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);
}

export function P8Switch({ on, title, busy, onChange, children }: {
  on: boolean; title: string; busy?: boolean; onChange: (next: boolean) => void; children: React.ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="txt">
        <h4>{title}</h4>
        <p>{children}</p>
      </div>
      <button type="button" role="switch" aria-checked={on} aria-label={title}
              className="set-switch" disabled={busy} onClick={() => onChange(!on)}>
        <span className="set-state p8-switch-state" data-on={on}>
          <span aria-hidden="true">{on ? '✓' : '○'}</span> {on ? 'On' : 'Off'}
        </span>
        <span className="set-track"><span className="set-knob" /></span>
      </button>
    </div>
  );
}

/** One read of the four switches, shared by the sections that show them. */
export function useMacSettings(): {
  settings: MacSettings | null; error: string | null; busy: keyof MacSettings | null;
  set: (key: keyof MacSettings, value: boolean) => void;
} {
  const [settings, setSettings] = useState<MacSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<keyof MacSettings | null>(null);
  useEffect(() => {
    let live = true;
    window.wanigan.mac.settings().then((s) => { if (live) setSettings(s); }, (e) => { if (live) setError(msg(e)); });
    return () => { live = false; };
  }, []);
  const set = (key: keyof MacSettings, value: boolean) => {
    setBusy(key);
    setError(null);
    window.wanigan.mac.setSetting(key, value)
      .then(setSettings, (e) => setError(msg(e)))
      .finally(() => setBusy(null));
  };
  return { settings, error, busy, set };
}

export function DockAndMenuBarSettings() {
  const { settings, error, busy, set } = useMacSettings();
  return (
    <Section title="Dock and menu bar"
             hint="Whether anything needs you, readable without the window in front. Both are off until you turn them on.">
      {error && <Note tone="error">{error}</Note>}
      {settings && (
        <div className="p8-switches">
          <P8Switch title="Count on the Dock icon" on={settings.dockBadge} busy={busy === 'dockBadge'}
                    onChange={(v) => set('dockBadge', v)}>
            A number on Wanigan’s Dock icon: sessions asking for permission or stopped on an error, plus sessions whose
            finished work is waiting on review. A snoozed session is not counted. It is a count only — no colour, no names —
            and it disappears when nothing needs you.
          </P8Switch>
          <P8Switch title="Sessions in the menu bar" on={settings.menuBarSessions} busy={busy === 'menuBarSessions'}
                    onChange={(v) => set('menuBarSessions', v)}>
            A menu-bar item listing each live session by its state word, how long it has been in that state, and its
            project. Choosing one brings Wanigan forward on that session; “Halt all agents…” opens the header’s own
            two-step confirmation rather than stopping anything itself. The glyph is a hollow ring while nothing needs you.
            The menu never shows what a session was asked, its title, or a path, because it opens over whatever else is
            on your screen.
          </P8Switch>
        </div>
      )}
    </Section>
  );
}
