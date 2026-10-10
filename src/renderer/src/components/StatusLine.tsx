// The status line: one line at the bottom of the window's work, under every
// view and its dock. It says the latest outcome (an icon, a sentence, and an
// action while one can be taken), holds what the view puts at its end
// (StatusSlot: the dock's tabs waiting, a count, a mode), and ends with the ?
// that opens the keys, with the compass that plays the view's tour beside it
// (and, on the view's first visit, the offer of that tour). A failure that must be acted on now (one with Retry)
// is a toast in the status line's own place, above it, never over a control.
// Every outcome also goes to the notification tray, with its time.
import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { actionable, useNotices, type Notice } from '../lib/notices';
import { ago } from '../lib/format';
import { Icon, type IconName } from './icons';
import { Button, IconButton } from './ui';
import { TourOffer, TourReplay } from './Tour';
import type { Tour } from '../tours';

const ICON: Record<Notice['tone'], IconName> = { info: 'note', done: 'check', error: 'alert' };

export function StatusLine({ onKeys, tour = null }: { onKeys: () => void; tour?: Tour | null }) {
  const { latest, urgent, ownLines, showLine, setSlot, act, settle, quiet } = useNotices();
  const hidden = ownLines > 0;
  useEffect(() => (hidden ? undefined : showLine()), [hidden, showLine]);
  if (hidden) return null;
  const said = latest && !latest.urgent ? latest : null;
  return (
    <div className="status-host">
      {urgent.map((n) => (
        // Must be acted on now: said here until it is done or dismissed.
        <div key={n.id} className="toast toast-error status-urgent" role="alert">
          <Icon name="alert" size={15} className="toast-icon" />
          <span className="toast-text">{n.text}{n.count > 1 ? <span className="toast-count"> ({n.count}×)</span> : null}</span>
          {n.action ? <Button size="s" onClick={() => act(n.id)}>{n.action.label}</Button> : null}
          <button type="button" className="toast-x" aria-label="Dismiss" data-tip="Dismiss" onClick={() => settle(n.id)}>
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}
      <div className="status-line" aria-label="Status">
        <div className="status-said" aria-live="polite">
          {said ? (
            <span className={`status-message status-${said.tone}`} role={said.tone === 'error' ? 'alert' : undefined}
              data-tip={`${said.text} · ${ago(said.at)}`}>
              <Icon name={ICON[said.tone]} size={14} className="status-icon" />
              <span className="status-text">{said.text}{said.count > 1 ? <span className="status-count"> ({said.count}×)</span> : null}</span>
              {actionable(said) ? <Button size="s" tone="quiet" onClick={() => act(said.id)}>{said.action!.label}</Button> : null}
              {said.tone === 'error' ? <IconButton icon="close" size="s" label="Put the message away" onClick={quiet} /> : null}
            </span>
          ) : null}
        </div>
        <TourOffer tour={tour} />
        <div className="status-slot" ref={setSlot} />
        <TourReplay tour={tour} />
        <IconButton icon="question" size="s" label="Keyboard shortcuts" keys="shortcuts" className="status-keys" onClick={onKeys} />
      </div>
    </div>
  );
}

/**
 * What a view puts at the status line's end: the dock's tabs waiting, a mode,
 * a count. Drawn there while the view is shown; nothing where no status line is.
 */
export function StatusSlot({ children }: { children: ReactNode }) {
  const { slot } = useNotices();
  return slot ? createPortal(children, slot) : null;
}
