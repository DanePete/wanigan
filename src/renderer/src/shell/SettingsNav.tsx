// Settings' sections, beside every one of them: Wanigan's own settings, one
// section at a time, and what was the sidebar's (Accounts, Skills, MCP
// servers), each one step from the rail's Settings and from the palette (⌘K).
import type { KeyboardEvent, ReactNode } from 'react';
import type { CommandId } from '@shared/shortcuts';
import { href, navigate, SETTINGS_SECTIONS, type Route, type SettingsSection } from '../lib/router';
import { Icon, type IconName } from '../components/icons';
import { tipProps } from '../components/ui';

export interface SettingsPlace {
  id: SettingsSection | 'accounts' | 'skills' | 'mcp';
  label: string;
  /** What the palette calls it, where the label alone would be taken for something else ("Live view" is a project's tab too). */
  palette?: string;
  icon: IconName;
  group: 'Wanigan' | 'Agents' | 'Connected';
  route: Route;
  keys?: CommandId;
}

const section = (id: SettingsSection): Route => ({ name: 'settings', section: id });

/** Every section, in the order the list shows them. */
export const SETTINGS_PLACES: readonly SettingsPlace[] = [
  { id: 'appearance', label: 'Appearance', icon: 'sun', group: 'Wanigan', route: section('appearance') },
  { id: 'general', label: 'General', icon: 'settings', group: 'Wanigan', route: section('general') },
  { id: 'live', label: 'Live view', palette: 'Live view settings', icon: 'live', group: 'Wanigan', route: section('live') },
  { id: 'updates', label: 'Updates', icon: 'pull', group: 'Wanigan', route: section('updates') },
  { id: 'accounts', label: 'Accounts', icon: 'account', group: 'Agents', route: { name: 'accounts' }, keys: 'go-accounts' },
  { id: 'skills', label: 'Skills', icon: 'skill', group: 'Agents', route: { name: 'skills' } },
  { id: 'mcp', label: 'MCP servers', icon: 'plug', group: 'Agents', route: { name: 'mcp' } },
  { id: 'local', label: 'Local models', icon: 'local', group: 'Agents', route: section('local') },
  { id: 'phone', label: 'Phone', icon: 'phone', group: 'Connected', route: section('phone') },
  { id: 'jev', label: 'Jev', icon: 'board', group: 'Connected', route: section('jev') },
];

const GROUPS = ['Wanigan', 'Agents', 'Connected'] as const;

/** Go to one of Settings' own sections, from anywhere: by its name, or by its heading's id (`set-local`). */
export function openSettingsSection(id: string): void {
  const name = id.replace(/^set-/, '');
  const found = SETTINGS_SECTIONS.find((s) => s === name);
  navigate(found ? { name: 'settings', section: found } : { name: 'settings' });
}

/** The section a route shows: a Settings route without one shows the first. */
function hereOf(route: Route): SettingsPlace['id'] | null {
  if (route.name === 'settings') return route.section ?? 'appearance';
  return route.name === 'accounts' || route.name === 'skills' || route.name === 'mcp' ? route.name : null;
}

/** Up and down move along the list, Home and End to its ends; Tab leaves it. */
function onListKey(e: KeyboardEvent<HTMLElement>): void {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const links = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>('a.settings-nav-item')];
  const at = links.indexOf(document.activeElement as HTMLAnchorElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? links.length - 1
    : e.key === 'ArrowDown' ? Math.min(links.length - 1, at + 1) : Math.max(0, at - 1);
  e.preventDefault();
  links[next]?.focus();
}

export function SettingsFrame({ route, children }: { route: Route; children: ReactNode }) {
  const here = hereOf(route);
  return (
    <div className="settings-frame">
      <nav className="settings-nav" aria-label="Settings sections" data-tour="settings-nav" onKeyDown={onListKey}>
        <h2 className="settings-nav-head">Settings</h2>
        {GROUPS.map((group) => (
          <div key={group} className="settings-nav-group">
            <h3 className="settings-nav-title">{group}</h3>
            <ul>
              {SETTINGS_PLACES.filter((p) => p.group === group).map((p) => {
                const current = here === p.id;
                return (
                  <li key={p.id}>
                    <a href={href(p.route)} className={`settings-nav-item${current ? ' active' : ''}`} aria-current={current ? 'page' : undefined}
                      {...(p.keys ? tipProps(p.label, p.keys, 'right') : {})}>
                      <Icon name={p.icon} size={16} /><span>{p.label}</span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
      <div className="settings-frame-view">{children}</div>
    </div>
  );
}
