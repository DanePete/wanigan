import type { ReactNode } from 'react';
import type { Need, ProjectSummary } from '@shared/model';
import { type CommandId } from '@shared/shortcuts';
import { useCoreStatus } from '../lib/api';
import { useMaterial } from '../lib/material';
import { href, type Location } from '../lib/router';
import { Icon, type IconName } from '../components/icons';
import { Orb } from '../components/Orb';
import { NotificationBell } from '../components/NotificationTray';
import { Count, ProjectTile, tipProps } from '../components/ui';

/** The routes that are Settings' sections: the rail's Settings is lit on each. */
export const SETTINGS_ROUTES = ['settings', 'accounts', 'skills', 'mcp'] as const;

/**
 * The rail (60 px): the whole app's navigation, icons with their names and
 * keys on hover and focus. Wanigan's mark (glass and water, never yellow,
 * whatever needs you: Needs you says that); Needs you with its amber count;
 * Sessions with what is running; a hairline; the projects as tiles, and one
 * to open another; then Search and commands, the notification tray and
 * Settings. Accounts, Skills and MCP servers are Settings' sections, and
 * everything is in the palette (⌘K).
 */
export function Rail({ projects, needs, location, onAddProject, onPalette }: {
  projects: ProjectSummary[] | undefined;
  needs: Need[] | undefined;
  location: Location;
  onAddProject: () => void;
  onPalette: () => void;
}) {
  const material = useMaterial();
  const status = useCoreStatus();
  const route = location.route;
  const running = projects?.reduce((n, p) => n + p.liveSessions, 0) ?? 0;
  const needCount = needs?.length ?? 0;
  const activeKey = route.name === 'project' || route.name === 'session' ? route.projectKey : null;
  const settings = (SETTINGS_ROUTES as readonly string[]).includes(route.name);
  const core = statusText(status);

  return (
    <nav className="rail" aria-label="Wanigan">
      <a className="rail-mark rail-orb" href={href({ name: 'needs' })} aria-label={`Wanigan: what needs you. ${core}`} {...tipProps(`Wanigan · ${core}`, null, 'right')}>
        {/* His water says agents are at work; it never turns amber here (Needs you does). */}
        <Orb size={34} signal={running ? 'working' : 'quiet'} material={material} />
        <span className={`core-status core-${status}`}>
          <span className="core-dot" aria-hidden="true" />
          <span className="visually-hidden">{core}</span>
        </span>
      </a>

      <RailLink to={href({ name: 'needs' })} icon="needs" label="Needs you" active={route.name === 'needs'} keys="go-needs" tour="rail-needs"
        count={needCount ? <Count n={needCount} tone="amber" className="rail-badge bump" key={needCount} /> : null}
        name={needCount ? `Needs you, ${needCount}` : 'Needs you'} />
      <RailLink to={href({ name: 'running' })} icon="sessions" label="Sessions" active={route.name === 'running'} keys="go-running" tour="rail-sessions"
        count={running ? <Count n={running} tone="water" className="rail-badge" key={running} /> : null}
        name={running ? `Sessions, ${running} running` : 'Sessions, none running'} />

      <hr className="rail-rule" />

      <ul className="rail-projects" aria-label="Projects" data-tour="rail-projects">
        {projects?.map((p, i) => (
          <li key={p.id}>
            <ProjectTile project={p} active={activeKey === p.key} href={href({ name: 'project', projectKey: p.key, view: 'board' })}
              keys={i < 9 ? `project-${i + 1}` as CommandId : undefined} />
          </li>
        ))}
        <li>
          <button type="button" className="rail-add" onClick={onAddProject} aria-label={projects?.length ? 'Open a project' : 'Open your first project'}
            {...tipProps(projects?.length ? 'Open a project' : 'Open your first project', null, 'right')}>
            <Icon name="plus" size={16} />
          </button>
        </li>
      </ul>

      <div className="rail-foot">
        <button type="button" className="rail-item rail-search" onClick={onPalette} data-tour="rail-search" aria-label="Search and commands" {...tipProps('Search and commands', 'palette', 'right')}>
          <Icon name="search" size={20} />
        </button>
        <NotificationBell />
        <RailLink to={href({ name: 'settings' })} icon="settings" label="Settings" active={settings} keys="settings" name="Settings" />
      </div>
    </nav>
  );
}

function RailLink({ to, icon, label, name, active, keys, count, tour }: {
  to: string; icon: IconName; label: string; name: string; active: boolean; keys: CommandId; count?: ReactNode; tour?: string;
}) {
  return (
    <a href={to} className={`rail-item${active ? ' active' : ''}`} aria-current={active ? 'page' : undefined} aria-label={name} data-tour={tour}
      {...tipProps(label, keys, 'right')}>
      <Icon name={icon} size={20} />
      {count}
    </a>
  );
}

function statusText(status: string): string {
  return status === 'connected' ? 'Core running' : status === 'connecting' ? 'Connecting…' : 'Core unavailable';
}
