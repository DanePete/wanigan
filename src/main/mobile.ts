/**
 * A private phone- and iPad-sized companion for the fleet. It is a monitor by
 * default; when the separately opt-in remote-control setting is enabled it
 * also provides an explicitly labeled, rate-limited agent console.
 *
 * This file is a facade. Every part of it lives in ./mobile: the credential
 * store and configuration at the bottom, one gated API dispatcher above them,
 * and the served page split into one module per screen. Nothing inside
 * ./mobile imports this file — that is what keeps the split free of cycles,
 * and it is why configuration and credentials moved out first.
 */

export type {
  MobileFleetSession,
  MobileFleetSnapshot,
  MobileMonitorConfig,
  MobileMonitorStatus,
} from '../shared/types';

export { DEFAULT_MOBILE_PORT, mobileConfig } from './mobile/config';
export type { MobileConfigPatch } from './mobile/config';

export { readableTerminal } from './mobile/terminal-text';

export { configureSnapshotSource } from './mobile/snapshot';

export { configureMobileControlSource } from './mobile/control';
export type { MobileControlSource } from './mobile/control';

// The repository review: the one route family that puts a file path on this
// wire, behind an opt-in of its own. The two pure functions are exported for the
// offline suite, which has to prove the caps refuse rather than truncate and has
// no cheap way to build a repository large enough to reach them.
export { MOBILE_REPO_LIMITS, numstatCounts, repoJson, repoReviewAllowed } from './mobile/git';
export type { MobileRepoCounts, MobileRepoFile, MobileRepoSummary } from './mobile/git';

export {
  mobileStatus,
  regenerateMobilePushTopic,
  regenerateMobileToken,
  setMobileConfig,
  startMobileMonitor,
  stopMobileMonitor,
} from './mobile/server';

export {
  MOBILE_PUSH_TIMEOUT_MS,
  lastMobilePushResult,
  sendMobilePush,
  testMobilePush,
} from './mobile/push';
export type { MobilePushInput, MobilePushResult } from './mobile/push';

export { MOBILE_SECTION_ANCHORS } from './mobile/page';
