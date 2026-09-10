import type { Project } from '@shared/types';
import { labelForTab, TAB_ICONS, type Tab } from '@shared/routes';
import { areaFor, SPACE_AREAS, spaceLabel } from '@shared/spaces';
import { Icon } from './bits';
import type { ReactNode } from 'react';

export function ProjectSpaces({ projects, selected, onSelect, onAdd }: {
  projects: Project[]; selected: string | null;
  onSelect: (id: string | null) => void; onAdd: () => void;
}) {
  return <nav className="project-spaces" aria-label="Project spaces">
    <button type="button" className={selected === null ? 'is-selected' : ''}
      aria-pressed={selected === null} onClick={() => onSelect(null)}>All spaces</button>
    {projects.map((project) => <button type="button" key={project.id}
      className={selected === project.id ? 'is-selected' : ''} aria-pressed={selected === project.id}
      title={project.name} onClick={() => onSelect(project.id)}>
      <Icon name="reveal" /><span>{project.name}</span>
    </button>)}
    <button type="button" className="space-add" aria-label="Add a project space" onClick={onAdd}><Icon name="plus" /></button>
  </nav>;
}

export function SpaceRoutes({ tab, go, projectName }: { tab: Tab; go: (tab: Tab) => void; projectName: string | null }) {
  const area = areaFor(tab);
  if (area.tabs.length === 1) return null;
  return <nav className="space-routes" aria-label={`${area.label} views`}>
    <span className="space-scope">{area.id === 'work' ? projectName ?? 'All projects' : area.label}</span>
    {area.tabs.map((id) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined}
      onClick={() => go(id)}>{spaceLabel(id) ?? labelForTab(id)}</button>)}
  </nav>;
}

export function SpaceDock({ tab, go, needs, expanded, onMore, companion }: {
  tab: Tab; go: (tab: Tab) => void; needs: number; expanded: boolean; onMore: () => void; companion?: ReactNode;
}) {
  const current = areaFor(tab);
  return <footer className="space-foot">
    {companion ?? <span className="space-foot-note">Local first. Your work, together.</span>}
    <nav className="space-dock" aria-label="Workspace navigation">
      {SPACE_AREAS.slice(0, 5).map((area) => <button type="button" key={area.id}
        aria-label={area.label} aria-current={current.id === area.id ? 'page' : undefined} onClick={() => go(area.tabs[0])}>
        <Icon name={area.icon} /><span>{area.label}</span>
        {area.id === 'fleet' && needs > 0 && <span className="space-count" aria-label={`${needs} need you`}>{needs}</span>}
      </button>)}
      <button type="button" aria-expanded={expanded} aria-controls="wanigan-sidebar"
        aria-label="All destinations" title="All destinations (⌥⌘S)" onClick={onMore}><Icon name="panel" /></button>
    </nav>
    <button className="space-settings" type="button" aria-label="Settings" onClick={() => go('settings')}>
      <Icon name={TAB_ICONS.settings} />
    </button>
  </footer>;
}
