import os from 'node:os';
import { app } from 'electron';
import type {
  Attention,
  MobileFleetSession,
  MobileFleetSnapshot,
  Session,
  SessionUsage,
} from '../shared/types';
import { EMPTY_USAGE } from '../shared/types';

/**
 * The phone surface gets a deliberately smaller view of a session than the
 * trusted Electron renderer. In particular it never receives a project path,
 * pid, conversation id, worktree, terminal output, transcript, hook summary,
 * command, or file name. Those fields are useful at the keyboard and needless
 * in a pocket status board.
 */
export function mobileFleetSnapshot(
  sessions: Session[],
  attention: Attention[],
  usage: Record<string, SessionUsage>,
  now = Date.now(),
): MobileFleetSnapshot {
  const byAttention = new Map(attention.map((value) => [value.sessionId, value]));
  const cards: MobileFleetSession[] = sessions.map((session) => {
    const a = byAttention.get(session.id) ?? {
      sessionId: session.id,
      kind: session.status === 'exited' ? 'finished' : 'idle',
      transitionId: `fallback:${session.status}:${session.endedAt ?? session.createdAt}`,
      since: session.endedAt ?? session.createdAt,
      label: session.status === 'exited' ? 'Done' : 'Idle',
      detail: null,
      tool: null,
    } satisfies Attention;
    const u = usage[session.id] ?? { sessionId: session.id, ...EMPTY_USAGE };
    return {
      id: session.id,
      projectName: session.projectName,
      title: session.title,
      providerId: session.providerId,
      model: session.model ?? null,
      status: session.status,
      createdAt: session.createdAt,
      endedAt: session.endedAt,
      attention: { kind: a.kind, label: a.label, since: a.since },
      usage: {
        costUsd: u.costUsd,
        costStatus: u.costStatus,
        inTokens: u.inTokens,
        outTokens: u.outTokens,
        linesAdded: u.linesAdded,
        linesRemoved: u.linesRemoved,
        requests: u.requests,
        errors: u.errors,
        lastAt: u.lastAt,
      },
    };
  });

  const totals = cards.reduce<MobileFleetSnapshot['totals']>((value, card) => {
    value.costUsd += card.usage.costUsd;
    if (card.usage.costStatus === 'unavailable') value.costUnavailable = true;
    value.inTokens += card.usage.inTokens;
    value.outTokens += card.usage.outTokens;
    value.linesAdded += card.usage.linesAdded;
    value.linesRemoved += card.usage.linesRemoved;
    value.requests += card.usage.requests;
    value.errors += card.usage.errors;
    value[card.attention.kind] += 1;
    if (card.status !== 'exited') value.running += 1;
    return value;
  }, {
    sessions: cards.length,
    running: 0,
    permission: 0,
    error: 0,
    finished: 0,
    idle: 0,
    working: 0,
    costUsd: 0,
    costUnavailable: false,
    inTokens: 0,
    outTokens: 0,
    linesAdded: 0,
    linesRemoved: 0,
    requests: 0,
    errors: 0,
  });

  const order = new Map([
    ['permission', 0], ['error', 1], ['finished', 2], ['idle', 3], ['working', 4],
  ]);
  cards.sort((a, b) =>
    (order.get(a.attention.kind) ?? 99) - (order.get(b.attention.kind) ?? 99)
      || a.attention.since - b.attention.since
      || a.id.localeCompare(b.id));

  return {
    generatedAt: now,
    host: os.hostname(),
    version: app.getVersion(),
    totals,
    sessions: cards,
  };
}
