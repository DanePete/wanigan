import { db } from './db';
import {
  DEFAULT_SLOTS,
  type LearningSettings,
  type WaniganSettings,
  type MotionSetting,
  type QueueSlots,
  type ThemeSetting,
  type TrustLevel,
} from '../shared/types';

/**
 * Small key/value settings. The spend cap is the one that matters: a batch is
 * fire-and-forget, so a mis-typed row count or a runaway max_tokens is only
 * catchable *before* submit.
 */
function ensure() {
  db().exec('CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
}

export function getSetting(k: string, fallback: string): string {
  ensure();
  const r = db().prepare('SELECT v FROM settings WHERE k = ?').get(k) as { v: string } | undefined;
  return r?.v ?? fallback;
}

export function setSetting(k: string, v: string) {
  ensure();
  db().prepare('INSERT INTO settings (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v);
}

/** Hard ceiling on a single run's estimated cost, in USD. 0 disables it. */
export function spendCap(): number {
  const n = Number(getSetting('spend_cap_usd', '1.00'));
  return Number.isFinite(n) && n >= 0 ? n : 1.0;
}

/* ── feature flags ──────────────────────────────────────────────────────
   Everything phases 1-20 added is switchable, and the two that observe a
   running agent (telemetry, hooks) default ON because they are how Wanigan
   knows anything at all — but they are the first things a suspicious user
   will want to turn off, so they must be one click away and honestly named.
   ──────────────────────────────────────────────────────────────────────── */

const bool = (k: string, dflt: boolean) => getSetting(k, dflt ? '1' : '0') === '1';

export function flags() {
  return {
    telemetry: bool('telemetry', true),
    hooks: bool('hooks', true),
    archiveTranscripts: bool('archive_transcripts', true),
    notifications: bool('notifications', true),
    mcpServerEnabled: bool('mcp_server', false),
    // Off by default: the first screenshot anyone takes should be the tool.
    pet: bool('pet', false),
  };
}

export function motion(): MotionSetting {
  const v = getSetting('motion', 'auto');
  return v === 'full' || v === 'off' ? v : 'auto';
}

/** A narrow guard at the privileged boundary; renderer text is never trusted. */
export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === 'system' || value === 'light' || value === 'dark';
}

/** Defaults to the OS so a new install does not silently force a colour mode. */
export function theme(): ThemeSetting {
  const value = getSetting('theme', 'system');
  return isThemeSetting(value) ? value : 'system';
}

/**
 * Theme is set through a typed IPC path instead of the generic settings
 * bridge. This keeps malformed renderer input from becoming a durable value.
 */
export function setTheme(value: unknown): ThemeSetting {
  if (!isThemeSetting(value)) throw new Error('Theme must be system, light, or dark.');
  setSetting('theme', value);
  return value;
}

export function slotsSetting(): QueueSlots {
  try {
    const parsed = JSON.parse(getSetting('slots', JSON.stringify(DEFAULT_SLOTS))) as Partial<QueueSlots>;
    return {
      session: Math.max(1, Number(parsed.session) || DEFAULT_SLOTS.session),
      headless: Math.max(1, Number(parsed.headless) || DEFAULT_SLOTS.headless),
      batch: Math.max(1, Number(parsed.batch) || DEFAULT_SLOTS.batch),
    };
  } catch { return DEFAULT_SLOTS; }
}

/** Events accumulate fast on a long session; retention is a setting, not a leak. */
export function eventRetentionDays(): number {
  const n = Number(getSetting('event_retention_days', '30'));
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export function learningSettings(): LearningSettings {
  const content = getSetting('learning_content_mode', 'local-same-provider');
  const automation = getSetting('learning_automation', 'hybrid');
  const budget = Number(getSetting('learning_monthly_budget_usd', '0'));
  const briefing = Number(getSetting('learning_briefing_max_tokens', '1200'));
  return {
    enabled: bool('learning_enabled', true),
    contentMode: content === 'operational-only' ? 'operational-only' : 'local-same-provider',
    automation: automation === 'review-only' ? 'review-only' : 'hybrid',
    // Reserved for a metered provider-specific consolidator. Until that path
    // exists end to end, reporting this as enabled would be a false control.
    allowModelAssistance: false,
    monthlyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 0,
    briefingMaxTokens: Number.isFinite(briefing)
      ? Math.min(8_000, Math.max(200, Math.round(briefing)))
      : 1_200,
    consolidationEnabled: bool('learning_consolidation', true),
  };
}

export function allSettings(): WaniganSettings {
  const f = flags();
  return {
    spendCapUsd: spendCap(),
    motion: motion(),
    theme: theme(),
    telemetry: f.telemetry,
    hooks: f.hooks,
    archiveTranscripts: f.archiveTranscripts,
    notifications: f.notifications,
    mcpServerEnabled: f.mcpServerEnabled,
    pet: f.pet,
    slots: slotsSetting(),
    eventRetentionDays: eventRetentionDays(),
    defaultTrust: (getSetting('default_trust', 'project') as TrustLevel),
    learning: learningSettings(),
  };
}
