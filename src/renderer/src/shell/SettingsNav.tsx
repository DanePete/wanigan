// Settings' sections, beside every one of them: what was the sidebar's
// Accounts, Skills and MCP servers are Settings now, each one step from the
// rail's Settings (and from the palette, ⌘K). The app's own settings are one
// page today; their names here take you to each. The Settings pass makes this
// one section at a time.
import type { ReactNode } from 'react';
import { href, navigate, type Route } from '../lib/router';
import { Icon, type IconName } from '../components/icons';
import { tipProps } from '../components/ui';

/** The groups of the Settings page, by the id of their heading. */
const ON_THE_PAGE: readonly { id: string; label: string; icon: IconName }[] = [
  { id: 'set-appearance', label: 'Appearance', icon: 'sun' },
  { id: 'set-general', label: 'General', icon: 'settings' },
  { id: 'set-live', label: 'Live view', icon: 'live' },
  { id: 'set-updates', label: 'Updates', icon: 'pull' },
  { id: 'set-local', label: 'Local models', icon: 'local' },
  { id: 'set-phone', label: 'Phone', icon: 'phone' },
  { id: 'set-jev', label: 'Jev', icon: 'board' },
];

const PAGES: readonly { route: Extract<Route, { name: 'accounts' | 'skills' | 'mcp' }>; label: string; icon: IconName; keys?: 'go-accounts' }[] = [
  { route: { name: 'accounts' }, label: 'Accounts', icon: 'account', keys: 'go-accounts' },
  { route: { name: 'skills' }, label: 'Skills', icon: 'skill' },
  { route: { name: 'mcp' }, label: 'MCP servers', icon: 'plug' },
];

/** Go to a group of the Settings page, from anywhere: the page first, then the group, once it is drawn. */
export function openSettingsSection(id: string): void {
  navigate({ name: 'settings' });
  let tries = 0;
  const find = (): void => {
    const el = document.getElementById(id);
    if (el) { el.scrollIntoView({ block: 'start' }); return; }
    if (++tries < 60) requestAnimationFrame(find);
  };
  requestAnimationFrame(find);
}

export function SettingsFrame({ route, children }: { route: Route; children: ReactNode }) {
  return (
    <div className="settings-frame">
      <nav className="settings-nav" aria-label="Settings sections">
        <h2 className="settings-nav-title">Settings</h2>
        <ul>
          {ON_THE_PAGE.map((s) => (
            <li key={s.id}>
              <button type="button" className="settings-nav-item" onClick={() => openSettingsSection(s.id)}>
                <Icon name={s.icon} size={16} /><span>{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
        <h2 className="settings-nav-title">Agents</h2>
        <ul>
          {PAGES.map((p) => {
            const here = route.name === p.route.name;
            return (
              <li key={p.route.name}>
                <a href={href(p.route)} className={`settings-nav-item${here ? ' active' : ''}`} aria-current={here ? 'page' : undefined}
                  {...(p.keys ? tipProps(p.label, p.keys, 'right') : {})}>
                  <Icon name={p.icon} size={16} /><span>{p.label}</span>
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="settings-frame-view">{children}</div>
    </div>
  );
}
