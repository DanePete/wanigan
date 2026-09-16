import { useEffect, useMemo, useState } from 'react';
import type { PastSession, TranscriptHit } from '@shared/types';
import { EmptyState, Note, PageHead, Reading, SectionHead, ago } from './bits';
import { useDialog } from './useDialog';
import TranscriptReader from './TranscriptReader';
import '../styles/session-history.css';

type Archive = Awaited<ReturnType<typeof window.wanigan.transcripts.list>>;
export type HistoryRequest = { sessionId: string; query: string; nonce: number };

export default function SessionHistory({ recent, scopeName, initial, resuming, onResume, onClose }: {
  recent: PastSession[]; scopeName: string; initial: HistoryRequest | null; resuming: string | null;
  onResume: (session: PastSession) => Promise<boolean>; onClose: () => void;
}) {
  const [selected, setSelected] = useState(initial?.sessionId ?? null);
  const [typed, setTyped] = useState(initial?.query ?? '');
  const [query, setQuery] = useState(initial?.query ?? '');
  const [archive, setArchive] = useState<Archive | null>(null);
  const [hits, setHits] = useState<TranscriptHit[]>([]);
  const [reading, setReading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [showArchive, setShowArchive] = useState(false);
  const [limit, setLimit] = useState(40);
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  useEffect(() => {
    let current = true;
    setReading(true); setError(null);
    const read = query ? window.wanigan.transcripts.search(query, 80).then(value => { if (current) setHits(value); })
      : window.wanigan.transcripts.list().then(value => { if (current) setArchive(value); });
    read.catch((e: unknown) => { if (current) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (current) setReading(false); });
    return () => { current = false; };
  }, [query, attempt]);
  const uniqueHits = useMemo(() => hits.filter((hit, index) => hits.findIndex(row => row.sessionId === hit.sessionId) === index), [hits]);
  const chosen = recent.find(row => row.id === selected);
  const hit = hits.find(row => row.sessionId === selected);
  const title = chosen?.title ?? chosen?.projectName ?? hit?.projectName ?? 'Archived conversation';
  return portal(<div {...backdropProps}>
    <section {...dialogProps} className="modal pane session-history" aria-label="Conversation history">
      <PageHead compact eyebrow="Sessions" title="Conversation history" lead="Read saved conversations. Resume only when you’re ready to continue."
        actions={<button className="btn" onClick={onClose}>Back to session</button>} />
      <div className="session-history-layout">
        <aside className="session-history-index" aria-label="Saved conversations">
          <form onSubmit={event => { event.preventDefault(); setQuery(typed.trim()); setLimit(40); }}>
            <label htmlFor="session-history-search">Search all local archives</label>
            <div className="session-history-search"><input className="field" id="session-history-search" type="search" value={typed} onChange={event => setTyped(event.target.value)} placeholder="Find something said…" /><button className="btn" type="submit">Search</button></div>
          </form>
          <p className="faint">Archive search covers every project and older saved transcripts beyond Recent.</p>
          {reading && <Reading what={query ? 'search results' : 'saved archives'} />}
          {error && <Note tone="error">{error}<button className="btn" onClick={() => setAttempt(value => value + 1)}>Retry history</button></Note>}
          {query ? <>
            <SectionHead label={`Matches for “${query}”`} count={uniqueHits.length} right={<button className="btn" onClick={() => { setQuery(''); setTyped(''); }}>Clear</button>} />
            {!reading && !error && !uniqueHits.length && <EmptyState posture="nothing-yet" title="No archived matches" cue="Try another phrase. Only conversations saved on this device can be searched." />}
            {!reading && !error && uniqueHits.map(row => <button key={row.sessionId} className="session-history-row" aria-pressed={selected === row.sessionId} onClick={() => setSelected(row.sessionId)}>
              <strong>{recent.find(past => past.id === row.sessionId)?.title ?? row.projectName}</strong><span className="faint">{row.providerId} · {ago(row.startedAt)}</span><span>{row.snippet}</span>
            </button>)}
            {!reading && hits.length >= 80 && <p className="faint">Showing the first 80 matching excerpts. Narrow your search to find a specific conversation.</p>}
          </> : <>
            <SectionHead label={`Recent · ${scopeName}`} count={recent.length} />
            {recent.map(row => <button key={row.id} className="session-history-row" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>
              <strong>{row.title ?? row.projectName}</strong><span className="faint">{row.projectName} · {ago(row.startedAt)}{!row.live ? ' · folder missing' : ''}</span>
            </button>)}
            {!recent.length && <p className="dim">No resumable recent conversations in this scope. Search or browse saved archives below.</p>}
            <button className="btn" aria-expanded={showArchive} onClick={() => setShowArchive(value => !value)}>{showArchive ? 'Hide' : 'Browse'} all local archives{archive ? ` (${archive.length})` : ''}</button>
            {showArchive && archive && <>
              <p className="faint">All projects. Older archive records may have only a session identifier.</p>
              {archive.slice(0, limit).map(row => <button key={row.sessionId} className="session-history-row" aria-pressed={selected === row.sessionId} onClick={() => setSelected(row.sessionId)}>
                <strong>{recent.find(past => past.id === row.sessionId)?.title ?? row.sessionId}</strong><span className="faint">{row.turns} turns · saved {ago(row.archivedAt)}</span>
              </button>)}
              {archive.length > limit && <button className="btn" onClick={() => setLimit(value => value + 40)}>Show more archives</button>}
            </>}
          </>}
        </aside>
        <div className="session-history-reading">
          {selected ? <>
            <SectionHead label={title} right={chosen && <button className="btn btn-primary" disabled={!chosen.live || resuming !== null} onClick={() => { void onResume(chosen).then(opened => { if (opened) onClose(); }); }}>{resuming === chosen.id ? 'Resuming…' : 'Resume exact conversation'}</button>} />
            <p className="faint mono session-history-identity">{chosen?.projectPath ?? hit?.projectPath ?? selected}</p>
            {chosen && !chosen.live && <Note tone="warn">The project folder is missing. Its saved transcript is still readable; resuming needs the project folder.</Note>}
            {!chosen && <p className="dim">Read-only archive. An exact resume handle is not available in the current Recent scope.</p>}
            <TranscriptReader sessionId={selected} />
          </> : <EmptyState posture="nothing-yet" title="Pick up the thread" cue="Select a conversation to read its saved record, or search for something said. Opening history does not start an agent." />}
        </div>
      </div>
    </section>
  </div>);
}
