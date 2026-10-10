// The live view's keys as the tooltips and aria-keyshortcuts say them (Tooltip.tsx draws `data-tip-keys`, platform
// correct): the same keys shared/live-keys.ts answers and the shortcut sheet lists, written once here so no control
// types a key into its name.
import type { Shortcut } from '@shared/shortcuts';

const live = (label: string, ...keys: string[]): Shortcut => ({ id: null, label, group: 'In the live view', keys });

export const LIVE_TIP = {
  select: live('Select a part on the page', 'P'),
  type: live('Type on the chosen words', 'E'),
  move: live('Move the chosen part', 'M'),
  code: live('The chosen part’s code', '.'),
  alone: live('Show the chosen part alone', 'Shift', 'A'),
  takeOut: live('Take the chosen part out', 'Shift', 'X'),
  devtools: live('Show in DevTools', 'Shift', 'D'),
  snap: live('Snap', 'Shift', 'S'),
  record: live('Record', 'Shift', 'R'),
  edits: live('Edits', 'Shift', 'E'),
  add: live('Add', 'Shift', 'B'),
  lens: live('Lens', 'Shift', 'L'),
  compare: live('Compare', 'Shift', 'C'),
  phone: live('Phone', '1'),
  tablet: live('Tablet', '2'),
  full: live('Full width', '3'),
  goto: live('Go to', 'Shift', 'Space'),
  clear: live('Clear the choice', 'Esc'),
  keep: live('Keep', 'Enter'),
  putBack: live('Put back', 'Esc'),
  stop: live('Stop', 'Esc'),
} as const;
