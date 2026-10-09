// A small hash router. Routes are data, so the palette, the rail and the tests
// all read the same list.
import { useSyncExternalStore } from 'react';
import { GIT_TABS, PROJECT_VIEWS, type GitTab, type ProjectView } from '@shared/views';

export { GIT_TABS, PROJECT_VIEWS, type GitTab, type ProjectView };

export type Route =
  | { name: 'needs' }
  | { name: 'running' }
  | { name: 'accounts' }
  | { name: 'skills' }
  | { name: 'mcp' }
  | { name: 'settings' }
  | { name: 'project'; projectKey: string; view: ProjectView }
  | { name: 'session'; projectKey: string; sessionId: string };

export interface Location {
  route: Route;
  /** The card open in the drawer, by key. */
  card: string | null;
  /** The card whose branch the Changes view shows, by key. */
  branch: string | null;
  /** The Changes view's tab: the working tree, commits, branches or stashes. */
  tab: GitTab;
}

export function parse(hash: string): Location {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  const search = new URLSearchParams(query);
  const card = search.get('card');
  const branch = search.get('branch');
  let route: Route = { name: 'needs' };
  if (parts[0] === 'running') route = { name: 'running' };
  else if (parts[0] === 'accounts') route = { name: 'accounts' };
  else if (parts[0] === 'skills') route = { name: 'skills' };
  else if (parts[0] === 'mcp') route = { name: 'mcp' };
  else if (parts[0] === 'settings') route = { name: 'settings' };
  else if (parts[0] === 'p' && parts[1]) {
    if (parts[2] === 's' && parts[3]) route = { name: 'session', projectKey: parts[1], sessionId: parts[3] };
    else {
      const view = PROJECT_VIEWS.find((v) => v.view === parts[2])?.view ?? 'board';
      route = { name: 'project', projectKey: parts[1], view };
    }
  }
  const tab = route.name === 'project' && route.view === 'changes' ? GIT_TABS.find((t) => t.tab === parts[3])?.tab ?? 'changes' : 'changes';
  return { route, card, branch, tab };
}

/** The Changes view, showing one card's branch. */
export const branchHref = (projectKey: string, cardKey: string): string =>
  `#/p/${encodeURIComponent(projectKey)}/changes?branch=${encodeURIComponent(cardKey)}`;

/** A tab of the Changes view, on the project folder or a card's worktree. */
export const gitHref = (projectKey: string, tab: GitTab, cardKey?: string | null): string =>
  `#/p/${encodeURIComponent(projectKey)}/changes${tab === 'changes' ? '' : `/${tab}`}${cardKey ? `?branch=${encodeURIComponent(cardKey)}` : ''}`;

export function href(route: Route, card?: string | null): string {
  let path: string;
  switch (route.name) {
    case 'needs': path = '/needs'; break;
    case 'running': path = '/running'; break;
    case 'accounts': path = '/accounts'; break;
    case 'skills': path = '/skills'; break;
    case 'mcp': path = '/mcp'; break;
    case 'settings': path = '/settings'; break;
    case 'project': path = `/p/${encodeURIComponent(route.projectKey)}/${route.view}`; break;
    case 'session': path = `/p/${encodeURIComponent(route.projectKey)}/s/${encodeURIComponent(route.sessionId)}`; break;
  }
  return `#${path}${card ? `?card=${encodeURIComponent(card)}` : ''}`;
}

export function navigate(route: Route, card?: string | null): void {
  const next = href(route, card);
  if (location.hash !== next) location.hash = next;
}

/** Open or close the card drawer without leaving the current view. */
export function openCard(card: string | null): void {
  navigate(parse(location.hash).route, card);
}

let current = parse(location.hash);
const listeners = new Set<() => void>();
window.addEventListener('hashchange', () => {
  current = parse(location.hash);
  for (const l of listeners) l();
});

export function useLocation(): Location {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => current,
  );
}
