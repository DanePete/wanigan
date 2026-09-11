/**
 * Continuing one conversation on another account.
 *
 * An account is a CODEX_HOME, and Codex writes a conversation into the home it
 * was launched under. So a thread started on the account that has just run out
 * of usage is, from the other account, not merely locked — it is invisible.
 * codex-sessions.ts already says this about reading ("a thread written under a
 * second account's home is invisible from the first"), and solves it there by
 * scanning every home. Launching cannot scan: it pins one home.
 *
 * What Codex needs to resume is the rollout file and nothing else. That was
 * measured rather than assumed: a home containing one hardlinked rollout and no
 * `session_index.jsonl`, no `state_5.sqlite` and no other entry resumed the
 * conversation exactly as a home with all of them did. So a handoff is one
 * directory entry, and on one volume a hardlink costs no bytes and no time.
 *
 * What this deliberately is not: T3 Code's shadow home, which symlinks a shared
 * `sessions/` between accounts so either may continue anything. That makes both
 * accounts permanently able to read every conversation the other ever had. This
 * moves one named conversation, when asked, and leaves the rest alone —
 * which keeps the promise `SEEDABLE` already makes by refusing to copy
 * `sessions/` and `history.jsonl` into a new account.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as accounts from './accounts';
import { codexRolloutFiles, codexThreadIdForSession } from './codex-sessions';
import type { AgentAccount } from '../shared/types';
import type { HandoffPlan, HandoffResult, HandoffTarget } from '../shared/handoff';

export type { HandoffPlan, HandoffResult, HandoffTarget } from '../shared/handoff';



/** Only Codex keeps a conversation as one self-contained file under its home. */
const HARNESS = 'codex';

/** This conversation's rollout, wherever it is readable from. */
function rolloutFor(threadId: string): string | null {
  return codexRolloutFiles([threadId]).get(threadId.toLowerCase()) ?? null;
}

/**
 * Where the file must appear inside another home.
 *
 * Codex files a rollout under `sessions/<year>/<month>/<day>/`, and resume finds
 * it by walking that tree — so the destination keeps the source's own date
 * directories rather than today's. Using today's would still resume, and would
 * quietly refile a conversation under the day it was moved.
 */
export function destinationFor(home: string, source: string): string | null {
  const parts = source.split(path.sep);
  const at = parts.lastIndexOf('sessions');
  if (at < 0 || parts.length - at < 2) return null;
  return path.join(home, ...parts.slice(at));
}

function reachableFrom(home: string, source: string): boolean {
  const target = destinationFor(home, source);
  if (!target) return false;
  try { return fs.statSync(target).isFile(); } catch { return false; }
}

/**
 * What a session could be continued on, and why not when it could not.
 *
 * Read-only. It answers for a surface that has to decide whether to offer a
 * control at all, so every refusal carries its reason rather than an empty list
 * that reads as "no other accounts".
 */
export function handoffPlan(sessionId: string): HandoffPlan {
  const empty = { threadId: null, fromAccountId: null, targets: [] as HandoffTarget[] };
  let rows: AgentAccount[];
  try { rows = accounts.list(HARNESS); }
  catch { return { ...empty, unavailable: 'Wanigan could not read its account list.' }; }
  if (rows.length < 2) {
    return { ...empty, unavailable: 'There is only one Codex account to run this on.' };
  }

  const threadId = codexThreadIdForSession(sessionId);
  if (!threadId) {
    return { ...empty, unavailable: 'This session has not recorded a Codex conversation yet.' };
  }
  const source = rolloutFor(threadId);
  if (!source) {
    return { threadId, fromAccountId: null, targets: [], unavailable: 'Wanigan could not find this conversation on disk.' };
  }

  const fromAccount = rows.find((row) => reachableFrom(row.configDir, source)) ?? null;
  const targets = rows
    .filter((row) => row.id !== fromAccount?.id)
    .map((row) => ({
      accountId: row.id,
      label: row.label,
      configDir: row.configDir,
      alreadyThere: reachableFrom(row.configDir, source),
    }));

  return {
    threadId,
    fromAccountId: fromAccount?.id ?? null,
    targets,
    unavailable: targets.length ? null : 'No other Codex account can take this conversation.',
  };
}


/**
 * Make one conversation resumable under another account.
 *
 * The source is never written to, moved or removed: after this the thread is
 * readable from both homes, and the account it started on can still continue it.
 * That matters because the reason for doing this at all is usually that one
 * account is out of usage for a while, not for good.
 */
export function handoffConversation(sessionId: string, toAccountId: string): HandoffResult {
  const plan = handoffPlan(sessionId);
  if (!plan.threadId) throw new Error(plan.unavailable ?? 'This session has no conversation to hand over.');

  const target = plan.targets.find((row) => row.accountId === toAccountId);
  if (!target) {
    // The renderer named an account; main decides whether it is one of this
    // conversation's actual options, exactly as projects:add refuses a path.
    throw new Error('Choose one of this conversation’s own accounts.');
  }

  const source = rolloutFor(plan.threadId);
  if (!source) throw new Error('Wanigan could not find this conversation on disk.');
  const destination = destinationFor(target.configDir, source);
  if (!destination) throw new Error('This conversation is not filed where Codex keeps its sessions.');

  if (target.alreadyThere) {
    return { threadId: plan.threadId, accountId: toAccountId, linkedTo: destination, hardlinked: true };
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  let hardlinked = true;
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    // EXDEV: the two homes are on different volumes, which is unusual but
    // allowed — an account directory only has to sit under home or Wanigan's
    // own data directory, and those can differ. A copy is correct, just not
    // free; a rollout can be hundreds of megabytes.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') {
      return { threadId: plan.threadId, accountId: toAccountId, linkedTo: destination, hardlinked: true };
    }
    if (code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    hardlinked = false;
  }
  return { threadId: plan.threadId, accountId: toAccountId, linkedTo: destination, hardlinked };
}
