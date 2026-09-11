import type { Project } from '@shared/types';
import { labelForTab, TAB_ICONS, type Tab } from '@shared/routes';
import { areaFor, SPACE_AREAS, spaceLabel } from '@shared/spaces';
import { Icon } from './bits';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useDialog } from './useDialog';
import '../styles/spaces.css';

export function ProjectSpaces({ projects, selected, ready, onSelect, onAdd }: {
  projects: Project[]; selected: string | null; ready: boolean;
  onSelect: (id: string | null) => void; onAdd: () => void;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const name = selected === null ? 'All spaces' : projects.find((project) => project.id === selected)?.name
    ?? (ready ? 'Space unavailable' : 'Loading space…');
  return <nav className="project-spaces" aria-label="Project spaces">
    <button type="button" className="space-switch-trigger" aria-label={`Switch project space: ${name}`}
      aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      title={name} onClick={() => setOpen(true)}>
      <Icon name={selected === null ? 'grid' : 'reveal'} />
      <span className="space-switch-name">{name}</span>
      {ready && <span className="space-switch-count" aria-hidden="true">{projects.length}</span>}
      <span className="space-switch-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <SpaceSwitcher id={id} projects={projects} selected={selected} ready={ready}
      onClose={() => setOpen(false)} onSelect={(value) => { setOpen(false); onSelect(value); }}
      onAdd={() => { setOpen(false); requestAnimationFrame(onAdd); }} />}
  </nav>;
}

function SpaceSwitcher({ id, projects, selected, ready, onClose, onSelect, onAdd }: {
  id: string; projects: Project[]; selected: string | null; ready: boolean;
  onClose: () => void; onSelect: (id: string | null) => void; onAdd: () => void;
}) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLDivElement>({ onClose, initialFocus: 'first' });
  const [query, setQuery] = useState('');
  const [activeKey, setActiveKey] = useState(selected === null ? 'all' : `project:${selected}`);
  const options = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return [
      { key: 'all', id: null, name: 'All spaces', detail: 'The view across your projects' },
      ...[...projects].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
        .map((project) => ({ key: `project:${project.id}`, id: project.id, name: project.name, detail: project.path })),
    ].filter((option) => `${option.name} ${option.detail}`.toLocaleLowerCase().includes(needle));
  }, [projects, query]);
  const activeIndex = Math.max(0, options.findIndex((option) => option.key === activeKey));
  const active = options[activeIndex];
  const optionId = (index: number) => `${id}-option-${index}`;
  useEffect(() => {
    document.getElementById(`${id}-option-${activeIndex}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, activeIndex, query]);

  return portal(<div {...backdropProps} className={`${backdropProps.className} space-switch-backdrop`}>
    <div {...dialogProps} id={id} className="space-switcher mo-enter" aria-label="Switch project space">
      <div className="space-switch-intro">
        <span>Your spaces <span>{ready ? projects.length : 'Loading…'}</span></span>
        <button type="button" className="space-switch-close" aria-label="Close space switcher" onClick={onClose}><Icon name="x" /></button>
      </div>
      <div className="space-switch-search">
        <Icon name="search" />
        <input role="combobox" aria-label="Search project spaces" placeholder="Find a space…" data-initial-focus
          aria-expanded="true" aria-controls={`${id}-list`} aria-autocomplete="list" autoComplete="off" spellCheck={false}
          aria-activedescendant={active ? optionId(activeIndex) : undefined} value={query}
          onChange={(event) => { setQuery(event.target.value); setActiveKey(''); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              if (options.length) setActiveKey(options[(activeIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length].key);
            } else if (event.key === 'Enter' && active) {
              event.preventDefault(); onSelect(active.id);
            }
          }} />
        {query && <button type="button" aria-label="Clear space search" onClick={() => {
          setQuery(''); setActiveKey('all'); dialogProps.ref.current?.querySelector('input')?.focus();
        }}><Icon name="x" /></button>}
      </div>
      <div className="space-switch-list" role="listbox" id={`${id}-list`} tabIndex={-1} aria-label="Project spaces" aria-busy={!ready}>
        {options.map((option, index) => <div key={option.key} id={optionId(index)} role="option"
          aria-selected={option.id === selected} className="space-switch-option" data-active={index === activeIndex}
          onMouseDown={(event) => event.preventDefault()} onPointerMove={() => setActiveKey(option.key)} onClick={() => onSelect(option.id)}>
          <Icon name={option.id === null ? 'grid' : 'reveal'} />
          <span className="space-switch-description"><strong>{option.name}</strong><span>{option.detail}</span></span>
          {option.id === selected && <span className="space-switch-check" aria-hidden="true">✓</span>}
        </div>)}
      </div>
      {options.length === 0 && <p className="space-switch-empty" role="status">No spaces match “{query.trim()}”.<br />Try a project name or folder path.</p>}
      <div className="space-switch-footer">
        <button type="button" onClick={onAdd} aria-label="Add a project space"><Icon name="plus" />Add space</button>
        <span aria-hidden="true">↑↓ to move · ↵ to open</span>
      </div>
    </div>
  </div>);
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
