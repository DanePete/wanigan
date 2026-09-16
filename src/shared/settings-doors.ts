/**
 * Where a "Settings › …" sentence in a refusal actually goes.
 *
 * Main writes refusals as text — they cross IPC as an Error message — and
 * several name the Settings section that fixes them. Printed, that is a
 * breadcrumb a person has to follow by hand, and one of them was wrong: the
 * interactive-session limit said "Settings › Dispatcher" while the section sits
 * under the Automation tab. Main now spells each breadcrumb from this table, and
 * the renderer reads the same table back to put a real link beside the sentence,
 * so the words and the door cannot drift apart.
 *
 * `tab` and `section` are the Settings view's own tab id and exact Section
 * title. A drifted title still lands on the right tab.
 */
export const SETTINGS_DOORS = [
  { breadcrumb: 'Settings › Automation › Dispatcher', tab: 'automation', section: 'Dispatcher', label: 'Open Dispatcher settings' },
  { breadcrumb: 'Settings › Agents › Accounts', tab: 'agents', section: 'Accounts', label: 'Open Accounts settings' },
  { breadcrumb: 'Settings › Agents', tab: 'agents', section: undefined, label: 'Open Agents settings' },
] as const;

export type SettingsDoor = (typeof SETTINGS_DOORS)[number];

/** The breadcrumb main prints for a door, by section title. */
export function settingsBreadcrumb(section: 'Dispatcher' | 'Accounts'): string {
  return SETTINGS_DOORS.find((door) => door.section === section)?.breadcrumb ?? 'Settings';
}

/**
 * The first door a message names, most specific breadcrumb first — so
 * "Settings › Agents › Accounts" opens Accounts rather than the Agents tab.
 */
export function settingsDoorIn(message: string | null | undefined): SettingsDoor | null {
  if (!message) return null;
  return [...SETTINGS_DOORS].sort((a, b) => b.breadcrumb.length - a.breadcrumb.length)
    .find((door) => message.includes(door.breadcrumb)) ?? null;
}
