import type { Tab } from './routes';

/** Presentation groups leave the long-standing command/digit routes intact. */
export const SPACE_AREAS = [
  { id: 'mission', label: 'Mission room', icon: 'compass', tabs: ['mission'] },
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

export const spaceLabel = (tab: Tab): string | null => tab === 'git' ? 'Changes' : null;
