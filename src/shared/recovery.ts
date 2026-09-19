/** Inspection separates execution, checkout exclusion and financial exposure. */
export type RecoveryExecution = 'owned/live' | 'confirmed finished' | 'unknown' | 'unsupported';
export type RecoveryObservation = {
  key: string;
  module: string;
  operationId: string;
  cwd: string | null;
  execution: RecoveryExecution;
  checkout: 'held' | 'not claimed';
  billing: 'independent' | 'unresolved';
  source: string;
  observedAt: number | null;
  reason: string;
  /** Exact bounded owner revisions/evidence; never prompts or command output. */
  revision: string;
  canReconcile: boolean;
};

export type RecoveryPreview = {
  token: string;
  expiresAt: number;
  generation: string;
  observation: RecoveryObservation;
  decision: string;
};

export type RecoveryInspection = {
  generation: string;
  storageMode: string;
  storageReason: string;
  unavailable?: string;
  storageOperation?: { id: string; phase: string; sourceGeneration: string; destinationGeneration: string;
    retainedDir: string; stagingDir: string; detail: string | null };
  observations: RecoveryObservation[];
  resolutions: { id: string; operationId: string; module: string; at: number; decision: string; generation: string }[];
};

export function reconciliationRefusal(observation: RecoveryObservation): string | null {
  if (observation.execution !== 'confirmed finished') return 'The owning runtime has not supplied sufficient completion evidence.';
  if (!observation.canReconcile) return 'This owner has no supported reconciliation for the recorded evidence.';
  return null;
}

export function recoveryReceiptCurrent(input: {
  now: number; expiresAt: number; expectedGeneration: string; generation: string;
  expectedRevision: string; revision: string;
}): boolean {
  return input.now < input.expiresAt && input.expectedGeneration === input.generation
    && input.expectedRevision === input.revision;
}
