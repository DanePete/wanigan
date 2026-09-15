import { db } from './db';
import { providerById } from './providers';
import { redactCredentials } from './redact';
import { classifyHeadlessPrompt, type HeadlessRefusal } from '../shared/slash-commands';

/**
 * The refusal an unattended run gets when its prompt is a slash command that
 * only an interactive terminal can run. See shared/slash-commands.ts for how
 * the lists were read and why anything unlisted is allowed.
 *
 * The refusal is recorded before it is thrown, so a schedule firing at 03:00
 * leaves a row saying what it refused and why, and nothing else: no run row,
 * no queue lease, no agent, no spend.
 */

export type RefusalSource = 'headless run' | 'schedule' | 'queue item';

export type { HeadlessRefusal };

export function refuseInteractiveOnly(input: {
  harness: string | null | undefined;
  providerId: string | null;
  prompt: string;
  source: RefusalSource;
  label?: string | null;
}): void {
  const verdict = classifyHeadlessPrompt(input.harness, input.prompt);
  if (verdict.kind !== 'interactive-only') return;
  try {
    db().prepare(`
      INSERT INTO headless_refusals (at, source, label, provider_id, harness, command, reason)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      Date.now(), input.source,
      input.label ? redactCredentials(input.label).slice(0, 200) : null,
      input.providerId, input.harness ?? null, `/${verdict.command}`, verdict.reason,
    );
  } catch { /* the refusal stands whether or not it could be written down */ }
  throw new Error(verdict.reason);
}

/**
 * A schedule is checked when it is created as well as when it fires, so an
 * operator hears about it at the desk rather than from an empty 03:00 row.
 * Without a provider the default is chosen at fire time; that check happens
 * then.
 */
export function refuseScheduleCommand(kind: string, payload: unknown, label: string): void {
  if (kind !== 'headless' || !payload || typeof payload !== 'object') return;
  const p = payload as Record<string, unknown>;
  if (typeof p.prompt !== 'string') return;
  const providerId = typeof p.providerId === 'string' && p.providerId ? p.providerId : null;
  if (!providerId) return;
  const def = providerById(providerId);
  if (!def) return;
  refuseInteractiveOnly({ harness: def.harness, providerId, prompt: p.prompt, source: 'schedule', label });
}

export function recentRefusals(limit = 20): HeadlessRefusal[] {
  const n = Math.max(1, Math.min(200, Math.floor(limit)));
  const rows = db().prepare(`
    SELECT id, at, source, label, provider_id, harness, command, reason
    FROM headless_refusals ORDER BY at DESC, id DESC LIMIT ?
  `).all(n) as Array<{ id: number; at: number; source: string; label: string | null; provider_id: string | null; harness: string | null; command: string; reason: string }>;
  return rows.map((r) => ({
    id: r.id, at: r.at, source: r.source, label: r.label, providerId: r.provider_id,
    harness: r.harness, command: r.command, reason: r.reason,
  }));
}
