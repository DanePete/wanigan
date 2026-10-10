// The design layer as the live view holds it: the project's edits from the
// core's log (`live.layer`), and what the main process said the last time it
// showed them on the page (LiveBridge.layerApply). Every change the window
// makes goes through `change`: the change, then the log read again, then the
// layer applied to the page again, so the tray, the bar's count and the page
// never disagree. The main process applies the layer after every load by
// itself; the window asks again only to hear what was shown and orphaned
// there, and only when the project's layer has edits (or is switched off).
//
// What runs for an edit (making it real, saving it to a template, verifying it) is kept here, per project, not in the
// tray: closing and opening the tray never starts one twice, and a verification's failure is still said. While a
// write to the site runs for the project, undo, redo and discard wait, so the log never moves between the site saving
// the words and the layer marking the edit.
//
// Whether the page shows the layer is the main process's switch (one for the view, whichever project it shows): it is
// read from main's answers, asked as soon as the project's live view opens, and an answer that comes back after the
// project changed is not this project's and is dropped.
//
// Typing on the page (LiveBridge.layerType) is kept here too, so the status line under the page says so whatever the
// side panel shows: words kept there are added as a text edit and the layer applied, as a retype in the box is.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerApplied, LayerEditInput, LayerPickTarget, LayerSnapshot, LayerTyped } from '@shared/design-layer';
import { bridge, call } from '../../lib/api';
import { draftsOf } from '../../lib/live-layer';
import { liveBridge } from '../../lib/live';
import { useToast } from '../ui';

/** What can run for one edit: making it real, saving its words to a template, verifying it. */
export type LayerTask = 'real' | 'template' | 'verify';

export interface LayerApi {
  /** The project's layer, or null until the core has answered. */
  snapshot: LayerSnapshot | null;
  /** What the main process said the last time it showed the layer on the page; null before it has. */
  applied: LayerApplied | null;
  /** The page shows the layer (true), or the site as it renders it without one. */
  on: boolean;
  /** Edits only in the layer: the bar's count. */
  drafts: number;
  /** Run a change (to the log, or to the site), then read the log again and show it on the page. Refusals are toasts. */
  change: <T>(run: () => Promise<T>) => Promise<T | undefined>;
  /** Add an edit the window keyed. */
  add: (edit: LayerEditInput) => Promise<LayerSnapshot | undefined>;
  /** Read the log and show it on the page again. */
  refresh: () => Promise<void>;
  /** Read the log and what the page shows now, and answer them: a check made just before a write. */
  fresh: () => Promise<{ snapshot: LayerSnapshot | null; applied: LayerApplied | null }>;
  /** Show the page with the layer, or without it. */
  show: (on: boolean) => Promise<void>;
  /** What runs for each edit now, by its id. */
  running: Readonly<Record<string, LayerTask>>;
  /** Making an edit real, or saving one to a template, runs for this project: undo, redo and discard wait for it. */
  writing: boolean;
  /** Run one task for an edit, one at a time per edit: a second start while one runs does nothing (and answers undefined). */
  task: <T>(id: string, kind: LayerTask, run: () => Promise<T>) => Promise<T | undefined>;
  /** Verify one implemented edit, or a style or token draft made in the theme, once at a time; what stopped it is kept in `failures`. */
  verify: (id: string) => Promise<unknown>;
  /** Why the last verification of an edit did not run, or was not recorded, by the edit's id; cleared when it is verified again. */
  failures: Readonly<Record<string, string>>;
  /** Take back the newest add or discard, bring back what undo took, take an edit out: each refused while a write runs. */
  undo: () => Promise<unknown>;
  redo: () => Promise<unknown>;
  discard: (id: string) => Promise<unknown>;
  /** The view finished loading a page: read the log and hear what the layer found on the page, when there is anything to find. */
  loaded: () => void;
  /** Typing on the page now: the status line says so, with Keep and Put back. */
  typing: boolean;
  /**
   * Type on the picked element's words in the page itself. Words kept there become a text edit for that element on
   * `page` (added, and the layer applied, so the page goes on showing them); answers the edit's target and words, or
   * null when they were put back, never typed (said), or the add was refused (said).
   */
  typeOnPage: (page: string) => Promise<{ target: LayerPickTarget; words: string } | null>;
  /** End typing on the page from the window: keep the words (true), or put back what the page showed (false). */
  endTyping: (keep: boolean) => void;
}

export function useLayer(projectId: string, local: boolean): LayerApi {
  const toast = useToast();
  const live = liveBridge();
  const [snapshot, setSnapshot] = useState<LayerSnapshot | null>(null);
  const [applied, setApplied] = useState<LayerApplied | null>(null);
  const localRef = useRef(local);
  localRef.current = local;
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;
  /** What runs for each edit: read and written at once by the handlers, shown through `running`. */
  const tasks = useRef(new Map<string, LayerTask>());
  const [running, setRunning] = useState<Readonly<Record<string, LayerTask>>>({});

  const read = useCallback(async (): Promise<LayerSnapshot | null> => {
    const snap = await call('live.layer', { projectId }).catch(() => null);
    if (!snap || snap.projectId !== projectId) return null;
    setSnapshot(snap);
    return snap;
  }, [projectId]);
  const apply = useCallback(async (): Promise<LayerApplied | null> => {
    // A hosted environment is shown read-only: the layer is the local site's.
    if (!live || !localRef.current) return null;
    const a = await live.layerApply().catch(() => null);
    // Asked for another project (the view moved on meanwhile): not this one's answer.
    if (!a || projectRef.current !== projectId) return null;
    setApplied(a);
    return a;
  }, [live, projectId]);
  const refresh = useCallback(async (): Promise<void> => { await read(); await apply(); }, [read, apply]);
  const fresh = useCallback(async () => ({ snapshot: await read(), applied: await apply() }), [read, apply]);

  // A project's view opens: its log, and main's answer for the page (whether the layer is shown included), at once.
  useEffect(() => {
    setSnapshot(null); setApplied(null); setFailures({});
    tasks.current = new Map(); setRunning({});
    void read();
    void apply();
  }, [read, apply]);
  // The main process marks edits too (orphaned on a load, implemented, verified): the core says the layer changed.
  useEffect(() => bridge().on((event, data) => {
    if (event === 'liveLayer' && (data as { projectId?: string }).projectId === projectId) void read();
  }), [projectId, read]);

  const change = useCallback(async <T,>(run: () => Promise<T>): Promise<T | undefined> => {
    let out: T | undefined;
    try {
      out = await run();
    } catch (e) {
      toast((e as Error).message, 'error');
      return undefined;
    } finally {
      await refresh();
    }
    return out;
  }, [refresh, toast]);
  const add = useCallback((edit: LayerEditInput) => change(() => call('live.layerAdd', { projectId, edit })), [change, projectId]);
  const show = useCallback(async (on: boolean): Promise<void> => {
    if (!live) return;
    const a = await live.layerShow(on).catch((e: Error) => { toast(e.message, 'error'); return null; });
    if (a && projectRef.current === projectId) setApplied(a);
  }, [live, toast, projectId]);
  const task = useCallback(async <T,>(id: string, kind: LayerTask, run: () => Promise<T>): Promise<T | undefined> => {
    if (tasks.current.has(id)) return undefined;
    const runs = tasks.current;
    runs.set(id, kind);
    setRunning(Object.fromEntries(runs));
    try {
      return await run();
    } finally {
      // A project changed meanwhile has its own list.
      if (tasks.current === runs) { runs.delete(id); setRunning(Object.fromEntries(runs)); }
    }
  }, []);
  const verify = useCallback((id: string) => task(id, 'verify', async () => {
    if (!live) return;
    const asked = projectRef.current;
    setFailures(({ [id]: _was, ...rest }) => rest);
    try {
      await live.layerVerify(id);
    } catch (e) {
      if (projectRef.current === asked) setFailures((f) => ({ ...f, [id]: (e as Error).message }));
    } finally {
      await refresh();
    }
  }), [task, live, refresh]);
  /** A change to the log, refused while a write to the site runs for this project: the layer records that write next. */
  const logged = useCallback(<T,>(run: () => Promise<T>): Promise<T | undefined> => {
    if ([...tasks.current.values()].some((k) => k === 'real' || k === 'template')) {
      toast('Wait for the save to the site to finish: the layer records it next.', 'error');
      return Promise.resolve(undefined);
    }
    return change(run);
  }, [change, toast]);
  const undo = useCallback(() => logged(() => call('live.layerUndo', { projectId })), [logged, projectId]);
  const redo = useCallback(() => logged(() => call('live.layerRedo', { projectId })), [logged, projectId]);
  const discard = useCallback((id: string) => logged(() => call('live.layerDiscard', { projectId, id })), [logged, projectId]);
  // A load can orphan an edit, or find one again: the log is read too, not only the page.
  const loaded = useCallback((): void => {
    if (!localRef.current) return;
    if (snapRef.current?.edits.length || applied?.off) void refresh();
  }, [refresh, applied?.off]);

  const [typing, setTyping] = useState(false);
  const typingNow = useRef(false);
  const typeOnPage = useCallback(async (page: string): Promise<{ target: LayerPickTarget; words: string } | null> => {
    if (!live || typingNow.current) return null;
    const asked = projectId;
    typingNow.current = true;
    setTyping(true);
    let got: LayerTyped;
    try {
      got = await live.layerType().catch((e: Error): LayerTyped => ({ ended: 'refused', why: e.message }));
    } finally {
      typingNow.current = false;
      setTyping(false);
    }
    if (got.ended === 'refused') { toast(got.why, 'error'); return null; }
    // Ended by Enter or Escape in the page: the keyboard comes back to the window, to the part's details, as after a pick.
    if (got.key) {
      await live.focusWindow().catch(() => {});
      window.requestAnimationFrame(() => document.querySelector<HTMLElement>('.live-inspector .live-side-title')?.focus());
    }
    if (got.ended === 'cancelled') { if (got.why) toast(got.why); return null; }
    // Kept for another project's page (the view moved on meanwhile): not this layer's.
    if (projectRef.current !== asked) return null;
    const { target, words } = got;
    const done = await add({ target: target.target, label: target.label, page, scope: 'this', breakpoint: 'all', change: { type: 'text', value: words }, before: target.before });
    return done ? { target, words } : null;
  }, [live, projectId, toast, add]);
  const endTyping = useCallback((keep: boolean): void => { void live?.layerTypeEnd(keep).catch(() => {}); }, [live]);

  const writing = Object.values(running).some((k) => k === 'real' || k === 'template');
  return {
    snapshot, applied, on: !applied?.off, drafts: draftsOf(snapshot), change, add, refresh, fresh, show, loaded,
    running, writing, task, verify, failures, undo, redo, discard, typing, typeOnPage, endTyping,
  };
}
