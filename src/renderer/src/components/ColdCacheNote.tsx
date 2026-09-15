import { useEffect, useState } from 'react';
import type { CacheWarmthFacts } from '@shared/cost-types';
import { coldCacheNote } from '@shared/cache-warmth';
import '../styles/cost.css';

/**
 * One line under the composer when the session's prompt cache has likely gone
 * cold: how long it has been idle, and roughly how much the next message will
 * re-read without cache. It reads facts only while there is a draft to send,
 * refreshes them every half minute while there is, and never touches the send.
 */
const REFRESH_MS = 30_000;

export default function ColdCacheNote({ sessionId, active }: { sessionId: string; active: boolean }) {
  const [facts, setFacts] = useState<CacheWarmthFacts | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    let live = true;
    const read = () => {
      setNow(Date.now());
      window.wanigan.cost.cacheWarmth(sessionId)
        .then((value) => { if (live) setFacts(value); })
        .catch(() => { if (live) setFacts(null); });
    };
    read();
    const timer = window.setInterval(read, REFRESH_MS);
    return () => { live = false; window.clearInterval(timer); };
  }, [sessionId, active]);
  if (!active || !facts?.supported) return null;
  const note = coldCacheNote({ now, lastTurnEndedAt: facts.lastTurnEndedAt, ttl: facts.ttl, contextTokens: facts.contextTokens });
  if (!note) return null;
  return <div className="composer-note cost-cold-cache" role="status">{note.text}</div>;
}
