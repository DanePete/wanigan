/**
 * The pure half of the Resume dialog: which band a saved conversation sits in,
 * whether it matches what was typed, and how an archive hit's «markers» split.
 *
 * Kept out of the renderer so the rules answer under `node --test` in under a
 * second. Nothing here reads a clock, the disk or the bridge; `now` is passed
 * in, so "Today" is a statement about the time the caller measured.
 */
import type { PastSession } from './types';

/**
 * Markers main wraps around the matched term in a transcript hit. Chosen there
 * because they practically never occur in source code, so a renderer can swap
 * them for markup without corrupting a snippet that quotes a bracket or a tag.
 * This is the one copy: src/main/transcripts.ts reads it from here.
 */
export const HIT_OPEN = '«';
export const HIT_CLOSE = '»';

export type HitPart = { text: string; hit: boolean };

/**
 * A snippet as plain and matched runs. An unpaired marker is left as the
 * character it is — degrading to the raw text is honest, dropping it is not.
 */
export function hitParts(snippet: string): HitPart[] {
  const parts: HitPart[] = [];
  let rest = snippet;
  for (;;) {
    const open = rest.indexOf(HIT_OPEN);
    const close = open < 0 ? -1 : rest.indexOf(HIT_CLOSE, open + 1);
    if (open < 0 || close < 0) break;
    if (open > 0) parts.push({ text: rest.slice(0, open), hit: false });
    if (close > open + 1) parts.push({ text: rest.slice(open + 1, close), hit: true });
    rest = rest.slice(close + 1);
  }
  if (rest) parts.push({ text: rest, hit: false });
  return parts;
}

/** When the conversation was last worked on: its end, or its start if it never recorded one. */
export function lastActive(row: Pick<PastSession, 'startedAt' | 'endedAt'>): number {
  return row.endedAt ?? row.startedAt;
}

export type HistoryBand = 'pinned' | 'today' | 'yesterday' | 'week' | 'earlier' | 'settled';

export const BAND_LABEL: Record<HistoryBand, string> = {
  pinned: 'Pinned',
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  earlier: 'Earlier',
  settled: 'Settled',
};

const DAY_MS = 86_400_000;

/**
 * Bands in reading order, each newest first, empty bands omitted.
 *
 * A pin outranks recency and a settle outranks both being recent and being
 * pinned only where main already decided it: main never returns a row with
 * both flags set as anything but pinned, so pinned is checked first. Day edges
 * are the caller's local midnight, not a rolling 24 hours — "Yesterday" at
 * 00:05 means the calendar day before.
 */
export function bandConversations<T extends Pick<PastSession, 'startedAt' | 'endedAt' | 'pinnedAt' | 'settledAt'>>(
  rows: readonly T[], now: number,
): { band: HistoryBand; rows: T[] }[] {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const yesterday = today - DAY_MS;
  const week = today - 7 * DAY_MS;
  const bands = new Map<HistoryBand, T[]>();
  const put = (band: HistoryBand, row: T) => bands.set(band, [...(bands.get(band) ?? []), row]);
  const ordered = [...rows].sort((a, b) => lastActive(b) - lastActive(a));
  for (const row of ordered) {
    const at = lastActive(row);
    if (row.pinnedAt != null) put('pinned', row);
    else if (row.settledAt != null) put('settled', row);
    else if (at >= today) put('today', row);
    else if (at >= yesterday) put('yesterday', row);
    else if (at >= week) put('week', row);
    else put('earlier', row);
  }
  const order: HistoryBand[] = ['pinned', 'today', 'yesterday', 'week', 'earlier', 'settled'];
  return order.filter((band) => bands.has(band)).map((band) => ({ band, rows: bands.get(band) ?? [] }));
}

/**
 * Whether a row matches what was typed: every whitespace-separated word must
 * appear somewhere in its name, project, agent, model, effort or path. Case
 * and accents are ignored; an empty query matches everything.
 */
export function matchesConversation(
  row: Pick<PastSession, 'title' | 'projectName' | 'projectPath' | 'model' | 'effort'>,
  providerLabel: string,
  query: string,
): boolean {
  const fold = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = fold([row.title, row.projectName, row.projectPath, providerLabel, row.model, row.effort]
    .filter(Boolean).join(' '));
  return words.every((word) => haystack.includes(word));
}
