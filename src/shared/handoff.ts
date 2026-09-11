/**
 * Continuing one conversation on another account of the same harness.
 *
 * Types only, in shared rather than beside the implementation, because the
 * preload surface names them and the renderer must not reach into src/main —
 * importing the module for its types alone is enough to pull the main process
 * into the renderer's project.
 */

export type HandoffTarget = {
  accountId: string;
  label: string;
  configDir: string;
  /** Already reachable from that account, so handing it over would be a no-op. */
  alreadyThere: boolean;
};

export type HandoffPlan = {
  /** Null when this session has no Codex conversation recorded yet. */
  threadId: string | null;
  /** The account the session runs under, when Wanigan resolved one. */
  fromAccountId: string | null;
  targets: readonly HandoffTarget[];
  /** Why there is nothing to offer, for a surface that must not show a dead control. */
  unavailable: string | null;
};

export type HandoffResult = {
  threadId: string;
  accountId: string;
  /** The path the conversation now also lives at. */
  linkedTo: string;
  /** True when the bytes are shared rather than duplicated. */
  hardlinked: boolean;
};
