import { useState } from 'react';
import type { CompanionPresenceState } from '@shared/companion-presence';
import { readTemperament } from '../orb/expression';
import { usePresenceReactions } from '../orb/presence';
import Orb from './Orb';

/** Stays mounted across work views; reads the shell's existing status poll. */
export default function CompanionPresence({ presence, expanded, onAttention, onHome }: {
  presence: CompanionPresenceState; expanded: boolean;
  onAttention: (anchor: HTMLButtonElement) => void; onHome: () => void;
}) {
  const {attentionEvent,completionEvent}=usePresenceReactions(presence);
  const [temperament]=useState(readTemperament);
  const action = presence.needs ? `Show ${presence.needs} ${presence.needs === 1 ? 'session that needs' : 'sessions that need'} you` : 'Talk to Wanigan';
  return <div className="companion-presence" data-signal={presence.signal}>
    <Orb compact signal={presence.signal} temperament={temperament} attentionEvent={attentionEvent} answerEvent={completionEvent}
      label={`Wanigan · ${presence.label}. ${action}. Across all project spaces.`}
      popup={presence.needs > 0} expanded={expanded}
      onActivate={anchor => presence.needs ? onAttention(anchor) : onHome()}>
      <span className="companion-caption" aria-hidden="true"><strong>Wanigan</strong><span>{presence.label}</span></span>
    </Orb>
  </div>;
}
