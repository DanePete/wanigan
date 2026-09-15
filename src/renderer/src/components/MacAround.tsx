import { useCallback, useEffect, useState } from 'react';
import type { MacSettings } from '@shared/mac-presence';
import type { AutomationLedgerRow, AutomationStatus } from '@shared/automation-protocol';
import { Mark, Note, Section, ago } from './bits';
import { useAnnounce } from './announce';
import { appendToComposerDraft } from './Composer';
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

/* ── the automation socket ───────────────────────────────────────────── */

const OUTCOME_MARK: Record<string, { glyph: string; tone: 'ok' | 'warn' | 'bad' | 'quiet' }> = {
  answered: { glyph: '✓', tone: 'ok' }, drafted: { glyph: '✎', tone: 'ok' }, 'drafted-held': { glyph: '✎', tone: 'quiet' },
  sent: { glyph: '↵', tone: 'warn' }, 'sent-from-queue': { glyph: '↵', tone: 'warn' }, queued: { glyph: '◷', tone: 'quiet' },
  started: { glyph: '▶', tone: 'warn' }, asked: { glyph: '?', tone: 'quiet' }, declined: { glyph: '✕', tone: 'quiet' },
  refused: { glyph: '✕', tone: 'bad' }, 'queue-dropped': { glyph: '✕', tone: 'quiet' }, 'queue-expired': { glyph: '✕', tone: 'quiet' },
  'write-failed': { glyph: '!', tone: 'bad' }, 'launch-failed': { glyph: '!', tone: 'bad' },
};

export function AutomationSocketSettings() {
  const { settings, error, busy, set } = useMacSettings();
  const [status, setStatus] = useState<AutomationStatus | null>(null);
  const [ledger, setLedger] = useState<AutomationLedgerRow[]>([]);
  const [readError, setReadError] = useState<string | null>(null);
  const reload = useCallback(() => {
    Promise.all([window.wanigan.automation.status(), window.wanigan.automation.ledger(20)])
      .then(([s, rows]) => { setStatus(s); setLedger(rows); setReadError(null); }, (e) => setReadError(msg(e)));
  }, []);
  useEffect(() => { reload(); }, [reload, settings?.automationSocket, settings?.automationSend]);

  return (
    <Section title="Automation socket"
             hint="A local door for your own scripts: list sessions, draft into a composer, and — only if you allow it — send. Off by default.">
      {(error || readError) && <Note tone="error">{error ?? readError}</Note>}
      {settings && (
        <div className="p8-switches">
          <P8Switch title="Local automation socket" on={settings.automationSocket} busy={busy === 'automationSocket'}
                    onChange={(v) => set('automationSocket', v)}>
            Opens a Unix domain socket in Wanigan’s own data folder, in a directory only your user can enter, with a fresh
            token beside it each time it starts. A script that reads the token can list sessions, read one session’s state,
            and put text into a session’s composer as a draft you still send yourself. Asking for a new session raises an
            approval dialog here, refused after five minutes. Every call is written to the ledger below with the process
            that made it.
          </P8Switch>
          <P8Switch title="Allow scripts to send" on={settings.automationSend} busy={busy === 'automationSend' || !settings.automationSocket}
                    onChange={(v) => set('automationSend', v)}>
            Lets a script’s <span className="mono">send</span> type into a session’s prompt. Even then the text reaches the
            agent only while it is idle or has finished its turn — the same rule the composer uses — and never answers a
            permission prompt; otherwise the send waits in a queue for up to an hour. With this off, a send is refused and
            the script is told to draft instead.
          </P8Switch>
        </div>
      )}
      {status && (
        <div className="p8-socket-state">
          <div className="p8-socket-line">
            {status.listening
              ? <Mark glyph="✓" word="listening" tone="ok" />
              : status.enabled
                ? <Mark glyph="!" word="not listening" tone="bad" />
                : <Mark glyph="○" word="off" tone="quiet" />}
            <code className="mono p8-path">{status.socketPath}</code>
          </div>
          {status.error && <Note tone="error">{status.error}</Note>}
          <p className="p8-fine">
            Token: <code className="mono p8-path">{status.tokenPath}</code> — never shown in this window. The reference
            client is <code className="mono">npm run cli -- socket list</code>; see <code className="mono">socket help</code>.
            {status.queued > 0 ? ` ${status.queued} send${status.queued === 1 ? '' : 's'} waiting for an agent to reach its prompt.` : ''}
          </p>
        </div>
      )}
      <div className="set-sub">Ledger</div>
      {ledger.length === 0 ? (
        <p className="p8-fine">No calls recorded. Every call the socket receives — answered, refused or queued — appears here.</p>
      ) : (
        <div className="p8-scroll">
          <table className="grid p8-ledger">
            <thead><tr><th>When</th><th>Verb</th><th>Outcome</th><th>Peer</th><th>Detail</th></tr></thead>
            <tbody>
              {ledger.map((row) => {
                const mark = OUTCOME_MARK[row.outcome] ?? { glyph: '·', tone: 'quiet' as const };
                return (
                  <tr key={row.id}>
                    <td className="p8-when">{ago(row.at)}</td>
                    <td className="mono">{row.verb}</td>
                    <td><Mark glyph={mark.glyph} word={row.outcome} tone={mark.tone} /></td>
                    <td className="mono p8-path">{row.peerPid ? `${row.peerCommand} · pid ${row.peerPid}` : 'unknown peer'}</td>
                    <td className="p8-fine">{row.detail ?? ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

/**
 * Where a script's draft lands: the session's composer, unsent, with a line in
 * the polite region that says where it came from. Rendered once by App.
 */
export function AutomationDraftLanding({ openSession }: { openSession: (id: string) => void }) {
  const { announce } = useAnnounce();
  useEffect(() => {
    const land = (sessionId: string, text: string) => {
      appendToComposerDraft(sessionId, text, 'A script put this in the draft through the automation socket. Nothing is sent until you press Send.');
      announce({ tone: 'info', text: 'A script drafted a message into a session’s composer. It is unsent.', action: { label: 'Open', run: () => openSession(sessionId) } });
    };
    const off = window.wanigan.automation.onDraft(({ sessionId, text }) => land(sessionId, text));
    window.wanigan.automation.takeDrafts()
      .then((held) => { for (const d of held) land(d.sessionId, d.text); })
      .catch(() => {});
    return () => { off(); };
  }, [announce, openSession]);
  return null;
}
