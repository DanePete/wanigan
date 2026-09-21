import type { WaniganModule } from '../module-registry';

/** Owns the shared database connection without moving legacy table ownership. */
export const storageModule: WaniganModule = {
  id: 'storage',
  label: 'Storage',
  required: { reason: 'Owns the evidence database connection and preserves its lifecycle across app, scheduler and CLI.' },
};
