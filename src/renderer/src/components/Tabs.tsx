// Tabs, in Studio's two forms: pill (a sunk track, the selected tab raised) to
// switch views or modes, underline (a 2 px water line) for a panel's sections.
//
// - Tabs: the WAI-ARIA tabs pattern, for what one panel shows (the Inspector's
//   Design, Made by, Data). Arrow keys, Home and End move and select; the
//   panel beneath is a TabPanel.
// - NavTabs: the same look for places, as links (the project bar's views):
//   each is a page of its own, so it is a link with aria-current, not a tab.
import { useId, type ReactNode, type RefObject } from 'react';
import type { CommandId, Shortcut } from '@shared/shortcuts';
import { tipProps } from './ui';

export interface TabItem<T extends string> {
  value: T;
  label: string;
  count?: number | null;
  disabled?: boolean;
  keys?: Shortcut | CommandId;
}

/** The id a tab gets, so a TabPanel can be named by it. */
export const tabId = (tabs: string, value: string): string => `${tabs}-tab-${value}`;
export const panelId = (tabs: string): string => `${tabs}-panel`;

export function Tabs<T extends string>({ id: given, label, value, onChange, tabs, form = 'underline', size = 'm', className }: {
  /** Names the tabs and their panel; give the same id to TabPanel. */
  id?: string;
  label: string;
  value: T;
  onChange: (value: T) => void;
  tabs: readonly TabItem<T>[];
  form?: 'pill' | 'underline';
  size?: 's' | 'm';
  className?: string;
}) {
  const own = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const id = given ?? own;
  const enabled = tabs.filter((t) => !t.disabled);
  return (
    <div role="tablist" aria-label={label} className={`tabs tabs-${form} tabs-${size}${className ? ` ${className}` : ''}`}>
      {tabs.map((t) => {
        const selected = t.value === value;
        return (
          <button key={t.value} type="button" role="tab" id={tabId(id, t.value)} aria-selected={selected} aria-controls={panelId(id)}
            tabIndex={selected ? 0 : -1} disabled={t.disabled} className={selected ? 'active' : ''}
            {...(t.keys ? tipProps(t.label, t.keys) : {})}
            onClick={() => onChange(t.value)}
            onKeyDown={(e) => {
              const at = enabled.findIndex((x) => x.value === t.value);
              let next: number;
              if (e.key === 'ArrowRight') next = (at + 1) % enabled.length;
              else if (e.key === 'ArrowLeft') next = (at + enabled.length - 1) % enabled.length;
              else if (e.key === 'Home') next = 0;
              else if (e.key === 'End') next = enabled.length - 1;
              else return;
              e.preventDefault();
              e.stopPropagation();
              const to = enabled[next];
              if (!to) return;
              onChange(to.value);
              document.getElementById(tabId(id, to.value))?.focus();
            }}>
            {t.label}
            {t.count ? <span className="tab-count">{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** What the selected tab shows, named by it. */
export function TabPanel<T extends string>({ tabs, value, children, className }: { tabs: string; value: T; children: ReactNode; className?: string }) {
  return (
    <div role="tabpanel" id={panelId(tabs)} aria-labelledby={tabId(tabs, value)} className={className}>
      {children}
    </div>
  );
}

export interface NavItem {
  href: string;
  label: string;
  current: boolean;
  count?: number | null;
  /** What the tooltip says, when more than the label. */
  tip?: string;
  keys?: Shortcut | CommandId;
}

/** Places as pill tabs: links, the current one marked. `children` follow the links inside the track (a ··· menu). */
export function NavTabs({ label, items, children, className, stripRef }: {
  label: string;
  items: readonly NavItem[];
  children?: ReactNode;
  className?: string;
  /** The strip itself, for keeping the current tab in view where it scrolls. */
  stripRef?: RefObject<HTMLElement | null>;
}) {
  return (
    <nav ref={stripRef} className={`tabs tabs-pill${className ? ` ${className}` : ''}`} aria-label={label}>
      {items.map((t) => (
        <a key={t.href} href={t.href} className={t.current ? 'active' : ''} aria-current={t.current ? 'page' : undefined}
          {...tipProps(t.tip ?? t.label, t.keys, 'bottom')}>
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </a>
      ))}
      {children}
    </nav>
  );
}
