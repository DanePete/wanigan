import type { WaniganModule } from '../module-registry';

/** Owns the consent, backend routing and metering boundary for learning calls.
 * Existing learning schema and public callers keep their compatibility facade. */
export const learningModelAssistModule: WaniganModule = {
  id: 'learning-model-assist',
  label: 'Model assistance',
  required: { reason: 'Enforces consent, backend routing and observed metering before learning can invoke a model.' },
};
