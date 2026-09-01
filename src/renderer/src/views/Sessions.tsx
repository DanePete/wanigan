import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LaunchOptions, PastSession, Project, ProviderId, ProviderInfo, Session, TrustLevel, WorktreeInfo,
} from '@shared/types';
import { EFFORT_LEVELS, TRUST_COPY, TRUST_LEVELS } from '@shared/types';
import TerminalPane, { feed, disposePane } from '../components/TerminalPane';
import NewSessionDialog from '../components/NewSessionDialog';
import CodePanel from '../components/CodePanel';
import AttentionQueue from '../components/AttentionQueue';
import Timeline from '../components/Timeline';
import SessionLearning from '../components/SessionLearning';
import Pet from '../components/Pet';
import { Note, ago, num, usd } from '../components/bits';
import '../styles/sessions.css';

const TINT: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)', glm: 'var(--glm)' };

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

/**
 * Trust reads as a filled progression: ◇ → ◈ → ◆. The shape carries the
 * escalation on its own, so the banner still says "more than usual is allowed"
 * in greyscale, and the wording always comes from TRUST_COPY.
 */
const TRUST_GLYPH: Record<TrustLevel, string> = { readonly: '◇', project: '◈', trusted: '◆' };

const rank = (t: TrustLevel) => TRUST_LEVELS.indexOf(t);

// The session picker has a different breakpoint from the code/timeline rail.
// A 960px coarse-pointer viewport includes iPad portrait without hiding the
// picker on a roomy desktop, while 860px keeps ordinary narrow windows from
// spending a third of their width on a list.
const SESSION_PICKER_COMPACT_QUERY = '(max-width: 860px), (pointer: coarse) and (max-width: 960px)';
const CODE_RAIL_COMPACT_QUERY = '(max-width: 900px), (pointer: coarse) and (max-width: 960px)';

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const [exactRecoveryDialog, setExactRecoveryDialog] = useState(false);
  // Loading is not empty. Until the first list() answers, "no sessions running"
  // would be a claim Wanigan has not checked.
  const [ready, setReady] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  // Remembered per machine: whether the side rail is open is a working
  // preference, not session state.
  const [showRail, setShowRail] = useState(() => localStorage.getItem('wanigan.code') === '1');
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia(CODE_RAIL_COMPACT_QUERY).matches);
  const [sessionPickerCompact, setSessionPickerCompact] = useState(() =>
    window.matchMedia(SESSION_PICKER_COMPACT_QUERY).matches,
  );
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false);
  const [railPane, setRailPane] = useState<Record<string, RailPane>>(readPanes);
  /*
   * Three agents in one repo were three identical rows. The launch title is
   * assigned once and is "<provider> · <project>" for all three of them, so the
   * only thing that can tell them apart is a name you give them. Kept on this
   * machine, which is exactly as long as the sessions themselves last: a PTY
   * does not survive a quit.
   */
  const [labels, setLabels] = useState<Record<string, string>>(readLabels);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [defaultTrust, setDefaultTrust] = useState<TrustLevel | null>(null);
  const [past, setPast] = useState<PastSession[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const [teachSession, setTeachSession] = useState<Session | null>(null);
  const activeRef = useRef<string | null>(null);
  const sessionPickerRef = useRef<HTMLElement | null>(null);
  const sessionPickerButtonRef = useRef<HTMLButtonElement | null>(null);
  // React state does not change until the next render. The ref closes the
  // same-tick gap so a double click cannot launch two writers for one thread.
  const resumePendingRef = useRef(false);
  // Unread increments waiting to be folded into the list in one pass.
  const unreadPending = useRef(new Map<string, number>());
  const unreadTimer = useRef<number | undefined>(undefined);
  activeRef.current = activeId;

  const flushUnread = useCallback(() => {
    unreadTimer.current = undefined;
    const pending = unreadPending.current;
    if (!pending.size) return;
    const batch = new Map(pending);
    pending.clear();
    setSessions((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        const add = batch.get(s.id);
        // A session selected during the window has already been read; its
        // badge was cleared by select(), and re-adding here would resurrect it.
        if (!add || s.id === activeRef.current) return s;
        changed = true;
        return { ...s, unread: s.unread + add };
      });
      // Identity matters: an unchanged array skips the whole rail re-render.
      return changed ? next : prev;
    });
  }, []);

  // The shell can ask for a new interactive session from any route. Consume
  // the request immediately after opening the dialog: returning to Sessions
  // later must not resurrect a dialog that the person already dismissed.
  useEffect(() => {
    if (newSessionRequest === null) return;
    setDialog(true);
    onNewSessionRequestConsumed();
  }, [newSessionRequest, onNewSessionRequestConsumed]);

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.wanigan.sessions.list());
      setPast(await window.wanigan.sessions.past());
      setListErr(null);
    } catch (e) {
      setListErr(msg(e));
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // An iPad-sized terminal beside a persistent 340px code rail becomes an
  // unreadable sliver. Keep the saved desktop preference, but deliberately
  // collapse the secondary pane below tablet width so the live conversation is
  // always the full working surface.
  useEffect(() => {
    const media = window.matchMedia(CODE_RAIL_COMPACT_QUERY);
    const sync = () => setCompactLayout(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  // On a tablet or a narrow window, the session list becomes an overlay. That
  // makes the terminal the full working surface instead of a column squeezed
  // between two persistent rails. The state is deliberately local: it is a
  // momentary switcher, not a preference the next launch should surprise you
  // with.
  useEffect(() => {
    const media = window.matchMedia(SESSION_PICKER_COMPACT_QUERY);
    const sync = () => {
      setSessionPickerCompact(media.matches);
      if (!media.matches) setSessionPickerOpen(false);
    };
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
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
    const offData = window.wanigan.on.data(({ sessionId, data }) => {
      feed(sessionId, data);
      if (sessionId === activeRef.current) return;
      /*
       * A chunk arrives per burst of agent output, and rebuilding every session
       * object in the list for each one made an unread badge cost a full
       * re-render of the rail and the tab strip. The increments are collected
       * and applied together instead; the badge is a count, not a clock.
       */
      unreadPending.current.set(sessionId, (unreadPending.current.get(sessionId) ?? 0) + 1);
      if (unreadTimer.current === undefined) {
        unreadTimer.current = window.setTimeout(flushUnread, 250);
      }
    });
    const offList = window.wanigan.on.sessions((list) => {
      setSessions((prev) => {
        const unread = new Map(prev.map((s) => [s.id, s.unread]));
        return list.map((s) => ({ ...s, unread: s.id === activeRef.current ? 0 : (unread.get(s.id) ?? 0) }));
      });
    });
    const offExit = window.wanigan.on.exit(({ sessionId, exitCode }) => {
      feed(sessionId, `\r\n\x1b[38;5;244m── session exited (code ${exitCode}) ──\x1b[0m\r\n`);
    });
    return () => {
      offData(); offList(); offExit();
      window.clearTimeout(unreadTimer.current);
      unreadTimer.current = undefined;
    };
  }, [flushUnread]);

  const select = useCallback((id: string) => {
    onActiveChange(id, sessions.find((session) => session.id === id)?.projectId);
    // Drop anything queued for this session too, or the next flush would put
    // the badge straight back on the tab you are now looking at.
    unreadPending.current.delete(id);
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
      if (el?.closest('.terminal-host') || document.querySelector('.modal-backdrop, [role="dialog"][aria-modal="true"]')) return;
      if (e.key === 't') { e.preventDefault(); setDialog(true); return; }
      if (e.key === 'b') {
        e.preventDefault();
        setShowRail((v) => { localStorage.setItem('wanigan.code', v ? '0' : '1'); return !v; });
        return;
      }
      if (e.key === 'w' && activeRef.current) {
        const s = sessions.find((x) => x.id === activeRef.current);
        if (s?.status === 'exited') { e.preventDefault(); void closeTab(s.id); }
        return;
      }
      const n = Number(e.key);
      if (n >= 1 && n <= 9 && sessions[n - 1]) { e.preventDefault(); select(sessions[n - 1].id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

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

  /** Your name for a session, or '' when you have not given it one. */
  const nameOf = useCallback((s: Session) => labels[s.id] ?? '', [labels]);

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
    const next = { ...labels };
    // An emptied field is how you take a name back off, not a way to store one.
    if (value) next[id] = value; else delete next[id];
    setLabels(next);
    writeLabels(next, sessions.map((s) => s.id));
    endRename(id, refocus);
  }, [draft, endRename, labels, sessions]);

  const att = useAttachments(active?.id ?? null);

  return (
    <div className="sessions-view" style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, minHeight: 0 }}>
      {/* P3 · who is blocked, worst wait first. Above everything, because the
          answer to "where do I go next" outranks the rail and the terminal. */}
      <AttentionQueue onJump={select} />

      <div className={`sessions${sessionPickerCompact ? ' sessions--compact-picker' : ''}${sessionPickerOpen ? ' sessions--picker-open' : ''}`} style={{ flex: 1, minHeight: 0 }}>
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
                    {p.branch && <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>{p.branch}</span>}
                    <FocusBtn className="faint" style={{ marginLeft: 'auto', fontSize: 'var(--t-lead)', lineHeight: 1, borderRadius: 'var(--r-sm)' }}
                              title={`New session in ${p.name}`} onClick={() => setDialog(true)}>+</FocusBtn>
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
                          <span className="dot" style={{ background: s.status === 'running' ? TINT[s.providerId] : 'var(--text-faint)' }} />
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
                            </span>
                          </span>
                          {s.unread > 0 && s.id !== activeId && (
                            <span className="pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent)',
                                                            fontVariantNumeric: 'tabular-nums' }}>
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
            {past.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="group-title">
                  <span className="label">Recent conversations</span>
                  <span className="faint" style={{ fontSize: 'var(--t-micro)', marginLeft: 'auto' }}>exact resume</span>
                </div>
                {past.slice(0, 8).map((p) => (
                  <div key={p.id} className="past-row">
                    <FocusBtn className="past-main" disabled={!p.live || resuming !== null}
                              title={p.live
                                ? `Resume this exact conversation in ${p.projectPath}`
                                : 'Project folder no longer exists'}
                              onClick={() => resume(p)}>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 'var(--t-small)' }}>
                          {p.projectName}
                          {!p.live && <span className="faint"> · missing</span>}
                        </span>
                        <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>
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
                    <FocusBtn className="past-x faint" title={`Forget this conversation and all ${p.continuationCount} saved launch record${p.continuationCount === 1 ? '' : 's'}`}
                              onClick={() => window.wanigan.sessions.forget(p.id).then(setPast).catch((e) => onError(msg(e)))}>
                      ×
                    </FocusBtn>
                  </div>
                ))}
              </div>
            )}

            <FocusBtn className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
                      onClick={onAddProject}>+ Add project</FocusBtn>
            {projects.length > 0 && (
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
            {sessions.map((s, i) => (
              <div key={s.id} className={`session-tab-wrap${s.id === activeId ? ' active' : ''}`}>
                <FocusBtn className={`tab session-tab${s.id === activeId ? ' active' : ''}`} onClick={() => select(s.id)}
                          aria-current={s.id === activeId ? 'page' : undefined}
                          title={nameOf(s) ? `${nameOf(s)} — ${s.title}` : s.title}
                          aria-label={`${nameOf(s) || s.projectName}, ${s.status === 'running' ? 'running' : 'exited'} session`}>
                  <span className="dot" style={{ width: 6, height: 6, borderRadius: 'var(--r-pill)',
                                                 background: s.status === 'running' ? (TINT[s.providerId] ?? 'var(--accent)') : 'var(--text-faint)' }} />
                  {nameOf(s) || s.projectName}
                  <span className="faint mono" style={{ fontSize: 'var(--t-micro)' }}>⌘{i + 1}</span>
                </FocusBtn>
                {s.status === 'exited' && (
                  <FocusBtn className="session-tab-close faint" title="Close exited session (⌘W)"
                            aria-label={`Close exited session for ${s.projectName}`}
                            onClick={() => void closeTab(s.id)}>×</FocusBtn>
                )}
              </div>
            ))}
            <FocusBtn className="tab tab-new-session faint" onClick={() => setDialog(true)} title="New session (⌘T)"
                      aria-label="New session (Command T)">+<span className="tab-new-session-text"> New</span></FocusBtn>
            <FocusBtn className={`tab session-side-panel-toggle faint${railOpen ? ' active' : ''}`} style={{ marginLeft: 'auto' }}
                      title={compactLayout ? 'The side panel is collapsed on tablets so the terminal stays readable.' : 'Toggle the side panel (⌘B)'}
                      disabled={compactLayout}
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
                  Running sessions are unaffected — this is Wanigan's own record of them. Retry below;
                  if it keeps failing, quit and reopen Wanigan to rebuild the connection to its database.
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
                {past.filter((p) => p.live)[0] && (
                  <FocusBtn className="btn" onClick={() => resume(past.filter((p) => p.live)[0])}>
                    Resume {past.filter((p) => p.live)[0].projectName}
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
                                 onSendToBatch={(paths) => onSendToBatch({
                                   projectId: active.projectId,
                                   root: active.worktree ?? active.projectPath,
                                   paths,
                                 })} />
                    ) : pane === 'timeline' ? (
                      <Timeline key={`tl-${active.id}`} sessionId={active.id}
                                onOpenFile={(p) => { window.wanigan.code.open(null, p).catch((e) => onError(msg(e))); }} />
                    ) : (
                      <div style={{ overflowY: 'auto', minHeight: 0, borderLeft: '1px solid var(--line)', padding: 'var(--s-2)' }}>
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
                            title="Stop the current turn. The session stays open — this is the Escape key Claude Code listens for. ⌘."
                            onClick={() => void window.wanigan.sessions.interrupt(active.id)}>
                    ⎋ interrupt
                  </FocusBtn>
                )}
                {active.status === 'running' && (
                  <FocusBtn className="faint session-status-action" style={{ fontSize: 'var(--t-small)', color: 'var(--bad)', borderRadius: 'var(--r-sm)' }}
                            title="End the session entirely. The conversation goes with it."
                            onClick={() => window.wanigan.sessions.kill(active.id)}>end session</FocusBtn>
                )}
              </>
            ) : <span>⌘T new session · ⌘1–9 switch · ⌘W close · ⌘B side panel</span>}
          </div>
        </div>
      </div>

      {dialog && (
        <NewSessionDialog providers={providers} projects={projects} defaultProjectId={active?.projectId}
                          onClose={() => setDialog(false)} onCreate={createSession} onAddProject={onAddProject} />
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
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="recover-codex-title"
               onMouseDown={(event) => event.stopPropagation()}>
        <div className="label" style={{ color: 'var(--codex)', marginBottom: 4 }}>Safe recovery</div>
        <h2 id="recover-codex-title" style={{ fontSize: 'var(--t-lead)', fontWeight: 600 }}>Recover an exact Codex conversation</h2>
        <p className="dim" style={{ marginTop: 7, fontSize: 'var(--t-small)', lineHeight: 1.5 }}>
          Use this for a known conversation — for example, your budgeting and investing thread. Wanigan checks the
          exact UUID against Codex’s local index, rollout, saved folder and writer lock. It never guesses “latest.”
        </p>

        <label style={{ display: 'block', marginTop: 16 }}>
          <span className="label">Codex conversation UUID</span>
          <input className="field mono" style={{ width: '100%', marginTop: 6, boxSizing: 'border-box' }}
                 autoFocus value={threadId} onChange={(event) => setThreadId(event.target.value)}
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
    </div>
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
  return (
    <div className="learning-modal-backdrop" onMouseDown={onClose}>
      <section className="learning-modal card" role="dialog" aria-modal="true" aria-label="Teach Wanigan from this session"
               onMouseDown={(e) => e.stopPropagation()}>
        <div className="learning-card-head">
          <div><span className="label">{session.providerId} · {session.projectName}</span><h2>Teach Wanigan from this session</h2></div>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
        <p className="dim">This stores your explanation and a reference to this session as evidence. It does not copy the whole transcript or edit project files.</p>
        <label><span className="label">What happened?</span><select className="field" value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}><option value="worked">This worked</option><option value="failed">This failed</option><option value="corrected">I corrected the agent</option><option value="preference">My preference</option></select></label>
        <label><span className="label">Title</span><input className="field" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="The reusable lesson" /></label>
        <label><span className="label">What should future agents know?</span><textarea className="field" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="State the outcome, constraint, correction, or procedure clearly…" /></label>
        <div className="learning-form-grid">
          <label><span className="label">Scope</span><select className="field" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}><option value="project">This project</option><option value="path">A path in this project</option><option value="personal">My knowledge</option></select></label>
          {scope === 'path' && <label><span className="label">Path pattern</span><input className="field mono" value={pathScope} onChange={(e) => setPathScope(e.target.value)} placeholder="src/api/**" /></label>}
        </div>
        <div className="learning-actions"><button className="btn btn-primary" disabled={busy || !title.trim() || !text.trim()} onClick={() => void submit()}>{busy ? 'Adding…' : 'Add reviewable lesson'}</button></div>
      </section>
    </div>
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

const LABEL_KEY = 'wanigan.session.labels';
const LABEL_MAX = 60;

function readLabels(): Record<string, string> {
  try {
    const raw = localStorage.getItem(LABEL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, LABEL_MAX);
    }
    return out;
  } catch { return {}; }
}

/** Pruned to live sessions, exactly like the pane map: ids are per-launch. */
function writeLabels(map: Record<string, string>, live: string[]) {
  try {
    const keep = new Set(live);
    const out = Object.fromEntries(Object.entries(map).filter(([k]) => keep.has(k)));
    localStorage.setItem(LABEL_KEY, JSON.stringify(out));
  } catch { /* storage can be blocked; the name just stops surviving a reload */ }
}

/* ── P19 + P9 · the session header ────────────────────────────────────── */

function SessionHeader({ session, defaultTrust, onRefresh, provider }: {
  session: Session; defaultTrust: TrustLevel | null; onRefresh: () => Promise<void>;
  provider?: ProviderInfo;
}) {
  const trust = session.trust ?? null;
  const elevated = !!trust && !!defaultTrust && rank(trust) > rank(defaultTrust);
  const tunable = session.providerId !== 'codex' && session.status === 'running' &&
    (provider?.supports.model === true || provider?.supports.effort === true);
  // Codex has its own live controls.  Its TUI's /model picker changes model,
  // reasoning effort and Auto choices, and /plan changes the next turn's
  // collaboration mode.  Treating it as Claude made this whole useful row
  // disappear merely because it does not accept Claude slash commands.
  const codexControls = session.providerId === 'codex' && session.status === 'running';
  if (!elevated && !session.worktree && !tunable && !codexControls) return null;

  return (
    <div style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-soft)' }}>
      {elevated && trust && defaultTrust && (
        <TrustBanner level={trust} fallback={defaultTrust} running={session.status !== 'exited'} />
      )}
      {session.worktree && <WorktreeBar session={session} path={session.worktree} onRefresh={onRefresh} />}
      {tunable && provider && <RunConfigBar session={session} provider={provider} />}
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
      <span className="mono" style={{ fontSize: 'var(--t-micro)', color: 'var(--text-dim)' }}>
        {session.model || 'Auto'} · effort {session.effort || 'Auto'}
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
        {sent ?? 'Use Model & effort for Auto / reasoning level. Plan mode affects the next task, not work already running.'}
      </span>
    </div>
  );
}

/* ── model and effort, on a session that is already running ──────────────
   --model and --effort are argv, and you cannot change a running process's
   arguments. What you CAN do is what you would do by hand: type the CLI's own
   /model and /effort into the terminal. So these controls send exactly that,
   which is why they work rather than merely looking like they do — and why
   they are disabled the moment a session exits.
   ─────────────────────────────────────────────────────────────────────── */

const MODEL_CHOICES: Record<string, { value: string; label: string }[]> = {
  claude: [
    { value: 'opus', label: 'Opus' },
    { value: 'sonnet', label: 'Sonnet' },
    { value: 'haiku', label: 'Haiku' },
    { value: 'fable', label: 'Fable' },
  ],
  // Filled from Z.ai's live catalog; this is only what shows before it answers.
  glm: [
    { value: 'glm-5.3', label: 'GLM 5.3' },
    { value: 'glm-5.3-flash', label: 'GLM 5.3 Flash' },
  ],
  codex: [],
};

function RunConfigBar({ session, provider }: { session: Session; provider: ProviderInfo }) {
  const [models, setModels] = useState<{ value: string; label: string }[]>(MODEL_CHOICES[provider.id] ?? []);
  const [modelNote, setModelNote] = useState<string | null>(null);

  // Z.ai ships models faster than a constant survives, so ask it. Anthropic's
  // catalog is already fetched the same way in the Batches view.
  useEffect(() => {
    if (provider.id !== 'glm') { setModels(MODEL_CHOICES[provider.id] ?? []); setModelNote(null); return; }
    let live = true;
    window.wanigan.key.glmModels()
      .then((r) => {
        if (!live) return;
        if (r.models.length) setModels(r.models.map((m) => ({ value: m.id, label: m.label })));
        setModelNote(r.note);
      })
      .catch(() => { /* the fallback list is already showing */ });
    return () => { live = false; };
  }, [provider.id]);

  const [model, setModel] = useState(session.model ?? '');
  const [effortIdx, setEffortIdx] = useState(() => {
    const i = EFFORT_LEVELS.indexOf((session.effort ?? '') as (typeof EFFORT_LEVELS)[number]);
    return i >= 0 ? i : 2;
  });
  const [sent, setSent] = useState<string | null>(null);

  function send(field: 'model' | 'effort', value: string) {
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

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap',
                  padding: '6px 12px', borderTop: '1px solid var(--line-soft)' }}>
      {provider.supports.model && models.length > 0 && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="label" style={{ margin: 0 }}>Model</span>
          <select
            className="field"
            style={{ padding: '3px 7px', fontSize: 'var(--t-small)' }}
            value={model}
            onChange={(e) => { setModel(e.target.value); if (e.target.value) send('model', e.target.value); }}
          >
            <option value="">CLI default</option>
            {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </select>
        </label>
      )}

      {provider.supports.effort && (
        <label style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <span className="label" style={{ margin: 0 }}>Effort</span>
          <input
            type="range"
            min={0}
            max={EFFORT_LEVELS.length - 1}
            step={1}
            value={effortIdx}
            aria-label="Effort level"
            aria-valuetext={EFFORT_LEVELS[effortIdx]}
            onChange={(e) => setEffortIdx(Number(e.target.value))}
            onPointerUp={() => send('effort', EFFORT_LEVELS[effortIdx])}
            onKeyUp={(e) => { if (e.key.startsWith('Arrow')) send('effort', EFFORT_LEVELS[effortIdx]); }}
            style={{ width: 128, accentColor: 'var(--accent)' }}
          />
          {/* The word, not just the notch — a slider position is not a value. */}
          <span className="mono" style={{ fontSize: 'var(--t-small)', color: 'var(--accent)', minWidth: 46 }}>
            {EFFORT_LEVELS[effortIdx]}
          </span>
        </label>
      )}

      <span className="faint" style={{ fontSize: 'var(--t-micro)', marginLeft: 'auto', minWidth: 0 }}>
        {sent
          ? <><span className="mono" style={{ color: 'var(--ok)' }}>{sent}</span> sent to the session</>
          : modelNote
            ? modelNote
            : 'Typed into the session as a slash command. /model also sets your default for new sessions.'}
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
  const copy = TRUST_COPY[level];
  return (
    <div role="status" style={{
      display: 'flex', alignItems: 'baseline', gap: 8, padding: '6px 12px',
      background: 'var(--warning-soft)', borderLeft: '3px solid var(--warning)', lineHeight: 1.45,
    }}>
      <span aria-hidden="true" style={{ color: 'var(--warning)', fontWeight: 700, fontSize: 'var(--t-small)' }}>
        {TRUST_GLYPH[level]}
      </span>
      <span style={{ color: 'var(--warning)', fontWeight: 650, fontSize: 'var(--t-small)', flex: 'none' }}>
        {copy.label} trust
      </span>
      <span style={{ color: 'var(--text-dim)', fontSize: 'var(--t-small)', minWidth: 0 }}>
        {copy.detail} {running ? 'This session is running' : 'This session ran'} above your default,
        {' '}{TRUST_COPY[fallback].label} ({TRUST_GLYPH[fallback]}).
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
        <p className="faint" style={{ fontSize: 'var(--t-small)', lineHeight: 1.45 }}>
          Nothing staged yet. Drop a file on the terminal, paste a screenshot with ⌘V, or add one —
          Wanigan copies it where {session.projectName}'s agent can read it and writes the path into your
          prompt, so all you add is the question. Sent files leave this strip.
        </p>
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
