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
import * as accounts from './accounts';
import { providerById } from './providers';
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
 * The account the fresh session runs as.
 *
 * By default the one this session already runs as. The limit bubble offers a
 * roomier account instead — "Work is at 96% of its week limit, Personal has
 * room" — and until this existed the button under that sentence opened the new
 * session on the pressed account anyway, so the one thing the offer promised
 * was the thing it did not do. The id arrives from the renderer, so it has to
 * name an account Wanigan holds for the harness this session runs: a Codex
 * login cannot carry a Claude Code conversation, and an unknown id is refused
 * rather than silently replaced by the default.
 *
 * A handover opens a fresh conversation seeded with a note, never a resume, so
 * no transcript is being moved between accounts — which is what makes a change
 * of account safe here when it is not for an exact resume.
 */
function carryAccount(session: Session, requested: string | null): string | null {
  if (!requested || requested === session.accountId) return session.accountId ?? null;
  const account = accounts.byId(requested);
  const harness = providerById(session.providerId)?.harness ?? null;
  if (!account || !harness || account.harness !== harness) {
    throw new Error('That account does not run this session\u2019s agent, so the work was not carried there.');
  }
  return account.id;
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
export async function finishHandover(sessionId: string, toAccountId: string | null = null): Promise<HandoverFinished> {
  const session = liveSession(sessionId);
  // Before the transcript is read or anything launches: a refused account must
  // not cost a note that is then thrown away.
  const accountId = carryAccount(session, toAccountId);

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

  // Same project and provider: a handover changes the conversation, never where
  // the work happens. The account changes only when the operator took the
  // offer that named a different one.
  const next = await createSession({
    providerId: session.providerId,
    projectId: session.projectId,
    accountId,
    model: session.model || undefined,
    initialPrompt: handoverSeed(note),
  });
  return { kind: 'carried', session: next, noteChars: note.length };
}

/** For the smoke suite: the account rule, without a live PTY to hand over. */
export const __test = { carryAccount };
