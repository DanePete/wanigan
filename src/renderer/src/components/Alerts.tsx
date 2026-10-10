// Alerts while Wanigan is in front: a new permission request, failure or review
// somewhere other than what is on screen arrives as a line in the status line's
// own place, above it, pushing the work up rather than covering a control, with
// a way to go to it. Urgent ones stay until handled or dismissed; the rest fade.
// The app decides what to offer (shared/notifications.ts); this says back what
// it showed, so nothing counts as announced that nobody saw.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Need, NeedKind } from '@shared/model';
import { ALERT_FADE_MS, URGENT_KINDS, needKey, needRoute, notificationFor, onScreen, type Viewing } from '@shared/notifications';
import { bridge } from '../lib/api';
import { forgetStale } from '../lib/forget';
import type { Location } from '../lib/router';
import { Icon, type IconName } from './icons';
import { Button, IconButton, ProjectMark } from './ui';

const MAX_SHOWN = 3;
/** A fading line is taken away once its leaving (alerts.css, --dur) has played. */
const LEAVE_MS = 200;

interface Alert {
  key: string;
  need: Need;
  urgent: boolean;
  at: number;
}

/** The window's own list of needs can trail the offer by a moment; a card is not removed as closed before this. */
const SETTLE_MS = 5_000;
/** A closed need is forgotten this long after it was last seen, well past any late repeat of its offer. */
const FORGET_MS = 10 * 60_000;

const ICON: Record<NeedKind, IconName> = {
  permission: 'alert', starting: 'alert', failed: 'alert', interrupted: 'alert', review: 'check', question: 'question', overlap: 'file', quiet: 'running', waiting: 'check', limit: 'pause',
};

export function viewingOf(location: Location): Viewing {
  const r = location.route;
  return {
    route: r.name === 'needs' || r.name === 'project' || r.name === 'session' ? r.name : 'other',
    projectKey: r.name === 'project' || r.name === 'session' ? r.projectKey : null,
    sessionId: r.name === 'session' ? r.sessionId : null,
    cardKey: location.card,
  };
}

export function Alerts({ needs, location }: { needs: Need[] | undefined; location: Location }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const viewing = useMemo(() => viewingOf(location), [location]);
  const viewingRef = useRef(viewing);
  viewingRef.current = viewing;
  /** Every key this window has accounted for, so a repeated offer is not shown twice; by when, so it can forget. */
  const handled = useRef(new Map<string, number>());

  useEffect(() => bridge().onAlerts((offered) => {
    const seen: string[] = [];
    const add: Alert[] = [];
    for (const need of offered) {
      const key = needKey(need);
      if (handled.current.has(key)) continue;
      handled.current.set(key, Date.now());
      seen.push(key);
      if (!onScreen(need, viewingRef.current)) add.push({ key, need, urgent: URGENT_KINDS.has(need.kind), at: Date.now() });
    }
    if (add.length) setAlerts((current) => [...current, ...add]);
    if (seen.length) void bridge().alertsSeen(seen).catch(() => {});
  }), []);

  // A need that was answered, or that you went to look at, needs no card.
  const present = useRef(new Map<string, number>());
  useEffect(() => {
    if (!needs) return;
    const open = new Set(needs.map(needKey));
    const now = Date.now();
    for (const k of open) { present.current.set(k, now); if (handled.current.has(k)) handled.current.set(k, now); }
    // Open all day, the window would otherwise remember every need there ever was.
    forgetStale(present.current, (k) => open.has(k), now - FORGET_MS);
    forgetStale(handled.current, (k) => open.has(k), now - FORGET_MS);
    const closed = (a: Alert): boolean => !open.has(a.key) && (present.current.has(a.key) || Date.now() - a.at > SETTLE_MS);
    setAlerts((current) => {
      const next = current.filter((a) => !closed(a) && !onScreen(a.need, viewing));
      return next.length === current.length ? current : next;
    });
  }, [needs, viewing]);

  const remove = useCallback((key: string, dismiss: boolean) => {
    setAlerts((current) => current.filter((a) => a.key !== key));
    if (dismiss) void bridge().alertsDismissed([key]).catch(() => {});
  }, []);

  // Where they are said: the status line's own place, which is under every view (App.tsx).
  const [host, setHost] = useState<Element | null>(null);
  useEffect(() => { setHost(document.querySelector('.status-host')); }, [location, alerts.length]);

  if (!alerts.length) return null;
  // Urgent first, then newest first.
  const shown = [...alerts].reverse().sort((a, b) => Number(b.urgent) - Number(a.urgent)).slice(0, MAX_SHOWN);
  const more = alerts.length - shown.length;
  const list = (
    <section className={`alerts${host ? '' : ' alerts-floating'}`} aria-label="Alerts">
      {shown.map((a) => <AlertCard key={a.key} alert={a} onRemove={remove} />)}
      {more ? <a className="alerts-more" href="#/needs">{more} more in Needs you</a> : null}
    </section>
  );
  // With no status line on screen (a view broke it), they float at the window's foot instead of going unsaid.
  return createPortal(list, host ?? document.body);
}

function AlertCard({ alert, onRemove }: { alert: Alert; onRemove: (key: string, dismiss: boolean) => void }) {
  const { need, urgent, key } = alert;
  const { title, body } = notificationFor(need);
  const held = useRef(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (urgent) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (): void => {
      timer = setTimeout(() => {
        // Being read counts as using it.
        if (held.current) { arm(); return; }
        setLeaving(true);
        timer = setTimeout(() => onRemove(key, false), LEAVE_MS);
      }, ALERT_FADE_MS);
    };
    arm();
    return () => clearTimeout(timer);
  }, [urgent, key, onRemove]);

  // As Needs you marks them: red for what failed, water for a review, amber for an agent waiting on you.
  const tone = need.kind === 'failed' || need.kind === 'interrupted' ? 'failed' : need.kind === 'review' ? 'review' : 'needs';
  return (
    <article
      className={`alert alert-${tone}${urgent ? ' alert-urgent' : ''}${leaving ? ' is-leaving' : ''}`}
      role={urgent ? 'alert' : 'status'}
      aria-label={title}
      onMouseEnter={() => { held.current = true; }}
      onMouseLeave={() => { held.current = false; }}
      onFocus={() => { held.current = true; }}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) held.current = false; }}
    >
      <span className="alert-icon" aria-hidden="true"><Icon name={ICON[need.kind]} size={15} /></span>
      <ProjectMark projectKey={need.projectKey} size="s" />
      <p className="alert-text">
        <span className="alert-title">{title}</span>
        {body && body !== title ? <span className="alert-body">{body}</span> : null}
        <span className="alert-where">{need.projectName}</span>
      </p>
      <div className="alert-actions">
        <Button size="s" tone={urgent ? 'attention' : 'plain'} onClick={() => { window.location.hash = needRoute(need); onRemove(key, true); }}>Open</Button>
        <IconButton icon="close" size="s" label={`Dismiss: ${title}`} onClick={() => onRemove(key, true)} />
      </div>
    </article>
  );
}
