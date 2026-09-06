import { getSetting } from '../settings';
import { ensurePushTopic } from './secrets';
import type { MobileMonitorConfig } from '../../shared/types';

/**
 * The non-secret half of the phone monitor: the settings rows that hold it,
 * how they are read back, and the two URLs derived from them.
 *
 * This module and ./secrets sit below every other mobile module on purpose.
 * The credential store deliberately names its own two legacy settings rows
 * rather than importing this table, because a cycle between configuration and
 * credentials would leave one of the two half-initialised at the moment the
 * other read it — and that failure surfaces at runtime as an undefined
 * settings key, not as a compile error.
 */

export const DEFAULT_MOBILE_PORT = 47_831;

export const KEY = {
  dashboardEnabled: 'mobile_dashboard_enabled',
  remoteControlEnabled: 'mobile_remote_control_enabled',
  port: 'mobile_port',
  dashboardUrl: 'mobile_dashboard_url',
  pushEnabled: 'mobile_push_enabled',
  pushServer: 'mobile_push_server',
} as const;

export type MobileConfigPatch = Partial<MobileMonitorConfig>;

export function boolSetting(key: string, fallback = false): boolean {
  return getSetting(key, fallback ? '1' : '0') === '1';
}

export function portSetting(): number {
  const value = Number(getSetting(KEY.port, String(DEFAULT_MOBILE_PORT)));
  return Number.isInteger(value) && value >= 1_024 && value <= 65_535
    ? value
    : DEFAULT_MOBILE_PORT;
}

export function normaliseHttpsUrl(raw: string, label: string): string {
  const value = raw.trim();
  if (!value) return '';
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a complete HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS.`);
  if (parsed.username || parsed.password) throw new Error(`${label} cannot contain a username or password.`);
  if (parsed.search || parsed.hash) throw new Error(`${label} cannot contain a query string or fragment.`);
  return parsed.toString().replace(/\/+$/, '');
}

/** Read the persisted, non-secret monitor configuration. */
export function mobileConfig(): MobileMonitorConfig {
  return {
    dashboardEnabled: boolSetting(KEY.dashboardEnabled),
    remoteControlEnabled: boolSetting(KEY.remoteControlEnabled),
    port: portSetting(),
    dashboardUrl: getSetting(KEY.dashboardUrl, '').trim(),
    pushEnabled: boolSetting(KEY.pushEnabled),
    pushServer: getSetting(KEY.pushServer, 'https://ntfy.sh').trim(),
    pushTopic: ensurePushTopic(),
  };
}

export function localUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function dashboardBase(config: MobileMonitorConfig): string {
  const configured = config.dashboardUrl.trim();
  return configured ? `${configured.replace(/\/+$/, '')}/` : localUrl(config.port);
}
