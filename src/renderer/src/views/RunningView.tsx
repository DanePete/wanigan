import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Account, Need, NeedKind, ProjectSummary, Session } from '@shared/model';
import { WATCH_MAX, pickWatched, topNeeds } from '@shared/watch';
import { useQuery } from '../lib/api';
import { href } from '../lib/router';
import { PROVIDER_LABEL, duration, plural } from '../lib/format';
import { Icon } from '../components/icons';
import { Button, Empty, IconButton, NotAnswering, ProjectMark, Segmented, StateMark } from '../components/ui';
import { Terminal } from '../components/Terminal';
import { SessionRow } from './ProjectView';

type Layout = 'list' | 'watch';
const LAYOUT_KEY = 'wanigan.running.layout';
const PINS_KEY = 'wanigan.watch.pins';
const LAYOUTS = [
  { value: 'list', label: 'List' },
  { value: 'watch', label: 'Watch', hint: `Up to ${WATCH_MAX} live terminals at once` },
] as const;
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
    if (pins.includes(id)) setPins(pins.filter((p) => p !== id));
    else if (!pinsFull) setPins([...pins, id]);
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
  const watching = layout === 'watch' && total > 0;

  return (
    <section className="view" aria-labelledby="running-title">
      <header className="topbar">
        <div className="topbar-title"><h1 id="running-title">Running</h1><span className="faint">{sessions.data ? plural(total, 'live session') : ''}</span></div>
        <div className="topbar-tools">
          {watching && pick.more ? (
            <span className="faint small watch-more">
              {plural(pick.more, 'more session')} running, not shown.{pick.pinned ? '' : ' Pin the ones to watch from the list.'}
            </span>
          ) : null}
          <Segmented label="Layout" value={layout} options={LAYOUTS} onChange={setLayout} />
        </div>
      </header>
      <div className="view-body">
        {sessions.error ? <NotAnswering error={sessions.error} onRetry={sessions.reload} /> : sessions.data && !total ? (
          <Empty title="Nothing is running" action={<Button tone="primary" icon="terminal" onClick={onNewSession}>New session</Button>}>
            Sessions run in Wanigan’s core, not in this window. Close the window and they keep going; this list is where to find them again.
          </Empty>
        ) : watching ? (
          <Watch shown={pick.shown} projects={projects} needs={needs} pins={pins} onTogglePin={togglePin}
            typing={typing} setTyping={setTyping} />
        ) : (
          <div className="view-pad running">
            {groups.map(({ project, sessions: list }) => (
              <section key={project.id} className="running-group" aria-label={project.name}>
                <h2 className="section-title"><ProjectMark projectKey={project.key} size="s" /> {project.name} <span className="faint">{list.length}</span></h2>
                <div className="srows">
                  {list.map((s) => (
                    <div key={s.id} className="running-row">
                      <SessionRow session={s} projectKey={project.key} />
                      <PinButton session={s} pinned={pins.includes(s.id)} full={pinsFull} onToggle={() => togglePin(s.id)} />
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function PinButton({ session, pinned, full, onToggle }: { session: Session; pinned: boolean; full: boolean; onToggle: () => void }) {
  return (
    <IconButton icon="pin" label={pinned ? `Unpin ${session.title} from Watch` : `Pin ${session.title} to Watch`}
      aria-pressed={pinned} disabled={!pinned && full} onClick={onToggle}
      title={!pinned && full ? `Watch shows ${WATCH_MAX} at a time. Unpin one first.` : pinned ? 'Unpin from Watch' : 'Pin to Watch'} />
  );
}

/** Up to four live terminals at once: one fills the room, two sit side by side, three or four make a grid. */
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

  return (
    <div className="watch-area">
      <div className={`watch watch-n${shown.length}`}>
        {shown.map((s) => {
          const project = projects?.find((p) => p.id === s.projectId);
          return (
            <WatchTile key={s.id} session={s} projectKey={project?.key ?? '?'} need={top.get(s.id) ?? null}
              account={s.accountId ? accounts.data?.find((a) => a.id === s.accountId) : undefined}
              pinned={pins.includes(s.id)} onTogglePin={() => onTogglePin(s.id)}
              typing={typing === s.id} onTyping={(on) => setTyping(on ? s.id : null)} />
          );
        })}
      </div>
    </div>
  );
}

function WatchTile({ session, projectKey, need, account, pinned, onTogglePin, typing, onTyping }: {
  session: Session;
  projectKey: string;
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
    <article ref={tile} className={`watch-tile${asking ? ' asking' : ''}${typing ? ' typing' : ''}`} aria-label={session.title}>
      <header className="watch-head">
        <ProjectMark projectKey={projectKey} size="s" />
        <span className="watch-title" title={session.title}>{session.title}</span>
        <StateMark state={session.state} />
        <span className="watch-facts" title={`${who}, running for ${duration(session.startedAt)}`}>
          <span className="watch-who">
            <Icon name={session.provider === 'shell' ? 'terminal' : session.provider} size={14} />
            {account ? <><span className="visually-hidden">{PROVIDER_LABEL[session.provider]} as </span>{account.label}</> : PROVIDER_LABEL[session.provider]}
          </span>
          <span className="faint">{duration(session.startedAt)}</span>
        </span>
        <span className="watch-tools">
          <a className="btn btn-quiet btn-icon" href={open} aria-label={`Open ${session.title}`} title="Open the session"><Icon name="open" /></a>
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
        title={typing ? undefined : 'Click to type into this session'}
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
