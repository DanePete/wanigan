/** Delivery follows the goal's human review without changing that goal's graph. */
export type RelayDeliveryKind = 'commit' | 'deploy';
export type RelayDeliveryStatus = 'pending' | 'running' | 'completed' | 'failed' | 'interrupted';
export type RelayDeployConfig = { command: string; timeoutMs: number; updatedAt: number | null };
export type RelayDeliveryAttempt = {
  id: string;
  kind: RelayDeliveryKind;
  status: Exclude<RelayDeliveryStatus, 'pending'>;
  startedAt: number;
  endedAt: number | null;
  checkout: string;
  head: string;
  files: string[];
  trailers: string[];
  command: string | null;
  commitHash: string | null;
  message: string | null;
  exitCode: number | null;
  output: string;
  error: string | null;
};
export type RelayDeliveryStage = {
  kind: RelayDeliveryKind;
  status: RelayDeliveryStatus;
  detail: string | null;
  attempts: RelayDeliveryAttempt[];
  receipt: RelayDeliveryAttempt | null;
};
export type RelayDeliveryRead = { commit: RelayDeliveryStage; deploy: RelayDeliveryStage; config: RelayDeployConfig };
export type RelayDeliveryPreview = {
  kind: RelayDeliveryKind;
  token: string;
  expiresAt: number;
  checkout: string;
  head: string;
  files: string[];
  message: string;
  trailers: string[];
  command: string | null;
  timeoutMs: number;
  existingCommit: boolean;
};
