import { useEffect, useRef, useState } from 'react';
import { EmptyState, Note, Reading, SectionHead } from './bits';
import '../styles/session-history.css';

type Transcript = Awaited<ReturnType<typeof window.wanigan.transcripts.get>>;

/**
 * A local archive read. Opening this component never launches a provider.
 *
 * `startAtEnd` scrolls to the last turn once it lands, for a reader deciding
 * whether to continue: where the conversation stopped is the part that matters.
 */
export default function TranscriptReader({ sessionId, startAtEnd = false }: { sessionId: string; startAtEnd?: boolean }) {
  return <ArchiveTurns key={sessionId} sessionId={sessionId} startAtEnd={startAtEnd} />;
}

function ArchiveTurns({ sessionId, startAtEnd }: { sessionId: string; startAtEnd: boolean }) {
  const [document, setDocument] = useState<Transcript | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [shown, setShown] = useState(40);
  const end = useRef<HTMLDivElement>(null);
  const landed = !!document?.turns.length;
  useEffect(() => {
    let current = true;
    setError(null);
    window.wanigan.transcripts.get(sessionId).then(value => {
      if (current) setDocument(value);
    }).catch((e: unknown) => { if (current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [sessionId, attempt]);
  // Once per read, not on "Show earlier turns": that click asks to look up.
  useEffect(() => {
    if (startAtEnd && landed) end.current?.scrollIntoView({ block: 'end' });
  }, [startAtEnd, landed]);
  if (error) return <Note tone="error"><strong>Could not read this conversation</strong><p>{error}</p><button className="btn" onClick={() => setAttempt(value => value + 1)}>Retry conversation</button></Note>;
  if (!document) return <Reading what="the archived conversation" />;
  if (!document.turns.length) return <EmptyState posture="nothing-yet" title="No readable transcript" cue={document.note ?? 'This session has no archived conversation on this device.'} />;
  const start = Math.max(0, document.turns.length - shown);
  return <div className="transcript-reader">
    <SectionHead label="Recorded conversation" count={document.turns.length} />
    <p className="dim">Showing {start + 1}–{document.turns.length} of the available turns, in conversation order. This is the saved archive; it does not update a running terminal.</p>
    {document.note && <Note tone="info">{document.note}</Note>}
    {start > 0 && <button className="btn" onClick={() => setShown(value => value + 80)}>Show {Math.min(80, start)} earlier turns</button>}
    <div className="transcript-turns">
      {document.turns.slice(start).map((turn, index) => <article className="transcript-turn" key={`${turn.at}-${start + index}`} data-role={turn.role}>
        <header><strong>{turn.role === 'user' ? 'You' : turn.role === 'assistant' ? 'Agent' : turn.role === 'tool' ? 'Tool' : 'System'}</strong>
          {turn.toolName && <span className="mono">{turn.toolName}</span>}<time className="faint" dateTime={new Date(turn.at).toISOString()}>{new Date(turn.at).toLocaleString()}</time></header>
        <pre>{turn.text}</pre>
      </article>)}
    </div>
    <div ref={end} />
  </div>;
}
