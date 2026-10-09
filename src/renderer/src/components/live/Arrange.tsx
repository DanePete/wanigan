// Moving parts of the live page by hand, the window's side (the page's side is
// in live-page.ts, the rules in shared/live-arrange.ts):
//
// - The page is armed with what may be dragged, and answers each drop with the
//   new order already shown on it. A move of configuration says what it
//   changes and asks first; a move of content is saved at once. Either way the
//   site saves it as the user logged in, the page reloads, and a toast offers
//   Undo. A 409 from the site says it changed meanwhile.
// - A part whose order is written in a template becomes a note for an agent,
//   with a picture of the order now and one of the order wanted.
// - The keyboard does the same from the Inspector: Alt+↑ and Alt+↓ move the
//   chosen part, Alt+Shift+← and → take it to another place it may go, Enter
//   saves and Escape puts it back, each step said aloud. In the panel its Move
//   verb opens, the arrows alone do it.
// - The palette (Add) places an entry by dragging it onto the page, by
//   choosing it and clicking where it goes, or by naming the place. The
//   component library (Library.tsx) places through the same palette entries.
// - Taking an item out (the Inspector's Take out) goes through here too: out
//   of anything shared it says where it shows and asks first; out of one
//   page's own content it is saved at once. Either way only the placement or
//   reference goes, a toast offers Undo, and the page is read back.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import {
  announce, buildSpec, checkInsert, checkRemove, collectionOf, moveNotice, placesIn, removeNotice, requestText, stepMove, targetsFor,
  type ArrangeDrop, type ArrangeSpec, type LiveInsert, type LiveMove, type LiveMoveSaved, type LiveRemove, type Step,
} from '@shared/live-arrange';
import type { PartIndex } from '@shared/live-lens';
import type { LiveRegion } from '@shared/live';
import { aiClientSentence, SAVE_CAVEAT, savesSentence, savesSignature } from '@shared/live-ai';
import { saveOf, type LiveTrace, type PaletteEntry, type TraceCollection, type TraceSave } from '@shared/live-trace';
import type { Layer } from '@shared/live-tree';
import type { ProjectSummary } from '@shared/model';
import { liveBridge } from '../../lib/live';
import { Select } from '../Select';
import { Button, Dialog, useToast } from '../ui';
import { addNote } from './note-store';
import { SavesNote } from './SiteAi';
import type { WriteChecks, WriteSnapshot } from './write-checks';

type At = { collection: string; index: number };
export type Pending =
  | { kind: 'item'; item: string; label: string; region: number; home: At; at: At }
  | { kind: 'loose'; region: number; label: string; group: { region: number; label: string }[]; home: number; at: number };

/** The owner's answer to a question before a write: go ahead, don't, or go ahead with WordPress core's AI Client stopped. */
type Answer = 'yes' | 'no' | 'without-ai';
interface Asking { title: string; text: string; action: string; alt: string | null; resolve: (answer: Answer) => void }

/**
 * Sets of code on a save path the owner was shown and went ahead with, while this window is open: a drop saves at
 * once, so the first one into a save that runs code beyond core asks; the same set does not ask again.
 */
const acknowledged = new Set<string>();

/** A rectangle around several, padded; null when there are none. */
function around(boxes: ({ x: number; y: number; width: number; height: number } | null)[], pad = 8) {
  const list = boxes.filter((b): b is NonNullable<typeof b> => !!b && b.width > 0 && b.height > 0);
  if (!list.length) return null;
  const x = Math.max(0, Math.min(...list.map((b) => b.x)) - pad), y = Math.max(0, Math.min(...list.map((b) => b.y)) - pad);
  return { x, y, width: Math.max(...list.map((b) => b.x + b.width)) + pad - x, height: Math.max(...list.map((b) => b.y + b.height)) + pad - y };
}

export function useArrange({ project, platform, trace, parts, regions, layers, enabled, page, checks, onSaved }: {
  project: ProjectSummary;
  platform: 'drupal' | 'wordpress' | 'site' | null;
  trace: LiveTrace | null;
  parts: PartIndex;
  regions: LiveRegion[];
  layers: readonly Layer[];
  /** Whether the page may be armed now (not loading, picking or editing; arranging switched on). */
  enabled: boolean;
  page: string;
  /** Every move, insert and undo is read back once the page reloads with it. */
  checks: WriteChecks;
  /** Something was moved or inserted: its label, for the Changed lens. */
  onSaved: (label: string) => void;
}) {
  const live = liveBridge();
  const toast = useToast();
  const [placing, setPlacing] = useState<PaletteEntry | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [said, setSaid] = useState('');
  const [asking, setAsking] = useState<Asking | null>(null);
  const cms = platform === 'wordpress' ? 'wordpress' : 'drupal';
  const say = useCallback((text: string) => setSaid((was) => (was === text ? `${text} ` : text)), []);
  const ask = (title: string, text: string, action: string, alt: string | null = null): Promise<Answer> => new Promise((resolve) => setAsking({ title, text, action, alt, resolve }));
  const label = (part: string): string => parts.parts.get(part)?.label ?? part;
  const coll = (id: string): TraceCollection | undefined => trace?.collections?.find((c) => c.id === id);
  /** What the page showed before a drag moved anything on it (the page shows a drop at once, before it is saved). */
  const baseline = useRef<WriteSnapshot | null>(null);

  /** The regions a write into these collections changes: each one's own part, else whatever holds its items. */
  const watchedIn = (ids: string[]): LiveRegion[] => {
    const at = new Map(regions.map((r) => [r.index, r]));
    const out: LiveRegion[] = [];
    for (const id of ids) {
      const c = coll(id);
      if (!c) continue;
      const own = c.part ? parts.regionsOf.get(c.part) ?? [] : [];
      const holders = own.length ? own : c.items.flatMap((i) => parts.regionsOf.get(i) ?? []).map((ix) => at.get(ix)?.parent ?? null).filter((x): x is number => x !== null);
      for (const ix of holders) { const r = at.get(ix); if (r) out.push(r); }
    }
    return out;
  };

  /**
   * Before a write into these collections: a configuration change is said and asked, as before; and the first
   * write into a save that runs code beyond core says whose, once for each set of that code while Wanigan is
   * open. On WordPress with core's AI Client, the answer may be to go ahead with it stopped for this one write.
   */
  const confirmWrite = async (title: string, action: string, ids: string[], first: string | null): Promise<Answer> => {
    const saves = [...new Set(ids.map((id) => saveOf(trace, coll(id))).filter((s): s is TraceSave => !!s && s.runs.length > 0))];
    const keys = saves.map((s) => `${project.id}|${savesSignature(s)}`);
    const fresh = keys.some((k) => !acknowledged.has(k));
    if (!first && !fresh) return 'yes';
    const alt = trace?.ai?.client ? `${action} without the site’s AI Client` : null;
    const text = [
      first,
      ...(fresh ? saves.map((s) => savesSentence(s)) : []),
      fresh ? SAVE_CAVEAT : null,
      fresh ? aiClientSentence(trace?.ai) : null,
      alt ? `“${alt}” stops WordPress core’s AI Client for this one save; a plugin that calls a provider on its own is not stopped.` : null,
      fresh ? 'Wanigan says this once for each set of code while it is open.' : null,
    ].filter(Boolean).join(' ');
    const answer = await ask(title, text, action, alt);
    if (answer !== 'no') for (const k of keys) acknowledged.add(k);
    return answer;
  };

  /** `back` says what Undo did: "Search is back where it was." */
  const undo = useCallback(async (token: string, back: string): Promise<void> => {
    if (!live) return;
    const check = await checks.prepareUndo(token, back.replace(/ is (back where it was|taken out again|back)\.$/, ''));
    const r = await live.undo(token);
    checks.settle(check, { ok: r.ok, ai: r.ai });
    if (r.ok) { toast(back); say(back); } else toast(r.error ?? 'It could not be put back.', 'error');
  }, [live, toast, say, checks]);

  const done = useCallback((r: LiveMoveSaved, what: string, saved: string, name: string, back: string): void => {
    if (r.ok) {
      onSaved(name);
      const token = r.undo;
      toast(`${what}. ${saved}`, 'info', token ? { action: { label: 'Undo', run: () => void undo(token, back) } } : undefined);
      say(`${what}: ${saved}`);
      return;
    }
    toast(r.error, 'error');
    say(r.error);
    if (!r.conflict) void live?.unpreview();
  }, [live, toast, say, undo, onSaved]);

  /** Save a move the page or the keyboard made; a configuration move, or code beyond core on its save, is said and asked first. */
  const saveMove = useCallback(async (move: LiveMove): Promise<void> => {
    const from = coll(move.collection);
    const to = coll(move.to.collection);
    if (!live || !from || !to) return;
    const notice = moveNotice(to.changes === 'configuration' ? to : from, cms);
    const name = label(move.item);
    const where = `${move.to.index + 1} of ${placesIn(to, move.item)} in ${to.label}`;
    const ids = [...new Set([from.id, to.id])];
    const answer = await confirmWrite(`Move ${name} to ${where}?`, 'Move it', ids, notice.confirm);
    if (answer === 'no') {
      await live.unpreview();
      say(`Not moved. ${name} stays where it was.`);
      return;
    }
    const check = baseline.current ? checks.fromSnapshot(baseline.current, 'move', name, watchedIn(ids)) : await checks.prepare('move', name, watchedIn(ids));
    const r = await live.move(move, answer === 'without-ai' ? { noSiteAi: true } : undefined);
    checks.settle(check, { ok: r.ok, ai: r.ai, undo: r.ok ? r.undo : null });
    done(r, `Moved ${name} to ${where}`, notice.saved, name, `${name} is back where it was.`);
  }, [live, cms, done, say, checks]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveInsert = useCallback(async (insert: LiveInsert): Promise<void> => {
    const into = coll(insert.collection);
    const entry = trace?.palette?.find((p) => p.id === insert.entry);
    if (!live || !into || !entry) return;
    // Checked here as the main process checks it, so a place that does not take it is said before anything is asked.
    const checked = checkInsert(trace, insert);
    if (typeof checked === 'string') { toast(checked, 'error'); say(checked); return; }
    const notice = moveNotice(into, cms);
    const first = notice.confirm ? notice.confirm.replace(/^This moves the block/, 'This adds the block').replace(/^This moves the widget/, 'This adds the widget') : null;
    const answer = await confirmWrite(`Add ${entry.label}?`, 'Add it', [into.id], first);
    if (answer === 'no') return;
    const check = baseline.current ? checks.fromSnapshot(baseline.current, 'insert', entry.label, watchedIn([into.id])) : await checks.prepare('insert', entry.label, watchedIn([into.id]));
    const r = await live.insert(insert, answer === 'without-ai' ? { noSiteAi: true } : undefined);
    checks.settle(check, { ok: r.ok, ai: r.ai, undo: r.ok ? r.undo : null });
    done(r, `Added ${entry.label} at ${insert.index + 1} of ${into.items.length + 1} in ${into.label}`, notice.saved, entry.label, `${entry.label} is taken out again.`);
  }, [live, trace, cms, done, checks]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Take one item out of its collection. Out of anything shared (configuration, or content shown in many places) it
   * says where it shows and asks first, and nothing is saved until the owner says so; out of one page's own content it
   * is saved at once. The first write into a save that runs code beyond core says whose, as every write does.
   */
  const saveRemove = useCallback(async (remove: LiveRemove): Promise<void> => {
    const from = coll(remove.collection);
    if (!live || !from) return;
    const checked = checkRemove(trace, remove);
    if (typeof checked === 'string') { toast(checked, 'error'); say(checked); return; }
    const notice = removeNotice(from, cms);
    const name = label(remove.item);
    const answer = await confirmWrite(`Take ${name} out?`, 'Take it out', [from.id], notice.confirm);
    if (answer === 'no') { say(`Not taken out. ${name} stays where it is.`); return; }
    const check = await checks.prepare('remove', name, watchedIn([from.id]));
    const r = await live.remove(checked, answer === 'without-ai' ? { noSiteAi: true } : undefined);
    checks.settle(check, { ok: r.ok, ai: r.ai, undo: r.ok ? r.undo : null });
    done(r, `Took ${name} out of ${from.label}`, notice.saved, name, `${name} is back.`);
  }, [live, trace, cms, done, say, checks, toast]); // eslint-disable-line react-hooks/exhaustive-deps

  /** A part whose order is in a template: pictures of the order now and the order wanted, as a note for an agent. */
  const request = useCallback(async (region: number, ref: number, place: 'before' | 'after', previewed: boolean): Promise<void> => {
    if (!live) return;
    const group = buildSpecGroup(regions, layers, region);
    const where = async (): Promise<ReturnType<typeof around>> => around(await Promise.all(group.map((r) => live.where(r))));
    if (!previewed) await live.preview(region, ref, place);
    const wanted = await where();
    await live.unpreview();
    const now = await where();
    const box = around([wanted, now], 0);
    const before = await live.capture(box ?? undefined);
    await live.preview(region, ref, place);
    const after = await live.capture(box ?? undefined);
    await live.unpreview();
    const at = new Map(regions.map((r) => [r.index, r]));
    const moved = at.get(region);
    const other = at.get(ref);
    if (!moved || !other) return;
    const name = (r: LiveRegion): string => (r.part ? parts.parts.get(r.part)?.label : null) ?? nameFor(r, layers);
    const vertical = Math.min(moved.rect.y + moved.rect.height, other.rect.y + other.rect.height) - Math.max(moved.rect.y, other.rect.y) <= Math.min(moved.rect.height, other.rect.height) / 2;
    const text = requestText(name(moved), name(other), place, vertical);
    addNote(project.id, { url: page, regions: [moved], pick: null, words: null, style: [], shot: before, after, text });
    toast(`A note for an agent: ${text.split('.')[0]}. Send it from Notes.`);
    say(`${text.split('.')[0]}: a note for an agent, in Notes.`);
  }, [live, regions, layers, parts, project.id, page, toast, say]);

  const onDrop = useCallback(async (drop: ArrangeDrop): Promise<void> => {
    if (drop.kind === 'move') await saveMove(drop.move);
    else if (drop.kind === 'insert') await saveInsert(drop.insert);
    else await request(drop.region, drop.ref, drop.place, true);
  }, [saveMove, saveInsert, request]);

  // Arm the page with what may be dragged; each drop is handled, then the page is armed again.
  const spec: ArrangeSpec = useMemo(() => buildSpec(trace, parts, layers, placing), [trace, parts, layers, placing]);
  // The page is armed again only when what it may drag changed, not on every render.
  const key = useMemo(() => JSON.stringify(spec), [spec]);
  const specRef = useRef(spec);
  specRef.current = spec;
  useEffect(() => {
    const s = specRef.current;
    if (!live || !enabled || pending || (!s.collections.length && !s.groups.length && !s.placing)) return undefined;
    let alive = true;
    void (async () => {
      while (alive) {
        // What the page shows before anything is dragged on it: a drop is shown moved before it is saved.
        baseline.current = await checks.snapshot(watchedIn(s.collections.map((c) => c.id)));
        if (!alive) return;
        const drop = await live.arrange(s);
        if (!alive) return;
        if (!drop) { if (s.placing) setPlacing(null); return; }
        await onDrop(drop);
        if (s.placing) { setPlacing(null); return; }
      }
    })();
    return () => { alive = false; void live.disarm(); };
  }, [live, key, enabled, pending, onDrop, checks]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── the keyboard ─────────────────────────────────────────────────────── */

  /** Where a pending move sits now, as the page shows it: before or after the item it lands by, or into an empty place. */
  const showAt = useCallback(async (p: Pending): Promise<void> => {
    if (!live) return;
    if (p.kind === 'loose') {
      const others = p.group.filter((m) => m.region !== p.region);
      if (p.at === p.home) { await live.unpreview(); return; }
      const ref = others[Math.min(p.at, others.length - 1)];
      if (ref) await live.preview(p.region, ref.region, p.at < others.length ? 'before' : 'after');
      return;
    }
    const target = coll(p.at.collection);
    if (!target) return;
    if (p.at.collection === p.home.collection && p.at.index === p.home.index) { await live.unpreview(); return; }
    const others = target.items.filter((i) => i !== p.item).map((i) => parts.regionsOf.get(i)?.[0] ?? null);
    const next = others.slice(p.at.index).find((r) => r !== null);
    const prev = [...others.slice(0, p.at.index)].reverse().find((r) => r !== null);
    const container = target.part ? parts.regionsOf.get(target.part)?.[0] ?? null : null;
    if (next !== undefined && next !== null) await live.preview(p.region, next, 'before');
    else if (prev !== undefined && prev !== null) await live.preview(p.region, prev, 'after');
    else if (container !== null) await live.preview(p.region, container, 'into');
  }, [live, parts]); // eslint-disable-line react-hooks/exhaustive-deps

  const describe = useCallback((p: Pending): string => {
    if (p.kind === 'loose') return `${p.label}, ${p.at + 1} of ${p.group.length}, in the template’s order`;
    const target = coll(p.at.collection);
    return target ? announce(p.label, p.at.index, placesIn(target, p.item), target.label) : p.label;
  }, [trace]); // eslint-disable-line react-hooks/exhaustive-deps

  /** What the chosen region could be moved as: an item of a collection, or one of a run whose order is in a template. */
  const movable = useCallback((region: LiveRegion | null): Pending | null => {
    if (!region || !trace) return region ? loosePending(region) : null;
    const part = parts.byRegion.get(region.index);
    const home = part ? collectionOf(trace, part.id) : null;
    if (part && home && targetsFor(trace, home.id).length) {
      const at = { collection: home.id, index: home.items.indexOf(part.id) };
      return { kind: 'item', item: part.id, label: part.label, region: region.index, home: at, at };
    }
    return loosePending(region);
    function loosePending(r: LiveRegion): Pending | null {
      const group = spec.groups.find((g) => g.some((m) => m.region === r.index));
      if (!group) return null;
      const home = group.findIndex((m) => m.region === r.index);
      return { kind: 'loose', region: r.index, label: group[home]?.label ?? '', group, home, at: home };
    }
  }, [trace, parts, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const step = useCallback((region: LiveRegion | null, s: Step): void => {
    const p = pending ?? movable(region);
    if (!p || !trace && p.kind === 'item') { say('This part cannot be moved here.'); return; }
    let next: Pending | null = null;
    if (p.kind === 'item' && trace) {
      const at = stepMove(trace, p.item, p.at, s);
      if (at) next = { ...p, at };
    } else if (p.kind === 'loose' && (s === 'up' || s === 'down')) {
      const at = p.at + (s === 'up' ? -1 : 1);
      if (at >= 0 && at < p.group.length) next = { ...p, at };
    }
    if (!next) { say(`${describe(p)}. It can go no further that way.`); if (!pending) setPending(p); return; }
    setPending(next);
    void showAt(next);
    say(describe(next));
  }, [pending, movable, trace, say, describe, showAt]);

  const cancel = useCallback((): void => {
    if (!pending) return;
    const p = pending;
    setPending(null);
    void live?.unpreview();
    say(`Move cancelled. ${describe({ ...p, at: p.home } as Pending)}.`);
  }, [pending, live, say, describe]);

  const commit = useCallback(async (): Promise<void> => {
    const p = pending;
    if (!p) return;
    setPending(null);
    if (p.kind === 'loose') {
      if (p.at === p.home) { await live?.unpreview(); return; }
      const others = p.group.filter((m) => m.region !== p.region);
      const ref = others[Math.min(p.at, others.length - 1)];
      if (ref) await request(p.region, ref.region, p.at < others.length ? 'before' : 'after', true);
      return;
    }
    if (p.at.collection === p.home.collection && p.at.index === p.home.index) { await live?.unpreview(); return; }
    await saveMove({ collection: p.home.collection, item: p.item, to: p.at });
  }, [pending, live, request, saveMove]);

  /** The Inspector's keys: Alt+arrows move, Enter saves, Escape puts it back. Returns whether the key was used. */
  const keys = useCallback((e: KeyboardEvent, region: LiveRegion | null): boolean => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement;
    if (e.altKey && !typing) {
      const s: Step | null = e.shiftKey ? (e.key === 'ArrowLeft' ? 'previous' : e.key === 'ArrowRight' ? 'next' : null) : (e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : null);
      if (s) { e.preventDefault(); e.stopPropagation(); step(region, s); return true; }
    }
    if (pending && e.key === 'Enter' && !typing) { e.preventDefault(); e.stopPropagation(); void commit(); return true; }
    if (pending && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); return true; }
    return false;
  }, [step, pending, commit, cancel]);

  // A reload, or a new trace, ends a move in progress: what it was relative to is gone.
  useEffect(() => { setPending(null); }, [trace]);

  return {
    spec, placing, setPlacing, pending, movable, step, commit, cancel, keys, said, saveInsert, saveRemove, describe,
    asking: asking ? (
      <Dialog title={asking.title} onClose={() => { asking.resolve('no'); setAsking(null); }}
        footer={(
          <>
            <Button tone="quiet" onClick={() => { asking.resolve('no'); setAsking(null); }}>Cancel</Button>
            {asking.alt ? <Button tone="quiet" onClick={() => { asking.resolve('without-ai'); setAsking(null); }}>{asking.alt}</Button> : null}
            <Button tone="primary" data-autofocus onClick={() => { asking.resolve('yes'); setAsking(null); }}>{asking.action}</Button>
          </>
        )}>
        <p>{asking.text}</p>
      </Dialog>
    ) : null,
  };
}

/** The run of siblings a region is in, from the layers: what a request's pictures frame. */
function buildSpecGroup(regions: LiveRegion[], layers: readonly Layer[], region: number): number[] {
  const walk = (list: readonly Layer[]): number[] | null => {
    if (list.some((l) => l.regions.length === 1 && l.region.index === region)) return list.filter((l) => l.regions.length === 1).map((l) => l.region.index);
    for (const l of list) { const found = walk(l.children); if (found) return found; }
    return null;
  };
  return walk(layers) ?? regions.filter((r) => r.index === region).map((r) => r.index);
}

function nameFor(r: LiveRegion, layers: readonly Layer[]): string {
  const walk = (list: readonly Layer[]): string | null => {
    for (const l of list) { if (l.region.index === r.index) return l.name.title; const f = walk(l.children); if (f) return f; }
    return null;
  };
  return walk(layers) ?? 'this part';
}

/**
 * What the Inspector's Move verb opens: where the part is, a button for each
 * step, and the keys that do the same. Here the arrows alone move it (↑ ↓, and
 * ← → to another place); anywhere in the part's details Alt+arrows do.
 */
export function MoveSection({ arrange, region, trace, panelRef, onClose }: {
  arrange: ReturnType<typeof useArrange>; region: LiveRegion; trace: LiveTrace | null;
  panelRef?: RefObject<HTMLElement | null>;
  /** Leave without moving: the verb closes the panel. */
  onClose?: () => void;
}) {
  const own = arrange.movable(region);
  const p = arrange.pending && arrange.pending.region === region.index ? arrange.pending : own;
  if (!p) return null;
  const home = p.kind === 'item' && trace ? trace.collections?.find((c) => c.id === p.home.collection) ?? null : null;
  const others = home && trace ? targetsFor(trace, home.id).filter((c) => c.id !== (p.kind === 'item' ? p.at.collection : '')) : [];
  const moving = !!arrange.pending;
  const arrows = (e: KeyboardEvent): void => {
    if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey || (e.target as Element).closest('.select')) return;
    const s: Step | null = e.key === 'ArrowUp' ? 'up' : e.key === 'ArrowDown' ? 'down' : e.key === 'ArrowLeft' ? 'previous' : e.key === 'ArrowRight' ? 'next' : null;
    if (s) { e.preventDefault(); e.stopPropagation(); arrange.step(region, s); }
    else if (e.key === 'Escape' && !moving && onClose) { e.preventDefault(); e.stopPropagation(); onClose(); }
  };
  return (
    <section className="live-move" aria-label="Move" ref={panelRef as RefObject<HTMLElement>} onKeyDown={arrows}>
      <p className="small">{arrange.describe(p)}.</p>
      {p.kind === 'item' && home ? (
        <>
          <p className="faint small">{home.changes === 'configuration' ? 'Its order is site configuration: moving it says what it changes before it saves.' : home.revisions === false ? 'Saved as content.' : 'Saved as content, as a new revision.'}</p>
          <SavesNote save={saveOf(trace, home)} ai={trace?.ai} />
        </>
      ) : <p className="faint small">Its order is written in the template: moving it makes a note for an agent, with pictures of the order now and the order wanted.</p>}
      <div className="live-actions">
        <Button size="s" tone="quiet" icon="chevron" className="live-up" onClick={() => arrange.step(region, 'up')}>Move up</Button>
        <Button size="s" tone="quiet" icon="chevron" className="live-down" onClick={() => arrange.step(region, 'down')}>Move down</Button>
        {others.length ? (
          <Select<string> label="Move to another place" size="s" value="" onChange={(id) => {
            const dir = trace ? targetsFor(trace, (p as { home: At }).home.collection).findIndex((c) => c.id === id) : -1;
            const here = trace ? targetsFor(trace, (p as { home: At }).home.collection).findIndex((c) => c.id === (p as { at: At }).at.collection) : -1;
            for (let i = 0; i < Math.abs(dir - here); i++) arrange.step(region, dir > here ? 'next' : 'previous');
          }} options={[{ value: '', label: 'Move to…' }, ...others.map((c) => ({ value: c.id, label: c.label }))]} />
        ) : null}
      </div>
      {moving ? (
        <div className="live-actions">
          <Button size="s" tone="primary" icon="check" onClick={() => void arrange.commit()}>{p.kind === 'loose' ? 'Make the note' : 'Save the move'}</Button>
          <Button size="s" tone="quiet" icon="undo" onClick={arrange.cancel}>Put it back</Button>
        </div>
      ) : null}
      <p className="faint small">Keys: ↑ and ↓ move it{others.length ? ', ← and → take it to another place' : ''} (Alt with them anywhere in its details); Enter saves, Escape puts it back.</p>
    </section>
  );
}

/** The palette: what the site can add here, by dragging onto the page, by placing with a click, or by naming the place. */
export function PaletteTab({ arrange, trace }: { arrange: ReturnType<typeof useArrange>; trace: LiveTrace | null }) {
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const palette = trace?.palette ?? [];
  if (!palette.length) return <p className="faint small live-side-block">The site helper offers nothing to add on this page.</p>;
  const q = query.trim().toLowerCase();
  const shown = palette.filter((p) => !q || p.label.toLowerCase().includes(q) || (p.by ?? '').toLowerCase().includes(q) || (p.description ?? '').toLowerCase().includes(q));
  const takes = (entry: string): TraceCollection[] => (trace?.collections ?? []).filter((c) => !c.why && c.inserts?.includes(entry));
  return (
    <div className="live-side-block live-palette">
      <label className="search-field">
        <span className="visually-hidden">Filter what can be added</span>
        <input type="search" placeholder="Filter" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <p className="faint small">Drag one onto the page, or choose Place and click where it goes. Escape stops.</p>
      <ul className="live-palette-list">
        {shown.map((p) => {
          const into = takes(p.id);
          return (
            <li key={p.id} className="live-palette-entry" draggable={into.length > 0}
              onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.label); e.dataTransfer.effectAllowed = 'copy'; arrange.setPlacing(p); }}>
              <div className="live-palette-what">
                <span className="small live-made-title">{p.label}</span>
                <span className="faint small">{p.kind.replace('-', ' ')}{p.by ? ` · ${p.by}` : ''}{into.length ? ` · into ${into.map((c) => c.label).join(', ')}` : ' · nowhere on this page'}</span>
                {p.description ? <span className="small">{p.description}</span> : null}
              </div>
              <div className="live-actions">
                <Button size="s" icon="plus" disabled={!into.length} aria-pressed={arrange.placing?.id === p.id}
                  onClick={() => arrange.setPlacing(arrange.placing?.id === p.id ? null : p)}>Place</Button>
                <Button size="s" tone="quiet" disabled={!into.length} aria-expanded={chosen === p.id} onClick={() => setChosen(chosen === p.id ? null : p.id)}>Choose where…</Button>
              </div>
              {chosen === p.id ? <PlaceBy entry={p} into={into} labelOf={(id) => trace?.parts.find((x) => x.id === id)?.label ?? id} onPlace={(i) => { setChosen(null); void arrange.saveInsert(i); }} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Placing by naming the place: which collection, and where in it. The keyboard's way, and anyone's. */
export function PlaceBy({ entry, into, labelOf, onPlace }: { entry: PaletteEntry; into: TraceCollection[]; labelOf: (part: string) => string; onPlace: (i: LiveInsert) => void }) {
  const [collection, setCollection] = useState(into[0]?.id ?? '');
  const c = into.find((x) => x.id === collection);
  const [index, setIndex] = useState(c?.items.length ?? 0);
  const places = c ? [{ value: 0, label: c.items.length ? `First, before ${labelOf(c.items[0] as string)}` : 'Into it' },
    ...c.items.map((item, i) => ({ value: i + 1, label: `After ${labelOf(item)}` }))] : [];
  return (
    <div className="live-place-by">
      <Select<string> label={`Where to add ${entry.label}`} size="s" value={collection} onChange={(v) => { setCollection(v); setIndex(into.find((x) => x.id === v)?.items.length ?? 0); }}
        options={into.map((x) => ({ value: x.id, label: x.label }))} />
      {c ? <Select<number> label="At" size="s" value={Math.min(index, c.items.length)} onChange={setIndex} options={places} /> : null}
      <Button size="s" tone="primary" disabled={!c} onClick={() => c && onPlace({ collection: c.id, index: Math.min(index, c.items.length), entry: entry.id })}>Add it</Button>
    </div>
  );
}
