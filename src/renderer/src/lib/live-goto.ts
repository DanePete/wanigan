// The Go to launcher in the window: what opens it (Shift+Space in the live
// view or its page, the live view’s address field, ⌘⇧Space anywhere in a
// project), where it opens (over the address field when the live view is on
// screen), what
// it remembers on this Mac (each project's chosen destinations, for
// frecency), the answers it can show at once while a fresh one comes, and the
// hook an edit popover offers its forms through. The launcher itself is
// components/live/GoTo.tsx; the rules are shared/live-goto.ts.
import { useCallback, useEffect, useRef } from 'react';
import type { FindItem, FindResult } from '@shared/live-find';
import { readVisits, remember, type LiveFindAnswer, type Visit } from '@shared/live-goto';
import type { LiveKeyId } from '@shared/live-keys';
import { liveBridge } from './live';

/* ── opening ───────────────────────────────────────────────────────────── */

export interface GoToRequest {
  /** The project whose site to go to; null is the project on screen. */
  projectId: string | null;
  /** Opened by Shift+Space on the page: the keyboard goes back there on Escape. */
  fromPage: boolean;
  /** Opened from the address field: the address shown, in the field and selected, so typing replaces it and Enter goes there. */
  address?: string | null;
  /** Opened by typing into the address field: what was typed so far. */
  query?: string | null;
}

const openers = new Set<(r: GoToRequest) => void>();

/** Open the launcher (or close it, when it is open for the same project): the window's host decides. */
export function openGoTo(request: GoToRequest): void {
  for (const o of openers) o(request);
}

/** The host listens here (components/live/GoTo.tsx). */
export function onGoTo(listener: (r: GoToRequest) => void): () => void {
  openers.add(listener);
  return () => { openers.delete(listener); };
}

/* ── where it opens ────────────────────────────────────────────────────── */

/** The live view’s address field, by project: Go to opens over it, so the field is where a page is typed. */
const anchors = new Map<string, HTMLElement>();

/** Called by the address field while it is on screen; returns its withdrawal. */
export function anchorGoTo(projectId: string, el: HTMLElement): () => void {
  anchors.set(projectId, el);
  return () => { if (anchors.get(projectId) === el) anchors.delete(projectId); };
}

/** Where the address field is now, when the project’s live view shows one. */
export function goToAnchor(projectId: string): DOMRect | null {
  const el = anchors.get(projectId);
  return el?.isConnected ? el.getBoundingClientRect() : null;
}

/** The origin the live view shows when it is not the local site’s (a hosted environment): Go to opens the same path there. */
const shownOrigins = new Map<string, string>();
export function showingOrigin(projectId: string, origin: string | null): void {
  if (origin) shownOrigins.set(projectId, origin); else shownOrigins.delete(projectId);
}
export const shownOrigin = (projectId: string): string | null => shownOrigins.get(projectId) ?? null;

/* ── where the live view is on screen ──────────────────────────────────── */

/** Projects whose live view is on screen now (the project view's, or a session's split). */
const onScreen = new Map<string, number>();
export const liveOnScreen = (projectId: string): boolean => (onScreen.get(projectId) ?? 0) > 0;

/** A page to open once the project's live view is on screen: chosen from elsewhere, then the view was opened for it. */
let pendingGo: { projectId: string; url: string; at: number } | null = null;
const PENDING_MS = 30_000;

export function goWhenShown(projectId: string, url: string): void {
  pendingGo = { projectId, url, at: Date.now() };
}

const editable = (el: Element | null): boolean => !!el && ((el as HTMLElement).isContentEditable
  || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || !!el.closest('.xterm, [role="textbox"], [role="combobox"]'));

/** Whether keys at an element are someone's typing: a field, an editor, a terminal. The live view's single keys leave those alone. */
export const isTyping = editable;

/**
 * Called by the live view while it is on screen: it is known to be there,
 * Shift+Space in its toolbar or side panel (not while typing) opens Go to,
 * and so does Shift+Space in its page, which the page script answers. The
 * page answers the live view's own keys too (P picks…), which `onPageKey`
 * runs. Returns what opens Go to from the address field.
 */
export function useGoToKeys(projectId: string, onPageKey?: (id: LiveKeyId) => void): (from?: Pick<GoToRequest, 'address' | 'query'>) => void {
  const pageKey = useRef(onPageKey);
  pageKey.current = onPageKey;
  useEffect(() => {
    onScreen.set(projectId, (onScreen.get(projectId) ?? 0) + 1);
    // A page chosen before the view was here: go there now (the view's show reached the app first).
    const want = pendingGo;
    if (want && want.projectId === projectId && Date.now() - want.at < PENDING_MS) {
      pendingGo = null;
      void liveBridge()?.go(want.url);
    }
    return () => { onScreen.set(projectId, (onScreen.get(projectId) ?? 1) - 1); };
  }, [projectId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.code !== 'Space' || !e.shiftKey || e.metaKey || e.ctrlKey || e.altKey || e.repeat || e.isComposing) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target?.closest('.live') || editable(target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      openGoTo({ projectId, fromPage: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [projectId]);

  // The page's own Shift+Space: wait for it, and again after each page loads (a new page has a new script).
  useEffect(() => {
    const live = liveBridge();
    if (!live?.awaitGoto) return undefined;
    let stopped = false;
    const wait = async (): Promise<void> => {
      while (!stopped) {
        const got = await live.awaitGoto().catch(() => null);
        if (stopped || !got) return;
        if (got === 'goto') openGoTo({ projectId, fromPage: true });
        else pageKey.current?.(got);
      }
    };
    let loading = true;
    const off = live.onState((s) => {
      if (s.projectId !== projectId) return;
      if (s.loading) { loading = true; return; }
      if (loading && !s.error) { loading = false; void wait(); }
    });
    void wait();
    return () => { stopped = true; off(); };
  }, [projectId]);

  return useCallback((from?: Pick<GoToRequest, 'address' | 'query'>) => openGoTo({ projectId, fromPage: false, ...from }), [projectId]);
}

/* ── remembered on this Mac ────────────────────────────────────────────── */

const visitsKey = (projectId: string): string => `wanigan.goto.${projectId}`;

/** A project's chosen destinations; empty when storage is unavailable. A per-viewer convenience, never required. */
export function loadVisits(projectId: string): Visit[] {
  try { return readVisits(JSON.parse(localStorage.getItem(visitsKey(projectId)) ?? '[]')); } catch { return []; }
}

export function rememberVisit(projectId: string, item: Pick<Visit, 'id' | 'label' | 'url' | 'kind'>): Visit[] {
  const next = remember(loadVisits(projectId), item, Date.now());
  try { localStorage.setItem(visitsKey(projectId), JSON.stringify(next)); } catch { /* storage unavailable: remembered for this window only */ }
  return next;
}

/* ── answers kept while the window is open ─────────────────────────────── */

const answers = new Map<string, LiveFindAnswer>();
const searches = new Map<string, Map<string, FindResult>>();
const SEARCHES_KEPT = 40;

/** The last index answer for a project, shown at once while a fresh one comes. */
export const keptAnswer = (projectId: string): LiveFindAnswer | null => answers.get(projectId) ?? null;
export const keepAnswer = (projectId: string, a: LiveFindAnswer): void => { answers.set(projectId, a); };

export function keptSearch(projectId: string, query: string): FindResult | null {
  return searches.get(projectId)?.get(query) ?? null;
}

export function keepSearch(projectId: string, query: string, result: FindResult): void {
  const list = searches.get(projectId) ?? new Map<string, FindResult>();
  list.delete(query);
  list.set(query, result);
  while (list.size > SEARCHES_KEPT) list.delete(list.keys().next().value as string);
  searches.set(projectId, list);
}

/* ── an edit form opened better than by loading it ─────────────────────── */

/**
 * Something that can open a destination's edit form better than loading it in
 * the view (the live view's edit popover). It answers true when it opened it;
 * false leaves Go to to load the form in the view.
 */
export type GoToEditor = (request: { projectId: string; item: FindItem; url: string }) => boolean;

let editor: GoToEditor | null = null;

/** Offer an editor for ⌥↩ in Go to while it is mounted; returns its withdrawal. The newest offer wins. */
export function provideGoToEditor(next: GoToEditor): () => void {
  editor = next;
  return () => { if (editor === next) editor = null; };
}

export const goToEditor = (): GoToEditor | null => editor;
