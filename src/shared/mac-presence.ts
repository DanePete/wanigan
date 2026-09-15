/**
 * The Mac around the app: what the Dock badge counts and what the menu-bar
 * list says, decided here from records main already holds.
 *
 * Both surfaces live outside the window, which is the whole point of them and
 * also the risk. A Dock badge is visible over every other app, and a menu-bar
 * menu opens over whatever is on screen — a shared screen, a recording, a
 * colleague's shoulder. So neither is allowed to carry anything a session was
 * asked. The rows here are rebuilt from an allow-list of fields (a state word,
 * how long, which project), never from a session record passed through, so a
 * field added to `Session` or `Attention` next month cannot reach the menu bar
 * by accident. `displayTitle` is the case that makes this necessary rather than
 * tidy: sessions.ts derives it from the launch prompt.
 *
 * Pure on purpose, so the offline suite can prove the redaction rather than a
 * reviewer believing it.
 */
import type { Attention, AttentionKind, Session } from './types.ts';

/** The four switches this package adds. Every one defaults off; see main/p8-settings.ts. */
export type MacSettings = {
  /** A count on the Dock icon: sessions asking, failed, or waiting on review. */
  dockBadge: boolean;
  /** A menu-bar item listing live sessions. */
  menuBarSessions: boolean;
  /** The owner-only Unix socket other programs on this Mac can drive Wanigan through. */
  automationSocket: boolean;
  /** Whether that socket's `send` may type into a session's prompt. Off means every send is queued as a draft. */
  automationSend: boolean;
};

/** The two attention kinds that are a question waiting on a person. */
export const BADGE_KINDS: readonly AttentionKind[] = ['permission', 'error'];

/**
 * What the Dock badge counts: sessions asking or failed, plus sessions whose
 * finished work is waiting on review, each session counted once.
 *
 * A snoozed session is left out. Snoozing is the operator saying "not now",
 * and a badge that keeps shouting about a session somebody deliberately set
 * aside is a badge people learn to ignore. `needsReview` holds the ids the
 * review summaries reported; an id with no summary contributes nothing rather
 * than a guess.
 */
export function badgeCount(attention: readonly Attention[], needsReview: ReadonlySet<string> = new Set(), now = Date.now()): number {
  const counted = new Set<string>();
  for (const a of attention) {
    const snoozed = typeof a.helper?.snoozedUntil === 'number' && a.helper.snoozedUntil > now;
    if (snoozed) continue;
    if (BADGE_KINDS.includes(a.kind)) counted.add(a.sessionId);
  }
  for (const id of needsReview) counted.add(id);
  return counted.size;
}

/** The Dock's own text: a count or nothing. Never a word, never a colour. */
export function badgeText(count: number): string {
  return count > 0 ? String(Math.min(count, 99)) : '';
}

export type TrayRow = {
  sessionId: string;
  /** The attention label — "Asking", "Failed", "Stalled" — or "Starting" before a verdict exists. */
  state: string;
  kind: AttentionKind | null;
  since: number;
  projectName: string;
  /** Whether this row is one the badge counts. */
  needsYou: boolean;
};

const MAX_ROWS = 20;
const MAX_PROJECT = 40;

function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * The live sessions, as the menu bar may show them.
 *
 * Only sessions that are still running: an exited agent has nothing to click
 * through to that the Recent list does not show better. Ordered the way the
 * attention queue orders them — the kinds worst first, then longest waiting —
 * so the first row is the one to open.
 */
export function trayRows(sessions: readonly Session[], attention: readonly Attention[], needsReview: ReadonlySet<string> = new Set(), now = Date.now()): TrayRow[] {
  const byId = new Map(attention.map((a) => [a.sessionId, a] as const));
  const order: readonly AttentionKind[] = ['permission', 'error', 'finished', 'idle', 'working'];
  const rows: TrayRow[] = [];
  for (const s of sessions) {
    if (s.status === 'exited') continue;
    const a = byId.get(s.id) ?? null;
    const snoozed = typeof a?.helper?.snoozedUntil === 'number' && a.helper.snoozedUntil > now;
    rows.push({
      sessionId: s.id,
      state: a ? clip(a.label, 24) : s.status === 'starting' ? 'Starting' : 'No signal yet',
      kind: a?.kind ?? null,
      since: a && Number.isFinite(a.since) ? a.since : s.createdAt,
      projectName: clip(s.projectName || 'Project', MAX_PROJECT),
      needsYou: !snoozed && ((a !== null && BADGE_KINDS.includes(a.kind)) || needsReview.has(s.id)),
    });
  }
  rows.sort((x, y) => {
    const rank = (r: TrayRow) => (r.kind ? order.indexOf(r.kind) : order.length);
    return rank(x) - rank(y) || x.since - y.since;
  });
  return rows.slice(0, MAX_ROWS);
}

/** "4m", "2h 5m", "3d" — how long a session has been in its state. */
export function timeInState(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export type TrayItem =
  | { kind: 'heading'; label: string }
  | { kind: 'session'; sessionId: string; label: string }
  | { kind: 'separator' }
  | { kind: 'open'; label: string }
  | { kind: 'halt'; label: string };

export type TrayModel = {
  /** True when nothing needs the operator: the glyph is hollow and there is no title. */
  quiet: boolean;
  /** Text beside the glyph. Empty while quiet. */
  title: string;
  /** Accessible description of the tray button. */
  tooltip: string;
  items: TrayItem[];
};

/**
 * The whole menu, as data. Main turns it into an Electron menu and does nothing
 * else with it, so everything that could leak is decided in this function.
 */
export function trayModel(rows: readonly TrayRow[], badge: number, now = Date.now()): TrayModel {
  const quiet = badge === 0;
  const live = rows.length;
  const heading = live === 0
    ? 'No live sessions'
    : quiet
      ? `${live} live session${live === 1 ? '' : 's'} · nothing needs you`
      : `${badge} need${badge === 1 ? 's' : ''} you · ${live} live`;
  const items: TrayItem[] = [{ kind: 'heading', label: heading }];
  for (const r of rows) {
    items.push({
      kind: 'session',
      sessionId: r.sessionId,
      label: `${r.needsYou ? '● ' : '○ '}${r.state} — ${r.projectName} · ${timeInState(now - r.since)}`,
    });
  }
  items.push({ kind: 'separator' }, { kind: 'open', label: 'Open Wanigan' }, { kind: 'halt', label: 'Halt all agents…' });
  return {
    quiet,
    title: quiet ? '' : String(Math.min(badge, 99)),
    tooltip: quiet ? 'Wanigan — nothing needs you' : `Wanigan — ${badge} session${badge === 1 ? '' : 's'} need${badge === 1 ? 's' : ''} you`,
    items,
  };
}

/**
 * The menu-bar glyph as an alpha mask, drawn in code so no image file is
 * shipped or fetched. A ring when quiet; the same ring with a filled centre
 * when something needs you. Shape carries the meaning, which is also why it
 * works as a macOS template image: the system decides the colour.
 *
 * Returns one alpha byte per pixel, row by row, `size` pixels square.
 */
export function trayGlyphAlpha(size: number, filled: boolean): Uint8Array {
  const out = new Uint8Array(size * size);
  const c = (size - 1) / 2;
  const outer = size * 0.42;
  const stroke = Math.max(1, size * 0.11);
  const inner = outer - stroke;
  const dot = size * 0.2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // One pixel of coverage falloff either side of each edge.
      const ring = Math.max(0, Math.min(1, outer + 0.5 - d)) * Math.max(0, Math.min(1, d - (inner - 0.5)));
      const centre = filled ? Math.max(0, Math.min(1, dot + 0.5 - d)) : 0;
      out[y * size + x] = Math.round(255 * Math.max(ring, centre));
    }
  }
  return out;
}

/** The alpha mask as BGRA bytes: black, with coverage in the alpha channel. */
export function trayGlyphBgra(size: number, filled: boolean): Uint8Array {
  const alpha = trayGlyphAlpha(size, filled);
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < alpha.length; i++) out[i * 4 + 3] = alpha[i];
  return out;
}
