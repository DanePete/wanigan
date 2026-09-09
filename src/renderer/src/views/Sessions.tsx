import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LaunchModelCatalogue, LaunchModelRow, LaunchOptions, PastSession, Project, ProviderInfo,
  Session, TrustLevel, WorktreeInfo,
} from '@shared/types';
import { TRUST_LEVELS, trustCopy, trustGlyph } from '@shared/types';
import { launchFieldChoices } from '@shared/launch-fields';
import { providerTint } from '@shared/provider-status';
import { applyUnreadCounts } from '@shared/unread';
import TerminalPane, { disposePane } from '../components/TerminalPane';
import Composer from '../components/Composer';
import NewSessionDialog from '../components/NewSessionDialog';
import CodePanel from '../components/CodePanel';
import AttentionQueue from '../components/AttentionQueue';
import Timeline from '../components/Timeline';
import SessionLearning from '../components/SessionLearning';
import Pet from '../components/Pet';
import { ConfirmNote, Explainer, Mark, Note, ago, num, usd } from '../components/bits';
import type { Tone } from '../components/bits';
import { useDialog } from '../components/useDialog';
import { bindingMatches, modalOpen } from '../bindings';
import '../styles/sessions.css';

/* ── phase 21 · what an attachment looks like ─────────────────────────
   The shapes live in the main process (src/main/attachments.ts) and cross the
   preload untyped. Restating the two fields-sets this view renders keeps
   node-side code out of the web build; the names match the main process
   exactly, so a drift shows up as a missing column rather than a wrong one. */
type AttachKind = 'image' | 'pdf' | 'text' | 'notebook' | 'unsupported';

type Attachment = {
  id: string;
  sessionId: string | null;
  name: string;
  storedPath: string;
  kind: AttachKind;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
  visualTokens: number | null;
  addedAt: number;
  fileId: string | null;
  /** Set once this file's path has been typed into the prompt. */
  referencedAt: number | null;
  /** Set once the operator submitted a line carrying that reference. */
  sentAt: number | null;
};

type AttachCheck = {
  ok: boolean;
  kind: AttachKind;
  bytes: number;
  visualTokens: number | null;
  estimatedUsd: number | null;
  warnings: string[];
  error: string | null;
};

/** Glyph AND word for every kind — the shape survives greyscale and a screenshot. */
const KIND: Record<AttachKind, { glyph: string; word: string }> = {
  image:       { glyph: '▣', word: 'image' },
  pdf:         { glyph: '▤', word: 'PDF' },
  text:        { glyph: '≡', word: 'text' },
  notebook:    { glyph: '⌗', word: 'notebook' },
  unsupported: { glyph: '✕', word: 'unsupported' },
};

/*
 * Trust reads as a filled progression: ◇ → ◈ → ◆. The shape carries the
 * escalation on its own, so the banner still says "more than usual is allowed"
 * in greyscale, and the wording always comes from trustCopy().
 *
 * Both the glyph and the copy live in shared/types.ts. Three files declared the
 * same three characters, and five call sites indexed TRUST_COPY directly with a
 * level that came from a database row rather than from TRUST_LEVELS — one
 * unrecognised value and the view went to its error boundary instead of saying
 * it did not recognise the level.
 */
const rank = (t: TrustLevel) => TRUST_LEVELS.indexOf(t);

// Measured on this view, not on the window. These were window-width media
// queries, and they were right while Sessions had the window to itself: the
// destination list now takes 208px off the left before Sessions begins, so a
// 900px window meant a 692px view — under both thresholds — while matchMedia
// still reported "roomy" and left the terminal 444px between two rails.
// A ResizeObserver on the view answers the question the layout is actually
// asking, and keeps answering it when the sidebar is hidden or the side panel
// opens. Coarse pointer stays a media query: it is not a width.
//
// A 960px coarse-pointer view includes iPad portrait without hiding the picker
// on a roomy desktop; 860px keeps ordinary narrow views from spending a third
// of their width on a list.
const SESSION_PICKER_COMPACT_QUERY = '(pointer: coarse)';
const SESSION_PICKER_COMPACT_WIDTH = 860;
const SESSION_PICKER_COARSE_WIDTH = 960;
const CODE_RAIL_COMPACT_WIDTH = 900;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * How many unsettled conversations the Recent read can return at all.
 *
 * This is main's number, not the renderer's: `sessions:past` calls
 * `pastSessions()` with no argument, and `pastSessions(limit = 40)` slices its
 * active and settled sections at `limit` each while pins bypass both. Repeating
 * it here is a duplicate of a main-process default across the IPC boundary, and
 * the only reason it is acceptable is that the row set carries no total — a
 * `PastSession[]` of forty cannot say whether forty-one were recorded. So the
 * cap is named, and what is behind it is explicitly not counted.
 */
const PAST_ACTIVE_CAP = 40;

/**
 * Selecting the already-active session is still a useful action on a tablet:
 * it closes the picker and returns the keyboard to xterm. TerminalPane does
 * this itself when the active id changes; this covers the same-id case without
 * rebuilding the terminal or touching its PTY.
 */
function focusVisibleSessionTerminal() {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const input = Array.from(document.querySelectorAll<HTMLTextAreaElement>(
      '.sessions-view .terminal-host .xterm-helper-textarea',
    )).find((element) => element.offsetParent !== null);
    input?.focus();
  }));
}

const KB = 1024;
/** Bytes are never printed bare — a lone 320128 is a puzzle. */
function size(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < KB) return `${n} B`;
  if (n < KB * KB) return `${(n / KB).toFixed(n < 10 * KB ? 1 : 0)} KB`;
  return `${(n / (KB * KB)).toFixed(n < 10 * KB * KB ? 1 : 0)} MB`;
}

const plural = (n: number, one: string) => `${num(n)} ${one}${n === 1 ? '' : 's'}`;

/**
 * index.css owns the global focus styles and this view does not; every button
 * it hand-styles therefore carries its own ring. :focus-visible is asked of the
 * element rather than tracked, so a mouse click never draws one and a Tab does.
 */
const FocusBtn = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(function FocusBtn(
  { style, onFocus, onBlur, children, ...rest },
  ref,
) {
  const [ring, setRing] = useState(false);
  return (
    <button
      ref={ref}
      {...rest}
      onFocus={(e) => { setRing(e.currentTarget.matches(':focus-visible')); onFocus?.(e); }}
      onBlur={(e) => { setRing(false); onBlur?.(e); }}
      style={ring ? { ...style, outline: '2px solid var(--accent)', outlineOffset: 1 } : style}
    >
      {children}
    </button>
  );
});
FocusBtn.displayName = 'FocusBtn';

export default function Sessions({
  providers, projects, onAddProject, onError, activeId, onActiveChange,
  newSessionRequest, onNewSessionRequestConsumed, onSendToBatch,
}: {
  providers: ProviderInfo[]; projects: Project[];
  onAddProject: () => Promise<void>; onError: (m: string) => void;
  activeId: string | null;
  onActiveChange: (id: string, projectId?: string) => void;
  newSessionRequest: number | null;
  onNewSessionRequestConsumed: () => void;
  onSendToBatch: (seed: { projectId: string; root: string; paths: string[] }) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [dialog, setDialog] = useState(false);
  // Which project the per-project '+' asked for; the rail button used to open
  // the dialog on whichever project the active session belonged to.
  const [dialogProject, setDialogProject] = useState<string | undefined>(undefined);
  const [exactRecoveryDialog, setExactRecoveryDialog] = useState(false);
  // Loading is not empty. Until the first list() answers, "no sessions running"
  // would be a claim Wanigan has not checked.
  const [ready, setReady] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  /*
   * Recent conversations has its own failure, because it has its own read.
   *
   * `sessions:list` is an in-memory map read (sessions.ts sessionListEntries)
   * and `sessions:past` is a SQLite query over session_log (sessions.ts
   * pastSessions). They used to share one try block, so an error thrown by the
   * database read set listErr and replaced the whole view — live terminals,
   * their tabs and the composer — with 'The session list did not load', a
   * heading that was then false about which read had failed.
   */
  const [pastErr, setPastErr] = useState<string | null>(null);
  // Remembered per machine: whether the side rail is open is a working
  // preference, not session state.
  const [showRail, setShowRail] = useState(() => localStorage.getItem('wanigan.code') === '1');
  // Both start collapsed and are corrected on the first measurement, one frame
  // later. Starting expanded would flash two rails into a view that has no room
  // for them, which is the exact failure this measurement exists to prevent.
  const [compactLayout, setCompactLayout] = useState(true);
  const [sessionPickerCompact, setSessionPickerCompact] = useState(true);
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [railPane, setRailPane] = useState<Record<string, RailPane>>(readPanes);
  // Visible by default: the composer earns its keep by being seen once.
  // Collapsing is remembered per machine, like the code rail.
  const [composerOpen, setComposerOpen] = useState(() => localStorage.getItem('wanigan.composer') !== '0');
  // A "view this turn's diff" jump from the Timeline into the Code pane. The
  // nonce makes repeat jumps to the same turn re-fire the effect.
  const [turnFocus, setTurnFocus] = useState<{ sessionId: string; turn: number; nonce: number } | null>(null);
  /*
   * Three agents in one repo were three identical rows. The launch title is
   * assigned once and is "<provider> · <project>" for all three of them, so the
   * only thing that can tell them apart is a name you give them — durable now:
   * renames write the session row and follow the conversation into Recent.
   */
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [defaultTrust, setDefaultTrust] = useState<TrustLevel | null>(null);
  const [past, setPast] = useState<PastSession[]>([]);
  /**
   * Whether this machine has more than one account at all.
   *
   * With one account its label is a constant, and stamping a constant on every
   * session row is noise. The badge appears exactly when it can distinguish two
   * sessions from each other.
   */
  const [multiAccount, setMultiAccount] = useState(false);
  useEffect(() => {
    let live = true;
    window.wanigan.accounts.list('claude-code')
      .then((rows) => { if (live) setMultiAccount(rows.length > 1); })
      .catch(() => { if (live) setMultiAccount(false); });
    return () => { live = false; };
  }, []);
  const [settledOpen, setSettledOpen] = useState(false);
  const [settledShown, setSettledShown] = useState(8);
  // The settled shelf could already be paged; the active band above it could
  // not, so the ninth-newest resumable conversation was reachable only by
  // settling, pinning or forgetting a newer one.
  const [activeShown, setActiveShown] = useState(8);
  /** The Recent row whose Forget is awaiting confirmation, if any. */
  const [forgetting, setForgetting] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [teachSession, setTeachSession] = useState<Session | null>(null);
  const activeRef = useRef<string | null>(null);
  /** The list as of this render, for handlers that outlive the closure. */
  const sessionsRef = useRef<Session[]>([]);
  // The element the two rail breakpoints are measured against: everything
  // Sessions has to fit, and nothing the window has spent elsewhere.
  const sessionsBoxRef = useRef<HTMLDivElement | null>(null);
  const sessionPickerRef = useRef<HTMLElement | null>(null);
  const sessionPickerButtonRef = useRef<HTMLButtonElement | null>(null);
  // React state does not change until the next render. The ref closes the
  // same-tick gap so a double click cannot launch two writers for one thread.
  const resumePendingRef = useRef(false);
  activeRef.current = activeId;
  sessionsRef.current = sessions;

  // The shell can ask for a new interactive session from any route. Consume
  // the request immediately after opening the dialog: returning to Sessions
  // later must not resurrect a dialog that the person already dismissed.
  useEffect(() => {
    if (newSessionRequest === null) return;
    setDialog(true);
    onNewSessionRequestConsumed();
  }, [newSessionRequest, onNewSessionRequestConsumed]);

  const refreshPast = useCallback(async () => {
    try {
      setPast(await window.wanigan.sessions.past());
      setPastErr(null);
    } catch (e) {
      setPastErr(msg(e));
    }
  }, []);
  // Declared after refreshPast so the dependency is the real callback, and
  // awaited last so a throw from the Recent read cannot reach this catch.
  const refresh = useCallback(async () => {
    try {
      setSessions(await window.wanigan.sessions.list());
      setListErr(null);
    } catch (e) {
      setListErr(msg(e));
    } finally {
      setReady(true);
    }
    await refreshPast();
  }, [refreshPast]);
  useEffect(() => { void refresh(); }, [refresh]);

  // Both rails, from one measurement of the room this view actually has.
  //
  // An iPad-sized terminal beside a persistent 340px code rail becomes an
  // unreadable sliver, so the saved desktop preference is kept but the
  // secondary pane collapses below tablet width. Narrower still and the session
  // list becomes an overlay, which makes the terminal the full working surface
  // instead of a column squeezed between two persistent rails. That overlay
  // state is deliberately local: it is a momentary switcher, not a preference
  // the next launch should surprise you with.
  useEffect(() => {
    const el = sessionsBoxRef.current;
    if (!el) return;
    const coarse = window.matchMedia(SESSION_PICKER_COMPACT_QUERY);
    const measure = () => {
      const width = el.getBoundingClientRect().width;
      // A width of 0 is a view that is not laid out yet (a hidden tab, the
      // frame before first paint). Measuring it would collapse both rails and
      // then expand them, which reads as a flicker rather than a layout.
      if (width <= 0) return;
      const limit = coarse.matches ? SESSION_PICKER_COARSE_WIDTH : SESSION_PICKER_COMPACT_WIDTH;
      const compactPicker = width <= limit;
      setSessionPickerCompact(compactPicker);
      if (!compactPicker) setSessionPickerOpen(false);
      setCompactLayout(width <= (coarse.matches ? SESSION_PICKER_COARSE_WIDTH : CODE_RAIL_COMPACT_WIDTH));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    coarse.addEventListener('change', measure);
    return () => { ro.disconnect(); coarse.removeEventListener('change', measure); };
  }, []);

  useEffect(() => {
    if (!sessionPickerCompact || !sessionPickerOpen) return;
    const focus = requestAnimationFrame(() => {
      sessionPickerRef.current?.querySelector<HTMLElement>('[data-session-picker-initial]')?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSessionPickerOpen(false);
      requestAnimationFrame(() => sessionPickerButtonRef.current?.focus());
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      cancelAnimationFrame(focus);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [sessionPickerCompact, sessionPickerOpen]);

  // The banner compares against the default, so the default is read once and
  // kept; a session above it is the exception worth shouting about.
  useEffect(() => {
    window.wanigan.policy.defaultTrust().then(setDefaultTrust).catch(() => setDefaultTrust(null));
  }, []);

  async function resume(p: PastSession) {
    if (resumePendingRef.current) return;
    resumePendingRef.current = true;
    setResuming(p.id);
    try {
      const s = await window.wanigan.sessions.create({
        providerId: p.providerId,
        projectId: p.projectId ?? '',
        model: p.model ?? undefined,
        effort: p.effort ?? undefined,
        permissionMode: p.permissionMode ?? undefined,
        resumeFrom: { sessionId: p.id, conversationId: p.conversationId },
      });
      await refresh();
      select(s.id);
    } catch (e) { onError(msg(e)); }
    finally {
      resumePendingRef.current = false;
      setResuming(null);
    }
  }

  useEffect(() => {
    // The count is main's now, and it had to be. This view counted output from
    // its own `session:data` subscription, and App.tsx unmounts it on every tab
    // change — so the badge counted nothing during the only stretch a badge is
    // for, and the number that survived leaving the view was the old one being
    // carried forward by the handler below rather than anything observed.
    // Main sees every chunk whatever tab is on screen, and it knows which
    // session that is, so it owns both halves of the question.
    const offUnread = window.wanigan.on.unread((counts) => {
      setSessions((prev) => applyUnreadCounts(prev, counts));
    });
    // The pushed list can now simply be used. It used to have its `unread`
    // overwritten from local state on arrival, because main's copy was the one
    // nothing maintained; that is the wrong way round today.
    const offList = window.wanigan.on.sessions((list) => setSessions(list));
    // An agent that exits belongs in Recent immediately: main's pastSessions()
    // excludes a conversation only while its execution is non-exited. Without
    // this the list was refreshed on mount, create, resume, rename and worktree
    // actions only, so a session that finished while the view was open showed
    // 'exited 0' on its tab and appeared nowhere in Recent until the operator
    // did something unrelated — and the phone, which polls every three seconds,
    // showed a different set of sessions from the Mac beside it.
    const offExit = window.wanigan.on.exit(() => { void refreshPast(); });
    return () => { offUnread(); offList(); offExit(); };
  }, [refreshPast]);

  const select = useCallback((id: string) => {
    onActiveChange(id, sessions.find((session) => session.id === id)?.projectId);
    // Clear it here as well as in main. markRead below is the authority and
    // answers within a frame or two, but the badge sits on the tab now filling
    // the screen, and a badge that outlives the click by a round trip reads as
    // one the click failed to clear.
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unread: 0 } : s)));
    if (sessionPickerCompact) {
      setSessionPickerOpen(false);
      focusVisibleSessionTerminal();
    }
    window.wanigan.sessions.markRead(id).catch(() => {});
  }, [onActiveChange, sessionPickerCompact, sessions]);

  // Fleet/Control and the session rail now share one selected id in App. This
  // local guard covers the first list response as well as a tab that vanished
  // while the shell was on another view, so Sessions never opens to a blank
  // terminal column merely because selection arrived a render later.
  useEffect(() => {
    if (!sessions.length || sessions.some((session) => session.id === activeId)) return;
    const running = sessions.filter((session) => session.status === 'running');
    const fallback = running[running.length - 1] ?? sessions[sessions.length - 1];
    if (fallback) onActiveChange(fallback.id, fallback.projectId);
  }, [activeId, onActiveChange, sessions]);

  const closeTab = useCallback(async (id: string) => {
    try {
      await window.wanigan.sessions.close(id);
      disposePane(id);
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeRef.current === id && next[next.length - 1]) {
          onActiveChange(next[next.length - 1].id, next[next.length - 1].projectId);
        }
        return next;
      });
    } catch (e) { onError(msg(e)); }
  }, [onActiveChange, onError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const el = document.activeElement as HTMLElement | null;
      // The terminal and an open dialog own their keystrokes. In particular
      // Ctrl+B/Ctrl+W are ordinary readline shortcuts, not app navigation.
      if (el?.closest('.terminal-host') || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (e.key === 't') { e.preventDefault(); setDialog(true); return; }
      if (e.key === 'b') {
        e.preventDefault();
        setShowRail((v) => { localStorage.setItem('wanigan.code', v ? '0' : '1'); return !v; });
        return;
      }
      if (e.key === 'e') {
        e.preventDefault();
        setComposerOpen((v) => {
          localStorage.setItem('wanigan.composer', v ? '0' : '1');
          if (!v) requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.composer-area')?.focus());
          return !v;
        });
        return;
      }
      // ⌘⌫, not ⌘W. macOS registers ⌘W as Close Window at the menu-bar level,
      // so it is consumed before this handler ever runs — the cheat sheet has
      // been printing a chord that closed the whole app instead of one exited
      // tab. ⌘⌫ is unclaimed here and already reads as "remove this".
      if (e.key === 'Backspace' && activeRef.current) {
        const s = sessions.find((x) => x.id === activeRef.current);
        if (s?.status === 'exited') { e.preventDefault(); void closeTab(s.id); }
        return;
      }
      // ⌘1–9 used to select the Nth session here and could never run: the
      // shell binds those to the view routes on window in the capture phase and
      // calls stopPropagation, so this bubble-phase listener was never reached.
      // Switching sessions is ⌥⌘← / ⌥⌘→ now, in its own effect below.
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // ⌥⌘← / ⌥⌘→ walk the open sessions. Its own effect because the handler above
  // takes ⌘ alone and would have to widen its guard to see Option, and because
  // bindingMatches is what keeps the printed chord and the working chord the
  // same string — it also refuses every chord inside a terminal host, so the
  // PTY keeps its arrow keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (modalOpen()) return;
      const back = bindingMatches(e, 'session-prev');
      if (!back && !bindingMatches(e, 'session-next')) return;
      e.preventDefault();
      e.stopPropagation();
      const list = sessionsRef.current;
      if (list.length < 2) return;
      const at = list.findIndex((s) => s.id === activeRef.current);
      // No selection yet walks in from the end the arrow points from, so the
      // first press always lands somewhere rather than doing nothing.
      const next = at < 0
        ? (back ? list.length - 1 : 0)
        : (at + (back ? -1 : 1) + list.length) % list.length;
      select(list[next].id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [select]);

  // A file dropped anywhere but the terminal would otherwise navigate the
  // window to it, which unmounts the whole app.
  useEffect(() => {
    const swallow = (e: DragEvent) => { e.preventDefault(); };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => { window.removeEventListener('dragover', swallow); window.removeEventListener('drop', swallow); };
  }, []);

  async function createSession(opts: LaunchOptions) {
    const s = await window.wanigan.sessions.create(opts);
    await refresh();
    select(s.id);
  }

  async function recoverExactCodex(threadId: string, projectId: string) {
    const s = await window.wanigan.sessions.recoverExactCodex({ threadId, projectId });
    await refresh();
    select(s.id);
  }

  const byProject = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [sessions]);

  const active = sessions.find((s) => s.id === activeId) ?? null;

  /*
   * ⌘. is the macOS stop convention and the terminal has no use for it, so it
   * can be taken safely even while the PTY has focus — which is exactly when
   * you want it, because that is where you are watching the agent run away.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key !== '.') return;
      if (!active || active.status !== 'running') return;
      e.preventDefault();
      void window.wanigan.sessions.interrupt(active.id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
  const anyInstalled = providers.some((p) => p.path);
  // Distinct commands, because two profiles can share one binary — GLM and
  // DeepSeek are the Claude Code CLI pointed at another endpoint.
  const missingBins = useMemo(
    () => [...new Set(providers.filter((p) => !p.path).map((p) => p.bin))],
    [providers],
  );
  const pane = (active && railPane[active.id]) || 'code';
  const railOpen = showRail && !compactLayout;

  const setPane = useCallback((sessionId: string, next: RailPane) => {
    const merged = { ...railPane, [sessionId]: next };
    setRailPane(merged);
    writePanes(merged, sessions.map((s) => s.id));
  }, [railPane, sessions]);

  /** The session's durable name, or '' when it has none. */
  const nameOf = useCallback((s: Session) => s.displayTitle ?? '', []);

  const startRename = useCallback((s: Session) => {
    setDraft(nameOf(s));
    setRenaming(s.id);
  }, [nameOf]);

  /*
   * Leaving the field by keyboard puts focus back on the control that opened
   * it; leaving it by clicking elsewhere must not, or the rename would steal
   * the click you just made. Hence the explicit flag rather than doing it on
   * every exit.
   */
  const endRename = useCallback((id: string, refocus: boolean) => {
    setRenaming(null);
    if (!refocus) return;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-rename-for="${CSS.escape(id)}"]`)?.focus();
    });
  }, []);

  const commitRename = useCallback((id: string, refocus: boolean) => {
    const value = draft.trim().slice(0, LABEL_MAX);
    // Optimistic: the row is the truth, but the list should not flicker back
    // to the old name while the write is in flight.
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, displayTitle: value || null } : s)));
    window.wanigan.sessions.rename(id, value)
      .then(() => refresh())
      .catch((e) => onError(msg(e)));
    endRename(id, refocus);
  }, [draft, endRename, onError, refresh]);

  const att = useAttachments(active?.id ?? null);

  return (
    <div className="sessions-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, minHeight: 0 }}>
      {/* P3 · who is blocked, worst wait first. Above everything, because the
          answer to "where do I go next" outranks the rail and the terminal. */}
      <AttentionQueue onJump={select} />

      <div ref={sessionsBoxRef}
           className={`sessions${sessionPickerCompact ? ' sessions--compact-picker' : ''}${sessionPickerOpen ? ' sessions--picker-open' : ''}`}
           style={{ flex: 1, minHeight: 0 }}>
        <aside ref={sessionPickerRef} id="wanigan-session-picker"
               className="session-rail" aria-label="Session picker"
               aria-hidden={sessionPickerCompact && !sessionPickerOpen ? true : undefined}>
          <div className="session-picker-heading">
            <div style={{ minWidth: 0 }}>
              <span className="label">Session switcher</span>
              <span className="session-picker-current mono">
                {active
                  ? `Viewing ${nameOf(active) || active.projectName}`
                  : `${sessions.length} open session${sessions.length === 1 ? '' : 's'}`}
              </span>
            </div>
            <FocusBtn className="session-picker-close" data-session-picker-initial
                      title="Close session switcher" aria-label="Close session switcher"
                      onClick={() => {
                        setSessionPickerOpen(false);
                        focusVisibleSessionTerminal();
                      }}>
              ×
            </FocusBtn>
          </div>
          <div className="rail-scroll">
            {projects.length === 0 && (
              <p className="faint" style={{ padding: '10px 6px', lineHeight: 1.5 }}>
                No projects yet. Add a folder to run agents in it.
              </p>
            )}
            {projects.map((p) => {
              const list = byProject.get(p.id) ?? [];
              return (
                <div key={p.id}>
                  <div className="group-title">
                    <span style={{ fontWeight: 600, fontSize: 'var(--t-small)' }}>{p.name}</span>
                    {p.branch && <span className="faint mono trunc" style={{ fontSize: 'var(--t-micro)', minWidth: 0 }} title={p.branch}>{p.branch}</span>}
                    <FocusBtn className="faint" style={{ marginLeft: 'auto', flex: 'none', fontSize: 'var(--t-lead)', lineHeight: 1, borderRadius: 'var(--r-sm)' }}
                              title={`New session in ${p.name}`} onClick={() => { setDialogProject(p.id); setDialog(true); }}>+</FocusBtn>
                  </div>
                  {list.length === 0 && <p className="faint" style={{ padding: '2px 8px 4px', fontSize: 'var(--t-small)' }}>no sessions</p>}
                  {list.map((s) => {
                    const providerLabel = providers.find((x) => x.id === s.providerId)?.label ?? s.providerId;
                    const name = nameOf(s);
                    return renaming === s.id ? (
                      <input key={s.id} className="field" autoFocus value={draft} maxLength={LABEL_MAX}
                             aria-label={`Name for this ${providerLabel} session in ${s.projectName}`}
                             placeholder={providerLabel}
                             style={{ width: '100%', margin: '2px 0', fontSize: 'var(--t-small)' }}
                             onChange={(e) => setDraft(e.target.value)}
                             onBlur={() => commitRename(s.id, false)}
                             onKeyDown={(e) => {
                               if (e.key === 'Enter') { e.preventDefault(); commitRename(s.id, true); }
                               if (e.key === 'Escape') { e.preventDefault(); endRename(s.id, true); }
                             }} />
                    ) : (
                      <div key={s.id} className="past-row">
                        <FocusBtn className={`session-item${s.id === activeId ? ' active' : ''}`}
                                  style={{ flex: 1, width: 'auto', minWidth: 0 }}
                                  aria-current={s.id === activeId ? 'page' : undefined}
                                  title={s.title}
                                  onClick={() => select(s.id)}>
                          <span className="dot" style={{ background: s.status === 'running' ? providerTint(s.providerId) : 'var(--text-faint)' }} />
                          <span style={{ minWidth: 0, flex: 1 }}>
                            <span className="trunc" style={{ display: 'block', fontSize: 'var(--t-small)' }}>
                              {name || providerLabel}
                              {s.worktree && <span className="faint" title="Runs in its own git worktree"> ⑂</span>}
                            </span>
                            <span className="faint mono trunc" style={{ display: 'block', fontSize: 'var(--t-micro)', fontVariantNumeric: 'tabular-nums' }}>
                              {/* Naming a session must not cost you the provider
                                  it runs, so the second line picks it up. */}
                              {name ? `${providerLabel} · ` : ''}
                              {s.status === 'running' ? `pid ${s.pid}` : `exited ${s.exitCode}`}
                              {/* Which login this session is actually signed in
                                  as. Shown only when more than one account
                                  exists: with a single account the label is a
                                  constant, and a constant on every row is
                                  noise rather than information. */}
                              {multiAccount && s.accountLabel && ` · ${s.accountLabel}`}
                            </span>
                          </span>
                          {/* One increment is one second in which output
                              arrived while you were elsewhere — not one
                              message, which is what a bare number beside a
                              chat-shaped list is read as. The sentence is on
                              the badge because the digit cannot carry it, and
                              it is the accessible name because a lone integer
                              announces as nothing at all. */}
                          {s.unread > 0 && s.id !== activeId && (
                            <span className="pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent)',
                                                            fontVariantNumeric: 'tabular-nums' }}
                                  title={`Output arrived ${s.unread} times while this session was not on screen`}
                                  aria-label={`Output arrived ${s.unread} times while this session was not on screen`}>
                              {s.unread > 99 ? '99+' : s.unread}
                            </span>
                          )}
                        </FocusBtn>
                        <FocusBtn className="past-x faint" data-rename-for={s.id}
                                  title={`Name this session — two agents in ${s.projectName} are otherwise the same row`}
                                  aria-label={`Rename the ${providerLabel} session in ${s.projectName}`}
                                  onClick={() => startRename(s)}>✎</FocusBtn>
                      </div>
                    );
                  })}
                </div>
              );
            })}
            {pastErr && (
              <Note tone="error" action={{ label: 'Retry', run: refreshPast }}>
                <span aria-hidden="true">✕ </span>Recent conversations did not load: {pastErr} The
                sessions above are unaffected — this is Wanigan's own record of past ones, and nothing
                running has changed.
              </Note>
            )}
            {past.length > 0 && (() => {
              // Pins float (newest pin first), settled sinks into its shelf,
              // and a missing project folder sinks within its own section —
              // stable sorts keep newest-first inside each band.
              const pinnedPast = [...past.filter((p) => p.pinnedAt != null)]
                .sort((a, b) => Number(b.live) - Number(a.live) || (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
              const activePast = [...past.filter((p) => p.pinnedAt == null && p.settledAt == null)]
                .sort((a, b) => Number(b.live) - Number(a.live));
              const settledPast = [...past.filter((p) => p.settledAt != null)]
                .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0));
              const setPastFlag = (p: PastSession, flag: 'pin' | 'settle', on: boolean) => {
                window.wanigan.sessions.setConversationFlag(p.id, flag, on)
                  .then((rows) => { setPast(rows); setPastErr(null); })
                  .catch((e) => onError(msg(e)));
              };
              const renderPast = (p: PastSession) => (
                <div key={p.id} className={forgetting === p.id ? 'past-row past-row-confirming' : 'past-row'}>
                  <FocusBtn className="past-main" disabled={!p.live || resuming !== null}
                            title={p.live
                              ? `Resume this exact conversation in ${p.projectPath}`
                              : 'Project folder no longer exists'}
                            onClick={() => resume(p)}>
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 'var(--t-small)' }}>
                        {p.pinnedAt != null && (
                          <span aria-label="pinned" title="Pinned" style={{ color: 'var(--accent)' }}>★ </span>
                        )}
                        {p.title ?? p.projectName}
                        {!p.live && <span className="faint"> · missing</span>}
                      </span>
                      <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>
                        {p.title ? `${p.projectName} · ` : ''}
                        {providers.find((x) => x.id === p.providerId)?.label ?? p.providerId}
                        {p.model && ` · ${p.model}`}
                        {p.effort && ` · ${p.effort}`}
                        {p.continuationCount > 1 && ` · ${p.continuationCount} launches`}
                        {' · '}{ago(p.startedAt)}
                      </span>
                    </span>
                    <span className="faint" style={{ fontSize: 'var(--t-micro)' }}>
                      {resuming === p.id ? '…' : '↻'}
                    </span>
                  </FocusBtn>
                  <FocusBtn className="past-x faint"
                            title={p.pinnedAt != null
                              ? 'Unpin — back to its place by recency'
                              : 'Pin above Recent, kept there across restarts'}
                            aria-label={p.pinnedAt != null ? `Unpin ${p.projectName}` : `Pin ${p.projectName}`}
                            onClick={() => setPastFlag(p, 'pin', p.pinnedAt == null)}>
                    {p.pinnedAt != null ? '★' : '☆'}
                  </FocusBtn>
                  <FocusBtn className="past-x faint"
                            title={p.settledAt != null
                              ? 'Un-settle — back into Recent'
                              : 'Settle into the shelf below. Nothing is deleted; forget is the × next door.'}
                            aria-label={p.settledAt != null ? `Un-settle ${p.projectName}` : `Settle ${p.projectName}`}
                            onClick={() => setPastFlag(p, 'settle', p.settledAt == null)}>
                    {p.settledAt != null ? '⤒' : '⤓'}
                  </FocusBtn>
                  {/* Forget destroys launch records and the exact-resume handle
                      with no undo, which bits.tsx records as tier T2: an inline
                      sentence, a verb button and Cancel. It sat 2px from settle
                      and pin in a 12px row and fired on one click. */}
                  <FocusBtn className="past-x faint"
                            title={`Forget this conversation and all ${p.continuationCount} saved launch record${p.continuationCount === 1 ? '' : 's'}`}
                            aria-label={`Forget ${p.title ?? p.projectName}`}
                            onClick={() => setForgetting(p.id)}>
                    ×
                  </FocusBtn>
                  {forgetting === p.id && (
                    <ConfirmNote
                      tone="error"
                      what={`Forget “${p.title ?? p.projectName}” and its ${p.continuationCount} launch record${p.continuationCount === 1 ? '' : 's'}. The conversation can no longer be resumed exactly.`}
                      verb="Forget"
                      busy={false}
                      onCancel={() => setForgetting(null)}
                      onRun={() => {
                        setForgetting(null);
                        void window.wanigan.sessions.forget(p.id)
                          .then((rows) => { setPast(rows); setPastErr(null); })
                          .catch((e) => onError(msg(e)));
                      }}
                    />
                  )}
                </div>
              );
              return (
                <div style={{ marginTop: 16 }}>
                  <div className="group-title">
                    <span className="label">Recent conversations</span>
                    <span className="faint" style={{ fontSize: 'var(--t-micro)', marginLeft: 'auto' }}>exact resume</span>
                  </div>
                  {pinnedPast.map(renderPast)}
                  {activePast.slice(0, activeShown).map(renderPast)}
                  {/* The count is read off the array this render already holds,
                      so it is what is hidden, not an estimate of it. */}
                  {activePast.length > activeShown && (
                    <FocusBtn className="faint rail-more"
                              onClick={() => setActiveShown((n) => n + 8)}>
                      Show {Math.min(8, activePast.length - activeShown)} more — {activePast.length - activeShown} not shown
                    </FocusBtn>
                  )}
                  {/* Only once nothing the renderer holds is still hidden. Past
                      this point the number withheld is main's, and main did not
                      send it — so this names the cap and refuses to count. */}
                  {activeShown >= activePast.length && activePast.length >= PAST_ACTIVE_CAP && (
                    <p className="faint rail-cap-note">
                      All {activePast.length} unsettled conversations Wanigan sent are shown. Its Recent read
                      returns at most {PAST_ACTIVE_CAP} of them and does not report how many are older, so this
                      is not a count of everything recorded. Pin one while it is here and it stays after it ages
                      past that.
                    </p>
                  )}
                  {settledPast.length > 0 && (
                    <>
                      <FocusBtn className="group-title" aria-expanded={settledOpen}
                                style={{ width: '100%', marginTop: 8, cursor: 'pointer' }}
                                onClick={() => setSettledOpen((o) => !o)}>
                        <span className="label">Settled ({settledPast.length})</span>
                        <span className="faint" style={{ marginLeft: 'auto' }} aria-hidden="true">
                          {settledOpen ? '▾' : '▸'}
                        </span>
                      </FocusBtn>
                      {settledOpen && settledPast.slice(0, settledShown).map(renderPast)}
                      {settledOpen && settledPast.length > settledShown && (
                        <FocusBtn className="faint rail-more"
                                  onClick={() => setSettledShown((n) => n + 8)}>
                          Show {Math.min(8, settledPast.length - settledShown)} more settled — {settledPast.length - settledShown} not shown
                        </FocusBtn>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            <FocusBtn className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
                      onClick={onAddProject}>+ Add project</FocusBtn>
            {/* Codex-only recovery: hide the route when no Codex CLI is installed
                rather than offering a dialog that can only fail. */}
            {projects.length > 0 && providers.some((p) => p.harnessId === 'codex' && p.path) && (
              <FocusBtn className="faint" style={{ width: '100%', justifyContent: 'center', marginTop: 8,
                                                     fontSize: 'var(--t-small)', borderRadius: 'var(--r-sm)' }}
                        onClick={() => setExactRecoveryDialog(true)}>
                Recover exact Codex UUID…
              </FocusBtn>
            )}
          </div>

          {/* Lives below the fold of the rail rather than in the terminal
              column: motion next to a repainting PTY is the one place this
              app refuses to animate. */}
          <Pet />
        </aside>

        {sessionPickerCompact && sessionPickerOpen && (
          <button type="button" className="session-picker-scrim" aria-label="Close session switcher"
                  onClick={() => {
                    setSessionPickerOpen(false);
                    focusVisibleSessionTerminal();
                  }} />
        )}

        <div className="session-main">
          <div className="tabbar">
            <FocusBtn ref={sessionPickerButtonRef} className={`tab session-picker-trigger${sessionPickerOpen ? ' active' : ''}`}
                      aria-controls="wanigan-session-picker" aria-expanded={sessionPickerCompact ? sessionPickerOpen : undefined}
                      aria-label={active
                        ? `Choose a session. Current session: ${nameOf(active) || active.projectName}`
                        : 'Choose a session'}
                      title={active
                        ? `Choose a session — currently ${nameOf(active) || active.projectName}`
                        : 'Choose a session'}
                      onClick={() => setSessionPickerOpen((open) => !open)}>
              <span aria-hidden="true" className="session-picker-glyph">☰</span>
              <span>Sessions</span>
              {active && <span className="session-picker-trigger-current">{nameOf(active) || active.projectName}</span>}
              <span className="session-picker-count" aria-hidden="true">{sessions.length}</span>
            </FocusBtn>
            {sessions.map((s) => (
              <div key={s.id} className={`session-tab-wrap${s.id === activeId ? ' active' : ''}`}>
                <FocusBtn className={`tab session-tab${s.id === activeId ? ' active' : ''}`} onClick={() => select(s.id)}
                          aria-current={s.id === activeId ? 'page' : undefined}
                          title={nameOf(s) ? `${nameOf(s)} — ${s.title}` : s.title}
                          aria-label={`${nameOf(s) || s.projectName}, ${s.status === 'running' ? 'running' : 'exited'} session`}>
                  <span className="dot" style={{ width: 6, height: 6, borderRadius: 'var(--r-pill)',
                                                 background: s.status === 'running' ? providerTint(s.providerId) : 'var(--text-faint)' }} />
                  {nameOf(s) || s.projectName}
                </FocusBtn>
                {s.status === 'exited' && (
                  <FocusBtn className="session-tab-close faint" title="Close exited session (⌘⌫)"
                            aria-label={`Close exited session for ${s.projectName}`}
                            onClick={() => void closeTab(s.id)}>×</FocusBtn>
                )}
              </div>
            ))}
            <FocusBtn className="tab tab-new-session faint" onClick={() => setDialog(true)} title="New session (⌘T)"
                      aria-label="New session (Command T)">+<span className="tab-new-session-text"> New</span></FocusBtn>
            <FocusBtn className={`tab session-side-panel-toggle faint${railOpen ? ' active' : ''}`} style={{ marginLeft: 'auto' }}
                      title={compactLayout ? 'The side panel is collapsed on tablets so the terminal stays readable.' : 'Toggle the side panel (⌘B)'}
                      disabled={compactLayout || !active}
                      onClick={() => setShowRail((v) => { localStorage.setItem('wanigan.code', v ? '0' : '1'); return !v; })}>
              {compactLayout ? 'terminal full width' : railOpen ? '⟨ hide' : `${pane} ⟩`}
            </FocusBtn>
          </div>

          {active && (
            <SessionHeader key={active.id} session={active} defaultTrust={defaultTrust} onRefresh={refresh}
                           provider={providers.find((p) => p.id === active.providerId)} />
          )}

          {!ready ? (
            <div className="empty">
              <p className="dim">Reading the session list…</p>
            </div>
          ) : listErr ? (
            <div className="empty">
              <div style={{ maxWidth: 460 }}>
                <h1 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>The session list did not load</h1>
                <p className="dim" style={{ marginTop: 6, lineHeight: 1.55 }}>{listErr}</p>
                <p className="faint" style={{ marginTop: 6, lineHeight: 1.5 }}>
                  Wanigan could not read its own list of live sessions. Any agent already running is still
                  running, and its terminal returns as soon as this read succeeds. Retry below; if it keeps
                  failing, quit and reopen Wanigan so it rebuilds the connection to its database.
                </p>
              </div>
              <FocusBtn className="btn btn-primary" onClick={() => void refresh()}>Retry</FocusBtn>
            </div>
          ) : sessions.length === 0 ? (
            <div className="empty">
              <div>
                <h1 style={{ fontSize: 'var(--t-title)', fontWeight: 600 }}>No sessions running</h1>
                <p className="dim" style={{ marginTop: 6, maxWidth: 460, lineHeight: 1.55 }}>
                  Each session is a real terminal, so permission prompts and the full TUI work exactly
                  as they do in your shell.
                </p>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                {projects.length === 0
                  ? <FocusBtn className="btn btn-primary" onClick={onAddProject}>Add your first project</FocusBtn>
                  : <FocusBtn className="btn btn-primary" onClick={() => setDialog(true)}>New session ⌘T</FocusBtn>}
                {/* A settled conversation is parked by choice; the quick-resume
                    offer respects that and reaches for the next live one. */}
                {past.filter((p) => p.live && p.settledAt == null)[0] && (
                  <FocusBtn className="btn" onClick={() => resume(past.filter((p) => p.live && p.settledAt == null)[0])}>
                    Resume {past.filter((p) => p.live && p.settledAt == null)[0].projectName}
                  </FocusBtn>
                )}
              </div>
              {!anyInstalled && providers.length > 0 && (
                // Named from the profiles that are actually loaded. This used to
                // say "neither claude nor codex", which was one hardcoded pair
                // out of however many a provider pack contributes.
                <p className="faint" style={{ maxWidth: 470, lineHeight: 1.5 }}>
                  No agent CLI was found — Wanigan looks for{' '}
                  {missingBins.map((bin, i) => (
                    <span key={bin}>
                      {i > 0 && (i === missingBins.length - 1 ? ' and ' : ', ')}
                      <span className="mono">{bin}</span>
                    </span>
                  ))}
                  {' '}on the PATH your login shell reported, plus the usual Homebrew, nvm and editor
                  extension directories. Install one, then open New session — it re-checks from there.
                  If one already runs in your terminal, quit and reopen Wanigan so it reads that PATH again.
                </p>
              )}
            </div>
          ) : (
            <div className={railOpen && active ? 'term-split' : 'term-full'}>
              <div className="term-col">
                {/* P21 · the terminal is the drop target: the file is for the
                    agent you are looking at, so it lands where you are looking. */}
                <div
                  style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}
                  onDragEnter={att.onDragEnter}
                  onDragOver={att.onDragOver}
                  onDragLeave={att.onDragLeave}
                  onDrop={att.onDrop}
                >
                  {sessions.map((s) => <TerminalPane key={s.id} sessionId={s.id} visible={s.id === activeId} />)}
                  {att.dragging && active && (
                    <div style={{
                      position: 'absolute', inset: 8, pointerEvents: 'none', zIndex: 5,
                      border: '2px dashed var(--accent)', borderRadius: 'var(--r-md)',
                      background: 'var(--accent-soft)', opacity: 0.96,
                      display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20,
                    }}>
                      <div>
                        <div style={{ fontSize: 'var(--t-lead)', fontWeight: 600 }}>
                          ⤓ Drop to attach to {active.projectName}
                        </div>
                        <div className="dim" style={{ fontSize: 'var(--t-small)', marginTop: 5, lineHeight: 1.5 }}>
                          Images, PDFs, text and notebooks are staged where this agent can read them.
                          Nothing is sent anywhere — the agent opens the file itself.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {active && <AttachStrip session={active} att={att} />}
                {active && (composerOpen ? (
                  <Composer key={`composer-${active.id}`} session={active} onError={onError}
                            onCollapse={() => { localStorage.setItem('wanigan.composer', '0'); setComposerOpen(false); }} />
                ) : (
                  <div className="composer-closed">
                    <FocusBtn className="faint composer-reopen"
                              title="Open the composer — drafts, queueing and stashed prompts (⌘E)"
                              onClick={() => { localStorage.setItem('wanigan.composer', '1'); setComposerOpen(true); }}>
                      ✎ compose ⌘E
                    </FocusBtn>
                  </div>
                ))}
              </div>

              {railOpen && active && (
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
                  {/* P8 · one rail, two readings of the same session: what the
                      repo looks like now, and what the agent actually did. */}
                  <div className="code-head" style={{ borderLeft: '1px solid var(--line)' }} role="group"
                       aria-label="Side panel">
                    <Seg on={pane === 'code'} onClick={() => setPane(active.id, 'code')}
                         title="Files this session changed">Code</Seg>
                    <Seg on={pane === 'timeline'} onClick={() => setPane(active.id, 'timeline')}
                         title="Every tool call the agent made, and how long it took">Timeline</Seg>
                    <Seg on={pane === 'learning'} onClick={() => setPane(active.id, 'learning')}
                         title="What this session was told at launch, and what it recorded — stored facts only">Learning</Seg>
                    <span className="faint mono" style={{ marginLeft: 'auto', fontSize: 'var(--t-micro)' }}>⌘B</span>
                  </div>
                  <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'grid',
                                borderLeft: pane === 'timeline' ? '1px solid var(--line)' : undefined }}>
                    {pane === 'code' ? (
                      <CodePanel key={`code-${active.id}`} projectPath={active.worktree ?? active.projectPath}
                                 projectName={active.projectName} sessionId={active.id}
                                 checkpointsSupported={active.capabilities?.hooks === true}
                                 focusTurn={turnFocus?.sessionId === active.id
                                   ? { turn: turnFocus.turn, nonce: turnFocus.nonce }
                                   : null}
                                 onFocusTurnHandled={() => setTurnFocus(null)}
                                 onSendToBatch={(paths) => onSendToBatch({
                                   projectId: active.projectId,
                                   root: active.worktree ?? active.projectPath,
                                   paths,
                                 })} />
                    ) : pane === 'timeline' ? (
                      <Timeline key={`tl-${active.id}`} sessionId={active.id}
                                onOpenFile={(p) => { window.wanigan.code.open(null, p).catch((e) => onError(msg(e))); }}
                                onOpenTurnDiff={(turn) => {
                                  setTurnFocus({ sessionId: active.id, turn, nonce: Date.now() });
                                  setPane(active.id, 'code');
                                }} />
                    ) : (
                      <div style={{ overflowY: 'auto', minHeight: 0, borderLeft: '1px solid var(--line)' }}>
                        <SessionLearning key={`sl-${active.id}`} sessionId={active.id}
                                         harness={active.harnessId ?? null} />
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="statusbar">
            {active ? (
              <>
                <span className="mono">{active.projectPath}</span><span>·</span>
                <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {active.status === 'running' ? `pid ${active.pid}` : `exited ${active.exitCode}`}
                </span>
                <FocusBtn className="faint session-status-action" style={{ marginLeft: 'auto', fontSize: 'var(--t-small)', borderRadius: 'var(--r-sm)' }}
                          onClick={() => window.wanigan.sessions.reveal(active.id)}
                          title={active.worktree
                            ? `Open the worktree this session runs in: ${active.worktree}`
                            : `Open ${active.projectPath}`}>
                  open folder
                </FocusBtn>
                <FocusBtn className="faint session-status-action" style={{ fontSize: 'var(--t-small)', color: 'var(--accent)', borderRadius: 'var(--r-sm)' }}
                          title="Turn an outcome, correction, preference, or reusable fact from this session into a reviewable Learning Inbox proposal"
                          onClick={() => setTeachSession(active)}>
                  ◇ teach Wanigan
                </FocusBtn>
                {active.status === 'running' && (
                  <FocusBtn className="faint session-status-action" style={{ fontSize: 'var(--t-small)', color: 'var(--warning)', borderRadius: 'var(--r-sm)' }}
                            title="Sends Escape to the agent — the key Claude Code and Codex both use to stop a turn. The session stays open. ⌘."
                            onClick={() => void window.wanigan.sessions.interrupt(active.id)}>
                    ⎋ interrupt
                  </FocusBtn>
                )}
                {active.status === 'running' && (
                  <FocusBtn className="faint session-status-action" style={{ fontSize: 'var(--t-small)', color: 'var(--bad)', borderRadius: 'var(--r-sm)' }}
                            title="End the session. The conversation stays in Recent below and can be resumed exactly."
                            onClick={() => window.wanigan.sessions.kill(active.id)}>end session</FocusBtn>
                )}
              </>
            ) : <span>⌘T new session · ⌥⌘←→ switch · ⌘⌫ close · ⌘B side panel</span>}
          </div>
        </div>
      </div>

      {dialog && (
        <NewSessionDialog providers={providers} projects={projects} defaultProjectId={dialogProject ?? active?.projectId}
                          liveSessions={sessions}
                          onClose={() => { setDialog(false); setDialogProject(undefined); }} onCreate={createSession} onAddProject={onAddProject} />
      )}
      {exactRecoveryDialog && (
        <ExactCodexRecoveryDialog projects={projects} defaultProjectId={active?.projectId}
                                  onClose={() => setExactRecoveryDialog(false)} onRecover={recoverExactCodex} />
      )}
      {teachSession && (
        <SessionTeachModal session={teachSession} onClose={() => setTeachSession(null)} onError={onError} />
      )}
    </div>
  );
}

function ExactCodexRecoveryDialog({ projects, defaultProjectId, onClose, onRecover }: {
  projects: Project[];
  defaultProjectId?: string;
  onClose: () => void;
  onRecover: (threadId: string, projectId: string) => Promise<void>;
}) {
  const [threadId, setThreadId] = useState('');
  const [projectId, setProjectId] = useState(() =>
    projects.some((project) => project.id === defaultProjectId) ? defaultProjectId! : projects[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!threadId.trim() || !projectId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRecover(threadId.trim(), projectId);
      onClose();
    } catch (e) {
      setError(msg(e));
      setBusy(false);
    }
  };
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'first' });
  // Both dialogs in this file used to hand-roll a backdrop: no Escape, no Tab
  // trap, and focus dropped on the document body when they closed. That last
  // one matters more here than in most of the app, because the thing under the
  // scrim is a live terminal with tabIndex 0 that hands the caret to xterm — a
  // few Shift-Tabs from an untrapped dialog and the operator is typing into a
  // running agent. useDialog owns the keyboard and portals out of .body.
  return portal(
    <div {...backdropProps}>
      <section {...dialogProps} className="modal" aria-labelledby="recover-codex-title">
        <div className="label" style={{ color: 'var(--codex)', marginBottom: 4 }}>Safe recovery</div>
        <h2 id="recover-codex-title" style={{ fontSize: 'var(--t-lead)', fontWeight: 600 }}>Recover an exact Codex conversation</h2>
        <p className="dim" style={{ marginTop: 7, fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          Use this for a known conversation — for example, your budgeting and investing thread. Wanigan checks the
          exact UUID against Codex’s local index, rollout, saved folder and writer lock. It never guesses “latest.”
        </p>

        <label style={{ display: 'block', marginTop: 16 }}>
          <span className="label">Codex conversation UUID</span>
          <input className="field mono" style={{ width: '100%', marginTop: 6, boxSizing: 'border-box' }}
                 data-initial-focus value={threadId} onChange={(event) => setThreadId(event.target.value)}
                 placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false}
                 aria-describedby="recover-codex-help" />
        </label>
        <label style={{ display: 'block', marginTop: 14 }}>
          <span className="label">Project folder used by this conversation</span>
          <select className="field" style={{ width: '100%', marginTop: 6, boxSizing: 'border-box' }}
                  value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name} — {project.path}</option>)}
          </select>
        </label>
        <p id="recover-codex-help" className="faint" style={{ marginTop: 9, fontSize: 'var(--t-micro)', lineHeight: 1.45 }}>
          Recovery launches only <span className="mono">codex resume &lt;UUID&gt;</span> through Wanigan’s normal terminal
          harness. If Codex says another writer is active or bootstrap fails, Wanigan changes no Recent history.
        </p>
        {error && (
          <div style={{ background: 'var(--bad-soft)', color: 'var(--bad)', border: '1px solid var(--bad)',
                        borderRadius: 'var(--r-sm)', padding: '7px 10px', marginTop: 12,
                        fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
            <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>{error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 18 }}>
          <FocusBtn className="btn" style={{ marginLeft: 'auto' }} disabled={busy} onClick={onClose}>Cancel</FocusBtn>
          <FocusBtn className="btn btn-primary" disabled={!threadId.trim() || !projectId || busy} onClick={() => void submit()}>
            {busy ? 'Verifying & opening…' : 'Recover exact thread'}
          </FocusBtn>
        </div>
      </section>
    </div>,
  );
}

function SessionTeachModal({ session, onClose, onError }: {
  session: Session;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<'worked' | 'failed' | 'corrected' | 'preference'>('worked');
  const [scope, setScope] = useState<'personal' | 'project' | 'path'>('project');
  const [pathScope, setPathScope] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await window.wanigan.learning.teach({
        sessionId: session.id,
        providerId: session.providerId,
        projectId: scope === 'personal' ? null : session.projectId,
        projectPath: scope === 'personal' ? null : session.projectPath,
        scope,
        pathScope: scope === 'path' ? pathScope.trim() || null : null,
        kind: outcome === 'failed' || outcome === 'corrected' ? 'rule' : 'memory',
        title: title.trim(),
        text: text.trim(),
        outcome,
      });
      onClose();
    } catch (e) { onError(msg(e)); }
    finally { setBusy(false); }
  };
  // 'least-destructive' is the safe default for a form that writes durable
  // knowledge, but the Title input carries data-initial-focus and wins: landing
  // on Close would put the caret nowhere useful in a dialog opened to type.
  const { portal, backdropProps, dialogProps } = useDialog<HTMLElement>({ onClose, initialFocus: 'least-destructive' });
  return portal(
    <div {...backdropProps}>
      <section {...dialogProps} className="learning-modal card" aria-label="Teach Wanigan from this session">
        <div className="learning-card-head">
          <div><span className="label">{session.providerId} · {session.projectName}</span><h2>Teach Wanigan from this session</h2></div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <p className="dim">This stores your explanation and a reference to this session as evidence. It does not copy the whole transcript or edit project files.</p>
        <label><span className="label">What happened?</span><select className="field" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="worked">This worked</option><option value="failed">This failed</option><option value="corrected">I corrected the agent</option><option value="preference">My preference</option></select></label>
        <label><span className="label">Title</span><input className="field" data-initial-focus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The reusable lesson" /></label>
        <label><span className="label">What should future agents know?</span><textarea className="field" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="State the outcome, constraint, correction, or procedure clearly…" /></label>
        <div className="learning-form-grid">
          <label><span className="label">Scope</span><select className="field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="project">This project</option><option value="path">A path in this project</option><option value="personal">My knowledge</option></select></label>
          {scope === 'path' && <label><span className="label">Path pattern</span><input className="field mono" value={pathScope} onChange={(e) => setPathScope(e.target.value)} placeholder="src/api/**" /></label>}
        </div>
        <div className="learning-actions"><button className="btn btn-primary" disabled={busy || !title.trim() || !text.trim()} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add reviewable lesson'}</button></div>
      </section>
    </div>,
  );
}

/* ── the rail's segmented control ─────────────────────────────────────── */

function Seg({ on, onClick, title, children }: {
  on: boolean; onClick: () => void; title: string; children: React.ReactNode;
}) {
  return (
    <FocusBtn className={`code-tab${on ? ' on' : ''}`} aria-pressed={on} title={title}
              onClick={onClick} style={{ fontVariantNumeric: 'tabular-nums' }}>
      {children}
    </FocusBtn>
  );
}

const PANE_KEY = 'wanigan.rail.pane';

type RailPane = 'code' | 'timeline' | 'learning';

function readPanes(): Record<string, RailPane> {
  try {
    const raw = localStorage.getItem(PANE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, RailPane> = {};
    for (const [k, v] of Object.entries(parsed)) if (v === 'code' || v === 'timeline' || v === 'learning') out[k] = v;
    return out;
  } catch { return {}; }
}

/** Session ids are per-launch, so the map is pruned to sessions that still exist. */
function writePanes(map: Record<string, RailPane>, live: string[]) {
  try {
    const keep = new Set(live);
    const out = Object.fromEntries(Object.entries(map).filter(([k]) => keep.has(k)));
    localStorage.setItem(PANE_KEY, JSON.stringify(out));
  } catch { /* storage can be blocked; the choice just stops surviving a restart */ }
}

/* ── what you called this session ─────────────────────────────────────── */

/** Field cap for the rename input; the row itself allows 120. */
const LABEL_MAX = 60;

/* ── P19 + P9 · the session header ────────────────────────────────────── */

function SessionHeader({ session, defaultTrust, onRefresh, provider }: {
  session: Session; defaultTrust: TrustLevel | null; onRefresh: () => Promise<void>;
  provider?: ProviderInfo;
}) {
  const trust = session.trust ?? null;
  const elevated = !!trust && !!defaultTrust && rank(trust) > rank(defaultTrust);
  // The profile this session launched under, and the harness it is actually
  // running. Both come from the frozen snapshot first: a pack can be upgraded,
  // disabled or removed while a session runs, and the live `provider` is only
  // what that id means now. main gates /model and /effort on
  // `harnessId === 'codex'` (sessions.ts), so the renderer asks the same
  // question rather than branching on a profile id — a pack profile on the
  // codex harness used to be offered Claude slash commands its CLI never took.
  const launched = session.providerProfile ?? provider ?? null;
  const harness = session.harnessId ?? session.providerProfile?.harness
    ?? provider?.harnessId ?? session.providerId;
  // Claude Code's harness, and only it. `/model` and `/effort` are Claude Code
  // slash commands typed straight into the PTY; a generic-cli profile that
  // declares a model launch field would have had them typed into a CLI that
  // reads them as a prompt, under a sentence describing Claude's persistence.
  const tunable = harness === 'claude-code' && session.status === 'running' &&
    (launched?.supports.model === true || launched?.supports.effort === true);
  // Declared but not reachable: say so rather than showing nothing.
  const declaresTuning = harness !== 'claude-code' && harness !== 'codex'
    && session.status === 'running'
    && (launched?.supports.model === true || launched?.supports.effort === true);
  // Codex has its own live controls.  Its TUI's /model picker changes model,
  // reasoning effort and Auto choices, and /plan changes the next turn's
  // collaboration mode.  Treating it as Claude made this whole useful row
  // disappear merely because it does not accept Claude slash commands.
  const codexControls = harness === 'codex' && session.status === 'running';
  if (!elevated && !session.worktree && !tunable && !codexControls) return null;

  return (
    <div style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-soft)' }}>
      {elevated && trust && defaultTrust && (
        <TrustBanner level={trust} fallback={defaultTrust} running={session.status !== 'exited'} />
      )}
      {session.worktree && <WorktreeBar session={session} path={session.worktree} onRefresh={onRefresh} />}
      {tunable && <RunConfigBar session={session} provider={provider} />}
      {/* Honest unsupported beats a control that types Claude's slash commands
          into a CLI that never agreed to read them. */}
      {declaresTuning && (
        <div className="session-tuning-absent">
          <Mark glyph="⊘" word="model and effort cannot be changed here" tone="quiet"
                title={`This profile declares a model or effort field, but Wanigan has no verified way to change either on a running ${harness} session. Start a new session to change them.`} />
        </div>
      )}
      {codexControls && <CodexControlBar session={session} />}
    </div>
  );
}

/** Controls that Codex itself documents in its interactive command palette. */
function CodexControlBar({ session }: { session: Session }) {
  const [sent, setSent] = useState<string | null>(null);
  const send = (command: '/model' | '/plan', label: string) => {
    // These are actual Codex TUI commands, not prompts that ask the agent to
    // imitate a settings change.  They take effect in the terminal the user is
    // already looking at and do not create an extra conversation turn.
    window.wanigan.sessions.write(session.id, `${command}\r`);
    setSent(label);
    window.setTimeout(() => setSent((current) => current === label ? null : current), 4000);
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
                  padding: '8px 12px', borderTop: '1px solid var(--line-soft)',
                  background: 'color-mix(in srgb, var(--codex) 9%, var(--bg-soft))' }}>
      <span className="label" style={{ margin: 0, color: 'var(--codex)' }}>Codex</span>
      {/* An absent model means no --model was passed, so the CLI's own default
          runs and Wanigan does not read what that default is. 'Auto' named a
          setting nobody chose and nobody observed; the run-config bar four
          lines down already says this correctly. */}
      <span className="mono" style={{ fontSize: 'var(--t-micro)', color: 'var(--text-dim)' }}>
        {session.model
          ? session.model
          : <Mark glyph="◦" word="CLI default" tone="quiet" title="No model was passed at launch, so Codex used its own default. Wanigan does not read what that is." />}
        {' · effort '}
        {session.effort
          ? session.effort
          : <Mark glyph="◦" word="CLI default" tone="quiet" title="No effort was passed at launch, so Codex used its own default." />}
      </span>
      <button className="btn btn-primary" style={{ fontSize: 'var(--t-small)', padding: '4px 10px' }}
              title="Open Codex’s model picker: choose model, reasoning effort, or an Auto choice"
              onClick={() => send('/model', 'Codex model picker opened')}>
        Change model &amp; effort…
      </button>
      <button className="btn" style={{ fontSize: 'var(--t-small)', padding: '3px 9px' }}
              title="Enter Codex Plan mode for the next task; Codex will explain the plan before changing files"
              onClick={() => send('/plan', 'Plan mode opened')}>
        Plan next task
      </button>
      <span className="faint" style={{ fontSize: 'var(--t-micro)', lineHeight: 1.35, minWidth: 0 }}>
        {sent ?? 'Model & effort opens Codex’s own picker. Plan mode affects the next task, not work already running.'}
      </span>
    </div>
  );
}

/**
 * What a running session's picker may honestly offer, and where it came from.
 *
 * This bar used to keep its own answer: a constant table of models keyed on
 * profile id, plus a short-circuit on that same id. Wanigan ships four
 * built-in profiles and the table held three keys — `claude`, `glm`, and an
 * empty `codex` entry this bar never reached, since a codex session gets
 * `CodexControlBar` instead. `deepseek` was the id it left out, so a DeepSeek
 * session got no picker here at all while `deepseekModels()` sat shipped in
 * main with nothing on this surface calling it; a pack profile, keyed on
 * nothing, was handed the same empty list. The short-circuit made `glm` the
 * one id with a live read, and that branch did print the note its fetcher
 * carries — "this is Wanigan's local list, not the service's" — so GLM was
 * the one profile here that said where its list came from. Claude's four
 * aliases were printed as bare fact, and they are Wanigan's own published
 * list rather than Anthropic's answer.
 * `providers:modelCatalogue` is the one place that question is answered now.
 * It reaches DeepSeek's fetcher from this bar for the first time, answers for
 * a pack profile from that profile's own declaration, and reports its own
 * provenance rather than rounding it up. A local pack's backend id is
 * namespaced `packId:backendId`, so it never matches a live or published
 * table — a pack profile gets what it declared, or 'none', never a service's
 * answer borrowed from a built-in that happens to share a name.
 *
 * Two rules this bar adds on top of that channel:
 *
 * The DECLARATION is the frozen one. `session.providerProfile` is the snapshot
 * written when this session launched; `provider` is whatever that profile id
 * resolves to now. A pack can be upgraded, disabled or removed while a session
 * runs, and Wanigan keeps the frozen pack/profile/backend/harness snapshot
 * until the session exits rather than reinterpreting a live session through a
 * newer manifest. So the effort scale and the model field come from the
 * snapshot, and the live provider is only the fallback for a session recorded
 * before the snapshot existed.
 *
 * The CATALOGUE is refused when the id no longer names the same backend. The
 * channel takes a profile id and main answers it from the pack snapshot loaded
 * now — correct for the dialog, which is choosing a profile to launch, and not
 * necessarily this session's. When the frozen backend and the current one are
 * both known and differ, the rows describe a service this session never spoke
 * to, and the profile's own declared list is shown instead with the reason.
 */

type CatalogueMark = { glyph: string; word: string; tone: Tone; title: string };

/** Provenance, as a glyph and a word — never as a colour, and never rounded up. */
const CATALOGUE_MARK: Record<LaunchModelCatalogue['source'] | 'reading', CatalogueMark> = {
  reading: {
    glyph: '◦', word: 'reading', tone: 'quiet',
    title: 'Wanigan is asking this profile which models it can launch. Nothing has been established yet.',
  },
  live: {
    glyph: '✓', word: 'live', tone: 'ok',
    title: 'Wanigan asked this backend for its catalogue and this is the answer it gave.',
  },
  declared: {
    glyph: '•', word: 'declared', tone: 'quiet',
    title: 'This profile declares its own model list, so the list is the profile’s rather than the backend’s.',
  },
  published: {
    glyph: '?', word: 'published', tone: 'warn',
    title: 'Wanigan’s own published list, because this backend could not be asked or would not answer. It can be out of date; a model that is not on it still works if you type /model into the session yourself.',
  },
  none: {
    glyph: '–', word: 'unknown', tone: 'dead',
    title: 'Nothing could be established about this profile’s models. That is not the same as this profile having none.',
  },
};

/* ── model and effort, on a session that is already running ──────────────
   --model and --effort are argv, and you cannot change a running process's
   arguments. What you CAN do is what you would do by hand: type the CLI's own
   /model and /effort into the terminal. So these controls send exactly that,
   which is why they work rather than merely looking like they do — and why
   they are disabled the moment a session exits.
   ─────────────────────────────────────────────────────────────────────── */

/** Reading, answered, or refused with the sentence that says why. */
type CatalogueRead =
  | { state: 'reading' }
  | { state: 'read'; catalogue: LaunchModelCatalogue }
  | { state: 'refused'; note: string };

function RunConfigBar({ session, provider }: { session: Session; provider?: ProviderInfo }) {
  // The profile this session actually started under, not what its id means now.
  const frozen = session.providerProfile ?? null;
  const launched = frozen ?? provider ?? null;
  const modelField = launchFieldChoices(launched, 'model');
  const effortField = launchFieldChoices(launched, 'effort');
  const levels = effortField.choices.map((choice) => choice.value);
  // `supported` is the conjunct that decides: launchFieldChoices hands back
  // Wanigan's five levels for any profile that declares none of its own, so a
  // slider guarded on the list alone would appear for a profile that takes no
  // effort flag. The length test never falsifies on today's fallback; it is
  // there so the slider's own max can never be asked to render -1.
  const showEffort = effortField.supported && levels.length > 0;

  // Both sides have to be known before a difference is worth calling drift; an
  // absent backendId is a legacy row, not a re-pointed profile.
  const launchedBackend = session.backendId ?? frozen?.backendId ?? null;
  const drifted = !!launchedBackend && !!provider?.backendId && provider.backendId !== launchedBackend;

  const [read, setRead] = useState<CatalogueRead>({ state: 'reading' });

  useEffect(() => {
    if (drifted) {
      setRead({ state: 'refused', note: 'This profile id now points at a different backend than the one this session launched against, so Wanigan will not show you that backend’s models here.' });
      return;
    }
    let live = true;
    setRead({ state: 'reading' });
    window.wanigan.providers.modelCatalogue(session.providerId)
      .then((catalogue) => { if (live) setRead({ state: 'read', catalogue }); })
      // The channel rejects outright when the profile is no longer loaded —
      // the pack was disabled or removed under a session that is still
      // running. That is a fact worth printing, not an empty list.
      .catch((e) => { if (live) setRead({ state: 'refused', note: `Wanigan could not read this profile’s model catalogue (${msg(e)}).` }); });
    return () => { live = false; };
  }, [session.providerId, drifted]);

  // The frozen profile's own list: what a refusal falls back to, and never a
  // guess — an empty one reports 'none', which means nothing was established.
  const declaredRows: LaunchModelRow[] = modelField.declared
    ? modelField.choices.map((choice) => ({
      value: choice.value, label: choice.label, description: choice.description ?? null, efforts: null,
    }))
    : [];
  const shown: LaunchModelCatalogue | null =
    read.state === 'read' ? read.catalogue
      : read.state === 'refused'
        ? {
          rows: declaredRows,
          source: declaredRows.length ? 'declared' : 'none',
          // The second sentence is only true when there is a declared list to
          // point at; a profile whose model field is free text has none, and
          // 'none' says so rather than promising four aliases nobody wrote down.
          note: declaredRows.length
            ? `${read.note} These are the models the profile itself declared at launch.`
            : read.note,
        }
        : null;

  const [model, setModel] = useState(session.model ?? '');
  const [effortIdx, setEffortIdx] = useState(() => {
    const i = levels.indexOf(session.effort ?? '');
    // Index 2 is 'high' on Wanigan's five-level scale and has been this
    // slider's default since it landed; a shorter declared scale takes its last.
    return i >= 0 ? i : Math.max(0, Math.min(2, levels.length - 1));
  });
  const [sent, setSent] = useState<string | null>(null);

  // A scale that changed under a held index would send `levels[i]` as
  // undefined, which reads at the other end as no effort at all.
  useEffect(() => {
    setEffortIdx((i) => Math.max(0, Math.min(i, levels.length - 1)));
  }, [levels.length]);

  function send(field: 'model' | 'effort', value: string | undefined) {
    if (!value) return;
    // A slash command is the whole action — there is nothing left to write —
    // and setTuning both types it and records the value on the session row.
    // Without that write-back, a tab switch remounts this bar and it re-seeds
    // from launch-time argv: the slider snapped back to the default while the
    // session kept running at the level actually sent.
    const command = `/${field} ${value}`;
    window.wanigan.sessions.setTuning(session.id, field, value)
      .then((ok) => {
        if (!ok) return;
        setSent(command);
        window.setTimeout(() => setSent((c) => (c === command ? null : c)), 2600);
      })
      .catch(() => { /* exited under the click; the next session push removes this bar */ });
  }

  /**
   * The last effort this bar actually sent, so a repeat is not re-sent.
   *
   * Seeded from the session's recorded effort: on mount the level on screen is
   * the level the agent is already at, and typing it again is a slash command
   * and a carriage return the operator did not ask for.
   */
  const lastEffortSent = useRef<string | undefined>(session.effort ?? undefined);
  function sendEffortIfChanged(value: string | undefined) {
    if (!value || value === lastEffortSent.current) return;
    lastEffortSent.current = value;
    send('effort', value);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                  padding: '6px 12px', borderTop: '1px solid var(--line-soft)' }}>
      {modelField.supported && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="label" style={{ margin: 0 }}>{modelField.label}</span>
          <select
            className="field"
            style={{ padding: '3px 7px', fontSize: 'var(--t-small)' }}
            value={model}
            /* A read that has not returned is not an empty catalogue, so the
               control holds the session's own value and says it is reading
               rather than offering a list it does not have yet. */
            disabled={!shown}
            aria-busy={!shown}
            onChange={(e) => { setModel(e.target.value); if (e.target.value) send('model', e.target.value); }}
          >
            {shown
              ? <>
                <option value="">CLI default</option>
                {shown.rows.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </>
              : <option value={model}>{model || 'CLI default'}</option>}
          </select>
          <Mark {...CATALOGUE_MARK[shown ? shown.source : 'reading']} />
        </label>
      )}

      {showEffort && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="label" style={{ margin: 0 }}>{effortField.label}</span>
          <input
            type="range"
            min={0}
            max={levels.length - 1}
            step={1}
            value={effortIdx}
            aria-label={`${effortField.label} level`}
            aria-valuetext={levels[effortIdx]}
            onChange={(e) => setEffortIdx(Number(e.target.value))}
            // Sent only when the level actually changed. Every pointer-up used
            // to type `/effort high⏎` into the agent — a tap on the thumb with
            // no movement, or a tap on the track from an iPad, submitted a
            // carriage return into whatever the TUI had half-typed. Home, End
            // and PageUp moved the slider and sent nothing at all, so the
            // keyboard check is on the value now rather than on the key name.
            onPointerUp={() => sendEffortIfChanged(levels[effortIdx])}
            onKeyUp={() => sendEffortIfChanged(levels[effortIdx])}
            style={{ width: 128, accentColor: 'var(--accent)' }}
          />
          {/* The word, not just the notch — a slider position is not a value.
              And it is not a claim about the session either: with no --effort at
              launch and no /effort sent since, the CLI's own default is what is
              running and the slider is only a proposal. Saying 'high' there was
              the same lie as an empty state drawn before the first read. */}
          <span className="mono" style={{ fontSize: 'var(--t-small)', color: 'var(--accent)', minWidth: 46 }}>
            {levels[effortIdx]}
          </span>
          {!session.effort && (
            <Mark glyph="◦" word="CLI default" tone="quiet"
                  title="This session launched without an effort argument and none has been sent since, so it is running at the CLI’s own default. Move the slider to send one." />
          )}
        </label>
      )}

      <span className="faint" style={{ fontSize: 'var(--t-micro)', marginLeft: 'auto', minWidth: 0 }}>
        {sent
          ? <><span className="mono" style={{ color: 'var(--ok)' }}>{sent}</span> sent to the session</>
          /* Both sentences, never one instead of the other. The note says where
             this list came from; the instruction says what these controls do,
             and it is the only place on screen that says it. Choosing the note
             would retire the instruction for every anthropic-backed session,
             because that backend's catalogue always carries a note. */
          : <>Typed into the session as a slash command, and recorded on this
              session.{shown?.note ? ` ${shown.note}` : ''}</>}
      </span>
    </div>
  );
}

/**
 * Persistent by construction: no dismiss control exists. A session allowed to
 * do more than your default is a fact about the machine for as long as it runs,
 * and a banner you can wave away is one you will wave away.
 */
function TrustBanner({ level, fallback, running }: {
  level: TrustLevel; fallback: TrustLevel; running: boolean;
}) {
  const copy = trustCopy(level);
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px',
      background: 'var(--warning-soft)', borderLeft: '3px solid var(--warning)', lineHeight: 1.45,
    }}>
      <span aria-hidden="true" style={{ color: 'var(--warning)', fontWeight: 700, fontSize: 'var(--t-small)' }}>
        {trustGlyph(level)}
      </span>
      <span style={{ color: 'var(--warning)', fontWeight: 650, fontSize: 'var(--t-small)', flex: 'none' }}>
        {copy.label} trust
      </span>
      <span style={{ color: 'var(--text-dim)', fontSize: 'var(--t-small)', minWidth: 0 }}>
        {copy.detail} {running ? 'This session is running' : 'This session ran'} above your default,
        {' '}{trustCopy(fallback).label} ({trustGlyph(fallback)}).
      </span>
    </div>
  );
}

/**
 * A worktree is work that lives somewhere the repo cannot see yet. The bar says
 * where it is, how much is uncommitted, and gives the two ways out — with the
 * dirty count read fresh at the moment of the warning, never from a poll that
 * may be twenty seconds stale.
 */
function WorktreeBar({ session, path, onRefresh }: {
  session: Session; path: string; onRefresh: () => Promise<void>;
}) {
  const [info, setInfo] = useState<WorktreeInfo | null | undefined>(undefined);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'merge' | 'check' | 'discard'>(null);
  const [confirm, setConfirm] = useState<WorktreeInfo | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      setInfo(await window.wanigan.worktrees.status(path));
      setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [path]);

  useEffect(() => {
    void load();
    // Nobody is reading a worktree count in a hidden window, and the Sessions
    // tab already runs several pollers; this one shells out to git each time.
    const t = setInterval(() => { if (!document.hidden) void load(); }, 20_000);
    const onVis = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [load]);

  async function merge() {
    setBusy('merge'); setResult(null);
    try {
      // Every refusal comes back as merged:false carrying the reason — a dirty
      // tree, a base branch nobody has checked out, a conflict it aborted and
      // restored — so the catch below is for the one case that throws: no
      // worktree at this path any more.
      const r = await window.wanigan.worktrees.merge(path);
      setResult({ ok: r.merged, text: r.detail });
      await load();
      await onRefresh();
    } catch (e) {
      setResult({ ok: false, text: msg(e) });
    } finally { setBusy(null); }
  }

  async function askDiscard() {
    setBusy('check'); setResult(null);
    try {
      const fresh = await window.wanigan.worktrees.status(path);
      setInfo(fresh);
      if (!fresh) {
        setResult({ ok: true, text: `Nothing to discard — there is no worktree at ${path} any more.` });
        return;
      }
      setConfirm(fresh);
    } catch (e) {
      setResult({ ok: false, text: msg(e) });
    } finally { setBusy(null); }
  }

  async function discard(target: WorktreeInfo) {
    setBusy('discard');
    try {
      const r = await window.wanigan.worktrees.remove(target.path, target.dirty > 0);
      setResult({ ok: r.removed, text: r.detail });
      setConfirm(null);
      await load();
      await onRefresh();
    } catch (e) {
      setResult({ ok: false, text: msg(e) });
      setConfirm(null);
    } finally { setBusy(null); }
  }

  const branch = info?.branch ?? null;

  return (
    <div style={{ padding: '6px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span aria-hidden="true" style={{ color: 'var(--accent)', fontWeight: 700 }}>⑂</span>
        <span className="label" style={{ flex: 'none' }}>Worktree</span>

        {info === undefined ? (
          <span className="faint" style={{ fontSize: 'var(--t-small)' }}>Reading git…</span>
        ) : info === null ? (
          <span className="dim" style={{ fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
            Gone from disk. Wanigan removes an isolated worktree once the session ends and nothing is
            uncommitted in it — the branch it used is kept.
          </span>
        ) : (
          <>
            <span className="mono" style={{ fontSize: 'var(--t-small)', fontWeight: 600 }}>{branch ?? 'detached HEAD'}</span>
            <span className="faint mono trunc" style={{ fontSize: 'var(--t-micro)' }} title={info.path}>{info.path}</span>
            <span className="dim" style={{ fontSize: 'var(--t-small)', fontVariantNumeric: 'tabular-nums' }}>
              {info.dirty > 0
                ? `${plural(info.dirty, 'uncommitted file')}`
                : 'nothing uncommitted'}
              {' · '}
              {info.ahead > 0 ? `${plural(info.ahead, 'commit')} ahead` : 'no commits yet'}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <FocusBtn className="btn" style={{ padding: '3px 9px' }} disabled={busy !== null || !branch}
                        title={branch
                          ? `Merge ${branch} back into the branch it was cut from`
                          : 'This worktree is on a detached HEAD, so there is no branch to merge'}
                        onClick={merge}>
                {busy === 'merge' ? 'Merging…' : 'Merge'}
              </FocusBtn>
              {/* Deleting the checkout an agent is actively editing pulls the
                  ground out from under a live process. The session has to end
                  first — the button says so instead of failing halfway. */}
              <FocusBtn className="btn btn-danger" style={{ padding: '3px 9px' }}
                        disabled={busy !== null || session.status === 'running'}
                        title={session.status === 'running'
                          ? 'End this session before discarding the worktree it is running in'
                          : 'Delete this worktree folder'}
                        onClick={askDiscard}>
                {busy === 'check' ? 'Checking…' : 'Discard…'}
              </FocusBtn>
            </div>
          </>
        )}
      </div>

      {confirm && (
        <div style={{ background: 'var(--warning-soft)', borderLeft: '3px solid var(--warning)',
                      borderRadius: 'var(--r-sm)', padding: '8px 11px', lineHeight: 1.5 }}>
          <div style={{ color: 'var(--warning)', fontWeight: 650, fontSize: 'var(--t-small)' }}>
            <span aria-hidden="true">⚠ </span>
            {confirm.dirty > 0
              ? `${plural(confirm.dirty, 'uncommitted file')} will be deleted`
              : 'Delete this worktree folder?'}
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 'var(--t-small)', marginTop: 3 }}>
            {confirm.dirty > 0
              ? <>Those changes exist only in <span className="mono">{confirm.path}</span> and nowhere else.
                  Commit them there first if you want to keep them.</>
              : <>Nothing is uncommitted, so only the folder at <span className="mono">{confirm.path}</span> goes.</>}
            {confirm.ahead > 0 && confirm.branch && (
              <> {plural(confirm.ahead, 'commit')} on <span className="mono">{confirm.branch}</span> are
                 not merged anywhere else; the branch itself is kept, so they are recoverable.</>
            )}
          </p>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <FocusBtn className="btn" onClick={() => setConfirm(null)} disabled={busy === 'discard'}>Keep it</FocusBtn>
            <FocusBtn className="btn btn-danger" onClick={() => discard(confirm)} disabled={busy === 'discard'}>
              {busy === 'discard' ? 'Deleting…' : confirm.dirty > 0 ? 'Delete it and lose the changes' : 'Delete the worktree'}
            </FocusBtn>
          </div>
        </div>
      )}

      {result && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Note tone={result.ok ? 'ok' : 'error'}>
              <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>{result.ok ? '✓' : '✕'}</span>
              <span style={{ fontWeight: 650 }}>{result.ok ? 'Done. ' : 'Not done. '}</span>
              {result.text}
            </Note>
          </div>
          <FocusBtn className="past-x faint" title="Dismiss" onClick={() => setResult(null)}>×</FocusBtn>
        </div>
      )}

      {err && (
        <Note tone="error">
          <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
          Could not read the worktree: {err} — Wanigan runs git in {path}; check the folder still exists.
        </Note>
      )}
    </div>
  );
}

/* ── P21 · attachments ────────────────────────────────────────────────── */

type AttachState = ReturnType<typeof useAttachments>;

function useAttachments(sessionId: string | null) {
  const [items, setItems] = useState<Attachment[]>([]);
  const [sent, setSent] = useState(0);
  const [cost, setCost] = useState<Record<string, number | null>>({});
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [rejects, setRejects] = useState<{ key: number; text: string }[]>([]);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const seq = useRef(0);
  const run = useRef(0);

  const load = useCallback(async () => {
    if (!sessionId) { setItems([]); setCost({}); setPhase('ready'); return; }
    // Switching tabs mid-read must not paint the previous session's files.
    const mine = ++run.current;
    try {
      const all = (await window.wanigan.attach.list(sessionId)) as Attachment[];
      if (mine !== run.current) return;
      // Sent files leave the strip the way they do in any chat client. The row
      // and the staged bytes both stay: the agent may still be reading them.
      const list = all.filter((a) => a.sentAt === null);
      setItems(list);
      setSent(all.length - list.length);
      setPhase('ready');
      setLoadErr(null);
      // Cost comes from the main process's own pricing, one bounded header read
      // per image, rather than a rate re-derived in the renderer.
      const priced = await Promise.all(list.filter((a) => a.kind === 'image').map(async (a) => {
        try {
          const c = (await window.wanigan.attach.inspect(a.storedPath)) as AttachCheck;
          return [a.id, c.estimatedUsd] as const;
        } catch { return [a.id, null] as const; }
      }));
      if (mine !== run.current) return;
      setCost(Object.fromEntries(priced));
    } catch (e) {
      if (mine !== run.current) return;
      setPhase('error');
      setLoadErr(msg(e));
    }
  }, [sessionId]);

  useEffect(() => { setPhase('loading'); void load(); }, [load]);

  // A rejection is the whole point of the check — it is shown verbatim and
  // stays until dismissed. Swallowing it is how a HEIC silently does nothing.
  const reject = useCallback((text: string) => {
    const key = ++seq.current;
    setRejects((prev) => [...prev, { key, text }].slice(-4));
  }, []);

  /**
   * Staging a file is not the same as telling the agent about it: the agent
   * reads from disk, so its path has to appear in the prompt. Attaching used
   * to stop at staging, which is why a file could be added, a question asked,
   * and the agent never learn the file existed.
   */
  const typeReference = useCallback(async (onlyNew = false) => {
    if (!sessionId) return false;
    try {
      const ok = await window.wanigan.attach.type(sessionId, onlyNew);
      if (ok) {
        setHint('Added to your prompt, not sent. Say what you want done with it, then press Enter.');
      } else if (!onlyNew) {
        setHint('Nothing to reference yet — attach a file first.');
      }
      await load();
      return ok;
    } catch (e) { reject(msg(e)); return false; }
  }, [sessionId, load, reject]);

  const addFiles = useCallback(async (files: File[]) => {
    if (!sessionId || files.length === 0) return;
    setBusy(true); setHint(null);
    for (const f of files) {
      try {
        // Electron 32 removed File.path; the bytes are the portable route, and
        // the main process runs the same checks on either.
        const p = (f as File & { path?: string }).path;
        if (p) await window.wanigan.attach.add(sessionId, p);
        else await window.wanigan.attach.paste(sessionId, await f.arrayBuffer(), f.name);
      } catch (e) { reject(msg(e)); }
    }
    setBusy(false);
    await load();
    // Only the newly staged files: a file already named in the prompt must not
    // be typed a second time.
    await typeReference(true);
  }, [sessionId, load, reject, typeReference]);

  const addPaths = useCallback(async (paths: string[]) => {
    if (!sessionId || paths.length === 0) return;
    setBusy(true); setHint(null);
    for (const p of paths) {
      try { await window.wanigan.attach.add(sessionId, p); }
      catch (e) { reject(msg(e)); }
    }
    setBusy(false);
    await load();
    // Only the newly staged files: a file already named in the prompt must not
    // be typed a second time.
    await typeReference(true);
  }, [sessionId, load, reject, typeReference]);

  const browse = useCallback(async () => {
    try {
      const picked = await window.wanigan.browse.pick(true);
      await addPaths(picked);
    } catch (e) { reject(msg(e)); }
  }, [addPaths, reject]);

  const remove = useCallback(async (id: string) => {
    try { await window.wanigan.attach.remove(id); }
    catch (e) { reject(msg(e)); }
    await load();
  }, [load, reject]);


  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 9000);
    return () => clearTimeout(t);
  }, [hint]);

  // The pooled terminal announces a submitted line; the files that prompt named
  // have gone to the agent, so re-read and let them leave the strip.
  useEffect(() => {
    if (!sessionId) return;
    const onSubmit = (e: Event) => {
      const detail = (e as CustomEvent<{ sessionId?: string }>).detail;
      if (detail?.sessionId === sessionId) void load();
    };
    window.addEventListener('wanigan:session-submit', onSubmit);
    return () => window.removeEventListener('wanigan:session-submit', onSubmit);
  }, [sessionId, load]);

  // ⌘V anywhere in the view, because the terminal is usually focused but the
  // browse button might be. Text paste is left alone for xterm to handle.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (!sessionId) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT'
        || (t.tagName === 'TEXTAREA' && !t.classList.contains('xterm-helper-textarea')))) return;
      const found = imagesFrom(e.clipboardData);
      if (found.length === 0) return;
      e.preventDefault();
      void addFiles(found);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [sessionId, addFiles]);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!sessionId || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, [sessionId]);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!sessionId || !hasFiles(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [sessionId]);

  const onDragLeave = useCallback(() => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!sessionId) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);

    // A dropped folder arrives as a zero-byte File. Naming it as a folder is
    // the same sentence the main process uses for a folder path, rather than
    // letting it come back as "this file is empty".
    const dirs: string[] = [];
    for (const item of Array.from(e.dataTransfer.items ?? [])) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry?.isDirectory) dirs.push(entry.name);
    }
    for (const d of dirs) reject(`${d} is a folder, not a file. Attach the files inside it individually.`);

    const files = Array.from(e.dataTransfer.files ?? []).filter((f) => !dirs.includes(f.name));
    if (files.length) void addFiles(files);
  }, [sessionId, addFiles, reject]);

  return {
    items,
    sent, cost, phase, loadErr, rejects, hint, busy, dragging,
    reload: load, browse, remove, typeReference,
    dismiss: (key: number) => setRejects((prev) => prev.filter((r) => r.key !== key)),
    onDragEnter, onDragOver, onDragLeave, onDrop,
  };
}

function hasFiles(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes('Files');
}

/** clipboardData.files is the normal route; items is the fallback some sources use. */
function imagesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out = Array.from(dt.files ?? []).filter((f) => f.type.startsWith('image/'));
  if (out.length) return out;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const f = item.getAsFile();
    if (f) out.push(f);
  }
  return out;
}

function AttachStrip({ session, att }: { session: Session; att: AttachState }) {
  const images = att.items.filter((a) => a.kind === 'image');
  const visual = images.reduce((n, a) => n + (a.visualTokens ?? 0), 0);
  const priced = images.reduce((n, a) => n + (att.cost[a.id] ?? 0), 0);

  return (
    <div className="session-attachments" style={{ borderTop: '1px solid var(--line)', background: 'var(--bg-soft)',
                  padding: '6px 10px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="label" style={{ flex: 'none' }}>Attachments</span>
        <span className="faint" style={{ fontSize: 'var(--t-small)', fontVariantNumeric: 'tabular-nums' }}>
          {att.phase === 'loading' ? 'reading…'
            : att.items.length === 0
              ? (att.sent > 0 ? `none staged · ${plural(att.sent, 'file')} sent` : 'none staged')
              : `${plural(att.items.length, 'file')} staged${att.sent > 0 ? ` · ${att.sent} sent` : ''}`}
          {images.length > 0 && visual > 0 && (
            <> · {num(visual)} visual tokens ≈ {usd(priced)} when read</>
          )}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <FocusBtn className="btn" style={{ padding: '3px 9px' }} onClick={att.browse} disabled={att.busy}
                    title="Pick files to stage for this session">
            {att.busy ? 'Adding…' : '+ Add files'}
          </FocusBtn>
          <FocusBtn className="btn" style={{ padding: '3px 9px' }} onClick={() => void att.typeReference()}
                    disabled={att.items.length === 0 || att.busy || session.status === 'exited'}
                    title={session.status === 'exited'
                      ? 'This session has exited, so there is no prompt to type into. Resume it from Recent, then add the file.'
                      : 'Attaching already names these files in your prompt. Use this to name them again — after clearing the input, say.'}>
            Name again
          </FocusBtn>
        </div>
      </div>

      {att.phase === 'error' ? (
        <Note tone="error">
          <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
          The attachment list did not load: {att.loadErr} Files already staged are still on disk in this
          session's attachment folder.{' '}
          <FocusBtn className="link" style={{ fontSize: 'var(--t-small)' }} onClick={() => void att.reload()}>Retry</FocusBtn>
        </Note>
      ) : att.phase === 'loading' ? (
        <p className="faint" style={{ fontSize: 'var(--t-small)' }}>Reading what is staged for this session…</p>
      ) : att.items.length === 0 ? (
        // Three lines of teaching, permanently, under the terminal on the view
        // an operator spends the day in — and it is a lesson learned once. The
        // remembered one-liner keeps it for a newcomer and gives it back to
        // everyone else as a "Show:" link.
        <Explainer id="attach-how" title="How attachments work" compact>
          Drop a file on the terminal, paste a screenshot with ⌘V, or add one. Wanigan copies it where
          this project's agent can read it and writes the path into your prompt, so all you add is the
          question. Sent files leave this strip.
        </Explainer>
      ) : (
        // Its own scroller: a dozen chips are wider than the pane, and the view
        // never scrolls sideways as a whole.
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          {att.items.map((a) => (
            <Chip key={a.id} a={a} usdCost={att.cost[a.id] ?? null} onRemove={() => void att.remove(a.id)} />
          ))}
        </div>
      )}

      {att.hint && <Note tone="info">{att.hint}</Note>}

      {att.rejects.map((r) => (
        <div key={r.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Note tone="error">
              <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
              <span style={{ fontWeight: 650 }}>Not attached. </span>{r.text}
            </Note>
          </div>
          <FocusBtn className="past-x faint" title="Dismiss" onClick={() => att.dismiss(r.key)}>×</FocusBtn>
        </div>
      ))}
    </div>
  );
}

function Chip({ a, usdCost, onRemove }: { a: Attachment; usdCost: number | null; onRemove: () => void }) {
  const k = KIND[a.kind] ?? KIND.unsupported;
  const dims = a.width && a.height ? `${num(a.width)}×${num(a.height)} px` : null;
  return (
    <div style={{ flex: 'none', maxWidth: 300, display: 'flex', alignItems: 'center', gap: 8,
                  border: '1px solid var(--line)', borderRadius: 'var(--r-md)', background: 'var(--bg-sunk)',
                  padding: '4px 4px 4px 9px' }}>
      <span aria-hidden="true" style={{ color: 'var(--text-dim)', fontWeight: 700 }}>{k.glyph}</span>
      <span style={{ minWidth: 0 }}>
        <span className="mono" style={{ display: 'block', fontSize: 'var(--t-small)', overflow: 'hidden',
                                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={a.storedPath}>
          {a.name}
        </span>
        <span className="faint" style={{ fontSize: 'var(--t-micro)', fontVariantNumeric: 'tabular-nums',
                                         whiteSpace: 'nowrap' }}>
          {k.word} · {size(a.bytes)}
          {dims && <> · {dims}</>}
          {a.kind === 'image' && a.visualTokens !== null && (
            <> · {num(a.visualTokens)} visual tokens{usdCost !== null && <> · {usd(usdCost)}</>}</>
          )}
        </span>
      </span>
      <FocusBtn className="past-x faint" title={`Remove ${a.name}`} onClick={onRemove}
                aria-label={`Remove ${a.name}`}>×</FocusBtn>
    </div>
  );
}
