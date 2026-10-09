// The rail on the left is full, or folded to icons. A narrow window folds it
// on its own; a choice the owner made by hand (⌘\) wins, at any width, and is
// remembered by the window that made it.

export type RailChoice = 'expanded' | 'collapsed';

/** Below this window width the rail folds to icons, unless the owner opened it by hand. */
export const RAIL_FOLDS_BELOW = 1180;

/** Whether the rail shows icons only. */
export function railCollapsed(choice: RailChoice | null, width: number): boolean {
  return choice ? choice === 'collapsed' : width < RAIL_FOLDS_BELOW;
}

/** The choice a toggle makes from what is on screen now. */
export const toggledRail = (collapsed: boolean): RailChoice => (collapsed ? 'expanded' : 'collapsed');

/** A stored choice, or null for "not chosen" (anything else that was stored). */
export const railChoice = (stored: unknown): RailChoice | null => (stored === 'expanded' || stored === 'collapsed' ? stored : null);
