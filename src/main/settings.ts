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
    // Per-turn workspace snapshots; on because they are local, reversible
    // evidence, and only captured where hooks already prove turn boundaries.
    checkpoints: bool('checkpoints', true),
    archiveTranscripts: bool('archive_transcripts', true),
    notifications: bool('notifications', true),
    mcpServerEnabled: bool('mcp_server', false),
    // Off by default: the first screenshot anyone takes should be the tool.
    pet: bool('pet', false),
    mobileRepositoryReview: mobileRepositoryReview(),
  };
}

/**
 * Whether a paired phone or iPad may read this Mac's working trees, run a
 * project's saved review gate, and commit what git already tracks.
 *
 * Every other route the phone monitor serves keeps the promise stated at the
 * top of mobile/snapshot.ts: no filesystem path, pid, worktree or transcript
 * crosses that wire, enforced by rebuilding every response from an allow-list.
 * A repository review cannot keep it — a changed-file list is made of paths —
 * so it is a decision of its own rather than something the phone monitor or the
 * agent console quietly includes. Turning either of those on does not turn this
 * on, and it is off on every install and every upgrade.
 *
 * mobile/git.ts is the only module behind this scope. Its five routes carry the
 * dispatcher's 'repo' scope — three reads and two writes — so they answer 403
 * until this is true; the paths they send are relative to the project rather
 * than to the disk, the writes never add an untracked file, and none of them
 * pushes.
 */
export function mobileRepositoryReview(): boolean {
  return bool('mobile_repository_review', false);
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

/**
 * The settings screen needs a small legacy key/value bridge for its switches,
 * but it must not be a write-anything endpoint into the settings table. Keep
 * the accepted controls explicit and validate their persisted representation
 * at the privileged boundary.
 */
export function setUserPreference(key: unknown, value: unknown): WaniganSettings {
  if (typeof key !== 'string' || typeof value !== 'string') {
    throw new Error('Preference names and values must be text.');
  }

  const preferenceKey = key;
  let preferenceValue = value;

  // Explainer visibility: 'explainer.<id>' = hidden | shown. Stored here rather
  // than in localStorage so a dismissed guide stays dismissed after a quit and
  // on a restored database; the id is bounded so the renderer cannot mint
  // arbitrary keys.
  if (/^explainer\.[a-z0-9-]{1,64}$/.test(preferenceKey)) {
    if (preferenceValue !== 'hidden' && preferenceValue !== 'shown') {
      throw new Error('An explainer is either hidden or shown.');
    }
    setSetting(preferenceKey, preferenceValue);
    return allSettings();
  }

  switch (preferenceKey) {
    case 'telemetry':
    case 'hooks':
    case 'checkpoints':
    case 'archive_transcripts':
    case 'notifications':
    case 'pet':
    case 'mcp_server':
    // The one preference here that widens what leaves this machine. It is a
    // plain 0/1 like the rest because the enforcement is not in this validator
    // — mobile/dispatch.ts refuses the routes outright while it is off — but it
    // is listed apart so nobody adds it to a "turn everything on" sweep by
    // reading the group above as a set of harmless switches.
    case 'mobile_repository_review':
      if (preferenceValue !== '0' && preferenceValue !== '1') {
        throw new Error(`${preferenceKey} must be enabled or disabled.`);
      }
      break;
    case 'motion':
      if (preferenceValue !== 'auto' && preferenceValue !== 'full' && preferenceValue !== 'off') {
        throw new Error('Motion must be auto, full, or off.');
      }
      break;
    // Whether the destination list is on screen. Durable rather than
    // per-window, because someone who hides it to give a terminal the full
    // width means it for tomorrow too, and ⌥⌘S brings it straight back.
    case 'nav_sidebar':
      if (preferenceValue !== 'open' && preferenceValue !== 'closed') {
        throw new Error('The sidebar is either open or closed.');
      }
      break;
    case 'event_retention_days': {
      if (!/^[1-9]\d{0,3}$/.test(preferenceValue)) {
        throw new Error('Event retention must be a whole number of days.');
      }
      const days = Number(preferenceValue);
      if (days > 3650) throw new Error('Event retention cannot exceed 3650 days.');
      preferenceValue = String(days);
      break;
    }
    default:
      throw new Error('That preference cannot be changed from the renderer.');
  }

  setSetting(preferenceKey, preferenceValue);
  return allSettings();
}

export function slotsSetting(): QueueSlots {
  try {
    const parsed = JSON.parse(getSetting('slots', JSON.stringify(DEFAULT_SLOTS))) as Partial<QueueSlots>;
    return {
      session: Math.max(1, Number(parsed.session) || DEFAULT_SLOTS.session),
      headless: Math.max(1, Number(parsed.headless) || DEFAULT_SLOTS.headless),
      batch: Math.max(1, Number(parsed.batch) || DEFAULT_SLOTS.batch),
      scout: Math.max(1, Number(parsed.scout) || DEFAULT_SLOTS.scout),
      node: Math.max(1, Number(parsed.node) || DEFAULT_SLOTS.node),
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
    // The operator's stored intent only. Whether a phrasing call can actually
    // be made also depends on consent, routing and metering, which live in
    // learning-model-assist.ts -- and that module reads this one, so it cannot
    // be consulted from here. learning-service.settings() computes the
    // effective value, and that is the accessor IPC and the renderer read.
    allowModelAssistance: bool('learning_model_assistance', false),
    monthlyBudgetUsd: Number.isFinite(budget) && budget >= 0 ? budget : 0,
    briefingMaxTokens: Number.isFinite(briefing)
      ? Math.min(8_000, Math.max(200, Math.round(briefing)))
      : 1_200,
    consolidationEnabled: bool('learning_consolidation', true),
  };
}

/** Every stored explainer flag, as flat 'explainer.<id>' keys the renderer reads back. */
function explainerFlags(): Record<`explainer.${string}`, 'hidden' | 'shown'> {
  ensure();
  const out: Record<string, 'hidden' | 'shown'> = {};
  const rows = db().prepare("SELECT k, v FROM settings WHERE k LIKE 'explainer.%'").all() as { k: string; v: string }[];
  for (const row of rows) if (row.v === 'hidden' || row.v === 'shown') out[row.k] = row.v;
  return out as Record<`explainer.${string}`, 'hidden' | 'shown'>;
}

/** The destination drawer starts closed; an explicit preference still wins. */
export function navSidebar(): 'open' | 'closed' {
  return getSetting('nav_sidebar', 'closed') === 'open' ? 'open' : 'closed';
}

export function allSettings(): WaniganSettings {
  const f = flags();
  return {
    ...explainerFlags(),
    spendCapUsd: spendCap(),
    motion: motion(),
    navSidebar: navSidebar(),
    theme: theme(),
    telemetry: f.telemetry,
    hooks: f.hooks,
    checkpoints: f.checkpoints,
    archiveTranscripts: f.archiveTranscripts,
    notifications: f.notifications,
    mcpServerEnabled: f.mcpServerEnabled,
    pet: f.pet,
    mobileRepositoryReview: f.mobileRepositoryReview,
    slots: slotsSetting(),
    eventRetentionDays: eventRetentionDays(),
    defaultTrust: (getSetting('default_trust', 'project') as TrustLevel),
    learning: learningSettings(),
  };
}
