// The parts every view is built from (Studio: docs/design/studio-components.md
// says what each is for). A view composes these; it does not invent its own
// button, dialog or badge. The frame's larger parts live beside this file:
// Tabs, Toolbar, Panel, Popover, StatusLine, NotificationTray, Tooltip.
import {
  Fragment, createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type ButtonHTMLAttributes, type MouseEvent, type ReactNode, type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import type { CardType, Priority, ProjectSummary, SessionState } from '@shared/model';
import { keyLabel, keysOn, shortcutFor, shortcutText, type CommandId, type Shortcut } from '@shared/shortcuts';
import { STATE_LABEL, TYPE_LABEL } from '../lib/format';
import { Icon, type IconName } from './icons';
import { useCoversLive } from '../lib/live';
import { bridge } from '../lib/api';
import { NoticesContext, type Notice, type NoticeAction, type NoticeTone } from '../lib/notices';

/* ── keys ────────────────────────────────────────────────────────────────── */

/** Whether keys are written the Mac way (⌘, ⌥, ⇧); everywhere else Ctrl, Alt and Shift. */
export function isMac(): boolean {
  try { return bridge().platform === 'darwin'; } catch { return false; }
}

/** A shortcut from the table, by command or as given. */
export function shortcutOf(keys: Shortcut | CommandId | null | undefined): Shortcut | undefined {
  if (!keys) return undefined;
  return typeof keys === 'string' ? shortcutFor(keys) : keys;
}

/** `aria-keyshortcuts` for a chord or a single key; a sequence (G then E) has no ARIA form, so none. */
export function ariaKeys(s: Shortcut | undefined, mac = isMac()): string | undefined {
  if (!s || s.sequence) return undefined;
  const name = (k: string): string => (k === 'Mod' ? (mac ? 'Meta' : 'Control') : k === 'Ctrl' ? 'Control' : k === 'Esc' ? 'Escape' : k);
  if (s.keys.some((k) => /[–-]/.test(k) && k.length > 1)) return undefined; // "1–9" is a family, not a key
  return s.keys.map(name).join('+');
}

/**
 * What a control says when pointed at or focused (Tooltip.tsx draws it): its
 * name and, from the shortcut table, its keys. Spread onto the control.
 */
export function tipProps(label: string, keys?: Shortcut | CommandId | null, side?: 'top' | 'right' | 'bottom'): Record<string, string> {
  const s = shortcutOf(keys);
  const mac = isMac();
  const aria = ariaKeys(s, mac);
  return {
    'data-tip': label,
    ...(s ? { 'data-tip-keys': shortcutText(s, mac) } : {}),
    ...(aria ? { 'aria-keyshortcuts': aria } : {}),
    ...(side ? { 'data-tip-side': side } : {}),
  };
}

/* ── buttons ─────────────────────────────────────────────────────────────── */

/**
 * primary: water fill, one per surface · plain: a hairline · quiet: words only ·
 * danger: a destructive confirm · attention: amber fill, only for the action
 * that answers what needs you (a permission waiting), never for emphasis.
 */
export type Tone = 'plain' | 'primary' | 'quiet' | 'danger' | 'attention';

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

/** A button with words: s is 28 px, m 32 px. `keys` puts its shortcut in its tooltip. */
export function Button({ tone = 'plain', icon, size = 'm', keys, children, className, onClick, disabled, ...rest }:
  { tone?: Tone; icon?: IconName; size?: 's' | 'm'; keys?: Shortcut | CommandId } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [click, busy] = useBusyClick(onClick);
  const tip = keys && typeof children === 'string' ? tipProps(children, keys) : {};
  return (
    <button type="button" className={`btn btn-${tone} btn-${size}${className ? ` ${className}` : ''}`} {...tip} {...rest}
      onClick={click} disabled={disabled || busy} aria-busy={busy || undefined}>
      {icon ? <Icon name={icon} size={size === 's' ? 14 : 16} /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

/**
 * A button that is only an icon (32 × 30): its name is its `aria-label` and
 * its tooltip, with its key. `pressed` makes it a toggle (a tool): water fill
 * while on.
 */
export function IconButton({ icon, label, tone = 'quiet', size = 'm', pressed, keys, tipSide, onClick, disabled, className, ...rest }:
  { icon: IconName; label: string; tone?: Tone; size?: 's' | 'm'; pressed?: boolean; keys?: Shortcut | CommandId; tipSide?: 'top' | 'right' | 'bottom' }
  & ButtonHTMLAttributes<HTMLButtonElement>) {
  const [click, busy] = useBusyClick(onClick);
  return (
    <button type="button" className={`btn btn-${tone} btn-icon btn-icon-${size}${className ? ` ${className}` : ''}`} aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed} {...tipProps(label, keys, tipSide)} {...rest}
      onClick={click} disabled={disabled || busy} aria-busy={busy || undefined}>
      <Icon name={icon} size={size === 's' ? 14 : 16} />
    </button>
  );
}

/**
 * One choice among a few, as a radio group: `pill` (a sunk track, the chosen
 * segment raised) to switch a mode, `underline` for a panel's sections.
 * Arrow keys, Home and End move and choose. To switch what a panel shows, with
 * the panel itself named by the choice, use Tabs instead.
 */
export function Segmented<T extends string | number>({ value, options, onChange, label, size = 'm', form = 'pill' }: {
  value: T;
  options: readonly { value: T; label: string; hint?: string; count?: number }[];
  onChange: (value: T) => void;
  label: string;
  size?: 's' | 'm';
  form?: 'pill' | 'underline';
}) {
  const selected = Math.max(0, options.findIndex((o) => o.value === value));
  return (
    <div className={`segmented segmented-${size} segmented-${form}`} role="radiogroup" aria-label={label}>
      {options.map((o, index) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={index === selected ? 0 : -1}
          className={o.value === value ? 'on' : ''}
          {...(o.hint ? { 'data-tip': o.hint } : {})}
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
          {o.count !== undefined ? <span className="segmented-count">{o.count}</span> : null}
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
    <span className={`state state-${state}`} {...(label ? {} : { 'data-tip': STATE_LABEL[state] })}>
      <span className={`state-dot${PULSING.has(state) ? ' pulse' : ''}`} aria-hidden="true" />
      {label ? <span className="state-label">{STATE_LABEL[state]}</span> : <span className="visually-hidden">{STATE_LABEL[state]}</span>}
    </span>
  );
}

export function TypeMark({ type, label = false }: { type: CardType; label?: boolean }) {
  return (
    <span className={`type type-${type}`} {...(label ? {} : { 'data-tip': TYPE_LABEL[type] })}>
      <span className="type-glyph" aria-hidden="true" />
      {label ? <span>{TYPE_LABEL[type]}</span> : <span className="visually-hidden">{TYPE_LABEL[type]}</span>}
    </span>
  );
}

export function PriorityMark({ priority }: { priority: Priority }) {
  return <span className={`prio prio-${priority}`} data-tip={`Priority P${priority}`}>P{priority}</span>;
}

/** A project's key, in mono, as the rail's tile shows it. */
export function ProjectMark({ projectKey, size = 'm' }: { projectKey: string; size?: 's' | 'm' | 'l' }) {
  return <span className={`pmark pmark-${size}`} aria-hidden="true">{projectKey}</span>;
}

/** A small label: what something is (neutral), or one of the meanings. Never amber: amber is a Count or a Dot. */
export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'water' | 'green' | 'red'; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * A number in a pill: sunk for a plain count, water-soft for one that is
 * news, red for failures, amber only for what needs you. `label` is what a
 * screen reader hears when the number alone would not say what it counts.
 */
export function Count({ n, tone = 'sunk', label, className }: { n: number; tone?: 'sunk' | 'water' | 'amber' | 'red'; label?: string; className?: string }) {
  return (
    <span className={`count count-${tone}${tone === 'amber' ? ' hot' : ''}${className ? ` ${className}` : ''}`}
      {...(label ? { role: 'img', 'aria-label': label } : {})}>
      {n}
    </span>
  );
}

/** A dot: water for live, amber only for "needs you", red for failed, green for done. Says `label` to a screen reader. */
export function Dot({ tone = 'water', label, className }: { tone?: 'water' | 'amber' | 'red' | 'green' | 'muted'; label?: string; className?: string }) {
  return <span className={`dot dot-${tone}${className ? ` ${className}` : ''}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })} />;
}

/**
 * A project in the rail: its key in mono on a 40 px tile, a water ring while
 * it is open, an amber dot when something in it needs you. A link, so it
 * opens in place; its name and key are its tooltip.
 */
export function ProjectTile({ project, active, href, keys }: { project: ProjectSummary; active: boolean; href: string; keys?: Shortcut | CommandId }) {
  const notes = [
    !project.pathOk ? 'folder missing' : null,
    project.pausedAt ? 'paused' : null,
    project.needsYou ? `${project.needsYou} need${project.needsYou === 1 ? 's' : ''} you` : project.liveSessions ? `${project.liveSessions} running` : null,
  ].filter(Boolean);
  const name = notes.length ? `${project.name}, ${notes.join(', ')}` : project.name;
  return (
    <a href={href} className={`ptile${active ? ' active' : ''}${project.pathOk ? '' : ' missing'}${project.pausedAt ? ' paused' : ''}`}
      aria-current={active ? 'page' : undefined} aria-label={name} {...tipProps(name, keys, 'right')}>
      <span className="ptile-key" aria-hidden="true">{project.key}</span>
      {project.needsYou ? <Dot tone="amber" className="ptile-dot" /> : project.liveSessions ? <Dot tone="water" className="ptile-dot" /> : null}
      {project.pausedAt ? <span className="ptile-paused" aria-hidden="true"><Icon name="pause" size={10} /></span> : null}
    </a>
  );
}

/**
 * A shortcut's keys as caps, platform-correct (⌘ on a Mac, Ctrl elsewhere), as
 * the shortcut table declares them (shared/shortcuts.ts): never typed out by
 * hand beside a command. Give it a shortcut, or keys as the table writes them.
 */
export function KeyCaps({ shortcut, keys, sequence, mac = isMac() }: { shortcut?: Shortcut; keys?: readonly string[]; sequence?: boolean; mac?: boolean }) {
  const list = shortcut ? keysOn(shortcut, mac) : keys ?? [];
  const then = shortcut?.sequence ?? sequence ?? false;
  return (
    <span className="keycaps">
      {list.map((k, i) => (
        <Fragment key={`${i}-${k}`}>
          {i && then ? <span className="keycaps-then">then</span> : null}
          <kbd>{keyLabel(k, mac)}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/* ── empty states ────────────────────────────────────────────────────────── */

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

/** Where explanation lives: a title, one sentence, one action. */
export function EmptyState({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: IconName }) {
  return (
    <div className="empty">
      {icon ? <span className="empty-icon" aria-hidden="true"><Icon name={icon} size={20} /></span> : null}
      <p className="empty-title">{title}</p>
      {children ? <div className="empty-body">{children}</div> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/** The old name for EmptyState, kept while views move. */
export const Empty = EmptyState;

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

/** A modal: sheet elevation, a title, the content, and a footer with at most one primary button. */
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
  useCoversLive();
  return createPortal(
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={id} ref={box} style={{ width }}>
        <header className="dialog-head">
          <h2 id={id}>{title}</h2>
          <IconButton icon="close" label="Close" keys={{ id: null, label: 'Close', group: 'In dialogs and lists', keys: ['Esc'] }} onClick={onClose} />
        </header>
        <div className="dialog-body">{children}</div>
        {footer ? <footer className="dialog-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body,
  );
}

/* ── fields ──────────────────────────────────────────────────────────────── */

/** A labelled field: a real `<label>` for the control `children` draws with the id it is given. */
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className={`field${error ? ' field-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? <p className="field-hint error-text" role="alert">{error}</p> : hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}

/** A switch: a real checkbox with the switch role, its label beside it and a quieter line under it. */
export function Toggle({ checked, onChange, label, hint, disabled, className }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const hintId = useId();
  return (
    <label className={`toggle${disabled ? ' disabled' : ''}${className ? ` ${className}` : ''}`}>
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} aria-describedby={hint ? hintId : undefined}
        onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint ? <span className="toggle-hint" id={hintId}>{hint}</span> : null}
      </span>
    </label>
  );
}

/* ── disclosure ──────────────────────────────────────────────────────────── */

/**
 * A section that opens on request: its heading is the button (WAI-ARIA
 * disclosure), with a quiet summary beside the title so a closed one still
 * says what is in it.
 */
export function Disclosure({ title, summary, open: initial = false, children, className }: {
  title: string;
  summary?: ReactNode;
  open?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(initial);
  return (
    <section className={`disclosure${open ? ' open' : ''}${className ? ` ${className}` : ''}`} aria-labelledby={`${id}-head`}>
      <h3 className="disclosure-head">
        <button type="button" id={`${id}-head`} aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((v) => !v)}>
          <Icon name="chevron" size={12} className="disclosure-twist" />
          <span className="disclosure-title">{title}</span>
          {summary ? <span className="disclosure-summary">{summary}</span> : null}
        </button>
      </h3>
      <div className="disclosure-body" id={`${id}-body`} hidden={!open}>{open ? children : null}</div>
    </section>
  );
}

/** Copy some text, and say so. `what` finishes "Copied …" ("the path", "the query"). */
export function CopyButton({ text, label, what = 'it' }: { text: string; label: string; what?: string }) {
  const toast = useToast();
  const copy = (): Promise<void> => navigator.clipboard.writeText(text)
    .then(() => toast(`Copied ${what}.`), () => toast('The clipboard is not available here. Select the text and copy it yourself.', 'error'));
  return <IconButton icon="copy" label={label} onClick={copy} />;
}

/* ── what just happened: the status line, the tray, and toasts ────────────── */

export type ToastAction = NoticeAction;
type PushToast = (text: string, tone?: NoticeTone, options?: { action?: ToastAction }) => void;
const ToastContext = createContext<PushToast>(() => {});

/** A toast that floats (where no status line is shown): as before Studio. */
interface Floating { id: number; text: string; tone: NoticeTone; action: ToastAction | null; count: number }

const INFO_MS = 3500;
/** An outcome with an action (Undo) offers it this long. */
const INFO_ACTION_MS = 12_000;
const MAX_TOASTS = 4;
const MAX_NOTICES = 50;

/**
 * The store behind `useToast()`. Every outcome is a notice in the tray (the
 * bell), and the latest is what the status line says. A failure with an
 * action (Retry) is a toast too, in the status line's place, until dismissed
 * or done: it must be acted on now. Where no status line is on screen (a view
 * that draws its own, the phone), outcomes float as toasts, as they always
 * did: info comes and goes, a failure stays until dismissed, the same failure
 * again is counted, not stacked.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Notice[]>([]);
  const [latestId, setLatestId] = useState<number | null>(null);
  const [floating, setFloating] = useState<Floating[]>([]);
  const [lines, setLines] = useState(0);
  const [ownLines, setOwnLines] = useState(0);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [, setTick] = useState(0);
  const linesNow = useRef(0);
  const ownNow = useRef(0);
  const next = useRef(1);

  const dismissFloating = useCallback((id: number) => setFloating((t) => t.filter((x) => x.id !== id)), []);
  const dismiss = useCallback((id: number) => {
    setList((l) => l.filter((n) => n.id !== id));
    setLatestId((at) => (at === id ? null : at));
  }, []);

  const push = useCallback<PushToast>((text, tone = 'info', options) => {
    const id = next.current++;
    const action = options?.action ?? null;
    const now = Date.now();
    const urgent = tone === 'error' && !!action;
    const onScreen = linesNow.current > 0 && ownNow.current === 0;
    setList((current) => {
      // The same failure again is counted, not repeated; so is the same outcome within a moment.
      const same = current.find((n) => n.text === text && n.tone === tone && (tone === 'error' || now - n.at < 2000));
      const counted = same ? same.count + 1 : 1;
      const notice: Notice = {
        id, text, tone, at: now, action, actionUntil: action && tone !== 'error' ? now + INFO_ACTION_MS : null,
        count: counted, read: false, urgent,
      };
      return [notice, ...current.filter((n) => n !== same)].slice(0, MAX_NOTICES);
    });
    if (!urgent || !onScreen) setLatestId(id);
    // An Undo lapses: the status line and the tray stop offering it.
    if (action && tone !== 'error') setTimeout(() => setTick((n) => n + 1), INFO_ACTION_MS + 50);
    if (onScreen) return;
    setFloating((current) => {
      const same = tone === 'error' ? current.find((t) => t.tone === 'error' && t.text === text) : undefined;
      let shown = current.filter((t) => t !== same);
      shown = [...shown, { id, text, tone, action, count: (same?.count ?? 0) + 1 }];
      // Over the limit, the oldest info goes first, then the oldest error.
      while (shown.length > MAX_TOASTS) {
        const drop = shown.find((t) => t.tone !== 'error') ?? shown[0];
        shown = shown.filter((t) => t !== drop);
      }
      return shown;
    });
    if (tone !== 'error') setTimeout(() => dismissFloating(id), action ? INFO_ACTION_MS : INFO_MS);
  }, [dismissFloating]);

  const settle = useCallback((id: number) => {
    setList((l) => l.map((n) => (n.id === id ? { ...n, urgent: false } : n)));
    dismissFloating(id);
  }, [dismissFloating]);

  const act = useCallback((id: number) => {
    const notice = list.find((n) => n.id === id);
    const run = notice?.action?.run;
    setList((l) => l.map((n) => (n.id === id ? { ...n, action: null, urgent: false } : n)));
    dismissFloating(id);
    run?.();
  }, [list, dismissFloating]);

  const showLine = useCallback(() => {
    linesNow.current++;
    setLines(linesNow.current);
    return () => { linesNow.current--; setLines(linesNow.current); };
  }, []);
  const ownLine = useCallback(() => {
    ownNow.current++;
    setOwnLines(ownNow.current);
    return () => { ownNow.current--; setOwnLines(ownNow.current); };
  }, []);

  const value = useMemo(() => {
    const latest = latestId === null ? null : list.find((n) => n.id === latestId) ?? null;
    return {
      list,
      latest,
      urgent: list.filter((n) => n.urgent).reverse(),
      unread: list.filter((n) => !n.read).length,
      unreadErrors: list.filter((n) => !n.read && n.tone === 'error').length,
      dismiss,
      settle,
      act,
      clear: () => { setList([]); setLatestId(null); },
      markRead: () => setList((l) => (l.some((n) => !n.read) ? l.map((n) => ({ ...n, read: true })) : l)),
      quiet: () => setLatestId(null),
      lines, ownLines, showLine, ownLine, slot, setSlot,
    };
  }, [list, latestId, dismiss, settle, act, lines, ownLines, showLine, ownLine, slot]);

  // A failure waiting for its Retry floats only where no status line can hold it; where one can, it moves there.
  const lineShown = lines > 0 && ownLines === 0;
  const urgentIds = new Set(value.urgent.map((n) => n.id));
  const urgentFloating = lineShown ? [] : value.urgent.filter((n) => !floating.some((t) => t.id === n.id));
  const floats = lineShown ? floating.filter((t) => !urgentIds.has(t.id)) : floating;
  return (
    <ToastContext.Provider value={push}>
      <NoticesContext.Provider value={value}>
        {children}
        <div className="toasts" role="status" aria-live="polite">
          {[...floats, ...urgentFloating.map((n) => ({ id: n.id, text: n.text, tone: n.tone, action: n.action, count: n.count }))].map((t) => (
            t.tone === 'error' ? (
              <div key={t.id} className="toast toast-error" role="alert">
                <Icon name="alert" size={15} className="toast-icon" />
                <span className="toast-text">{t.text}{t.count > 1 ? <span className="toast-count"> ({t.count}×)</span> : null}</span>
                {t.action ? <Button size="s" onClick={() => act(t.id)}>{t.action.label}</Button> : null}
                <button type="button" className="toast-x" aria-label="Dismiss" data-tip="Dismiss" onClick={() => settle(t.id)}>
                  <Icon name="close" size={14} />
                </button>
              </div>
            ) : t.action ? (
              // A done thing that can be undone: it stays long enough to change one's mind.
              <div key={t.id} className="toast toast-info">
                <span className="toast-text">{t.text}</span>
                <Button size="s" onClick={() => act(t.id)}>{t.action.label}</Button>
              </div>
            ) : (
              <div key={t.id} className="toast toast-info">{t.text}</div>
            )
          ))}
        </div>
      </NoticesContext.Provider>
    </ToastContext.Provider>
  );
}

/**
 * Say what happened: `toast(text)` for an outcome, `toast(text, 'done')` for
 * something saved or verified, `toast(text, 'error')` for a failure; give an
 * `action` (Undo, Retry) when something can be done about it.
 */
export const useToast = () => useContext(ToastContext);
