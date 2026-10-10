import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Account, Need, NeedKind, ProjectSummary, Session } from '@shared/model';
import { WATCH_FULL, WATCH_MAX, pickWatched, togglePin as pinToggled, topNeeds, watchColumns } from '@shared/watch';
import { useQuery } from '../lib/api';
import { href, openCard } from '../lib/router';
import { PROVIDER_LABEL, duration, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, Count, EmptyState, IconButton, NotAnswering, ProjectMark, Segmented, StateMark, tipProps } from '../components/ui';
import { Section } from '../components/Panel';
import { useHow } from '../lib/how';
import { HowArrow, HowBox, HowButton, HowDialog, HowLane, HowNote, howNum } from '../components/How';
import { Terminal } from '../components/Terminal';
import { SessionRow } from './SessionsView';

type Layout = 'list' | 'watch';
const LAYOUT_KEY = 'wanigan.running.layout';
const PINS_KEY = 'wanigan.watch.pins';
const LAYOUTS = [
  { value: 'list', label: 'List' },
  { value: 'watch', label: 'Watch', hint: `Up to ${WATCH_MAX} live terminals at once` },
] as const;
/** A tile's height for its width: about the shape of a session's terminal, as its own view draws it. */
const TILE_SHAPE = 0.62;
/** The needs the rest of the app marks amber (needs.css): the owner has to act. */
const AMBER: ReadonlySet<NeedKind> = new Set(['permission', 'overlap', 'limit', 'question']);

// Both are per-viewer conveniences: losing them loses nothing that matters.
function readLayout(): Layout {
  try { return localStorage.getItem(LAYOUT_KEY) === 'watch' ? 'watch' : 'list'; } catch { return 'list'; }
}
function readPins(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(PINS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** Every live session, in every project. The one place the whole crew is visible. */
export function RunningView({ projects, needs, onNewSession }: {
  projects: ProjectSummary[] | undefined;
  needs: Need[] | undefined;
  onNewSession: () => void;
}) {
  const sessions = useQuery('sessions.list', { live: true }, ['sessions']);
  const [layout, setLayoutState] = useState<Layout>(readLayout);
  const setLayout = (next: Layout): void => {
    setLayoutState(next);
    try { localStorage.setItem(LAYOUT_KEY, next); } catch { /* remembered for this visit only */ }
  };
  const [pins, setPinsState] = useState<string[]>(readPins);
  const setPins = (next: string[]): void => {
    setPinsState(next);
    try { localStorage.setItem(PINS_KEY, JSON.stringify(next)); } catch { /* remembered for this visit only */ }
  };
  // A pin on a session that has ended means nothing; let it go.
  useEffect(() => {
    if (!sessions.data) return;
    const live = new Set(sessions.data.map((s) => s.id));
    if (pins.some((id) => !live.has(id))) setPins(pins.filter((id) => live.has(id)));
  }, [sessions.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const pinsFull = pins.length >= WATCH_MAX;
  const togglePin = (id: string): void => {
    const next = pinToggled(pins, id);
    if ('pins' in next) setPins(next.pins);
  };

  const groups = useMemo(() => {
    const byProject = new Map<string, NonNullable<typeof sessions.data>>();
    for (const s of sessions.data ?? []) byProject.set(s.projectId, [...(byProject.get(s.projectId) ?? []), s]);
    return (projects ?? []).filter((p) => byProject.has(p.id)).map((p) => ({ project: p, sessions: byProject.get(p.id) ?? [] }));
  }, [sessions.data, projects]);
  const total = sessions.data?.length ?? 0;

  // The session being typed into stays on screen while it has the keys.
  const [typing, setTyping] = useState<string | null>(null);
  // The same sessions the list shows: those in a project that is open.
  const pick = useMemo(() => pickWatched(groups.flatMap((g) => g.sessions), needs ?? [], pins, typing), [groups, needs, pins, typing]);
  const top = useMemo(() => topNeeds(needs ?? []), [needs]);
  const watching = layout === 'watch' && total > 0;
  const how = useHow('running');

  return (
    <section className="view running-view" aria-labelledby="running-title">
      <header className="topbar">
        <div className="topbar-title">
          <h1 id="running-title">Running</h1>
          {sessions.data && total ? <Count n={total} label={plural(total, 'live session')} /> : null}
        </div>
        <div className="topbar-tools">
          {watching && pick.more ? (
            <span className="toolbar-count watch-more" {...(pick.pinned ? {} : tipProps('Pin the ones to watch from the list'))}>
              {plural(pick.more, 'more session')} running, not shown.
            </span>
          ) : null}
          <HowButton onClick={how.show} />
          <span className="running-layout" data-tour="running-layout"><Segmented label="Layout" size="s" value={layout} options={LAYOUTS} onChange={setLayout} /></span>
          <Button size="s" tone="primary" icon="terminal" keys="new-session" onClick={onNewSession} data-tour="running-new">New session</Button>
        </div>
      </header>
      <div className="view-body">
        {sessions.error ? <NotAnswering error={sessions.error} onRetry={sessions.reload} /> : sessions.data && !total ? (
          <EmptyState title="Nothing is running" icon="running" action={<Button tone="primary" icon="terminal" keys="new-session" onClick={onNewSession}>New session</Button>}>
            Sessions run in Wanigan’s core, not in this window: close it and they keep going, and this is where to find them again.
          </EmptyState>
        ) : watching ? (
          <Watch shown={pick.shown} projects={projects} needs={needs} pins={pins} onTogglePin={togglePin}
            typing={typing} setTyping={setTyping} />
        ) : (
          <div className="running-list" data-tour="running-list">
            {groups.map(({ project, sessions: list }) => (
              <Section key={project.id} className="running-group" title={<><ProjectMark projectKey={project.key} size="s" />{project.name} <Count n={list.length} /></>}>
                <div className="srows">
                  {list.map((s) => (
                    <div key={s.id} className="running-row">
                      <SessionRow session={s} projectKey={project.key} />
                      <span className="running-actions" data-tour="running-actions">
                        <RowAction session={s} projectKey={project.key} need={top.get(s.id) ?? null} />
                        <PinButton session={s} pinned={pins.includes(s.id)} full={pinsFull} onToggle={() => togglePin(s.id)} />
                      </span>
                    </div>
                  ))}
                </div>
              </Section>
            ))}
          </div>
        )}
      </div>
      {how.open ? (
        <RunningHow total={sessions.data ? total : null} asking={sessions.data ? groups.flatMap((g) => g.sessions).filter((s) => { const n = top.get(s.id); return !!n && AMBER.has(n); }).length : null}
          pinned={pins.length} shown={watching ? pick.shown.length : null} onClose={how.hide} onWatch={() => setLayout('watch')} onList={() => setLayout('list')} />
      ) : null}
    </section>
  );
}

/** How Running works, as a picture: every sentence is a rule Watch or the core enforces, with this window's numbers. */
function RunningHow({ total, asking, pinned, shown, onClose, onWatch, onList }: {
  total: number | null; asking: number | null; pinned: number; shown: number | null; onClose: () => void; onWatch: () => void; onList: () => void;
}) {
  const then = (to: () => void) => () => { onClose(); to(); };
  return (
    <HowDialog place="running" title="How Running works" onClose={onClose}
      intro={<><strong>Every live session in every project, in one place.</strong> They run in Wanigan’s core; this view finds them, says which need you, and lets you watch several at once.</>}
      side={(
        <>
          <HowNote title="Needs you, in amber" tone="needs">
            <ul>
              <li><strong>Asking permission:</strong> answer it in the session’s terminal.</li>
              <li><strong>A question on its card:</strong> answer it on the card.</li>
              <li><strong>Out of its limit:</strong> carry it on under another account, or wait.</li>
              <li><strong>Two sessions, one file:</strong> they may be undoing each other.</li>
            </ul>
          </HowNote>
          <HowNote title="Reading the picture" tone="quiet">
            <ul>
              <li>Click a box to show that layout.</li>
              <li>Numbers are live. A missing number means its source has not answered.</li>
            </ul>
          </HowNote>
        </>
      )}>
      <HowLane n={1} title="Running" actor="agents">
        <HowBox actor="agents" title="Every live session" num={howNum(total, 'running', 'running')} onClick={then(onList)} hint="Show the list">
          In every open project, grouped by project, each with its agent, card and how long it has run.
        </HowBox>
        <HowArrow />
        <HowBox actor="board" tag="Wanigan" title="In the core, not the window">
          Close the window and they keep going; open it again and they are here, output and all.
        </HowBox>
      </HowLane>
      <HowLane n={2} title="What needs you" actor="needs">
        <HowBox actor="needs" title="Ranked as Needs you ranks them" num={howNum(asking, 'needs you now', 'need you now')}>
          The same needs, in the same order: a permission first, then two sessions on one file, then a limit, then a question on a card.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Its action, in place">
          The row offers the answer Needs you would: the terminal, the card, or carrying it on. A session that needs nothing has only its pin.
        </HowBox>
      </HowLane>
      <HowLane n={3} title="Watch" actor="you">
        <HowBox actor="you" title={`Up to ${WATCH_MAX} at once`} num={shown !== null ? howNum(shown, 'shown now', 'shown now') : null} onClick={then(onWatch)} hint="Show Watch">
          Each live terminal at its own size, scaled to fit. Watching never resizes a session, so its screen stays as the agent left it.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Which ones" num={pinned ? howNum(pinned, 'pinned', 'pinned') : null}>
          Pins choose them, in the order pinned. With none, the ones that need you most, then the most recently active.
        </HowBox>
        <HowArrow />
        <HowBox actor="you" title="Typing into one">
          A tile is read-only until you click it or press Enter on it; Esc gives the keys back. One out of sight is not drawn.
        </HowBox>
      </HowLane>
    </HowDialog>
  );
}

/**
 * What a row that needs you offers, in place: the same action Needs you gives
 * it, in amber. A session that needs nothing has only its pin.
 */
function RowAction({ session, projectKey, need }: { session: Session; projectKey: string; need: NeedKind | null }) {
  if (!need || !AMBER.has(need)) return null;
  const open = href({ name: 'session', projectKey, sessionId: session.id });
  if (need === 'question' && session.cardKey) {
    const key = session.cardKey;
    return <Button size="s" tone="attention" onClick={() => openCard(key)} {...tipProps(`Answer the question on ${key}`)}>Answer</Button>;
  }
  const words = need === 'permission' ? 'Answer in terminal' : need === 'limit' ? 'Carry it on' : 'Open';
  const tip = need === 'permission' ? 'The terminal has the keys when it opens'
    : need === 'limit' ? 'Out of its usage limit: continue on another account, or wait for the reset'
      : 'Another session is working on the same files';
  return <a className="btn btn-s btn-attention" href={open} {...tipProps(tip)}><span>{words}</span></a>;
}

function PinButton({ session, pinned, full, onToggle }: { session: Session; pinned: boolean; full: boolean; onToggle: () => void }) {
  return (
    <IconButton icon="pin" size="s"
      label={pinned ? `Unpin ${session.title} from Watch` : full ? `Pin ${session.title} to Watch. ${WATCH_FULL}` : `Pin ${session.title} to Watch`}
      pressed={pinned} disabled={!pinned && full} onClick={onToggle} data-tour="running-pin" />
  );
}

/**
 * Up to WATCH_MAX live terminals at once. The columns follow the count (one
 * fills the room, two sit side by side, then 2×2, 3×2, 3×3, 4×3) and the room:
 * no tile is narrower or shorter than its stylesheet's readable minimum (80
 * columns by 16 rows of the terminal's font at the smallest text size), so a
 * window too small for them all scrolls rather than squeezing them.
 */
function Watch({ shown, projects, needs, pins, onTogglePin, typing, setTyping }: {
  shown: Session[];
  projects: ProjectSummary[] | undefined;
  needs: Need[] | undefined;
  pins: string[];
  onTogglePin: (id: string) => void;
  typing: string | null;
  setTyping: (id: string | null) => void;
}) {
  const accounts = useQuery('accounts.list', {}, ['accounts']);
  const top = useMemo(() => topNeeds(needs ?? []), [needs]);
  // How long each has been running moves on by itself.
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const grid = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [layout, setLayout] = useState<{ columns: number; row: number }>({ columns: 1, row: 0 });
  useEffect(() => {
    const el = grid.current;
    if (!el) return undefined;
    const measure = (): void => {
      const css = getComputedStyle(el);
      const room = el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
      const gap = parseFloat(css.columnGap) || 0;
      // The probe is the readable minimum, drawn by the stylesheet: its size is the least a tile may be.
      const width = probe.current?.offsetWidth ?? 0;
      const height = probe.current?.offsetHeight ?? 0;
      const columns = watchColumns(shown.length, room + gap, width + gap);
      // A tile keeps about a terminal's shape, so a session's screen scales by its width, not squashed by a short row.
      const column = (room - gap * (columns - 1)) / columns;
      const row = Math.round(Math.max(height, column * TILE_SHAPE));
      setLayout((was) => (was.columns === columns && was.row === row ? was : { columns, row }));
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, [shown.length]);
  const { columns, row } = layout;
  // The rows share the room when it is there, and never go under a terminal's shape: then Watch scrolls.
  const rows = `minmax(${row}px, 1fr)`;

  return (
    <div className="watch-area">
      <span ref={probe} className="watch-probe" aria-hidden="true" />
      <div ref={grid} className={`watch watch-n${shown.length}`}
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: rows }} data-columns={columns}>
        {shown.map((s, i) => {
          const project = projects?.find((p) => p.id === s.projectId);
          // A last tile alone in its row takes the whole row.
          const alone = columns > 1 && i === shown.length - 1 && shown.length % columns === 1;
          return (
            <WatchTile key={s.id} session={s} projectKey={project?.key ?? '?'} need={top.get(s.id) ?? null} wide={alone}
              account={s.accountId ? accounts.data?.find((a) => a.id === s.accountId) : undefined}
              pinned={pins.includes(s.id)} onTogglePin={() => onTogglePin(s.id)}
              typing={typing === s.id} onTyping={(on) => setTyping(on ? s.id : null)} />
          );
        })}
      </div>
    </div>
  );
}

function WatchTile({ session, projectKey, need, wide, account, pinned, onTogglePin, typing, onTyping }: {
  session: Session;
  projectKey: string;
  /** Alone in the last row: it spans the row. */
  wide: boolean;
  need: NeedKind | null;
  account: Account | undefined;
  pinned: boolean;
  onTogglePin: () => void;
  typing: boolean;
  onTyping: (on: boolean) => void;
}) {
  const tile = useRef<HTMLElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const giveKeys = useRef<(() => void) | null>(null);
  const seen = useSeen(tile);
  const open = href({ name: 'session', projectKey, sessionId: session.id });
  const who = `${PROVIDER_LABEL[session.provider]}${account ? ` as ${account.label}` : ''}`;
  const asking = need !== null && AMBER.has(need);

  return (
    <article ref={tile} className={`watch-tile${asking ? ' asking' : ''}${typing ? ' typing' : ''}`} aria-label={session.title}
      style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <header className="watch-head">
        <ProjectMark projectKey={projectKey} size="s" />
        <span className="watch-title" {...tipProps(session.title)}>{session.title}</span>
        <StateMark state={session.state} />
        <span className="watch-facts" {...tipProps(`${who}, running for ${duration(session.startedAt)}`)}>
          <span className="watch-who">
            <Icon name={session.provider === 'shell' ? 'terminal' : session.provider} size={14} />
            {account ? <><span className="visually-hidden">{PROVIDER_LABEL[session.provider]} as </span>{account.label}</> : PROVIDER_LABEL[session.provider]}
          </span>
          <span className="faint">{duration(session.startedAt)}</span>
        </span>
        <span className="watch-tools">
          <a className="btn btn-quiet btn-icon btn-icon-s" href={open} aria-label={`Open ${session.title}`} {...tipProps('Open the session')}><Icon name="open" size={14} /></a>
          {/* Pinning is done from the list; a tile Wanigan chose has nothing to unpin. */}
          {pinned ? <PinButton session={session} pinned full={false} onToggle={onTogglePin} /> : null}
        </span>
      </header>
      {/* Read-only until asked: a click, or Enter on the focused tile, hands it the keys; Escape takes them back. */}
      <div
        ref={screen}
        className="watch-screen"
        role="group"
        tabIndex={0}
        aria-label={typing ? `Typing into ${session.title}. Escape to stop.` : `${session.title}. Press Enter to type into it.`}
        {...(typing ? {} : tipProps('Click, or press Enter, to type into this session'))}
        onMouseDown={(e) => { if (e.button === 0) { e.preventDefault(); giveKeys.current?.(); } }}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); giveKeys.current?.(); }
        }}
        onFocus={(e) => { if (e.target !== e.currentTarget) onTyping(true); }}
        onBlur={(e) => { if (e.target !== e.currentTarget) onTyping(false); }}
      >
        {seen ? <Terminal sessionId={session.id} live fixedSize focusRef={giveKeys} onEscape={() => screen.current?.focus()} /> : null}
        {typing ? <span className="watch-hint" aria-hidden="true">Typing into this session · Esc to stop</span> : null}
      </div>
    </article>
  );
}

/**
 * Whether a tile can be seen: on screen, in a window that is not hidden. A
 * terminal nobody can see is not drawn and not watched; going away waits a
 * moment, so a quick scroll past does not restart it.
 */
function useSeen(ref: RefObject<HTMLElement | null>): boolean {
  const [onScreen, setOnScreen] = useState(true);
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(!!entry?.isIntersecting), { rootMargin: '120px' });
    io.observe(el);
    const onVisibility = (): void => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [ref]);
  const now = onScreen && visible;
  const [seen, setSeen] = useState(now);
  useEffect(() => {
    if (now) { setSeen(true); return; }
    const t = setTimeout(() => setSeen(false), 1500);
    return () => clearTimeout(t);
  }, [now]);
  return seen;
}
