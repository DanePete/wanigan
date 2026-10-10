// The design layer as the live view holds it: the project's edits from the
// core's log (`live.layer`), and what the main process said the last time it
// showed them on the page (LiveBridge.layerApply). Every change the window
// makes goes through `change`: the change, then the log read again, then the
// layer applied to the page again, so the tray, the bar's count and the page
// never disagree. The main process applies the layer after every load by
// itself; the window asks again only to hear what was shown and orphaned
// there, and only when the project's layer has edits (or is switched off).
import { useCallback, useEffect, useRef, useState } from 'react';
import type { LayerApplied, LayerEditInput, LayerSnapshot } from '@shared/design-layer';
import { bridge, call } from '../../lib/api';
import { draftsOf } from '../../lib/live-layer';
import { liveBridge } from '../../lib/live';
import { useToast } from '../ui';

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
  /** The view finished loading a page: read the log and hear what the layer found on the page, when there is anything to find. */
  loaded: () => void;
}

export function useLayer(projectId: string, local: boolean): LayerApi {
  const toast = useToast();
  const live = liveBridge();
  const [snapshot, setSnapshot] = useState<LayerSnapshot | null>(null);
  const [applied, setApplied] = useState<LayerApplied | null>(null);
  const localRef = useRef(local);
  localRef.current = local;
  const snapRef = useRef(snapshot);
  snapRef.current = snapshot;

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
    if (a) setApplied(a);
    return a;
  }, [live]);
  const refresh = useCallback(async (): Promise<void> => { await read(); await apply(); }, [read, apply]);
  const fresh = useCallback(async () => ({ snapshot: await read(), applied: await apply() }), [read, apply]);

  useEffect(() => { setSnapshot(null); setApplied(null); void read(); }, [read]);
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
    if (a) setApplied(a);
  }, [live, toast]);
  // A load can orphan an edit, or find one again: the log is read too, not only the page.
  const loaded = useCallback((): void => {
    if (!localRef.current) return;
    if (snapRef.current?.edits.length || applied?.off) void refresh();
  }, [refresh, applied?.off]);

  return { snapshot, applied, on: !applied?.off, drafts: draftsOf(snapshot), change, add, refresh, fresh, show, loaded };
}
