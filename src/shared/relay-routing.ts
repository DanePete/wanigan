/** Operator policy for a Relay. Preferences never change acceptance gates. */
export type RelayRoutingMode = 'auto' | 'manual';
export type RelayRoutingPreference = 'cost' | 'balanced' | 'quality';
export type RelayRoutingSettings = { mode: RelayRoutingMode; preference: RelayRoutingPreference };

export const DEFAULT_RELAY_ROUTING: Readonly<RelayRoutingSettings> = { mode: 'auto', preference: 'cost' };

export const RELAY_ROUTING_PREFERENCES: readonly {
  value: RelayRoutingPreference; label: string; description: string;
}[] = [
  { value: 'cost', label: 'Lower cost', description: 'Prefer sufficient models and effort that avoid unnecessary spend and retries.' },
  { value: 'balanced', label: 'Balanced', description: 'Balance model capability, reasoning effort, and expected cost.' },
  { value: 'quality', label: 'Higher quality', description: 'Prefer more capability and reasoning headroom for difficult or uncertain work.' },
];

/** Renderer and API input is checked before any inference or database write. */
export function readRelayRouting(raw: unknown): RelayRoutingSettings {
  if (raw === undefined) return { ...DEFAULT_RELAY_ROUTING };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Relay routing must specify a mode and preference.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => key !== 'mode' && key !== 'preference')) throw new Error('Unknown Relay routing setting.');
  if (value.mode !== 'auto' && value.mode !== 'manual') throw new Error('Choose Auto or Manual routing.');
  if (value.preference !== 'cost' && value.preference !== 'balanced' && value.preference !== 'quality') {
    throw new Error('Choose Lower cost, Balanced, or Higher quality routing.');
  }
  return { mode: value.mode, preference: value.preference };
}
