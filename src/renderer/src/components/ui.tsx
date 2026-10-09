// The parts every view is built from. A view composes these; it does not invent
// its own button, dialog or badge.
import {
  Fragment, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { CardType, Priority, SessionState } from '@shared/model';
import { keyLabel, type Shortcut } from '@shared/shortcuts';
import { STATE_LABEL, TYPE_LABEL } from '../lib/format';
import { Icon, type IconName } from './icons';

/* ── buttons ─────────────────────────────────────────────────────────────── */

type Tone = 'plain' | 'primary' | 'quiet' | 'danger' | 'attention';

/**
 * An action that returns a promise keeps its button disabled until it settles,
 * and the second click of a double click is ignored, so no action can be
 * started twice by a quick second click. Pass the action
 * itself (`onClick={save}`), not `() => void save()`, which throws that away.
 */
function useBusyClick(onClick: ButtonHTMLAttributes<HTMLButtonElement>['onClick']):
  [((e: MouseEvent<HTMLButtonElement>) => void) | undefined, boolean] {
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const click = onClick ? (e: MouseEvent<HTMLButtonElement>): void => {
    // The second click of a double click (detail 2) is the same intent, however fast
    // the first one finished. Keys report 0, so Enter and Space always work.
    if (running.current || e.detail > 1) return;
    const done = (onClick as (e: MouseEvent<HTMLButtonElement>) => unknown)(e);
    if (done instanceof Promise) {
      running.current = true;
      setBusy(true);
      done.finally(() => { running.current = false; setBusy(false); }).catch(() => {});
    }
  } : undefined;
  return [click, busy];
}

export function Button({ tone = 'plain', icon, size = 'm', children, className, onClick, disabled, ...rest }:
  { tone?: Tone; icon?: IconName; size?: 's' | 'm' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [click, busy] = useBusyClick(onClick);
  return (
    <button type="button" className={`btn btn-${tone} btn-${size}${className ? ` ${className}` : ''}`} {...rest}
      onClick={click} disabled={disabled || busy} aria-busy={busy || undefined}>
      {icon ? <Icon name={icon} size={size === 's' ? 14 : 16} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

export function IconButton({ icon, label, tone = 'quiet', onClick, disabled, ...rest }:
  { icon: IconName; label: string; tone?: Tone } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [click, busy] = useBusyClick(onClick);
  return (
    <button type="button" className={`btn btn-${tone} btn-icon`} aria-label={label} title={label} {...rest}
      onClick={click} disabled={disabled || busy} aria-busy={busy || undefined}>
      <Icon name={icon} />
    </button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label, size = 'm' }: {
  value: T;
  options: readonly { value: T; label: string; hint?: string }[];
  onChange: (value: T) => void;
  label: string;
  size?: 's' | 'm';
}) {
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`segmented segmented-${size}`} role="radiogroup" aria-label={label}>
      {options.map((o, index) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={index === selected ? 0 : -1}
          className={o.value === value ? 'on' : ''}
          title={o.hint}
          onClick={() => onChange(o.value)}
          onKeyDown={(event) => {
            let next: number;
            if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length;
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + options.length - 1) % options.length;
            else if (event.key === 'Home') next = 0;
            else if (event.key === 'End') next = options.length - 1;
            else return;
            event.preventDefault();
            event.stopPropagation();
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
            onChange(options[next]!.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * One run at a time, for actions reached from a key or a form as well as a
 * button: a second Enter while the first send is still going does nothing,
 * so nothing is sent or created twice.
 */
export function useSingleFlight(): <T>(run: () => Promise<T>) => Promise<T | undefined> {
  const running = useRef(false);
  const [finished, setFinished] = useState(0);
  // The cleared form must reach the DOM before another submit can use its
  // handler. An RPC can finish before React commits the new draft state.
  useLayoutEffect(() => { running.current = false; }, [finished]);
  return useCallback(async <T,>(run: () => Promise<T>): Promise<T | undefined> => {
    if (running.current) return undefined;
    running.current = true;
    try { return await run(); } finally { setFinished((n) => n + 1); }
  }, []);
}

/* ── marks ───────────────────────────────────────────────────────────────── */

const PULSING: ReadonlySet<SessionState> = new Set(['working', 'starting']);

export function StateMark({ state, label = true }: { state: SessionState; label?: boolean }) {
  return (
    <span className={`state state-${state}`} title={STATE_LABEL[state]}>
      <span className={`state-dot${PULSING.has(state) ? ' pulse' : ''}`} aria-hidden="true" />
      {label ? <span className="state-label">{STATE_LABEL[state]}</span> : <span className="visually-hidden">{STATE_LABEL[state]}</span>}
    </span>
  );
}

export function TypeMark({ type, label = false }: { type: CardType; label?: boolean }) {
  return (
    <span className={`type type-${type}`} title={TYPE_LABEL[type]}>
      <span className="type-glyph" aria-hidden="true" />
      {label ? <span>{TYPE_LABEL[type]}</span> : <span className="visually-hidden">{TYPE_LABEL[type]}</span>}
    </span>
  );
}

export function PriorityMark({ priority }: { priority: Priority }) {
  return <span className={`prio prio-${priority}`} title={`Priority P${priority}`}>P{priority}</span>;
}

/** A project's key, stamped like a log mark. */
export function ProjectMark({ projectKey, size = 'm' }: { projectKey: string; size?: 's' | 'm' | 'l' }) {
  return <span className={`pmark pmark-${size}`} aria-hidden="true">{projectKey}</span>;
}

/**
 * A shortcut's keys as caps, as the shortcut table declares them
 * (shared/shortcuts.ts): never typed out by hand beside a command.
 */
export function KeyCaps({ shortcut, mac }: { shortcut: Shortcut; mac: boolean }) {
  return (
    <span className="keycaps">
      {shortcut.keys.map((k, i) => (
        <Fragment key={`${i}-${k}`}>
          {i && shortcut.sequence ? <span className="keycaps-then">then</span> : null}
          <kbd>{keyLabel(k, mac)}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/**
 * What a view shows when the core did not answer, in place of its empty state:
 * "Nothing needs you" from a core that is down would be a false all-clear.
 */
export function NotAnswering({ error, onRetry, title = 'Wanigan’s core is not answering' }: { error: Error; onRetry: () => void; title?: string }) {
  return (
    <div className="empty" role="alert">
      <p className="empty-title">{title}</p>
      <div className="empty-body">{error.message}</div>
      <div className="empty-action"><Button icon="refresh" onClick={onRetry}>Retry</Button></div>
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/* ── dialog ──────────────────────────────────────────────────────────────── */

/**
 * What every modal does with the keyboard: focus moves in when it opens (to
 * `[data-autofocus]`, else the first match of `first`), Tab stays inside,
 * Escape closes, and focus goes back where it was when it closes.
 */
export function useFocusTrap(box: RefObject<HTMLElement | null>, onClose: () => void, first = 'input, textarea, select, button'): void {
  // Callers pass a new onClose each render; the trap is set once, or every
  // re-render (a core event) would pull focus back to the first field.
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusable = 'button, a[href], input, textarea, select, [tabindex]';
    const usable = (el: HTMLElement): boolean => !el.matches(':disabled') && !el.closest('[inert]') && el.tabIndex >= 0 && el.getClientRects().length > 0;
    const available = (selector: string): HTMLElement | undefined =>
      [...(box.current?.querySelectorAll<HTMLElement>(selector) ?? [])].find(usable);
    // A preferred control may be disabled; a text-only confirmation has no body fields.
    const target = available('[data-autofocus]') ?? available(first)
      ?? available(focusable);
    target?.focus();
    const onKey = (e: KeyboardEvent): void => {
      // An open dropdown's list sits outside the box; its keys are its own.
      if ((e.target as Element | null)?.closest?.('.sel-list')) return;
      // Escape belongs to a terminal (its program), and to an input method composing text.
      if (e.key === 'Escape' && (e.isComposing || (e.target as Element | null)?.closest?.('.xterm'))) return;
      if (e.key === 'Escape') { e.stopPropagation(); close.current(); }
      if (e.key === 'Tab' && box.current) {
        const items = [...box.current.querySelectorAll<HTMLElement>(focusable)]
          .filter(usable);
        if (!items.length) return;
        const firstEl = items[0] as HTMLElement;
        const lastEl = items[items.length - 1] as HTMLElement;
        if (e.shiftKey && document.activeElement === firstEl) { e.preventDefault(); lastEl.focus(); }
        else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); firstEl.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      previous?.focus?.();
    };
  }, [box, first]);
}

export function Dialog({ title, onClose, children, footer, width = 520 }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  useFocusTrap(box, onClose, '.dialog-body input, .dialog-body textarea, .dialog-body select, .dialog-body button');
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={box} style={{ width }}>
        <header className="dialog-head">
          <h2 id={id}>{title}</h2>
          <IconButton icon="close" label="Close" onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

/* ── toasts ──────────────────────────────────────────────────────────────── */

export interface ToastAction { label: string; run: () => void }
interface Toast { id: number; text: string; tone: 'info' | 'error'; action: ToastAction | null; count: number }
type PushToast = (text: string, tone?: Toast['tone'], options?: { action?: ToastAction }) => void;
const ToastContext = createContext<PushToast>(() => {});

const INFO_MS = 3500;
const MAX_TOASTS = 4;

/**
 * Info toasts come and go. An error stays until it is dismissed, because a
 * failure that vanished before it was read is a failure nobody knows about;
 * it can carry an action (Retry). The same error again is counted, not stacked.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback<PushToast>((text, tone = 'info', options) => {
    const id = next.current++;
    setToasts((current) => {
      const same = tone === 'error' ? current.find((t) => t.tone === 'error' && t.text === text) : undefined;
      let list = current.filter((t) => t !== same);
      list = [...list, { id, text, tone, action: options?.action ?? null, count: (same?.count ?? 0) + 1 }];
      // Over the limit, the oldest info goes first, then the oldest error.
      while (list.length > MAX_TOASTS) {
        const drop = list.find((t) => t.tone === 'info') ?? list[0];
        list = list.filter((t) => t !== drop);
      }
      return list;
    });
    if (tone === 'info') setTimeout(() => dismiss(id), INFO_MS);
  }, [dismiss]);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          t.tone === 'error' ? (
            <div key={t.id} className="toast toast-error" role="alert">
              <span className="toast-text">{t.text}{t.count > 1 ? <span className="toast-count"> ({t.count}×)</span> : null}</span>
              {t.action ? (
                <Button size="s" onClick={() => { dismiss(t.id); t.action?.run(); }}>{t.action.label}</Button>
              ) : null}
              <button type="button" className="toast-x" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(t.id)}>
                <Icon name="close" size={14} />
              </button>
            </div>
          ) : (
            <div key={t.id} className="toast toast-info">{t.text}</div>
          )
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
