// What a card's agents looked at in the live view, through its tools
// (`wanigan mcp`): each call, the page and width, what came back, and whether
// it came after the session's last edit. The core keeps every call, answered
// or refused; this only reads them. Evidence, not a score.
import { useState } from 'react';
import type { LiveLook } from '@shared/live-agent';
import type { CardDetail } from '@shared/model';
import { useQuery } from '../../lib/api';
import { ago } from '../../lib/format';
import { Icon } from '../icons';
import { Button } from '../ui';
import '../../styles/live.css';

const SHOWN = 6;
const AGENT: Record<string, string> = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };

/** "Claude looked at /about at 375 px", as the review reads it. */
export function lookSentence(look: LiveLook): string {
  const who = AGENT[look.provider] ?? 'The agent';
  const page = look.page ?? 'the page';
  const at = look.width ? ` at ${look.width} px` : '';
  if (!look.ok) return `${who} tried to read the live view (${look.tool.replace('live_', '')})`;
  switch (look.tool) {
    case 'live_status': return `${who} checked the live view`;
    case 'live_look': return `${who} looked at ${page}${at}${look.asked ? `, ${look.asked}` : ''}`;
    case 'live_find': return `${who} searched ${page}${at} for ${look.asked}`;
    case 'live_part': return `${who} looked closely at ${look.asked} on ${page}${at}`;
    case 'live_problems': return `${who} checked ${page}${at} for problems${look.asked ? `, ${look.asked}` : ''}`;
    case 'live_diff': return `${who} compared ${page}${at} with its screenshot ${look.asked}`;
    default: return `${who} read the live view`;
  }
}

/** Whether the look came after the session's last edit, or what it edited after. */
export function lookWhen(look: LiveLook): string | null {
  if (!look.editsBefore && !look.editsAfter) return null;
  if (!look.editsAfter) return 'after its last edit';
  return `then edited ${look.editsAfter === 1 ? 'one more file' : `${look.editsAfter} more files`}`;
}

export function CardLooks({ card }: { card: CardDetail }) {
  const looks = useQuery('live.looks', { cardId: card.id }, ['liveLooks'], (_e, d) => (d as { projectId?: string }).projectId === card.projectId);
  const [all, setAll] = useState(false);
  const list = looks.data ?? [];
  if (!list.length) return null;
  const shown = all ? list : list.slice(0, SHOWN);
  return (
    <section className="drawer-section live-looks" aria-label="What the agents looked at in the live view">
      <h3>Looked at the live view <span className="faint">{list.length}</span></h3>
      <ul className="evidence">
        {shown.map((look) => {
          const when = lookWhen(look);
          return (
            <li key={look.id} className={look.ok ? undefined : 'live-look-refused'}>
              <Icon name={look.tool === 'live_diff' ? 'layers' : look.tool === 'live_problems' ? 'alert' : 'eye'} size={14} />
              <span>{lookSentence(look)}{when ? <span className="faint">, {when}</span> : null}: {look.said}</span>
              <span className="faint evidence-by" title={look.sessionTitle}>{ago(look.at)}</span>
            </li>
          );
        })}
      </ul>
      {list.length > SHOWN ? (
        <Button size="s" tone="quiet" onClick={() => setAll((v) => !v)}>{all ? 'Show fewer' : `Show all ${list.length}`}</Button>
      ) : null}
    </section>
  );
}
