import type { Project } from '@shared/types';
import { labelForTab, type Tab } from '@shared/routes';
import { areaFor, SPACE_AREAS, type SpaceAreaId } from '@shared/spaces';
import { Icon } from './bits';
import { chordLabels, useKeymap } from '../bindings';
import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { useDialog } from './useDialog';

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

type WorkspaceNavigationProps = {
  tab: Tab; go: (tab: Tab) => void; goArea: (area: SpaceAreaId) => void;
  open: boolean; onClose: () => void; compact: boolean;
  needs: number; running: number; runsInFlight: number | null;
  batchWork: { done: number; total: number } | null;
  attentionAction?: ReactNode; batchAction?: ReactNode; companion?: ReactNode;
};

/** The area list is stable; only its local destinations change with the work. */
export function WorkspaceNavigation(props: WorkspaceNavigationProps) {
  if (props.compact) return props.open ? <NavigationDialog {...props} /> : null;
  return <aside className="workbench-navigation" id="wanigan-sidebar"><NavigationContents {...props} /></aside>;
}

function NavigationDialog(props: WorkspaceNavigationProps) {
  const { portal, backdropProps, dialogProps } = useDialog<HTMLDivElement>({ onClose: props.onClose, initialFocus: 'first' });
  return portal(<div {...backdropProps} className={`${backdropProps.className} workbench-navigation-backdrop`}>
    <div {...dialogProps} id="wanigan-sidebar" className="workbench-navigation workbench-navigation-dialog" aria-label="Workspace navigation">
      <div className="workbench-navigation-title"><span>Navigation</span><button type="button" onClick={props.onClose} aria-label="Close navigation"><Icon name="x" /></button></div>
      <NavigationContents {...props} />
    </div>
  </div>);
}

function NavigationContents({ tab, go, goArea, onClose, compact, needs, running, runsInFlight, batchWork, attentionAction, batchAction, companion }: WorkspaceNavigationProps) {
  const current = areaFor(tab);
  const keymap = useKeymap().map;
  const openArea = (id: SpaceAreaId) => { goArea(id); if (compact) onClose(); };
  const openView = (id: Tab) => { go(id); if (compact) onClose(); };
  return <>
    <nav className="workbench-areas" aria-label="Workspace navigation" onKeyDown={(event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (at < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
      {SPACE_AREAS.map(area => {
        const active = current.id === area.id;
        const count = area.id === 'fleet' ? needs : area.id === 'work' ? running : area.id === 'automation' ? runsInFlight : null;
        return <div key={area.id} className={`workbench-area${area.id === 'settings' ? ' workbench-area-settings' : ''}`}>
          <button type="button" className="workbench-area-button" aria-label={area.label}
            aria-current={active ? 'page' : undefined} data-nav-tab={active ? tab : area.tabs[0]} tabIndex={active ? 0 : -1}
            data-initial-focus={active ? true : undefined} onClick={() => openArea(area.id)}>
            <Icon name={area.icon} /><span>{area.label}</span>
            {count !== null && count > 0 && <span className="workbench-area-count" aria-label={area.id === 'fleet' ? `${count} need you` : `${count} active`}>{count}</span>}
          </button>
          {active && area.tabs.length > 1 && <nav className="workbench-local-routes" aria-label={`${area.label} views`}>
            {area.tabs.map(id => <button key={id} type="button" data-nav-tab={id}
              aria-current={id === tab ? 'page' : undefined} aria-keyshortcuts={chordLabels(keymap, `view:${id}`).aria}
              title={`${labelForTab(id)} (${chordLabels(keymap, `view:${id}`).keys})`} onClick={() => openView(id)}>
              <span className="nav-tab-label">{labelForTab(id)}</span><span className="nav-tab-chord" aria-hidden="true">{chordLabels(keymap, `view:${id}`).keys}</span>
            </button>)}
          </nav>}
          {area.id === 'fleet' && attentionAction}
          {area.id === 'automation' && <>
            {batchWork && <div className="workbench-batch-status"><span>{batchWork.done} / {batchWork.total} batch requests</span>
              <progress className="workbench-batch-progress" value={batchWork.done} max={batchWork.total}
                aria-label={`${batchWork.done} of ${batchWork.total} batch requests returned`} /></div>}
            {batchAction}
          </>}
        </div>;
      })}
    </nav>
    <div className="workbench-navigation-companion">{companion ?? <span className="workbench-local-note">Local workspace</span>}</div>
  </>;
}
