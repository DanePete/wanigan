// The bell in the rail, and the tray it opens: every outcome the window said
// (the status line says only the latest), newest first, each with its time and
// what can still be done about it, until dismissed. The app's own news lives
// here too: whether to check for new versions (asked once, never assumed) and
// a new version when one is out. Opening the tray reads it; the bell counts
// what is unread, red when a failure is among it, never amber (amber is
// "needs you", which is the rail's Needs you).
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAppState } from '../lib/settings';
import { navigate } from '../lib/router';
import { actionable, useNotices, type Notice } from '../lib/notices';
import { ago } from '../lib/format';
import { Icon, type IconName } from './icons';
import { Popover } from './Popover';
import { Button, Count, IconButton, tipProps, useToast } from './ui';

const ICON: Record<Notice['tone'], IconName> = { info: 'note', done: 'check', error: 'alert' };

let opener: (() => void) | null = null;

/** Open the tray from elsewhere (the palette's Notifications). */
export function openNotifications(): void {
  opener?.();
}

export function NotificationBell() {
  const { list, unread, unreadErrors, markRead, dismiss, act, clear } = useNotices();
  const app = useAppNews();
  const [open, setOpen] = useState(false);
  const bell = useRef<HTMLButtonElement>(null);
  const waiting = unread + app.count;
  const label = waiting ? `Notifications, ${waiting} new` : 'Notifications';
  const toggle = (): void => {
    if (open) { setOpen(false); markRead(); } else setOpen(true);
  };
  const close = (): void => { setOpen(false); markRead(); };
  useEffect(() => {
    const show = (): void => { bell.current?.focus(); setOpen(true); };
    opener = show;
    return () => { if (opener === show) opener = null; };
  }, []);
  return (
    <>
      <button ref={bell} type="button" className={`rail-item${open ? ' active' : ''}`} aria-label={label} aria-haspopup="dialog" aria-expanded={open}
        {...tipProps('Notifications', null, 'right')} onClick={toggle}>
        <Icon name="bell" size={20} />
        {waiting ? <Count n={waiting} tone={unreadErrors ? 'red' : 'water'} className="rail-badge" /> : null}
      </button>
      <Popover anchor={bell} open={open} onClose={close} label="Notifications" side="right" align="end" width={360} beside=".rail" className="tray">
        <div className="tray-head">
          <h2 className="tray-title">Notifications</h2>
          {list.length ? <Button size="s" tone="quiet" onClick={clear}>Clear all</Button> : null}
        </div>
        <div className="tray-body">
          {app.items}
          {list.length ? (
            <ol className="tray-list">
              {list.map((n) => (
                <li key={n.id} className={`tray-item tray-${n.tone}${n.read ? '' : ' unread'}`}>
                  <Icon name={ICON[n.tone]} size={15} className="tray-icon" />
                  <div className="tray-text">
                    <p>{n.text}{n.count > 1 ? <span className="faint"> ({n.count}×)</span> : null}</p>
                    <time dateTime={new Date(n.at).toISOString()}>{ago(n.at)}</time>
                  </div>
                  {actionable(n) ? <Button size="s" onClick={() => act(n.id)}>{n.action!.label}</Button> : null}
                  <IconButton icon="close" size="s" label={`Dismiss “${n.text.length > 40 ? `${n.text.slice(0, 40)}…` : n.text}”`} onClick={() => dismiss(n.id)} />
                </li>
              ))}
            </ol>
          ) : app.count ? null : (
            <div className="tray-empty">
              <p className="tray-empty-title">Nothing new</p>
              <p className="faint">What you and your agents finish, and anything that fails, collects here as it happens.</p>
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}

/**
 * The app's own news, in the tray: once, whether to check GitHub daily (it is
 * never done without a yes), and after that a new version when one is out.
 * Not in the demo, which never asks the network.
 */
function useAppNews(): { count: number; items: ReactNode } {
  const { state, update } = useAppState();
  const toast = useToast();
  if (!state?.updates) return { count: 0, items: null };
  const fail = (e: unknown): void => toast((e as Error)?.message ?? String(e), 'error');
  if (state.updates.state === 'available') {
    const label = `Wanigan ${state.updates.release.version} is available`;
    return {
      count: 1,
      items: (
        <div className="tray-item tray-news tray-update">
          <Icon name="pull" size={15} className="tray-icon" />
          <div className="tray-text"><p>{label}</p><span className="faint">Download it from Settings, Updates.</span></div>
          <Button size="s" onClick={() => navigate({ name: 'settings', section: 'updates' })}>Settings</Button>
        </div>
      ),
    };
  }
  if (state.settings.updateChecks !== 'ask') return { count: 0, items: null };
  return {
    count: 1,
    items: (
      <div className="tray-item tray-news tray-update-ask" role="group" aria-labelledby="tray-update-q">
        <Icon name="question" size={15} className="tray-icon" />
        <div className="tray-text">
          <p id="tray-update-q">Check for new versions once a day?</p>
          <p className="faint">GitHub receives normal connection metadata, but no project or conversation data. You can change this in Settings.</p>
          <div className="tray-answers">
            <Button size="s" onClick={() => update({ updateChecks: 'daily' }).catch(fail)}>Check daily</Button>
            <Button size="s" tone="quiet" onClick={() => update({ updateChecks: 'off' }).catch(fail)}>Not now</Button>
          </div>
        </div>
      </div>
    ),
  };
}
