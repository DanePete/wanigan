// A dropdown that looks like the rest of Wanigan in both themes, where the
// native one opens an OS menu that ignores them. The ARIA "select-only
// combobox" pattern: a button names the choice; the list it opens takes the
// arrow keys, Home and End, typing to jump, Enter or Space to choose, and Escape
// or Tab to close. The list is drawn over everything, so a drawer or a dialog
// never clips it.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './icons';
import { useCoversLive } from '../lib/live';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  /** A second, quieter line under the label. */
  detail?: string;
  /** Something richer under that: an account's limits left, for one. Not read out as the option's name. */
  extra?: ReactNode;
  /** Options with the same group are listed under its heading, in order. */
  group?: string;
  disabled?: boolean;
}

interface Place { left: number; top: number; width: number; maxHeight: number; anchor: { left: number; top: number } }

const GAP = 4;
const MAX_HEIGHT = 320;

export function Select<T extends string | number>({ id, value, onChange, options, label, size = 'm', className, disabled }: {
  /** For a `<label htmlFor>`; Field passes one. */
  id?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly SelectOption<T>[];
  /** The accessible name, when no visible label points at it. */
  label?: string;
  size?: 's' | 'm';
  className?: string;
  disabled?: boolean;
}) {
  const own = useId();
  const listId = `${own}-list`;
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  useCoversLive(open);
  const [active, setActive] = useState(-1);
  const [place, setPlace] = useState<Place | null>(null);
  const placeRef = useRef(place);
  placeRef.current = place;
  const typed = useRef({ text: '', at: 0 });
  const current = options.find((o) => o.value === value);
  const enabled = useMemo(() => options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0), [options]);

  const openList = (at = options.findIndex((o) => o.value === value)): void => {
    if (disabled) return;
    setActive(at >= 0 && !options[at]?.disabled ? at : enabled[0] ?? -1);
    setOpen(true);
  };
  const close = (refocus = true): void => {
    setOpen(false);
    setPlace(null);
    if (refocus) button.current?.focus();
  };
  const choose = (i: number): void => {
    const o = options[i];
    if (!o || o.disabled) return;
    if (o.value !== value) onChange(o.value);
    close();
  };

  // Place the list under the button, or above it when there is no room below.
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const up = below < 160 && above > below;
    const maxHeight = Math.min(MAX_HEIGHT, up ? above : below);
    const width = Math.max(r.width, 200);
    const left = Math.min(r.left, window.innerWidth - width - 8);
    setPlace({ left, top: up ? r.top - GAP - maxHeight : r.bottom + GAP, width, maxHeight, anchor: { left: r.left, top: r.top } });
  }, [open]);

  // The list exists only once it has a place; focus it then, so its keys are its own.
  const placed = place !== null;
  useEffect(() => {
    if (open && placed) list.current?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!list.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    const gone = (e: Event): void => {
      // Scrolling the list itself is fine; anything else moving the button closes it. A scroll
      // that lands after the list opened (focus brought a half-hidden button into view) moved nothing.
      if (e.target instanceof Node && list.current?.contains(e.target)) return;
      const r = button.current?.getBoundingClientRect();
      if (e.type === 'scroll' && r && placeRef.current && Math.abs(r.top - placeRef.current.anchor.top) < 1 && Math.abs(r.left - placeRef.current.anchor.left) < 1) return;
      close(false);
    };
    document.addEventListener('mousedown', away, true);
    window.addEventListener('resize', gone);
    window.addEventListener('scroll', gone, true);
    return () => {
      document.removeEventListener('mousedown', away, true);
      window.removeEventListener('resize', gone);
      window.removeEventListener('scroll', gone, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const step = (from: number, by: 1 | -1): number => {
    const at = enabled.indexOf(from);
    if (at < 0) return enabled[by > 0 ? 0 : enabled.length - 1] ?? -1;
    return enabled[Math.max(0, Math.min(enabled.length - 1, at + by))] ?? from;
  };
  const jump = (key: string): number => {
    const now = Date.now();
    typed.current = { text: now - typed.current.at < 700 ? typed.current.text + key.toLowerCase() : key.toLowerCase(), at: now };
    const q = typed.current.text;
    return enabled.find((i) => options[i]?.label.toLowerCase().startsWith(q)) ?? -1;
  };

  const onButtonKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openList(); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const i = jump(e.key);
      if (i >= 0) { e.preventDefault(); onChange(options[i]!.value); }
    }
  };
  const onListKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => step(a, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => step(a, -1)); }
    else if (e.key === 'Home') { e.preventDefault(); setActive(enabled[0] ?? -1); }
    else if (e.key === 'End') { e.preventDefault(); setActive(enabled[enabled.length - 1] ?? -1); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(active); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === 'Tab') { close(); }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const i = jump(e.key);
      if (i >= 0) setActive(i);
    }
  };

  let lastGroup: string | undefined;
  return (
    <>
      <button
        ref={button}
        id={id}
        type="button"
        className={`select select-${size}${className ? ` ${className}` : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        {...(label ? { 'aria-label': label } : {})}
        disabled={disabled}
        onClick={() => (open ? close() : openList())}
        onKeyDown={onButtonKey}
      >
        <span className="select-value">{current?.label ?? ''}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && place ? createPortal(
        <ul
          ref={list}
          id={listId}
          role="listbox"
          tabIndex={-1}
          className="sel-list"
          aria-label={label ?? current?.label}
          aria-activedescendant={active >= 0 ? `${own}-o${active}` : undefined}
          style={{ left: place.left, top: place.top, minWidth: place.width, maxHeight: place.maxHeight }}
          onKeyDown={onListKey}
        >
          {options.map((o, i) => {
            const heading = o.group && o.group !== lastGroup ? o.group : null;
            lastGroup = o.group;
            return [
              heading ? <li key={`g-${heading}`} role="presentation" className="sel-group">{heading}</li> : null,
              <li
                key={`${String(o.value)}-${i}`}
                id={`${own}-o${i}`}
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                className={`sel-opt${i === active ? ' active' : ''}${o.value === value ? ' chosen' : ''}`}
                onMouseMove={() => { if (!o.disabled && active !== i) setActive(i); }}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(i)}
              >
                <span className="sel-check" aria-hidden="true">{o.value === value ? <Icon name="check" size={13} /> : null}</span>
                <span className="sel-text">
                  <span>{o.label}</span>
                  {o.detail ? <span className="sel-detail">{o.detail}</span> : null}
                  {o.extra ? <span className="sel-extra">{o.extra}</span> : null}
                </span>
              </li>,
            ];
          })}
        </ul>,
        document.body,
      ) : null}
    </>
  );
}
