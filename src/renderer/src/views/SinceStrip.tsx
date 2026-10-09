// What agents did on this board while you were away: one compact line of
// counts that opens to the cards behind them. Dismissed, it stays away until
// something new happens. The time of your last look is a per-viewer
// convenience kept in this window's storage; the counting is shared/since.ts.
import { useEffect, useId, useMemo, useState } from 'react';
import type { CardSummary } from '@shared/model';
import { sinceSummary } from '@shared/since';
import { forProject, useQuery } from '../lib/api';
import { openCard } from '../lib/router';
import { ago } from '../lib/format';
import { Icon } from '../components/icons';
import { IconButton } from '../components/ui';

const key = (projectId: string): string => `wanigan.lastSeen.${projectId}`;
/** Activity read per look; when it is all newer than your last look, counts are floors. */
const LIMIT = 300;
/** Card keys listed per line in the detail before "and n more". */
const KEYS_SHOWN = 12;

function readSeen(projectId: string): number | null {
  try { const v = Number(localStorage.getItem(key(projectId))); return Number.isFinite(v) && v > 0 ? v : null; } catch { return null; }
}

function writeSeen(projectId: string, at: number): void {
  try { localStorage.setItem(key(projectId), String(at)); } catch { /* convenience only */ }
}

export function SinceStrip({ projectId, cards }: { projectId: string; cards: CardSummary[] | undefined }) {
  // The previous visit, captured once; this visit is recorded when you leave.
  const [since] = useState(() => readSeen(projectId));
  // Dismissing counts as a look: only what happens after it brings the line back.
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  useEffect(() => () => writeSeen(projectId, Date.now()), [projectId]);
  const activity = useQuery('activity.list', since ? { projectId, limit: LIMIT } : null, ['board', 'sessions'], forProject(projectId));
  const from = Math.max(since ?? 0, dismissedAt ?? 0);
  const summary = useMemo(() => (since && activity.data ? sinceSummary(activity.data, from, LIMIT) : null), [since, activity.data, from]);
  const keyOf = useMemo(() => new Map((cards ?? []).map((c) => [c.id, c.key])), [cards]);

  if (!since || !summary?.groups.length) return null;
  const dismiss = (): void => {
    const now = Date.now();
    writeSeen(projectId, now);
    setDismissedAt(now);
    setOpen(false);
  };

  return (
    <div className={`since${open ? ' open' : ''}`}>
      <div className="since-line" role="status">
        <button type="button" className="since-toggle" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((o) => !o)}>
          <Icon name="chevron" size={14} className="since-chevron" />
          <span className="since-when">Since you looked {ago(from)}</span>
          <span className="since-counts">
            {summary.groups.map((g) => <span key={g.verb} className="since-count">{g.short}</span>)}
          </span>
        </button>
        <IconButton icon="close" label="Dismiss until something new happens" onClick={dismiss} />
      </div>
      {open ? (
        <ul className="since-detail" id={detailId}>
          {summary.groups.map((g) => {
            const keys = g.cardIds.map((id) => keyOf.get(id)).filter((k): k is string => !!k);
            return (
              <li key={g.verb}>
                <span>{g.long}</span>
                {keys.length ? (
                  <span className="since-keys">
                    {keys.slice(0, KEYS_SHOWN).map((k) => (
                      <button key={k} type="button" className="linkish mono" onClick={() => openCard(k)}>{k}</button>
                    ))}
                    {keys.length > KEYS_SHOWN ? <span className="faint">and {keys.length - KEYS_SHOWN} more</span> : null}
                  </span>
                ) : null}
              </li>
            );
          })}
          {summary.partial ? <li className="faint">Counted from the latest {LIMIT} events on this board; there may be more.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
