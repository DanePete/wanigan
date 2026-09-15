import { getSetting, setSetting } from './settings';
import type { MacSettings } from '../shared/mac-presence';

export type { MacSettings };

/**
 * The switches the Mac-around-the-app features add, kept out of the shared
 * settings bridge so each can say exactly what turning it on does.
 *
 * Every one of them defaults off. Two put Wanigan outside its own window (a
 * Dock badge, a menu-bar item), and two open a door into it from other programs
 * on this Mac (the automation socket, and letting that socket send). A person
 * who has not asked for any of that should not find it switched on by an
 * upgrade.
 */
const KEYS: Record<keyof MacSettings, string> = {
  dockBadge: 'mac_dock_badge',
  menuBarSessions: 'mac_menu_bar_sessions',
  automationSocket: 'automation_socket',
  automationSend: 'automation_socket_send',
};

export function macSettings(): MacSettings {
  const read = (k: keyof MacSettings) => getSetting(KEYS[k], '0') === '1';
  return {
    dockBadge: read('dockBadge'),
    menuBarSessions: read('menuBarSessions'),
    automationSocket: read('automationSocket'),
    automationSend: read('automationSend'),
  };
}

/** Validated at the boundary: the name must be one of the four, the value a boolean. */
export function setMacSetting(key: unknown, value: unknown): MacSettings {
  if (typeof key !== 'string' || !(key in KEYS)) throw new Error('That is not one of Wanigan’s Mac settings.');
  if (typeof value !== 'boolean') throw new Error('A Mac setting is either on or off.');
  setSetting(KEYS[key as keyof MacSettings], value ? '1' : '0');
  return macSettings();
}
