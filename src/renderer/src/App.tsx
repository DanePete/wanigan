import { useCallback, useEffect, useState } from 'react';
import type { Project, ProviderInfo } from '@shared/types';
import Sessions from './views/Sessions';
import Batches from './views/Batches';
import SettingsView from './views/Settings';
import InsightsView from './views/Insights';

type Tab = 'sessions' | 'batches' | 'insights' | 'settings';

export default function App() {
  const [tab, setTab] = useState<Tab>('sessions');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [hasKey, setHasKey] = useState(false);
  const [running, setRunning] = useState(0);
  const [activeRuns, setActiveRuns] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const loadShell = useCallback(async () => {
    const [pv, pj, ks] = await Promise.all([
      window.foreman.providers.list(),
      window.foreman.projects.list(),
      window.foreman.key.status(),
    ]);
    setProviders(pv); setProjects(pj); setHasKey(ks.present);
  }, []);

  useEffect(() => { void loadShell(); }, [loadShell]);

  // Badge counts for the nav, so a background batch or session is visible from
  // whichever view you happen to be in.
  useEffect(() => {
    const tick = async () => {
      try {
        const [ss, runs] = await Promise.all([
          window.foreman.sessions.list(),
          window.foreman.batch.runs(),
        ]);
        setRunning(ss.filter((s) => s.status === 'running').length);
        setActiveRuns((runs as { status: string }[]).filter((r) =>
          ['in_progress', 'submitting', 'canceling'].includes(r.status)).length);
      } catch { /* db not ready yet */ }
    };
    void tick();
    const t = setInterval(tick, 6000);
    const off = window.foreman.on.batchChanged(() => void tick());
    return () => { clearInterval(t); off(); };
  }, []);

  // Branches move constantly; keep the shared project list honest.
  useEffect(() => {
    const t = setInterval(() => {
      window.foreman.projects.refresh().then(setProjects).catch(() => {});
    }, 30_000);
    return () => clearInterval(t);
  }, []);

  const addProject = useCallback(async () => {
    try {
      const p = await window.foreman.projects.pick();
      if (p) setProjects(await window.foreman.projects.list());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);

  const removeProject = useCallback(async (id: string) => {
    setProjects(await window.foreman.projects.remove(id));
  }, []);

  return (
    <div className="shell">
      <nav className="nav">
        <span className="brand">Foreman</span>
        <div className="nav-tabs">
          <NavTab id="sessions" tab={tab} set={setTab} label="Sessions" badge={running} />
          <NavTab id="batches"  tab={tab} set={setTab} label="Batches"  badge={activeRuns} />
          <NavTab id="insights" tab={tab} set={setTab} label="Insights" />
          <NavTab id="settings" tab={tab} set={setTab} label="Settings"
                  warn={!hasKey} />
        </div>
      </nav>

      <div className="body">
        {tab === 'sessions' && (
          <Sessions providers={providers} projects={projects}
                    onAddProject={addProject} onError={setError} />
        )}
        {tab === 'batches' && (
          <Batches projects={projects} hasKey={hasKey} onNeedKey={() => setTab('settings')} />
        )}
        {tab === 'insights' && <InsightsView />}
        {tab === 'settings' && (
          <SettingsView providers={providers} projects={projects}
                        onKeyChange={loadShell} onRemoveProject={removeProject} onAddProject={addProject} />
        )}
      </div>

      {error && (
        <div className="toast" onClick={() => setError(null)} role="alert">
          {error} <span className="faint">— click to dismiss</span>
        </div>
      )}
    </div>
  );
}

function NavTab({ id, tab, set, label, badge, warn }: {
  id: Tab; tab: Tab; set: (t: Tab) => void; label: string; badge?: number; warn?: boolean;
}) {
  const on = tab === id;
  return (
    <button className={`nav-tab${on ? ' on' : ''}`} onClick={() => set(id)}>
      {label}
      {badge ? <span className="nav-badge">{badge}</span> : null}
      {warn ? <span className="nav-dot" title="No API key set" /> : null}
    </button>
  );
}
