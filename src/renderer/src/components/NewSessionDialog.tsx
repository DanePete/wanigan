import { useEffect, useState } from 'react';
import type { LaunchOptions, Project, ProviderId, ProviderInfo } from '@shared/types';

const TINT: Record<ProviderId, string> = { claude: 'var(--claude)', codex: 'var(--codex)' };

export default function NewSessionDialog({
  providers, projects, defaultProjectId, onClose, onCreate, onAddProject,
}: {
  providers: ProviderInfo[];
  projects: Project[];
  defaultProjectId?: string;
  onClose: () => void;
  onCreate: (opts: LaunchOptions) => Promise<void>;
  onAddProject: () => Promise<void>;
}) {
  const installed = providers.filter((p) => p.path);
  const [providerId, setProviderId] = useState<ProviderId>(installed[0]?.id ?? 'claude');
  const [projectId, setProjectId] = useState(defaultProjectId ?? projects[0]?.id ?? '');
  const [extraArgs, setExtraArgs] = useState('');
  const [initialPrompt, setInitialPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void go();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function go() {
    if (!projectId || busy) return;
    setBusy(true); setErr(null);
    try {
      await onCreate({ providerId, projectId, extraArgs, initialPrompt });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2 style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>New session</h2>

        <div className="label">Agent</div>
        <div style={{ display: 'flex', gap: 8, margin: '6px 0 14px' }}>
          {providers.map((p) => {
            const on = providerId === p.id;
            return (
              <button
                key={p.id}
                disabled={!p.path}
                onClick={() => setProviderId(p.id)}
                className="btn"
                style={{
                  flex: 1, flexDirection: 'column', alignItems: 'flex-start', gap: 2, padding: '9px 11px',
                  borderColor: on ? TINT[p.id] : 'var(--line)',
                  background: on ? 'var(--bg-sunk)' : 'var(--bg-soft)',
                }}
                title={p.path ?? `${p.bin} not found on PATH`}
              >
                <span style={{ fontWeight: 600, color: on ? TINT[p.id] : undefined }}>{p.label}</span>
                <span className="faint mono" style={{ fontSize: 10.5 }}>
                  {p.path ? (p.version ?? 'installed') : 'not installed'}
                </span>
              </button>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span className="label">Project</span>
          <button className="faint" style={{ fontSize: 11.5, marginLeft: 'auto' }}
                  onClick={onAddProject}>+ add a folder</button>
        </div>
        {projects.length ? (
          <select className="field" style={{ margin: '6px 0 14px' }}
                  value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}{p.branch ? ` — ${p.branch}` : ''}
              </option>
            ))}
          </select>
        ) : (
          <p className="faint" style={{ margin: '6px 0 14px' }}>
            No projects yet — add a folder to start a session in it.
          </p>
        )}

        <div className="label">First message <span style={{ textTransform: 'none' }}>(optional)</span></div>
        <textarea className="field mono" rows={3} style={{ margin: '6px 0 4px', resize: 'vertical' }}
                  placeholder="Typed into the session once it is up."
                  value={initialPrompt} onChange={(e) => setInitialPrompt(e.target.value)} />

        <details style={{ margin: '10px 0 4px' }}>
          <summary className="faint" style={{ cursor: 'pointer', fontSize: 11.5 }}>Extra CLI flags</summary>
          <input className="field mono" style={{ marginTop: 6 }}
                 placeholder="--resume    --permission-mode plan"
                 value={extraArgs} onChange={(e) => setExtraArgs(e.target.value)} />
        </details>

        {err && (
          <div style={{ background: 'var(--bad-soft)', color: 'var(--bad)', border: '1px solid var(--bad)',
                        borderRadius: 6, padding: '7px 10px', margin: '10px 0', fontSize: 12 }}>
            {err}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={onClose} style={{ marginLeft: 'auto' }}>Cancel</button>
          <button className="btn btn-primary" onClick={go} disabled={!projectId || busy}>
            {busy ? 'Starting…' : 'Start session'}
          </button>
        </div>
        <p className="faint" style={{ fontSize: 11, marginTop: 8, textAlign: 'right' }}>⌘↵ to start</p>
      </div>
    </div>
  );
}
