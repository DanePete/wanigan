// Guided tours (tours/): the welcome tour plays once on the first launch; each
// view's own tour offers itself in the status line the first time the view is
// opened, and replays from the status line's compass and the palette. A tour
// dims the window around one thing at a time and says beside it what it is for
// and what you can do there. It is a modal: Next and Back (→ and ←), Esc ends
// it, focus stays in its card and goes back where it was. Like every overlay it
// steps the live view aside, so it can point at what is drawn where the page is.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ProjectSummary } from '@shared/model';
import { bridge } from '../lib/api';
import { useCoversLive } from '../lib/live';
import { navigate, type Route } from '../lib/router';
import { mayOffer, placeCard, type Placed, type Rect } from '../lib/tour-model';
import { dismissTourOffer, endTour, startTour, toursOnTheirOwn, usePlayingTour, useTourState } from '../lib/tours';
import { TOURS, tourFor, type Tour, type TourContext, type TourStep } from '../tours';
import { Button, IconButton, useFocusTrap } from './ui';
import { Icon } from './icons';

/** How far the lit area reaches past its target, in CSS pixels. */
const SPOT_PAD = 6;
const NAME = /^[a-z0-9-]+$/;

/** What a step points at, when it is on the screen: drawn, with a size. */
function findTarget(name: string | undefined): HTMLElement | null {
  if (!name || !NAME.test(name)) return null;
  const el = document.querySelector<HTMLElement>(`[data-tour~="${name}"]`);
  if (!el || !el.getClientRects().length) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

/** Wait for a step's target to be drawn (a view that has just been opened), up to `ms`. */
function waitForTarget(name: string, ms: number): Promise<HTMLElement | null> {
  return new Promise((resolve) => {
    const until = performance.now() + ms;
    const look = (): void => {
      const el = findTarget(name);
      if (el || performance.now() > until) resolve(el);
      else requestAnimationFrame(look);
    };
    look();
  });
}

const sameRect = (a: Rect | null, b: Rect | null): boolean =>
  a === b || (!!a && !!b && Math.abs(a.left - b.left) < 0.5 && Math.abs(a.top - b.top) < 0.5 && Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5);

export function tourContext(route: Route, projects: readonly ProjectSummary[] | undefined): TourContext {
  return {
    mac: bridge().platform === 'darwin',
    projectKey: route.name === 'project' || route.name === 'session' ? route.projectKey : null,
    firstProjectKey: (projects?.find((p) => !p.pausedAt) ?? projects?.[0])?.key ?? null,
  };
}

/**
 * Mounted once (App.tsx): plays the tour that is playing, and starts the welcome
 * tour on the first launch, once the projects have answered and no dialog is open.
 */
export function TourHost({ route, projects, blocked }: { route: Route; projects: readonly ProjectSummary[] | undefined; blocked: boolean }) {
  const playing = usePlayingTour();
  const seen = useTourState();
  useEffect(() => {
    if (playing || blocked || !projects || !TOURS.has('welcome') || !toursOnTheirOwn() || !mayOffer(seen, 'welcome')) return undefined;
    const t = setTimeout(() => startTour('welcome'), 700);
    return () => clearTimeout(t);
  }, [playing, blocked, projects, seen]);
  const tour = playing ? TOURS.get(playing) : undefined;
  return tour ? <TourRun key={tour.id} tour={tour} ctx={tourContext(route, projects)} /> : null;
}

function TourRun({ tour, ctx }: { tour: Tour; ctx: TourContext }) {
  const [at, setAt] = useState(-1);
  const ctxNow = useRef(ctx);
  ctxNow.current = ctx;
  const moving = useRef(0);
  useCoversLive(true);

  // Whether a step can be shown from here: no target, a place to go, or its target on the screen.
  const showable = useCallback((s: TourStep): boolean => {
    if (!s.target) return true;
    const to = s.go?.(ctxNow.current);
    if (to === null) return false;
    return to !== undefined || !!findTarget(s.target);
  }, []);

  // To a step: go where it says, wait for its target, and pass over it if the target never shows.
  const move = useCallback((from: number, dir: 1 | -1): void => {
    const token = ++moving.current;
    const visit = async (i: number): Promise<void> => {
      if (token !== moving.current) return;
      if (i < 0) return; // back from the first: stay
      if (i >= tour.steps.length) { endTour(); return; }
      const step = tour.steps[i]!;
      const to = step.go?.(ctxNow.current);
      if (to === null) { await visit(i + dir); return; }
      if (to) navigate(to);
      if (!step.target) { setAt(i); return; }
      const el = await waitForTarget(step.target, to ? 2500 : 400);
      if (token !== moving.current) return;
      if (!el) { await visit(i + dir); return; }
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      setAt(i);
    };
    void visit(from + dir);
  }, [tour]);

  useEffect(() => { move(-1, 1); }, [move]);
  // From the last stop that can be shown, Next is Done: it ends the tour at once rather than look for stops that are not there.
  const shownNow = useRef<boolean[]>([]);
  const next = useCallback(() => (shownNow.current.slice(at + 1).some(Boolean) ? move(at, 1) : endTour()), [move, at]);
  const back = useCallback(() => move(at, -1), [move, at]);

  // → and ← step; the window's own keys stay out of it while the tour is up (it is aria-modal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); back(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [next, back]);

  const step = at >= 0 ? tour.steps[at] : undefined;
  if (!step) return null;
  const shown = tour.steps.map((s, i) => (i === at ? true : showable(s)));
  shownNow.current = shown;
  return <TourCard tour={tour} step={step} at={at} shown={shown} ctx={ctx} next={next} back={back} />;
}

/** The lit target and the card beside it: mounted with the first step, so focus moves into it once and returns once. */
function TourCard({ tour, step, at, shown, ctx, next, back }: {
  tour: Tour; step: TourStep; at: number; shown: boolean[]; ctx: TourContext; next: () => void; back: () => void;
}) {
  const [rect, setRect] = useState<Rect | null>(null);
  const [place, setPlace] = useState<Placed | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  useFocusTrap(card, endTour, '[data-autofocus]');

  // Follow the target as the window lays out (a panel opening, the window resized, a scroll).
  useEffect(() => {
    if (!step.target) { setRect(null); return undefined; }
    let raf = 0;
    const tick = (): void => {
      const r = findTarget(step.target)?.getBoundingClientRect();
      const now = r ? { left: r.left - SPOT_PAD, top: r.top - SPOT_PAD, width: r.width + 2 * SPOT_PAD, height: r.height + 2 * SPOT_PAD } : null;
      setRect((was) => (sameRect(was, now) ? was : now));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  useLayoutEffect(() => {
    const el = card.current;
    if (!el) return;
    const size = el.getBoundingClientRect();
    setPlace(placeCard(rect, { width: size.width, height: size.height }, { width: innerWidth, height: innerHeight }, step.side ?? 'bottom'));
  }, [rect, step]);

  const total = shown.filter(Boolean).length;
  const pos = shown.slice(0, at + 1).filter(Boolean).length;
  const first = !shown.slice(0, at).some(Boolean);
  const last = !shown.slice(at + 1).some(Boolean);
  const body = typeof step.body === 'function' ? step.body(ctx) : step.body;
  return createPortal(
    <div className="tour" data-tour-id={tour.id}>
      {rect ? <div className="tour-spot" aria-hidden="true" data-tour-target={step.target} style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} />
        : <div className="tour-shade" aria-hidden="true" />}
      <div ref={card} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId}
        className={`tour-card tour-${place?.side ?? 'center'}`}
        // Unplaced it is transparent, not hidden: a hidden card could not take the focus it is given as it opens.
        style={place ? { left: place.left, top: place.top } : { opacity: 0 }}>
        <p className="tour-where">
          <Icon name="tour" size={14} />
          <span>{tour.id === 'welcome' ? 'Welcome' : `Tour of ${tour.name}`}</span>
          <span className="tour-count">{pos} of {total}</span>
        </p>
        <h2 id={titleId} className="tour-title">{step.title}</h2>
        <p id={bodyId} className="tour-body">{body}</p>
        <div className="tour-foot">
          <Button tone="quiet" size="s" onClick={endTour}>End tour</Button>
          <span className="tour-dots" aria-hidden="true">
            {shown.map((s, i) => (s ? <span key={i} className={i === at ? 'on' : ''} /> : null))}
          </span>
          <Button size="s" onClick={back} disabled={first} aria-keyshortcuts="ArrowLeft">Back</Button>
          <Button tone="primary" size="s" onClick={next} data-autofocus aria-keyshortcuts="ArrowRight">{last ? 'Done' : 'Next'}</Button>
        </div>
        <span className="visually-hidden" aria-live="polite">{`${pos} of ${total}: ${step.title}`}</span>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A view's tour, offered in the status line on the view's first visit: Take the
 * tour, or Not now (either way it is not offered again). Offered only after the
 * welcome tour has had its turn, so two tours never compete for the first minute.
 */
export function TourOffer({ tour }: { tour: Tour | null }) {
  const seen = useTourState();
  const playing = usePlayingTour();
  const welcomed = seen.seen.includes('welcome') || !TOURS.has('welcome');
  if (!tour || playing || !welcomed || !toursOnTheirOwn() || !mayOffer(seen, tour.id)) return null;
  return (
    <span className="tour-offer" role="status">
      <Icon name="tour" size={14} className="tour-offer-icon" />
      <span className="tour-offer-text"><strong>New to {tour.name}?</strong> {tour.intro}</span>
      <Button size="s" tone="primary" onClick={() => startTour(tour.id)}>Take the tour</Button>
      <IconButton icon="close" size="s" label={`Not now: don’t offer the tour of ${tour.name} again`} onClick={() => dismissTourOffer(tour.id)} />
    </span>
  );
}

/** The compass at the status line's end: plays the view's tour again. Nothing where the view has none. */
export function TourReplay({ tour }: { tour: Tour | null }) {
  if (!tour) return null;
  return <IconButton icon="tour" size="s" label={`Tour of ${tour.name}`} className="status-tour" data-tour="status-tour" onClick={() => startTour(tour.id)} />;
}

/** Replays the tour of the place a route shows; false when it has none. */
export function replayTourOf(route: Route): boolean {
  const tour = tourFor(route);
  if (!tour) return false;
  startTour(tour.id);
  return true;
}
