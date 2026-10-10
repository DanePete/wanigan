// "How this works": a view's rules as a picture, with live numbers. Every view
// that is more than a simple form has one (the board's is views/HowItWorks.tsx),
// opened from its toolbar (HowButton) and the palette, so the owner understands
// what they are doing there before they do it. Every sentence is a rule the code
// enforces; a number whose source has not answered is left out, never guessed.
//
//   const how = useHow('changes');
//   <HowButton onClick={how.show} />
//   {how.open ? <HowDialog place="changes" title="How Changes works" intro={…} onClose={how.hide} side={…}>
//     <HowLane n={1} title="…" actor="agents"><HowBox …/><HowArrow label="…" /><HowBox …/></HowLane>
//   </HowDialog> : null}
import type { KeyboardEvent, ReactNode } from 'react';
import { startTour } from '../lib/tours';
import { TOURS } from '../tours';
import { Button, Dialog } from './ui';

/** Who does a step: each has its colour (styles/how.css) and the tag a box shows. */
export type HowActor = 'you' | 'agents' | 'jev' | 'board' | 'wanigan' | 'site' | 'needs' | 'done';

const TAG: Record<HowActor, string> = {
  you: 'You', agents: 'Agents', jev: 'Jev', board: 'The board', wanigan: 'Wanigan', site: 'The site', needs: 'Needs you', done: 'Done',
};

/** The toolbar's button that opens a view's How this works. */
export function HowButton({ onClick, label = 'How this works' }: { onClick: () => void; label?: string }) {
  return <Button size="s" icon="question" onClick={onClick}>{label}</Button>;
}

/** The dialog: an intro, the flow as lanes, and side notes; with the view's tour a click away when it has one. */
export function HowDialog({ place, title, intro, side, onClose, children }: {
  /** The view's place (tours/index.ts), for its tour. */
  place: string;
  title: string;
  intro: ReactNode;
  side?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const tour = TOURS.get(place);
  return (
    <Dialog title={title} onClose={onClose} width={1240}
      footer={tour ? <Button tone="quiet" size="s" icon="tour" onClick={() => { onClose(); startTour(tour.id); }}>Take the tour of {tour.name}</Button> : undefined}>
      <p className="how-intro">{intro}</p>
      <div className={side ? 'how' : 'how how-alone'}>
        <div className="how-flow">{children}</div>
        {side ? <aside className="how-side">{side}</aside> : null}
      </div>
    </Dialog>
  );
}

export function HowLane({ n, title, actor, children }: { n: number; title: string; actor: HowActor; children: ReactNode }) {
  return (
    <section className={`how-lane how-${actor}`} aria-label={`${n}. ${title}`}>
      <h3 className="how-lane-title"><span className="how-lane-n">{n}</span>{title}</h3>
      <div className="how-lane-row">{children}</div>
    </section>
  );
}

/** One step: who does it, what it is, the rule in a sentence or two, and a live number. A box with `onClick` opens what it describes. */
export function HowBox({ actor, title, num, children, onClick, hint, tag }: {
  actor: HowActor; title: string; num?: string | null; children: ReactNode; onClick?: () => void; hint?: string; tag?: string;
}) {
  const onKey = (e: KeyboardEvent): void => {
    if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); }
  };
  return (
    <div
      className={`how-box how-${actor}${onClick ? ' linked' : ''}`}
      {...(onClick ? { role: 'link', tabIndex: 0, onClick, onKeyDown: onKey, 'aria-label': `${title}. ${hint ?? ''}`, 'data-tip': hint } : {})}
    >
      <span className="how-tag">{tag ?? TAG[actor]}</span>
      <strong className="how-title">{title}</strong>
      <p className="how-text">{children}</p>
      {num ? <span className="how-num">{num}</span> : null}
    </div>
  );
}

export function HowArrow({ label }: { label?: string }) {
  return (
    <span className={`how-arrow${label ? ' labelled' : ''}`} aria-hidden="true">
      {label ? <span className="how-arrow-label">{label}</span> : null}
    </span>
  );
}

/** A side note: a heading and a few lines (when you are needed, who does what, reading the picture). */
export function HowNote({ title, tone, children }: { title: string; tone?: 'needs' | 'quiet'; children: ReactNode }) {
  return (
    <section className={`how-card${tone ? ` how-card-${tone}` : ''}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

/** "3 waiting" from a count, or nothing while its source has not answered. */
export function howNum(n: number | null | undefined, one: string, many = one): string | null {
  if (n === null || n === undefined) return null;
  return `${n} ${n === 1 ? one : many}`;
}
