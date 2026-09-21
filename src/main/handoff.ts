/**
 * Continuing one conversation on another account.
 *
 * An account is a configuration directory — CODEX_HOME for Codex,
 * CLAUDE_CONFIG_DIR for Claude Code — and each harness writes a conversation
 * into the directory it was launched under. So a conversation started on the
 * account that has just run out of usage is, from the other account, not
 * merely locked — it is invisible. Reading solves that by scanning every
 * directory; launching cannot scan: it pins one.
 *
 * The two harnesses need different things from a handoff, and the plan says
 * which (`method`):
 *
 * Codex resumes by conversation id and looks for the rollout only under its
 * own home. What it needs is the rollout file and nothing else. That was
 * measured rather than assumed: a home containing one hardlinked rollout and no
 * `session_index.jsonl`, no `state_5.sqlite` and no other entry resumed the
 * conversation exactly as a home with all of them did. So a Codex handoff is
 * one directory entry, and on one volume a hardlink costs no bytes and no time.
 *
 * Claude Code accepts the absolute path of a transcript in place of an id
 * (`--resume <path>`), and with `--fork-session` writes the continuation as a
 * new conversation under whichever directory it was launched with. Measured on
 * 2026-09-21 with CLI 2.1.278: a transcript under one account's directory,
 * resumed by path under a second account's login, continued under that login
 * and filed its fork under the second directory, copying nothing into it and
 * writing nothing back to the first. So a Claude handoff writes nothing ahead
 * of time; the launch does the work, and this module only decides where the
 * transcript is and who else could read it.
 *
 * What this deliberately is not: T3 Code's shadow home, which symlinks a shared
 * `sessions/` between accounts so either may continue anything, or the
 * `--share-history` symlink of `projects/` that Claude account switchers offer.
 * Both make every account permanently able to read every conversation the
 * others ever had. This moves one named conversation, when asked, and leaves
 * the rest alone — which keeps the promise `SEEDABLE` already makes by refusing
 * to copy `sessions/` and `history.jsonl` into a new account.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as accounts from './accounts';
import { db } from './db';
import { codexRolloutFiles, codexThreadIdForSession } from './codex-sessions';
import { exactTranscriptPath } from './transcripts';
import type { AgentAccount } from '../shared/types';
import type { HandoffPlan, HandoffResult, HandoffTarget } from '../shared/handoff';

export type { HandoffMethod, HandoffPlan, HandoffResult, HandoffTarget } from '../shared/handoff';

const CODEX = 'codex';
const CLAUDE = 'claude-code';

type SessionRow = {
  harness_id: string | null;
  provider_id: string;
  conversation_id: string | null;
  project_path: string;
  worktree: string | null;
};

function sessionRow(sessionId: string): SessionRow | undefined {
  return db().prepare(`
    SELECT harness_id, provider_id, conversation_id, project_path, worktree
    FROM session_log WHERE id = ?
  `).get(sessionId) as SessionRow | undefined;
}

/** A conversation id is a UUID; nothing else is ever looked up as a file name. */
const CONVERSATION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/* ── Codex: link the rollout ────────────────────────────────────────── */

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
 * Whether one Codex conversation is readable from one account's home right now.
 *
 * This is the fact an exact resume under that account rests on, and a handoff
 * is precisely what changes it from no to yes. The resume path used to refuse
 * every account but the one the conversation was recorded under, so the
 * handoff linked the rollout into the other home and the resume that followed
 * was then refused for being under the other home: the feature could not
 * complete. Asked of the filesystem rather than of a record, because a link a
 * person removed by hand is no longer a conversation Codex will find.
 */
export function readableFromAccount(threadId: string, accountId: string): boolean {
  const account = accounts.byId(accountId);
  if (!account || account.harness !== CODEX) return false;
  const source = rolloutFor(threadId);
  return !!source && reachableFrom(account.configDir, source);
}

function codexPlan(sessionId: string): HandoffPlan {
  const empty = { method: 'link' as const, threadId: null, fromAccountId: null, targets: [] as HandoffTarget[] };
  let rows: AgentAccount[];
  try { rows = accounts.list(CODEX); }
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
    return { ...empty, threadId, unavailable: 'Wanigan could not find this conversation on disk.' };
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
    method: 'link',
    threadId,
    fromAccountId: fromAccount?.id ?? null,
    targets,
    unavailable: targets.length ? null : 'No other Codex account can take this conversation.',
  };
}

function linkRollout(plan: HandoffPlan, target: HandoffTarget): HandoffResult {
  const threadId = plan.threadId!;
  const source = rolloutFor(threadId);
  if (!source) throw new Error('Wanigan could not find this conversation on disk.');
  const destination = destinationFor(target.configDir, source);
  if (!destination) throw new Error('This conversation is not filed where Codex keeps its sessions.');

  const done = (hardlinked: boolean): HandoffResult =>
    ({ threadId, accountId: target.accountId, method: 'link', linkedTo: destination, hardlinked });
  if (target.alreadyThere) return done(true);

  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    // EXDEV: the two homes are on different volumes, which is unusual but
    // allowed — an account directory only has to sit under home or Wanigan's
    // own data directory, and those can differ. A copy is correct, just not
    // free; a rollout can be hundreds of megabytes.
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'EEXIST') return done(true);
    if (code !== 'EXDEV') throw error;
    fs.copyFileSync(source, destination);
    return done(false);
  }
  return done(true);
}

/* ── Claude Code: fork from the transcript ──────────────────────────── */

function physical(p: string): string {
  const resolved = path.resolve(p);
  try { return fs.realpathSync.native(resolved); } catch { return resolved; }
}

/** Whether `file` lies somewhere under `dir`, comparing physical paths. */
export function within(dir: string, file: string): boolean {
  const rel = path.relative(physical(dir), physical(file));
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * The account whose directory holds this transcript, or null.
 *
 * Read from the filesystem rather than from the session row's `account_id`:
 * the row says which account launched the session, and that is usually the
 * same answer, but a transcript is a file and the account that can no longer
 * be found on disk is not one anybody can resume under.
 */
export function transcriptOwner(rows: readonly AgentAccount[], transcript: string): AgentAccount | null {
  return rows.find((row) => within(row.configDir, transcript)) ?? null;
}

function claudePlan(row: SessionRow): HandoffPlan {
  const empty = { method: 'fork' as const, threadId: null, fromAccountId: null, targets: [] as HandoffTarget[] };
  let rows: AgentAccount[];
  try { rows = accounts.list(CLAUDE); }
  catch { return { ...empty, unavailable: 'Wanigan could not read its account list.' }; }
  if (rows.length < 2) {
    return { ...empty, unavailable: 'There is only one Claude Code account to run this on.' };
  }

  const threadId = row.conversation_id?.trim() ?? '';
  if (!CONVERSATION_ID.test(threadId)) {
    return { ...empty, unavailable: 'This session has not recorded a Claude Code conversation yet.' };
  }
  const source = exactTranscriptPath(threadId, row.worktree ?? row.project_path);
  if (!source) {
    return { ...empty, threadId, unavailable: 'Wanigan could not find this conversation’s transcript on disk.' };
  }

  // Every other Claude account can read the file by path, so every other
  // account is a target — there is no "already there" for a fork, because
  // the fork does not exist until the launch makes it.
  const fromAccount = transcriptOwner(rows, source);
  const targets = rows
    .filter((row) => row.id !== fromAccount?.id)
    .map((row) => ({ accountId: row.id, label: row.label, configDir: row.configDir, alreadyThere: false }));

  return {
    method: 'fork',
    threadId,
    fromAccountId: fromAccount?.id ?? null,
    targets,
    unavailable: targets.length ? null : 'No other Claude Code account can take this conversation.',
  };
}

/* ── the surface ─────────────────────────────────────────────────────── */

/**
 * What a session could be continued on, and why not when it could not.
 *
 * Read-only. It answers for a surface that has to decide whether to offer a
 * control at all, so every refusal carries its reason rather than an empty list
 * that reads as "no other accounts".
 */
export function handoffPlan(sessionId: string): HandoffPlan {
  const empty = { method: null, threadId: null, fromAccountId: null, targets: [] as HandoffTarget[] };
  const row = sessionRow(sessionId);
  if (!row) return { ...empty, unavailable: 'Wanigan has no record of this session.' };
  const harness = row.harness_id ?? row.provider_id;
  if (harness === CODEX) return codexPlan(sessionId);
  if (harness === CLAUDE) return claudePlan(row);
  return { ...empty, unavailable: 'Wanigan cannot continue this harness’s conversations on another account.' };
}

/**
 * Make one conversation resumable under another account.
 *
 * The source is never written to, moved or removed: after this the conversation
 * is readable from both accounts, and the account it started on can still
 * continue it. That matters because the reason for doing this at all is usually
 * that one account is out of usage for a while, not for good.
 *
 * For Claude Code this writes nothing: the launch that follows resumes from the
 * transcript's path and forks. The result still names where the other account
 * will read from, so the caller and the tests can see the same fact.
 */
export function handoffConversation(sessionId: string, toAccountId: string): HandoffResult {
  const plan = handoffPlan(sessionId);
  if (!plan.threadId || !plan.method) throw new Error(plan.unavailable ?? 'This session has no conversation to hand over.');

  const target = plan.targets.find((row) => row.accountId === toAccountId);
  if (!target) {
    // The renderer named an account; main decides whether it is one of this
    // conversation's actual options, exactly as projects:add refuses a path.
    throw new Error('Choose one of this conversation’s own accounts.');
  }

  if (plan.method === 'link') return linkRollout(plan, target);

  const row = sessionRow(sessionId)!;
  const source = exactTranscriptPath(plan.threadId, row.worktree ?? row.project_path);
  if (!source) throw new Error('Wanigan could not find this conversation’s transcript on disk.');
  return { threadId: plan.threadId, accountId: toAccountId, method: 'fork', linkedTo: source, hardlinked: false };
}
