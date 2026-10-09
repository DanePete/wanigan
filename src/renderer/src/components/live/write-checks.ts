// Reading back every write the live view makes (shared/live-check.ts): what the
// watched parts showed is read before an edit, move, insert or undo; the site
// saves it and the page reloads with a new trace; then the new render is
// checked, and a write the site called a success that changed nothing on the
// page is said plainly. What the site's own AI did during it (WordPress) is
// said as the write comes back.
import { useCallback, useMemo, useRef, type MutableRefObject } from 'react';
import type { LiveRegion } from '@shared/live';
import { saveAiSentence, type SaveAi } from '@shared/live-ai';
import { judge, regionsAfter, verdictText, type WriteCheck, type WriteKind } from '@shared/live-check';
import type { LiveTraceAnswer } from '@shared/live-lens';
import type { liveBridge } from '../../lib/live';

type Bridge = NonNullable<ReturnType<typeof liveBridge>>;

/** Each region once, at most 50: what one write watches. */
const unique = (regions: readonly LiveRegion[]): LiveRegion[] => [...new Map(regions.map((r) => [r.index, r])).values()].slice(0, 50);

/** What regions showed at one moment, to build a check from later (the page shows a dragged part moved before it is saved). */
export interface WriteSnapshot { traceId: string | null; scan: LiveRegion[]; prints: Record<number, string | null> }

export interface WriteChecks {
  /** What the regions show now, before a write is made. */
  prepare(kind: WriteKind, what: string, regions: readonly LiveRegion[], target?: WriteCheck['target']): Promise<WriteCheck>;
  /** What the regions show now, kept for a write made later. */
  snapshot(regions: readonly LiveRegion[]): Promise<WriteSnapshot>;
  /** A check from a snapshot: the regions as they were then. */
  fromSnapshot(snap: WriteSnapshot, kind: WriteKind, what: string, regions: readonly LiveRegion[]): WriteCheck;
  /** A move or insert's undo: the same parts as the write it undoes, found on the page as it is now. */
  prepareUndo(token: string, what: string): Promise<WriteCheck>;
  /** The write came back: say what the site's AI did, and check it once the page reloads. `undo` keeps it for its undo. */
  settle(check: WriteCheck, result: { ok: boolean; ai?: SaveAi | null; undo?: string | null }): void;
  /** The page started loading. */
  loading(): void;
  /** A trace arrived for the page as it is now (after its scan): a pending check is judged against it. */
  traced(answer: LiveTraceAnswer): Promise<void>;
}

export function useWriteChecks({ live, scan, traceId, say }: {
  live: Bridge | null;
  /** The page's regions as last scanned. */
  scan: MutableRefObject<LiveRegion[]>;
  /** The trace the page shows now. */
  traceId: () => string | null;
  /** Say something about a write: `warn` when it needs the owner to look. */
  say: (text: string, warn: boolean, toast: boolean) => void;
}): WriteChecks {
  const pending = useRef<{ check: WriteCheck; reloaded: boolean; ai: string | null } | null>(null);
  const undos = useRef(new Map<string, WriteCheck>());


  const snapshot = useCallback(async (regions: readonly LiveRegion[]): Promise<WriteSnapshot> => {
    const list = unique(regions);
    const at = { traceId: traceId(), scan: [...scan.current] };
    return { ...at, prints: live && list.length ? await live.fingerprints(list.map((r) => r.index)) : {} };
  }, [live, scan, traceId]);

  const fromSnapshot = useCallback((snap: WriteSnapshot, kind: WriteKind, what: string, regions: readonly LiveRegion[]): WriteCheck => ({
    kind, what, traceId: snap.traceId, scan: snap.scan, watched: unique(regions).map((r) => ({ region: r, print: snap.prints[r.index] ?? null })),
  }), []);

  const prepare = useCallback(async (kind: WriteKind, what: string, regions: readonly LiveRegion[], target?: WriteCheck['target']): Promise<WriteCheck> => {
    const check = fromSnapshot(await snapshot(regions), kind, what, regions);
    return target ? { ...check, target } : check;
  }, [snapshot, fromSnapshot]);

  const prepareUndo = useCallback(async (token: string, what: string): Promise<WriteCheck> => {
    const done = undos.current.get(token);
    const now = done ? regionsAfter(done, scan.current).filter((r): r is LiveRegion => r !== null) : [];
    return prepare('undo', what, now);
  }, [prepare, scan]);

  const settle = useCallback((check: WriteCheck, result: { ok: boolean; ai?: SaveAi | null; undo?: string | null }): void => {
    const ai = saveAiSentence(result.ai ?? null);
    // What the site's AI did is said at once, whether or not the save went through: it may have spent either way.
    if (ai?.ran) say(ai.text, false, true);
    if (!result.ok) { pending.current = null; return; }
    if (result.undo) undos.current.set(result.undo, check);
    pending.current = { check, reloaded: false, ai: ai?.text ?? null };
  }, [say]);

  const loading = useCallback((): void => {
    if (pending.current) pending.current.reloaded = true;
  }, []);

  const traced = useCallback(async (answer: LiveTraceAnswer): Promise<void> => {
    const p = pending.current;
    if (!p) return;
    const newer = answer.state === 'ok' && answer.trace.id !== p.check.traceId;
    if (!p.reloaded && !newer) return;
    pending.current = null;
    const after = regionsAfter(p.check, scan.current);
    const indexes = after.filter((r): r is LiveRegion => r !== null).map((r) => r.index);
    const prints = live && indexes.length ? await live.fingerprints(indexes) : {};
    const verdict = judge(p.check, answer.state === 'ok' ? answer.trace : null, after.map((r) => (r ? prints[r.index] ?? null : null)));
    const said = verdictText(p.check, verdict);
    say(p.ai ? `${said.text} ${p.ai}` : said.text, said.tone === 'warn', said.tone === 'warn');
  }, [live, scan, say]);

  return useMemo(() => ({ prepare, snapshot, fromSnapshot, prepareUndo, settle, loading, traced }), [prepare, snapshot, fromSnapshot, prepareUndo, settle, loading, traced]);
}
