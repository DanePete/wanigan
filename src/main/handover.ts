/**
 * Carrying a conversation into a fresh one when its window fills.
 *
 * Two halves, because the wait between them belongs to the renderer: `Stop`
 * already arrives there on the session-event stream, and main keeps no listener
 * of its own on that path. `begin` writes the prompt; the renderer waits for
 * that session's Stop; `finish` reads what the agent wrote and launches.
 *
 * What the split must not cost is the thing that makes it safe: the renderer
 * never supplies the note. It names a session, and main reads the text out of
 * that session's own live transcript — so no surface can launch a session
 * carrying a blob it composed, any more than it can register a project by
 * naming a path.
 *
 * The old session is never killed, interrupted, or touched beyond the one
 * prompt. A full context window is not a failure, and that conversation stays
 * the record of how the work reached here.
 */
import { HANDOVER_PROMPT, handoverSeed } from '../shared/context-handover';
import { createSession, listSessions, writeSession } from './sessions';
import { lastAssistantTurn } from './transcripts';
import type { Session } from '../shared/types';

import type { HandoverBegun, HandoverFinished } from '../shared/handover';

export type { HandoverBegun, HandoverFinished } from '../shared/handover';

function liveSession(sessionId: string): Session {
  const session = listSessions().find((row) => row.id === sessionId);
  if (!session) throw new Error('That session is no longer running.');
  if (session.status === 'exited') {
    throw new Error('That session has ended, so there is nothing to carry across from it.');
  }
  return session;
}

/**
 * Ask the agent for a handover note.
 *
 * Submitted, unlike an attachment reference: this is Wanigan's own question
 * rather than a prompt somebody was in the middle of writing, and it is asked
 * because they clicked a button that says so. The trailing newline is the
 * click.
 */
export function beginHandover(sessionId: string): HandoverBegun {
  const session = liveSession(sessionId);
  if (!writeSession(session.id, `${HANDOVER_PROMPT}\r`)) {
    throw new Error('Wanigan could not reach that session to ask for a handover note.');
  }
  return { sessionId: session.id, prompt: HANDOVER_PROMPT };
}

/**
 * Read what the agent wrote and open the fresh session with it.
 *
 * Three outcomes, kept apart because they need different sentences. A note that
 * carries; an answer with nothing usable in it, which is not a failure and
 * leaves the operator free to start blank; and a transcript that could not be
 * read at all, which is a different thing from an empty one and must not be
 * reported as though the agent had said nothing.
 */
export async function finishHandover(sessionId: string): Promise<HandoverFinished> {
  const session = liveSession(sessionId);

  let note: string | null;
  try {
    note = lastAssistantTurn(session.projectPath, session.conversationId ?? null);
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: `Wanigan could not read this conversation's transcript: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!note) {
    return { kind: 'empty', reason: 'The agent did not write a handover note.' };
  }

  // Same project, provider and account: a handover changes the conversation,
  // never where the work happens or who it runs as.
  const next = await createSession({
    providerId: session.providerId,
    projectId: session.projectId,
    accountId: session.accountId ?? null,
    model: session.model || undefined,
    initialPrompt: handoverSeed(note),
  });
  return { kind: 'carried', session: next, noteChars: note.length };
}
