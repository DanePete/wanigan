import { db } from './db';
import { contextForSession } from './policy';
import { redactCredentials } from './redact';
import { getSetting, setSetting } from './settings';
import { findGrant, grantKeyFor, GRANT_DAY_CHOICES, type GrantMatch, type StoredGrant } from '../shared/grants';
import type { GrantSetting, HookInput, SessionEvent } from '../shared/types';

/**
 * Grants: recording what a person approved in an attended session, and letting
 * an unattended run of the same project rely on it — only where the project
 * opted in, which by default none has.
 *
 * What counts as a person approving is observed rather than asked: a
 * PermissionRequest for a call, then that tool's PostToolUse in the same live,
 * attended session. A headless run's own calls never create grants; neither do
 * calls the gate allowed without asking, because nobody was asked.
 */

const PENDING_MS = 30 * 60_000;
const DEFAULT_DAYS = 7;
const pending = new Map<string, { at: number; input: HookInput; projectId: string; projectPath: string | null }>();

function settingKey(projectId: string): string {
  return `policy_grants:${projectId}`;
}

export function grantSetting(projectId: string): { enabled: boolean; days: number } {
  try {
    const raw = JSON.parse(getSetting(settingKey(projectId), '{}')) as { enabled?: unknown; days?: unknown };
    const days = typeof raw.days === 'number' && (GRANT_DAY_CHOICES as readonly number[]).includes(raw.days) ? raw.days : DEFAULT_DAYS;
    return { enabled: raw.enabled === true, days };
  } catch {
    return { enabled: false, days: DEFAULT_DAYS };
  }
}

export function setGrantSetting(projectId: string, enabled: boolean, days: number): { enabled: boolean; days: number } {
  if (typeof projectId !== 'string' || !projectId || projectId.length > 200) throw new Error('That is not a project Wanigan knows.');
  const known = db().prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
  if (!known) throw new Error('That is not a project Wanigan knows.');
  if (!(GRANT_DAY_CHOICES as readonly number[]).includes(days)) throw new Error(`Choose ${GRANT_DAY_CHOICES.join(', ')} days.`);
  setSetting(settingKey(projectId), JSON.stringify({ enabled: enabled === true, days }));
  return grantSetting(projectId);
}

/** An attended session is one with a session_log row and no context marking it unattended. */
function attendedProject(sessionId: string): { projectId: string; projectPath: string | null } | null {
  if (contextForSession(sessionId)?.attended === false) return null;
  try {
    const row = db().prepare('SELECT project_id, project_path, worktree FROM session_log WHERE id = ?').get(sessionId) as { project_id: string | null; project_path: string; worktree: string | null } | undefined;
    return row?.project_id ? { projectId: row.project_id, projectPath: row.worktree ?? row.project_path } : null;
  } catch { return null; }
}

/** Fed every stored hook event with its body. */
export function observeForGrants(stored: SessionEvent, input: HookInput): void {
  const k = `${stored.sessionId}|${stored.toolName ?? ''}`;
  if (stored.event === 'PermissionRequest') {
    const who = attendedProject(stored.sessionId);
    if (who) pending.set(k, { at: stored.at, input, ...who });
    if (pending.size > 500) {
      const oldest = pending.keys().next();
      if (!oldest.done) pending.delete(oldest.value);
    }
    return;
  }
  if (stored.event === 'PermissionDenied' || stored.event === 'PostToolUseFailure') { pending.delete(k); return; }
  if (stored.event === 'Stop' || stored.event === 'SessionEnd') {
    for (const key of [...pending.keys()]) if (key.startsWith(`${stored.sessionId}|`)) pending.delete(key);
    return;
  }
  if (stored.event !== 'PostToolUse') return;
  const req = pending.get(k);
  pending.delete(k);
  if (!req || stored.at - req.at > PENDING_MS) return;
  const key = grantKeyFor(req.input, req.projectPath);
  if (!key) return;
  try {
    db().prepare('INSERT INTO policy_grants (at, project_id, session_id, grant_key, tool_name, summary) VALUES (?,?,?,?,?,?)')
      .run(stored.at, req.projectId, stored.sessionId, key.key, key.tool, redactCredentials(key.summary).slice(0, 300));
  } catch { /* a lost grant makes a later unattended run ask, which is the safe direction */ }
}

/** Grants for a project, newest first, bounded. */
function grantsFor(projectId: string): StoredGrant[] {
  return (db().prepare('SELECT id, at, tool_name, grant_key, summary, session_id FROM policy_grants WHERE project_id = ? ORDER BY at DESC LIMIT 2000')
    .all(projectId) as { id: number; at: number; tool_name: string; grant_key: string; summary: string; session_id: string }[])
    .map((r) => ({ id: r.id, at: r.at, tool: r.tool_name, key: r.grant_key, summary: r.summary, sessionId: r.session_id }));
}

/** For an unattended ask: the grant it may rely on, or why there is none. Null when the project has not opted in. */
export function grantFor(projectId: string | null, projectPath: string | null, input: HookInput, now = Date.now()): (GrantMatch & { days: number }) | null {
  if (!projectId) return null;
  const setting = grantSetting(projectId);
  if (!setting.enabled) return null;
  return { ...findGrant(input, projectPath, grantsFor(projectId), now, setting.days), days: setting.days };
}

export function grantSettings(projectIds: string[], now = Date.now()): GrantSetting[] {
  return projectIds.map((projectId) => {
    const s = grantSetting(projectId);
    const since = now - s.days * 86_400_000;
    const row = db().prepare('SELECT COUNT(*) AS n, MAX(at) AS newest FROM policy_grants WHERE project_id = ? AND at >= ?').get(projectId, since) as { n: number; newest: number | null };
    return { projectId, enabled: s.enabled, days: s.days, grants: Number(row.n), newestAt: row.newest };
  });
}
