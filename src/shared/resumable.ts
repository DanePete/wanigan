/**
 * Whether a recorded conversation id names a conversation that exists.
 *
 * Wanigan chooses the Claude CLI's conversation id itself and passes it as
 * `--session-id`, which is what makes a specific session resumable later rather
 * than "the most recent one". The cost of choosing it is that the id exists
 * before the conversation does: the CLI files
 * `$CLAUDE_CONFIG_DIR/projects/<slug>/<id>.jsonl` when the session takes its
 * first turn, and a session that exits without one leaves the id naming
 * nothing. `claude --resume` then answers "No conversation found with session
 * ID" and exits 1.
 *
 * Wanigan already models this for Codex, which reports its thread id only
 * after its first prompt — so a null id there is the signal, and `control.ts`
 * has called that `identity_pending` since before this file existed. A minted
 * id is never null, so that signal could not fire for Claude, and a row whose
 * conversation was never created reported `exact`.
 *
 * This is the predicate both surfaces read. It is pure: whether a file is on
 * disk is a question for the main process, and the answer arrives here as
 * evidence. Keeping it that way is what lets it answer in `test:shared` in
 * under a second against the exact row that failed.
 */

export type ConversationEvidence = {
  /** The harness that produced the row: `claude-code`, `codex`, `provider:…`. */
  harness: string;
  /** The id Wanigan recorded for the conversation, if it recorded one. */
  conversationId: string | null;
  /**
   * The harness's own transcript for exactly this id is on disk now. Exactly
   * this id: the newest file in the same directory belongs to some other
   * conversation and proves nothing about this one.
   */
  transcriptOnDisk: boolean;
  /** Wanigan archived its own copy of this session's transcript when it ended. */
  transcriptArchived: boolean;
};

export type ResumeReason =
  | 'transcript_present'
  | 'identity_reported'
  | 'no_identity'
  | 'never_turned'
  | 'transcript_gone';

export type ConversationProof =
  | { resumable: true; reason: Extract<ResumeReason, 'transcript_present' | 'identity_reported'> }
  | {
    resumable: false;
    reason: Extract<ResumeReason, 'no_identity' | 'never_turned' | 'transcript_gone'>;
    /** What is missing, in a sentence the surface can show unedited. */
    detail: string;
  };

/**
 * True for a harness whose conversation id Wanigan chose at launch.
 *
 * A harness id, not a profile id: GLM runs the same CLI under its own profile
 * and is filed under the same harness, and a provider pack that declares
 * `claude-code` gets the same treatment for the same reason. Anything else
 * reports an id it already has, so the id's presence is the proof and its
 * absence is already `no_identity`.
 */
export function mintsIdentityAtLaunch(harness: string): boolean {
  return harness === 'claude-code';
}

export function conversationProof(evidence: ConversationEvidence): ConversationProof {
  const { conversationId, harness, transcriptOnDisk, transcriptArchived } = evidence;
  if (!conversationId?.trim()) {
    return {
      resumable: false,
      reason: 'no_identity',
      detail: 'The provider has not yet reported a durable conversation identity.',
    };
  }
  if (!mintsIdentityAtLaunch(harness)) return { resumable: true, reason: 'identity_reported' };
  if (transcriptOnDisk) return { resumable: true, reason: 'transcript_present' };
  if (transcriptArchived) {
    // Wanigan's archive is a copy under its own data directory; the CLI reads
    // only its own. So the conversation happened and its evidence is intact —
    // what is gone is the file the CLI would reopen.
    return {
      resumable: false,
      reason: 'transcript_gone',
      detail: 'This conversation has been recorded, but the harness no longer holds the transcript it '
        + 'would reopen. Its transcript and evidence stay searchable in Wanigan.',
    };
  }
  return {
    resumable: false,
    reason: 'never_turned',
    detail: 'This session ended before it took a turn, so the harness never created the conversation. '
      + 'Start a new session instead — there is nothing recorded to continue.',
  };
}
