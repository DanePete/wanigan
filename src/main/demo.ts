import { getSetting, setSetting } from './settings';
import type { DemoState } from '../shared/demo';

/** Stored intent only. Each window freezes its privacy boundary at creation. */
export function demoOn(): boolean {
  return getSetting('demo_mode', '0') === '1';
}

export function setDemo(on: unknown): boolean {
  if (typeof on !== 'boolean') throw new Error('Demo mode is either on or off.');
  setSetting('demo_mode', on ? '1' : '0');
  return on;
}

/** No real-to-fake map: this answer contains no personal data. */
export function demoState(on = demoOn()): DemoState {
  return { on, source: on ? 'fictional' : 'live' };
}
