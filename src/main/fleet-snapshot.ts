import os from 'node:os';
import { app } from 'electron';
import * as accounts from './accounts';
import type {
  Attention,
  MobileFleetSession,
  MobileFleetSnapshot,
  Session,
  SessionUsage,
} from '../shared/types';
import { EMPTY_USAGE } from '../shared/types';

/**
 * Which login a session is signed in as, for an operator holding a phone and
 * unable to open Settings.
 *
 * The id is a grouping key: no remote-control route accepts one, and nothing on
 * the phone can launch a session under a named account. The label is the same
 * string the desktop stamps on a session row. Neither is a credential, and the
 * account's config directory — the thing that actually selects the login, and
 * the only part of an account worth stealing — deliberately stays behind. On
 * this wire an account is an identity and nothing more.
 */
export type MobileFleetAccount = { id: string | null; label: string };

/** A phone fleet row, plus the account it is signed in as. */
export type MobileFleetSessionWithAccount = MobileFleetSession & { account: MobileFleetAccount };

/**
 * The snapshot this module builds. Still a MobileFleetSnapshot everywhere one
 * is expected — the account is added to the rows, nothing is taken away — but
 * named so the privacy rebuild in mobile/snapshot.ts, which is the only thing
 * that decides what actually reaches a phone, can see the field it is being
 * offered rather than reading it back off an untyped record.
 */
export type MobileFleetSnapshotWithAccounts =
  Omit<MobileFleetSnapshot, 'sessions'> & { sessions: MobileFleetSessionWithAccount[] };

/**
 * Two absences, told apart, in the words usage.ts already uses.
 *
 * A session with no recorded account either predates accounts or ran on a
 * profile that has none — one fact, and one label. A session that names an
 * account Wanigan no longer has is a different fact, and reporting it as blank
 * would read as the first one. Keep both in step with labelFor() in usage.ts,
 * so the same session does not read one way on the Usage screen and another way
 * on the phone.
 */
const NO_ACCOUNT = 'No account';
const REMOVED_ACCOUNT = 'Removed account';

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
): MobileFleetSnapshotWithAccounts {
  const byAttention = new Map(attention.map((value) => [value.sessionId, value]));
  // Read once per snapshot rather than once per row, and only when a row names
  // an account at all: the phone polls this on a timer, and reading an account
  // stats its directory to decide whether it is still present.
  //
  // Guarded because everything else here is built from in-memory state a poll
  // cannot fail on. A database Wanigan cannot read must not take the whole
  // status board down over a name.
  let known: Map<string, string> | null = null;
  if (sessions.some((session) => session.accountId)) {
    try {
      known = new Map(accounts.listAll().map((account) => [account.id, account.label]));
    } catch {
      known = null;
    }
  }
  const accountOf = (session: Session): MobileFleetAccount => {
    const id = session.accountId ?? null;
    if (!id) return { id: null, label: NO_ACCOUNT };
    if (!known) {
      // The account table could not be read, so whether it was removed is
      // unknown and claiming removal would be an invention. What the session
      // froze at launch is still the account it authenticated as; the id is the
      // last resort resumeAccountFor() names an account by for the same reason.
      return { id, label: session.accountLabel || id };
    }
    // The launch freezes which account, not what it is called. A rename is the
    // operator renaming their own login, so the current label is the name they
    // would find in Settings; the frozen id is what identifies it.
    return { id, label: known.get(id) ?? REMOVED_ACCOUNT };
  };
  const cards: MobileFleetSessionWithAccount[] = sessions.map((session) => {
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
      account: accountOf(session),
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
