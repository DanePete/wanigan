import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { WaniganModule } from '../module-registry';
import type { AgentAccount } from '../../shared/types';
import { db } from '../db';
import { readCodexStatus } from './usage-codex-status';
import { claudeAuthState } from './usage-claude-limits';
import { confirmsLogin, eligibilityVerdict, type EligibilityReading } from '../../shared/account-eligibility';

/**
 * Whether a named login may be used, asked at the moment of launch.
 *
 * Usage owns the readers and what they recorded. This owns the decision, and
 * it is required because the decision protects somebody's allowance: a module
 * that could redefine "this login may run unattended work" would empty the
 * refusal of meaning, and an optional one would take the refusal with it.
 *
 * Only account-native metadata is read. No thread or turn is started, no token
 * refreshed and no credit consumed. The stored row holds a digest of what the
 * provider reported about the login, never an email or a credential.
 */
function migrate(d: Database.Database): void {
  d.exec(`CREATE TABLE IF NOT EXISTS account_eligibility (
    account_id TEXT PRIMARY KEY,
    harness TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    auth_state TEXT NOT NULL,
    ordinary_usage_allowed INTEGER,
    failure TEXT,
    /* Moved only by an attended launch: a person present confirmed this login. */
    confirmed_login_digest TEXT,
    confirmed_at INTEGER
  )`);
}

const digest = (parts: (string | null | undefined)[]): string | null =>
  parts.some(Boolean) ? createHash('sha256').update(JSON.stringify(parts.map((part) => part ?? null))).digest('hex') : null;

const unverified = (failure: string): EligibilityReading =>
  ({ authState: 'unknown', requiresLogin: null, ordinaryUsageAllowed: null, loginDigest: null, failure: failure.slice(0, 300) });

/** One reading. The readers' own short caches make a fan-out over many
 * repositories one probe per account rather than one per repository. */
async function read(account: AgentAccount): Promise<EligibilityReading | null> {
  try {
    if (account.harness === 'codex') {
      const status = await readCodexStatus(false, account.id);
      return {
        authState: status.authState ?? 'unknown', requiresLogin: status.requiresOpenaiAuth ?? null,
        ordinaryUsageAllowed: status.ordinaryUsageAllowed ?? null, failure: null,
        // Plan is left out on purpose: an upgrade is not a different person.
        loginDigest: digest([status.backendAccountId, status.identity?.email]),
      };
    }
    if (account.harness === 'claude-code') {
      const auth = await claudeAuthState(account);
      if (auth.failure) return unverified(auth.failure);
      return {
        authState: auth.identity ? 'signed-in' : 'signed-out', requiresLogin: true, ordinaryUsageAllowed: null, failure: null,
        // The organisation's id where the CLI reports one: a renamed
        // organisation is the same login, and must not refuse a queue.
        loginDigest: auth.identity ? digest([auth.identity.email, auth.orgId ?? auth.identity.orgName]) : null,
      };
    }
    // No reader for this harness. That is not evidence about its login.
    return null;
  } catch (error) {
    return unverified(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Call before the synchronous part of a launch. Throws the refusal for
 * unattended work; returns what a person should be told otherwise. `account`
 * is null when no account applies to the profile, and then nothing is asked.
 */
export async function checkAccountEligibility(account: AgentAccount | null, options: { attended: boolean }): Promise<string[]> {
  if (!account) return [];
  const reading = await read(account);
  if (!reading) return [];
  const d = db();
  const prior = d.prepare('SELECT confirmed_login_digest AS digest FROM account_eligibility WHERE account_id=?')
    .get(account.id) as { digest: string | null } | undefined;
  const verdict = eligibilityVerdict({ reading, priorLoginDigest: prior?.digest ?? null, attended: options.attended, accountLabel: account.label });
  const confirmed = confirmsLogin({ attended: options.attended, reading });
  const now = Date.now();
  d.prepare(`INSERT INTO account_eligibility(account_id,harness,checked_at,auth_state,ordinary_usage_allowed,failure,confirmed_login_digest,confirmed_at)
    VALUES (@id,@harness,@now,@auth,@allowed,@failure,@digest,@confirmedAt)
    ON CONFLICT(account_id) DO UPDATE SET harness=excluded.harness, checked_at=excluded.checked_at, auth_state=excluded.auth_state,
      ordinary_usage_allowed=excluded.ordinary_usage_allowed, failure=excluded.failure,
      confirmed_login_digest=COALESCE(excluded.confirmed_login_digest, confirmed_login_digest),
      confirmed_at=COALESCE(excluded.confirmed_at, confirmed_at)`).run({
    id: account.id, harness: account.harness, now, auth: reading.authState, failure: reading.failure,
    allowed: reading.ordinaryUsageAllowed === null ? null : reading.ordinaryUsageAllowed ? 1 : 0,
    digest: confirmed ? reading.loginDigest : null, confirmedAt: confirmed ? now : null,
  });
  if (verdict.refusal) throw new Error(verdict.refusal);
  return verdict.notes;
}

export const accountEligibilityModule: WaniganModule = {
  id: 'account-eligibility', label: 'Account eligibility',
  required: { reason: 'Decides whether a named login may be used for a launch. A module that could redefine that would let unattended work spend an allowance nobody confirmed.' },
  migrate,
};
