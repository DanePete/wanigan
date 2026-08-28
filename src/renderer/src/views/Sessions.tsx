import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  LaunchOptions, PastSession, Project, ProviderId, ProviderInfo, Session, TrustLevel, WorktreeInfo,
} from '@shared/types';
import { TRUST_COPY, TRUST_LEVELS } from '@shared/types';
import TerminalPane, { feed, disposePane } from '../components/TerminalPane';
import NewSessionDialog from '../components/NewSessionDialog';
import CodePanel from '../components/CodePanel';
import AttentionQueue from '../components/AttentionQueue';
import Timeline from '../components/Timeline';
import { Note, ago, num, usd } from '../components/bits';

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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
function FocusBtn({ style, onFocus, onBlur, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const [ring, setRing] = useState(false);
  return (
    <button
      {...rest}
      onFocus={(e) => { setRing(e.currentTarget.matches(':focus-visible')); onFocus?.(e); }}
      onBlur={(e) => { setRing(false); onBlur?.(e); }}
      style={ring ? { ...style, outline: '2px solid var(--accent)', outlineOffset: 1 } : style}
    >
      {children}
    </button>
  );
}

export default function Sessions({ providers, projects, onAddProject, onError, onSendToBatch }: {
  providers: ProviderInfo[]; projects: Project[];
  onAddProject: () => Promise<void>; onError: (m: string) => void;
  onSendToBatch: (seed: { projectId: string; root: string; paths: string[] }) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  // Loading is not empty. Until the first list() answers, "no sessions running"
  // would be a claim Foreman has not checked.
  const [ready, setReady] = useState(false);
  const [listErr, setListErr] = useState<string | null>(null);
  // Remembered per machine: whether the side rail is open is a working
  // preference, not session state.
  const [showRail, setShowRail] = useState(() => localStorage.getItem('foreman.code') === '1');
  const [railPane, setRailPane] = useState<Record<string, 'code' | 'timeline'>>(readPanes);
  const [defaultTrust, setDefaultTrust] = useState<TrustLevel | null>(null);
  const [past, setPast] = useState<PastSession[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const refresh = useCallback(async () => {
    try {
      setSessions(await window.foreman.sessions.list());
      setPast(await window.foreman.sessions.past());
      setListErr(null);
    } catch (e) {
      setListErr(msg(e));
    } finally {
      setReady(true);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // The banner compares against the default, so the default is read once and
  // kept; a session above it is the exception worth shouting about.
  useEffect(() => {
    window.foreman.policy.defaultTrust().then(setDefaultTrust).catch(() => setDefaultTrust(null));
  }, []);

  async function resume(p: PastSession) {
    setResuming(p.id);
    try {
      const s = await window.foreman.sessions.create({
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
    finally { setResuming(null); }
  }

  useEffect(() => {
    const offData = window.foreman.on.data(({ sessionId, data }) => {
      feed(sessionId, data);
      if (sessionId !== activeRef.current) {
        setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, unread: s.unread + 1 } : s)));
      }
    });
    const offList = window.foreman.on.sessions((list) => {
      setSessions((prev) => {
        const unread = new Map(prev.map((s) => [s.id, s.unread]));
        return list.map((s) => ({ ...s, unread: s.id === activeRef.current ? 0 : (unread.get(s.id) ?? 0) }));
      });
    });
    const offExit = window.foreman.on.exit(({ sessionId, exitCode }) => {
      feed(sessionId, `\r\n\x1b[38;5;244m── session exited (code ${exitCode}) ──\x1b[0m\r\n`);
    });
    return () => { offData(); offList(); offExit(); };
  }, []);

  const select = useCallback((id: string) => {
    setActiveId(id);
    setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, unread: 0 } : s)));
    window.foreman.sessions.markRead(id).catch(() => {});
  }, []);

  const closeTab = useCallback(async (id: string) => {
    try {
      await window.foreman.sessions.close(id);
      disposePane(id);
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeRef.current === id) setActiveId(next[next.length - 1]?.id ?? null);
        return next;
      });
    } catch (e) { onError(msg(e)); }
  }, [onError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 't') { e.preventDefault(); setDialog(true); return; }
      if (e.key === 'b') {
        e.preventDefault();
        setShowRail((v) => { localStorage.setItem('foreman.code', v ? '0' : '1'); return !v; });
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
    const s = await window.foreman.sessions.create(opts);
    await refresh();
    select(s.id);
  }

  const byProject = useMemo(() => {
    const m = new Map<string, Session[]>();
    for (const s of sessions) m.set(s.projectId, [...(m.get(s.projectId) ?? []), s]);
    return m;
  }, [sessions]);

  const active = sessions.find((s) => s.id === activeId) ?? null;
  const anyInstalled = providers.some((p) => p.path);
  const pane = (active && railPane[active.id]) || 'code';

  const setPane = useCallback((sessionId: string, next: 'code' | 'timeline') => {
    const merged = { ...railPane, [sessionId]: next };
    setRailPane(merged);
    writePanes(merged, sessions.map((s) => s.id));
  }, [railPane, sessions]);

  const att = useAttachments(active?.id ?? null);

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, minHeight: 0 }}>
      {/* P3 · who is blocked, worst wait first. Above everything, because the
          answer to "where do I go next" outranks the rail and the terminal. */}
      <AttentionQueue onJump={select} />

      <div className="sessions" style={{ flex: 1, minHeight: 0 }}>
        <aside className="session-rail">
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
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{p.name}</span>
                    {p.branch && <span className="faint mono" style={{ fontSize: 10.5 }}>{p.branch}</span>}
                    <FocusBtn className="faint" style={{ marginLeft: 'auto', fontSize: 15, lineHeight: 1, borderRadius: 5 }}
                              title={`New session in ${p.name}`} onClick={() => setDialog(true)}>+</FocusBtn>
                  </div>
                  {list.length === 0 && <p className="faint" style={{ padding: '2px 8px 4px', fontSize: 11.5 }}>no sessions</p>}
                  {list.map((s) => (
                    <FocusBtn key={s.id} className={`session-item${s.id === activeId ? ' active' : ''}`}
                              onClick={() => select(s.id)}>
                      <span className="dot" style={{ background: s.status === 'running' ? TINT[s.providerId] : 'var(--text-faint)' }} />
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 12.5 }}>
                          {providers.find((x) => x.id === s.providerId)?.label ?? s.providerId}
                          {s.worktree && <span className="faint" title="Runs in its own git worktree"> ⑂</span>}
                        </span>
                        <span className="faint mono" style={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }}>
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
                  ))}
                </div>
              );
            })}
            {past.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="group-title">
                  <span className="label">Recent</span>
                  <span className="faint" style={{ fontSize: 10.5, marginLeft: 'auto' }}>resumable</span>
                </div>
                {past.slice(0, 8).map((p) => (
                  <div key={p.id} className="past-row">
                    <FocusBtn className="past-main" disabled={!p.live || resuming === p.id}
                              title={p.live ? `Resume in ${p.projectPath}` : 'Project folder no longer exists'}
                              onClick={() => resume(p)}>
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span style={{ display: 'block', fontSize: 12 }}>
                          {p.projectName}
                          {!p.live && <span className="faint"> · missing</span>}
                        </span>
                        <span className="faint mono" style={{ fontSize: 10 }}>
                          {providers.find((x) => x.id === p.providerId)?.label ?? p.providerId}
                          {p.model && ` · ${p.model}`}
                          {p.effort && ` · ${p.effort}`}
                          {' · '}{ago(p.startedAt)}
                        </span>
                      </span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {resuming === p.id ? '…' : '↻'}
                      </span>
                    </FocusBtn>
                    <FocusBtn className="past-x faint" title={`Forget ${p.projectName}`}
                              onClick={() => window.foreman.sessions.forget(p.id).then(setPast).catch((e) => onError(msg(e)))}>
                      ×
                    </FocusBtn>
                  </div>
                ))}
                {past.some((p) => p.providerId === 'codex') && (
                  <p className="faint" style={{ padding: '4px 8px', fontSize: 10.5, lineHeight: 1.45 }}>
                    Codex can only resume its most recent conversation, not a specific one.
                  </p>
                )}
              </div>
            )}

            <FocusBtn className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
                      onClick={onAddProject}>+ Add project</FocusBtn>
          </div>
        </aside>

        <div className="session-main">
          <div className="tabbar">
            {sessions.map((s, i) => (
              <FocusBtn key={s.id} className={`tab${s.id === activeId ? ' active' : ''}`} onClick={() => select(s.id)}>
                <span className="dot" style={{ width: 6, height: 6, borderRadius: 999,
                                               background: s.status === 'running' ? TINT[s.providerId] : 'var(--text-faint)' }} />
                {s.projectName}
                <span className="faint mono" style={{ fontSize: 10.5 }}>⌘{i + 1}</span>
                {s.status === 'exited' && (
                  <span onClick={(e) => { e.stopPropagation(); void closeTab(s.id); }}
                        className="faint" style={{ marginLeft: 2, fontSize: 13 }} title="Close (⌘W)">×</span>
                )}
              </FocusBtn>
            ))}
            <FocusBtn className="tab faint" onClick={() => setDialog(true)} title="New session (⌘T)">+</FocusBtn>
            <FocusBtn className={`tab faint${showRail ? ' active' : ''}`} style={{ marginLeft: 'auto' }}
                      title="Toggle the side panel (⌘B)"
                      onClick={() => setShowRail((v) => { localStorage.setItem('foreman.code', v ? '0' : '1'); return !v; })}>
              {showRail ? '⟨ hide' : `${pane} ⟩`}
            </FocusBtn>
          </div>

          {active && (
            <SessionHeader key={active.id} session={active} defaultTrust={defaultTrust} onRefresh={refresh} />
          )}

          {!ready ? (
            <div className="empty">
              <p className="dim">Reading the session list…</p>
            </div>
          ) : listErr ? (
            <div className="empty">
              <div style={{ maxWidth: 460 }}>
                <h1 style={{ fontSize: 17, fontWeight: 600 }}>The session list did not load</h1>
                <p className="dim" style={{ marginTop: 6, lineHeight: 1.55 }}>{listErr}</p>
                <p className="faint" style={{ marginTop: 6, lineHeight: 1.5 }}>
                  Running sessions are unaffected — this is Foreman's own record of them. Retry below;
                  if it keeps failing, quit and reopen Foreman to rebuild the connection to its database.
                </p>
              </div>
              <FocusBtn className="btn btn-primary" onClick={() => void refresh()}>Retry</FocusBtn>
            </div>
          ) : sessions.length === 0 ? (
            <div className="empty">
              <div>
                <h1 style={{ fontSize: 19, fontWeight: 600 }}>No sessions running</h1>
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
                <p className="faint" style={{ maxWidth: 470, lineHeight: 1.5 }}>
                  Neither <span className="mono">claude</span> nor <span className="mono">codex</span> was found.
                  Foreman resolves your login shell's PATH and scans editor extension directories — if they run
                  in your terminal, restart Foreman and it will find them.
                </p>
              )}
            </div>
          ) : (
            <div className={showRail && active ? 'term-split' : 'term-full'}>
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
                      border: '2px dashed var(--accent)', borderRadius: 10,
                      background: 'var(--accent-soft)', opacity: 0.96,
                      display: 'grid', placeItems: 'center', textAlign: 'center', padding: 20,
                    }}>
                      <div>
                        <div style={{ fontSize: 15, fontWeight: 600 }}>
                          ⤓ Drop to attach to {active.projectName}
                        </div>
                        <div className="dim" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.5 }}>
                          Images, PDFs, text and notebooks are staged where this agent can read them.
                          Nothing is sent anywhere — the agent opens the file itself.
                        </div>
                      </div>
                    </div>
                  )}
                </div>
                {active && <AttachStrip session={active} att={att} />}
              </div>

              {showRail && active && (
                <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
                  {/* P8 · one rail, two readings of the same session: what the
                      repo looks like now, and what the agent actually did. */}
                  <div className="code-head" style={{ borderLeft: '1px solid var(--line)' }} role="group"
                       aria-label="Side panel">
                    <Seg on={pane === 'code'} onClick={() => setPane(active.id, 'code')}
                         title="Files this session changed">Code</Seg>
                    <Seg on={pane === 'timeline'} onClick={() => setPane(active.id, 'timeline')}
                         title="Every tool call the agent made, and how long it took">Timeline</Seg>
                    <span className="faint mono" style={{ marginLeft: 'auto', fontSize: 10.5 }}>⌘B</span>
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
                    ) : (
                      <Timeline key={`tl-${active.id}`} sessionId={active.id}
                                onOpenFile={(p) => { window.foreman.code.open(null, p).catch((e) => onError(msg(e))); }} />
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
                <FocusBtn className="faint" style={{ marginLeft: 'auto', fontSize: 11.5, borderRadius: 5 }}
                          onClick={() => window.foreman.sessions.reveal(active.worktree ?? active.projectPath)}
                          title={active.worktree
                            ? `Open the worktree this session runs in: ${active.worktree}`
                            : `Open ${active.projectPath}`}>
                  open folder
                </FocusBtn>
                {active.status === 'running' && (
                  <FocusBtn className="faint" style={{ fontSize: 11.5, color: 'var(--bad)', borderRadius: 5 }}
                            onClick={() => window.foreman.sessions.kill(active.id)}>stop</FocusBtn>
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

const PANE_KEY = 'foreman.rail.pane';

function readPanes(): Record<string, 'code' | 'timeline'> {
  try {
    const raw = localStorage.getItem(PANE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: Record<string, 'code' | 'timeline'> = {};
    for (const [k, v] of Object.entries(parsed)) if (v === 'code' || v === 'timeline') out[k] = v;
    return out;
  } catch { return {}; }
}

/** Session ids are per-launch, so the map is pruned to sessions that still exist. */
function writePanes(map: Record<string, 'code' | 'timeline'>, live: string[]) {
  try {
    const keep = new Set(live);
    const out = Object.fromEntries(Object.entries(map).filter(([k]) => keep.has(k)));
    localStorage.setItem(PANE_KEY, JSON.stringify(out));
  } catch { /* storage can be blocked; the choice just stops surviving a restart */ }
}

/* ── P19 + P9 · the session header ────────────────────────────────────── */

function SessionHeader({ session, defaultTrust, onRefresh }: {
  session: Session; defaultTrust: TrustLevel | null; onRefresh: () => Promise<void>;
}) {
  const trust = session.trust ?? null;
  const elevated = !!trust && !!defaultTrust && rank(trust) > rank(defaultTrust);
  if (!elevated && !session.worktree) return null;

  return (
    <div style={{ borderBottom: '1px solid var(--line)', background: 'var(--bg-soft)' }}>
      {elevated && trust && defaultTrust && (
        <TrustBanner level={trust} fallback={defaultTrust} running={session.status !== 'exited'} />
      )}
      {session.worktree && <WorktreeBar session={session} path={session.worktree} onRefresh={onRefresh} />}
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
      <span aria-hidden="true" style={{ color: 'var(--warning)', fontWeight: 700, fontSize: 12 }}>
        {TRUST_GLYPH[level]}
      </span>
      <span style={{ color: 'var(--warning)', fontWeight: 650, fontSize: 12, flex: 'none' }}>
        {copy.label} trust
      </span>
      <span style={{ color: 'var(--text-dim)', fontSize: 12, minWidth: 0 }}>
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
      setInfo(await window.foreman.worktrees.status(path));
      setErr(null);
    } catch (e) { setErr(msg(e)); }
  }, [path]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 20_000);
    return () => clearInterval(t);
  }, [load]);

  async function merge() {
    setBusy('merge'); setResult(null);
    try {
      const fn = mergeFn();
      if (!fn) {
        const branch = info?.branch ?? '<branch>';
        setResult({
          ok: false,
          text: `Foreman cannot merge from this window yet. In ${info?.repoRoot ?? session.projectPath}, `
              + `run: git merge --no-ff ${branch}`,
        });
        return;
      }
      const r = await fn(path);
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
      const fresh = await window.foreman.worktrees.status(path);
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
      const r = await window.foreman.worktrees.remove(target.path, target.dirty > 0);
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
          <span className="faint" style={{ fontSize: 12 }}>Reading git…</span>
        ) : info === null ? (
          <span className="dim" style={{ fontSize: 12, lineHeight: 1.45 }}>
            Gone from disk. Foreman removes an isolated worktree once the session ends and nothing is
            uncommitted in it — the branch it used is kept.
          </span>
        ) : (
          <>
            <span className="mono" style={{ fontSize: 12, fontWeight: 600 }}>{branch ?? 'detached HEAD'}</span>
            <span className="faint mono trunc" style={{ fontSize: 11 }} title={info.path}>{info.path}</span>
            <span className="dim" style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
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
              <FocusBtn className="btn btn-danger" style={{ padding: '3px 9px' }} disabled={busy !== null}
                        title="Delete this worktree folder" onClick={askDiscard}>
                {busy === 'check' ? 'Checking…' : 'Discard…'}
              </FocusBtn>
            </div>
          </>
        )}
      </div>

      {confirm && (
        <div style={{ background: 'var(--warning-soft)', borderLeft: '3px solid var(--warning)',
                      borderRadius: 6, padding: '8px 11px', lineHeight: 1.5 }}>
          <div style={{ color: 'var(--warning)', fontWeight: 650, fontSize: 12.5 }}>
            <span aria-hidden="true">⚠ </span>
            {confirm.dirty > 0
              ? `${plural(confirm.dirty, 'uncommitted file')} will be deleted`
              : 'Delete this worktree folder?'}
          </div>
          <p style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 3 }}>
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
          Could not read the worktree: {err} — Foreman runs git in {path}; check the folder still exists.
        </Note>
      )}
    </div>
  );
}

/**
 * mergeWorktree() is implemented in the main process but has no IPC channel of
 * its own yet, so the button asks for one at call time and, when it is absent,
 * hands back the git command instead of failing silently.
 */
type MergeFn = (p: string, opts?: { squash?: boolean; message?: string })
  => Promise<{ merged: boolean; detail: string }>;

function mergeFn(): MergeFn | null {
  const wt = window.foreman.worktrees as unknown as { merge?: MergeFn };
  return typeof wt.merge === 'function' ? wt.merge.bind(wt) : null;
}

/* ── P21 · attachments ────────────────────────────────────────────────── */

type AttachState = ReturnType<typeof useAttachments>;

function useAttachments(sessionId: string | null) {
  const [items, setItems] = useState<Attachment[]>([]);
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
      const list = (await window.foreman.attach.list(sessionId)) as Attachment[];
      if (mine !== run.current) return;
      setItems(list);
      setPhase('ready');
      setLoadErr(null);
      // Cost comes from the main process's own pricing, one bounded header read
      // per image, rather than a rate re-derived in the renderer.
      const priced = await Promise.all(list.filter((a) => a.kind === 'image').map(async (a) => {
        try {
          const c = (await window.foreman.attach.inspect(a.storedPath)) as AttachCheck;
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

  const addFiles = useCallback(async (files: File[]) => {
    if (!sessionId || files.length === 0) return;
    setBusy(true); setHint(null);
    for (const f of files) {
      try {
        // Electron 32 removed File.path; the bytes are the portable route, and
        // the main process runs the same checks on either.
        const p = (f as File & { path?: string }).path;
        if (p) await window.foreman.attach.add(sessionId, p);
        else await window.foreman.attach.paste(sessionId, await f.arrayBuffer(), f.name);
      } catch (e) { reject(msg(e)); }
    }
    setBusy(false);
    await load();
  }, [sessionId, load, reject]);

  const addPaths = useCallback(async (paths: string[]) => {
    if (!sessionId || paths.length === 0) return;
    setBusy(true); setHint(null);
    for (const p of paths) {
      try { await window.foreman.attach.add(sessionId, p); }
      catch (e) { reject(msg(e)); }
    }
    setBusy(false);
    await load();
  }, [sessionId, load, reject]);

  const browse = useCallback(async () => {
    try {
      const picked = await window.foreman.browse.pick(true);
      await addPaths(picked);
    } catch (e) { reject(msg(e)); }
  }, [addPaths, reject]);

  const remove = useCallback(async (id: string) => {
    try { await window.foreman.attach.remove(id); }
    catch (e) { reject(msg(e)); }
    await load();
  }, [load, reject]);

  const typeReference = useCallback(async () => {
    if (!sessionId) return;
    try {
      const ok = await window.foreman.attach.type(sessionId);
      setHint(ok
        ? 'Typed into the session, not sent. Write what you want done with it, then press Enter.'
        : 'Nothing to reference yet — attach a file first.');
    } catch (e) { reject(msg(e)); }
  }, [sessionId, reject]);

  useEffect(() => {
    if (!hint) return;
    const t = setTimeout(() => setHint(null), 9000);
    return () => clearTimeout(t);
  }, [hint]);

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
    items, cost, phase, loadErr, rejects, hint, busy, dragging,
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
    <div style={{ borderTop: '1px solid var(--line)', background: 'var(--bg-soft)',
                  padding: '6px 10px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className="label" style={{ flex: 'none' }}>Attachments</span>
        <span className="faint" style={{ fontSize: 11.5, fontVariantNumeric: 'tabular-nums' }}>
          {att.phase === 'loading' ? 'reading…'
            : att.items.length === 0 ? 'none staged'
            : `${plural(att.items.length, 'file')}`}
          {images.length > 0 && visual > 0 && (
            <> · {num(visual)} visual tokens ≈ {usd(priced)} when read</>
          )}
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <FocusBtn className="btn" style={{ padding: '3px 9px' }} onClick={att.browse} disabled={att.busy}
                    title="Pick files to stage for this session">
            {att.busy ? 'Adding…' : '+ Add files'}
          </FocusBtn>
          <FocusBtn className="btn" style={{ padding: '3px 9px' }} onClick={att.typeReference}
                    disabled={att.items.length === 0 || att.busy || session.status === 'exited'}
                    title={session.status === 'exited'
                      ? 'This session has exited, so there is no prompt to type into. Resume it from Recent, then add the file.'
                      : 'Types the file reference into the prompt and stops — you write the question and press Enter'}>
            Add to prompt
          </FocusBtn>
        </div>
      </div>

      {att.phase === 'error' ? (
        <Note tone="error">
          <span aria-hidden="true" style={{ fontWeight: 700, marginRight: 6 }}>✕</span>
          The attachment list did not load: {att.loadErr} Files already staged are still on disk in this
          session's attachment folder.{' '}
          <FocusBtn className="link" style={{ fontSize: 12.5 }} onClick={() => void att.reload()}>Retry</FocusBtn>
        </Note>
      ) : att.phase === 'loading' ? (
        <p className="faint" style={{ fontSize: 11.5 }}>Reading what is staged for this session…</p>
      ) : att.items.length === 0 ? (
        <p className="faint" style={{ fontSize: 11.5, lineHeight: 1.45 }}>
          Nothing staged yet. Drop a file on the terminal, paste a screenshot with ⌘V, or add one —
          Foreman copies it where {session.projectName}'s agent can read it and names the path in your prompt.
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
                  border: '1px solid var(--line)', borderRadius: 8, background: 'var(--bg-sunk)',
                  padding: '4px 4px 4px 9px' }}>
      <span aria-hidden="true" style={{ color: 'var(--text-dim)', fontWeight: 700 }}>{k.glyph}</span>
      <span style={{ minWidth: 0 }}>
        <span className="mono" style={{ display: 'block', fontSize: 11.5, overflow: 'hidden',
                                        textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={a.storedPath}>
          {a.name}
        </span>
        <span className="faint" style={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums',
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
