// Notes on a live page, kept per project while Wanigan runs: what the owner
// pointed at, what they want changed, and what they tried by hand (new words,
// a style), each with a picture of the part. They go to an agent together, as
// one message, when the owner sends them. Nothing is sent or spent before that.
import { useSyncExternalStore } from 'react';
import type { LivePick, LiveRegion } from '@shared/live';
import { nameOf } from '@shared/live-names';

export interface StyleChange { property: string; from: string; to: string }

export interface LiveNote {
  id: string;
  /** The page it was made on. */
  url: string;
  /** What was pointed at: the part, and what it sits in (innermost first). */
  regions: LiveRegion[];
  pick: LivePick | null;
  /** What the owner wants, in their words (may be empty when a change says it). */
  text: string;
  words: { before: string; after: string; file: string | null } | null;
  style: StyleChange[];
  /** A PNG (base64) of the part as it looked. */
  shot: string | null;
  at: number;
}

const byProject = new Map<string, LiveNote[]>();
const listeners = new Set<() => void>();
const EMPTY: LiveNote[] = [];

function changed(): void { for (const l of listeners) l(); }

export function addNote(projectId: string, note: Omit<LiveNote, 'id' | 'at'>): void {
  const list = byProject.get(projectId) ?? [];
  byProject.set(projectId, [...list, { ...note, id: `${Date.now().toString(36)}-${list.length}`, at: Date.now() }]);
  changed();
}

export function removeNote(projectId: string, id: string): void {
  byProject.set(projectId, (byProject.get(projectId) ?? []).filter((n) => n.id !== id));
  changed();
}

export function clearNotes(projectId: string): void {
  byProject.delete(projectId);
  changed();
}

export function useNotes(projectId: string): LiveNote[] {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => byProject.get(projectId) ?? EMPTY,
  );
}

/** One region, the way a message to an agent names it: what it is and where its code is. */
function regionLine(r: LiveRegion, componentDir?: string | null): string {
  const n = nameOf(r);
  const where = [
    r.component ? `component ${r.component}${componentDir ? ` (${componentDir})` : ''}` : null,
    r.file ? `template ${r.file}` : null,
    r.hook ? `theme hook ${r.hook}` : null,
    r.entity ? `entity ${r.entity}` : null,
    r.field ? `field ${r.field}` : null,
    r.block ? `block ${r.block}` : null,
    r.view ? `view ${r.view}` : null,
    r.element ? `Elementor ${r.element}` : null,
  ].filter(Boolean).join(', ');
  return `${n.title} (${n.kind || 'part'})${where ? `: ${where}` : ''}`;
}

/** The message the notes make: numbered, each with the part, its code, and any change tried by hand. */
export function notesText(notes: readonly LiveNote[], dirOf: (componentId: string) => string | null): string {
  const pages = [...new Set(notes.map((n) => n.url))];
  const lines = [notes.length === 1
    ? `A note from the live view of ${pages[0]}:`
    : `${notes.length} notes from the live view of ${pages.length === 1 ? pages[0] : `${pages.length} pages`}:`];
  notes.forEach((n, i) => {
    lines.push('', `${i + 1}. ${n.text.trim() || (n.words ? 'Change these words.' : n.style.length ? 'Change this style.' : 'Look at this part.')}`);
    if (pages.length > 1) lines.push(`   Page: ${n.url}`);
    if (n.pick) lines.push(`   Pointed at: \`${n.pick.selector}\`${n.pick.text ? ` (“${n.pick.text.slice(0, 120)}”)` : ''}`);
    const made = n.regions.slice(0, 4).map((r) => regionLine(r, r.component ? dirOf(r.component) : null));
    if (made.length) lines.push(`   Made by (innermost first): ${made.join('; ')}`);
    if (n.words) lines.push(`   Words: “${n.words.before}” → “${n.words.after}”${n.words.file ? ` (written in ${n.words.file})` : ''}`);
    if (n.style.length) {
      lines.push(`   Style tried in the page (not saved): ${n.style.map((s) => `${s.property} ${s.from} → ${s.to}`).join(', ')}`);
      lines.push('   Make it in the site’s own styles, the way this theme already styles things (its classes or CSS), not as an inline style.');
    }
  });
  if (notes.some((n) => n.shot)) lines.push('', 'A picture of each part, as it looked, is attached in the same order.');
  return lines.join('\n');
}
