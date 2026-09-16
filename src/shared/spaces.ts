import type { Tab } from './routes';

/** Presentation groups leave the long-standing command/digit routes intact. */
export const SPACE_AREAS = [
  { id: 'mission', label: 'Home', icon: 'compass', tabs: ['mission'] },
  { id: 'work', label: 'Projects', icon: 'terminal', tabs: ['sessions', 'board', 'git', 'context'] },
  { id: 'fleet', label: 'Fleet', icon: 'grid', tabs: ['fleet', 'usage', 'insights'] },
  { id: 'review', label: 'Review', icon: 'target', tabs: ['control'] },
  { id: 'knowledge', label: 'Knowledge', icon: 'brain', tabs: ['learning', 'skills', 'scout', 'plugins'] },
  { id: 'automation', label: 'Automation', icon: 'clock', tabs: ['runs', 'batches', 'schedules'] },
  { id: 'settings', label: 'Settings', icon: 'sliders', tabs: ['settings'] },
] as const satisfies readonly { id: string; label: string; icon: string; tabs: readonly Tab[] }[];

export function areaFor(tab: Tab) {
  return SPACE_AREAS.find((area) => (area.tabs as readonly Tab[]).includes(tab)) ?? SPACE_AREAS[0];
}

export type SpaceAreaId = (typeof SPACE_AREAS)[number]['id'];
export type AreaMemory = Partial<Record<SpaceAreaId, Tab>>;

/** Moving between areas must not turn returning to work into starting over. */
export function rememberDestination(memory: AreaMemory, tab: Tab): AreaMemory {
  return { ...memory, [areaFor(tab).id]: tab };
}

export function areaDestination(id: SpaceAreaId, memory: AreaMemory): Tab {
  const area = SPACE_AREAS.find(item => item.id === id) ?? SPACE_AREAS[0];
  const remembered = memory[id];
  return remembered && (area.tabs as readonly Tab[]).includes(remembered) ? remembered : area.tabs[0];
}

/** A workspace view does not pretend the remembered project filters its data. */
export function projectScopeFor(tab: Tab): 'optional' | 'required' | 'workspace' {
  if (tab === 'git' || tab === 'context') return 'required';
  if (tab === 'mission' || tab === 'sessions' || tab === 'board') return 'optional';
  return 'workspace';
}
