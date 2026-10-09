// Where the phone is: a tab, and anything opened from it. A stack, so Back
// returns to where you were; a tab starts its stack again.
import { createContext, useContext } from 'react';

export type Screen =
  | { name: 'needs' }
  | { name: 'sessions' }
  | { name: 'session'; id: string }
  | { name: 'boards' }
  | { name: 'board'; projectId: string }
  | { name: 'card'; id: string }
  | { name: 'new'; projectId?: string; cardId?: string }
  | { name: 'phone' };

export type Tab = 'needs' | 'sessions' | 'boards' | 'new' | 'phone';

export interface Nav {
  screen: Screen;
  canGoBack: boolean;
  go: (screen: Screen) => void;
  back: () => void;
  tab: (tab: Tab) => void;
}

export const NavContext = createContext<Nav | null>(null);

export function useNav(): Nav {
  const nav = useContext(NavContext);
  if (!nav) throw new Error('useNav outside the phone app');
  return nav;
}

/** The tab a screen belongs to, for the tab bar. */
export function tabOf(screen: Screen): Tab {
  switch (screen.name) {
    case 'needs': return 'needs';
    case 'sessions': case 'session': return 'sessions';
    case 'boards': case 'board': case 'card': return 'boards';
    case 'new': return 'new';
    case 'phone': return 'phone';
  }
}
