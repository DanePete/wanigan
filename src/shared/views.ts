// A project's views, in order, with the key that jumps to each (after G). Shared
// so the router, the key handler, the shortcut sheet and the app menu all read
// the same list.

export type ProjectView = 'board' | 'list' | 'sessions' | 'history' | 'changes' | 'decisions' | 'activity' | 'live';

export const PROJECT_VIEWS: readonly { view: ProjectView; label: string; key: string }[] = [
  { view: 'board', label: 'Board', key: 'b' },
  { view: 'list', label: 'List', key: 'l' },
  { view: 'sessions', label: 'Sessions', key: 's' },
  { view: 'history', label: 'History', key: 'h' },
  { view: 'changes', label: 'Changes', key: 'c' },
  { view: 'decisions', label: 'Decisions', key: 'd' },
  { view: 'activity', label: 'Activity', key: 'a' },
];

/**
 * The live view (docs/design/2026-10-08-live-view.md) is a project view too, but
 * optional: its tab shows only while Settings › Live view is on, so it is not in
 * the list the menu, the palette and the shortcut sheet are built from.
 */
export const LIVE_VIEW = { view: 'live' as const, label: 'Live' };

/** The tabs of a project's Changes view, the git workbench: the working tree, the history, branches and stashes. */
export type GitTab = 'changes' | 'commits' | 'branches' | 'stashes';

export const GIT_TABS: readonly { tab: GitTab; label: string }[] = [
  { tab: 'changes', label: 'Changes' },
  { tab: 'commits', label: 'Commits' },
  { tab: 'branches', label: 'Branches' },
  { tab: 'stashes', label: 'Stashes' },
];

/** What the window title is made of; null where it does not apply. */
export interface TitleParts {
  /** The view's name: "Needs you", "Board", "Running". */
  view: string;
  /** The project on screen, by name (or key, before the name is known). */
  project: string | null;
  /** The session on screen, by its title. */
  session: string | null;
  /** The card open in the drawer, by key. */
  card: string | null;
}

/**
 * The window's title, the most context first and the app last, as macOS shows
 * it in the Window menu and Mission Control: "Northstar · Board — Wanigan".
 */
export function windowTitle(t: TitleParts): string {
  const parts = t.project ? [t.project, t.session ?? t.view] : [t.view];
  if (t.card) parts.push(t.card);
  return `${parts.filter(Boolean).join(' · ')} — Wanigan`;
}
