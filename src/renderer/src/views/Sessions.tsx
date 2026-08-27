import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LaunchOptions, Project, ProviderId, ProviderInfo, Session } from '@shared/types';
import TerminalPane, { feed, disposePane } from '../components/TerminalPane';
import NewSessionDialog from '../components/NewSessionDialog';

const TINT: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)' };

export default function Sessions({ providers, projects, onAddProject, onError }: {
  providers: ProviderInfo[]; projects: Project[];
  onAddProject: () => Promise<void>; onError: (m: string) => void;
}) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeId;

  const refresh = useCallback(async () => setSessions(await window.foreman.sessions.list()), []);
  useEffect(() => { void refresh(); }, [refresh]);

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
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
  }, [onError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 't') { e.preventDefault(); setDialog(true); return; }
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

  return (
    <div className="sessions">
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
                  <button className="faint" style={{ marginLeft: 'auto', fontSize: 15, lineHeight: 1 }}
                          title={`New session in ${p.name}`} onClick={() => setDialog(true)}>+</button>
                </div>
                {list.length === 0 && <p className="faint" style={{ padding: '2px 8px 4px', fontSize: 11.5 }}>no sessions</p>}
                {list.map((s) => (
                  <button key={s.id} className={`session-item${s.id === activeId ? ' active' : ''}`} onClick={() => select(s.id)}>
                    <span className="dot" style={{ background: s.status === 'running' ? TINT[s.providerId] : 'var(--text-faint)' }} />
                    <span style={{ minWidth: 0, flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 12.5 }}>
                        {providers.find((x) => x.id === s.providerId)?.label ?? s.providerId}
                      </span>
                      <span className="faint mono" style={{ fontSize: 10.5 }}>
                        {s.status === 'running' ? `pid ${s.pid}` : `exited ${s.exitCode}`}
                      </span>
                    </span>
                    {s.unread > 0 && s.id !== activeId && (
                      <span className="pill" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
                        {s.unread > 99 ? '99+' : s.unread}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            );
          })}
          <button className="btn" style={{ width: '100%', justifyContent: 'center', marginTop: 14 }}
                  onClick={onAddProject}>+ Add project</button>
        </div>
      </aside>

      <div className="session-main">
        <div className="tabbar">
          {sessions.map((s, i) => (
            <button key={s.id} className={`tab${s.id === activeId ? ' active' : ''}`} onClick={() => select(s.id)}>
              <span className="dot" style={{ width: 6, height: 6, borderRadius: 999,
                                             background: s.status === 'running' ? TINT[s.providerId] : 'var(--text-faint)' }} />
              {s.projectName}
              <span className="faint mono" style={{ fontSize: 10.5 }}>⌘{i + 1}</span>
              {s.status === 'exited' && (
                <span onClick={(e) => { e.stopPropagation(); void closeTab(s.id); }}
                      className="faint" style={{ marginLeft: 2, fontSize: 13 }} title="Close (⌘W)">×</span>
              )}
            </button>
          ))}
          <button className="tab faint" onClick={() => setDialog(true)} title="New session (⌘T)">+</button>
        </div>

        {sessions.length === 0 ? (
          <div className="empty">
            <div>
              <h1 style={{ fontSize: 19, fontWeight: 600 }}>No sessions running</h1>
              <p className="dim" style={{ marginTop: 6, maxWidth: 460, lineHeight: 1.55 }}>
                Each session is a real terminal, so permission prompts and the full TUI work exactly
                as they do in your shell.
              </p>
            </div>
            {projects.length === 0
              ? <button className="btn btn-primary" onClick={onAddProject}>Add your first project</button>
              : <button className="btn btn-primary" onClick={() => setDialog(true)}>New session ⌘T</button>}
            {!anyInstalled && providers.length > 0 && (
              <p className="faint" style={{ maxWidth: 470, lineHeight: 1.5 }}>
                Neither <span className="mono">claude</span> nor <span className="mono">codex</span> was found.
                Foreman resolves your login shell's PATH and scans editor extension directories — if they run
                in your terminal, restart Foreman and it will find them.
              </p>
            )}
          </div>
        ) : (
          sessions.map((s) => <TerminalPane key={s.id} sessionId={s.id} visible={s.id === activeId} />)
        )}

        <div className="statusbar">
          {active ? (
            <>
              <span className="mono">{active.projectPath}</span><span>·</span>
              <span>{active.status === 'running' ? `pid ${active.pid}` : `exited ${active.exitCode}`}</span>
              <button className="faint" style={{ marginLeft: 'auto', fontSize: 11.5 }}
                      onClick={() => window.foreman.sessions.reveal(active.projectPath)}>open folder</button>
              {active.status === 'running' && (
                <button className="faint" style={{ fontSize: 11.5, color: 'var(--bad)' }}
                        onClick={() => window.foreman.sessions.kill(active.id)}>stop</button>
              )}
            </>
          ) : <span>⌘T new session · ⌘1–9 switch · ⌘W close</span>}
        </div>
      </div>

      {dialog && (
        <NewSessionDialog providers={providers} projects={projects} defaultProjectId={active?.projectId}
                          onClose={() => setDialog(false)} onCreate={createSession} onAddProject={onAddProject} />
      )}
    </div>
  );
}
