import { attentionOf } from './attention';
import * as control from './control';
import { recordGoalTrace } from './goal-trace';
import { halted } from './halt';
import { onHookEvent } from './hooks';
import { listSessions, writeSession } from './sessions';
import {
  HANDBACK_LIMIT, failureExcerpt, handBackPrompt, handBackVerdict, pasteFrames,
} from '../shared/gate-feedback';
import type { Attention, DocketProof, GateProofDetail, Session, SessionEvent } from '../shared/types';

/**
 * Verified done: the review gate runs when a goal's agent says it has stopped.
 *
 * An agent ending its turn is a claim that the work is done. For a goal that
 * opted in, each Stop from an implementation or verification session runs the
 * project's review gate in that task's tree and records the result as a proof,
 * so "claimed" and "verified" are two separate facts on the task. The gate
 * runs asynchronously after the Stop rather than inside a blocking Stop hook:
 * a hook that waits minutes for a test suite would hit the CLI's hook timeout,
 * and the CLI would carry on as if nothing had been checked.
 *
 * A failed gate can be typed back into the session, if the goal also opted
 * into that. It starts another agent turn and so spends tokens, which is why
 * it is capped per task, refused over any session that has moved on since it
 * stopped, and refused once the goal's reported spend reaches its cap. The
 * rules are in shared/gate-feedback.ts, where they are tested.
 */

/** Stops that land inside this window fold into one gate run. */
const STOP_SETTLE_MS = 2_000;
/** How long a stop waits for a gate someone else is running on the same task. */
const BUSY_RETRY_MS = 5_000;
/** The Composer's pause between a bracketed paste and the Enter that submits it. */
const SUBMIT_DELAY_MS = 120;

type Pending = { timer: NodeJS.Timeout | null; running: boolean; again: SessionEvent | null };
const pending = new Map<string, Pending>();
let subscribed = false;
let changed: () => void = () => {};

/** Subscribes to the hook bus once. `onChange` tells the renderer a goal moved. */
export function initGoalGate(onChange: () => void): void {
  changed = onChange;
  if (subscribed) return;
  subscribed = true;
  onHookEvent((event) => {
    if (event.event === 'Stop') scheduleStopGate(event);
  });
}

function scheduleStopGate(event: SessionEvent, delayMs = STOP_SETTLE_MS): void {
  let target: control.StopGateTarget | null = null;
  try { target = control.stopGateTarget(event.sessionId); } catch { return; }
  if (!target) return;
  const nodeId = target.nodeId;
  const entry = pending.get(nodeId) ?? { timer: null, running: false, again: null };
  pending.set(nodeId, entry);
  // A stop that lands while the gate runs is kept, newest only, and runs after
  // it. If the agent changed nothing in between, that run is skipped as
  // unchanged, so keeping it costs one tree hash.
  if (entry.running) { entry.again = event; return; }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => { entry.timer = null; void drain(nodeId, event); }, delayMs);
  entry.timer.unref?.();
}

async function drain(nodeId: string, event: SessionEvent): Promise<void> {
  const entry = pending.get(nodeId);
  if (!entry) return;
  if (control.gateRunning(nodeId)) {
    // The operator pressed Run review gate first. Its tree may predate this
    // stop, so this one waits its turn instead of being dropped.
    entry.timer = setTimeout(() => { entry.timer = null; void drain(nodeId, event); }, BUSY_RETRY_MS);
    entry.timer.unref?.();
    return;
  }
  entry.running = true;
  try { await runStopGate(event); }
  catch (error) { console.warn('[wanigan] the gate an agent stop asked for failed:', error); }
  finally {
    entry.running = false;
    const next = entry.again;
    entry.again = null;
    if (next) scheduleStopGate(next, 0);
    else if (!entry.timer) pending.delete(nodeId);
  }
}

export type StopGateOutcome =
  | { ran: false; reason: 'not-gated' | 'halted' | 'unchanged' | 'refused'; detail: string | null }
  | { ran: true; proof: DocketProof; handBack: GateProofDetail['handBack'] };

/** What the hand-back reads and writes, so the smoke suite can stand in for a live PTY. */
export type HandBackDeps = {
  session: (sessionId: string) => Session | null;
  attention: (session: Session) => Pick<Attention, 'kind' | 'transitionId'>;
  write: (sessionId: string, data: string, internal?: { bracketedPaste?: boolean }) => boolean;
  wait: (ms: number) => Promise<void>;
};

const LIVE: HandBackDeps = {
  session: (sessionId) => listSessions().find((session) => session.id === sessionId) ?? null,
  attention: attentionOf,
  write: writeSession,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** One stop, handled now. Exported for the smoke suite; live stops come through the debounce above. */
export async function runStopGate(event: SessionEvent, deps: HandBackDeps = LIVE): Promise<StopGateOutcome> {
  const target = control.stopGateTarget(event.sessionId);
  if (!target) return { ran: false, reason: 'not-gated', detail: null };
  if (halted()) return { ran: false, reason: 'halted', detail: null };
  let run: Awaited<ReturnType<typeof control.runGateOnStop>>;
  try {
    // Started before the nudge so the task already reads as running a gate
    // when the renderer re-reads it.
    const started = control.runGateOnStop(target.nodeId);
    changed();
    run = await started;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    recordGoalTrace({
      sessionId: event.sessionId, source: 'gate', kind: 'gate_on_stop', status: 'failed', toolName: null,
      summary: `The agent stopped, and the review gate could not run: ${detail}`,
      durationMs: null, costUsd: 0, inTokens: 0, outTokens: 0,
    });
    changed();
    return { ran: false, reason: 'refused', detail };
  }
  if ('skipped' in run) { changed(); return { ran: false, reason: 'unchanged', detail: null }; }
  // Control calls a zero-exit run with stale checkout evidence 'recorded'.
  // It is neither verified done nor a failed command to hand back to an agent.
  if (run.proof.status !== 'failed' || !run.failing) { changed(); return { ran: true, proof: run.proof, handBack: null }; }
  const handBack = await handBackFailure(event, run.failing, deps);
  control.recordHandBack(run.proof.id, handBack);
  changed();
  // The proof as it now reads back, hand-back included, rather than as it was
  // before the hand-back was decided.
  return { ran: true, proof: run.proof.gate ? { ...run.proof, gate: { ...run.proof.gate, handBack } } : run.proof, handBack };
}

async function handBackFailure(
  event: SessionEvent, failing: NonNullable<control.GateRun['failing']>, deps: HandBackDeps,
): Promise<NonNullable<GateProofDetail['handBack']>> {
  // Read again: a gate can run for minutes, and in that time the task can be
  // completed, the goal can stop gating, or hand-back can be turned off.
  const target = control.stopGateTarget(event.sessionId);
  if (!target) {
    return { sent: false, attempt: null, sentence: 'The task finished, or its goal stopped gating, while the gate ran, so nothing was handed back.' };
  }
  const session = deps.session(event.sessionId);
  const attention = session ? deps.attention(session) : null;
  const verdict = handBackVerdict({
    enabled: target.returnFailures, halted: halted(), returnsSoFar: target.gateReturns,
    budgetUsd: target.budgetUsd, spendUsd: target.spendUsd, spendStatus: target.spendStatus,
    sessionStatus: session?.status ?? null,
    attention: attention ? { kind: attention.kind, transitionId: attention.transitionId } : null,
    stopEventId: event.id,
  });
  if (!verdict.send) return { sent: false, attempt: null, sentence: verdict.sentence };
  // Counted before anything is typed. A count that outlives a write the
  // session refused costs one hand-back that never arrived; the other order
  // could send one the cap never saw.
  if (!control.countHandBack(target.nodeId, event.sessionId, verdict.attempt)) {
    return { sent: false, attempt: null, sentence: 'Another hand-back for this task was counted first, so this one was not sent.' };
  }
  const excerpt = failureExcerpt(failing.output);
  const [paste, enter] = pasteFrames(handBackPrompt({ command: failing.command, exitCode: failing.exitCode, excerpt, attempt: verdict.attempt }));
  if (!deps.write(event.sessionId, paste, { bracketedPaste: true })) {
    return { sent: false, attempt: verdict.attempt, sentence: 'The session stopped accepting input before the failure could be typed, so nothing was sent. It still counts toward this task’s limit.' };
  }
  await deps.wait(SUBMIT_DELAY_MS);
  // The paste does not authorize a later Enter: a permission question, pause,
  // budget change or replacement session can arrive during the submit delay.
  // Keep the reserved count even when submission is refused; never clear input
  // in a terminal that may now belong to a different interaction.
  const unsent = (reason: string): NonNullable<GateProofDetail['handBack']> => ({
    sent: false, attempt: verdict.attempt,
    sentence: `The failure text was pasted but not submitted because ${reason}. It may remain in the terminal input. This hand-back still counts toward the task’s limit.`,
  });
  const current = control.stopGateTarget(event.sessionId);
  if (!current || current.nodeId !== target.nodeId || current.docketId !== target.docketId
    || current.gateReturns !== verdict.attempt) {
    return unsent('the task, goal gate or hand-back reservation changed before Enter');
  }
  const currentSession = deps.session(event.sessionId);
  const currentAttention = currentSession ? deps.attention(currentSession) : null;
  const submit = handBackVerdict({
    enabled: current.returnFailures, halted: halted(),
    // This is the already-counted reservation, not another hand-back request.
    returnsSoFar: verdict.attempt - 1,
    budgetUsd: current.budgetUsd, spendUsd: current.spendUsd, spendStatus: current.spendStatus,
    sessionStatus: currentSession?.status ?? null,
    attention: currentAttention,
    stopEventId: event.id,
  });
  if (!submit.send) {
    const reason = {
      off: 'hand-back was turned off', halted: 'Wanigan was halted',
      limit: 'the hand-back limit was reached', 'no-budget': 'the goal no longer has an automatic spending budget',
      cap: 'reported spend reached the budget', 'unknown-spend': 'a session has no reported cost',
      'session-gone': 'the session is no longer running', 'moved-on': 'the session moved on from the triggering stop',
    }[submit.reason];
    return unsent(reason);
  }
  if (!deps.write(event.sessionId, enter)) return unsent('the session refused Enter');
  const lines = `${excerpt.shownLines} line${excerpt.shownLines === 1 ? '' : 's'}`;
  recordGoalTrace({
    sessionId: event.sessionId, source: 'gate', kind: 'gate_hand_back', status: 'recorded', toolName: null,
    summary: `Typed the failed review gate back into the session (hand-back ${verdict.attempt} of ${HANDBACK_LIMIT}): the failing command and ${lines} of its output.`,
    durationMs: null, costUsd: 0, inTokens: 0, outTokens: 0,
  });
  return {
    sent: true, attempt: verdict.attempt,
    sentence: `Typed back into the session as hand-back ${verdict.attempt} of ${HANDBACK_LIMIT}: the failing command and ${lines} of its output.`,
  };
}
