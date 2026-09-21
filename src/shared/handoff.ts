/**
 * Continuing one conversation on another account of the same harness.
 *
 * Types only, in shared rather than beside the implementation, because the
 * preload surface names them and the renderer must not reach into src/main —
 * importing the module for its types alone is enough to pull the main process
 * into the renderer's project.
 */

/**
 * How the other account comes to be able to continue the conversation.
 *
 * `link`: Codex. The rollout file is hardlinked into the other account's home,
 * and that account resumes the same conversation id.
 *
 * `fork`: Claude Code. Nothing is written to either account's directory ahead
 * of time. The other account is launched with `--resume <transcript path>
 * --fork-session`, reads the original transcript where it lies, and writes the
 * continuation as a new conversation under its own directory.
 */
export type HandoffMethod = 'link' | 'fork';

export type HandoffTarget = {
  accountId: string;
  label: string;
  configDir: string;
  /** Already reachable from that account, so handing it over would be a no-op. Always false for a fork. */
  alreadyThere: boolean;
};

export type HandoffPlan = {
  /** Which mechanism this harness uses, or null when there is nothing to offer. */
  method: HandoffMethod | null;
  /** Null when this session has no conversation recorded yet. */
  threadId: string | null;
  /** The account the conversation is filed under, when Wanigan resolved one. */
  fromAccountId: string | null;
  targets: readonly HandoffTarget[];
  /** Why there is nothing to offer, for a surface that must not show a dead control. */
  unavailable: string | null;
};

export type HandoffResult = {
  threadId: string;
  accountId: string;
  method: HandoffMethod;
  /**
   * Where the other account reads the conversation from: the linked copy in its
   * own home for `link`, the original transcript for `fork`.
   */
  linkedTo: string;
  /** True when the bytes are shared rather than duplicated. False for a fork, which shares nothing. */
  hardlinked: boolean;
};
