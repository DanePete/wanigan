import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * One feedback contract for the renderer.
 *
 * Six notice mechanisms grew up side by side — the shell toast, Notes inside
 * ad-hoc live regions, a banner on a six-second timer, a composer flash — and
 * most of them were silent to assistive technology. This is the shell half:
 * `announce()` writes into one polite region that is mounted for the life of
 * the window and empty by default, because a live region only announces text
 * that arrives after it exists. Errors go to the shell toast instead, which
 * keeps its contract — a message, a runnable retry, a route to the owning
 * view, Dismiss and Esc — and announces itself as an alert; writing the same
 * sentence into the polite region as well would read it twice.
 *
 * Lifetime is written once, here: a message stays until the next message or
 * Dismiss. No timers — the operator is watching agents, not this strip.
 */

export type AnnounceTone = 'ok' | 'info' | 'warn' | 'error';
export type AnnounceAction = { label: string; run: () => Promise<unknown> | void };
export type Announcement = { tone: AnnounceTone; text: string; action?: AnnounceAction };

export type AnnounceApi = {
  announce: (announcement: Announcement) => void;
  dismiss: () => void;
};

const ApiContext = createContext<AnnounceApi | null>(null);
const CurrentContext = createContext<Announcement | null>(null);

const GLYPH: Record<Exclude<AnnounceTone, 'error'>, string> = { ok: '✓', info: '·', warn: '!' };

export function AnnounceProvider({ onError, children }: {
  /** The shell toast. Receives every `tone: 'error'` announcement. */
  onError: (text: string, action?: AnnounceAction) => void;
  children: ReactNode;
}) {
  const [current, setCurrent] = useState<Announcement | null>(null);
  const announce = useCallback((announcement: Announcement) => {
    if (announcement.tone === 'error') {
      // The toast owns errors. Clear the strip so a stale "saved" does not sit
      // beside the failure that followed it.
      setCurrent(null);
      onError(announcement.text, announcement.action);
      return;
    }
    setCurrent(announcement);
  }, [onError]);
  const dismiss = useCallback(() => setCurrent(null), []);
  const api = useMemo<AnnounceApi>(() => ({ announce, dismiss }), [announce, dismiss]);
  return (
    <ApiContext.Provider value={api}>
      <CurrentContext.Provider value={current}>{children}</CurrentContext.Provider>
    </ApiContext.Provider>
  );
}

const FALLBACK: AnnounceApi = {
  announce: (a) => { console.warn('[wanigan] announce() called outside AnnounceProvider:', a.text); },
  dismiss: () => {},
};

/** `announce({ tone, text, action? })`. Safe outside the provider: it warns. */
export function useAnnounce(): AnnounceApi {
  return useContext(ApiContext) ?? FALLBACK;
}

/**
 * The polite region. Rendered once by App, outside .shell, and never
 * unmounted. Empty by default — the strip is the region's content, so the
 * element assistive tech watches is always the same one.
 */
export function AnnounceRegion() {
  const current = useContext(CurrentContext);
  const { announce, dismiss } = useAnnounce();
  const [running, setRunning] = useState(false);
  const runAction = () => {
    const action = current?.action;
    if (!action || running) return;
    setRunning(true);
    void Promise.resolve()
      .then(() => action.run())
      .then(() => dismiss())
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        announce({ tone: 'error', text: `${action.label} failed: ${message}`, action });
      })
      .finally(() => setRunning(false));
  };
  return (
    <div className="announce-region" role="status">
      {current && current.tone !== 'error' && (
        <div className="announce-strip" data-tone={current.tone}>
          <span className="glyph" aria-hidden="true">{GLYPH[current.tone]}</span>
          <span>{current.text}</span>
          <span className="announce-actions">
            {current.action && (
              <button className="btn btn-sm" type="button" onClick={runAction} disabled={running} aria-busy={running}>
                {running ? `${current.action.label}…` : current.action.label}
              </button>
            )}
            <button className="btn btn-sm" type="button" onClick={dismiss}>Dismiss</button>
          </span>
        </div>
      )}
    </div>
  );
}
