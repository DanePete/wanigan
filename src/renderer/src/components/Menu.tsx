// A menu of actions that looks like the rest of Wanigan in both themes: a
// button opens it, and it lists commands (ARIA menu button pattern), grouped
// under headings, each with a quieter second line and its key. The list takes
// the arrow keys, Home and End, typing to jump, Enter or Space to run, and
// Escape or Tab to close. It is drawn over everything (so a side panel never
// clips it) and, like every dropdown here, steps the live view aside while it
// is open. Select is for choosing a value; this is for doing something.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { keyLabel } from '@shared/shortcuts';
import { bridge } from '../lib/api';
import { useCoversLive } from '../lib/live';
import { Icon, type IconName } from './icons';

export interface MenuItem {
  id: string;
  label: string;
  /** A second, quieter line: what it does or where it saves. */
  detail?: string;
  icon?: IconName;
  /** Its key, as the shortcut table writes keys (`['Shift', 'C']`). */
  keys?: string[];
  disabled?: boolean;
  /** A choice among several (an environment) or a switch (drag handles): ticked when on. */
  checked?: boolean;
  kind?: 'radio' | 'check';
  /** Items with the same group are listed under its heading, in order. */
  group?: string;
  run: () => void;
}

interface Place { left: number; top: number; width: number; maxHeight: number }

const GAP = 4;
const MAX_HEIGHT = 460;

export function MenuButton({ label, items, notes, children, className, title, align = 'start', width = 300, disabled, openRef, onOpen }: {
  /** The button's accessible name. */
  label: string;
  items: readonly MenuItem[];
  /** A line of text under a group's items (what opening a hosted environment does), read with each of them. */
  notes?: Readonly<Record<string, string>>;
  /** What the button shows. */
  children: ReactNode;
  className?: string;
  title?: string;
  /** Which edge of the button the menu lines up with. */
  align?: 'start' | 'end';
  width?: number;
  disabled?: boolean;
  /** Set to a function that opens the menu, for a key that opens it. */
  openRef?: MutableRefObject<(() => void) | null>;
  onOpen?: (open: boolean) => void;
}) {
  const own = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const listId = `${own}-menu`;
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useCoversLive(open);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Place | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const enabled = useMemo(() => items.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [items]);
  const mac = bridge().platform === 'darwin';

  const show = (at = enabled[0] ?? -1): void => {
    if (disabled) return;
    setActive(at);
    setOpen(true);
    onOpen?.(true);
  };
  const close = (refocus = true): void => {
    setOpen(false);
    setPlace(null);
    onOpen?.(false);
    if (refocus) button.current?.focus();
  };
  const run = (i: number): void => {
    const item = items[i];
    if (!item || item.disabled) return;
    close();
    item.run();
  };
  if (openRef) openRef.current = () => { if (open) close(); else { button.current?.focus(); show(); } };

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const up = below < 200 && above > below;
    const maxHeight = Math.min(MAX_HEIGHT, up ? above : below);
    const w = Math.min(Math.max(r.width, width), window.innerWidth - 16);
    const left = Math.max(8, Math.min(align === 'end' ? r.right - w : r.left, window.innerWidth - w - 8));
    setPlace({ left, top: up ? r.top - GAP - maxHeight : r.bottom + GAP, width: w, maxHeight });
  }, [open, align, width]);

  const placed = place !== null;
  useEffect(() => { if (open && placed) list.current?.focus(); }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    const gone = (e: Event): void => {
      if (e.target instanceof Node && list.current?.contains(e.target)) return;
      close(false);
    };
    document.addEventListener('mousedown', away, true);
    window.addEventListener('resize', gone);
    return () => {
      document.removeEventListener('mousedown', away, true);
      window.removeEventListener('resize', gone);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const step = (from: number, by: 1 | -1): number => {
    const at = enabled.indexOf(from);
    if (at < 0) return enabled[by > 0 ? 0 : enabled.length - 1] ?? -1;
    return enabled[(at + by + enabled.length) % enabled.length] ?? from;
  };
  const jump = (key: string): number => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
    const q = typed.current.text;
    return enabled.find((i) => items[i]?.label.toLowerCase().startsWith(q)) ?? -1;
  };

  const onButtonKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); show(enabled[enabled.length - 1] ?? -1); }
  };
  const onListKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(enabled[0] ?? -1); }
    else if (e.key === 'End') { e.preventDefault(); setActive(enabled[enabled.length - 1] ?? -1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); run(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { e.preventDefault(); close(); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const i = jump(e.key);
      if (i >= 0) setActive(i);
    }
  };

  const groups: { group: string | undefined; rows: { item: MenuItem; i: number }[] }[] = [];
  items.forEach((item, i) => {
    const last = groups[groups.length - 1];
    if (last && last.group === item.group) last.rows.push({ item, i });
    else groups.push({ group: item.group, rows: [{ item, i }] });
  });
  const noteId = (g: string): string => `${own}-note-${g.replace(/\W/g, '')}`;

  return (
    <>
      <button ref={button} type="button" className={`btn menu-button${className ? ` ${className}` : ''}`} title={title}
        aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? listId : undefined} disabled={disabled}
        onClick={() => (open ? close() : show())} onKeyDown={onButtonKey}>
        {children}
      </button>
      {open && place ? createPortal(
        <div ref={list} id={listId} role="menu" tabIndex={-1} className="sel-list menu-list" aria-label={label}
          aria-activedescendant={active >= 0 ? `${own}-i${active}` : undefined}
          style={{ left: place.left, top: place.top, width: place.width, maxHeight: place.maxHeight }}
          onKeyDown={onListKey}>
          {groups.map((g, gi) => (
            <div key={`${g.group ?? ''}-${gi}`} role="group" aria-label={g.group}>
              {g.group ? <div role="presentation" className="sel-group">{g.group}</div> : null}
              {g.rows.map(({ item, i }) => (
                <div key={item.id} id={`${own}-i${i}`} data-i={i}
                  role={item.kind === 'radio' ? 'menuitemradio' : item.kind === 'check' ? 'menuitemcheckbox' : 'menuitem'}
                  aria-checked={item.kind ? !!item.checked : undefined}
                  aria-disabled={item.disabled || undefined}
                  aria-keyshortcuts={item.keys ? item.keys.map((k) => (k === 'Mod' ? (mac ? 'Meta' : 'Control') : k)).join('+') : undefined}
                  aria-describedby={g.group && notes?.[g.group] ? noteId(g.group) : undefined}
                  className={`sel-opt menu-item${i === active ? ' active' : ''}`}
                  onMouseMove={() => { if (!item.disabled && active !== i) setActive(i); }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(i)}>
                  <span className="sel-check" aria-hidden="true">
                    {item.kind ? (item.checked ? <Icon name="check" size={13} /> : null) : item.icon ? <Icon name={item.icon} size={14} /> : null}
                  </span>
                  <span className="sel-text">
                    <span>{item.label}</span>
                    {item.detail ? <span className="sel-detail">{item.detail}</span> : null}
                  </span>
                  {item.keys ? (
                    <span className="menu-keys" aria-hidden="true">{item.keys.map((k) => <kbd key={k}>{keyLabel(k, mac)}</kbd>)}</span>
                  ) : null}
                </div>
              ))}
              {g.group && notes?.[g.group] ? <p id={noteId(g.group)} className="menu-note">{notes[g.group]}</p> : null}
            </div>
          ))}
        </div>,
        document.body,
      ) : null}
    </>
  );
}
