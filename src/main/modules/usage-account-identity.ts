import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AccountLimits, AgentAccount } from '../../shared/types';

/** The actual state-file convention follows accounts.launchEnv: default Claude
 * reads its sibling file; an explicit CLAUDE_CONFIG_DIR reads inside it. */
function claudeStateFile(account: AgentAccount): string {
  return account.configDir === path.join(os.homedir(), '.claude')
    ? `${account.configDir}.json` : path.join(account.configDir, '.claude.json');
}

function canonicalDirectory(account: AgentAccount): string | null {
  try { return fs.statSync(account.configDir).isDirectory() ? fs.realpathSync(account.configDir) : null; } catch { return null; }
}

/** A login change invalidates a cached reading without reading any credential.
 * Missing files are a stable state too (including OS credential-store users). */
export function usageAccountRevision(account: AgentAccount): string {
  const files = account.harness === 'codex'
    ? [path.join(account.configDir, 'auth.json'), path.join(account.configDir, 'config.toml')]
    : [path.join(account.configDir, '.credentials.json')];
  const states = files.map((file) => {
    try {
      const stat = fs.statSync(file);
      return [file, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    } catch { return [file, null]; }
  });
  return createHash('sha256').update(JSON.stringify([
    account.id, account.configDir, canonicalDirectory(account), states, savedLogin(account),
  ])).digest('hex');
}

/** Whether a file stat can witness this account's login changing. Codex may
 * keep credentials in the OS keyring (`cli_auth_credentials_store`), where a
 * save deletes auth.json and a later login touches no file at all. Only the
 * ordinary config file is read, never a credential. An administrator can
 * enforce a store this file does not show, so true means "as configured". */
export function usageLoginWitnessed(account: AgentAccount): boolean {
  if (account.harness !== 'codex') return true;
  try {
    const config = fs.readFileSync(path.join(account.configDir, 'config.toml'), 'utf8');
    const mode = /^\s*cli_auth_credentials_store\s*=\s*["']([a-z]+)["']/m.exec(config)?.[1];
    return mode === undefined || mode === 'file';
  } catch { return true; }
}

function savedLogin(account: AgentAccount): string | null {
  if (account.harness !== 'claude-code') return null;
  // Only ordinary Claude account metadata, never .credentials.json, Keychain,
  // or Codex auth.json. Email/plan/percentage equality cannot establish a match.
  let fd: number | undefined;
  try {
    // A FIFO can wait indefinitely during open, before the descriptor can be
    // checked. Nonblocking open lets the ordinary-file guard reject it below.
    fd = fs.openSync(claudeStateFile(account), fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const bytes = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > stat.size) return null;
    const raw: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const oauth = (raw as Record<string, unknown>).oauthAccount;
    if (!oauth || typeof oauth !== 'object') return null;
    const { accountUuid, organizationUuid } = oauth as Record<string, unknown>;
    if (typeof accountUuid !== 'string' || !accountUuid.trim()
      || typeof organizationUuid !== 'string' || !organizationUuid.trim()) return null;
    return createHash('sha256').update(JSON.stringify([account.harness, accountUuid, organizationUuid])).digest('hex');
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Comparison keys never leave main. A saved login match stays labelled saved,
 * even when its owner is currently signed out or the live probe failed. */
export function withUsageIdentityEvidence(rows: AccountLimits[], accounts: AgentAccount[]): AccountLimits[] {
  const evidence = accounts.map((account) => ({
    account, directory: canonicalDirectory(account), login: savedLogin(account),
  }));
  return rows.map((row) => {
    const mine = evidence.find(({ account }) => account.id === row.accountId);
    const sharedWith: NonNullable<AccountLimits['identityEvidence']>['sharedWith'] = [];
    if (mine) for (const other of evidence) {
      if (other.account.id === row.accountId || other.account.harness !== row.harness) continue;
      const basis = mine.directory && mine.directory === other.directory ? 'configuration-directory'
        : mine.login && mine.login === other.login ? 'saved-login' : null;
      if (basis) sharedWith.push({ accountId: other.account.id, accountLabel: other.account.label, basis });
    }
    return { ...row, identityEvidence: { sharedWith } };
  });
}
