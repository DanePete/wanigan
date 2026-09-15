import { db } from './db';
import * as accounts from './accounts';
import { flags } from './settings';
import { providerById } from './providers';
import { listSessions } from './sessions';
import {
  envNames, resolveLaunchProvenance, type LaunchOrigin, type LaunchProvenanceInput, type LaunchValue,
} from '../shared/launch-provenance';
import type { LaunchOptions, Session } from '../shared/types';

/**
 * Where a live session's launch values came from, kept from the moment of
 * launch. The renderer's own launches record it at the IPC boundary, where the
 * options that were sent and the session that resulted are both in hand. A
 * session started elsewhere — a phone, an autopilot, Wanigan's MCP server — is
 * answered from its frozen snapshot, and anything that snapshot cannot place is
 * labelled as unrecorded rather than guessed.
 */

/** What Wanigan itself sets in every agent's environment (sessions.ts agentEnv). */
function waniganEnvNames(): string[] {
  const names = ['CLAUDE_CODE_FORCE_SESSION_PERSISTENCE', 'COLORTERM', 'FORCE_COLOR', 'PATH', 'TERM'];
  let telemetry = false;
  try { telemetry = flags().telemetry; } catch { telemetry = false; }
  if (telemetry) names.push('OTEL_* (telemetry)');
  return names;
}

export function envNamesFor(providerId: unknown, harness?: string | null): LaunchProvenanceInput['env'] {
  const def = typeof providerId === 'string' ? providerById(providerId) : null;
  let provider: string[] = [];
  try { provider = envNames(def?.env?.()); } catch { provider = []; }
  const h = harness ?? def?.harness ?? null;
  return { provider, account: h ? accounts.configEnvVar(h) : null, wanigan: waniganEnvNames() };
}

function inputFrom(session: Session, origin: LaunchOrigin, opts: Partial<LaunchOptions> | null): LaunchProvenanceInput {
  const def = providerById(session.providerId);
  const fields = session.providerProfile?.launchFields ?? [];
  const defaultOf = (id: string) => {
    const value = fields.find((f) => f.id === id)?.defaultValue;
    return typeof value === 'string' ? value : null;
  };
  const supports = session.providerProfile?.supports ?? def?.supports ?? { model: true, effort: true, permissionMode: true, resume: true };
  const harness = session.harnessId ?? def?.harness ?? null;
  let accountSource: LaunchProvenanceInput['account']['source'] = 'none';
  let reason: string | null = null;
  if (session.accountId) {
    if (origin === 'resume') accountSource = 'resumed';
    else if (opts?.accountId) accountSource = 'explicit';
    else if (harness) {
      try {
        const resolved = accounts.resolve({ harness, projectId: session.projectId });
        accountSource = resolved.account?.id === session.accountId && resolved.source !== 'explicit' ? resolved.source : 'explicit';
      } catch { accountSource = 'explicit'; }
    }
  } else {
    reason = 'no Wanigan account applies to this profile';
  }
  return {
    origin,
    provider: { label: session.providerProfile?.label ?? def?.label ?? session.providerId, packSource: def?.source ?? null, packLabel: session.providerPackId ?? null },
    harness,
    fields: {
      model: { supported: supports.model, value: session.model ?? null, profileDefault: defaultOf('model') },
      effort: { supported: supports.effort, value: session.effort ?? null, profileDefault: defaultOf('effort') },
      permissionMode: { supported: supports.permissionMode, value: session.permissionMode ?? null, profileDefault: defaultOf('permissionMode') },
    },
    account: { label: session.accountLabel ?? null, source: accountSource, reason },
    isolation: { isolated: Boolean(session.worktree), reusedWorktree: origin === 'resume' && Boolean(session.worktree) },
    extraArgs: typeof opts?.extraArgs === 'string' ? opts.extraArgs : null,
    env: envNamesFor(session.providerId, harness),
  };
}

/** Called by the renderer's launch handler with the options it sent and the session that resulted. */
export function recordLaunchProvenance(session: Session, opts: LaunchOptions): void {
  const origin: LaunchOrigin = opts.resumeFrom ? 'resume' : 'renderer';
  try {
    const rows = resolveLaunchProvenance(inputFrom(session, origin, opts));
    db().prepare('INSERT OR REPLACE INTO session_launch_provenance (session_id, at, origin, values_json) VALUES (?,?,?,?)')
      .run(session.id, Date.now(), origin, JSON.stringify(rows));
  } catch { /* provenance is evidence, never a launch dependency */ }
}

export function launchProvenanceFor(sessionId: unknown): { origin: LaunchOrigin; values: LaunchValue[] } | null {
  if (typeof sessionId !== 'string' || !sessionId) return null;
  const row = db().prepare('SELECT origin, values_json FROM session_launch_provenance WHERE session_id=?')
    .get(sessionId) as { origin: LaunchOrigin; values_json: string } | undefined;
  if (row) {
    try { return { origin: row.origin, values: JSON.parse(row.values_json) as LaunchValue[] }; } catch { /* fall through to the snapshot */ }
  }
  const session = listSessions().find((s) => s.id === sessionId);
  if (!session) return null;
  return { origin: 'unknown', values: resolveLaunchProvenance(inputFrom(session, 'unknown', null)) };
}
