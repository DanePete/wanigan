import { useState } from 'react';
import type { CompanionPresenceState } from '@shared/companion-presence';
import { readTemperament } from '../orb/expression';
import { usePresenceReactions } from '../orb/presence';
import Orb from './Orb';
import HandoverBubble from './HandoverBubble';
import type { OrbStory } from '@shared/orb-story';

/** Stays mounted across work views; reads the shell's existing status poll. */
export default function CompanionPresence({ presence, story, expanded, onAttention, onHome, onOpenSession, onError }: {
  story?:OrbStory;presence: CompanionPresenceState; expanded: boolean;
  onAttention: (anchor: HTMLButtonElement) => void; onHome: () => void;
  /** Focus the session a handover opened, so it does not start out of sight. */
  onOpenSession?: (id: string, projectId?: string) => void;
  onError?: (message: string) => void;
}) {
  const {attentionEvent,completionEvent,failureEvent}=usePresenceReactions(presence);
  const [temperament]=useState(readTemperament);
  const action = presence.needs ? `Show ${presence.needs} ${presence.needs === 1 ? 'session that needs' : 'sessions that need'} you` : 'Talk to Wanigan';
  return <div className="companion-presence" data-signal={presence.signal}>
    {/* Renders nothing unless the reading is one Wanigan measured and the
        conversation is genuinely filling; see context-handover.ts. */}
    <HandoverBubble story={story} onOpened={(id, projectId) => onOpenSession?.(id, projectId)}
                    onError={(m) => onError?.(m)} />
    <Orb story={{...story,failureEvent,failed:!!presence.errorEvents?.length}} compact signal={presence.signal} temperament={temperament} attentionEvent={attentionEvent} completionEvent={completionEvent}
      label={`Wanigan · ${presence.label}. ${story?.context?`${story.context.label}: ${story.context.note}. `:''}${action}. Across all project spaces.`}
      popup={presence.needs > 0} expanded={expanded}
      onActivate={anchor => presence.needs ? onAttention(anchor) : onHome()}>
      <span className="companion-caption" aria-hidden="true"><strong>Wanigan</strong><span>{presence.label}</span></span>
    </Orb>
  </div>;
}
